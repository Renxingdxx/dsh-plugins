/**
 * End-to-end audit of the automatic colour pipeline.
 *
 * Walks the exact chain the browser runs:
 *   dominant colour (per-frame, sampled with the same filter as
 *   sampleDominantColor) → theme easing → scene derivation (dim + tint) →
 *   autoPalette → every contrast guarantee the palette promises.
 *
 * Two layers:
 *   1. REAL FRAMES — the bundled default.gif, every frame, at the user's
 *      current live settings AND at fully automatic settings.
 *   2. COLOUR SWEEP — a grid of hues/luminances through every dim/strength/
 *      alpha combination, asserting no scene can produce an unreadable pair.
 *
 * Run: node tools/verify-autotheme.mjs [path-to-gif-dominants.json]
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

function mount() {
  let captured = null
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) { captured = module } } },
    XMLHttpRequest: class {
      open() {}
      send() {
        this.status = 200
        this.responseText = JSON.stringify({ settings: {}, video: { kind: 'none' } })
      }
    },
    console,
    MutationObserver: class { observe() {} disconnect() {} },
    document: {
      documentElement: { setAttribute() {}, removeAttribute() {}, style: {} },
      head: { appendChild() {} },
      body: {},
      querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, getContext: () => null }),
    },
  })
  vm.runInContext(SOURCE, context)
  captured.factory((name) => {
    if (name === 'react') {
      return {
        useState: () => [{}, () => {}],
        useEffect: () => {},
        useLayoutEffect: () => {},
        useRef: () => ({ current: null }),
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        createElement: () => ({}),
      }
    }
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${name}`)
  }).apply({ slots: { inject(slot, run) { if (typeof run === 'function') run() }, register() {} } })
  const hook = context.__DSH_CHAT_BG__
  if (hook === undefined) throw new Error('test hook missing')
  return hook
}

const hook = mount()
const { parseColor, formatColor, lerpColor, luminance, contrastRatio, autoPalette } = hook

/**
 * The EXACT scene derivation the background component performs (mirrors
 * client.js: scene = lerp(lerp(dominant ?? theme, black, dim), theme, strength*0.6)).
 */
function deriveScene(dominantHex, themeHex, dim, strength) {
  const sceneRgb = parseColor(dominantHex !== null ? dominantHex : themeHex)
  const themeRgb = parseColor(themeHex)
  return lerpColor(lerpColor(sceneRgb, [0, 0, 0], dim), themeRgb, strength * 0.6)
}

/**
 * The contrast contract autoPalette actually promises.
 *
 * `text ≥7` is the AUTO-mode target; a manual `uiText` is only rescued to AA
 * (4.5) because the user asked for that colour. And no target above the
 * mathematical ceiling of a mid-tone background can be met (#808080 tops out
 * at 4.98 against black), so every assertion is clamped to the best ratio
 * physically achievable on that background.
 */
function auditPalette(p, { manualText = false } = {}) {
  const P = (hex) => parseColor(hex)
  const scene = P(p.__scene)
  const problems = []
  const ceiling = (bg) => Math.max(contrastRatio([255, 255, 255], P(bg)), contrastRatio([10, 11, 16], P(bg)))
  const need = (label, fg, bg, target) => {
    const ratio = contrastRatio(P(fg), P(bg))
    const required = Math.min(target, ceiling(bg)) - 0.03
    if (ratio < required) problems.push(`${label}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${required.toFixed(2)}`)
  }
  need('text/scene', p.text, p.__scene, manualText ? 4.5 : 7)
  need('secondary/scene', p.secondary, p.__scene, 4.5)
  need('tertiary/scene', p.tertiary, p.__scene, 3)
  need('assistant/scene', p.assistantText, p.__scene, 4.5)
  need('user/bubble', p.userText, p.bubble, 4.5)
  need('codeText/codeBlock', p.codeText, p.codeBlock, 4.5)
  need('inlineText/inlineChip', p.inlineCodeText, p.inlineCode, 4.5)
  need('buttonText/button', p.buttonText, p.button, 4.5)
  need('accent/scene', p.accent, p.__scene, 4.5)
  return problems
}

