/**
 * DOM regression test for the dsh-chat-background browser half.
 *
 * Builds a miniature shell that mirrors the real AppFrame tree — a frame with
 * an opaque background and three column children — then drives the exact
 * functions that decide what gets cleared, and asserts the painting ORDER is
 * correct for each scope.
 *
 * This catches the bug that made videos "not display": with `scope: chat`,
 * clearing only the conversation column left the frame's own opaque background
 * over the video's rect (a `z-index: -1` body child paints BELOW the frame),
 * so the video existed but was invisible.
 *
 * Run: node tools/verify-dom.mjs
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

/** The theme colours `getComputedStyle(body)` reports for the stub shell. */
const BODY_VARS = {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-specific-sidebar-fill': '#f1f2f4',
  '--dsw-alias-label-primary': '#101014',
}

function makeStyle() {
  const vars = {}
  return {
    setProperty(name, value) {
      vars[name] = String(value)
    },
    removeProperty(name) {
      delete vars[name]
    },
    getPropertyValue(name) {
      return vars[name] ?? ''
    },
    _vars: vars,
  }
}

let elementSequence = 0

function makeElement(label, attrs = {}) {
  const el = {
    label,
    id: elementSequence,
    style: makeStyle(),
    _attrs: { ...attrs },
    children: [],
    parentElement: null,
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null
    },
    setAttribute(name, value) {
      this._attrs[name] = value
    },
    removeAttribute(name) {
      delete this._attrs[name]
    },
    querySelector(selector) {
      const name = /^\[([a-z-]+)\]$/.exec(selector)
      if (name === null) return null
      for (const child of this.children) {
        if (child.hasAttribute(name[1])) return child
        const found = child.querySelector(selector)
        if (found !== null) return found
      }
      return null
    },
  }
  elementSequence += 1
  return el
}

function attach(parent, ...kids) {
  for (const kid of kids) {
    kid.parentElement = parent
    parent.children.push(kid)
  }
}

/**
 * The miniature shell: body > #root > frame > (sidebar, center(scroll),
 * rightbar, bottomRow, overlay).
 * @returns the elements and a `document` stub wired to them.
 */
function buildShell() {
  const body = makeElement('body')
  const root = makeElement('#root')
  const frame = makeElement('frame', { class: 'mP3x-q_frame' })
  const sidebar = makeElement('sidebar', { class: 'mP3x-q_sidebarCol' })
  const center = makeElement('center', { class: 'mP3x-q_centerCol' })
  const scroll = makeElement('scroll', { 'data-conversation-scroll': '' })
  const rightbar = makeElement('rightbar', { class: 'mP3x-q_rightbarCol' })
  const bottomRow = makeElement('bottomRow', { class: 'mP3x-q_bottomRow', 'data-shell-bottom': '' })
  const overlay = makeElement('overlay', { 'data-shell-overlay': '' })
  attach(root, frame)
  attach(frame, sidebar, center, rightbar, bottomRow, overlay)
  attach(center, scroll)
  attach(body, root)

  const createdTags = []
  const head = {
    appendChild(node) {
      createdTags.push(node)
      return node
    },
  }
  const rootAttrs = {}
  const document = {
    body,
    head,
    documentElement: {
      setAttribute(name, value) {
        rootAttrs[name] = String(value)
      },
      removeAttribute(name) {
        delete rootAttrs[name]
      },
      _attrs: rootAttrs,
    },
    querySelector(selector) {
      const styleMatch = /^style\[data-([a-z0-9-]+)\]$/.exec(selector)
      if (styleMatch !== null) {
        const attr = `data-${styleMatch[1]}`
        return createdTags.find((tag) => tag._attrs[attr] !== undefined) ?? null
      }
      if (selector === 'html') return document.documentElement
      const name = /^\[([a-z-]+)\]$/.exec(selector)
      if (name !== null) return body.querySelector(selector)
      return null
    },
    createElement(tagName) {
      const tag = makeElement(tagName)
      tag.textContent = ''
      tag.remove = () => {
        const at = createdTags.indexOf(tag)
        if (at >= 0) createdTags.splice(at, 1)
      }
      return tag
    },
  }
  return { body, frame, sidebar, center, rightbar, bottomRow, overlay, document, createdTags }
}

/** @returns the current text of the palette style tag, or null. */
function paletteStyleText(shell) {
  const tag = shell.createdTags.find((t) => t._attrs['data-dsh-chat-bg-palette'] !== undefined)
  return tag === undefined ? null : tag.textContent
}

