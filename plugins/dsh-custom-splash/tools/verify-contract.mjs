/**
 * Contract test for the dsh-custom-splash host half.
 *
 * Runs `apply` against a mock Cordis context, then drives the registered HTTP
 * routes directly — no network, no Electron. Catches the classes of bug that
 * matter here: a wrong route prefix, a descriptor that disagrees with the
 * resolver, a Range response that a `<video>`/`<audio>` cannot use, and the
 * three-state `src`/`audio` rules.
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

const { apply, normalizeConfig, resolvePicture, resolveSound, resolveMedia, DEFAULTS } = await import(INDEX)

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
  check('undefined → defaults', d.muted === false && d.volume === 0.7 && d.skip === 'button', JSON.stringify(d))
  const n = normalizeConfig({ muted: 'yes', volume: 9, skip: 'nope', fit: 'x', playbackRate: 0 })
  check('bad values fall back or clamp', n.muted === false && n.volume === 1 && n.skip === 'button' && n.fit === 'cover' && n.playbackRate === 0.1, JSON.stringify(n))
  const c = normalizeConfig({ muted: true, volume: 0.25, unlockOnGesture: false, src: 'a', audio: 'b' })
  check('good values pass through', c.muted === true && c.volume === 0.25 && c.unlockOnGesture === false && c.src === 'a' && c.audio === 'b', JSON.stringify(c))
}

/* ------------------------------------------------------------------ */
/* Media resolution                                                   */
/* ------------------------------------------------------------------ */
const home = mkdtempSync(join(tmpdir(), 'dsh-custom-splash-verify-'))
const picturePath = join(home, 'clip.mp4')
const soundPath = join(home, 'tune.wav')
const missingPath = join(home, 'nope.mp4')
writeFileSync(picturePath, Buffer.alloc(2048, 1))
writeFileSync(soundPath, Buffer.alloc(1024, 2))

section('resolvePicture / resolveSound')
{
  const bundled = resolvePicture(undefined, home)
  check('unset → bundled picture', bundled.configured === true && bundled.source === 'bundled' && bundled.descriptor.kind === 'image', JSON.stringify(bundled))
  const cleared = resolvePicture('', home)
  check('empty → cleared, not configured', cleared.configured === false && cleared.source === 'cleared', JSON.stringify(cleared))
  const chosen = resolvePicture(picturePath, home)
  check('path → chosen video', chosen.configured === true && chosen.source === 'chosen' && chosen.descriptor.kind === 'video', JSON.stringify(chosen))
  const missing = resolvePicture(missingPath, home)
  check('missing file reports missing-file', missing.configured === true && missing.descriptor.problem === 'missing-file', JSON.stringify(missing))

  const soundBundled = resolveSound(undefined, bundled.descriptor, bundled.source, home)
  check('bundled picture → bundled sound', soundBundled.configured === true && soundBundled.source === 'bundled' && soundBundled.descriptor.kind === 'sound', JSON.stringify(soundBundled))
  const soundVideo = resolveSound(undefined, chosen.descriptor, chosen.source, home)
  check('chosen video → picture-audio', soundVideo.configured === true && soundVideo.source === 'picture-audio' && soundVideo.descriptor === null, JSON.stringify(soundVideo))
  const soundNone = resolveSound('', chosen.descriptor, chosen.source, home)
  check('empty audio → cleared, no sound', soundNone.configured === false && soundNone.source === 'cleared', JSON.stringify(soundNone))
  const soundFile = resolveSound(soundPath, chosen.descriptor, chosen.source, home)
  check('audio path → chosen sound', soundFile.configured === true && soundFile.source === 'chosen' && soundFile.descriptor.kind === 'sound', JSON.stringify(soundFile))
  const soundImage = resolveSound(undefined, { kind: 'image' }, 'chosen', home)
  check('chosen image → auto-picture-audio (silent)', soundImage.configured === false && soundImage.source === 'auto-picture-audio', JSON.stringify(soundImage))
}

