/**
 * Contract test for the dsh-chat-background host half.
 *
 * Runs `apply` against a mock Cordis context, then drives the registered HTTP
 * routes directly — no network, no Electron. Catches the classes of bug that
 * matter here: a wrong route prefix, a descriptor that disagrees with the
 * resolver, a Range response a `<video>` cannot use, and the three-state `src`
 * rule.
 *
 * Run: node tools/verify-contract.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const INDEX = pathToFileURL(join(PACKAGE_DIR, 'index.js')).href

const { apply, normalizeConfig, normalizeRegion, normalizeRegions, normalizeColorChoice, resolveVideo, resolveAudio, resolveMedia, DEFAULTS } = await import(INDEX)

let failures = 0
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

/* ------------------------------------------------------------------ */
/* Config normalisation                                               */
/* ------------------------------------------------------------------ */
section('normalizeConfig')
{
  const d = normalizeConfig(undefined)
  check('undefined → defaults', d.opacity === 0.5 && d.muted === true && d.fit === 'cover', JSON.stringify(d))
  check('default regions present', Array.isArray(d.regions) && d.regions.length === 3, JSON.stringify(d.regions))
  check('v2 defaults', d.scope === 'fullscreen' && d.audioSource === 'none' && d.uiText === 'auto' && d.uiAccent === 'auto' && d.uiSurface === 'auto' && d.uiSurfaceAlpha === 0.55, JSON.stringify({ scope: d.scope, audioSource: d.audioSource, uiText: d.uiText }))
  check('v3 role defaults', d.uiUserText === 'auto' && d.uiAssistantText === 'auto' && d.uiBubble === 'auto', JSON.stringify({ user: d.uiUserText, assistant: d.uiAssistantText, bubble: d.uiBubble }))
  check('v4 code defaults', d.uiCodeBlock === 'auto' && d.uiCodeText === 'auto', JSON.stringify({ block: d.uiCodeBlock, text: d.uiCodeText }))
  check('v5 button/inline defaults', d.uiButton === 'auto' && d.uiButtonText === 'auto' && d.uiInlineCode === 'auto' && d.uiInlineCodeText === 'auto', JSON.stringify({ b: d.uiButton, bt: d.uiButtonText, i: d.uiInlineCode, it: d.uiInlineCodeText }))
  const n = normalizeConfig({ opacity: 9, blur: -3, dim: 2, scale: 0, speed: 0, fit: 'x', themeColor: 'red', scope: 'diagonal', audioSource: 'bluetooth', audioVolume: -1, uiText: 'rebeccapurple', uiAccent: '#123456', uiSurfaceAlpha: 8 })
  check('bad values clamp or fall back', n.opacity === 1 && n.blur === 0 && n.dim === 1 && n.scale === 0.2 && n.speed === 0.1 && n.fit === 'cover' && n.themeColor === '#6f86ff', JSON.stringify(n))
  check('bad v2 values fall back', n.scope === 'fullscreen' && n.audioSource === 'none' && n.audioVolume === 0 && n.uiText === 'auto' && n.uiAccent === '#123456' && n.uiSurfaceAlpha === 1, JSON.stringify(n))
  const c = normalizeConfig({ src: 'a', opacity: 0.25, blur: 6, dim: 0.3, scale: 1.5, speed: 1.5, themeAuto: false, themeColor: '#abcdef', themeStrength: 0.5, themeBlend: 'overlay' })
  check('good values pass through', c.src === 'a' && c.opacity === 0.25 && c.blur === 6 && c.dim === 0.3 && c.scale === 1.5 && c.speed === 1.5 && c.themeAuto === false && c.themeColor === '#abcdef' && c.themeStrength === 0.5 && c.themeBlend === 'overlay', JSON.stringify(c))
}

section('normalizeRegion / normalizeRegions')
{
  const r = normalizeRegion({ id: 'v', shape: 'radial', anchor: { x: 2, y: -1 }, size: 9, strength: 5, color: '#fff', blend: 'nope', gradient: false, invert: true }, 0)
  check('region clamps and falls back', r.anchor.x === 1 && r.anchor.y === 0 && r.size === 4 && r.strength === 1 && r.color === '#fff' && r.blend === 'multiply' && r.gradient === false && r.invert === true, JSON.stringify(r))
  check('invalid colour falls back', normalizeRegion({ color: 'not-a-colour' }, 0).color === '#000000')
  check('region id from index when absent', normalizeRegion({}, 3).id === 'region-3')
  const empty = normalizeRegions([])
  check('empty list is preserved', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))
  const bad = normalizeRegions([null, 'x', 5])
  check('bad entries are dropped', bad.length === 0, JSON.stringify(bad))
  const dup = normalizeRegions([{ id: 'a' }, { id: 'a' }])
  check('duplicate ids get suffixed', dup[0].id === 'a' && dup[1].id === 'a-1', JSON.stringify(dup.map((x) => x.id)))
  const none = normalizeRegions(undefined)
  check('undefined → default regions', none.length === 3 && none[0].id === 'vignette', JSON.stringify(none.map((x) => x.id)))
}

