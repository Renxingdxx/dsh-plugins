/**
 * Structural test for the dsh-chat-background browser half.
 *
 * The client bundle is a `window.__ModuleLoader__.load` registration, so it is
 * executed here in a `vm` sandbox with stub `react` / `react-dom` / `XMLHttpRequest`
 * and a recording Cordis context. It verifies the boot decisions, and exercises
 * the pure helpers the blending depends on (region gradients, colour maths,
 * dominant-colour sampling).
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

/** Run the bundle against a canned config payload. */
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
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement: { setAttribute() {}, removeAttribute() {}, style: {} },
      head: { appendChild() {} },
      body: {},
      querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, getContext: () => null }),
    },
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
  return { registered, hook: context.__DSH_CHAT_BG__ }
}

function bundledPayload(overrides = {}) {
  return {
    version: 1,
    settings: { opacity: 0.5, muted: true, fit: 'cover', themeAuto: true, themeColor: '#6f86ff', regions: [] },
    video: { kind: 'image', url: '/dsh-chat-background/video/default.gif', name: 'default.gif', bytes: 1 },
    videoSource: 'bundled',
    videoProblem: null,
    ...overrides,
  }
}

console.log('== client module shape ==')
{
  let captured = null
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (module) => { captured = module } } },
    console,
  })
  vm.runInContext(SOURCE, context)
  check('registers with the package name', captured.id === 'dsh-chat-background', captured.id)
  check('factory is a function', typeof captured.factory === 'function')
}

console.log('\n== pure helpers ==')
{
  const { hook } = mount(bundledPayload())
  check('exposes a test hook', hook !== undefined && typeof hook.regionBackground === 'function', typeof hook)

  // Colour helpers
  check('parseColor #rrggbb', JSON.stringify(hook.parseColor('#6f86ff')) === JSON.stringify([111, 134, 255]))
  check('parseColor #rgb', JSON.stringify(hook.parseColor('#fff')) === JSON.stringify([255, 255, 255]))
  check('parseColor rejects garbage', hook.parseColor('nope') === null)
  check('formatColor round-trips', hook.formatColor([1, 2, 3]) === '#010203')
  const lerped = hook.lerpColor([0, 0, 0], [10, 20, 30], 0.5)
  check('lerpColor midpoint', JSON.stringify(lerped) === JSON.stringify([5, 10, 15]), JSON.stringify(lerped))

  // objectFit
  check('objectFit cover', hook.objectFit('cover') === 'cover')
  check('objectFit fill', hook.objectFit('fill') === 'fill')
  check('objectFit contain fallback', hook.objectFit('weird') === 'contain')

  // region gradients
  const radial = hook.regionBackground({ shape: 'radial', anchor: { x: 0.5, y: 0.5 }, size: 1, color: '#000000', gradient: true, invert: false })
  check('radial gradient shape', radial.startsWith('radial-gradient(circle at 50% 50%, #000000 0%, transparent 100%)'), radial)

  const radialInv = hook.regionBackground({ shape: 'radial', anchor: { x: 0.5, y: 0.5 }, size: 1, color: '#000000', gradient: true, invert: true })
  check('radial inverted keeps centre clear', radialInv.includes('transparent 0%') && radialInv.includes('transparent 50%'), radialInv)

  const top = hook.regionBackground({ shape: 'linear', anchor: { x: 0.5, y: 0 }, size: 0.5, color: '#123456', gradient: true, invert: false })
  check('linear from top', top.startsWith('linear-gradient(to bottom, #123456 0%, transparent 50%)'), top)

  const bottom = hook.regionBackground({ shape: 'linear', anchor: { x: 0.5, y: 1 }, size: 0.5, color: '#123456', gradient: true, invert: false })
  check('linear from bottom', bottom.startsWith('linear-gradient(to top,'), bottom)

  const hard = hook.regionBackground({ shape: 'linear', anchor: { x: 0, y: 0.5 }, size: 0.5, color: '#123456', gradient: false, invert: false })
  check('hard edge uses solid stop', hard.includes('#123456 0%, #123456 49%, transparent 50%'), hard)
}