section('resolveMedia')
{
  const wav = resolveMedia(soundPath, home, { wav: 'audio/wav' }, null)
  check('wav resolves as sound kind', wav.configured === true && wav.kind === 'sound' && wav.mime === 'audio/wav', JSON.stringify(wav))
  const mp4 = resolveMedia(picturePath, home, { mp4: 'video/mp4' }, new Set(['gif']))
  check('mp4 resolves as video kind', mp4.configured === true && mp4.kind === 'video', JSON.stringify(mp4))
}

/* ------------------------------------------------------------------ */
/* HTTP routes via a mock Cordis context                             */
/* ------------------------------------------------------------------ */
function makeContext() {
  const routes = new Map()
  const injections = []
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
    on(event, fn) {
      if (event === 'webserver/index-inject') injections.push(fn)
    },
    logger: { warn: () => {} },
  }
  return { ctx, routes, injections }
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

    // A real `res` is a Writable: `serveMedia` pipes the file into it. Build one
    // that also carries the status/headers the handlers set.
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
    // A body-reading handler attaches its listeners synchronously, before its
    // first `await`; emit on the next microtask so they are already attached.
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
const { ctx, routes, injections } = makeContext()
apply(ctx, { muted: false, volume: 0.7, unlockOnGesture: true }, {})

section('route table')
{
  const expected = ['/dsh-custom-splash/config.json', '/dsh-custom-splash/config', '/dsh-custom-splash/pick', '/dsh-custom-splash/picture', '/dsh-custom-splash/sound']
  for (const path of expected) {
    check(`route registered: ${path}`, routes.has(path), [...routes.keys()].join(', '))
  }
  check('picture route is a prefix', routes.get('/dsh-custom-splash/picture')?.kind === 'prefix')
  check('sound route is a prefix', routes.get('/dsh-custom-splash/sound')?.kind === 'prefix')
}

section('index injection')
{
  const table = []
  for (const fn of injections) fn(table)
  const styles = table.filter((row) => row.kind === 'style')
  const scripts = table.filter((row) => row.kind === 'script')
  check('injects a boot cover style', styles.some((row) => row.text.includes('dsh-custom-splash-cover')), JSON.stringify(styles.map((s) => s.text)))
  check('injects a guard script', scripts.some((row) => row.text.includes('__DSH_CUSTOM_SPLASH_COVER_GUARD__')))
}

section('GET config.json (bundled default)')
{
  const res = await callRoute(routes.get('/dsh-custom-splash/config.json'))
  const payload = JSON.parse(res.body)
  check('status 200', res.status === 200, res.status)
  check('picture is bundled image', payload.picture.kind === 'image' && payload.pictureSource === 'bundled', JSON.stringify(payload.picture))
  check('picture url is under the picture route', payload.picture.url.startsWith('/dsh-custom-splash/picture/'), payload.picture.url)
  check('sound is bundled audio', payload.sound.kind === 'sound' && payload.soundSource === 'bundled', JSON.stringify(payload.sound))
  check('sound url is under the sound route', payload.sound.url.startsWith('/dsh-custom-splash/sound/'), payload.sound.url)
  check('muted defaults to false', payload.settings.muted === false)
  check('volume defaults to 0.7', payload.settings.volume === 0.7)
}

section('picture/sound byte routes')
{
  const config = JSON.parse((await callRoute(routes.get('/dsh-custom-splash/config.json'))).body)
  const pictureName = config.picture.name
  const soundName = config.sound.name

  const full = await callRoute(routes.get('/dsh-custom-splash/picture'), { url: `/dsh-custom-splash/picture/${encodeURIComponent(pictureName)}` })
  check('picture full request 200', full.status === 200, full.status)
  // The bundled default is an animated GIF: it is not seekable, so Range is not
  // offered. A chosen MP4 is seekable — checked in the section below.
  check('gif picture is not range-seekable', full.headers['Accept-Ranges'] === 'none', full.headers['Accept-Ranges'])

  const soundFull = await callRoute(routes.get('/dsh-custom-splash/sound'), { url: `/dsh-custom-splash/sound/${encodeURIComponent(soundName)}` })
  check('sound full request 200', soundFull.status === 200, soundFull.status)
  check('sound accepts ranges', soundFull.headers['Accept-Ranges'] === 'bytes', soundFull.headers['Accept-Ranges'])

  const soundRanged = await callRoute(routes.get('/dsh-custom-splash/sound'), {
    url: `/dsh-custom-splash/sound/${encodeURIComponent(soundName)}`,
    headers: { range: 'bytes=10-19' },
  })
  check('sound range 206', soundRanged.status === 206, soundRanged.status)
  check('sound range length 10', soundRanged.headers['Content-Length'] === '10', soundRanged.headers['Content-Length'])

  const wrongName = await callRoute(routes.get('/dsh-custom-splash/picture'), { url: '/dsh-custom-splash/picture/other.gif' })
  check('unknown name 404', wrongName.status === 404, wrongName.status)
}