/* ------------------------------------------------------------------ */
/* Media resolution                                                   */
/* ------------------------------------------------------------------ */
const home = mkdtempSync(join(tmpdir(), 'dsh-chat-bg-verify-'))
const videoPath = join(home, 'bg.mp4')
const imagePath = join(home, 'bg.gif')
const missingPath = join(home, 'nope.mp4')
const audioPath = join(home, 'theme.mp3')
writeFileSync(videoPath, Buffer.alloc(4096, 1))
writeFileSync(imagePath, Buffer.alloc(2048, 2))
writeFileSync(audioPath, Buffer.alloc(1024, 3))

section('resolveVideo')
{
  const bundled = resolveVideo(undefined, home)
  check('unset → bundled', bundled.configured === true && bundled.source === 'bundled' && bundled.descriptor.kind === 'image', JSON.stringify(bundled))
  const cleared = resolveVideo('', home)
  check('empty → cleared, not configured', cleared.configured === false && cleared.source === 'cleared', JSON.stringify(cleared))
  const chosen = resolveVideo(videoPath, home)
  check('path → chosen video', chosen.configured === true && chosen.source === 'chosen' && chosen.descriptor.kind === 'video', JSON.stringify(chosen))
  const missing = resolveVideo(missingPath, home)
  check('missing file reports missing-file', missing.configured === true && missing.descriptor.problem === 'missing-file', JSON.stringify(missing))
}

section('normalizeColorChoice / resolveAudio')
{
  check('undefined → auto', normalizeColorChoice(undefined) === 'auto')
  check('literal auto', normalizeColorChoice('auto') === 'auto')
  check('hex passes', normalizeColorChoice('#abcdef') === '#abcdef')
  check('bad hex → auto', normalizeColorChoice('rebeccapurple') === 'auto')
  const unset = resolveAudio(undefined, home)
  check('audio unset → not configured', unset.configured === false && unset.source === 'unset', JSON.stringify(unset))
  const cleared = resolveAudio('', home)
  check('audio cleared → not configured', cleared.configured === false, JSON.stringify(cleared))
  const chosen = resolveAudio(audioPath, home)
  check('audio path resolves as sound', chosen.configured === true && chosen.descriptor.kind === 'sound' && chosen.descriptor.mime === 'audio/mpeg', JSON.stringify(chosen))
  const wrongKind = resolveAudio(videoPath, home)
  check('video file in audio slot is unsupported', wrongKind.descriptor.problem === 'unsupported-format', JSON.stringify(wrongKind.descriptor))
}

section('resolveMedia')
{
  const mp4 = resolveMedia(videoPath, home)
  check('mp4 resolves as video', mp4.configured === true && mp4.kind === 'video' && mp4.mime === 'video/mp4', JSON.stringify(mp4))
  const gif = resolveMedia(imagePath, home)
  check('gif resolves as image', gif.configured === true && gif.kind === 'image', JSON.stringify(gif))
}

/* ------------------------------------------------------------------ */
/* HTTP routes via a mock Cordis context                             */
/* ------------------------------------------------------------------ */
function makeContext() {
  const routes = new Map()
  const ctx = {
    inject(keys, fn) {
      const scoped = {
        effect(run) {
          run()
        },
        webServer: {
          register(route) {
            routes.set(route.path, route)
          },
        },
        get() {
          return undefined
        },
      }
      fn(scoped)
    },
    logger: { warn: () => {} },
  }
  return { ctx, routes }
}

function callRoute(route, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolveCall) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = headers

    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolveCall({ status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
    }

    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    })
    res.status = 0
    res.headers = {}
    res.destroyed = false
    res.writeHead = function (status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders || {}
    }
    res.destroy = function () {
      this.destroyed = true
      if (this.listenerCount('close') > 0) this.emit('close')
    }
    res.end = function (payload) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
      finish()
      return this
    }

    const returned = route.handler(req, res)
    if (body !== undefined) {
      Promise.resolve().then(() => {
        req.emit('data', Buffer.from(body))
        req.emit('end')
      })
    }
    if (returned !== undefined && typeof returned.then === 'function') {
      returned.then(finish, finish)
    }
  })
}

process.env.DSH_HOME = home
const { ctx, routes } = makeContext()
apply(ctx, { src: undefined, opacity: 0.5 }, {})

