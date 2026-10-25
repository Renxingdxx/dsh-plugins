/**
 * Structural test for the dsh-custom-splash browser half.
 *
 * The client bundle is a `window.__ModuleLoader__.load` registration, so it is
 * executed here in a `vm` sandbox with stub `react` / `react-dom` / `XMLHttpRequest`
 * and a recording Cordis context. It verifies the two decisions that matter at
 * boot: the settings tab is always registered, and the overlay is registered
 * only when there is a picture or sound to show.
 *
 * Run: node tools/verify-client.mjs
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React surface: enough for `apply` to reference the components. */
const reactStub = {
  useState: () => [{}, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const reactDomStub = { createPortal: (node) => node }

/**
 * Run the bundle against a canned config payload.
 * @param payload - the JSON the Host would return for `config.json`.
 * @returns the recorded slot registrations.
 */
function mount(payload) {
  let captured = null
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(module) {
          captured = module
        },
      },
    },
    XMLHttpRequest: class {
      open(method, url, async) {
        this.method = method
        this.url = url
        this.async = async
      }
      send() {
        this.status = 200
        this.responseText = JSON.stringify(payload)
      }
    },
    console,
  })
  vm.runInContext(SOURCE, context)
  if (captured === null) throw new Error('client.js did not register a module')

  const factoryResult = captured.factory((name) => {
    if (name === 'react') return reactStub
    if (name === 'react-dom') return reactDomStub
    throw new Error(`unexpected require: ${name}`)
  })

  const registered = []
  const ctx = {
    slots: {
      inject(slot, run) {
        if (typeof run === 'function') run()
      },
      register(spec, component) {
        registered.push({ slot: spec.name, id: spec.id, order: spec.order, component })
      },
    },
  }
  factoryResult.apply(ctx)
  return { registered, factoryResult, hook: context.__DSH_CUSTOM_SPLASH__ }
}

console.log('== client module shape ==')
{
  let captured = null
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (module) => { captured = module } } },
    console,
  })
  vm.runInContext(SOURCE, context)
  check('registers with the package name', captured.id === 'dsh-custom-splash', captured.id)
  check('factory is a function', typeof captured.factory === 'function')
}

console.log('\n== soundPlan (the sound-unlock policy) ==')
{
  const bundled = {
    version: 1,
    settings: { muted: false, volume: 0.7, unlockOnGesture: true },
    picture: { kind: 'image', url: '/dsh-custom-splash/picture/default.gif', name: 'default.gif', bytes: 1 },
    sound: { kind: 'sound', url: '/dsh-custom-splash/sound/default.wav', name: 'default.wav', bytes: 1 },
    soundSource: 'bundled',
    pictureSource: 'bundled',
    pictureProblem: null,
    soundProblem: null,
  }
  const { hook } = mount(bundled)
  check('exposes a test hook', hook !== undefined && typeof hook.soundPlan === 'function', typeof hook)

  const base = { muted: false, volume: 0.7, unlockOnGesture: true }
  const video = hook.soundPlan(base, { separateSound: false, pictureKind: 'video', soundProblem: null })
  check('video own audio → unmuted + unlock', video.pictureMuted === false && video.startSoundUnmuted === true && video.unlockOnGesture === true, JSON.stringify(video))

  const separate = hook.soundPlan(base, { separateSound: true, pictureKind: 'video', soundProblem: null })
  check('separate sound → picture muted, sound unmuted', separate.pictureMuted === true && separate.startSoundUnmuted === true && separate.unlockOnGesture === true, JSON.stringify(separate))

  const muted = hook.soundPlan({ ...base, muted: true }, { separateSound: true, pictureKind: 'video', soundProblem: null })
  check('master mute → no sound at all', muted.pictureMuted === true && muted.startSoundUnmuted === false && muted.unlockOnGesture === false, JSON.stringify(muted))

  const image = hook.soundPlan(base, { separateSound: false, pictureKind: 'image', soundProblem: null })
  check('image without separate sound → silent', image.startSoundUnmuted === false && image.unlockOnGesture === false, JSON.stringify(image))

  const imageSound = hook.soundPlan(base, { separateSound: true, pictureKind: 'image', soundProblem: null })
  check('image with separate sound → sound only', imageSound.pictureMuted === true && imageSound.startSoundUnmuted === true, JSON.stringify(imageSound))

  const broken = hook.soundPlan(base, { separateSound: true, pictureKind: 'image', soundProblem: 'missing-file' })
  check('broken sound file → silent', broken.startSoundUnmuted === false && broken.unlockOnGesture === false, JSON.stringify(broken))

  const noUnlock = hook.soundPlan({ ...base, unlockOnGesture: false }, { separateSound: false, pictureKind: 'video', soundProblem: null })
  check('unlock disabled → still attempts, no gesture', noUnlock.startSoundUnmuted === true && noUnlock.unlockOnGesture === false, JSON.stringify(noUnlock))
}

console.log('\n== boot with the bundled default ==')
{
  const payload = {
    version: 1,
    settings: { muted: false, volume: 0.7, unlockOnGesture: true, skip: 'button' },
    picture: { kind: 'image', url: '/dsh-custom-splash/picture/default.gif', name: 'default.gif', bytes: 1 },
    sound: { kind: 'sound', url: '/dsh-custom-splash/sound/default.wav', name: 'default.wav', bytes: 1 },
    soundSource: 'bundled',
    pictureSource: 'bundled',
    pictureProblem: null,
    soundProblem: null,
  }
  const { registered } = mount(payload)
  const tab = registered.find((row) => row.slot === 'settings.plugins.tab')
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('settings tab registered', tab !== undefined && tab.id === 'dsh-custom-splash', JSON.stringify(registered.map((r) => r.slot)))
  check('overlay registered when media present', overlay !== undefined && overlay.id === 'dsh-custom-splash')
  check('overlay sits above the shell', overlay !== undefined && overlay.order === 900, overlay && overlay.order)
}

console.log('\n== boot with everything cleared ==')
{
  const payload = {
    version: 1,
    settings: { muted: false, volume: 0.7 },
    picture: { kind: 'none' },
    sound: { kind: 'none' },
    soundSource: 'cleared',
    pictureSource: 'cleared',
    pictureProblem: null,
    soundProblem: null,
  }
  const { registered } = mount(payload)
  const tab = registered.find((row) => row.slot === 'settings.plugins.tab')
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('settings tab still registered', tab !== undefined)
  check('overlay NOT registered when nothing to show', overlay === undefined, JSON.stringify(registered.map((r) => r.slot)))
}

console.log('\n== boot with a video whose own audio is the sound ==')
{
  const payload = {
    version: 1,
    settings: { muted: false, volume: 0.7 },
    picture: { kind: 'video', url: '/dsh-custom-splash/picture/clip.mp4', name: 'clip.mp4', bytes: 1 },
    sound: { kind: 'none' },
    soundSource: 'picture-audio',
    pictureSource: 'chosen',
    pictureProblem: null,
    soundProblem: null,
  }
  const { registered } = mount(payload)
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('overlay registered for a video with its own audio', overlay !== undefined)
}

console.log('\n== boot with an unplayable picture ==')
{
  const payload = {
    version: 1,
    settings: { muted: false, volume: 0.7 },
    picture: { kind: 'none', name: 'bad.mp4', extension: 'mp4' },
    sound: { kind: 'none' },
    soundSource: 'cleared',
    pictureSource: 'chosen',
    pictureProblem: 'missing-file',
    soundProblem: null,
  }
  const { registered } = mount(payload)
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('overlay NOT registered when the picture is broken', overlay === undefined)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-client: ok')
