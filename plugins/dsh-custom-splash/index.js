/**
 * dsh-custom-splash — Host half.
 *
 * A custom DSH splash screen that plays a picture (video or animated image) and
 * SOUND, then dissolves into the interface.
 *
 * Why this plugin is split into two halves:
 *   - a browser cannot read a local file path, so the chosen files and their
 *     validation live here;
 *   - video and audio need HTTP Range so a splash streams instead of buffering
 *     whole;
 *   - the native file dialog has to open in the Host process.
 *
 * Sound model (the reason this plugin exists):
 *   - `src`    is the picture. `undefined` (never chosen) uses the bundled
 *              default, `''` (cleared) plays no picture, a path plays that file.
 *   - `audio`  is the sound. `undefined` means AUTO: the bundled WAV when the
 *              picture is the bundled default, otherwise the video's own audio
 *              track (and nothing for a silent picture). `''` means mute.
 *   - `muted`  master mute; defaults to `false` because the point is sound.
 *   - Chromium refuses unmuted autoplay before a user gesture, so the client
 *     plays muted at first and unmutes on the first pointer/key/touch. That is
 *     `unlockOnGesture`.
 *
 * Zero runtime dependencies, deliberately (see the module doc of the reference
 * plugin this is modelled on): a `link:` install resolves imports from its own
 * directory, so a dependency that only ships inside DSH breaks the profile.
 *
 * @module dsh-custom-splash
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of this package's directory; the picker script resolves from here. */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** Route namespace. Absolute, so it works over HTTP and the Electron IPC bridge. */
const ROUTE_BASE = '/dsh-custom-splash'
const CONFIG_ROUTE = `${ROUTE_BASE}/config.json`
const PICTURE_ROUTE = `${ROUTE_BASE}/picture`
const SOUND_ROUTE = `${ROUTE_BASE}/sound`
const SAVE_ROUTE = `${ROUTE_BASE}/config`
const PICK_ROUTE = `${ROUTE_BASE}/pick`

/** Directory inside the DSH home that holds this plugin's own state. */
const STATE_DIRNAME = 'dsh-custom-splash'

/** Bundled default picture and sound, shipped inside the package. */
const BUNDLED_PICTURE = join(PACKAGE_DIR, 'assets', 'default.gif')
const BUNDLED_SOUND = join(PACKAGE_DIR, 'assets', 'default.wav')

/** Largest file this plugin will serve; guards against a mis-typed path. */
const MAX_MEDIA_BYTES = 4096 * 1024 * 1024

/** Upper bound on a stored path. */
const MAX_SRC_LENGTH = 4096

/** How long the native picker may stay open before the Host gives up. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/** Extension → MIME for picture material. */
const PICTURE_FORMATS = {
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
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webma: 'audio/webm',
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
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'audio/webm',
])

/** Documented defaults. */
export const DEFAULTS = {
  src: undefined,
  audio: undefined,
  duration: 0,
  skip: 'button',
  skipAfterMs: 1200,
  muted: false,
  volume: 0.7,
  unlockOnGesture: true,
  fit: 'cover',
  background: '#000000',
  fadeInMs: 320,
  fadeOutMs: 300,
  playbackRate: 1,
  waitForAppMs: 2500,
  holdAfterEndMs: 0,
  maxReplays: 0,
}

/** `skip` values the player implements. */
const SKIP_MODES = new Set(['button', 'click', 'auto', 'never'])
/** `fit` values, mapped onto CSS `object-fit`. */
const FIT_MODES = new Set(['contain', 'cover', 'fill'])

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