section('POST config (chosen files)')
{
  const save = await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: picturePath, audio: soundPath }),
  })
  check('save 200', save.status === 200, save.status)
  const saved = JSON.parse(save.body)
  check('saved picture is a video', saved.picture.kind === 'video', JSON.stringify(saved.picture))
  check('saved sound is a separate file', saved.sound.kind === 'sound' && saved.soundSource === 'chosen', JSON.stringify(saved.sound))

  const after = JSON.parse((await callRoute(routes.get('/dsh-custom-splash/config.json'))).body)
  check('config reflects chosen picture', after.picture.name === 'clip.mp4', after.picture.name)
  check('config reflects chosen sound', after.sound.name === 'tune.wav', after.sound.name)

  const saveAuto = await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: null }),
  })
  check('saving audio:null succeeds', saveAuto.status === 200, saveAuto.status)
  const autoBody = JSON.parse(saveAuto.body)
  check('audio null → picture own audio', autoBody.soundSource === 'picture-audio', autoBody.soundSource)

  const saveBad = await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: 42 }),
  })
  check('non-string src rejected 400', saveBad.status === 400, saveBad.status)

  const saveCleared = await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '', audio: '' }),
  })
  check('clearing both succeeds', saveCleared.status === 200, saveCleared.status)
  const clearedBody = JSON.parse(saveCleared.body)
  check('cleared picture is none', clearedBody.picture.kind === 'none', JSON.stringify(clearedBody.picture))
  check('cleared sound is none', clearedBody.sound.kind === 'none' && clearedBody.soundSource === 'cleared', clearedBody.soundSource)
}

section('Range on a chosen MP4')
{
  const save = await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: picturePath, audio: null }),
  })
  check('saving an MP4 succeeds', save.status === 200, save.status)
  const config = JSON.parse((await callRoute(routes.get('/dsh-custom-splash/config.json'))).body)
  check('mp4 picture resolves as video', config.picture.kind === 'video', JSON.stringify(config.picture))

  const ranged = await callRoute(routes.get('/dsh-custom-splash/picture'), {
    url: `/dsh-custom-splash/picture/${encodeURIComponent(config.picture.name)}`,
    headers: { range: 'bytes=0-99' },
  })
  check('mp4 range 206', ranged.status === 206, ranged.status)
  check('mp4 range length 100', ranged.headers['Content-Length'] === '100', ranged.headers['Content-Length'])
  check('mp4 range Content-Range', ranged.headers['Content-Range'] === `bytes 0-99/${config.picture.bytes}`, ranged.headers['Content-Range'])

  // Leave the state cleared so the reload section below sees a clean slate.
  await callRoute(routes.get('/dsh-custom-splash/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '', audio: '' }),
  })
}

section('reload after save (state file)')
{
  // A fresh apply must see what the previous one wrote.
  const second = makeContext()
  apply(second.ctx, {}, {})
  const res = await callRoute(second.routes.get('/dsh-custom-splash/config.json'))
  const payload = JSON.parse(res.body)
  check('fresh mount sees cleared picture', payload.picture.kind === 'none', JSON.stringify(payload.picture))
  check('fresh mount sees cleared sound', payload.sound.kind === 'none', JSON.stringify(payload.sound))
}

/* ------------------------------------------------------------------ */
rmSync(home, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-contract: ok')