/** Run the client bundle with a rich DOM stub and return its test hook. */
function loadClient(shell) {
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
    document: shell.document,
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    clearTimeout,
    getComputedStyle: (el) => ({
      getPropertyValue: (name) => (el === shell.body ? BODY_VARS[name] ?? '' : ''),
    }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  })
  vm.runInContext(SOURCE, context)
  const factoryResult = captured.factory((name) => {
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
  })
  const ctx = {
    slots: {
      inject(slot, run) {
        if (typeof run === 'function') run()
      },
      register() {},
    },
  }
  // apply() installs the test hook, including the shell-discovery functions.
  factoryResult.apply(ctx)
  const result = context.__DSH_CHAT_BG__
  if (result === undefined) throw new Error('test hook missing — apply() never ran')
  return result
}

console.log('== chat scope: the frame must not hide the video ==')
{
  const shell = buildShell()
  const hook = loadClient(shell)
  hook.armShellWatcher('chat')

  // The bug this test exists for: the frame painted opaque over the video rect.
  check('frame background cleared', shell.frame.style.background === 'transparent', shell.frame.style.background)
  check('chat column background cleared', shell.center.style.background === 'transparent', shell.center.style.background)
  check('chat column token cleared', shell.center.style.getPropertyValue('--dsw-alias-bg-base') === 'transparent', shell.center.style.getPropertyValue('--dsw-alias-bg-base'))

  // Siblings stay opaque — and now paint from the TOKEN, so the derived chrome
  // palette (applied to the frame by the component) reaches them automatically
  // instead of a colour frozen at clear time.
  check('sidebar keeps opaque token fill', shell.sidebar.style.background === 'var(--dsw-specific-sidebar-fill)', shell.sidebar.style.background)
  check('rightbar keeps opaque token base', shell.rightbar.style.background === 'var(--dsw-alias-bg-base)', shell.rightbar.style.background)
  check('bottomRow keeps opaque token base', shell.bottomRow.style.background === 'var(--dsw-alias-bg-base)', shell.bottomRow.style.background)

  // No token leak: the frame must not carry a transparent token in chat scope,
  // or the sidebar's descendants would inherit it.
  check('no transparent token on the frame', shell.frame.style.getPropertyValue('--dsw-alias-bg-base') !== 'transparent', shell.frame.style.getPropertyValue('--dsw-alias-bg-base'))

  // The overlay and the leading/handle seats are never touched.
  check('overlay untouched', shell.overlay.style.background === undefined, String(shell.overlay.style.background))

  hook.disarmShellWatcher()
  check('frame restored', shell.frame.style.background === '', shell.frame.style.background)
  check('sidebar restored', shell.sidebar.style.background === '', shell.sidebar.style.background)
  check('chat column restored', shell.center.style.background === '', shell.center.style.background)
  check('chat column token removed', shell.center.style.getPropertyValue('--dsw-alias-bg-base') === '')
}

console.log('\n== fullscreen scope: every column is a hole ==')
{
  const shell = buildShell()
  const hook = loadClient(shell)
  hook.armShellWatcher('fullscreen')
  check('frame background cleared', shell.frame.style.background === 'transparent')
  check('frame token cleared', shell.frame.style.getPropertyValue('--dsw-alias-bg-base') === 'transparent')
  check('sidebar transparent', shell.sidebar.style.background === 'transparent', shell.sidebar.style.background)
  check('center transparent', shell.center.style.background === 'transparent')
  check('rightbar transparent', shell.rightbar.style.background === 'transparent')
  check('bottomRow transparent', shell.bottomRow.style.background === 'transparent')
  hook.disarmShellWatcher()
  check('all restored', shell.frame.style.background === '' && shell.sidebar.style.background === '' && shell.center.style.background === '')
}

console.log('\n== scope switch: chat → fullscreen leaves no opaque siblings ==')
{
  const shell = buildShell()
  const hook = loadClient(shell)
  hook.armShellWatcher('chat')
  hook.armShellWatcher('fullscreen')
  check('sidebar now transparent', shell.sidebar.style.background === 'transparent', shell.sidebar.style.background)
  check('center still transparent', shell.center.style.background === 'transparent')
  hook.disarmShellWatcher()
  check('restored clean', shell.sidebar.style.background === '' && shell.center.style.background === '' && shell.frame.style.background === '')
}