/**
 * Coerce a raw configuration into the effective settings.
 * @param raw - merged configuration object.
 * @returns the effective configuration with every field present and valid.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const background = typeof input.background === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.background)
    ? input.background
    : DEFAULTS.background
  return {
    // `undefined` means "never chosen", which lets a bundled default apply; `''`
    // means "explicitly cleared".
    src: typeof input.src === 'string' ? input.src.slice(0, MAX_SRC_LENGTH) : undefined,
    audio: typeof input.audio === 'string' ? input.audio.slice(0, MAX_SRC_LENGTH) : undefined,
    duration: clampNumber(input.duration, DEFAULTS.duration, 0, 600000),
    skip: oneOf(input.skip, SKIP_MODES, DEFAULTS.skip),
    skipAfterMs: clampNumber(input.skipAfterMs, DEFAULTS.skipAfterMs, 0, 60000),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULTS.muted,
    volume: clampNumber(input.volume, DEFAULTS.volume, 0, 1),
    unlockOnGesture: typeof input.unlockOnGesture === 'boolean' ? input.unlockOnGesture : DEFAULTS.unlockOnGesture,
    fit: oneOf(input.fit, FIT_MODES, DEFAULTS.fit),
    background,
    fadeInMs: clampNumber(input.fadeInMs, DEFAULTS.fadeInMs, 0, 10000),
    fadeOutMs: clampNumber(input.fadeOutMs, DEFAULTS.fadeOutMs, 0, 10000),
    playbackRate: clampNumber(input.playbackRate, DEFAULTS.playbackRate, 0.1, 4),
    waitForAppMs: clampNumber(input.waitForAppMs, DEFAULTS.waitForAppMs, 0, 60000),
    holdAfterEndMs: clampNumber(input.holdAfterEndMs, DEFAULTS.holdAfterEndMs, 0, 60000),
    maxReplays: Math.round(clampNumber(input.maxReplays, DEFAULTS.maxReplays, 0, 100)),
  }
}

/**
 * Accept `value` as a finite number inside `[min, max]`, else `fallback`.
 * @param value - the configured value.
 * @param fallback - the default.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the accepted number.
 */
function toAbsolutePath(reference, dshHome) {
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2))
  if (isAbsolute(reference)) return resolve(reference)
  return resolve(dshHome, reference)
}

/**
 * Describe one file to play, or why it cannot be played.
 * @param reference - the configured path.
 * @param dshHome - absolute DSH home directory.
 * @param formats - extension → MIME table for this slot.
 * @param images - the set of image extensions, or `null` for a sound slot.
 * @returns `{ configured: false }` when nothing should play, otherwise a descriptor.
 */
export function resolveMedia(reference, dshHome, formats, images) {
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

  return {
    configured: true,
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
    extension,
    mime,
    kind: images !== null && images.has(extension) ? 'image' : (images === null ? 'sound' : 'video'),
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
  }
}

/**
 * Resolve the picture slot, honouring the three-state rule.
 * @param src - the configured `src`.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured, source, descriptor }`.
 */
export function resolvePicture(src, dshHome) {
  if (typeof src === 'string') {
    const trimmed = src.trim()
    if (trimmed === '') return { configured: false, source: 'cleared', descriptor: null }
    return { configured: true, source: 'chosen', descriptor: resolveMedia(trimmed, dshHome, PICTURE_FORMATS, IMAGE_KIND) }
  }
  if (!existsSync(BUNDLED_PICTURE)) return { configured: false, source: 'unset', descriptor: null }
  const bundled = resolveMedia(BUNDLED_PICTURE, dshHome, PICTURE_FORMATS, IMAGE_KIND)
  if (bundled.configured !== true || bundled.problem !== undefined) return { configured: false, source: 'unset', descriptor: null }
  return { configured: true, source: 'bundled', descriptor: bundled }
}

/**
 * Resolve the sound slot.
 *
 * `undefined` is AUTO, not "bundled":
 *   - picture is the bundled default (or absent) → the bundled WAV;
 *   - picture is a user video → that video's own audio track (no separate file);
 *   - picture is a user image → silence.
 * `''` is an explicit mute and never falls back to anything.
 * @param audio - the configured `audio`.
 * @param picture - the resolved picture descriptor, or `null`.
 * @param pictureSource - `bundled` | `chosen` | `cleared` | `unset`.
 * @param dshHome - absolute DSH home directory.
 * @returns `{ configured, source, descriptor }`.
 */
