/**
 * dsh-chat-background — browser half.
 *
 * Hand-written client bundle in the DSH client-module form: executing this file
 * only REGISTERS a lazy factory (`window.__ModuleLoader__.load`); every module
 * body side effect lives inside the factory closure and runs at materialization.
 * No bundler is involved, which is what keeps this package installable without a
 * build script.
 *
 * Two registrations:
 *   - `shell.overlay` — the background itself, and ONLY when a video is
 *     configured. With no video the plugin registers nothing here, so DSH
 *     behaves exactly as if it were not installed.
 *   - `settings.plugins.tab` — the settings page that chooses the video and
 *     tunes the blending.
 *
 * Host endpoints (absolute, so the same strings work in the browser and under
 * Electron, where the preload bridge forwards absolute-path requests):
 *   GET  /dsh-chat-background/config.json  effective settings + video descriptor
 *   POST /dsh-chat-background/config       store the chosen path and tuning
 *   POST /dsh-chat-background/pick         open a native file dialog
 *   GET  /dsh-chat-background/video/<n>    the video bytes, Range-capable
 *
 * Layering, which is the whole design:
 *
 *   The background is portaled to `<body>` as `position: fixed; inset: 0;
 *   z-index: -1; pointer-events: none`. A negative z-index on a body child paints
 *   BEHIND `#root`'s normal-flow content, so the video sits under the application
 *   instead of over it. `pointer-events: none` means it can never steal a click.
 *
 *   Inside that container the layers stack upward:
 *     1. the video
 *     2. one layer per configured region (vignette, top scrim, bottom scrim, …)
 *     3. the theme tint
 *     4. the dim
 *
 *   Because the container creates a stacking context, `mix-blend-mode` on a
 *   region blends it with the video and the layers below it only — never with the
 *   application above, which is what makes "blend with the video in different
 *   places" possible without disturbing the interface.
 *
 *   The application's own backgrounds are cleared so the video can show through.
 *   That is done by setting the two base background tokens to `transparent` on
 *   the shell frame, which the frame and its columns consume. Card and message
 *   surfaces use their own tokens and stay opaque, so readability is preserved.
 *
 * @module dsh-chat-background/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-background',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')

    /**
     * Mount background nodes as direct children of `<body>`.
     *
     * The background must be in the ROOT stacking context, not inside the shell
     * frame: the frame is `position: relative`, so anything inside it is trapped
     * in the frame's stacking context and cannot paint behind the columns. A
     * negative z-index at the body level is the only place that sits behind
     * `#root`'s normal-flow content.
     *
     * @param node - the element to place.
     * @returns the portal, or the node unchanged when there is no body yet.
     */
    function topLayer(node) {
      if (typeof document === 'undefined' || document.body === null) return node
      return createPortal(node, document.body)
    }

    const BASE = '/dsh-chat-background'
    const CONFIG_URL = `${BASE}/config.json`
    const SAVE_URL = `${BASE}/config`
    const PICK_URL = `${BASE}/pick`
    const OVERLAY_SLOT = 'shell.overlay'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-chat-background'

    /** Marker on `<html>` that gates the injected stylesheet. */
    const ROOT_ATTR = 'data-dsh-chat-bg'

    /**
     * Clear opaque backgrounds so the video can show through, for one scope.
     *
     * The container is `z-index: -1` at the body level, so it paints BELOW the
     * block backgrounds of `#root` and the shell frame. Clearing only the chat
     * column would leave the frame's own opaque background over the video's
     * rect and hide it entirely — the frame must go transparent in BOTH
     * scopes. `chat` therefore re-asserts the concrete theme colours on the
     * non-conversation siblings (sidebar, right bar, bottom row), so the hole
     * is only ever the conversation column's rect.
     *
     * The frame is found through `[data-shell-overlay]`, whose parent is the
     * frame — a stable part of the shell contract, unlike the minified
     * CSS-module class names. The chat column is the frame child that contains
     * `[data-conversation-scroll]`.
     *
     * Safe to call repeatedly and from any branch; a no-op when the shell has
     * not painted yet.
     * @param scope - `fullscreen` or `chat`.
     * @returns every element whose background was touched, for later restore.
     */
    function clearAppBackgrounds(scope) {
      if (typeof document === 'undefined') return []
      const touched = []
      try {
        const overlay = document.querySelector('[data-shell-overlay]')
        const frame = overlay !== null ? overlay.parentElement : null
        if (frame === null) {
          // The shell has not mounted yet; the MutationObserver will retry.
          return []
        }
        if (scope === 'chat' && findChatColumn(frame) === null) {
          // No conversation on screen (the plugin page, automation tasks, a
          // workspace view…): there is nowhere to place the chat hole. The
          // old fallback punched a FULL-FRAME hole instead, which left those
          // opaque pages sitting directly on the video — unreadable mush
          // (v0.8.1 report). Correct behaviour: touch nothing. The undo pass
          // that precedes this call already restored every surface, the
          // frame keeps its opaque background (hidden video), and the chrome
          // palette the component writes on the frame themes the whole app —
          // exactly the "其余区域自动适配" contract, extended to non-chat
          // pages. Returning nothing means nothing new is owned.
          return []
        }
        // The frame's own background ALWAYS has to go: it is a single opaque
        // layer beneath every column, and a `z-index: -1` body child paints
        // below it. But the TOKEN override is scoped to where the hole is:
        // fullscreen drops it on the frame (every column is a hole), chat drops
        // it on the conversation column only, so the sidebar's descendants
        // keep inheriting the real theme colour — or, in v0.8, the CHROME
        // palette the component writes on the frame. `tokens` records who we
        // overrode, so the undo pass never strips a token it never wrote.
        const column = scope === 'chat' ? findChatColumn(frame) : null
        frame.style.background = 'transparent'
        touched.push({ el: frame, tokens: column === null })

        if (column === null) {
          frame.style.setProperty('--dsw-alias-bg-base', 'transparent')
          frame.style.setProperty('--dsw-specific-sidebar-fill', 'transparent')
        }
        for (const child of Array.from(frame.children)) {
          if (child === column) continue
          if (child.hasAttribute('data-shell-overlay')) continue
          if (child.hasAttribute('data-shell-leading')) continue
          if (child.getAttribute('class') !== null && /handle/i.test(child.getAttribute('class'))) continue
          if (column === null) {
            child.style.background = 'transparent'
          } else {
            // Keep the non-chat surfaces opaque — they must cover the now
            // transparent frame beneath them — but paint them from the TOKEN
            // rather than a colour captured at clear time. The frame carries
            // the derived chrome palette (v0.8), so the sidebar and the rest of
            // the chrome follow the video's theme automatically; before any
            // palette exists the same token resolves to the stock theme colour.
            const usesSidebar = child.getAttribute('class') !== null && /sidebar/i.test(child.getAttribute('class'))
            child.style.background = usesSidebar
              ? 'var(--dsw-specific-sidebar-fill)'
              : 'var(--dsw-alias-bg-base)'
          }
          touched.push({ el: child, tokens: false })
        }
        if (column !== null) {
          column.style.setProperty('--dsw-alias-bg-base', 'transparent')
          column.style.setProperty('--dsw-specific-sidebar-fill', 'transparent')
          column.style.background = 'transparent'
          touched.push({ el: column, tokens: true })
        }
      } catch { /* clearing backgrounds must never throw */ }
      return touched
    }

    /**
     * The column element that hosts the conversation, inside a frame.
     * @param frame - the shell frame element.
     * @returns the direct frame child containing `[data-conversation-scroll]`.
     */
    function findChatColumn(frame) {
      const scroll = frame.querySelector('[data-conversation-scroll]')
      if (scroll === null) return null
      let node = scroll
      while (node.parentElement !== null && node.parentElement !== frame) node = node.parentElement
      return node.parentElement === frame ? node : null
    }

    /**
     * Push a palette onto one element as inline theme tokens, plus the
     * role-split stylesheet rules that inline variables cannot express
     * (user bubbles vs assistant text).
     *
     * The host gets a `data-dsh-chat-bg-scope` marker; the palette stylesheet
     * keys off it, so the split applies inside this scope only — and removing
     * the marker retires the rules with no cleanup ordering hazards.
     * @param host - the element that scopes the tokens to its subtree.
     * @param palette - the output of `autoPalette`.
     * @param surfaceAlpha - frosted-panel alpha 0–1.
     */
    function applyTokens(host, palette, surfaceAlpha) {
      if (host === null || host === undefined) return
      const pct = (v) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`
      try {
        host.style.setProperty('--dsw-alias-label-primary', palette.assistantText)
        host.style.setProperty('--dsw-alias-label-secondary', palette.secondary)
        host.style.setProperty('--dsw-alias-label-tertiary', palette.tertiary)
        host.style.setProperty('--dsw-alias-label-quaternary', palette.tertiary)
        host.style.setProperty('--dsw-alias-brand-primary', palette.accent)
        host.style.setProperty('--dsw-alias-bg-base', 'transparent')
        host.style.setProperty('--dsw-alias-bg-module-platform', `color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha)}, transparent)`)
        host.style.setProperty('--dsw-alias-bg-layer-2', `color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha * 0.88)}, transparent)`)
        host.style.setProperty('--dsw-alias-bg-layer-3', `color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha + 0.15)}, transparent)`)
        host.style.setProperty('--dsw-alias-border-l2', `color-mix(in srgb, ${palette.border} 55%, transparent)`)
        host.style.setProperty('--dsw-alias-border-l3', `color-mix(in srgb, ${palette.border} 75%, transparent)`)
        host.style.setProperty('--dsw-alias-border-l4', palette.borderStrong)
        host.style.setProperty('--dsw-alias-interactive-bg-hover', `color-mix(in srgb, ${palette.surface} 80%, ${palette.text} 20%)`)
        // The composer/input card surface and the primary buttons ("新会话"):
        // without these, those widgets kept the stock theme colours and looked
        // "not configurable" even though the rest of the scope adapted.
        host.style.setProperty('--dsw-specific-input-major', `color-mix(in srgb, ${palette.surface} ${pct(Math.min(1, surfaceAlpha + 0.25))}, transparent)`)
        // Floating/raised buttons: the sidebar 「新会话」 reads
        // --dsw-alias-button-elevated-fill (stock: pure white) and the chat
        // 「回到底部」 circle reads --dsw-alias-button-floating-fill (also
        // white) — both were the invisible-white-pill bug. Their ink is
        // guaranteed against the fill by the palette stylesheet below.
        host.style.setProperty('--dsw-alias-button-elevated-fill', palette.button)
        host.style.setProperty('--dsw-alias-button-floating-fill', palette.button)
        host.style.setProperty('--dsw-alias-button-floating-hover', palette.buttonStrong)
        host.style.setProperty('--dsw-alias-interactive-bg-hover-solid', palette.buttonStrong)
        host.style.setProperty('--dsw-specific-selector', palette.button)
        host.style.setProperty('--dsw-alias-button-primary-fill', palette.button)
        host.style.setProperty('--dsw-alias-button-primary-hover', palette.buttonStrong)
        // Two ink paths exist: the primary-button family reads
        // `--dsw-alias-label-primary-foreground`, while the elevated/floating
        // buttons and the composer 「+」 read `--dsw-alias-label-primary`
        // (which the scope otherwise sets to the assistant text). The palette
        // stylesheet below re-pins the button selectors' ink so both paths
        // land on a colour guaranteed ≥4.5 against the shared fill.
        host.style.setProperty('--dsw-alias-label-primary-foreground', palette.buttonText)
        host.style.setProperty('--dsw-specific-bubble', palette.bubble)
        // Inline `code` chips read their own token; without it a light theme
        // paints a near-white chip with near-white ink.
        host.style.setProperty('--dsw-alias-markdown-inline-code', palette.inlineCode)
        // Fenced code blocks (and their sticky banner bar) read this token;
        // setting it on the scope host restyles every block inside.
        host.style.setProperty('--dsw-alias-markdown-code-block', palette.codeBlock)
        host.style.setProperty('--dsw-alias-markdown-code-block-banner', palette.codeBlock)
        // Plain-CSS consumers that ignore the tokens still need readable text.
        host.style.color = palette.text

        // Role split, keyed off the stable flow-kind attributes the transcript
        // rows carry (`user`/`steering` are the human side; everything else in
        // the flow is the model's).
        host.setAttribute('data-dsh-chat-bg-scope', '')
        let tag = document.querySelector('style[data-dsh-chat-bg-palette]')
        if (tag === null) {
          tag = document.createElement('style')
          tag.setAttribute('data-dsh-chat-bg-palette', '')
          document.head.appendChild(tag)
        }
        const roleSelectors = '[data-dsh-chat-bg-scope] [data-chat-flow-kind="user"],[data-dsh-chat-bg-scope] [data-chat-flow-kind="steering"]'
        // Opaque overlays — the settings modal, dropdown menus, listboxes and
        // tooltips — mount INSIDE the frame and paint their own themed card.
        // Without an exemption every token pushed here bleeds into them: the
        // v0.6 regression was bright chat ink washing out the settings page's
        // white nav. Overlays are cut out of the button-ink rule below, and
        // the stock theme values are re-asserted on them.
        const opaqueRoots = ['[role="dialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]']
        // `:not()` takes a selector LIST; each entry must be its own full
        // descendant compound (a bare comma-joined prefix would only qualify
        // the last entry).
        const opaqueNot = (target) => opaqueRoots.map((root) => `${root} ${target}`).join(',')
        // The chrome marker is on the FRAME, so in chat scope its derived
        // tokens inherit into dialogs too — the reset must cover them, or the
        // settings page would take chrome ink on its own white cards.
        const opaqueSelector = ['[data-dsh-chat-bg-scope]', '[data-dsh-chat-bg-chrome]']
          .flatMap((prefix) => opaqueRoots.map((root) => `${prefix} ${root}`))
          .join(',')
        // The theme's own values, read from <body>: the stock token cascade
        // flows through it, while every override lives on the frame/column.
        let overlayBlock = ''
        try {
          const bodyStyle = getComputedStyle(document.body)
          const decls = []
          for (const name of [
            '--dsw-alias-label-primary',
            '--dsw-alias-label-secondary',
            '--dsw-alias-label-tertiary',
            '--dsw-alias-label-quaternary',
            '--dsw-alias-brand-primary',
            '--dsw-alias-bg-base',
            '--dsw-alias-bg-module-platform',
            '--dsw-alias-bg-layer-2',
            '--dsw-alias-bg-layer-3',
            '--dsw-specific-sidebar-nav-item-active',
            '--dsw-specific-sidebar-nav-item-active-accent',
            '--dsw-alias-border-l2',
            '--dsw-alias-border-l3',
            '--dsw-alias-border-l4',
            '--dsw-alias-interactive-bg-hover',
            '--dsw-specific-input-major',
            '--dsw-alias-button-elevated-fill',
            '--dsw-alias-button-floating-fill',
            '--dsw-alias-button-floating-hover',
            '--dsw-alias-interactive-bg-hover-solid',
            '--dsw-specific-selector',
            '--dsw-alias-button-primary-fill',
            '--dsw-alias-button-primary-hover',
            '--dsw-alias-label-primary-foreground',
            '--dsw-specific-bubble',
            '--dsw-alias-markdown-inline-code',
            '--dsw-alias-markdown-code-block',
            '--dsw-alias-markdown-code-block-banner',
          ]) {
            const value = String(bodyStyle.getPropertyValue(name) || '').trim()
            if (value !== '') decls.push(`${name}:${value}`)
          }
          const baseInk = String(bodyStyle.getPropertyValue('--dsw-alias-label-primary') || '').trim()
          if (baseInk !== '') decls.push(`color:${baseInk}`)
          if (decls.length > 0) overlayBlock = `{${decls.join(';')}}`
        } catch { overlayBlock = '' }
        // Code blocks: the fenced block paints its background from the token
        // above; its base ink has no dedicated token, so it is set per element.
        // Highlight.js spans override individual colours, which is intended —
        // this is the fallback ink for plain text inside the block.
        // Opaque overlays are exempt: the settings page renders plugin READMEs
        // with real code blocks, and those keep the stock theme (their
        // background token is re-asserted by the overlay reset below).
        const codeSelectors = ['[data-dsh-chat-bg-scope]']
          .flatMap((prefix) => [
            `${prefix} .md-code-block:not(${opaqueNot('.md-code-block')})`,
            `${prefix} .md-code-block:not(${opaqueNot('.md-code-block')}) pre`,
            `${prefix} .md-code-block:not(${opaqueNot('.md-code-block')}) pre code`,
          ])
          .join(',')
        tag.textContent = [
          // User rows: their own text colour AND their own bubble colour. The
          // bubble's text reads `--dsw-alias-label-primary`, so setting it on
          // the row retints the bubble text without touching the assistant.
          `${roleSelectors}{--dsw-alias-label-primary:${palette.userText};--dsw-specific-bubble:${palette.bubble}}`,
          // Fallback for anything styled by plain CSS rather than tokens.
          `${roleSelectors}{color:${palette.userText}}`,
          // The base scope text variable covers the assistant side already
          // (label-primary = assistantText); repeat it on answer kinds so a
          // nested user override elsewhere cannot leak.
          '[data-dsh-chat-bg-scope] [data-chat-flow-kind="turn-process"]{--dsw-alias-label-primary:'+palette.assistantText+'}',
          `${codeSelectors}{color:${palette.codeText}}`,
          // Inline chips: their ink inherits the surrounding text colour, which
          // is guaranteed against the SCENE, not against the chip. Give them
          // their own readable ink — except inside opaque overlays, whose chip
          // background token the reset below re-asserts to the stock value.
          `[data-dsh-chat-bg-scope] :not(pre)>code:not(${opaqueRoots.map((root) => `${root} code`).join(',')}){color:${palette.inlineCodeText}}`,
          // The raised/floating button family's ink. NOT a blanket `button`
          // rule: the changed-files card renders its rows AS buttons on a
          // white card, and a blanket rule painted them with bright chat ink
          // (v0.6.1 regression). Only the widgets whose BACKGROUND this plugin
          // owns need the ink override, and each has a stable CSS module
          // suffix: `_toBottom` (scroll circle), `_add` inside
          // `[data-composer-card]` (the composer +) — both live in the chat
          // column — and `_newSession`, which in chat scope is styled by the
          // chrome tokens instead (harmless duplicate, correct in fullscreen).
          // The override redefines the VARIABLE on the element itself, so the
          // widget's own `color: var(--dsw-alias-label-primary)` rule resolves
          // to the button ink while every other button in the frame (card
          // rows, settings nav, list items) is left alone.
          `[data-dsh-chat-bg-scope] [class*="_newSession"],[data-dsh-chat-bg-scope] [class*="_toBottom"],[data-dsh-chat-bg-scope] [data-composer-card] [class*="_add"]{--dsw-alias-label-primary:${palette.buttonText}}`,
          // 「加载更早」: the wrapper class is a CSS-module hash (V4vHZW_older)
          // that changes between builds, but the `_older` SUFFIX is stable —
          // match on it. The button reads a hover-solid background and the
          // scene-derived secondary ink, neither guaranteed as a pair; pin the
          // whole button-family colour onto it directly.
          `[data-dsh-chat-bg-scope] [class*="_older"] button{background:${palette.button};color:${palette.buttonText}}`,
          // Token reset for opaque overlays. The palette above is pushed on the
          // frame/column, and custom properties inherit INTO any modal mounted
          // underneath — the settings page then paints its white cards with
          // chat-derived ink and washed-out labels. Re-assert the theme's own
          // values (captured from <body>, where the stock cascade still flows)
          // on every overlay root, so dialogs, menus and tooltips look exactly
          // like they do without this plugin.
          opaqueSelector + (overlayBlock === '' ? '' : overlayBlock),
        ].join('\n')
      } catch { /* never let styling break the app */ }
    }

    /** Remove every token and marker `applyTokens` wrote. */
    function removeTokens(host) {
      if (host === null || host === undefined) return
      try {
        for (const name of [
          '--dsw-alias-label-primary',
          '--dsw-alias-label-secondary',
          '--dsw-alias-label-tertiary',
          '--dsw-alias-label-quaternary',
          '--dsw-alias-brand-primary',
          '--dsw-alias-bg-base',
          '--dsw-alias-bg-module-platform',
          '--dsw-alias-bg-layer-2',
          '--dsw-alias-bg-layer-3',
          '--dsw-alias-border-l2',
          '--dsw-alias-border-l3',
          '--dsw-alias-border-l4',
          '--dsw-alias-interactive-bg-hover',
          '--dsw-specific-input-major',
          '--dsw-alias-button-elevated-fill',
          '--dsw-alias-button-floating-fill',
          '--dsw-alias-button-floating-hover',
          '--dsw-alias-interactive-bg-hover-solid',
          '--dsw-specific-selector',
          '--dsw-alias-button-primary-fill',
          '--dsw-alias-button-primary-hover',
          '--dsw-alias-label-primary-foreground',
          '--dsw-specific-bubble',
          '--dsw-alias-markdown-inline-code',
          '--dsw-alias-markdown-code-block',
          '--dsw-alias-markdown-code-block-banner',
        ]) {
          host.style.removeProperty(name)
        }
        host.style.removeProperty('color')
        host.removeAttribute('data-dsh-chat-bg-scope')
        const tag = document.querySelector('style[data-dsh-chat-bg-palette]')
        if (tag !== null) tag.textContent = ''
      } catch { /* restoring must never throw */ }
    }

    /** Inject the gating stylesheet once, and start watching for the shell. */
    let shellWatcher = null
    let currentScope = 'fullscreen'
    /** Elements whose inline backgrounds we currently own (undo target). */
    let ownedHosts = []

    /**
     * Apply one clearing scope.
     *
     * Every element this plugin touched is restored first, then the new scope
     * is cleared from what the DOM looks like NOW. The undo pass can never be
     * skipped: the observer's re-assertion runs on every DOM mutation, and if
     * the scope's element set changed underneath it (a chat→fullscreen fall-
     * back returning to a real conversation, a React remount replacing a
     * column) stale inline values would linger. Undo-and-re-apply happens
     * synchronously inside one task, so the browser paints only the final
     * state — there is nothing to flicker.
     *
     * The undo removes ONLY what `clearAppBackgrounds` itself wrote (the v0.8
     * bug: it also stripped the frame's `--dsw-alias-bg-base` /
     * `--dsw-specific-sidebar-fill` CHROME tokens on every mutation, so the
     * sidebar kept the stock dark background while its text followed the
     * palette). The `tokens` flag records which hosts got the token overrides.
     * @param scope - `fullscreen` or `chat`.
     */
    function applyScope(scope) {
      for (const owned of ownedHosts) {
        owned.el.style.background = ''
        if (owned.tokens) {
          owned.el.style.removeProperty('--dsw-alias-bg-base')
          owned.el.style.removeProperty('--dsw-specific-sidebar-fill')
        }
      }
      ownedHosts = []
      currentScope = scope
      // The gating stylesheet keys one rule off this marker (the Windows
      // titlebar strip, below), so it must track the live scope.
      try { document.documentElement.setAttribute(ROOT_ATTR + '-scope', scope) } catch { /* decorative */ }
      ownedHosts = clearAppBackgrounds(scope)
    }

    function armShellWatcher(scope) {
      if (typeof document === 'undefined') return
      try {
        if (shellWatcher !== null) {
          applyScope(scope)
          return
        }
        document.documentElement.setAttribute(ROOT_ATTR, 'on')
        const style = document.createElement('style')
        style.setAttribute('data-dsh-chat-bg', '')
        style.textContent = [
          `html[${ROOT_ATTR}="on"], html[${ROOT_ATTR}="on"] body { background: transparent !important; }`,
          `html[${ROOT_ATTR}="on"] #root { background: transparent !important; }`,
          `html[${ROOT_ATTR}="on"] [data-shell-overlay] { background: transparent !important; }`,
          // Windows custom titlebar: the shell paints an opaque strip via
          // `[class*="_frame"]:before` (the class hash changes per build, the
          // `_frame` suffix is stable) using the sidebar fill. In fullscreen
          // scope that strip floats over the video and breaks the immersion;
          // drop its background — the drag region and window buttons are
          // untouched. In chat scope the strip stays: the sidebar beside it is
          // opaque and a transparent band over the window base would look
          // broken.
          `html[${ROOT_ATTR}="on"][${ROOT_ATTR}-scope="fullscreen"] [data-windows-titlebar] [class*="_frame"]:before { background: transparent !important; }`,
        ].join('\n')
        if (document.head && !document.querySelector('style[data-dsh-chat-bg]')) {
          document.head.appendChild(style)
        }
        shellWatcher = new MutationObserver(() => {
          // Re-assert: React may replace the frame between renders, and the
          // owned-host list goes stale with it.
          applyScope(currentScope)
        })
        shellWatcher.observe(document.documentElement, { childList: true, subtree: true })
        applyScope(scope)
      } catch { /* the background is decorative; a failed observer is not fatal */ }
    }

    /** Disarm the watcher and restore the shell's own styling. */
    function disarmShellWatcher() {
      try {
        if (shellWatcher !== null) {
          shellWatcher.disconnect()
          shellWatcher = null
        }
        const style = document.querySelector('style[data-dsh-chat-bg]')
        if (style !== null) style.remove()
        document.documentElement.removeAttribute(ROOT_ATTR)
        document.documentElement.removeAttribute(ROOT_ATTR + '-scope')
        for (const owned of ownedHosts) {
          owned.el.style.background = ''
          if (owned.tokens) {
            owned.el.style.removeProperty('--dsw-alias-bg-base')
            owned.el.style.removeProperty('--dsw-specific-sidebar-fill')
          }
        }
        ownedHosts = []
      } catch { /* restoring must never throw */ }
    }

    /** UI strings; the background is always visible, so it follows the OS language. */
    const TEXT = {
      zh: {
        tab: '聊天背景',
        title: '聊天视频背景',
        intro: '把一段视频循环播放在聊天区背后，可分别调节各区域的混合方式、透明度和主题色。开启「自动主题色」后，插件会从视频主体颜色推导主题色。',
        videoLabel: '背景视频',
        videoPlaceholder: '留空使用内置背景，例如 D:\\videos\\bg.mp4',
        choose: '选择文件…',
        save: '保存',
        clear: '清除',
        saved: '已保存。下次打开或刷新页面即可生效。',
        cleared: '已清除。插件不再介入。',
        picking: '等待文件选择…',
        pickerUnavailable: '这个宿主没有可用的文件对话框，请直接把路径填进上面的输入框。',
        current: '当前生效',
        none: '未设置 —— 插件不介入',
        bundled: '正在使用内置背景',
        willPlay: '正在循环播放',
        size: '大小',
        summary: '素材信息',
        scopeLabel: '背景范围',
        scopeFullscreen: '全屏（整个界面）',
        scopeChat: '仅聊天区域',
        opacity: '视频透明度',
        blur: '背景模糊',
        dim: '整体压暗',
        scale: '缩放',
        speed: '播放速度',
        fit: '填充方式',
        fitCover: '铺满裁切',
        fitContain: '完整显示',
        fitFill: '拉伸填满',
        audioLabel: '背景音频',
        audioSourceLabel: '音源',
        audioNone: '静音',
        audioVideo: '视频原声',
        audioCustom: '自定义音频',
        audioFileLabel: '音频文件',
        audioFilePlaceholder: '例如 D:\\music\\ambience.mp3',
        audioVolume: '音频音量',
        audioLoop: '循环播放',
        audioButtonTip: '背景音频控制',
        audioPlay: '播放',
        audioPause: '暂停',
        audioUnavailable: '当前音源不可用（视频没有音轨，或未选择有效的音频文件）。',
        themeAuto: '自动主题色',
        themeAutoHint: '从视频主体颜色推导主题色，随视频变化',
        themeColor: '主题色',
        themeStrength: '主题色强度',
        themeBlend: '主题色混合方式',
        uiLabel: '界面配色适配',
        uiHint: '自动模式下，文字/强调色/面板颜色会从背景画面推导，保证对比度和可读性；也可以逐个手动指定。',
        uiText: '文字颜色',
        uiUserText: '用户消息文字',
        uiAssistantText: '模型回复文字',
        uiBubble: '用户气泡颜色',
        uiCodeBlock: '代码块背景颜色',
        uiCodeText: '代码块文字颜色',
        uiInlineCode: '行内代码背景',
        uiInlineCodeText: '行内代码文字',
        uiButton: '按钮背景（+号/回到底部/加载更早；全屏含新会话）',
        uiButtonText: '按钮文字',
        uiAccent: '强调色（按钮/高亮）',
        uiSurface: '面板颜色（输入框/卡片）',
        uiAlpha: '面板不透明度',
        uiAuto: '自动',
        regions: '区域混合',
        regionsHint: '每个区域独立设置位置、大小、颜色与混合方式，与视频分别交融。',
        addRegion: '添加区域',
        regionId: '名称',
        regionShape: '形状',
        shapeRadial: '径向',
        shapeLinear: '线性',
        regionAnchor: '锚点',
        regionSize: '大小',
        regionStrength: '强度',
        regionColor: '颜色',
        regionBlend: '混合',
        regionGradient: '渐变',
        regionInvert: '反向',
        removeRegion: '删除',
        regionEmpty: '暂无区域，只保留纯视频背景。',
        problem: {
          'unsupported-format': '这个扩展名不在支持列表里。',
          'missing-file': '找不到这个文件。',
          'unreadable-file': '这个文件读不出来。',
          'not-a-file': '这个路径不是一个文件。',
          'file-too-large': '文件超过 4 GiB 上限。',
          'codec-unsupported': '容器能读，但里面的编码格式当前 Electron 不支持，转码成 H.264 或 VP9 即可。',
          'load-failed': '读不到插件配置。',
        },
      },
      en: {
        tab: 'Chat background',
        title: 'Chat video background',
        intro: 'Loops a video behind the chat area. Each region blends with the video independently — position, size, colour and blend mode — and the theme colour can be derived from the video’s dominant colour.',
        videoLabel: 'Background video',
        videoPlaceholder: 'Leave empty for the bundled background, e.g. D:\\videos\\bg.mp4',
        choose: 'Choose file…',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved. It takes effect the next time DSH opens or the page reloads.',
        cleared: 'Cleared. The plugin no longer engages.',
        picking: 'Waiting for the file dialog…',
        pickerUnavailable: 'This host has no file dialog available; paste the path into the field above instead.',
        current: 'Currently active',
        none: 'Not set — the plugin stays out of the way',
        bundled: 'Using the bundled background',
        willPlay: 'Looping',
        size: 'Size',
        summary: 'Media',
        scopeLabel: 'Background scope',
        scopeFullscreen: 'Fullscreen (whole shell)',
        scopeChat: 'Chat area only',
        opacity: 'Video opacity',
        blur: 'Background blur',
        dim: 'Overall dim',
        scale: 'Scale',
        speed: 'Playback speed',
        fit: 'Fit',
        fitCover: 'Cover (crop)',
        fitContain: 'Contain',
        fitFill: 'Fill (stretch)',
        audioLabel: 'Background audio',
        audioSourceLabel: 'Audio source',
        audioNone: 'Silent',
        audioVideo: 'Video sound',
        audioCustom: 'Custom audio',
        audioFileLabel: 'Audio file',
        audioFilePlaceholder: 'e.g. D:\\music\\ambience.mp3',
        audioVolume: 'Audio volume',
        audioLoop: 'Loop',
        audioButtonTip: 'Background audio controls',
        audioPlay: 'Play',
        audioPause: 'Pause',
        audioUnavailable: 'The current source is unavailable (the video has no audio track, or no valid audio file is chosen).',
        themeAuto: 'Auto theme colour',
        themeAutoHint: 'Derived from the video’s dominant colour and updated as it plays',
        themeColor: 'Theme colour',
        themeStrength: 'Theme strength',
        themeBlend: 'Theme blend mode',
        uiLabel: 'UI colour adaptation',
        uiHint: 'In auto mode text, accent and panel colours are derived from the scene with guaranteed contrast; each role can also be set manually.',
        uiText: 'Text colour',
        uiUserText: 'User message text',
        uiAssistantText: 'Assistant reply text',
        uiBubble: 'User bubble colour',
        uiCodeBlock: 'Code block background',
        uiCodeText: 'Code block text',
        uiInlineCode: 'Inline code background',
        uiInlineCodeText: 'Inline code text',
        uiButton: 'Button fill (+, to-bottom, load-older; New chat in fullscreen)',
        uiButtonText: 'Primary button text',
        uiAccent: 'Accent colour (buttons/highlights)',
        uiSurface: 'Surface colour (inputs/cards)',
        uiAlpha: 'Surface opacity',
        uiAuto: 'Auto',
        regions: 'Region blending',
        regionsHint: 'Each region blends with the video independently — position, size, colour and blend mode.',
        addRegion: 'Add region',
        regionId: 'Name',
        regionShape: 'Shape',
        shapeRadial: 'Radial',
        shapeLinear: 'Linear',
        regionAnchor: 'Anchor',
        regionSize: 'Size',
        regionStrength: 'Strength',
        regionColor: 'Colour',
        regionBlend: 'Blend',
        regionGradient: 'Gradient',
        regionInvert: 'Invert',
        removeRegion: 'Remove',
        regionEmpty: 'No regions — a plain video background.',
        problem: {
          'unsupported-format': 'That extension is not in the supported list.',
          'missing-file': 'That file was not found.',
          'unreadable-file': 'That file could not be read.',
          'not-a-file': 'That path is not a file.',
          'file-too-large': 'The file exceeds the 4 GiB limit.',
          'codec-unsupported': 'The container is readable but the codec inside it is not supported by this Electron build. Transcode to H.264 or VP9.',
          'load-failed': 'The plugin configuration could not be read.',
        },
      },
    }

    /** @returns the locale dictionary for the active page language. */
    function strings() {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('zh') ? TEXT.zh : TEXT.en
    }

    /** Fetch the Host's effective settings. */
    async function payload() {
      try {
        const response = await fetch(CONFIG_URL, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return { settings: {}, video: { kind: 'none' }, videoProblem: 'load-failed' }
        return await response.json()
      } catch {
        return { settings: {}, video: { kind: 'none' }, videoProblem: 'load-failed' }
      }
    }

    /**
     * Read the same payload synchronously.
     *
     * `apply` must decide whether to mount the background BEFORE the shell paints,
     * and an `await` hands control back to the event loop. A synchronous XHR keeps
     * that decision inside the current task.
     * @returns the parsed payload, or a "nothing" payload.
     */
    function payloadSync() {
      try {
        const request = new XMLHttpRequest()
        request.open('GET', CONFIG_URL, false)
        request.send(null)
        if (request.status !== 200) return { settings: {}, video: { kind: 'none' } }
        return JSON.parse(request.responseText)
      } catch {
        return { settings: {}, video: { kind: 'none' } }
      }
    }

    /** Defaults mirroring the Host schema, used when a field is absent from the wire. */
    const FALLBACK = {
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
      regions: [
        { id: 'vignette', shape: 'radial', anchor: { x: 0.5, y: 0.5 }, size: 1.15, strength: 0.55, color: '#000000', blend: 'multiply', gradient: true, invert: true },
        { id: 'top', shape: 'linear', anchor: { x: 0.5, y: 0.0 }, size: 0.35, strength: 0.5, color: '#000000', blend: 'multiply', gradient: true, invert: false },
        { id: 'bottom', shape: 'linear', anchor: { x: 0.5, y: 1.0 }, size: 0.45, strength: 0.7, color: '#000000', blend: 'multiply', gradient: true, invert: false },
      ],
      audioSource: 'none',
      audio: undefined,
      audioVolume: 0.6,
      audioLoop: true,
      uiText: 'auto',
      uiUserText: 'auto',
      uiAssistantText: 'auto',
      uiAccent: 'auto',
      uiSurface: 'auto',
      uiBubble: 'auto',
      uiCodeBlock: 'auto',
      uiCodeText: 'auto',
      uiButton: 'auto',
      uiButtonText: 'auto',
      uiInlineCode: 'auto',
      uiInlineCodeText: 'auto',
      uiSurfaceAlpha: 0.55,
    }

    /** @returns `value` when it is a usable number, else `fallback`. */
    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /** @returns the CSS `object-fit` keyword for the `fit` setting. */
    function objectFit(fit) {
      if (fit === 'cover') return 'cover'
      if (fit === 'fill') return 'fill'
      return 'contain'
    }

    /** @returns a human-readable byte size. */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** Parse `#rgb` / `#rrggbb` into `[r, g, b]`, or `null`. */
    function parseColor(hex) {
      if (typeof hex !== 'string') return null
      const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
      if (match === null) return null
      let body = match[1]
      if (body.length === 3) body = body.split('').map((c) => c + c).join('')
      return [
        parseInt(body.slice(0, 2), 16),
        parseInt(body.slice(2, 4), 16),
        parseInt(body.slice(4, 6), 16),
      ]
    }

    /** Format `[r, g, b]` as `#rrggbb`. */
    function formatColor(rgb) {
      return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
    }

    /** Linearly interpolate two colours; `t` in `[0, 1]`. */
    function lerpColor(from, to, t) {
      return [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ]
    }

    /** WCAG relative luminance of an `[r,g,b]` triple, 0–1. */
    function luminance(rgb) {
      const chan = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
    }

    /** WCAG contrast ratio between two colours, 1–21. */
    function contrastRatio(a, b) {
      const la = luminance(a)
      const lb = luminance(b)
      const hi = Math.max(la, lb)
      const lo = Math.min(la, lb)
      return (hi + 0.05) / (lo + 0.05)
    }

    /**
     * Nudge `fg` toward white or black until it contrasts with `bg` enough.
     *
     * Both directions are tried and the one that passes with the SMALLEST
     * deviation wins, so a light colour on a dark background keeps its white
     * character while a mid-tone background (where white alone cannot pass,
     * e.g. #6f86ff) flips the ink dark instead of returning a failure.
     * @param fg - the candidate foreground `[r,g,b]`.
     * @param bg - the effective background `[r,g,b]`.
     * @param target - the required contrast ratio (4.5 ≈ WCAG AA body text).
     * @returns the adjusted `[r,g,b]`.
     */
    function ensureContrast(fg, bg, target) {
      if (contrastRatio(fg, bg) >= target) return [fg[0], fg[1], fg[2]]
      const white = [255, 255, 255]
      const black = [10, 11, 16]
      // Evaluate the ROUNDED candidate: the palette is emitted as #rrggbb, and
      // a pass at 4.51 that rounds to 4.46 would break the promise downstream.
      const rounded = (c) => parseColor(formatColor(c))
      let best = null
      for (const toward of [white, black]) {
        // Integer steps 1..20: a float `step += 0.05` loop never reaches 1.0
        // (0.9500000000000003 + 0.05 > 1.0), so the pure extremes — the only
        // colours that pass on mid-tone backgrounds — were never tried.
        for (let i = 1; i <= 20; i += 1) {
          const candidate = rounded(lerpColor(fg, toward, i / 20))
          if (contrastRatio(candidate, bg) >= target) {
            if (best === null || i < best.step) best = { candidate, step: i }
            break
          }
        }
      }
      if (best !== null) return best.candidate
      // Neither pure direction reaches the target (a perfectly mid-tone bg):
      // return whichever extreme contrasts more.
      return contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black
    }

    /**
     * Derive a complete UI palette from the scene.
     *
     * `scene` is what the background actually looks like after opacity and dim:
     * the sampled dominant colour pushed toward black by `dim`, then toward the
     * theme colour by `themeStrength`. Text roles get guaranteed-contrast
     * colours, the accent gets enough contrast to work as a label or button
     * colour, and surfaces get a frosted neutral whose lightness opposes the
     * scene. Manual hex overrides win per role; `'auto'` keeps the derivation.
     * @param options - `{ scene, themeColor, overrides, surfaceAlpha }`.
     * @returns the palette of `#rrggbb` strings, plus `dark`.
     */
    /** @returns a hex override parsed, or `null` when the role is `'auto'`. */
    function overrideFor(overrides, key) {
      const value = overrides[key]
      return value !== undefined && value !== 'auto' ? parseColor(value) : null
    }

    function autoPalette(options) {
      const scene = options.scene
      const theme = parseColor(options.themeColor) || [111, 134, 255]
      const overrides = options.overrides || {}
      const surfaceAlpha = typeof options.surfaceAlpha === 'number' ? options.surfaceAlpha : 0.55

      const dark = luminance(scene) < 0.42
      const baseText = dark ? [240, 243, 248] : [20, 22, 28]
      const text = ensureContrast(baseText, scene, 7)
      const secondary = ensureContrast(lerpColor(text, scene, 0.28), scene, 4.5)
      const tertiary = ensureContrast(lerpColor(text, scene, 0.45), scene, 3)
      const accentOverride = overrideFor(overrides, 'uiAccent')
      const accentSource = accentOverride !== null ? accentOverride : theme
      const accent = ensureContrast(accentSource, scene, 4.5)
      const accentStrong = ensureContrast(accentSource, scene, 7)

      const textOverride = overrideFor(overrides, 'uiText')
      const surfaceBase = dark ? [14, 16, 24] : [248, 249, 252]
      const surfaceComputed = lerpColor(scene, surfaceBase, Math.min(1, Math.max(0.18, surfaceAlpha)))
      const surfaceOverride = overrideFor(overrides, 'uiSurface')
      const surface = surfaceOverride !== null ? surfaceOverride : surfaceComputed

      // The user bubble is normally a soft tint of the theme on the scene; a
      // manual colour wins. Its text must read on THIS colour, not on the scene.
      const bubbleOverride = overrideFor(overrides, 'uiBubble')
      const bubbleComputed = lerpColor(scene, theme, dark ? 0.22 : 0.16)
      const bubbleRgb = bubbleOverride !== null ? bubbleOverride : bubbleComputed

      // Role text: user → assistant → uiText → derived, each guaranteed ≥4.5
      // against the surface it will actually sit on (scene for the assistant,
      // the bubble colour for the user).
      const userOverride = overrideFor(overrides, 'uiUserText')
      const assistantOverride = overrideFor(overrides, 'uiAssistantText')
      const userSource = userOverride !== null ? userOverride : textOverride !== null ? textOverride : text
      const assistantSource = assistantOverride !== null ? assistantOverride : textOverride !== null ? textOverride : text

      // Code blocks get their own background and text. Auto background: darker
      // than the surface on dark scenes (code reads as a recessed panel), a
      // soft light grey on bright ones. The code text — whatever it is — is
      // always nudged ≥4.5 against the code background actually painted, so a
      // custom light-on-light choice still stays readable. Syntax-highlighted
      // spans keep their own colours; this is the block's base ink.
      const codeBlockOverride = overrideFor(overrides, 'uiCodeBlock')
      const codeBlockComputed = dark
        ? lerpColor(scene, [8, 10, 18], 0.55)
        : lerpColor(scene, [233, 236, 242], 0.6)
      const codeBlockRgb = codeBlockOverride !== null ? codeBlockOverride : codeBlockComputed
      // Fallback chain: manual uiCodeText → manual uiText → derived code ink.
      const codeTextOverride = overrideFor(overrides, 'uiCodeText')
      const codeTextSource = codeTextOverride !== null
        ? codeTextOverride
        : textOverride !== null ? textOverride : (dark ? [235, 240, 250] : [16, 18, 26])
      const codeTextFinal = ensureContrast(codeTextSource, codeBlockRgb, 4.5)

      // The raised/floating button family (composer +, 回到底部, and in
      // fullscreen also 新会话) paints its background from
      // `--dsw-alias-button-elevated-fill` / `-floating-fill` /
      // `--dsw-specific-selector` and takes its ink from the theme's
      // `--dsw-alias-label-primary` — which the scope sets to the assistant
      // text. So the auto fill must be readable UNDER THE ASSISTANT INK (and
      // under `buttonText`, which is derived against it). A manual `uiButton`
      // wins and the foreground re-derives against it.
      const buttonOverride = overrideFor(overrides, 'uiButton')
      const buttonLight = lerpColor(scene, [248, 249, 252], 0.82)
      const buttonDark = lerpColor(scene, [16, 18, 26], 0.55)
      // Prefer the surface-toned fill; if the assistant ink cannot read on it,
      // take whichever extreme contrasts with that ink better.
      const buttonSurface = lerpColor(surfaceComputed, surfaceBase, 0.55)
      const buttonCandidates = contrastRatio(text, buttonSurface) >= 4.5
        ? [buttonSurface]
        : [buttonLight, buttonDark].sort((a, b) => contrastRatio(text, b) - contrastRatio(text, a))
      const buttonRgb = buttonOverride !== null ? buttonOverride : buttonCandidates[0]
      const buttonTextOverride = overrideFor(overrides, 'uiButtonText')
      const buttonTextSource = buttonTextOverride !== null
        ? buttonTextOverride
        : textOverride !== null ? textOverride : baseText
      const buttonTextFinal = ensureContrast(buttonTextSource, buttonRgb, 4.5)

      // Inline `code` chips inside prose. Stock: near-white chip, inherited
      // ink — invisible over a light theme or when the chip token is untouched
      // in chat scope. Auto: a chip one step off the assistant surface, ink
      // guaranteed on it.
      const inlineOverride = overrideFor(overrides, 'uiInlineCode')
      const inlineComputed = dark
        ? lerpColor(scene, [52, 58, 78], 0.5)
        : lerpColor(scene, [222, 226, 234], 0.55)
      const inlineRgb = inlineOverride !== null ? inlineOverride : inlineComputed
      const inlineTextOverride = overrideFor(overrides, 'uiInlineCodeText')
      const inlineTextSource = inlineTextOverride !== null
        ? inlineTextOverride
        : textOverride !== null ? textOverride : (dark ? [235, 240, 250] : [16, 18, 26])
      const inlineTextFinal = ensureContrast(inlineTextSource, inlineRgb, 4.5)

      return {
        dark,
        text: formatColor(textOverride !== null ? ensureContrast(textOverride, scene, 4.5) : text),
        secondary: formatColor(textOverride !== null ? ensureContrast(lerpColor(textOverride, scene, 0.28), scene, 4.5) : secondary),
        tertiary: formatColor(tertiary),
        userText: formatColor(ensureContrast(userSource, bubbleRgb, 4.5)),
        assistantText: formatColor(ensureContrast(assistantSource, scene, 4.5)),
        accent: formatColor(accent),
        accentStrong: formatColor(accentStrong),
        surface: formatColor(surface),
        bubble: formatColor(bubbleRgb),
        codeBlock: formatColor(codeBlockRgb),
        codeText: formatColor(codeTextFinal),
        button: formatColor(buttonRgb),
        buttonStrong: formatColor(ensureContrast(buttonRgb, scene, 4.5)),
        buttonText: formatColor(buttonTextFinal),
        inlineCode: formatColor(inlineRgb),
        inlineCodeText: formatColor(inlineTextFinal),
        border: formatColor(lerpColor(scene, text, 0.35)),
        borderStrong: formatColor(lerpColor(scene, text, 0.55)),
      }
    }

    /**
     * The palette for the OPAQUE regions around the chat column.
     *
     * In `scope: 'chat'` the video only covers the conversation column, so the
     * sidebar and the other columns stay solid panels. They should still follow
     * the theme the video produced — but they cannot reuse the chat palette,
     * whose colours are guaranteed against the VIDEO (a moving, semi-transparent
     * surface). Here the background is a flat colour this function chooses, so
     * every ink is measured against that exact solid, at the same WCAG targets.
     *
     * Deliberately independent of the manual `ui*` overrides: those describe
     * chat-area roles. The chrome follows the automatic derivation so a custom
     * bright chat colour can never make the sidebar unreadable.
     * @param options - `{ scene, themeColor }` as `[r,g,b]` / hex.
     * @returns a token map of `#rrggbb` strings.
     */
    function chromePalette(options) {
      const scene = options.scene
      // Measure against the ROUNDED colour: the palette is emitted as #rrggbb,
      // and a guarantee computed on the float would miss by a hair on the
      // rendered hex (the boundary that produced 4.4996 against a 4.5 promise).
      const quantize = (rgb) => parseColor(formatColor(rgb))
      const dark = luminance(scene) < 0.42
      // A solid tinted off the scene: dark scenes get a deep neutral, bright
      // ones a soft off-white. Pushed far enough that the panel reads as a
      // surface, not as a faded version of the video.
      const base = quantize(lerpColor(scene, dark ? [12, 14, 20] : [247, 248, 251], 0.62))
      // The sidebar is one step away from the base so the two columns remain
      // distinguishable, exactly as the stock theme does it.
      const sidebar = quantize(lerpColor(base, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.07 : 0.045))
      // Text sits on BOTH panels, so it must clear the WORSE of the two.
      // Guarantee against each in turn; the two panels are close enough that
      // two passes always converge, and the final check picks the pure extreme
      // with the best minimum if anything still fails.
      const inkSeed = dark ? [240, 243, 248] : [20, 22, 28]
      let ink = ensureContrast(inkSeed, base, 7)
      ink = ensureContrast(ink, sidebar, 7)
      ink = ensureContrast(ink, base, 7)
      if (contrastRatio(ink, base) < 7 || contrastRatio(ink, sidebar) < 7) {
        const white = [255, 255, 255]
        const black = [10, 11, 16]
        const minAgainst = (c) => Math.min(contrastRatio(c, base), contrastRatio(c, sidebar))
        ink = minAgainst(white) >= minAgainst(black) ? white : black
      }
      const secondary = ensureContrast(lerpColor(ink, base, 0.3), base, 4.5)
      const tertiary = ensureContrast(lerpColor(ink, base, 0.5), base, 3)
      const themeRgb = parseColor(options.themeColor)
      const accent = ensureContrast(themeRgb !== null ? themeRgb : ink, base, 4.5)
      const surface = quantize(lerpColor(base, ink, 0.09))
      const layer = quantize(lerpColor(base, ink, 0.14))
      // The chrome button fill. The sidebar 「新会话」 paints its ink from
      // `--dsw-alias-label-primary` — the chrome TEXT — so the fill must keep
      // that ink readable, not merely the derived buttonText. Candidates are
      // tried in order of how much they stand out, and the panel colour itself
      // is the last resort: text-on-base is guaranteed at 7:1 above, so a
      // button that merely looks flush with its panel is the worst case, never
      // an unreadable one.
      const buttonCandidates = [
        quantize(lerpColor(base, ink, dark ? 0.15 : 0.11)),
        quantize(lerpColor(base, dark ? [0, 0, 0] : [255, 255, 255], 0.25)),
        quantize(lerpColor(base, ink, dark ? 0.07 : 0.05)),
        base,
      ]
      const button = buttonCandidates.find((c) => contrastRatio(ink, c) >= 4.5) ?? base
      const codeBlock = quantize(lerpColor(base, dark ? [0, 0, 0] : [228, 232, 240], dark ? 0.35 : 0.7))
      // The sidebar's ACTIVE nav row (the selected session) paints from its
      // own token pair; left stock, a dark-blue slab floats on a bright
      // chrome. Derive it from the accent, kept readable under the chrome ink.
      const navSeed = quantize(lerpColor(base, accent, 0.3))
      const navMid = quantize(lerpColor(base, accent, 0.15))
      // Same safety net as the button fill: text-on-base is guaranteed at 7:1,
      // so the flush-with-panel colour is the worst acceptable outcome.
      const navActive = contrastRatio(ink, navSeed) >= 4.5
        ? navSeed
        : (contrastRatio(ink, navMid) >= 4.5 ? navMid : base)
      return {
        base: formatColor(base),
        sidebar: formatColor(sidebar),
        navActive: formatColor(navActive),
        navActiveAccent: formatColor(accent),
        text: formatColor(ink),
        secondary: formatColor(secondary),
        tertiary: formatColor(tertiary),
        accent: formatColor(accent),
        surface: formatColor(surface),
        layer: formatColor(layer),
        button: formatColor(button),
        buttonStrong: formatColor(quantize(lerpColor(button, ink, 0.12))),
        buttonText: formatColor(ensureContrast(ink, button, 4.5)),
        codeBlock: formatColor(codeBlock),
        codeText: formatColor(ensureContrast(ink, codeBlock, 4.5)),
        border: formatColor(quantize(lerpColor(base, ink, 0.26))),
        borderStrong: formatColor(quantize(lerpColor(base, ink, 0.42))),
      }
    }

    /**
     * Paint the opaque chrome tokens onto the frame.
     *
     * Set on the FRAME (not the column) so every non-chat surface inherits
     * them, while the conversation column's own inline tokens keep winning for
     * the chat area. The frame also gets a marker so the palette stylesheet can
     * exempt dialogs mounted anywhere under it.
     * @param frame - the shell frame element.
     * @param chrome - the output of `chromePalette`.
     */
    function applyChromeTokens(frame, chrome) {
      if (frame === null || frame === undefined) return
      try {
        frame.setAttribute('data-dsh-chat-bg-chrome', '')
        frame.style.setProperty('--dsw-alias-bg-base', chrome.base)
        frame.style.setProperty('--dsw-specific-sidebar-fill', chrome.sidebar)
        // The selected conversation row in the sidebar.
        frame.style.setProperty('--dsw-specific-sidebar-nav-item-active', chrome.navActive)
        frame.style.setProperty('--dsw-specific-sidebar-nav-item-active-accent', chrome.navActiveAccent)
        frame.style.setProperty('--dsw-alias-label-primary', chrome.text)
        frame.style.setProperty('--dsw-alias-label-secondary', chrome.secondary)
        frame.style.setProperty('--dsw-alias-label-tertiary', chrome.tertiary)
        frame.style.setProperty('--dsw-alias-label-quaternary', chrome.tertiary)
        frame.style.setProperty('--dsw-alias-brand-primary', chrome.accent)
        frame.style.setProperty('--dsw-alias-bg-module-platform', chrome.surface)
        frame.style.setProperty('--dsw-alias-bg-layer-2', chrome.surface)
        frame.style.setProperty('--dsw-alias-bg-layer-3', chrome.layer)
        frame.style.setProperty('--dsw-alias-border-l2', `color-mix(in srgb, ${chrome.border} 55%, transparent)`)
        frame.style.setProperty('--dsw-alias-border-l3', `color-mix(in srgb, ${chrome.border} 75%, transparent)`)
        frame.style.setProperty('--dsw-alias-border-l4', chrome.borderStrong)
        frame.style.setProperty('--dsw-alias-interactive-bg-hover', chrome.surface)
        frame.style.setProperty('--dsw-alias-interactive-bg-hover-solid', chrome.button)
        frame.style.setProperty('--dsw-specific-input-major', chrome.surface)
        frame.style.setProperty('--dsw-alias-button-elevated-fill', chrome.button)
        frame.style.setProperty('--dsw-alias-button-floating-fill', chrome.button)
        frame.style.setProperty('--dsw-alias-button-floating-hover', chrome.buttonStrong)
        frame.style.setProperty('--dsw-specific-selector', chrome.button)
        frame.style.setProperty('--dsw-alias-button-primary-fill', chrome.button)
        frame.style.setProperty('--dsw-alias-button-primary-hover', chrome.buttonStrong)
        frame.style.setProperty('--dsw-alias-label-primary-foreground', chrome.buttonText)
        frame.style.setProperty('--dsw-alias-markdown-code-block', chrome.codeBlock)
        frame.style.setProperty('--dsw-alias-markdown-code-block-banner', chrome.codeBlock)
        frame.style.setProperty('--dsw-alias-markdown-inline-code', chrome.surface)
      } catch { /* styling must never break the app */ }
    }

    /**
     * Remove every chrome token `applyChromeTokens` wrote.
     * @param frame - the shell frame element.
     */
    function clearChromeTokens(frame) {
      if (frame === null || frame === undefined) return
      try {
        for (const name of [
          '--dsw-alias-bg-base',
          '--dsw-specific-sidebar-fill',
          '--dsw-specific-sidebar-nav-item-active',
          '--dsw-specific-sidebar-nav-item-active-accent',
          '--dsw-alias-label-primary',
          '--dsw-alias-label-secondary',
          '--dsw-alias-label-tertiary',
          '--dsw-alias-label-quaternary',
          '--dsw-alias-brand-primary',
          '--dsw-alias-bg-module-platform',
          '--dsw-alias-bg-layer-2',
          '--dsw-alias-bg-layer-3',
          '--dsw-alias-border-l2',
          '--dsw-alias-border-l3',
          '--dsw-alias-border-l4',
          '--dsw-alias-interactive-bg-hover',
          '--dsw-alias-interactive-bg-hover-solid',
          '--dsw-specific-input-major',
          '--dsw-alias-button-elevated-fill',
          '--dsw-alias-button-floating-fill',
          '--dsw-alias-button-floating-hover',
          '--dsw-specific-selector',
          '--dsw-alias-button-primary-fill',
          '--dsw-alias-button-primary-hover',
          '--dsw-alias-label-primary-foreground',
          '--dsw-alias-markdown-code-block',
          '--dsw-alias-markdown-code-block-banner',
          '--dsw-alias-markdown-inline-code',
        ]) {
          frame.style.removeProperty(name)
        }
        frame.removeAttribute('data-dsh-chat-bg-chrome')
      } catch { /* restoring must never throw */ }
    }

    /**
     * The stylesheet body that remaps theme tokens inside one scope.
     * @param selector - a CSS selector matching the scope element.
     * @param palette - the output of `autoPalette`.
     * @param surfaceAlpha - frosted-panel alpha 0–1.
     * @returns the CSS rules.
     */
    function uiTokensCss(selector, palette, surfaceAlpha) {
      const pct = (v) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`
      const vars = [
        `--dsw-alias-label-primary: ${palette.text}`,
        `--dsw-alias-label-secondary: ${palette.secondary}`,
        `--dsw-alias-label-tertiary: ${palette.tertiary}`,
        `--dsw-alias-label-quaternary: ${palette.tertiary}`,
        `--dsw-alias-brand-primary: ${palette.accent}`,
        `--dsw-alias-bg-base: transparent`,
        `--dsw-alias-bg-module-platform: color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha)}, transparent)`,
        `--dsw-alias-bg-layer-2: color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha * 0.88)}, transparent)`,
        `--dsw-alias-bg-layer-3: color-mix(in srgb, ${palette.surface} ${pct(surfaceAlpha + 0.15)}, transparent)`,
        `--dsw-alias-border-l2: color-mix(in srgb, ${palette.border} 55%, transparent)`,
        `--dsw-alias-border-l3: color-mix(in srgb, ${palette.border} 75%, transparent)`,
        `--dsw-alias-border-l4: ${palette.borderStrong}`,
        `--dsw-alias-interactive-bg-hover: color-mix(in srgb, ${palette.surface} 80%, ${palette.text} 20%)`,
      ].join(';')
      return `${selector}{${vars}}`
    }

    /**
     * Decide what plays sound, and on which element.
     * @param settings - the effective settings (`audioSource`, `audioVolume`).
     * @param options - `{ videoKind, audioOk }`.
     * @returns `{ carrier, videoMuted, allowGesture }`.
     */
    function audioPlan(settings, options) {
      const videoHasSound = options.videoKind === 'video'
      if (settings.audioSource === 'none') {
        return { carrier: 'none', videoMuted: true, allowGesture: false }
      }
      if (settings.audioSource === 'custom') {
        if (options.audioOk === true) {
          // The video's own track (if any) is muted so the two never double up.
          return { carrier: 'audio', videoMuted: true, allowGesture: settings.audioVolume > 0 }
        }
        return videoHasSound
          ? { carrier: 'video', videoMuted: false, allowGesture: true }
          : { carrier: 'none', videoMuted: true, allowGesture: false }
      }
      // 'video'
      return videoHasSound
        ? { carrier: 'video', videoMuted: false, allowGesture: true }
        : { carrier: 'none', videoMuted: true, allowGesture: false }
    }

    /**
     * Sample the dominant colour of a video frame.
     *
     * Averages the pixels that are neither near-black nor near-white, so a dark
     * scene does not collapse the accent to black and a blown-out one does not
     * collapse it to white. Returns `null` when the frame carries no usable colour.
     * @param video - the playing video element.
     * @returns a `#rrggbb` string, or `null`.
     */
    function sampleDominantColor(video) {
      try {
        if (typeof document === 'undefined') return null
        const size = 32
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx === null) return null
        ctx.drawImage(video, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue
          const luminance = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
          if (luminance < 14 || luminance > 245) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n += 1
        }
        if (n === 0) return null
        return formatColor([r / n, g / n, b / n])
      } catch {
        // A tainted canvas (a cross-origin video) throws on getImageData. The
        // background still plays; only the automatic theme colour is unavailable.
        return null
      }
    }

    /**
     * Build the CSS `background` for one region.
     * @param region - the normalised region.
     * @returns a gradient string.
     */
    function regionBackground(region) {
      const anchorX = Math.round(region.anchor.x * 100)
      const anchorY = Math.round(region.anchor.y * 100)
      const color = region.color
      const extent = Math.round(region.size * 100)
      if (region.shape === 'radial') {
        if (region.invert) {
          return `radial-gradient(circle at ${anchorX}% ${anchorY}%, transparent 0%, transparent ${Math.round(region.size * 50)}%, ${color} ${extent}%)`
        }
        return `radial-gradient(circle at ${anchorX}% ${anchorY}%, ${color} 0%, transparent ${extent}%)`
      }
      let direction = 'to bottom'
      if (region.anchor.y <= 0.01) direction = 'to bottom'
      else if (region.anchor.y >= 0.99) direction = 'to top'
      else if (region.anchor.x <= 0.01) direction = 'to right'
      else if (region.anchor.x >= 0.99) direction = 'to left'
      if (region.gradient) {
        return `linear-gradient(${direction}, ${color} 0%, transparent ${extent}%)`
      }
      return `linear-gradient(${direction}, ${color} 0%, ${color} ${Math.max(1, extent - 1)}%, transparent ${extent}%)`
    }

    /**
     * The background layer.
     *
     * Renders a fixed container behind the application holding the video, the
     * per-region blend layers, the theme tint and the dim. In `scope: 'chat'`
     * the container is positioned over the conversation column's rect instead
     * of the viewport, and only that column's backgrounds are cleared.
     * @returns the container element.
     */
    function ChatBackground() {
      const videoRef = React.useRef(null)
      const audioRef = React.useRef(null)
      const [session, setSession] = React.useState({ phase: 'loading' })
      const [themeColor, setThemeColor] = React.useState(FALLBACK.themeColor)
      const [dominant, setDominant] = React.useState(null)
      // The eased value, mirrored in a ref: the rAF loop must read the CURRENT
      // colour without re-subscribing, and setState is asynchronous.
      const dominantRef = React.useRef(null)
      const themeRef = React.useRef(FALLBACK.themeColor)
      // Keep the mirror honest: a settings save (manual theme) or the settled
      // snap writes through setState, and this runs after every render.
      React.useEffect(() => {
        themeRef.current = themeColor
      }, [themeColor])
      const [rect, setRect] = React.useState(null)
      const [playing, setPlaying] = React.useState(false)
      const [awaitingGesture, setAwaitingGesture] = React.useState(false)
      const gestureBound = React.useRef(false)
      const t = strings()

      /** Load the effective settings. */
      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          const settings = { ...FALLBACK, ...((result && result.settings) || {}) }
          setSession({
            phase: 'ready',
            settings,
            video: (result && result.video) || { kind: 'none' },
            videoSource: (result && result.videoSource) || null,
            videoProblem: (result && result.videoProblem) || null,
            audio: (result && result.audio) || { kind: 'none' },
            soundSource: (result && result.soundSource) || 'none',
            audioProblem: (result && result.audioProblem) ?? null,
          })
        })
        return () => {
          cancelled = true
        }
      }, [])

      /** Arm the shell watcher, for this session's scope, while mounted. */
      const scope = session.phase === 'ready' ? session.settings.scope : 'fullscreen'
      React.useLayoutEffect(() => {
        armShellWatcher(scope)
        return () => disarmShellWatcher()
      }, [scope])

      /** The audio plan for this session. Memoised so the play effects below
       *  re-run only when the session actually changes — otherwise every render
       *  would re-call `play()` and undo a pause from the audio button. */
      const plan = React.useMemo(() => (session.phase === 'ready'
        ? audioPlan(session.settings, {
          videoKind: session.video.kind,
          audioOk: session.audio.kind === 'sound' && session.audioProblem === null,
        })
        : { carrier: 'none', videoMuted: true, allowGesture: false }), [session])

      /**
       * Loop the video forever.
       *
       * The video plays muted unless the audio plan says it carries the sound.
       * An unmuted autoplay attempt can be refused by the browser; the catch
       * falls back to muted playback and marks the plan as awaiting a gesture,
       * which the audio button then unlocks on click.
       *
       * Playback is only re-attempted when the media identity changes: a
       * settings save produces a new `session` object with the same URL, and
       * pausing/restarting the loop for that would stutter the picture.
       */
      const lastAttemptKey = React.useRef('')
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        const settings = session.settings
        const media = session.video
        if (media.kind === 'none' || session.videoProblem !== null) return undefined
        const node = videoRef.current
        if (node === null || node === undefined) return undefined

        node.playbackRate = settings.speed
        node.loop = true
        node.muted = plan.videoMuted || plan.carrier === 'none'
        node.volume = plan.carrier === 'video' ? settings.audioVolume : settings.volume

        const attemptKey = `${plan.carrier} ${media.url ?? ''}`
        if (attemptKey === lastAttemptKey.current) return undefined
        lastAttemptKey.current = attemptKey

        const started = node.play()
        if (started !== undefined && typeof started.then === 'function') {
          started.then(
            () => {
              if (!node.muted) setPlaying(true)
            },
            () => {
              // Unmuted autoplay refused: retry muted. The video must keep
              // playing even when its sound cannot.
              node.muted = true
              const retry = node.play()
              if (retry !== undefined && typeof retry.catch === 'function') retry.catch(() => {})
              if (plan.carrier === 'video') setAwaitingGesture(true)
            }
          )
        }
        return undefined
      }, [session, plan])

      /**
       * Track the chat column's rect when the scope is 'chat'.
       *
       * A light poll plus a window-resize listener keeps the fixed container
       * glued to the conversation: the column moves and resizes with sidebar
       * drags, panel toggles and React remounts, none of which fire a window
       * event. The poll is 500 ms and the state only updates on a real change,
       * so it costs nothing between layout shifts.
       */
      const trackRect = session.phase === 'ready' && session.settings.scope === 'chat'
      React.useEffect(() => {
        if (!trackRect) {
          setRect(null)
          return undefined
        }
        const measure = () => {
          const overlay = document.querySelector('[data-shell-overlay]')
          const frame = overlay !== null ? overlay.parentElement : null
          if (frame === null) return
          const column = findChatColumn(frame)
          if (column === null) return
          const box = column.getBoundingClientRect()
          setRect((previous) => {
            if (previous !== null
              && Math.abs(previous.left - box.left) < 0.5
              && Math.abs(previous.top - box.top) < 0.5
              && Math.abs(previous.width - box.width) < 0.5
              && Math.abs(previous.height - box.height) < 0.5) {
              return previous
            }
            return { left: box.left, top: box.top, width: box.width, height: box.height }
          })
        }
        measure()
        const poll = window.setInterval(measure, 500)
        window.addEventListener('resize', measure)
        return () => {
          window.clearInterval(poll)
          window.removeEventListener('resize', measure)
        }
      }, [trackRect])

      /**
       * Derive the theme colour from the video's dominant colour.
       *
       * Sampling and easing are deliberately SEPARATE:
       *
       * - A slow tick (every 2s) takes one fresh frame sample and stores it as
       *   the *target*. Sampling is the expensive part (decode + 1024 pixels).
       * - A requestAnimationFrame loop then eases the *displayed* colour toward
       *   that target every frame, with a time constant that makes a full
       *   transition take about two seconds.
       *
       * Easing on the frame clock is what makes the change read as a gradient:
       * the previous design eased once per 2s tick, so the whole palette —
       * background, text, buttons, code — lurched visibly twice a second.
       * Because the palette is recomputed from the eased source, EVERY derived
       * colour (text, secondary, bubble, code block, button, borders) glides,
       * and each frame's palette still passes the full contrast guarantees —
       * unlike easing the output colours directly, which could drift through
       * unreadable midpoints.
       *
       * The loop parks itself once the value has settled, so a static poster
       * frame costs no CPU, and it restarts on the next sample.
       */
      const EASE_TAU_MS = 700
      // Per-channel settle bound in 0–255. Two units is imperceptible, and it
      // is what lets the frame loop park itself instead of spinning forever on
      // differences nobody can see.
      const EASE_SETTLE = 2
      const dominantTargetRef = React.useRef(null)
      const easeFrameRef = React.useRef(0)
      const easeLastRef = React.useRef(0)

      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return undefined
        if (session.phase !== 'ready') return undefined
        if (session.video.kind === 'none' || session.videoProblem !== null) return undefined
        if (session.settings.themeAuto !== true) return undefined
        const node = videoRef.current
        if (node === null || node === undefined) return undefined

        /** Nudge the displayed colour toward the target; false once settled. */
        const easeStep = (now) => {
          const target = dominantTargetRef.current
          if (target === null) return false
          const from = parseColor(dominantRef.current)
          const to = parseColor(target)
          if (from === null || to === null) {
            dominantRef.current = target
            setDominant(target)
            return true
          }
          const dt = easeLastRef.current === 0 ? 16 : Math.min(120, now - easeLastRef.current)
          easeLastRef.current = now
          // Frame-rate independent exponential smoothing.
          const k = 1 - Math.exp(-dt / EASE_TAU_MS)
          const next = lerpColor(from, to, k)
          const rounded = formatColor(next)
          // Snap once every channel is within two 8-bit steps: imperceptible,
          // and it lets the loop park instead of chasing float dust forever.
          const settled = Math.abs(next[0] - to[0]) <= EASE_SETTLE && Math.abs(next[1] - to[1]) <= EASE_SETTLE && Math.abs(next[2] - to[2]) <= EASE_SETTLE
          if (settled) {
            if (dominantRef.current !== target) {
              dominantRef.current = target
              setDominant(target)
            }
            if (themeRef.current !== target) {
              themeRef.current = target
              setThemeColor(target)
            }
            return false
          }
          if (rounded !== dominantRef.current) {
            dominantRef.current = rounded
            setDominant(rounded)
          }
          // The theme colour follows the SAME eased value, so the tint and the
          // scene never disagree mid-transition. Only commit when the rounded
          // colour actually moves: an unconditional setState per frame would
          // recompute the whole palette (12 roles + a stylesheet rebuild) at
          // 60fps even while the video is visually still.
          const nextTheme = formatColor(lerpColor(parseColor(themeRef.current) ?? from, next, k))
          if (nextTheme !== themeRef.current) {
            themeRef.current = nextTheme
            setThemeColor(nextTheme)
          }
          // Still moving: keep the pump alive.
          return true
        }

        const pump = () => {
          easeFrameRef.current = 0
          const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
          if (easeStep(now)) {
            easeFrameRef.current = window.requestAnimationFrame(pump)
          }
        }

        const startPump = () => {
          if (easeFrameRef.current !== 0) return
          easeLastRef.current = 0
          easeFrameRef.current = window.requestAnimationFrame(pump)
        }

        const interval = window.setInterval(() => {
          // drawImage accepts both `<video>` and `<img>`, so an animated GIF
          // background is sampled the same way.
          const sample = sampleDominantColor(node)
          if (sample === null) return
          dominantTargetRef.current = sample
          if (dominantRef.current === null) {
            dominantRef.current = sample
            setDominant(sample)
          }
          startPump()
        }, 2000)
        // Prime immediately so the first paint is not the default blue.
        const first = sampleDominantColor(node)
        if (first !== null) {
          dominantTargetRef.current = first
          dominantRef.current = first
          setDominant(first)
        }
        return () => {
          window.clearInterval(interval)
          if (easeFrameRef.current !== 0 && typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(easeFrameRef.current)
          }
          easeFrameRef.current = 0
        }
      }, [session])

      /**
       * The custom audio element: play it when the plan says so.
       * @returns nothing.
       */
      const lastAudioKey = React.useRef('')
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (plan.carrier !== 'audio') {
          lastAudioKey.current = ''
          const node = audioRef.current
          if (node !== null && node !== undefined) {
            try {
              node.pause()
            } catch { /* already stopped */ }
          }
          return undefined
        }
        const node = audioRef.current
        if (node === null || node === undefined) return undefined
        const settings = session.settings
        node.volume = settings.audioVolume
        node.loop = settings.audioLoop
        // A settings save that did not change the carrier or the file must not
        // restart playback — that would cut the sound off mid-phrase.
        const attemptKey = `audio ${session.audio.url ?? ''}`
        if (attemptKey === lastAudioKey.current) return undefined
        lastAudioKey.current = attemptKey
        node.muted = false
        const started = node.play()
        if (started !== undefined && typeof started.then === 'function') {
          started.then(
            () => setPlaying(true),
            () => {
              node.muted = true
              const retry = node.play()
              if (retry !== undefined && typeof retry.catch === 'function') retry.catch(() => {})
              setAwaitingGesture(true)
            }
          )
        }
        return undefined
      }, [session, plan])

      /**
       * A fresh settings read (page reload, or the boot fetch completing)
       * resets the gesture latch: the play effects above re-evaluate the plan
       * and set `awaitingGesture` again only if the browser still refuses.
       */
      React.useEffect(() => {
        gestureBound.current = false
        setAwaitingGesture(false)
      }, [session])

      /**
       * Gesture unlock: the first click/keypress starts the sound unmuted.
       *
       * Chromium refuses unmuted playback before any user gesture, and a
       * background is by definition running before one. The floating audio
       * button also calls the same unlock, so a user who sees the hint has an
       * obvious thing to press.
       */
      const unlock = React.useCallback(() => {
        gestureBound.current = true
        setAwaitingGesture(false)
        if (plan.carrier === 'video') {
          const node = videoRef.current
          if (node !== null && node !== undefined) {
            node.muted = false
            node.volume = session.settings.audioVolume
            const again = node.play()
            if (again !== undefined && typeof again.catch === 'function') again.catch(() => {})
          }
        } else if (plan.carrier === 'audio') {
          const node = audioRef.current
          if (node !== null && node !== undefined) {
            node.muted = false
            node.currentTime = 0
            const again = node.play()
            if (again !== undefined && typeof again.catch === 'function') again.catch(() => {})
          }
        }
        setPlaying(true)
      }, [plan, session.settings])

      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (!awaitingGesture || gestureBound.current) return undefined
        const onGesture = () => unlock()
        window.addEventListener('pointerdown', onGesture, true)
        window.addEventListener('keydown', onGesture, true)
        return () => {
          window.removeEventListener('pointerdown', onGesture, true)
          window.removeEventListener('keydown', onGesture, true)
        }
      }, [session, awaitingGesture, unlock])

      /**
       * Push the palette onto the scope's host element.
       *
       * `fullscreen` restyles the whole frame; `chat` restyles only the
       * conversation column, so the sidebar keeps the theme the user chose.
       */
      /** The scene + visible theme both palettes derive from. */
      const sceneState = React.useMemo(() => {
        if (session.phase !== 'ready') return null
        const settings = session.settings
        const auto = settings.themeAuto === true
        const visibleTheme = auto ? themeColor : settings.themeColor
        // The eased dominant only feeds the scene while auto is ON: turning it
        // off must fall back to the manual theme, not freeze on the last frame
        // the video happened to show.
        const sceneRgb = parseColor(auto && dominant !== null ? dominant : visibleTheme) || [16, 18, 26]
        const themeRgb = parseColor(visibleTheme) || [111, 134, 255]
        // What the pixels actually look like: dominant pushed dark by `dim`,
        // then toward the theme tint by its strength.
        const scene = lerpColor(lerpColor(sceneRgb, [0, 0, 0], settings.dim), themeRgb, settings.themeStrength * 0.6)
        return { scene, visibleTheme }
      }, [session, themeColor, dominant])

      const palette = React.useMemo(() => {
        if (sceneState === null) return null
        const settings = session.settings
        return autoPalette({
          scene: sceneState.scene,
          themeColor: sceneState.visibleTheme,
          overrides: {
            uiText: settings.uiText,
            uiUserText: settings.uiUserText,
            uiAssistantText: settings.uiAssistantText,
            uiAccent: settings.uiAccent,
            uiSurface: settings.uiSurface,
            uiBubble: settings.uiBubble,
            uiCodeBlock: settings.uiCodeBlock,
            uiCodeText: settings.uiCodeText,
            uiButton: settings.uiButton,
            uiButtonText: settings.uiButtonText,
            uiInlineCode: settings.uiInlineCode,
            uiInlineCodeText: settings.uiInlineCodeText,
          },
          surfaceAlpha: settings.uiSurfaceAlpha,
        })
      }, [sceneState, session])

      /**
       * The palette for the opaque chrome (sidebar etc.) in chat scope.
       *
       * Independent of the manual chat overrides on purpose: those describe
       * the chat column; the chrome follows the automatic derivation so it can
       * never be washed out by a bright custom chat colour.
       */
      const chrome = React.useMemo(() => {
        if (sceneState === null) return null
        return chromePalette({ scene: sceneState.scene, themeColor: sceneState.visibleTheme })
      }, [sceneState])

      React.useEffect(() => {
        if (session.phase !== 'ready' || palette === null) return undefined
        const overlay = document.querySelector('[data-shell-overlay]')
        const frame = overlay !== null ? overlay.parentElement : null
        if (frame === null) return undefined
        const chatScope = session.settings.scope === 'chat'
        const host = chatScope ? findChatColumn(frame) : frame
        applyTokens(host, palette, session.settings.uiSurfaceAlpha)
        // Chat scope: the columns around the video stay SOLID, so they get
        // their own derived palette on the frame (v0.8) — the sidebar, its
        // text, its buttons and its panels now follow the video's theme too.
        // The chat column's own inline tokens keep winning inside it, so the
        // composer + and 回到底部 still take the chat palette while the
        // sidebar takes the chrome palette. No button-token "lift" is needed
        // any more: the chrome set is self-consistent (its fill is readable
        // under the chrome ink by construction), and lifting chat-palette
        // buttons over it would break that pairing.
        if (chatScope && chrome !== null) applyChromeTokens(frame, chrome)
        // Publish the live palette so the settings page can hand a user the
        // DERIVED colour when they un-tick a role's "auto", instead of a
        // placeholder.
        try {
          globalThis.__DSH_CHAT_BG_PALETTE__ = palette
        } catch { /* a frozen globalThis is not worth failing a boot over */ }
        return () => {
          // A palette change or unmount must not leave stale tokens behind:
          // without this, switching `chat` → `fullscreen` would keep the column's
          // old inline values winning over the frame's new ones.
          removeTokens(host)
          if (chatScope) clearChromeTokens(frame)
        }
      }, [session, palette, chrome])

      if (session.phase === 'loading') {
        return topLayer(React.createElement('div', {
          'aria-hidden': true,
          style: { position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' },
        }))
      }

      const settings = session.settings
      const media = session.video
      const regions = Array.isArray(settings.regions) ? settings.regions : []
      const visible = settings.themeAuto === true ? themeColor : settings.themeColor

      // `chat` scope follows the conversation column's rect; `fullscreen` or a
      // rect not yet measured covers the viewport.
      const containerStyle = rect !== null && settings.scope === 'chat'
        ? {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: -1,
          pointerEvents: 'none',
          overflow: 'hidden',
          isolation: 'isolate',
          transition: 'left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease',
        }
        : {
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          pointerEvents: 'none',
          overflow: 'hidden',
          isolation: 'isolate',
        }

      const layers = []

      if (media.kind === 'video') {
        layers.push(React.createElement('video', {
          key: 'video',
          ref: videoRef,
          src: media.url,
          muted: plan.videoMuted || plan.carrier === 'none' || awaitingGesture,
          playsInline: true,
          autoPlay: true,
          loop: true,
          preload: 'auto',
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            opacity: settings.opacity,
            filter: settings.blur > 0 ? `blur(${settings.blur}px)` : undefined,
            transform: settings.scale !== 1 ? `scale(${settings.scale})` : undefined,
            transformOrigin: 'center center',
            transition: 'opacity 0.3s ease, filter 0.3s ease, transform 0.3s ease',
            willChange: 'opacity, filter, transform',
          },
        }))
      } else if (media.kind === 'image') {
        layers.push(React.createElement('img', {
          key: 'video',
          ref: videoRef,
          src: media.url,
          alt: '',
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            opacity: settings.opacity,
            filter: settings.blur > 0 ? `blur(${settings.blur}px)` : undefined,
            transform: settings.scale !== 1 ? `scale(${settings.scale})` : undefined,
            transformOrigin: 'center center',
            transition: 'opacity 0.3s ease, filter 0.3s ease, transform 0.3s ease',
          },
        }))
      }

      // The custom sound file, when the plan says it carries the audio. Hidden.
      if (plan.carrier === 'audio') {
        layers.push(React.createElement('audio', {
          key: 'sound',
          ref: audioRef,
          src: session.audio.url,
          loop: settings.audioLoop,
          preload: 'auto',
          style: { display: 'none' },
        }))
      }

      // One layer per region, each blending with the video independently.
      regions.forEach((region, index) => {
        if (region.strength <= 0) return
        layers.push(React.createElement('div', {
          key: `region-${region.id}-${index}`,
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            background: regionBackground(region),
            opacity: region.strength,
            mixBlendMode: region.blend,
            pointerEvents: 'none',
          },
        }))
      })

      // The theme tint, on top of the regions.
      if (settings.themeStrength > 0) {
        layers.push(React.createElement('div', {
          key: 'theme',
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            background: visible,
            opacity: settings.themeStrength,
            mixBlendMode: settings.themeBlend,
            pointerEvents: 'none',
            // The eased source already moves per-frame; this only smooths the
            // one-off jump when a manual theme colour is saved. Long enough to
            // read as a fade, short enough not to lag the eased value.
            transition: 'background 0.4s ease, opacity 0.3s ease',
          },
        }))
      }

      // The dim, on top of everything, for readability.
      if (settings.dim > 0) {
        layers.push(React.createElement('div', {
          key: 'dim',
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            background: '#000000',
            opacity: settings.dim,
            pointerEvents: 'none',
          },
        }))
      }

      /**
       * The floating audio button. It is the one interactive part of the
       * background: pointer-events are re-enabled on it alone. It unlocks a
       * refused autoplay, toggles play/pause, and hints when the source is
       * unavailable.
       */
      if (settings.audioSource !== 'none') {
        const unavailable = plan.carrier === 'none'
        const accent = palette !== null ? palette.accent : visible
        const surface = palette !== null ? palette.surface : 'rgba(0,0,0,0.55)'
        const label = unavailable
          ? '♪⚠'
          : awaitingGesture
            ? '♪!'
            : playing
              ? '♪'
              : '♪▶'
        layers.push(React.createElement('button', {
          key: 'audio-button',
          type: 'button',
          title: unavailable ? t.audioUnavailable : t.audioButtonTip,
          'aria-label': t.audioButtonTip,
          onClick: () => {
            if (unavailable) return
            if (awaitingGesture) {
              unlock()
              return
            }
            const node = plan.carrier === 'video' ? videoRef.current : audioRef.current
            if (node === null || node === undefined) return
            if (playing) {
              try {
                node.pause()
              } catch { /* already paused */ }
              setPlaying(false)
            } else {
              node.muted = false
              const again = node.play()
              if (again !== undefined && typeof again.catch === 'function') again.catch(() => {
                node.muted = true
                const retry = node.play()
                if (retry !== undefined && typeof retry.catch === 'function') retry.catch(() => {})
                setAwaitingGesture(true)
              })
              setPlaying(true)
            }
          },
          style: {
            position: 'absolute',
            right: '12px',
            bottom: '12px',
            pointerEvents: 'auto',
            width: '34px',
            height: '34px',
            borderRadius: '999px',
            border: `1px solid ${accent}`,
            background: surface,
            color: accent,
            font: 'inherit',
            fontSize: '14px',
            lineHeight: '32px',
            cursor: unavailable ? 'default' : 'pointer',
            opacity: awaitingGesture ? 1 : 0.75,
            boxShadow: awaitingGesture ? `0 0 0 3px color-mix(in srgb, ${accent} 35%, transparent)` : 'none',
            transition: 'opacity 0.2s ease, box-shadow 0.2s ease',
          },
        }, label))
      }

      return topLayer(React.createElement('div', {
        style: containerStyle,
        'data-dsh-chat-background': '',
      }, layers))
    }

    /** Shared field styling for the settings page. */
    const FIELD = {
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
      height: '34px',
      padding: '0 12px',
      border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #17181a)',
      font: 'inherit',
      fontSize: '13px',
    }

    /** @param options - label text, click handler, and emphasis. */
    function button(options) {
      return React.createElement('button', {
        type: 'button',
        onClick: options.onClick,
        disabled: options.disabled === true,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: 1.5,
          borderRadius: '8px',
          padding: '5px 14px',
          cursor: options.disabled === true ? 'default' : 'pointer',
          opacity: options.disabled === true ? 0.4 : 1,
          border: options.primary === true ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, #d3d5da)',
          background: options.primary === true ? 'var(--dsw-alias-label-primary, #17181a)' : 'transparent',
          color: options.primary === true ? 'var(--dsw-alias-bg-layer-3, #ffffff)' : 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, options.label)
    }

    /** A labelled numeric slider. */
    function slider(options) {
      return React.createElement('label', {
        key: options.key,
        style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, [
        React.createElement('span', { key: 'label', style: { minWidth: '72px' } }, options.label),
        React.createElement('input', {
          key: 'range',
          type: 'range',
          min: options.min,
          max: options.max,
          step: options.step,
          value: options.value,
          disabled: options.disabled,
          onChange: (event) => options.onChange(Number(event.target.value)),
          style: { flex: 1 },
        }),
        React.createElement('span', {
          key: 'value',
          style: { minWidth: '46px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
        }, options.format ? options.format(options.value) : String(options.value)),
      ])
    }

    /**
     * The settings page: choose the video and tune the blending.
     * @returns the settings page element.
     */
    function ChatBackgroundSettings() {
      const t = strings()
      const [draft, setDraft] = React.useState('')
      const [audioDraft, setAudioDraft] = React.useState('')
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)
      // Tuning values live in one draft object so a single Save writes them all.
      const [tuning, setTuning] = React.useState(null)
      const [regions, setRegions] = React.useState([])

      /** @returns the tuning object extracted from one settings payload. */
      const tuningOf = (s) => ({
        scope: s.scope,
        opacity: s.opacity,
        fit: s.fit,
        blur: s.blur,
        dim: s.dim,
        scale: s.scale,
        speed: s.speed,
        themeAuto: s.themeAuto,
        themeColor: s.themeColor,
        themeStrength: s.themeStrength,
        themeBlend: s.themeBlend,
        audioSource: s.audioSource,
        audioVolume: s.audioVolume,
        audioLoop: s.audioLoop,
        uiText: s.uiText,
        uiUserText: s.uiUserText,
        uiAssistantText: s.uiAssistantText,
        uiAccent: s.uiAccent,
        uiSurface: s.uiSurface,
        uiBubble: s.uiBubble,
        uiCodeBlock: s.uiCodeBlock,
        uiCodeText: s.uiCodeText,
        uiButton: s.uiButton,
        uiButtonText: s.uiButtonText,
        uiInlineCode: s.uiInlineCode,
        uiInlineCodeText: s.uiInlineCodeText,
        uiSurfaceAlpha: s.uiSurfaceAlpha,
      })

      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          const s = { ...FALLBACK, ...((result && result.settings) || {}) }
          setTuning(tuningOf(s))
          setRegions(Array.isArray(s.regions) ? s.regions.map((r) => ({ ...r })) : [])
          setDraft(typeof result?.effectiveSrc === 'string' && result.effectiveSrc !== ''
            ? result.effectiveSrc
            : (typeof s.src === 'string' ? s.src : ''))
          setAudioDraft(typeof result?.effectiveAudioSrc === 'string' && result.effectiveAudioSrc !== ''
            ? result.effectiveAudioSrc
            : (typeof s.audio === 'string' ? s.audio : ''))
          setState({
            status: 'ready',
            video: (result && result.video) || { kind: 'none' },
            videoSource: (result && result.videoSource) || null,
            videoProblem: (result && result.videoProblem) || null,
            audio: (result && result.audio) || { kind: 'none' },
            audioProblem: (result && result.audioProblem) ?? null,
            soundSource: (result && result.soundSource) || 'none',
          })
        })
        return () => {
          cancelled = true
        }
      }, [])

      /** @returns the server's answer, or a normalized failure. */
      const post = async (url, body) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          if (!response.ok) return { ok: false, error: `http-${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) }
        }
      }

      /**
       * Ask the Host to open a native dialog.
       * @param slot - `video` or `audio`; decides which field receives the path.
       */
      const choose = async (slot) => {
        setBusy(true)
        setState((previous) => ({ ...previous, status: 'picking' }))
        const result = await post(PICK_URL, { slot })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({
            ...previous,
            status: 'ready',
            videoProblem: result.error === 'picker-unavailable' ? 'picker-unavailable' : 'load-failed',
          }))
          return
        }
        if (typeof result.path === 'string' && result.path.trim() !== '') {
          if (slot === 'audio') setAudioDraft(result.path)
          else setDraft(result.path)
          setState((previous) => ({ ...previous, status: 'ready', videoProblem: null, audioProblem: null }))
        } else {
          setState((previous) => ({ ...previous, status: 'ready' }))
        }
      }

      /** Build the payload from the current drafts. */
      const buildPayload = () => ({
        src: draft,
        audio: audioDraft,
        ...(tuning === null ? {} : tuning),
        regions,
      })

      /** Refresh every draft from a save response. */
      const absorb = (result) => {
        const s = { ...FALLBACK, ...((result && result.settings) || {}) }
        setTuning(tuningOf(s))
        setRegions(Array.isArray(s.regions) ? s.regions.map((r) => ({ ...r })) : [])
        setState({
          status: 'ready',
          video: result.video || { kind: 'none' },
          videoSource: result.videoSource || null,
          videoProblem: result.videoProblem ?? null,
          audio: result.audio || { kind: 'none' },
          audioProblem: result.audioProblem ?? null,
          soundSource: result.soundSource || null,
        })
      }

      const save = async (value) => {
        const next = value === undefined ? draft : value
        setBusy(true)
        const result = await post(SAVE_URL, buildPayload())
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', videoProblem: 'load-failed' }))
          return
        }
        if (value !== undefined) setDraft(value)
        absorb(result)
        setState((previous) => ({ ...previous, notice: next === '' ? t.cleared : t.saved }))
      }

      /** Save only the audio fields (used by the audio-only quick actions). */
      const saveAudio = async () => {
        setBusy(true)
        const result = await post(SAVE_URL, {
          audio: audioDraft,
          ...(tuning === null ? {} : tuning),
        })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', audioProblem: 'load-failed' }))
          return
        }
        absorb(result)
        setState((previous) => ({ ...previous, notice: t.saved }))
      }

      const updateRegion = (index, patch) => {
        setRegions((previous) => previous.map((region, i) => (i === index ? { ...region, ...patch } : region)))
      }

      const addRegion = () => {
        setRegions((previous) => [
          ...previous,
          {
            id: `region-${previous.length + 1}`,
            shape: 'radial',
            anchor: { x: 0.5, y: 0.5 },
            size: 0.6,
            strength: 0.5,
            color: tuning === null ? FALLBACK.themeColor : tuning.themeColor,
            blend: 'soft-light',
            gradient: true,
            invert: false,
          },
        ])
      }

      const removeRegion = (index) => {
        setRegions((previous) => previous.filter((_, i) => i !== index))
      }

      const problemText = state.videoProblem === 'picker-unavailable'
        ? t.pickerUnavailable
        : (state.videoProblem !== null && state.videoProblem !== undefined ? (t.problem[state.videoProblem] ?? null) : null)
      const video = state.video || { kind: 'none' }
      const active = video.kind !== 'none'

      const rows = []
      rows.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 14px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, t.intro))

      // ---- scope ----------------------------------------------------------
      if (tuning !== null) {
        rows.push(React.createElement('div', {
          key: 'scope',
          style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
        }, [
          React.createElement('span', { key: 'label', style: { minWidth: '72px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' } }, t.scopeLabel),
          React.createElement('select', {
            key: 'select',
            value: tuning.scope,
            disabled: busy,
            onChange: (event) => setTuning((p) => ({ ...p, scope: event.target.value })),
            style: { flex: 1, height: '34px', padding: '0 12px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #17181a)', font: 'inherit', fontSize: '13px' },
          }, [
            React.createElement('option', { key: 'fullscreen', value: 'fullscreen' }, t.scopeFullscreen),
            React.createElement('option', { key: 'chat', value: 'chat' }, t.scopeChat),
          ]),
        ]))
      }

      rows.push(React.createElement('label', {
        key: 'video',
        style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' },
      }, [
        React.createElement('span', { key: 'label' }, t.videoLabel),
        React.createElement('div', { key: 'row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
          React.createElement('input', {
            key: 'input',
            type: 'text',
            value: draft,
            spellCheck: false,
            placeholder: t.videoPlaceholder,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void save()
            },
            style: FIELD,
          }),
          button({ label: t.choose, onClick: () => void choose('video'), disabled: busy }),
        ]),
      ]))

      rows.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' },
      }, [
        button({ key: 'save', label: t.save, onClick: () => void save(), disabled: busy, primary: true }),
        button({ key: 'clear', label: t.clear, onClick: () => void save(''), disabled: busy || draft === '' }),
      ]))

      if (state.status === 'picking') {
        rows.push(React.createElement('p', {
          key: 'picking',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
        }, t.picking))
      }

      if (state.notice !== undefined) {
        rows.push(React.createElement('p', {
          key: 'notice',
          role: 'status',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-success-primary, #22c55e)' },
        }, state.notice))
      }

      if (problemText !== null) {
        rows.push(React.createElement('p', {
          key: 'problem',
          role: 'alert',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, problemText))
      }

      // ---- tuning ---------------------------------------------------------
      if (tuning !== null) {
        rows.push(React.createElement('div', {
          key: 'tuning',
          style: { marginTop: '18px', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '12px' },
        }, [
          slider({
            key: 'opacity',
            label: t.opacity,
            min: 0,
            max: 1,
            step: 0.05,
            value: tuning.opacity,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, opacity: v })),
            format: (v) => `${Math.round(v * 100)}%`,
          }),
          slider({
            key: 'blur',
            label: t.blur,
            min: 0,
            max: 20,
            step: 1,
            value: tuning.blur,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, blur: v })),
            format: (v) => `${v}px`,
          }),
          slider({
            key: 'dim',
            label: t.dim,
            min: 0,
            max: 1,
            step: 0.05,
            value: tuning.dim,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, dim: v })),
            format: (v) => `${Math.round(v * 100)}%`,
          }),
          slider({
            key: 'scale',
            label: t.scale,
            min: 0.5,
            max: 3,
            step: 0.1,
            value: tuning.scale,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, scale: v })),
            format: (v) => `${v.toFixed(1)}×`,
          }),
          slider({
            key: 'speed',
            label: t.speed,
            min: 0.1,
            max: 3,
            step: 0.1,
            value: tuning.speed,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, speed: v })),
            format: (v) => `${v.toFixed(1)}×`,
          }),
          React.createElement('div', {
            key: 'fit',
            style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'label', style: { minWidth: '72px' } }, t.fit),
            React.createElement('select', {
              key: 'select',
              value: tuning.fit,
              disabled: busy,
              onChange: (event) => setTuning((p) => ({ ...p, fit: event.target.value })),
              style: { flex: 1, height: '34px', padding: '0 12px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #17181a)', font: 'inherit', fontSize: '13px' },
            }, [
              React.createElement('option', { key: 'cover', value: 'cover' }, t.fitCover),
              React.createElement('option', { key: 'contain', value: 'contain' }, t.fitContain),
              React.createElement('option', { key: 'fill', value: 'fill' }, t.fitFill),
            ]),
          ]),
        ]))
      }

      // ---- theme ---------------------------------------------------------
      if (tuning !== null) {
        rows.push(React.createElement('div', {
          key: 'theme',
          style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '12px' },
        }, [
          React.createElement('div', {
            key: 'theme-head',
            style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)' },
          }, t.themeAuto),
          React.createElement('p', {
            key: 'theme-hint',
            style: { margin: '0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #8b9098)' },
          }, t.themeAutoHint),
          React.createElement('label', {
            key: 'theme-auto',
            style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)', cursor: 'pointer' },
          }, [
            React.createElement('input', {
              key: 'checkbox',
              type: 'checkbox',
              checked: tuning.themeAuto,
              disabled: busy,
              onChange: (event) => setTuning((p) => ({ ...p, themeAuto: event.target.checked })),
              style: { margin: 0 },
            }),
            React.createElement('span', { key: 'text' }, t.themeAuto),
          ]),
          slider({
            key: 'theme-strength',
            label: t.themeStrength,
            min: 0,
            max: 1,
            step: 0.05,
            value: tuning.themeStrength,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, themeStrength: v })),
            format: (v) => `${Math.round(v * 100)}%`,
          }),
          React.createElement('div', {
            key: 'theme-color',
            style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'label', style: { minWidth: '72px' } }, t.themeColor),
            React.createElement('input', {
              key: 'color',
              type: 'color',
              value: tuning.themeColor,
              disabled: busy || tuning.themeAuto === true,
              onChange: (event) => setTuning((p) => ({ ...p, themeColor: event.target.value })),
              style: { width: '44px', height: '30px', padding: 0, border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '8px', background: 'transparent', cursor: 'pointer' },
            }),
            React.createElement('input', {
              key: 'hex',
              type: 'text',
              value: tuning.themeColor,
              spellCheck: false,
              disabled: busy || tuning.themeAuto === true,
              onChange: (event) => setTuning((p) => ({ ...p, themeColor: event.target.value })),
              style: { flex: 1, ...FIELD, height: '30px' },
            }),
          ]),
          React.createElement('div', {
            key: 'theme-blend',
            style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'label', style: { minWidth: '72px' } }, t.themeBlend),
            React.createElement('select', {
              key: 'select',
              value: tuning.themeBlend,
              disabled: busy,
              onChange: (event) => setTuning((p) => ({ ...p, themeBlend: event.target.value })),
              style: { flex: 1, height: '34px', padding: '0 12px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #17181a)', font: 'inherit', fontSize: '13px' },
            }, [
              React.createElement('option', { key: 'soft-light', value: 'soft-light' }, 'Soft light'),
              React.createElement('option', { key: 'overlay', value: 'overlay' }, 'Overlay'),
              React.createElement('option', { key: 'multiply', value: 'multiply' }, 'Multiply'),
              React.createElement('option', { key: 'screen', value: 'screen' }, 'Screen'),
              React.createElement('option', { key: 'hard-light', value: 'hard-light' }, 'Hard light'),
              React.createElement('option', { key: 'color-dodge', value: 'color-dodge' }, 'Color dodge'),
              React.createElement('option', { key: 'color-burn', value: 'color-burn' }, 'Color burn'),
              React.createElement('option', { key: 'difference', value: 'difference' }, 'Difference'),
              React.createElement('option', { key: 'exclusion', value: 'exclusion' }, 'Exclusion'),
              React.createElement('option', { key: 'normal', value: 'normal' }, 'Normal'),
            ]),
          ]),
        ]))
      }

      // ---- audio ----------------------------------------------------------
      if (tuning !== null) {
        const AUDIO_SOURCES = [['none', t.audioNone], ['video', t.audioVideo], ['custom', t.audioCustom]]
        const soundRow = []
        if (state.soundSource === 'video-fallback') {
          soundRow.push(React.createElement('p', {
            key: 'fallback',
            role: 'status',
            style: { margin: '8px 0 0', fontSize: '12px', color: 'var(--dsw-alias-state-warning-primary, #d97706)' },
          }, t.audioUnavailable))
        }
        rows.push(React.createElement('div', {
          key: 'audio',
          style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '12px' },
        }, [
          React.createElement('div', {
            key: 'audio-head',
            style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)' },
          }, t.audioLabel),
          React.createElement('div', {
            key: 'audio-source',
            style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'label', style: { minWidth: '72px' } }, t.audioSourceLabel),
            React.createElement('select', {
              key: 'select',
              value: tuning.audioSource,
              disabled: busy,
              onChange: (event) => setTuning((p) => ({ ...p, audioSource: event.target.value })),
              style: { flex: 1, height: '34px', padding: '0 12px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #17181a)', font: 'inherit', fontSize: '13px' },
            }, AUDIO_SOURCES.map(([value, label]) => React.createElement('option', { key: value, value }, label))),
          ]),
          tuning.audioSource === 'custom'
            ? React.createElement('div', {
                key: 'audio-file',
                style: { display: 'flex', gap: '8px', alignItems: 'center' },
              }, [
                React.createElement('input', {
                  key: 'input',
                  type: 'text',
                  value: audioDraft,
                  spellCheck: false,
                  placeholder: t.audioFilePlaceholder,
                  disabled: busy,
                  onChange: (event) => setAudioDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void saveAudio()
                  },
                  style: FIELD,
                }),
                button({ key: 'pick', label: t.choose, onClick: () => void choose('audio'), disabled: busy }),
              ])
            : null,
          slider({
            key: 'audio-volume',
            label: t.audioVolume,
            min: 0,
            max: 1,
            step: 0.05,
            value: tuning.audioVolume,
            disabled: busy || tuning.audioSource === 'none',
            onChange: (v) => setTuning((p) => ({ ...p, audioVolume: v })),
            format: (v) => `${Math.round(v * 100)}%`,
          }),
          React.createElement('label', {
            key: 'audio-loop',
            style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)', cursor: 'pointer' },
          }, [
            React.createElement('input', {
              key: 'checkbox',
              type: 'checkbox',
              checked: tuning.audioLoop,
              disabled: busy || tuning.audioSource !== 'custom',
              onChange: (event) => setTuning((p) => ({ ...p, audioLoop: event.target.checked })),
              style: { margin: 0 },
            }),
            React.createElement('span', { key: 'text' }, t.audioLoop),
          ]),
          ...soundRow,
        ]))
      }

      // ---- UI colour adaptation ------------------------------------------
      if (tuning !== null) {
        // The background component publishes the live derived palette here;
        // un-ticking a role's "auto" seeds the editor with THAT colour — what
        // the user is seeing — instead of a meaningless placeholder.
        const roleKey = { uiText: 'text', uiUserText: 'userText', uiAssistantText: 'assistantText', uiAccent: 'accent', uiSurface: 'surface', uiBubble: 'bubble', uiCodeBlock: 'codeBlock', uiCodeText: 'codeText', uiButton: 'button', uiButtonText: 'buttonText', uiInlineCode: 'inlineCode', uiInlineCodeText: 'inlineCodeText' }
        const livePalette = (() => {
          try {
            return globalThis.__DSH_CHAT_BG_PALETTE__ || null
          } catch {
            return null
          }
        })()
        const colorRole = (key, label) => {
          const value = tuning[key]
          const isAuto = value === 'auto'
          const fallback = (livePalette !== null && typeof livePalette[roleKey[key]] === 'string')
            ? livePalette[roleKey[key]]
            : (key === 'uiSurface' || key === 'uiBubble' ? '#20242e' : '#e8eaf0')
          const shown = isAuto ? fallback : (/^#[0-9a-f]{6}$/i.test(value) ? value : `#${value.replace(/^#/, '').padEnd(6, '0').slice(0, 6)}`)
          return React.createElement('div', {
            key,
            style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'label', style: { minWidth: '150px' } }, label),
            React.createElement('label', {
              key: 'auto',
              style: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' },
            }, [
              React.createElement('input', {
                key: 'radio',
                type: 'checkbox',
                checked: isAuto,
                disabled: busy,
                onChange: (event) => setTuning((p) => ({ ...p, [key]: event.target.checked ? 'auto' : shown })),
                style: { margin: 0 },
              }),
              React.createElement('span', { key: 'text' }, t.uiAuto),
            ]),
            React.createElement('input', {
              key: 'swatch',
              type: 'color',
              value: shown,
              disabled: busy || isAuto,
              onChange: (event) => setTuning((p) => ({ ...p, [key]: event.target.value })),
              style: { width: '40px', height: '28px', padding: 0, border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '8px', background: 'transparent', cursor: isAuto ? 'default' : 'pointer', opacity: isAuto ? 0.4 : 1 },
            }),
            React.createElement('input', {
              key: 'hex',
              type: 'text',
              value: isAuto ? 'auto' : value,
              spellCheck: false,
              disabled: busy || isAuto,
              onChange: (event) => setTuning((p) => ({ ...p, [key]: event.target.value })),
              style: { width: '96px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
          ])
        }
        rows.push(React.createElement('div', {
          key: 'ui',
          style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '12px' },
        }, [
          React.createElement('div', {
            key: 'ui-head',
            style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)' },
          }, t.uiLabel),
          React.createElement('p', {
            key: 'ui-hint',
            style: { margin: '0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #8b9098)' },
          }, t.uiHint),
          colorRole('uiText', t.uiText),
          colorRole('uiUserText', t.uiUserText),
          colorRole('uiAssistantText', t.uiAssistantText),
          colorRole('uiBubble', t.uiBubble),
          colorRole('uiCodeBlock', t.uiCodeBlock),
          colorRole('uiCodeText', t.uiCodeText),
          colorRole('uiInlineCode', t.uiInlineCode),
          colorRole('uiInlineCodeText', t.uiInlineCodeText),
          colorRole('uiButton', t.uiButton),
          colorRole('uiButtonText', t.uiButtonText),
          colorRole('uiAccent', t.uiAccent),
          colorRole('uiSurface', t.uiSurface),
          slider({
            key: 'ui-alpha',
            label: t.uiAlpha,
            min: 0,
            max: 1,
            step: 0.05,
            value: tuning.uiSurfaceAlpha,
            disabled: busy,
            onChange: (v) => setTuning((p) => ({ ...p, uiSurfaceAlpha: v })),
            format: (v) => `${Math.round(v * 100)}%`,
          }),
        ]))
      }

      // ---- regions ------------------------------------------------------
      rows.push(React.createElement('div', {
        key: 'regions',
        style: { marginTop: '16px', padding: '12px 14px', border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '12px' },
      }, [
        React.createElement('div', {
          key: 'head',
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px' },
        }, [
          React.createElement('div', { key: 'title', style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)' } }, t.regions),
          button({ key: 'add', label: t.addRegion, onClick: addRegion, disabled: busy }),
        ]),
        React.createElement('p', {
          key: 'hint',
          style: { margin: '0 0 10px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #8b9098)' },
        }, t.regionsHint),
        regions.length === 0
          ? React.createElement('p', {
              key: 'empty',
              style: { margin: '0', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #8b9098)' },
            }, t.regionEmpty)
          : null,
        regions.map((region, index) => React.createElement('div', {
          key: region.id,
          style: { marginBottom: '10px', padding: '10px', border: '0.5px solid var(--dsw-alias-border-l3, #e4e4e7)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-2, #f1f2f4)' },
        }, [
          React.createElement('div', {
            key: 'row1',
            style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' },
          }, [
            React.createElement('input', {
              key: 'id',
              type: 'text',
              value: region.id,
              disabled: busy,
              onChange: (event) => updateRegion(index, { id: event.target.value }),
              style: { flex: 1, ...FIELD, height: '30px', fontSize: '12px' },
            }),
            React.createElement('select', {
              key: 'shape',
              value: region.shape,
              disabled: busy,
              onChange: (event) => updateRegion(index, { shape: event.target.value }),
              style: { ...FIELD, height: '30px', width: '110px', fontSize: '12px' },
            }, [
              React.createElement('option', { key: 'radial', value: 'radial' }, t.shapeRadial),
              React.createElement('option', { key: 'linear', value: 'linear' }, t.shapeLinear),
            ]),
            button({ key: 'remove', label: t.removeRegion, onClick: () => removeRegion(index), disabled: busy }),
          ]),
          React.createElement('div', {
            key: 'row2',
            style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'anchor-label', style: { minWidth: '52px' } }, t.regionAnchor),
            React.createElement('input', {
              key: 'ax',
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              value: region.anchor.x,
              disabled: busy,
              onChange: (event) => updateRegion(index, { anchor: { x: Number(event.target.value), y: region.anchor.y } }),
              style: { width: '64px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
            React.createElement('input', {
              key: 'ay',
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              value: region.anchor.y,
              disabled: busy,
              onChange: (event) => updateRegion(index, { anchor: { x: region.anchor.x, y: Number(event.target.value) } }),
              style: { width: '64px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
            React.createElement('span', { key: 'size-label', style: { minWidth: '52px' } }, t.regionSize),
            React.createElement('input', {
              key: 'size',
              type: 'number',
              min: 0.05,
              max: 4,
              step: 0.05,
              value: region.size,
              disabled: busy,
              onChange: (event) => updateRegion(index, { size: Number(event.target.value) }),
              style: { width: '64px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
            React.createElement('span', { key: 'strength-label', style: { minWidth: '52px' } }, t.regionStrength),
            React.createElement('input', {
              key: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              value: region.strength,
              disabled: busy,
              onChange: (event) => updateRegion(index, { strength: Number(event.target.value) }),
              style: { width: '64px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
          ]),
          React.createElement('div', {
            key: 'row3',
            style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #5c6068)' },
          }, [
            React.createElement('span', { key: 'color-label', style: { minWidth: '52px' } }, t.regionColor),
            React.createElement('input', {
              key: 'color',
              type: 'color',
              value: region.color,
              disabled: busy,
              onChange: (event) => updateRegion(index, { color: event.target.value }),
              style: { width: '40px', height: '28px', padding: 0, border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)', borderRadius: '8px', background: 'transparent', cursor: 'pointer' },
            }),
            React.createElement('input', {
              key: 'color-hex',
              type: 'text',
              value: region.color,
              spellCheck: false,
              disabled: busy,
              onChange: (event) => updateRegion(index, { color: event.target.value }),
              style: { width: '90px', ...FIELD, height: '28px', fontSize: '12px' },
            }),
            React.createElement('span', { key: 'blend-label', style: { minWidth: '52px' } }, t.regionBlend),
            React.createElement('select', {
              key: 'blend',
              value: region.blend,
              disabled: busy,
              onChange: (event) => updateRegion(index, { blend: event.target.value }),
              style: { ...FIELD, height: '28px', width: '120px', fontSize: '12px' },
            }, ['multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'color-dodge', 'color-burn', 'difference', 'exclusion', 'normal'].map((mode) => (
              React.createElement('option', { key: mode, value: mode }, mode)
            ))),
            React.createElement('label', {
              key: 'gradient',
              style: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' },
            }, [
              React.createElement('input', {
                key: 'checkbox',
                type: 'checkbox',
                checked: region.gradient,
                disabled: busy,
                onChange: (event) => updateRegion(index, { gradient: event.target.checked }),
                style: { margin: 0 },
              }),
              React.createElement('span', { key: 'text' }, t.regionGradient),
            ]),
            React.createElement('label', {
              key: 'invert',
              style: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' },
            }, [
              React.createElement('input', {
                key: 'checkbox',
                type: 'checkbox',
                checked: region.invert === true,
                disabled: busy,
                onChange: (event) => updateRegion(index, { invert: event.target.checked }),
                style: { margin: 0 },
              }),
              React.createElement('span', { key: 'text' }, t.regionInvert),
            ]),
          ]),
        ])),
      ]))

      rows.push(React.createElement('div', {
        key: 'summary',
        style: {
          marginTop: '16px',
          padding: '12px 14px',
          border: '0.5px solid var(--dsw-alias-border-l4, #d4d4d4)',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-2, #f1f2f4)',
          fontSize: '13px',
          lineHeight: 1.7,
          color: 'var(--dsw-alias-label-secondary, #5c6068)',
        },
      }, [
        React.createElement('div', {
          key: 'title',
          style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, #17181a)', marginBottom: '4px' },
        }, `${t.current}: ${active ? (state.videoSource === 'bundled' ? t.bundled : t.willPlay) : t.none}`),
        state.videoSource === 'bundled'
          ? React.createElement('div', { key: 'bundled', style: { marginBottom: '4px' } }, t.bundled)
          : null,
        active
          ? React.createElement('div', { key: 'file', style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' } },
              `${video.name ?? ''}${video.bytes === undefined ? '' : `  ·  ${humanBytes(video.bytes)}`}`)
          : null,
      ]))

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '760px' } }, rows)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page is always registered: it is how the video gets chosen.
        ctx.slots.inject(TAB_SLOT, () => ctx.slots.register(
          { name: TAB_SLOT, id: ROW_ID, order: 50, label: () => strings().tab },
          ChatBackgroundSettings,
        ))

        try {
          globalThis.__DSH_CHAT_BG__ = {
            regionBackground,
            sampleDominantColor,
            parseColor,
            formatColor,
            lerpColor,
            objectFit,
            humanBytes,
            luminance,
            contrastRatio,
            ensureContrast,
            autoPalette,
            uiTokensCss,
            audioPlan,
            // Shell discovery, exposed for the DOM regression test: these are
            // the exact functions the painting-order bug lives in.
            armShellWatcher,
            disarmShellWatcher,
            clearAppBackgrounds,
            findChatColumn,
            applyTokens,
            removeTokens,
            chromePalette,
            applyChromeTokens,
            clearChromeTokens,
            version: 3,
          }
        } catch { /* a frozen globalThis is not worth failing a boot over */ }

        // The background itself is registered ONLY when a video is configured,
        // decided from a SYNCHRONOUS read so it is queued before the first paint.
        const initial = payloadSync()
        const initialVideo = (initial && initial.video) || { kind: 'none' }
        const initialProblem = (initial && initial.videoProblem) || null
        if (initialVideo.kind !== 'none' && initialProblem === null) {
          ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
            { name: OVERLAY_SLOT, id: ROW_ID, order: 900 },
            ChatBackground,
          ))
        }
      },
    }
  },
})