console.log('\n== findChatColumn ==')
{
  const shell = buildShell()
  const hook = loadClient(shell)
  const found = hook.findChatColumn(shell.frame)
  check('resolves to the center column', found === shell.center, found && found.label)
  // Without the scroll marker there is no conversation: null. Detach it from
  // the center column's child list, which is what the stub querySelector
  // walks.
  const bare = buildShell()
  bare.center.children = []
  check('null when no conversation', hook.findChatColumn(bare.frame) === null)
  // v0.8.2 contract: a chat-scope miss must NOT punch a full-frame hole —
  // that left the plugin/tasks pages sitting unreadably on the video. The
  // app stays fully opaque (the hidden video behind the frame), and the
  // chrome palette keeps theming everything.
  const bareHook = loadClient(bare)
  bareHook.armShellWatcher('chat')
  check('no-hole: frame keeps its opaque background', bare.frame.style.background !== 'transparent', String(bare.frame.style.background))
  check('no-hole: sidebar untouched', bare.sidebar.style.background !== 'transparent' && bare.sidebar.style.background !== 'var(--dsw-specific-sidebar-fill)', String(bare.sidebar.style.background))
  check('no-hole: no transparent token on the frame', bare.frame.style.getPropertyValue('--dsw-alias-bg-base') === '', bare.frame.style.getPropertyValue('--dsw-alias-bg-base'))
  bareHook.disarmShellWatcher()
  // And returning to a real conversation re-punches the chat hole correctly.
  hook.armShellWatcher('chat')
  check('re-punch: frame cleared again', shell.frame.style.background === 'transparent', shell.frame.style.background)
  hook.disarmShellWatcher()
}

console.log('\n== titlebar transparency follows the scope ==')
{
  // v0.6: the Windows titlebar strip is dropped ONLY in fullscreen scope; in
  // chat scope the sidebar beside it stays opaque and the strip must remain.
  const shell = buildShell()
  const hook = loadClient(shell)
  hook.armShellWatcher('chat')
  check('root carries the chat scope', shell.document.documentElement._attrs['data-dsh-chat-bg-scope'] === 'chat', JSON.stringify(shell.document.documentElement._attrs))
  const gate = shell.createdTags.find((t) => t._attrs['data-dsh-chat-bg'] !== undefined)
  check('gating stylesheet present', gate !== undefined && typeof gate.textContent === 'string' && gate.textContent.length > 0)
  check('titlebar rule keyed to fullscreen only', gate.textContent.includes('[data-dsh-chat-bg-scope="fullscreen"]') && gate.textContent.includes(':before'), gate.textContent.slice(-220))
  hook.armShellWatcher('fullscreen')
  check('scope attribute tracks the switch', shell.document.documentElement._attrs['data-dsh-chat-bg-scope'] === 'fullscreen')
  hook.disarmShellWatcher()
  check('scope attribute removed on disarm', shell.document.documentElement._attrs['data-dsh-chat-bg-scope'] === undefined, JSON.stringify(shell.document.documentElement._attrs))
  check('root attribute removed on disarm', shell.document.documentElement._attrs['data-dsh-chat-bg'] === undefined)
}

console.log('\n== 「加载更早」 joins the button family ==')
{
  // v0.6: the older-history button reads a hover-solid background and the
  // scene-derived secondary ink — never a guaranteed pair. The palette sheet
  // must pin both onto the button-family colours, matched by the stable
  // `_older` class suffix (the hash prefix changes between builds).
  const shell = buildShell()
  const hook = loadClient(shell)
  const palette = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.5 })
  hook.applyTokens(shell.center, palette, 0.5)
  const tag = paletteStyleText(shell)
  check('older-button rule present', tag.includes('[class*="_older"] button'), tag.slice(-320))
  check('older-button gets the family background', tag.includes(`background:${palette.button}`), `expected ${palette.button}`)
  check('older-button gets the family ink', tag.includes(`color:${palette.buttonText}`), `expected ${palette.buttonText}`)
  check('older pair is readable', hook.contrastRatio(hook.parseColor(palette.buttonText), hook.parseColor(palette.button)) >= 4.5,
    `${palette.buttonText} on ${palette.button}`)
  hook.removeTokens(shell.center)
  check('older rule retired with the sheet', paletteStyleText(shell) === '')
}

