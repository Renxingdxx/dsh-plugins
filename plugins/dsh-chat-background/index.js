/**
 * dsh-chat-background — Host half.
 *
 * A looping video background for the DSH chat area, with per-region blending,
 * opacity, theme colour and automatic theme-colour derivation from the video's
 * dominant colour.
 *
 * Why this plugin is split into two halves:
 *   - a browser cannot read a local file path, so the chosen video and its
 *     validation live here;
 *   - video needs HTTP Range so a background streams instead of buffering whole;
 *   - the native file dialog has to open in the Host process.
 *
 * The dominant colour is NOT computed here. A browser can draw a video frame to
 * a canvas and read pixels, which works for any format the browser decodes; the
 * Host has no decoder. The client samples the video and reports the colour.
 *
 * Zero runtime dependencies, deliberately: a plugin installed with `link:`
 * resolves its imports from its own real directory, so a dependency that only
 * ships inside the DSH installation fails with ERR_MODULE_NOT_FOUND and takes
 * the whole profile down with it.
 *
 * @module dsh-chat-background
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of this package's directory; the picker script resolves from here. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** Route namespace. Absolute, so it works over HTTP and the Electron IPC bridge. */
const ROUTE_BASE = '/dsh-chat-background'
const CONFIG_ROUTE = `${ROUTE_BASE}/config.json`
const VIDEO_ROUTE = `${ROUTE_BASE}/video`
const AUDIO_ROUTE = `${ROUTE_BASE}/audio`
const SAVE_ROUTE = `${ROUTE_BASE}/config`
const PICK_ROUTE = `${ROUTE_BASE}/pick`

/** Directory inside the DSH home that holds this plugin's own state. */
const STATE_DIRNAME = 'dsh-chat-background'

/** Bundled default background, shipped inside the package. */
const BUNDLED_VIDEO = join(PACKAGE_DIR, 'assets', 'default.gif')

/** Largest file this plugin will serve; guards against a mis-typed path. */
const MAX_MEDIA_BYTES = 4096 * 1024 * 1024

/** Upper bound on a stored path. */
const MAX_SRC_LENGTH = 4096

/** How long the native picker may stay open before the Host gives up. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/** Extension → MIME for background material. */
const FORMATS = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  ogm: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  gif: 'image/gif',
  apng: 'image/apng',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

/** Extensions that are animation-by-themselves and therefore render as `<img>`. */
const IMAGE_KIND = new Set(['gif', 'apng', 'webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'bmp', 'ico'])

/** Extension → MIME for sound material. */
const SOUND_FORMATS = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
}

/** Containers worth answering a `Range` request against. */
const SEEKABLE = new Set([
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/ogg',
  'video/quicktime',
  'video/mp2t',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'audio/webm',
])

/** Blend modes a region may use, mirrored by the client. */
const BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'hard-light',
  'color-dodge',
  'color-burn',
  'difference',
  'exclusion',
])

/** Shapes a region may take. */
const SHAPES = new Set(['linear', 'radial'])

/** The three default regions: a vignette plus top and bottom scrims. */
const DEFAULT_REGIONS = [
  {
    id: 'vignette',
    shape: 'radial',
    anchor: { x: 0.5, y: 0.5 },
    size: 1.15,
    strength: 0.55,
    color: '#000000',
    blend: 'multiply',
    gradient: true,
    invert: true,
  },
  {
    id: 'top',
    shape: 'linear',
    anchor: { x: 0.5, y: 0.0 },
    size: 0.35,
    strength: 0.5,
    color: '#000000',
    blend: 'multiply',
    gradient: true,
    invert: false,
  },
  {
    id: 'bottom',
    shape: 'linear',
    anchor: { x: 0.5, y: 1.0 },
    size: 0.45,
    strength: 0.7,
    color: '#000000',
    blend: 'multiply',
    gradient: true,
    invert: false,
  },
]

/** `fit` values, mapped onto CSS `object-fit`. */
const FIT_MODES = new Set(['contain', 'cover', 'fill'])

/** Where the background paints: the whole frame, or just the chat panel. */
const SCOPES = new Set(['fullscreen', 'chat'])

/** Audio sources for the floating player. */
const AUDIO_SOURCES = new Set(['none', 'video', 'custom'])