console.log('\n== autoPalette (UI colour adaptation) ==')
{
  const { hook } = mount(bundledPayload())
  const dark = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.55 })
  check('dark scene → light text', hook.parseColor(dark.text)[0] > 180, JSON.stringify(dark))
  check('dark scene flags dark', dark.dark === true)
  check('text contrasts with scene', hook.contrastRatio(hook.parseColor(dark.text), [16, 18, 30]) >= 7, String(hook.contrastRatio(hook.parseColor(dark.text), [16, 18, 30])))
  check('secondary passes AA', hook.contrastRatio(hook.parseColor(dark.secondary), [16, 18, 30]) >= 4.5, String(hook.contrastRatio(hook.parseColor(dark.secondary), [16, 18, 30])))
  check('accent contrasts', hook.contrastRatio(hook.parseColor(dark.accent), [16, 18, 30]) >= 4.5, String(hook.contrastRatio(hook.parseColor(dark.accent), [16, 18, 30])))

  const light = hook.autoPalette({ scene: [235, 238, 245], themeColor: '#2050c0', overrides: {}, surfaceAlpha: 0.55 })
  check('light scene → dark text', hook.parseColor(light.text)[0] < 80, JSON.stringify(light))
  check('light scene not dark', light.dark === false)
  check('light text contrasts', hook.contrastRatio(hook.parseColor(light.text), [235, 238, 245]) >= 7)

  const override = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiText: '#ffcc00' }, surfaceAlpha: 0.55 })
  check('manual text override wins', override.text === '#ffcc00', override.text)

  const auto = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiText: 'auto' }, surfaceAlpha: 0.55 })
  check('auto override derives', auto.text !== '#ffcc00' && /^#[0-9a-f]{6}$/.test(auto.text), auto.text)

  // ---- role split (user text vs assistant text, v0.3) ---------------------
  const split = hook.autoPalette({
    scene: [16, 18, 30],
    themeColor: '#6f86ff',
    overrides: { uiUserText: '#ffd54a', uiAssistantText: '#9fe8b8' },
    surfaceAlpha: 0.55,
  })
  check('user role differs from assistant role', split.userText !== split.assistantText, `${split.userText} / ${split.assistantText}`)
  check('user text readable on the bubble', hook.contrastRatio(hook.parseColor(split.userText), hook.parseColor(split.bubble)) >= 4.5,
    `${split.userText} on ${split.bubble} = ${hook.contrastRatio(hook.parseColor(split.userText), hook.parseColor(split.bubble)).toFixed(2)}`)
  check('assistant text readable on the scene', hook.contrastRatio(hook.parseColor(split.assistantText), [16, 18, 30]) >= 4.5,
    `${split.assistantText} on scene = ${hook.contrastRatio(hook.parseColor(split.assistantText), [16, 18, 30]).toFixed(2)}`)

  // A dark manual user colour on a dark scene must be nudged to stay readable.
  const clamped = hook.autoPalette({ scene: [14, 14, 18], themeColor: '#6f86ff', overrides: { uiUserText: '#0a0a0a' }, surfaceAlpha: 0.55 })
  check('unreadable user colour is corrected', hook.contrastRatio(hook.parseColor(clamped.userText), hook.parseColor(clamped.bubble)) >= 4.5,
    `${clamped.userText} vs ${clamped.bubble} = ${hook.contrastRatio(hook.parseColor(clamped.userText), hook.parseColor(clamped.bubble)).toFixed(2)}`)

  // `uiText` alone seeds BOTH roles; a role-specific value wins over it.
  const shared = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiText: '#ffffff' }, surfaceAlpha: 0.55 })
  check('shared uiText seeds both roles', shared.userText === shared.assistantText, `${shared.userText} / ${shared.assistantText}`)
  const mixed = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiText: '#ffffff', uiUserText: '#ffd54a' }, surfaceAlpha: 0.55 })
  check('role-specific wins over shared uiText', mixed.userText !== mixed.assistantText, `${mixed.userText} / ${mixed.assistantText}`)

  // The bubble defaults to a theme tint and accepts a manual colour.
  check('bubble derived is hex', /^#[0-9a-f]{6}$/.test(split.bubble), split.bubble)
  const manualBubble = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiBubble: '#442288' }, surfaceAlpha: 0.55 })
  check('manual bubble honoured', manualBubble.bubble === '#442288', manualBubble.bubble)

  // ---- code blocks (v0.4) --------------------------------------------------
  const codeAuto = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.55 })
  check('code block derived is hex', /^#[0-9a-f]{6}$/.test(codeAuto.codeBlock), codeAuto.codeBlock)
  check('code text derived is hex', /^#[0-9a-f]{6}$/.test(codeAuto.codeText), codeAuto.codeText)
  check('auto code text readable on its block', hook.contrastRatio(hook.parseColor(codeAuto.codeText), hook.parseColor(codeAuto.codeBlock)) >= 4.5,
    `${codeAuto.codeText} on ${codeAuto.codeBlock} = ${hook.contrastRatio(hook.parseColor(codeAuto.codeText), hook.parseColor(codeAuto.codeBlock)).toFixed(2)}`)
  const codeLight = hook.autoPalette({ scene: [235, 238, 245], themeColor: '#2050c0', overrides: {}, surfaceAlpha: 0.55 })
  check('light scene code text readable', hook.contrastRatio(hook.parseColor(codeLight.codeText), hook.parseColor(codeLight.codeBlock)) >= 4.5,
    `${codeLight.codeText} on ${codeLight.codeBlock}`)

  const codeManual = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiCodeBlock: '#0d1117', uiCodeText: '#ff7700' }, surfaceAlpha: 0.55 })
  check('manual code block honoured', codeManual.codeBlock === '#0d1117', codeManual.codeBlock)
  check('readable manual code text kept', codeManual.codeText === '#ff7700',
    `${codeManual.codeText} contrast ${hook.contrastRatio(hook.parseColor(codeManual.codeText), hook.parseColor('#0d1117')).toFixed(2)}`)

  // A light code text on a light block must be nudged darker, not obeyed blindly.
  const clash = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiCodeBlock: '#f2f2f2', uiCodeText: '#ffe9a8' }, surfaceAlpha: 0.55 })
  check('clashing code text auto-corrected', hook.contrastRatio(hook.parseColor(clash.codeText), hook.parseColor(clash.codeBlock)) >= 4.5,
    `${clash.codeText} on ${clash.codeBlock} = ${hook.contrastRatio(hook.parseColor(clash.codeText), hook.parseColor(clash.codeBlock)).toFixed(2)}`)

  // uiText seeds the code ink when only it is set and stays readable there.
  const seeded = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiText: '#ffdd44' }, surfaceAlpha: 0.55 })
  check('uiText seeds code text', hook.contrastRatio(hook.parseColor(seeded.codeText), hook.parseColor(seeded.codeBlock)) >= 4.5 && seeded.codeText !== codeAuto.codeText,
    `${seeded.codeText} contrast ${hook.contrastRatio(hook.parseColor(seeded.codeText), hook.parseColor(seeded.codeBlock)).toFixed(2)}`)

  // All three roles fall back to the derived base when everything is auto.
  const plain = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.55 })
  check('auto roles share the derived text', plain.userText === plain.text && plain.assistantText === plain.text, JSON.stringify(plain))

  // ---- primary button and inline code (v0.5) ------------------------------
  // The stock pair is a light fill with a WHITE label — the reported bug was a
  // white pill with white text. Auto must never reproduce that.
  const lightScene = hook.autoPalette({ scene: [235, 238, 245], themeColor: '#2050c0', overrides: {}, surfaceAlpha: 0.55 })
  check('light scene: button text readable on button', hook.contrastRatio(hook.parseColor(lightScene.buttonText), hook.parseColor(lightScene.button)) >= 4.5,
    `${lightScene.buttonText} on ${lightScene.button} = ${hook.contrastRatio(hook.parseColor(lightScene.buttonText), hook.parseColor(lightScene.button)).toFixed(2)}`)
  const darkScene = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.55 })
  check('dark scene: button text readable on button', hook.contrastRatio(hook.parseColor(darkScene.buttonText), hook.parseColor(darkScene.button)) >= 4.5,
    `${darkScene.buttonText} on ${darkScene.button}`)
  // The auto button is a SOLID surface colour chosen so BOTH ink paths read on
  // it: the explicit `buttonText` AND the scope's assistant text (which is what
  // the elevated/floating buttons' own `color:` declaration resolves to).
  check('auto button readable with the assistant ink', hook.contrastRatio(hook.parseColor(darkScene.assistantText), hook.parseColor(darkScene.button)) >= 4.5,
    `${darkScene.assistantText} on ${darkScene.button} = ${hook.contrastRatio(hook.parseColor(darkScene.assistantText), hook.parseColor(darkScene.button)).toFixed(2)}`)
  check('light scene auto button readable with assistant ink', hook.contrastRatio(hook.parseColor(lightScene.assistantText), hook.parseColor(lightScene.button)) >= 4.5,
    `${lightScene.assistantText} on ${lightScene.button}`)
  // A solid (opaque) fill, not a translucent one: the widgets paint it as a
  // background over the video, and translucency would let the scene bleed in.
  check('auto button fill is a plain hex', /^#[0-9a-f]{6}$/.test(darkScene.button), darkScene.button)

  // A bright manual button fill must get dark ink automatically.
  const brightButton = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiButton: '#ffe9a8' }, surfaceAlpha: 0.55 })
  check('bright manual button gets dark ink', hook.luminance(hook.parseColor(brightButton.buttonText)) < 0.5, brightButton.buttonText)
  check('bright manual button readable', hook.contrastRatio(hook.parseColor(brightButton.buttonText), hook.parseColor('#ffe9a8')) >= 4.5)
  // A manual button text that clashes is corrected, not obeyed blindly.
  const clashButton = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiButton: '#ffffff', uiButtonText: '#f2f2f2' }, surfaceAlpha: 0.55 })
  check('clashing button text auto-corrected', hook.contrastRatio(hook.parseColor(clashButton.buttonText), hook.parseColor('#ffffff')) >= 4.5,
    `${clashButton.buttonText} on white = ${hook.contrastRatio(hook.parseColor(clashButton.buttonText), hook.parseColor('#ffffff')).toFixed(2)}`)

  // Inline code chips: readable ink on their own chip colour.
  check('inline chip derived is hex', /^#[0-9a-f]{6}$/.test(lightScene.inlineCode), lightScene.inlineCode)
  check('light scene inline text readable on chip', hook.contrastRatio(hook.parseColor(lightScene.inlineCodeText), hook.parseColor(lightScene.inlineCode)) >= 4.5,
    `${lightScene.inlineCodeText} on ${lightScene.inlineCode}`)
  check('dark scene inline text readable on chip', hook.contrastRatio(hook.parseColor(darkScene.inlineCodeText), hook.parseColor(darkScene.inlineCode)) >= 4.5,
    `${darkScene.inlineCodeText} on ${darkScene.inlineCode}`)
  const inlineManual = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: { uiInlineCode: '#e8e8e8', uiInlineCodeText: '#f5f5c8' }, surfaceAlpha: 0.55 })
  check('clashing inline text auto-corrected', hook.contrastRatio(hook.parseColor(inlineManual.inlineCodeText), hook.parseColor('#e8e8e8')) >= 4.5,
    `${inlineManual.inlineCodeText} on #e8e8e8`)
}