export function resolveSound(audio, picture, pictureSource, dshHome) {
  if (typeof audio === 'string') {
    const trimmed = audio.trim()
    if (trimmed === '') return { configured: false, source: 'cleared', descriptor: null }
    return { configured: true, source: 'chosen', descriptor: resolveMedia(trimmed, dshHome, SOUND_FORMATS, null) }
  }
  // AUTO.
  const pictureIsBundled = pictureSource === 'bundled'
  const pictureIsImage = picture !== null && picture.kind === 'image'
  if (!pictureIsBundled && (picture === null || pictureIsImage)) {
    // A chosen still image carries no audio of its own.
    if (picture === null) {
      if (!existsSync(BUNDLED_SOUND)) return { configured: false, source: 'unset', descriptor: null }
      const bundled = resolveMedia(BUNDLED_SOUND, dshHome, SOUND_FORMATS, null)
      if (bundled.configured !== true || bundled.problem !== undefined) return { configured: false, source: 'unset', descriptor: null }
      return { configured: true, source: 'bundled', descriptor: bundled }
    }
    return { configured: false, source: 'auto-picture-audio', descriptor: null }
  }
  if (pictureIsBundled) {
    if (!existsSync(BUNDLED_SOUND)) return { configured: false, source: 'unset', descriptor: null }
    const bundled = resolveMedia(BUNDLED_SOUND, dshHome, SOUND_FORMATS, null)
    if (bundled.configured !== true || bundled.problem !== undefined) return { configured: false, source: 'unset', descriptor: null }
    return { configured: true, source: 'bundled', descriptor: bundled }
  }
  // A chosen video: its own audio track is the sound.
  return { configured: true, source: 'picture-audio', descriptor: null }
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
export function pickMediaFileForTest(initial, kind) {
  return pickViaPowerShell({ logger: { warn: () => {} } }, initial, kind)
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

/** Replace the stored `src`/`audio` atomically. */
function writeState(dshHome, patch) {
  const dir = join(dshHome, STATE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const file = stateFile(dshHome)
  const temporary = `${file}.tmp`
  // A `null` value means "delete this key", which is how the settings page
  // returns a slot to AUTO (the difference between "never chosen" and "the user
  // picked the automatic rule" is meaningful, so it must be removable).
  const next = { ...readState(dshHome) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * Open a native file dialog and resolve the chosen path.
 * @param ctx - the plugin context.
 * @param initial - an existing path to start the dialog at.
 * @param kind - `picture` | `sound` | `any`; filters the dialog.
 * @returns the chosen absolute path, `''` on cancel, or `undefined` when unavailable.
 */
async function pickMediaFile(ctx, initial, kind = 'any') {
  const electronResult = await pickViaElectron(initial, kind)
  if (electronResult !== undefined) return electronResult
  if (process.platform === 'win32') return pickViaPowerShell(ctx, initial, kind)
  if (process.platform === 'darwin') return pickViaOsa(initial)
  return pickViaZenity(initial)
}

/** Try Electron's native dialog. */
async function pickViaElectron(initial, kind) {
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
    const picture = Object.keys(PICTURE_FORMATS).filter((e) => !IMAGE_KIND.has(e))
    const result = await dialog.showOpenDialog({
      title: 'Select media for the DSH splash',
      properties: ['openFile'],
      defaultPath: initial === '' ? undefined : initial,
      filters: kind === 'sound'
        ? [
            { name: 'Audio', extensions: [...Object.keys(SOUND_FORMATS)] },
            { name: 'All files', extensions: ['*.*'] },
          ]
        : [
            { name: 'All supported media', extensions: [...Object.keys(PICTURE_FORMATS), ...Object.keys(SOUND_FORMATS)] },
            { name: 'Video', extensions: picture },
            { name: 'Animated / still image', extensions: [...IMAGE_KIND] },
            { name: 'Audio', extensions: [...Object.keys(SOUND_FORMATS)] },
          ],
    })
    if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch {
    return undefined
  }
}

/** Run the bundled PowerShell picker. */
function pickViaPowerShell(ctx, initial, kind) {
  const script = join(PACKAGE_DIR, 'tools', 'pick-media-file.ps1')
  if (!existsSync(script)) {
    ctx.logger.warn('dsh-custom-splash: tools/pick-media-file.ps1 is missing from the installed package; the settings page keeps its text fields.')
    return Promise.resolve(undefined)
  }
  const startDir = initial === '' ? '' : dirname(initial)
  const startFile = initial === '' ? '' : initial.slice(initial.lastIndexOf(sep) + 1)
  const carrier = join(tmpdir(), `dsh-custom-splash-pick-${process.pid}-${Date.now()}.txt`)
  return (__testHooks.runCapture ?? runCapture)('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutFile', carrier,
    '-Kind', kind,
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
function pickViaOsa(initial) {
  const prompt = 'Select media for the DSH splash'
  const args = initial === ''
    ? ['-e', `POSIX path of (choose file with prompt "${prompt}")`]
    : ['-e', `POSIX path of (choose file with prompt "${prompt}" default location POSIX file "${initial}")`]
  return runCapture('osascript', args).then((output) => (output === undefined ? undefined : output.trim()))
}

/** Linux fallback through zenity. */
function pickViaZenity(initial) {
  return runCapture('zenity', [
    '--file-selection',
    '--title=Select media for the DSH splash',
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
      if (ctx !== undefined) ctx.logger.warn(`dsh-custom-splash: ${command} could not be started (${error.code ?? error.message}); the settings page keeps its text fields.`)
      finish(undefined)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        if (ctx !== undefined && err.trim() !== '') ctx.logger.warn(`dsh-custom-splash: ${command} exited ${code}: ${err.trim().slice(0, 400)}`)
        return finish(undefined)
      }
      finish(Buffer.concat(outChunks).toString('utf8'))
    })
  })
}

/**
 * Build the descriptor sent to the browser for one slot.
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
 * Mount the splash.
 * @param ctx - the plugin context.
 * @param rawConfig - the row `config` as written in YAML.
 * @param options - test seam only.
 */
export function apply(ctx, rawConfig, options = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchConfig = normalizeConfig(rawConfig)
  const pick = options.picker ?? ((initial, kind) => pickMediaFile(ctx, initial, kind))

  /** Effective settings: patch row, then the settings-page file on top. */
  const settings = () => {
    const stored = readState(dshHome)
    const merged = { ...patchConfig }
    for (const [key, value] of Object.entries(stored)) {
      if (key in DEFAULTS) merged[key] = value
    }
    return normalizeConfig(merged)
  }

  /** Resolve both slots for the current settings. */
  const resolve = () => {
    const effective = settings()
    const picture = resolvePicture(effective.src, dshHome)
    const sound = resolveSound(effective.audio, picture.descriptor, picture.source, dshHome)
    return { effective, picture, sound }
  }

  // Suppress the shell's own boot layer while our splash owns the screen.
  //
  // Mirrors the proven mechanism from dsh-splash-animation: hide the boot
  // spinner, hide `#root`, and force a dark base colour so a light-theme machine
  // does not flash white before the splash paints. The client removes the style
  // element exactly once when it has mounted; the inline guard releases it if
  // the client never runs.
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const { picture, sound } = resolve()
      if (picture.configured !== true && sound.configured !== true) return
      const alreadyPresent = table.some((row) => row && row.kind === 'style' && typeof row.text === 'string' && row.text.includes('dsh-custom-splash-boot'))
      if (alreadyPresent) return
      table.push({
        kind: 'style',
        text: '/* dsh-custom-splash-boot */ [data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}'
          + '/* dsh-custom-splash-cover */ #root{visibility:hidden!important}'
          + '/* dsh-custom-splash-base */ html,body{background-color:#000!important}',
      })
      table.push({
        kind: 'script',
        placement: 'head',
        text: '/* dsh-custom-splash-guard */'
          + 'try{'
          + 'var m=["dsh-custom-splash-cover","dsh-custom-splash-base"];'
          + 'var go=function(){try{'
          + 'var ss=document.head?document.head.getElementsByTagName("style"):[],doomed=[];'
          + 'for(var i=0;i<ss.length;i++){var x=ss[i].textContent||"";'
          + 'for(var j=0;j<m.length;j++){if(x.indexOf(m[j])!==-1){doomed.push(ss[i]);break}}}'
          + 'for(var k=0;k<doomed.length;k++){doomed[k].remove()}}catch(e){}};'
          + 'var t=setTimeout(go,10000);'
          + 'globalThis.__DSH_CUSTOM_SPLASH_COVER_GUARD__={release:go,clear:function(){clearTimeout(t)}}'
          + '}catch(e){}',
      })
    } catch { /* a broken settings read must not break index rendering */ }
  })

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
        const descriptor = getDescriptor()
        if (descriptor.configured !== true || descriptor.problem !== undefined) {
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
        if (requested !== descriptor.name) {
          notFound(res)
          return
        }
        serveMedia(req, res, descriptor)
      },
    }))

    serveSlot(PICTURE_ROUTE, () => resolve().picture.descriptor)
    serveSlot(SOUND_ROUTE, () => resolve().sound.descriptor)

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => {
        if (guard(req, res)) return
        const { effective, picture, sound } = resolve()
        const pictureOk = picture.configured === true && picture.descriptor !== null && picture.descriptor.problem === undefined
        const soundOk = sound.configured === true && sound.descriptor !== null && sound.descriptor.problem === undefined
        // `configured` for the whole splash: sound may be the video's own track
        // (descriptor null, source `picture-audio`), which still counts.
        const soundActive = sound.configured === true
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({
          version: 1,
          settings: effective,
          picture: wireDescriptor(picture.descriptor, PICTURE_ROUTE),
          sound: wireDescriptor(sound.descriptor, SOUND_ROUTE),
          // Sound can be the picture's own audio track; report it separately so the
          // settings page can describe it.
          soundSource: sound.source,
          soundActive,
          pictureProblem: pictureOk ? null : (picture.descriptor && picture.descriptor.problem) ?? null,
          soundProblem: soundOk ? null : (sound.descriptor && sound.descriptor.problem) ?? null,
          pictureSource: picture.source,
          effectivePictureSrc: pictureOk ? (picture.source === 'bundled' ? BUNDLED_PICTURE : effective.src) : '',
          effectiveSoundSrc: soundOk ? (sound.source === 'bundled' ? BUNDLED_SOUND : effective.audio) : '',
          chosen: picture.source === 'chosen' || picture.source === 'cleared' || sound.source === 'chosen' || sound.source === 'cleared',
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
        const body = await readJsonBody(req, 16 * 1024)
        if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        // Either or both slots may be saved in one call; absent keys are untouched.
        // A `null` value means "return this slot to AUTO", which deletes the key
        // from the state file (see `writeState`).
        const has = (key) => Object.prototype.hasOwnProperty.call(body, key)
        const srcRaw = has('src') ? body.src : undefined
        const audioRaw = has('audio') ? body.audio : undefined
        const srcValid = srcRaw === undefined || srcRaw === null || typeof srcRaw === 'string'
        const audioValid = audioRaw === undefined || audioRaw === null || typeof audioRaw === 'string'
        if (!srcValid || !audioValid) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        const patch = {}
        if (srcRaw === null) patch.src = null
        else if (srcRaw !== undefined) patch.src = srcRaw.trim().slice(0, MAX_SRC_LENGTH)
        if (audioRaw === null) patch.audio = null
        else if (audioRaw !== undefined) patch.audio = audioRaw.trim().slice(0, MAX_SRC_LENGTH)
        if (Object.keys(patch).length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'invalid-body' }))
          return
        }
        try {
          writeState(dshHome, patch)
        } catch (error) {
          ctx.logger.warn(`dsh-custom-splash: could not write the state file (${error.code ?? error.message})`)
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'write-failed' }))
          return
        }
        const { effective, picture, sound } = resolve()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          version: 1,
          settings: effective,
          picture: wireDescriptor(picture.descriptor, PICTURE_ROUTE),
          sound: wireDescriptor(sound.descriptor, SOUND_ROUTE),
          soundSource: sound.source,
          soundActive: sound.configured === true,
          pictureProblem: (picture.descriptor && picture.descriptor.problem) ?? null,
          soundProblem: (sound.descriptor && sound.descriptor.problem) ?? null,
          pictureSource: picture.source,
          effectivePictureSrc: picture.configured === true && picture.descriptor !== null && picture.descriptor.problem === undefined
            ? (picture.source === 'bundled' ? BUNDLED_PICTURE : effective.src)
            : '',
          effectiveSoundSrc: sound.configured === true && sound.descriptor !== null && sound.descriptor.problem === undefined
            ? (sound.source === 'bundled' ? BUNDLED_SOUND : effective.audio)
            : '',
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
        const slot = body !== null && typeof body === 'object' && typeof body.slot === 'string' ? body.slot : 'picture'
        const kind = slot === 'sound' ? 'sound' : 'picture'
        const { effective } = resolve()
        const initial = kind === 'sound' ? (effective.audio || '') : (effective.src || '')
        const chosen = await pick(initial, kind)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(chosen === undefined ? { ok: false, error: 'picker-unavailable' } : { ok: true, path: chosen }))
      },
    }))
  })
}