/** Documented defaults. */
export const DEFAULTS = {
  src: undefined,
  scope: 'fullscreen',
  opacity: 0.5,
  muted: true,
  volume: 0,
  fit: 'cover',
  blur: 0,
  dim: 0.45,
  scale: 1,
  speed: 1,
  themeAuto: true,
  themeColor: '#6f86ff',
  themeStrength: 0.35,
  themeBlend: 'soft-light',
  regions: DEFAULT_REGIONS,
  // ---- v0.2: background audio + UI adaptation -------------------------
  // `audioSource` is the deliberate choice; when it is 'custom' but no file
  // resolves, the client falls back to 'video'. An explicit 'none' never
  // falls back — the same three-state spirit as the splash plugin's `src`.
  audioSource: 'none',
  audio: undefined,
  audioVolume: 0.6,
  audioLoop: true,
  // UI colours: 'auto' derives readable values from the (possibly automatic)
  // theme colour and the scene luminance; a hex string overrides that role.
  // `uiText` is the shared base; `uiUserText`/`uiAssistantText` split the two
  // transcript roles; `uiBubble` colours the user message bubble; `uiSurface`
  // covers the composer input; the accent drives primary buttons ("new chat").
  uiText: 'auto',
  uiUserText: 'auto',
  uiAssistantText: 'auto',
  uiAccent: 'auto',
  uiSurface: 'auto',
  uiBubble: 'auto',
  // Code blocks: `uiCodeBlock` is the fenced-block background (the banner bar
  // follows it); `uiCodeText` is the code text, always nudged to stay readable
  // on that background.
  uiCodeBlock: 'auto',
  uiCodeText: 'auto',
  // v0.5: the primary button (sidebar 「新会话」) and inline `code` chips.
  // Each is a background + text pair; the text roles are always nudged to
  // stay readable on their own background — that fixes the white-on-white
  // button and white-on-white chip the stock tokens produce over a tinted UI.
  uiButton: 'auto',
  uiButtonText: 'auto',
  uiInlineCode: 'auto',
  uiInlineCodeText: 'auto',
  // Strength of the frosted-glass veil behind cards, inputs and buttons.
  uiSurfaceAlpha: 0.55,
}

/** @returns the lower-case extension of `file`, without the dot. */
function extensionOf(file) {
  return extname(file).replace(/^\./, '').toLowerCase()
}

/** @returns `value` when it is a finite number inside `[min, max]`, else `fallback`. */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** @returns `value` when it is a string in `allowed`, else `fallback`. */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/** @returns a CSS colour when it is `#rgb` or `#rrggbb`, else `fallback`. */
function safeColor(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : fallback
}

/**
 * Normalise one region against the schema.
 * @param raw - the region as written in YAML or JSON.
 * @param index - its position, used for the fallback id.
 * @returns the accepted region, or `null` when it is unusable.
 */
export function normalizeRegion(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 64) : `region-${index}`
  const shape = oneOf(raw.shape, SHAPES, 'linear')
  const blend = oneOf(raw.blend, BLEND_MODES, 'multiply')
  const anchor = raw.anchor !== null && typeof raw.anchor === 'object' && !Array.isArray(raw.anchor) ? raw.anchor : {}
  const anchorX = clampNumber(anchor.x, 0.5, 0, 1)
  const anchorY = clampNumber(anchor.y, shape === 'radial' ? 0.5 : 0.0, 0, 1)
  return {
    id,
    shape,
    anchor: { x: anchorX, y: anchorY },
    size: clampNumber(raw.size, shape === 'radial' ? 1.15 : 0.45, 0.05, 4),
    strength: clampNumber(raw.strength, shape === 'radial' ? 0.55 : 0.6, 0, 1),
    color: safeColor(raw.color, '#000000'),
    blend,
    gradient: typeof raw.gradient === 'boolean' ? raw.gradient : true,
    invert: typeof raw.invert === 'boolean' ? raw.invert : false,
  }
}

/**
 * Normalise the `regions` list.
 *
 * An empty list means "no extra blending", which is a legitimate choice and is
 * kept as an empty array — not replaced with the defaults, because an explicit
 * empty list is a deliberate decision the same way `src: ''` is.
 * @param raw - the configured regions.
 * @returns the accepted list.
 */
export function normalizeRegions(raw) {
  if (raw === undefined || raw === null) return DEFAULT_REGIONS.map((region) => ({ ...region }))
  if (!Array.isArray(raw)) return DEFAULT_REGIONS.map((region) => ({ ...region }))
  const seen = new Set()
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    const region = normalizeRegion(raw[i], i)
    if (region === null) continue
    if (seen.has(region.id)) region.id = `${region.id}-${i}`
    seen.add(region.id)
    out.push(region)
  }
  return out
}