console.log('\n== uiTokensCss ==')
{
  const { hook } = mount(bundledPayload())
  const palette = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.5 })
  const css = hook.uiTokensCss('[data-x]', palette, 0.5)
  check('selector and block present', css.startsWith('[data-x]{') && css.endsWith('}'), css.slice(0, 60))
  check('remaps label-primary', css.includes(`--dsw-alias-label-primary: ${palette.text}`))
  check('remaps brand-primary', css.includes(`--dsw-alias-brand-primary: ${palette.accent}`))
  check('base becomes transparent', css.includes('--dsw-alias-bg-base: transparent'))
  check('surface uses color-mix with alpha', css.includes('color-mix(in srgb') && css.includes('50%'))
}

console.log('\n== audioPlan ==')
{
  const { hook } = mount(bundledPayload())
  const none = hook.audioPlan({ audioSource: 'none', audioVolume: 0.5 }, { videoKind: 'video', audioOk: true })
  check('none → silent video', none.carrier === 'none' && none.videoMuted === true && none.allowGesture === false, JSON.stringify(none))

  const video = hook.audioPlan({ audioSource: 'video', audioVolume: 0.6 }, { videoKind: 'video', audioOk: false })
  check('video source → video carrier unmuted', video.carrier === 'video' && video.videoMuted === false && video.allowGesture === true, JSON.stringify(video))

  const videoOnGif = hook.audioPlan({ audioSource: 'video', audioVolume: 0.6 }, { videoKind: 'image', audioOk: false })
  check('video source on a gif → no sound', videoOnGif.carrier === 'none' && videoOnGif.videoMuted === true, JSON.stringify(videoOnGif))

  const custom = hook.audioPlan({ audioSource: 'custom', audioVolume: 0.6 }, { videoKind: 'video', audioOk: true })
  check('custom resolved → audio carrier, video muted', custom.carrier === 'audio' && custom.videoMuted === true && custom.allowGesture === true, JSON.stringify(custom))

  const customZero = hook.audioPlan({ audioSource: 'custom', audioVolume: 0 }, { videoKind: 'video', audioOk: true })
  check('custom at volume 0 → no gesture wait', customZero.carrier === 'audio' && customZero.allowGesture === false, JSON.stringify(customZero))

  const customBroken = hook.audioPlan({ audioSource: 'custom', audioVolume: 0.6 }, { videoKind: 'video', audioOk: false })
  check('custom missing → video fallback', customBroken.carrier === 'video' && customBroken.videoMuted === false, JSON.stringify(customBroken))

  const customNoVideo = hook.audioPlan({ audioSource: 'custom', audioVolume: 0.6 }, { videoKind: 'image', audioOk: false })
  check('custom missing over a gif → silent', customNoVideo.carrier === 'none', JSON.stringify(customNoVideo))
}