console.log('\n== opaque overlays (settings modal) are exempt from the palette ==')
{
  // v0.6 regression: the settings page mounts INSIDE the frame, so the scope's
  // tokens inherited into it — bright chat ink washed out its white nav, and
  // the button-ink rule repainted its row buttons. Overlays must be cut out of
  // the button rule and have the STOCK theme values re-asserted on them.
  const shell = buildShell()
  const hook = loadClient(shell)
  const palette = hook.autoPalette({ scene: [16, 18, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.5 })
  hook.applyTokens(shell.center, palette, 0.5)
  const tag = paletteStyleText(shell)

  check('button ink is targeted, not blanket', !tag.includes('button:not(') && !tag.includes('-scope] button,') && !tag.includes('-scope] button{'), 'blanket button rule is back')
  check('button ink targets newSession', tag.includes('[class*="_newSession"]'), tag.slice(-420))
  check('button ink targets toBottom', tag.includes('[class*="_toBottom"]'))
  check('button ink targets the composer add', tag.includes('[data-composer-card] [class*="_add"]'))
  check('overlay reset rule present', tag.includes('[data-dsh-chat-bg-scope] [role="dialog"]'), tag.slice(-520))
  // The reset re-asserts the stub body's stock colours, not the palette's.
  check('overlay reset restores stock label-primary', tag.includes('--dsw-alias-label-primary:#101014'), 'expected the body value #101014')
  check('overlay reset restores an opaque base', tag.includes('--dsw-alias-bg-base:#ffffff'), 'expected the body value #ffffff')
  check('overlay reset restores plain ink', tag.includes('color:#101014'), 'expected the body label-primary as plain color')
  check('overlay reset does not leak the palette ink', !tag.slice(tag.indexOf('[data-dsh-chat-bg-scope] [role="dialog"]')).includes(palette.assistantText), 'reset block carries palette ink')
  // Code blocks inside the settings README must keep the stock theme too.
  check('code rule excludes dialogs', tag.includes('.md-code-block:not([role="dialog"] .md-code-block,'), tag.slice(0, 400))
  check('inline chip rule excludes dialogs', tag.includes(':not(pre)>code:not([role="dialog"] code,'), tag.slice(0, 700))
}

console.log('\n== applyTokens: input, buttons and bubbles actually change ==')
{
  // The reported complaint was that the composer input and the "new chat"
  // button did not respond to the palette. These are the exact tokens those
  // widgets read.
  const shell = buildShell()
  const hook = loadClient(shell)
  const palette = hook.autoPalette({
    scene: [16, 18, 30],
    themeColor: '#6f86ff',
    overrides: { uiSurface: '#1b2740', uiAccent: '#7fd0ff', uiButton: '#ffd54a', uiBubble: '#2b3a66', uiUserText: '#ffd54a', uiAssistantText: '#9fe8b8' },
    surfaceAlpha: 0.5,
  })
  hook.applyTokens(shell.center, palette, 0.5)

  const tokens = shell.center.style._vars
  check('button fill is the manual button colour, not the accent', tokens['--dsw-alias-button-primary-fill'] === '#ffd54a' && palette.button !== palette.accent,
    `button=${palette.button} accent=${palette.accent}`)
  check('primary button hover set', tokens['--dsw-alias-button-primary-hover'] === palette.buttonStrong)
  // v0.5: the button label must no longer be the stock white on a light fill.
  check('button foreground set', tokens['--dsw-alias-label-primary-foreground'] === palette.buttonText, tokens['--dsw-alias-label-primary-foreground'])
  check('button text readable on fill', hook.contrastRatio(hook.parseColor(palette.buttonText), hook.parseColor(palette.button)) >= 4.5,
    `${palette.buttonText} on ${palette.button}`)
  // v0.5: inline code chips get their own background token.
  check('inline code token set', tokens['--dsw-alias-markdown-inline-code'] === palette.inlineCode, tokens['--dsw-alias-markdown-inline-code'])
  check('composer surface token set', typeof tokens['--dsw-specific-input-major'] === 'string' && tokens['--dsw-specific-input-major'].includes('color-mix'), tokens['--dsw-specific-input-major'])
  check('bubble token set', tokens['--dsw-specific-bubble'] === palette.bubble, tokens['--dsw-specific-bubble'])
  // v0.4: fenced code blocks read --dsw-alias-markdown-code-block (+ banner).
  check('code block token set', tokens['--dsw-alias-markdown-code-block'] === palette.codeBlock, tokens['--dsw-alias-markdown-code-block'])
  check('code banner token follows the block', tokens['--dsw-alias-markdown-code-block-banner'] === palette.codeBlock)
  check('scope marker present', shell.center.getAttribute('data-dsh-chat-bg-scope') === '')

  const tag = paletteStyleText(shell)
  check('role stylesheet created', tag !== null && typeof tag === 'string' && tag.length > 0, String(tag === null ? 'null' : tag.length))
  check('user row selector present', tag.includes('[data-chat-flow-kind="user"]'), tag.slice(0, 140))
  check('user text painted on user rows', tag.includes(palette.userText), tag.slice(0, 200))
  check('bubble colour painted on user rows', tag.includes(palette.bubble))
  check('assistant colour painted separately', tag.includes(palette.assistantText), tag.slice(-220))
  // v0.4: code ink painted on fenced blocks inside the scope.
  check('code block selector present', tag.includes('.md-code-block'), tag.slice(-260))
  check('code text painted on blocks', tag.includes(`color:${palette.codeText}`), `expected codeText ${palette.codeText}`)
  check('auto code text readable on its block', hook.contrastRatio(hook.parseColor(palette.codeText), hook.parseColor(palette.codeBlock)) >= 4.5,
    `${palette.codeText} on ${palette.codeBlock}`)
  // v0.5: inline chips get their own ink rule inside the scope.
  check('inline code rule present', tag.includes(':not(pre)>code') && tag.includes(palette.inlineCodeText), tag.slice(-260))
  check('inline text readable on chip', hook.contrastRatio(hook.parseColor(palette.inlineCodeText), hook.parseColor(palette.inlineCode)) >= 4.5,
    `${palette.inlineCodeText} on ${palette.inlineCode}`)
  // v0.5.1: the raised/floating button family (composer +, 回到底部, 新会话)
  // reads elevated/floating/selector fills — all three get the button colour.
  check('elevated button fill set', tokens['--dsw-alias-button-elevated-fill'] === palette.button, tokens['--dsw-alias-button-elevated-fill'])
  check('floating button fill set', tokens['--dsw-alias-button-floating-fill'] === palette.button)
  check('composer + selector fill set', tokens['--dsw-specific-selector'] === palette.button)
  // Their ink path: targeted class-suffix rules (never a blanket button rule —
  // that washed out the changed-files card rows in v0.6.1).
  check('scoped button ink rule present', tag.includes('[class*="_newSession"]') && tag.includes(palette.buttonText), tag.slice(-320))

  hook.removeTokens(shell.center)
  check('button fill removed', shell.center.style._vars['--dsw-alias-button-primary-fill'] === undefined)
  check('elevated fill removed', shell.center.style._vars['--dsw-alias-button-elevated-fill'] === undefined)
  check('floating fill removed', shell.center.style._vars['--dsw-alias-button-floating-fill'] === undefined)
  check('selector fill removed', shell.center.style._vars['--dsw-specific-selector'] === undefined)
  check('button foreground removed', shell.center.style._vars['--dsw-alias-label-primary-foreground'] === undefined)
  check('inline code token removed', shell.center.style._vars['--dsw-alias-markdown-inline-code'] === undefined)
  check('input token removed', shell.center.style._vars['--dsw-specific-input-major'] === undefined)
  check('bubble token removed', shell.center.style._vars['--dsw-specific-bubble'] === undefined)
  check('code block token removed', shell.center.style._vars['--dsw-alias-markdown-code-block'] === undefined)
  check('code banner token removed', shell.center.style._vars['--dsw-alias-markdown-code-block-banner'] === undefined)
  check('marker removed', shell.center.getAttribute('data-dsh-chat-bg-scope') === null)
  check('role stylesheet emptied', paletteStyleText(shell) === '')
}

console.log('\n== v0.8 chrome tokens: the opaque regions follow the theme ==')
{
  const shell = buildShell()
  const hook = loadClient(shell)
  const chrome = hook.chromePalette({ scene: [10, 15, 30], themeColor: '#6f86ff' })
  hook.applyChromeTokens(shell.frame, chrome)
  const vars = shell.frame.style._vars
  check('chrome marker set', shell.frame.getAttribute('data-dsh-chat-bg-chrome') === '')
  check('chrome base token on the frame', vars['--dsw-alias-bg-base'] === chrome.base, vars['--dsw-alias-bg-base'])
  check('chrome sidebar token', vars['--dsw-specific-sidebar-fill'] === chrome.sidebar, vars['--dsw-specific-sidebar-fill'])
  check('chrome ink token', vars['--dsw-alias-label-primary'] === chrome.text, vars['--dsw-alias-label-primary'])
  check('chrome button fill', vars['--dsw-alias-button-elevated-fill'] === chrome.button)
  check('chrome button ink', vars['--dsw-alias-label-primary-foreground'] === chrome.buttonText)
  check('chrome code block token', vars['--dsw-alias-markdown-code-block'] === chrome.codeBlock)
  check('chrome nav-active token', vars['--dsw-specific-sidebar-nav-item-active'] === chrome.navActive, vars['--dsw-specific-sidebar-nav-item-active'])
  check('chrome nav-accent token', vars['--dsw-specific-sidebar-nav-item-active-accent'] === chrome.navActiveAccent)
  // The chat column's own tokens must not be disturbed by the chrome set.
  check('chrome written to the frame only', shell.center.style._vars['--dsw-alias-bg-base'] === undefined)

  hook.clearChromeTokens(shell.frame)
  check('chrome marker removed', shell.frame.getAttribute('data-dsh-chat-bg-chrome') === null)
  check('chrome base removed', shell.frame.style._vars['--dsw-alias-bg-base'] === undefined)
  check('chrome sidebar removed', shell.frame.style._vars['--dsw-specific-sidebar-fill'] === undefined)
  check('chrome ink removed', shell.frame.style._vars['--dsw-alias-label-primary'] === undefined)
  check('chrome button fill removed', shell.frame.style._vars['--dsw-alias-button-elevated-fill'] === undefined)
  check('chrome code token removed', shell.frame.style._vars['--dsw-alias-markdown-code-block'] === undefined)
  check('chrome nav-active removed', shell.frame.style._vars['--dsw-specific-sidebar-nav-item-active'] === undefined)

  // The overlay reset must cover chrome-mounted dialogs: the settings page
  // inherits chrome tokens from the frame, so it needs the same exemption.
  const palette = hook.autoPalette({ scene: [10, 15, 30], themeColor: '#6f86ff', overrides: {}, surfaceAlpha: 0.5 })
  hook.applyTokens(shell.center, palette, 0.5)
  const tag = paletteStyleText(shell)
  check('overlay reset covers the chrome marker', tag.includes('[data-dsh-chat-bg-chrome] [role="dialog"]'), tag.slice(-520))
  check('blanket button rule stays retired', !tag.includes('button:not(') && !tag.includes('-scope] button{'), 'blanket button rule is back')
  hook.removeTokens(shell.center)
}

console.log('\n== v0.8.1: the observer must never strip CHROME tokens from the frame ==')
{
  // The regression: applyScope's undo pass removed `--dsw-alias-bg-base` and
  // `--dsw-specific-sidebar-fill` from EVERY owned host on every DOM mutation.
  // In chat scope the frame owns those two as the chrome palette, so the
  // sidebar kept its stock dark background while its text followed the palette
  // — the "整体界面不相符" report. The undo must only remove tokens the clear
  // pass itself wrote.
  const shell = buildShell()
  const hook = loadClient(shell)
  hook.armShellWatcher('chat')
  const chrome = hook.chromePalette({ scene: [235, 238, 245], themeColor: '#002aff' })
  hook.applyChromeTokens(shell.frame, chrome)
  // Simulate the observer firing: the scope is re-applied, the undo runs first.
  hook.armShellWatcher('chat')
  check('chrome base token survives the re-apply', shell.frame.style.getPropertyValue('--dsw-alias-bg-base') === chrome.base,
    shell.frame.style.getPropertyValue('--dsw-alias-bg-base'))
  check('chrome sidebar token survives', shell.frame.style.getPropertyValue('--dsw-specific-sidebar-fill') === chrome.sidebar,
    shell.frame.style.getPropertyValue('--dsw-specific-sidebar-fill'))
  check('chrome ink token survives', shell.frame.style.getPropertyValue('--dsw-alias-label-primary') === chrome.text,
    shell.frame.style.getPropertyValue('--dsw-alias-label-primary'))
  check('sidebar still paints from the token', shell.sidebar.style.background === 'var(--dsw-specific-sidebar-fill)', shell.sidebar.style.background)
  hook.disarmShellWatcher()
  check('disarm clears the frame background', shell.frame.style.background === '')
  // Fullscreen writes its OWN transparent tokens on the frame — those must
  // still be undone, or the app keeps holes after the plugin leaves.
  hook.armShellWatcher('fullscreen')
  check('fullscreen frame token present', shell.frame.style.getPropertyValue('--dsw-alias-bg-base') === 'transparent')
  hook.disarmShellWatcher()
  check('fullscreen frame token removed on disarm', shell.frame.style.getPropertyValue('--dsw-alias-bg-base') === '')
  check('fullscreen sidebar restored', shell.sidebar.style.background === '')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-dom: ok')