function paletteFor(scene, themeHex, overrides, alpha) {
  const p = autoPalette({ scene, themeColor: themeHex, overrides, surfaceAlpha: alpha })
  return { ...p, __scene: formatColor(scene) }
}

console.log('== 1. real frames: bundled default.gif, fully automatic ==')
{
  const jsonPath = process.argv[2]
  if (jsonPath === undefined) {
    console.log('  (skipped — pass the dominants JSON as argv[2])')
  } else {
    const frames = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''))
    check('frames sampled', Array.isArray(frames) && frames.length > 40, String(frames.length))
    let theme = '#6f86ff'
    let worst = null
    let brokenFrames = 0
    for (const dominant of frames) {
      if (dominant === null) continue
      // The 2s easing tick the component runs, condensed to its steady state:
      // theme converges to the (filtered) dominant.
      theme = formatColor(lerpColor(parseColor(theme), parseColor(dominant), 0.25))
      const scene = deriveScene(dominant, theme, 0.45, 0.35)
      const problems = auditPalette(paletteFor(scene, theme, {}, 0.55))
      if (problems.length > 0) {
        brokenFrames += 1
        if (worst === null) worst = `${dominant}: ${problems[0]}`
      }
    }
    check('every gif frame yields a fully readable palette', brokenFrames === 0, worst ?? 'all frames clean')
    // The dominant must actually move the theme (not a stuck constant).
    check('theme tracks the video (eased)', theme !== '#6f86ff', theme)
    // Spread check: colours differ across the loop.
    const uniq = new Set(frames.filter(Boolean))
    check('dominant colour varies per frame', uniq.size > 10, `${uniq.size} distinct`)
  }
}

console.log('\n== 2. the user’s LIVE settings (themeAuto off, #002aff) ==')
{
  // src config: themeColor #002aff, dim 0, strength 0.3, alpha 0.2, all roles auto.
  const scene = deriveScene(null, '#002aff', 0, 0.3)
  const problems = auditPalette(paletteFor(scene, '#002aff', {}, 0.2))
  check('live config produces zero contrast violations', problems.length === 0, problems.join(' | '))
  const p = paletteFor(scene, '#002aff', {}, 0.2)
  console.log(`  scene=${p.__scene} text=${p.text} button=${p.button}/${p.buttonText} code=${p.codeBlock}/${p.codeText}`)
}

console.log('\n== 3. colour sweep: hue × luminance × settings grid ==')
{
  const hues = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  const lums = [0.05, 0.15, 0.3, 0.42, 0.5, 0.6, 0.75, 0.9]
  const dims = [0, 0.45, 1]
  const strengths = [0, 0.35, 1]
  const alphas = [0.18, 0.55, 1]
  const themeColors = ['#6f86ff', '#002aff', '#ff5030', '#00c070']
  let total = 0
  const broken = []
  const hsl = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
  }
  for (const hue of hues) {
    for (const lum of lums) {
      const dominant = hsl(hue, 0.6, Math.min(0.97, Math.max(0.03, lum)))
      for (const dim of dims) {
        for (const strength of strengths) {
          for (const alpha of alphas) {
            for (const theme of themeColors) {
              total += 1
              const scene = deriveScene(formatColor(dominant), theme, dim, strength)
              const problems = auditPalette(paletteFor(scene, theme, {}, alpha))
              if (problems.length > 0) broken.push(`${formatColor(dominant)}/dim${dim}/str${strength}/a${alpha}/${theme}: ${problems[0]}`)
            }
          }
        }
      }
    }
  }
  check(`${total} automatic scenes all readable`, broken.length === 0, broken.slice(0, 4).join(' | '))
}