/**
 * Normalise one UI-colour slot: `'auto'` (derive) or a hex override.
 * @param value - the configured value.
 * @returns `'auto'` or the accepted `#rgb`/`#rrggbb` string.
 */
export function normalizeColorChoice(value) {
  if (value === undefined || value === null) return 'auto'
  if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return 'auto'
  return safeColor(value, 'auto')
}

/**
 * Coerce a raw configuration into the effective settings.
 * @param raw - merged configuration object.
 * @returns the effective configuration with every field present and valid.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    // `undefined` means "never chosen", which lets a bundled default apply; `''`
    // means "explicitly cleared".
    src: typeof input.src === 'string' ? input.src.slice(0, MAX_SRC_LENGTH) : undefined,
    scope: oneOf(input.scope, SCOPES, DEFAULTS.scope),
    opacity: clampNumber(input.opacity, DEFAULTS.opacity, 0, 1),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULTS.muted,
    volume: clampNumber(input.volume, DEFAULTS.volume, 0, 1),
    fit: oneOf(input.fit, FIT_MODES, DEFAULTS.fit),
    blur: clampNumber(input.blur, DEFAULTS.blur, 0, 40),
    dim: clampNumber(input.dim, DEFAULTS.dim, 0, 1),
    scale: clampNumber(input.scale, DEFAULTS.scale, 0.2, 4),
    speed: clampNumber(input.speed, DEFAULTS.speed, 0.1, 4),
    themeAuto: typeof input.themeAuto === 'boolean' ? input.themeAuto : DEFAULTS.themeAuto,
    themeColor: safeColor(input.themeColor, DEFAULTS.themeColor),
    themeStrength: clampNumber(input.themeStrength, DEFAULTS.themeStrength, 0, 1),
    themeBlend: oneOf(input.themeBlend, BLEND_MODES, DEFAULTS.themeBlend),
    regions: normalizeRegions(input.regions),
    audioSource: oneOf(input.audioSource, AUDIO_SOURCES, DEFAULTS.audioSource),
    audio: typeof input.audio === 'string' ? input.audio.slice(0, MAX_SRC_LENGTH) : undefined,
    audioVolume: clampNumber(input.audioVolume, DEFAULTS.audioVolume, 0, 1),
    audioLoop: typeof input.audioLoop === 'boolean' ? input.audioLoop : DEFAULTS.audioLoop,
    uiText: normalizeColorChoice(input.uiText),
    uiUserText: normalizeColorChoice(input.uiUserText),
    uiAssistantText: normalizeColorChoice(input.uiAssistantText),
    uiAccent: normalizeColorChoice(input.uiAccent),
    uiSurface: normalizeColorChoice(input.uiSurface),
    uiBubble: normalizeColorChoice(input.uiBubble),
    uiCodeBlock: normalizeColorChoice(input.uiCodeBlock),
    uiCodeText: normalizeColorChoice(input.uiCodeText),
    uiButton: normalizeColorChoice(input.uiButton),
    uiButtonText: normalizeColorChoice(input.uiButtonText),
    uiInlineCode: normalizeColorChoice(input.uiInlineCode),
    uiInlineCodeText: normalizeColorChoice(input.uiInlineCodeText),
    uiSurfaceAlpha: clampNumber(input.uiSurfaceAlpha, DEFAULTS.uiSurfaceAlpha, 0, 1),
  }
}

/** @returns the absolute candidate path for a configured reference. */
function toAbsolutePath(reference, dshHome) {
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2))
  if (isAbsolute(reference)) return resolve(reference)
  return resolve(dshHome, reference)
}

/**
 * Describe one file to play, or why it cannot be played.
 * @param reference - the configured path.
 * @param dshHome - absolute DSH home directory.
 * @param formats - extension → MIME table; defaults to the picture formats.
 * @returns `{ configured: false }` when nothing should play, otherwise a descriptor.
 */