section('route table')
{
  const expected = ['/dsh-chat-background/config.json', '/dsh-chat-background/config', '/dsh-chat-background/pick', '/dsh-chat-background/video', '/dsh-chat-background/audio']
  for (const path of expected) {
    check(`route registered: ${path}`, routes.has(path), [...routes.keys()].join(', '))
  }
  check('video route is a prefix', routes.get('/dsh-chat-background/video')?.kind === 'prefix')
  check('audio route is a prefix', routes.get('/dsh-chat-background/audio')?.kind === 'prefix')
}

section('GET config.json (bundled default)')
{
  const res = await callRoute(routes.get('/dsh-chat-background/config.json'))
  const payload = JSON.parse(res.body)
  check('status 200', res.status === 200, res.status)
  check('version is 2', payload.version === 2, payload.version)
  check('video is bundled image', payload.video.kind === 'image' && payload.videoSource === 'bundled', JSON.stringify(payload.video))
  check('video url is under the video route', payload.video.url.startsWith('/dsh-chat-background/video/'), payload.video.url)
  check('audio unset → kind none', payload.audio.kind === 'none', JSON.stringify(payload.audio))
  check('soundSource none by default', payload.soundSource === 'none', payload.soundSource)
  check('opacity defaults to 0.5', payload.settings.opacity === 0.5)
  check('muted defaults to true', payload.settings.muted === true)
  check('themeAuto defaults to true', payload.settings.themeAuto === true)
  check('themeColor defaults', payload.settings.themeColor === '#6f86ff')
  check('regions default', Array.isArray(payload.settings.regions) && payload.settings.regions.length === 3)
}

section('video byte route')
{
  const config = JSON.parse((await callRoute(routes.get('/dsh-chat-background/config.json'))).body)
  const name = config.video.name
  const full = await callRoute(routes.get('/dsh-chat-background/video'), { url: `/dsh-chat-background/video/${encodeURIComponent(name)}` })
  check('gif full request 200', full.status === 200, full.status)
  check('gif is not range-seekable', full.headers['Accept-Ranges'] === 'none', full.headers['Accept-Ranges'])

  const wrongName = await callRoute(routes.get('/dsh-chat-background/video'), { url: '/dsh-chat-background/video/other.mp4' })
  check('unknown name 404', wrongName.status === 404, wrongName.status)
}

section('POST config (chosen video + Range)')
{
  const save = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: videoPath, opacity: 0.6, blur: 4, themeAuto: false, themeColor: '#123456', regions: [{ id: 'x' }] }),
  })
  check('save 200', save.status === 200, save.status)
  const saved = JSON.parse(save.body)
  check('saved video is a video', saved.video.kind === 'video', JSON.stringify(saved.video))
  check('saved opacity', saved.settings.opacity === 0.6)
  check('saved blur', saved.settings.blur === 4)
  check('saved themeAuto', saved.settings.themeAuto === false)
  check('saved regions', saved.settings.regions.length === 1 && saved.settings.regions[0].id === 'x', JSON.stringify(saved.settings.regions))

  const after = JSON.parse((await callRoute(routes.get('/dsh-chat-background/config.json'))).body)
  check('config reflects chosen video', after.video.name === 'bg.mp4', after.video.name)

  const ranged = await callRoute(routes.get('/dsh-chat-background/video'), {
    url: `/dsh-chat-background/video/${encodeURIComponent('bg.mp4')}`,
    headers: { range: 'bytes=0-99' },
  })
  check('mp4 range 206', ranged.status === 206, ranged.status)
  check('mp4 range length 100', ranged.headers['Content-Length'] === '100', ranged.headers['Content-Length'])
  check('mp4 range Content-Range', ranged.headers['Content-Range'] === `bytes 0-99/${after.video.bytes}`, ranged.headers['Content-Range'])

  const saveBad = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: 42 }),
  })
  check('non-string src rejected 400', saveBad.status === 400, saveBad.status)

  const saveRegionsBad = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regions: 'nope' }),
  })
  check('non-array regions rejected 400', saveRegionsBad.status === 400, saveRegionsBad.status)

  const saveUnknown = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 'a-b-c': 'nope' }),
  })
  check('unknown keys rejected 400', saveUnknown.status === 400, saveUnknown.status)

  const saveCleared = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '' }),
  })
  check('clearing succeeds', saveCleared.status === 200, saveCleared.status)
  const clearedBody = JSON.parse(saveCleared.body)
  check('cleared video is none', clearedBody.video.kind === 'none', JSON.stringify(clearedBody.video))
}