console.log('\n== 4. manual overrides cannot break readability ==')
{
  const scene = parseColor('#3b4768')
  const clashes = [
    { uiText: '#ffffff' },
    { uiButton: '#ffffff', uiButtonText: '#ffffff' },
    { uiButton: '#000000', uiButtonText: '#000000' },
    { uiCodeBlock: '#ffffff', uiCodeText: '#ffffff' },
    { uiInlineCode: '#ffffff', uiInlineCodeText: '#ffffff' },
    { uiBubble: '#ffffff', uiUserText: '#ffffff' },
    { uiBubble: '#000000', uiUserText: '#000000' },
    { uiText: '#808080' },
    { uiAccent: '#808080' },
  ]
  for (const overrides of clashes) {
    const problems = auditPalette(paletteFor(scene, '#6f86ff', overrides, 0.55), { manualText: overrides.uiText !== undefined })
    check(`override ${JSON.stringify(overrides)} stays readable`, problems.length === 0, problems.join(' | '))
  }
}

console.log('\n== 5. degenerate frames ==')
{
  // Pure black / pure white video: the sampler filters them out (returns null)
  // and the palette must fall back to the theme without dividing by zero.
  const nullScene = deriveScene(null, '#6f86ff', 0.45, 0.35)
  const problems = auditPalette(paletteFor(nullScene, '#6f86ff', {}, 0.55))
  check('no dominant → theme scene still readable', problems.length === 0, problems.join(' | '))
  const mid = paletteFor([128, 128, 128], '#808080', {}, 0.55)
  check('mid-grey scene readable', auditPalette({ ...mid, __scene: '#808080' }).length === 0, auditPalette({ ...mid, __scene: '#808080' }).join(' | '))
}

console.log('\n== 6. the eased transition path is readable at EVERY frame ==')
{
  // The smoothing eases the SOURCE (dominant/theme) per animation frame and
  // recomputes the whole palette from it — the design claim is that no
  // midpoint can be unreadable. Walk the eased path between the two most
  // different frames of the real gif (and the hardest synthetic pairs) and
  // audit every stop, exactly as the browser would see them.
  const jsonPath = process.argv[2]
  const pairs = []
  if (jsonPath !== undefined) {
    const frames = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '')).filter(Boolean)
    let best = null
    for (const a of frames) {
      for (const b of frames) {
        const B = parseColor(b)
        const d = Math.max(...parseColor(a).map((v, i) => Math.abs(v - B[i])))
        if (best === null || d > best.d) best = { a, b, d }
      }
    }
    pairs.push([best.a, best.b])
  }
  pairs.push(['#080808', '#f5f5f5'], ['#ff0000', '#0000ff'], ['#087545', '#a1321f'])
  let stops = 0
  const broken = []
  for (const [a, b] of pairs) {
    // Mirror the component: exponential easing, ~700ms tau, 60fps, over a
    // target change; the path is dense in the first frames.
    let from = parseColor(a)
    let theme = parseColor(a)
    const to = parseColor(b)
    for (let i = 0; i < 120; i += 1) {
      const k = 1 - Math.exp(-16.7 / 700)
      from = lerpColor(from, to, k)
      theme = lerpColor(theme, to, k)
      const dominantHex = formatColor(from)
      const themeHex = formatColor(theme)
      const scene = deriveScene(dominantHex, themeHex, 0.45, 0.35)
      const problems = auditPalette(paletteFor(scene, themeHex, {}, 0.55))
      stops += 1
      if (problems.length > 0 && broken.length < 4) broken.push(`${dominantHex}→${themeHex}: ${problems[0]}`)
    }
  }
  check(`${stops} eased-path frames all readable`, broken.length === 0, broken.join(' | '))
  // Convergence: τ=700ms means a full black→white move settles (within the
  // 2/255 snap the pump uses) in ≈3.4s — about two sample ticks. It must NOT
  // still be crawling after four ticks, or the loop would never park.
  let v = parseColor('#000000')
  const k = 1 - Math.exp(-16.7 / 700)
  let settledAt = -1
  for (let i = 0; i < 480; i += 1) {
    v = lerpColor(v, parseColor('#ffffff'), k)
    if (settledAt < 0 && v.every((c) => 255 - c <= 2)) settledAt = i
  }
  check('easing settles within two sample ticks', settledAt > 0 && settledAt <= 240, `settled at frame ${settledAt} (~${(settledAt * 16.7 / 1000).toFixed(1)}s)`)
  // The visible midpoint of a black→white move must be a true grey ramp, not
  // stuck: sample the path at 25/50/75% and confirm monotone lightening.
  let w = parseColor('#000000')
  const marks = []
  for (let i = 0; i < 240; i += 1) {
    w = lerpColor(w, parseColor('#ffffff'), k)
    if ([60, 120, 180].includes(i)) marks.push(Math.round(w[0]))
  }
  check('midpoints form a monotone ramp', marks.length === 3 && marks[0] < marks[1] && marks[1] < marks[2], JSON.stringify(marks))
}