export function resolveMedia(reference, dshHome, formats = FORMATS) {
  const trimmed = typeof reference === 'string' ? reference.trim() : ''
  if (trimmed === '') return { configured: false }

  const path = toAbsolutePath(trimmed, dshHome)
  const extension = extensionOf(path)
  const mime = formats[extension]

  // Existence before format: a typo'd path should report "missing", not
  // "unsupported", so the user is sent to the right problem.
  if (!existsSync(path)) return { configured: true, problem: 'missing-file', extension, path }

  let stats
  try {
    stats = statSync(path)
  } catch {
    return { configured: true, problem: 'unreadable-file', extension, path }
  }
  if (!stats.isFile()) return { configured: true, problem: 'not-a-file', extension, path }
  if (mime === undefined) return { configured: true, problem: 'unsupported-format', extension, path }
  if (stats.size > MAX_MEDIA_BYTES) return { configured: true, problem: 'file-too-large', extension, path }

  const isSound = formats === SOUND_FORMATS
  return {
    configured: true,
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
    extension,
    mime,
    kind: isSound ? 'sound' : (IMAGE_KIND.has(extension) ? 'image' : 'video'),
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
  }
}

/**
 * Resolve the audio slot. Unlike video there is no bundled default: 'custom'
 * with an unset/invalid file simply means the sound falls back to the video's
 * own track, which is what the audio button does too.
 * @param audio - the configured `audio` path.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured, source, descriptor }`.
 */
export function resolveAudio(audio, dshHome) {
  if (typeof audio !== 'string' || audio.trim() === '') return { configured: false, source: 'unset', descriptor: null }
  return { configured: true, source: 'chosen', descriptor: resolveMedia(audio.trim(), dshHome, SOUND_FORMATS) }
}

/**
 * Resolve the video slot, honouring the three-state rule.
 * @param src - the configured `src`.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured, source, descriptor }`.
 */
export function resolveVideo(src, dshHome) {
  if (typeof src === 'string') {
    const trimmed = src.trim()
    if (trimmed === '') return { configured: false, source: 'cleared', descriptor: null }
    return { configured: true, source: 'chosen', descriptor: resolveMedia(trimmed, dshHome) }
  }
  if (!existsSync(BUNDLED_VIDEO)) return { configured: false, source: 'unset', descriptor: null }
  const bundled = resolveMedia(BUNDLED_VIDEO, dshHome)
  if (bundled.configured !== true || bundled.problem !== undefined) return { configured: false, source: 'unset', descriptor: null }
  return { configured: true, source: 'bundled', descriptor: bundled }
}

/** Shared 404 body. */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('not found')
}

/** Parse one `Range` header against a known length. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    if (rawEnd === '') return undefined
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined
  return { start, end }
}

/** Stream one resolved file, honouring `Range` and conditional requests. */
function serveMedia(req, res, media) {
  const seekable = SEEKABLE.has(media.mime)
  const headers = {
    'Content-Type': media.mime,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': seekable ? 'bytes' : 'none',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${media.mtimeMs.toString(36)}-${media.bytes.toString(36)}"`,
  }

  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const range = seekable ? parseRange(req.headers.range, media.bytes) : undefined
  if (seekable && req.headers.range !== undefined && range === undefined) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${media.bytes}` })
    res.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? media.bytes - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'Content-Length': String(end - start + 1),
    ...range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${media.bytes}` },
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(media.path, { start, end })
  let failed = false
  stream.on('error', () => {
    failed = true
    try {
      res.destroy()
    } catch { /* the socket may already be gone */ }
  })
  res.on('close', () => {
    if (!failed) stream.destroy()
  })
  stream.pipe(res)
}

/** Read a JSON request body with a hard size ceiling. */
function readJsonBody(req, limit) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/** Test seam for the child-process boundary. */
export const __testHooks = { runCapture: undefined }

/** Open the native picker, bypassing the Electron attempt. */
export function pickMediaFileForTest(initial, slot) {
  return pickViaPowerShell({ logger: { warn: () => {} } }, initial, slot)
}

/** @returns the state file path inside the DSH home. */
function stateFile(dshHome) {
  return join(dshHome, STATE_DIRNAME, 'config.json')
}