section('POST config (v2: scope / audio / ui)')
{
  const save = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      src: videoPath,
      scope: 'chat',
      audioSource: 'custom',
      audio: audioPath,
      audioVolume: 0.8,
      audioLoop: false,
      uiText: '#eeeeee',
      uiUserText: '#ffdd44',
      uiAssistantText: 'auto',
      uiAccent: 'auto',
      uiSurface: 'auto',
      uiBubble: '#2b3a66',
      uiCodeBlock: '#0d1117',
      uiCodeText: 'auto',
      uiButton: '#ffd54a',
      uiButtonText: 'auto',
      uiInlineCode: 'auto',
      uiInlineCodeText: '#334455',
      uiSurfaceAlpha: 0.4,
    }),
  })
  check('v2 save 200', save.status === 200, save.status)
  const saved = JSON.parse(save.body)
  check('scope saved as chat', saved.settings.scope === 'chat', saved.settings.scope)
  check('audio resolves as sound', saved.audio.kind === 'sound', JSON.stringify(saved.audio))
  check('audio url under audio route', saved.audio.url.startsWith('/dsh-chat-background/audio/'), saved.audio.url)
  check('uiText override kept', saved.settings.uiText === '#eeeeee', saved.settings.uiText)
  check('uiAccent stays auto', saved.settings.uiAccent === 'auto', saved.settings.uiAccent)
  check('uiCodeBlock override kept', saved.settings.uiCodeBlock === '#0d1117', saved.settings.uiCodeBlock)
  check('uiCodeText stays auto', saved.settings.uiCodeText === 'auto', saved.settings.uiCodeText)
  check('uiButton override kept', saved.settings.uiButton === '#ffd54a', saved.settings.uiButton)
  check('uiInlineCodeText override kept', saved.settings.uiInlineCodeText === '#334455', saved.settings.uiInlineCodeText)
  check('audioLoop saved false', saved.settings.audioLoop === false)

  const config = JSON.parse((await callRoute(routes.get('/dsh-chat-background/config.json'))).body)
  check('config exposes soundSource', config.soundSource === 'custom', config.soundSource)
  check('config effectiveAudioSrc', typeof config.effectiveAudioSrc === 'string' && config.effectiveAudioSrc.includes('theme.mp3'), config.effectiveAudioSrc)

  const audioFull = await callRoute(routes.get('/dsh-chat-background/audio'), {
    url: `/dsh-chat-background/audio/${encodeURIComponent('theme.mp3')}`,
  })
  check('audio full request 200', audioFull.status === 200, audioFull.status)
  check('audio mime is mpeg', audioFull.headers['Content-Type'] === 'audio/mpeg', audioFull.headers['Content-Type'])
  check('audio is range-seekable', audioFull.headers['Accept-Ranges'] === 'bytes', audioFull.headers['Accept-Ranges'])

  const audioRanged = await callRoute(routes.get('/dsh-chat-background/audio'), {
    url: `/dsh-chat-background/audio/${encodeURIComponent('theme.mp3')}`,
    headers: { range: 'bytes=0-99' },
  })
  check('audio range 206', audioRanged.status === 206, audioRanged.status)

  const audioWrong = await callRoute(routes.get('/dsh-chat-background/audio'), { url: '/dsh-chat-background/audio/bg.mp4' })
  check('video file refused on audio route 404', audioWrong.status === 404, audioWrong.status)

  // custom source with a video-only file: soundSource falls back to the video.
  const fallback = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: videoPath }),
  })
  check('audio video path saved', fallback.status === 200, fallback.status)
  const fbBody = JSON.parse(fallback.body)
  check('unsupported audio file reports problem', fbBody.audioProblem === 'unsupported-format', fbBody.audioProblem)

  const badUi = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uiText: 'rebeccapurple' }),
  })
  check('bad colour accepted but normalized to auto', badUi.status === 200 && JSON.parse(badUi.body).settings.uiText === 'auto', `${badUi.status}`)

  const notAString = await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uiText: 42 }),
  })
  check('non-string colour rejected 400', notAString.status === 400, notAString.status)
}

section('reload after save (state file)')
{
  // Clear both slots for a clean slate, then confirm a fresh mount sees it.
  await callRoute(routes.get('/dsh-chat-background/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '', audio: '' }),
  })
  const second = makeContext()
  apply(second.ctx, {}, {})
  const res = await callRoute(second.routes.get('/dsh-chat-background/config.json'))
  const payload = JSON.parse(res.body)
  check('fresh mount sees cleared video', payload.video.kind === 'none', JSON.stringify(payload.video))
  check('fresh mount sees cleared audio', payload.audio.kind === 'none', JSON.stringify(payload.audio))
  check('fresh mount soundSource none', payload.soundSource === 'none', payload.soundSource)
}

/* ------------------------------------------------------------------ */
rmSync(home, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-contract: ok')