console.log('\n== boot with the bundled default ==')
{
  const { registered } = mount(bundledPayload())
  const tab = registered.find((row) => row.slot === 'settings.plugins.tab')
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('settings tab registered', tab !== undefined && tab.id === 'dsh-chat-background', JSON.stringify(registered.map((r) => r.slot)))
  check('background registered when a video is present', overlay !== undefined && overlay.id === 'dsh-chat-background')
  check('background sits above the shell', overlay !== undefined && overlay.order === 900, overlay && overlay.order)
}

console.log('\n== boot with everything cleared ==')
{
  const { registered } = mount(bundledPayload({
    video: { kind: 'none' },
    videoSource: 'cleared',
  }))
  const tab = registered.find((row) => row.slot === 'settings.plugins.tab')
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('settings tab still registered', tab !== undefined)
  check('background NOT registered when nothing to show', overlay === undefined, JSON.stringify(registered.map((r) => r.slot)))
}

console.log('\n== boot with an unplayable video ==')
{
  const { registered } = mount(bundledPayload({ videoProblem: 'missing-file' }))
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('background NOT registered when the video is broken', overlay === undefined)
}

console.log('\n== boot with an empty region list ==')
{
  const { registered } = mount(bundledPayload({ settings: { regions: [] } }))
  const overlay = registered.find((row) => row.slot === 'shell.overlay')
  check('background still registers with no regions', overlay !== undefined)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-client: ok')