/** Read the settings-page state. */
function readState(dshHome) {
  const file = stateFile(dshHome)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Replace the stored state atomically. */
function writeState(dshHome, patch) {
  const dir = join(dshHome, STATE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const file = stateFile(dshHome)
  const temporary = `${file}.tmp`
  const next = { ...readState(dshHome), ...patch }
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * Open a native file dialog and resolve the chosen path.
 * @param ctx - the plugin context.
 * @param initial - an existing path to start the dialog at.
 * @param slot - `video` or `audio`; decides the dialog's filters.
 * @returns the chosen absolute path, `''` on cancel, or `undefined` when unavailable.
 */
async function pickMediaFile(ctx, initial, slot = 'video') {
  const electronResult = await pickViaElectron(initial, slot)
  if (electronResult !== undefined) return electronResult
  if (process.platform === 'win32') return pickViaPowerShell(ctx, initial, slot)
  if (process.platform === 'darwin') return pickViaOsa(initial, slot)
  return pickViaZenity(initial, slot)
}

/** Try Electron's native dialog. */
async function pickViaElectron(initial, slot = 'video') {
  if (process.versions.electron === undefined && process.type === undefined) return undefined
  let dialog
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    dialog = (require('electron').dialog ?? require('electron/main')?.dialog)
  } catch {
    return undefined
  }
  if (dialog === undefined || typeof dialog.showOpenDialog !== 'function') return undefined
  try {
    const result = await dialog.showOpenDialog({
      title: slot === 'audio' ? 'Select an audio file for the DSH chat background' : 'Select a video for the DSH chat background',
      properties: ['openFile'],
      defaultPath: initial === '' ? undefined : initial,
      filters: slot === 'audio'
        ? [
            { name: 'Audio', extensions: [...Object.keys(SOUND_FORMATS)] },
            { name: 'All files', extensions: ['*.*'] },
          ]
        : [
            { name: 'All supported media', extensions: [...Object.keys(FORMATS)] },
            { name: 'Video', extensions: Object.keys(FORMATS).filter((e) => !IMAGE_KIND.has(e)) },
            { name: 'Animated / still image', extensions: [...IMAGE_KIND] },
          ],
    })
    if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch {
    return undefined
  }
}

/** Run the bundled PowerShell picker. */
function pickViaPowerShell(ctx, initial, slot = 'video') {
  const script = join(PACKAGE_DIR, 'tools', 'pick-media-file.ps1')
  if (!existsSync(script)) {
    ctx.logger.warn('dsh-chat-background: tools/pick-media-file.ps1 is missing from the installed package; the settings page keeps its text field.')
    return Promise.resolve(undefined)
  }
  const startDir = initial === '' ? '' : dirname(initial)
  const startFile = initial === '' ? '' : initial.slice(initial.lastIndexOf(sep) + 1)
  const carrier = join(tmpdir(), `dsh-chat-bg-pick-${process.pid}-${Date.now()}.txt`)
  return (__testHooks.runCapture ?? runCapture)('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutFile', carrier,
    '-Kind', slot === 'audio' ? 'sound' : 'video',
    '-InitialDirectory', startDir,
    '-InitialFile', startFile,
  ], ctx).then((output) => {
    if (output === undefined) return undefined
    try {
      if (!existsSync(carrier)) return ''
      return readFileSync(carrier, 'utf8').replace(/^\uFEFF/, '').trim()
    } catch {
      return undefined
    } finally {
      try {
        unlinkSync(carrier)
      } catch { /* the picker may never have created it */ }
    }
  })
}

/** macOS fallback through AppleScript. */
function pickViaOsa(initial, slot = 'video') {
  const prompt = slot === 'audio' ? 'Select an audio file for the DSH chat background' : 'Select a video for the DSH chat background'
  const args = initial === ''
    ? ['-e', `POSIX path of (choose file with prompt "${prompt}")`]
    : ['-e', `POSIX path of (choose file with prompt "${prompt}" default location POSIX file "${initial}")`]
  return runCapture('osascript', args).then((output) => (output === undefined ? undefined : output.trim()))
}

/** Linux fallback through zenity. */
function pickViaZenity(initial, slot = 'video') {
  return runCapture('zenity', [
    '--file-selection',
    `--title=${slot === 'audio' ? 'Select an audio file for the DSH chat background' : 'Select a video for the DSH chat background'}`,
    ...initial === '' ? [] : [`--filename=${initial}`],
  ]).then((output) => (output === undefined ? undefined : output.trim()))
}

/** Run a child process with a timeout, capturing stdout as UTF-8. */
function runCapture(command, args, ctx) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolveRun(undefined)
      return
    }
    const outChunks = []
    let err = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch { /* already gone */ }
      finish(undefined)
    }, PICK_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (ctx !== undefined) ctx.logger.warn(`dsh-chat-background: ${command} could not be started (${error.code ?? error.message}); the settings page keeps its text field.`)
      finish(undefined)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        if (ctx !== undefined && err.trim() !== '') ctx.logger.warn(`dsh-chat-background: ${command} exited ${code}: ${err.trim().slice(0, 400)}`)
        return finish(undefined)
      }
      finish(Buffer.concat(outChunks).toString('utf8'))
    })
  })
}