console.log('\n== 7. chrome palette: the opaque regions stay readable too ==')
{
  // v0.8: in chat scope the sidebar and friends are SOLID panels painted from
  // chromePalette. Every ink must clear its own solid background, because the
  // video is not behind them to average out.
  const chrome = hook.chromePalette
  check('chromePalette exported', typeof chrome === 'function')
  const auditChrome = (c) => {
    const P = (hex) => parseColor(hex)
    const problems = []
    const need = (label, fg, bg, target) => {
      const ratio = contrastRatio(P(fg), P(bg))
      if (ratio < target) problems.push(`${label}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${target}`)
    }
    need('text/base', c.text, c.base, 7)
    need('text/sidebar', c.text, c.sidebar, 7)
    need('secondary/base', c.secondary, c.base, 4.5)
    need('tertiary/base', c.tertiary, c.base, 3)
    need('accent/base', c.accent, c.base, 4.5)
    need('buttonText/button', c.buttonText, c.button, 4.5)
    need('text/button (ink path)', c.text, c.button, 4.5)
    need('codeText/codeBlock', c.codeText, c.codeBlock, 4.5)
    // Panels (inputs, cards) sit on `surface`/`layer` and paint chrome text.
    need('text/surface', c.text, c.surface, 4.5)
    need('text/layer', c.text, c.layer, 4.5)
    // The selected sidebar row: chrome ink on the derived active fill.
    need('text/navActive', c.text, c.navActive, 4.5)
    return problems
  }
  const scenes = []
  for (const hue of [0, 40, 90, 150, 200, 260, 320]) {
    for (const l of [0.04, 0.12, 0.3, 0.5, 0.7, 0.95]) {
      const s = 0.6
      const k = (n) => (n + hue / 30) % 12
      const a = s * Math.min(l, 1 - l)
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
      scenes.push(formatColor([Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]))
    }
  }
  let broken = []
  for (const scene of scenes) {
    for (const theme of ['#6f86ff', '#002aff', '#ff5030']) {
      const c = chrome({ scene: parseColor(scene), themeColor: theme })
      const problems = auditChrome(c)
      if (problems.length > 0 && broken.length < 4) broken.push(`${scene}/${theme}: ${problems[0]}`)
    }
  }
  check(`${scenes.length * 3} chrome scenes all readable`, broken.length === 0, broken.join(' | '))
  // The chrome must actually FOLLOW the scene, not be a fixed grey.
  const darkChrome = chrome({ scene: parseColor('#0a0f1e'), themeColor: '#6f86ff' })
  const lightChrome = chrome({ scene: parseColor('#eef2f8'), themeColor: '#6f86ff' })
  check('chrome is dark on a dark scene', luminance(parseColor(darkChrome.base)) < 0.25, darkChrome.base)
  check('chrome is light on a bright scene', luminance(parseColor(lightChrome.base)) > 0.8, lightChrome.base)
  check('chrome sidebar differs from base', darkChrome.sidebar !== darkChrome.base, `${darkChrome.sidebar} vs ${darkChrome.base}`)
  // The chrome takes NO chat overrides: its signature is { scene, themeColor }
  // only, so a bright custom chat colour can never wash out the sidebar.
  check('chromePalette takes exactly one argument', chrome.length === 1, `length=${chrome.length}`)
  check('chrome ignores extra override fields', chrome({
    scene: parseColor('#0a0f1e'),
    themeColor: '#6f86ff',
    overrides: { uiText: '#ffff00', uiButton: '#00ff00' },
  }).text === darkChrome.text)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-autotheme: ok')