/**
 * Build the descriptor sent to the browser.
 * @param descriptor - the resolved descriptor, or `null`.
 * @param route - the prefix the bytes are served under.
 * @returns the wire object.
 */
function wireDescriptor(descriptor, route) {
  if (descriptor === null || descriptor.configured !== true || descriptor.problem !== undefined) {
    return { kind: 'none', name: descriptor && descriptor.name, extension: descriptor && descriptor.extension }
  }
  return {
    url: `${route}/${encodeURIComponent(descriptor.name)}`,
    name: descriptor.name,
    kind: descriptor.kind,
    mime: descriptor.mime,
    extension: descriptor.extension,
    bytes: descriptor.bytes,
  }
}

/**
 * Mount the plugin.
 * @param ctx - the plugin context.
 * @param rawConfig - the row `config` as written in YAML.
 * @param options - test seam only.
 */
export function apply(ctx, rawConfig, options = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchConfig = normalizeConfig(rawConfig)
  const pick = options.picker ?? ((initial, slot) => pickMediaFile(ctx, initial, slot))

  /** Effective settings: patch row, then the settings-page file on top. */
  const settings = () => {
    const stored = readState(dshHome)
    const merged = { ...patchConfig }
    for (const [key, value] of Object.entries(stored)) {
      if (key in DEFAULTS) merged[key] = value
    }
    return normalizeConfig(merged)
  }

  /** Resolve the video slot for the current settings. */
  const resolve = () => resolveVideo(settings().src, dshHome)

  /** Resolve the audio slot for the current settings. */
  const resolveSound = () => resolveAudio(settings().audio, dshHome)

  ctx.inject(['webServer'], (scoped) => {
    /** The trust fence needs the request, so each handler asks per request. */
    const rejectionFor = (req) => {
      let connection
      try {
        connection = scoped.get('connection')
      } catch {
        connection = undefined
      }
      if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
      return connection.requestRejection(req)
    }

    /** Reject anything that is not this machine's own authenticated client. */
    const guard = (req, res) => {
      const rejection = rejectionFor(req)
      if (rejection === undefined) return false
      res.writeHead(rejection)
      res.end()
      return true
    }

    /** Serve one slot's bytes under its own prefix. */
    const serveSlot = (route, getDescriptor) => scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: route,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const media = getDescriptor()
        if (media === null || media.configured !== true || media.problem !== undefined) {
          notFound(res)
          return
        }
        let requested
        try {
          requested = decodeURIComponent(String(req.url ?? '').slice(route.length).replace(/^\//, '').split('?')[0])
        } catch {
          notFound(res)
          return
        }
        if (requested !== media.name) {
          notFound(res)
          return
        }
        serveMedia(req, res, media)
      },
    }))

    serveSlot(VIDEO_ROUTE, () => resolve().descriptor)
    serveSlot(AUDIO_ROUTE, () => resolveSound().descriptor)

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        const effective = settings()
        const video = resolve()
        const audio = resolveSound()
        const ok = video.configured === true && video.descriptor !== null && video.descriptor.problem === undefined
        const audioOk = audio.descriptor !== null && audio.descriptor.configured === true && audio.descriptor.problem === undefined
        const videoIsVideo = video.descriptor !== null && video.descriptor.kind === 'video'
        // The effective sound source the client should act on: an explicit
        // choice that resolves, else the video's own track, else silence.
        let soundSource = 'none'
        if (effective.audioSource === 'custom') {
          if (audioOk) soundSource = 'custom'
          else if (videoIsVideo) soundSource = 'video-fallback'
        } else if (effective.audioSource === 'video' && videoIsVideo) {
          soundSource = 'video'
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({
          version: 2,
          settings: effective,
          video: wireDescriptor(video.descriptor, VIDEO_ROUTE),
          videoSource: video.source,
          videoProblem: ok ? null : (video.descriptor && video.descriptor.problem) ?? null,
          effectiveSrc: ok ? (video.source === 'bundled' ? BUNDLED_VIDEO : effective.src) : '',
          chosen: video.source === 'chosen' || video.source === 'cleared',
          audio: wireDescriptor(audio.descriptor, AUDIO_ROUTE),
          audioSource: audio.source,
          audioProblem: (audio.descriptor && audio.descriptor.problem) ?? null,
          soundSource,
          effectiveAudioSrc: audioOk ? effective.audio : '',
        }))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 32 * 1024)
        if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        // Only the keys the settings page owns are writable; everything else is
        // ignored rather than silently stored, so a malformed row cannot change
        // the picture the next boot paints.
        const allowed = ['src', 'scope', 'opacity', 'muted', 'volume', 'fit', 'blur', 'dim', 'scale', 'speed', 'themeAuto', 'themeColor', 'themeStrength', 'themeBlend', 'regions', 'audioSource', 'audio', 'audioVolume', 'audioLoop', 'uiText', 'uiUserText', 'uiAssistantText', 'uiAccent', 'uiSurface', 'uiBubble', 'uiCodeBlock', 'uiCodeText', 'uiButton', 'uiButtonText', 'uiInlineCode', 'uiInlineCodeText', 'uiSurfaceAlpha']
        const patch = {}
        for (const key of allowed) {
          if (!Object.prototype.hasOwnProperty.call(body, key)) continue
          const value = body[key]
          if (key === 'src' || key === 'audio') {
            if (typeof value !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
              return
            }
            patch[key] = value.trim().slice(0, MAX_SRC_LENGTH)
            continue
          }
          if (key === 'regions') {
            if (!Array.isArray(value)) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
              return
            }
            patch.regions = value
            continue
          }
          if (key === 'muted' || key === 'themeAuto' || key === 'audioLoop') {
            if (typeof value !== 'boolean') {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
              return
            }
            patch[key] = value
            continue
          }
          if (key === 'uiText' || key === 'uiUserText' || key === 'uiAssistantText' || key === 'uiAccent' || key === 'uiSurface' || key === 'uiBubble'
            || key === 'uiCodeBlock' || key === 'uiCodeText'
            || key === 'uiButton' || key === 'uiButtonText' || key === 'uiInlineCode' || key === 'uiInlineCodeText') {
            // 'auto' or a hex colour. A malformed hex is not refused here:
            // normalizeConfig falls it back to 'auto' on read, the same contract
            // the YAML patch row follows — a typo cannot brick the styling.
            if (typeof value !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
              return
            }
            patch[key] = normalizeColorChoice(value)
            continue
          }
          if (typeof value !== 'number' && typeof value !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
            return
          }
          patch[key] = value
        }
        if (Object.keys(patch).length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        try {
          writeState(dshHome, patch)
        } catch (error) {
          ctx.logger.warn(`dsh-chat-background: could not write the state file (${error.code ?? error.message})`)
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'write-failed' }))
          return
        }
        const effective = settings()
        const video = resolve()
        const audio = resolveSound()
        const audioOk = audio.descriptor !== null && audio.descriptor.configured === true && audio.descriptor.problem === undefined
        const videoIsVideo = video.descriptor !== null && video.descriptor.kind === 'video'
        let soundSource = 'none'
        if (effective.audioSource === 'custom') {
          if (audioOk) soundSource = 'custom'
          else if (videoIsVideo) soundSource = 'video-fallback'
        } else if (effective.audioSource === 'video' && videoIsVideo) {
          soundSource = 'video'
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          version: 2,
          settings: effective,
          video: wireDescriptor(video.descriptor, VIDEO_ROUTE),
          videoSource: video.source,
          videoProblem: (video.descriptor && video.descriptor.problem) ?? null,
          effectiveSrc: video.configured === true && video.descriptor !== null && video.descriptor.problem === undefined
            ? (video.source === 'bundled' ? BUNDLED_VIDEO : effective.src)
            : '',
          audio: wireDescriptor(audio.descriptor, AUDIO_ROUTE),
          audioProblem: (audio.descriptor && audio.descriptor.problem) ?? null,
          soundSource,
          effectiveAudioSrc: audioOk ? effective.audio : '',
        }))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: PICK_ROUTE,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req, 4 * 1024)
        const slot = body !== null && typeof body === 'object' && body.slot === 'audio' ? 'audio' : 'video'
        const initial = slot === 'audio' ? (settings().audio || '') : (settings().src || '')
        const chosen = await pick(initial, slot)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(chosen === undefined ? { ok: false, error: 'picker-unavailable' } : { ok: true, path: chosen }))
      },
    }))
  })
}
