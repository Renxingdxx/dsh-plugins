/**
 * dsh-custom-splash — browser half.
 *
 * Hand-written client bundle in the DSH client-module form: executing this file
 * only REGISTERS a lazy factory (`window.__ModuleLoader__.load`); every module
 * body side effect lives inside the factory closure and runs at materialization.
 * No bundler is involved, which is what keeps this package installable without a
 * build script.
 *
 * Two registrations:
 *   - `shell.overlay` — the splash itself, and ONLY when there is something to
 *     show. With neither a picture nor sound configured, the plugin registers
 *     nothing here, so DSH behaves exactly as if it were not installed.
 *   - `settings.plugins.tab` — the settings page that chooses the media.
 *
 * Host endpoints (absolute, so the same strings work in the browser and under
 * Electron, where the preload bridge forwards absolute-path requests):
 *   GET  /dsh-custom-splash/config.json  effective settings + media descriptors
 *   POST /dsh-custom-splash/config       store the chosen paths / sound mode
 *   POST /dsh-custom-splash/pick         open a native file dialog
 *   GET  /dsh-custom-splash/picture/<n>  the picture bytes, Range-capable
 *   GET  /dsh-custom-splash/sound/<n>    the sound bytes, Range-capable
 *
 * The sound story, which is the reason this plugin exists:
 *   - A separate `<audio>` element carries an independent sound file; a video's
 *     own audio track is used when no separate file is configured.
 *   - Chromium refuses unmuted autoplay before a user gesture. So the client
 *     always starts the PICTURE (muted if necessary) and separately attempts the
 *     sound unmuted. When that attempt is refused it falls back to muted and, if
 *     `unlockOnGesture` is on, unmutes on the first pointer/key/touch — at which
 *     point the sound restarts from the beginning.
 *
 * @module dsh-custom-splash/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-custom-splash',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')

    /**
     * Mount splash nodes as direct children of `<body>`.
     *
     * A slot's own outlet wrapper is `display: contents`, so it adds no box — but
     * it does not remove the slot's ANCESTORS, and any ancestor that creates a
     * stacking context traps a descendant's `z-index`. Portalling to `<body>` puts
     * the splash in the root stacking context, where the number means what it
     * says. DSH's own `Menu` does the same.
     *
     * @param node - the element to place.
     * @returns the portal, or the node unchanged when there is no body yet.
     */
    function topLayer(node) {
      if (typeof document === 'undefined' || document.body === null) return node
      return createPortal(node, document.body)
    }

    /** The stacking level every splash node uses. */
    const TOP_Z = 2147483000

    /** Markers inside the Host's rules, used to find and remove the style element. */
    const COVER_MARKERS = ['dsh-custom-splash-cover', 'dsh-custom-splash-base']

    /** Guards the removal so it cannot run twice. */
    let coverReleased = false

    /**
     * Drop the Host's cover and its dark base colour, revealing the application.
     *
     * Safe to call at any time and from any branch: a no-op once released, and a
     * no-op when the Host injected nothing at all.
     */
    function releaseCover() {
      if (coverReleased || typeof document === 'undefined') return
      coverReleased = true
      try {
        const guard = globalThis.__DSH_CUSTOM_SPLASH_COVER_GUARD__
        if (guard !== undefined && guard !== null && typeof guard.clear === 'function') guard.clear()
      } catch { /* an absent guard is the normal case */ }
      try {
        const sheets = document.head ? document.head.getElementsByTagName('style') : []
        for (let i = 0; i < sheets.length; i += 1) {
          const node = sheets[i]
          const text = typeof node.textContent === 'string' ? node.textContent : ''
          if (!COVER_MARKERS.some((marker) => text.includes(marker))) continue
          if (typeof node.remove === 'function') node.remove()
          else if (node.parentNode) node.parentNode.removeChild(node)
        }
      } catch { /* revealing the application must never throw */ }
    }

    const BASE = '/dsh-custom-splash'
    const CONFIG_URL = `${BASE}/config.json`
    const SAVE_URL = `${BASE}/config`
    const PICK_URL = `${BASE}/pick`
    const OVERLAY_SLOT = 'shell.overlay'
    const TAB_SLOT = 'settings.plugins.tab'
    const ROW_ID = 'dsh-custom-splash'

    /** UI strings; the splash is the first thing a user sees, so it follows the OS language. */
    const TEXT = {
      zh: {
        tab: '自定义开屏',
        title: '自定义开屏动画',
        intro: '开屏时先播放一段画面和声音，播完淡出露出界面。声音默认开启；浏览器在用户首次操作前会拦截带声音的自动播放，所以首次点击/按键后声音才会响起。',
        pictureLabel: '画面（视频或动图）',
        picturePlaceholder: '留空使用内置动画，例如 D:\\videos\\opening.mp4',
        soundLabel: '声音',
        soundAuto: '跟随画面',
        soundFile: '使用独立声音文件',
        soundNone: '静音',
        soundPathPlaceholder: '例如 D:\\music\\opening.mp3',
        choose: '选择文件…',
        save: '保存',
        clearPicture: '清除画面',
        saved: '已保存。下次打开或刷新 DSH 时生效。',
        picking: '等待文件选择…',
        pickerUnavailable: '这个宿主没有可用的文件对话框，请直接把路径填进上面的输入框。',
        current: '当前生效',
        none: '未设置 —— 插件不介入',
        bundledPicture: '正在使用内置动画',
        bundledSound: '正在使用内置声音',
        pictureAudio: '正在使用画面自带的声音',
        soundOff: '声音已关闭',
        soundOn: '声音已开启',
        clickForSound: '点击开启声音',
        size: '大小',
        summary: '素材信息',
        skip: '跳过',
        problem: {
          'unsupported-format': '这个扩展名不在支持列表里。',
          'missing-file': '找不到这个文件。',
          'unreadable-file': '这个文件读不出来。',
          'not-a-file': '这个路径不是一个文件。',
          'file-too-large': '文件超过 4 GiB 上限。',
          'codec-unsupported': '容器能读，但里面的编码格式当前 Electron 不支持，转码成 H.264、VP9 或 MP3/WAV 即可。',
          'load-failed': '读不到插件配置。',
        },
      },
      en: {
        tab: 'Custom splash',
        title: 'Custom splash animation',
        intro: 'Plays a picture with sound on startup and fades out into the interface. Sound is on by default; browsers block unmuted autoplay before the first user gesture, so the sound starts on the first click or keypress.',
        pictureLabel: 'Picture (video or animated image)',
        picturePlaceholder: 'Leave empty for the bundled animation, e.g. D:\\videos\\opening.mp4',
        soundLabel: 'Sound',
        soundAuto: 'Follow the picture',
        soundFile: 'Use a separate sound file',
        soundNone: 'Mute',
        soundPathPlaceholder: 'e.g. D:\\music\\opening.mp3',
        choose: 'Choose file…',
        save: 'Save',
        clearPicture: 'Clear picture',
        saved: 'Saved. It takes effect the next time DSH opens or the page reloads.',
        picking: 'Waiting for the file dialog…',
        pickerUnavailable: 'This host has no file dialog available; paste the path into the field above instead.',
        current: 'Currently active',
        none: 'Not set — the plugin stays out of the way',
        bundledPicture: 'Using the bundled animation',
        bundledSound: 'Using the bundled sound',
        pictureAudio: 'Using the picture’s own sound',
        soundOff: 'Sound is off',
        soundOn: 'Sound is on',
        clickForSound: 'Click to enable sound',
        size: 'Size',
        summary: 'Media',
        skip: 'Skip',
        problem: {
          'unsupported-format': 'That extension is not in the supported list.',
          'missing-file': 'That file was not found.',
          'unreadable-file': 'That file could not be read.',
          'not-a-file': 'That path is not a file.',
          'file-too-large': 'The file exceeds the 4 GiB limit.',
          'codec-unsupported': 'The container is readable but the codec inside it is not supported by this Electron build. Transcode to H.264, VP9 or MP3/WAV.',
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
        if (!response.ok) return { settings: {}, picture: { kind: 'none' }, sound: { kind: 'none' }, pictureProblem: 'load-failed' }
        return await response.json()
      } catch {
        return { settings: {}, picture: { kind: 'none' }, sound: { kind: 'none' }, pictureProblem: 'load-failed' }
      }
    }

    /**
     * Read the same payload synchronously.
     *
     * `apply` must decide whether to mount the overlay BEFORE the shell paints,
     * and an `await` hands control back to the event loop. A synchronous XHR is
     * the only way to keep that decision inside the current task.
     * @returns the parsed payload, or a "nothing" payload.
     */
    function payloadSync() {
      try {
        const request = new XMLHttpRequest()
        request.open('GET', CONFIG_URL, false)
        request.send(null)
        if (request.status !== 200) return { settings: {}, picture: { kind: 'none' }, sound: { kind: 'none' } }
        return JSON.parse(request.responseText)
      } catch {
        return { settings: {}, picture: { kind: 'none' }, sound: { kind: 'none' } }
      }
    }

    /** Defaults mirroring the Host schema, used when a field is absent from the wire. */
    const FALLBACK = {
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

    /** @returns `value` when it is a usable number, else `fallback`. */
    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /** Headroom added to the known length before the rescue timer may fire. */
    const FALLBACK_SLACK_MS = 5000

    /** Rescue timeout when a video never reports a length at all. */
    const UNKNOWN_LENGTH_TIMEOUT_MS = 120000

    /**
     * Delay, in milliseconds, before the rescue timer may dismiss the overlay.
     * @param lengthSeconds - the media length, or `NaN`/`0` when unknown.
     * @param settings - the effective settings.
     * @returns the delay in milliseconds.
     */
    function fadeDelayFor(lengthSeconds, settings) {
      const known = typeof lengthSeconds === 'number' && Number.isFinite(lengthSeconds) && lengthSeconds > 0
      if (!known) return UNKNOWN_LENGTH_TIMEOUT_MS
      if (settings.duration > 0 && settings.duration < lengthSeconds * 1000) return settings.duration
      return lengthSeconds * 1000 + FALLBACK_SLACK_MS
    }

    /** @returns the CSS `object-fit` keyword for the `fit` setting. */
    function objectFit(fit) {
      if (fit === 'cover') return 'cover'
      if (fit === 'fill') return 'fill'
      return 'contain'
    }

    /**
     * Decide how this configuration should handle sound.
     *
     * The whole point of the plugin is that a splash can carry sound, so the
     * rules are stated once here and reused by the picture effect, the sound
     * effect and the overlay. They are also exported for the structural test.
     *
     * @param settings - the effective settings.
     * @param options - `{ separateSound, pictureKind, soundProblem }`.
     * @returns the plan: `pictureMuted`, `startSoundUnmuted`, `unlockOnGesture`.
     */
    function soundPlan(settings, options) {
      const separateSound = options.separateSound === true
      const broken = options.soundProblem !== null && options.soundProblem !== undefined
      const hasSound = !settings.muted && (separateSound || options.pictureKind === 'video') && !broken
      return {
        // A separate sound file carries the audio, so the picture is muted to
        // avoid playing the same sound twice.
        pictureMuted: settings.muted || separateSound,
        // Try the sound unmuted first; Chromium refuses before a gesture, and
        // the caller falls back from the rejection.
        startSoundUnmuted: hasSound,
        // If it was refused, wait for the first gesture to unlock it.
        unlockOnGesture: hasSound && settings.unlockOnGesture !== false,
      }
    }

    /** @returns a human-readable byte size. */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * One splash overlay.
     *
     * Lifecycle: cover → fade in → play → fade out → unmount. The fade starts
     * `fadeOutMs` after the media ends. Every path terminates: a splash that
     * cannot be dismissed would hide the application.
     * @returns the overlay element, or `null` in the frame after dismissal.
     */
    function SplashAnimation() {
      const [session, setSession] = React.useState({ phase: 'loading' })
      const [phase, setPhase] = React.useState('in')
      const [failed, setFailed] = React.useState(false)
      const [paintable, setPaintable] = React.useState(false)
      const [soundUnlocked, setSoundUnlocked] = React.useState(false)
      const [soundNotice, setSoundNotice] = React.useState(null)
      const videoRef = React.useRef(null)
      const imgRef = React.useRef(null)
      const soundRef = React.useRef(null)
      const dismissedRef = React.useRef(false)
      const gestureBoundRef = React.useRef(false)
      const t = strings()

      /** Reveal the application in the same commit that mounts the splash. */
      React.useLayoutEffect(() => {
        releaseCover()
      }, [])

      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          const settings = { ...FALLBACK, ...((result && result.settings) || {}) }
          setSession({
            phase: 'ready',
            settings,
            picture: (result && result.picture) || { kind: 'none' },
            sound: (result && result.sound) || { kind: 'none' },
            soundSource: (result && result.soundSource) || null,
            pictureProblem: (result && result.pictureProblem) || null,
            soundProblem: (result && result.soundProblem) || null,
          })
        })
        return () => {
          cancelled = true
        }
      }, [])

      /** One-way dismissal: the first caller wins, later callers are no-ops. */
      const dismiss = React.useCallback(() => {
        if (dismissedRef.current) return
        dismissedRef.current = true
        setPhase('out')
      }, [])

      /**
       * While the splash owns the screen it also owns input.
       *
       * The overlay covers the viewport, so every pointer event the user can
       * produce is aimed at it. Another plugin can claim a click by POSITION
       * rather than by target, so a capture listener on `window` handles the
       * skip marker here and stops the bubble.
       *
       * The listeners MUST come off when the splash is finished, and that is not
       * the same moment as unmounting: the console keeps this entry mounted while
       * it renders `null`, so a cleanup that only runs on unmount never runs at
       * all. The gate is therefore in the dependency list.
       */
      const capturingInput = session.phase !== 'done'
      React.useEffect(() => {
        if (!capturingInput) return undefined
        const skipMode = (session.settings && session.settings.skip) || 'button'
        const onPointer = (event) => {
          event.stopPropagation()
        }
        const onClick = (event) => {
          event.stopPropagation()
          const target = event.target
          const onSkip = target !== null && target !== undefined
            && typeof target.closest === 'function'
            && target.closest('[data-dsh-custom-splash-skip]') !== null
          if (onSkip || skipMode === 'click') dismiss()
        }
        window.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('click', onClick, true)
        return () => {
          window.removeEventListener('pointerdown', onPointer, true)
          window.removeEventListener('click', onClick, true)
        }
      }, [capturingInput, session.settings, dismiss])

      /** Keys that dismiss early. */
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (session.settings.skip === 'never' || session.settings.skip === 'auto') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            dismiss()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [session, dismiss])

      /** Auto mode: leave after a fixed time. */
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        if (session.settings.skip !== 'auto') return undefined
        const id = window.setTimeout(dismiss, Math.max(0, session.settings.skipAfterMs))
        return () => window.clearTimeout(id)
      }, [session, dismiss])

      /** Fade out, then unmount. */
      React.useEffect(() => {
        if (phase !== 'out') return undefined
        const fade = num(session.settings && session.settings.fadeOutMs, FALLBACK.fadeOutMs)
        const id = window.setTimeout(() => setSession((previous) => ({ ...previous, phase: 'done' })), fade)
        return () => window.clearTimeout(id)
      }, [phase, session.settings])

      /** Brief "sound is on" toast after an unlock. */
      React.useEffect(() => {
        if (soundNotice === null) return undefined
        const id = window.setTimeout(() => setSoundNotice(null), 1600)
        return () => window.clearTimeout(id)
      }, [soundNotice])

      /**
       * The picture: always plays, muted when its own audio is not the sound.
       *
       * A separate sound file (or the master mute) mutes the video's audio so the
       * two never double up. When the picture's own audio IS the sound, the video
       * starts unmuted and — if the browser refuses — falls back to muted and
       * waits for a gesture.
       */
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        const settings = session.settings
        const picture = session.picture
        const separateSound = session.sound.kind === 'sound'
        const plan = soundPlan(settings, {
          separateSound,
          pictureKind: picture.kind,
          soundProblem: session.soundProblem,
        })
        const timers = []
        const cleanups = []
        const after = (ms, run) => {
          const id = window.setTimeout(run, Math.max(0, ms))
          timers.push(id)
          return id
        }
        const clearAll = () => {
          for (const id of timers) window.clearTimeout(id)
        }
        const detachAll = () => {
          for (const fn of cleanups) {
            try {
              fn()
            } catch { /* a listener that is already gone */ }
          }
        }

        if (session.failed || session.pictureProblem !== null) {
          // An unplayable picture is never shown as a card over the application:
          // DSH simply appears and the settings page reports the problem.
          dismiss()
          return clearAll
        }

        let fadeTimer
        const finish = () => after(settings.holdAfterEndMs, dismiss)

        /** Unmute the picture's own audio on the first gesture. */
        const bindGesture = () => {
          if (gestureBoundRef.current || !plan.unlockOnGesture) return
          gestureBoundRef.current = true
          const unlock = () => {
            const video = videoRef.current
            if (video === null || settings.muted) return
            try {
              if (video.ended) video.currentTime = 0
              video.muted = false
              video.volume = settings.volume
              const play = video.play()
              if (play !== undefined && typeof play.catch === 'function') play.catch(() => {})
            } catch { /* the gesture already counted; a failed replay is not fatal */ }
            setSoundUnlocked(true)
            setSoundNotice(t.soundOn)
          }
          window.addEventListener('pointerdown', unlock, true)
          window.addEventListener('keydown', unlock, true)
          window.addEventListener('touchstart', unlock, true)
          cleanups.push(() => {
            window.removeEventListener('pointerdown', unlock, true)
            window.removeEventListener('keydown', unlock, true)
            window.removeEventListener('touchstart', unlock, true)
          })
        }

        if (picture.kind === 'none') {
          // Sound-only splash (or nothing): no picture carries the timeline, so
          // the duration settings decide when to leave.
          const lifetime = settings.duration > 0 ? settings.duration : Math.max(settings.waitForAppMs, 4000)
          after(lifetime, dismiss)
          return clearAll
        }

        if (picture.kind === 'image') {
          // An animated image has no `ended` event, so its length is unknowable
          // in the DOM: the duration is the only exit.
          const lifetime = settings.duration > 0 ? settings.duration : Math.max(settings.waitForAppMs, 4000)
          after(lifetime, dismiss)
          return clearAll
        }

        const video = videoRef.current
        if (video === null || video === undefined) {
          dismiss()
          return clearAll
        }

        video.playbackRate = settings.playbackRate
        video.volume = settings.volume
        // Muted when a separate sound file carries the audio, or on a master mute.
        video.muted = plan.pictureMuted

        /** Arm the backstop once the length is known. */
        const armFallback = () => {
          if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
          fadeTimer = after(fadeDelayFor(video.duration, settings), dismiss)
        }

        const onEnded = () => {
          if (settings.maxReplays > 0) {
            const replayed = Number(video.dataset.replays || '0')
            if (replayed < settings.maxReplays) {
              video.dataset.replays = String(replayed + 1)
              video.currentTime = 0
              const again = video.play()
              if (again !== undefined && typeof again.catch === 'function') again.catch(() => dismiss())
              return
            }
          }
          if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
          finish()
        }
        const onError = () => dismiss()
        const onPaintable = () => setPaintable(true)
        const onFirstUnmuted = () => {
          setSoundUnlocked(true)
        }

        video.addEventListener('loadedmetadata', armFallback)
        video.addEventListener('durationchange', armFallback)
        video.addEventListener('ended', onEnded)
        video.addEventListener('error', onError)
        video.addEventListener('loadeddata', onPaintable)
        video.addEventListener('canplay', onPaintable)

        const started = video.play()
        if (started !== undefined && typeof started.then === 'function') {
          started.then(
            () => {
              // Autoplay was allowed: the picture's own audio is already going.
              if (!plan.pictureMuted) onFirstUnmuted()
            },
            () => {
              // Autoplay refused, or the codec failed after metadata. A muted
              // retry satisfies every autoplay policy and keeps the picture on
              // screen; the sound is then unlocked by the first gesture.
              video.muted = true
              const retry = video.play()
              if (retry !== undefined && typeof retry.catch === 'function') {
                retry.catch(() => dismiss())
              }
              // Only the picture's OWN audio is unlocked by a gesture here; when a
              // separate sound file is configured it owns the audio and binds its
              // own listener.
              if (plan.unlockOnGesture && !separateSound) {
                bindGesture()
              }
            }
          )
        } else if (!plan.pictureMuted) {
          // A browser that allowed unmuted autoplay: the sound is already going.
          onFirstUnmuted()
        }

        return () => {
          clearAll()
          detachAll()
          video.removeEventListener('loadedmetadata', armFallback)
          video.removeEventListener('durationchange', armFallback)
          video.removeEventListener('ended', onEnded)
          video.removeEventListener('error', onError)
          video.removeEventListener('loadeddata', onPaintable)
          video.removeEventListener('canplay', onPaintable)
        }
      }, [session, failed, dismiss, t])

      /**
       * The separate sound file.
       *
       * Tried unmuted first. On refusal it plays muted (so a later gesture has
       * something to unmute) and binds the gesture listener. Restarting from the
       * beginning on unlock means the user hears the whole thing, not the tail.
       */
      React.useEffect(() => {
        if (session.phase !== 'ready') return undefined
        const settings = session.settings
        if (session.sound.kind !== 'sound') return undefined
        const audio = soundRef.current
        if (audio === null || audio === undefined) return undefined
        const plan = soundPlan(settings, {
          separateSound: true,
          pictureKind: session.picture.kind,
          soundProblem: session.soundProblem,
        })
        const cleanups = []
        const detachAll = () => {
          for (const fn of cleanups) {
            try {
              fn()
            } catch { /* already gone */ }
          }
        }

        const bindGesture = () => {
          if (gestureBoundRef.current || !plan.unlockOnGesture) return
          gestureBoundRef.current = true
          const unlock = () => {
            if (settings.muted) return
            try {
              if (audio.ended) audio.currentTime = 0
              audio.muted = false
              audio.volume = settings.volume
              const play = audio.play()
              if (play !== undefined && typeof play.catch === 'function') play.catch(() => {})
            } catch { /* the gesture already counted */ }
            setSoundUnlocked(true)
            setSoundNotice(t.soundOn)
          }
          window.addEventListener('pointerdown', unlock, true)
          window.addEventListener('keydown', unlock, true)
          window.addEventListener('touchstart', unlock, true)
          cleanups.push(() => {
            window.removeEventListener('pointerdown', unlock, true)
            window.removeEventListener('keydown', unlock, true)
            window.removeEventListener('touchstart', unlock, true)
          })
        }

        if (!plan.startSoundUnmuted) {
          // Muted (or the file is broken): keep it silent and leave.
          audio.muted = true
          return detachAll
        }

        audio.volume = settings.volume
        audio.muted = false
        const started = audio.play()
        if (started !== undefined && typeof started.then === 'function') {
          started.then(
            () => {
              // Allowed: the separate sound is already going.
              setSoundUnlocked(true)
            },
            () => {
              // Refused. Muted for now; the first gesture restarts it unmuted.
              audio.muted = true
              const retry = audio.play()
              if (retry !== undefined && typeof retry.catch === 'function') retry.catch(() => {})
              bindGesture()
            }
          )
        } else {
          setSoundUnlocked(true)
        }

        return detachAll
      }, [session, t])

      if (session.phase === 'done') return null

      if (session.phase === 'loading') {
        return topLayer(React.createElement('div', {
          'aria-hidden': true,
          style: { position: 'fixed', inset: 0, zIndex: TOP_Z, background: '#000000', pointerEvents: 'auto' },
        }))
      }

      const settings = session.settings
      const picture = session.picture
      const sound = session.sound
      const separateSound = sound.kind === 'sound'
      const fading = phase === 'out'
      const plan = soundPlan(settings, {
        separateSound,
        pictureKind: picture.kind,
        soundProblem: session.soundProblem,
      })
      // The hint only makes sense when a gesture can actually unlock the sound;
      // with `unlockOnGesture` off there is nothing to click for.
      const soundLocked = plan.unlockOnGesture && !soundUnlocked

      const overlayStyle = {
        position: 'fixed',
        inset: 0,
        zIndex: TOP_Z,
        display: 'grid',
        placeItems: 'center',
        background: settings.background,
        pointerEvents: 'auto',
        opacity: fading ? 0 : 1,
        transition: `opacity ${fading ? settings.fadeOutMs : settings.fadeInMs}ms ease`,
        overflow: 'hidden',
      }

      const children = []

      if (picture.kind === 'video') {
        children.push(React.createElement('video', {
          key: 'video',
          ref: videoRef,
          src: picture.url,
          muted: settings.muted || separateSound,
          playsInline: true,
          autoPlay: true,
          preload: 'auto',
          onError: () => setFailed(true),
          'aria-label': 'splash animation',
          style: {
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            background: settings.background,
          },
        }))
      } else if (picture.kind === 'image') {
        children.push(React.createElement('img', {
          key: 'image',
          ref: imgRef,
          src: picture.url,
          alt: '',
          onError: () => setFailed(true),
          style: {
            width: '100%',
            height: '100%',
            objectFit: objectFit(settings.fit),
            background: settings.background,
          },
        }))
      }

      // A separate sound file is never visible; it exists to carry the audio.
      if (separateSound) {
        children.push(React.createElement('audio', {
          key: 'sound',
          ref: soundRef,
          src: sound.url,
          preload: 'auto',
          style: { display: 'none' },
        }))
      }

      // An opaque cover that survives until the video can paint.
      if (picture.kind === 'video' && !paintable) {
        children.push(React.createElement('div', {
          key: 'cover',
          'aria-hidden': true,
          style: { position: 'absolute', inset: 0, background: settings.background },
        }))
      }

      // Tell the user the sound is waiting for a gesture. The button is a real
      // control, but the window-level capture listener would stop a click before
      // React saw it, so the pointerdown unlock above is what actually fires.
      if (soundLocked) {
        children.push(React.createElement('button', {
          key: 'sound-hint',
          type: 'button',
          'data-dsh-custom-splash-sound': '',
          onClick: (event) => {
            event.stopPropagation()
          },
          style: {
            position: 'absolute',
            left: '50%',
            bottom: '22px',
            transform: 'translateX(-50%)',
            padding: '7px 16px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.42))',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            font: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            opacity: 0.85,
          },
        }, t.clickForSound))
      }

      if (soundNotice !== null) {
        children.push(React.createElement('div', {
          key: 'sound-notice',
          role: 'status',
          style: {
            position: 'absolute',
            left: '50%',
            top: '22px',
            transform: 'translateX(-50%)',
            padding: '6px 14px',
            borderRadius: '999px',
            background: 'rgba(0,0,0,0.55)',
            color: '#ffffff',
            font: 'inherit',
            fontSize: '13px',
            pointerEvents: 'none',
          },
        }, soundNotice))
      }

      if (settings.skip !== 'never' && settings.skip !== 'auto') {
        children.push(React.createElement('button', {
          key: 'skip',
          type: 'button',
          'data-dsh-custom-splash-skip': '',
          onClick: (event) => {
            event.stopPropagation()
            dismiss()
          },
          style: {
            position: 'absolute',
            right: '22px',
            bottom: '20px',
            padding: '7px 14px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.42))',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            font: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            opacity: 0.72,
          },
        }, t.skip))
      }

      return topLayer(React.createElement('div', {
        style: overlayStyle,
        onClick: settings.skip === 'click' ? dismiss : undefined,
        'data-dsh-custom-splash': '',
      }, children))
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

    /**
     * The settings page: choose the picture and the sound.
     * @returns the settings page element.
     */
    function SplashSettings() {
      const t = strings()
      const [pictureDraft, setPictureDraft] = React.useState('')
      const [soundMode, setSoundMode] = React.useState('auto')
      const [soundDraft, setSoundDraft] = React.useState('')
      const [volume, setVolume] = React.useState(0.7)
      const [unlockOnGesture, setUnlockOnGesture] = React.useState(true)
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        payload().then((result) => {
          if (cancelled) return
          const s = { ...FALLBACK, ...((result && result.settings) || {}) }
          setVolume(num(s.volume, FALLBACK.volume))
          setUnlockOnGesture(s.unlockOnGesture !== false)
          // The sound field follows the mode the Host resolved.
          const source = (result && result.soundSource) || null
          const effectiveSound = typeof result?.effectiveSoundSrc === 'string' ? result.effectiveSoundSrc : ''
          let mode = 'auto'
          if (source === 'chosen') mode = 'file'
          else if (source === 'cleared') mode = 'none'
          else if (source === 'unset') mode = 'auto'
          setSoundMode(mode)
          setSoundDraft(mode === 'file' ? effectiveSound : '')
          setPictureDraft(typeof result?.effectivePictureSrc === 'string' && result.effectivePictureSrc !== ''
            ? result.effectivePictureSrc
            : (typeof s.src === 'string' ? s.src : ''))
          setState({
            status: 'ready',
            picture: (result && result.picture) || { kind: 'none' },
            sound: (result && result.sound) || { kind: 'none' },
            soundSource: source,
            pictureProblem: (result && result.pictureProblem) || null,
            soundProblem: (result && result.soundProblem) || null,
            pictureSource: (result && result.pictureSource) || null,
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

      /** Map the sound mode onto the stored `audio` value. */
      const soundPayloadValue = () => {
        if (soundMode === 'file') return soundDraft.trim()
        if (soundMode === 'none') return ''
        return null // `auto`: delete the key so the Host resolves it
      }

      const choose = async (kind) => {
        setBusy(true)
        setState((previous) => ({ ...previous, status: 'picking' }))
        const result = await post(PICK_URL, { slot: kind })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', soundProblem: result.error === 'picker-unavailable' ? 'picker-unavailable' : 'load-failed' }))
          return
        }
        if (typeof result.path === 'string' && result.path.trim() !== '') {
          if (kind === 'picture') setPictureDraft(result.path)
          else {
            setSoundMode('file')
            setSoundDraft(result.path)
          }
          setState((previous) => ({ ...previous, status: 'ready', pictureProblem: null, soundProblem: null }))
        } else {
          setState((previous) => ({ ...previous, status: 'ready' }))
        }
      }

      const save = async () => {
        setBusy(true)
        const result = await post(SAVE_URL, {
          src: pictureDraft,
          audio: soundPayloadValue(),
          volume,
          unlockOnGesture,
        })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', pictureProblem: 'load-failed' }))
          return
        }
        const s = { ...FALLBACK, ...((result && result.settings) || {}) }
        setVolume(num(s.volume, FALLBACK.volume))
        setUnlockOnGesture(s.unlockOnGesture !== false)
        setState({
          status: 'ready',
          picture: result.picture || { kind: 'none' },
          sound: result.sound || { kind: 'none' },
          soundSource: result.soundSource || null,
          pictureProblem: result.pictureProblem ?? null,
          soundProblem: result.soundProblem ?? null,
          pictureSource: result.pictureSource || null,
          notice: t.saved,
        })
      }

      const clearPicture = async () => {
        setBusy(true)
        const result = await post(SAVE_URL, { src: '' })
        setBusy(false)
        if (result.ok !== true) {
          setState((previous) => ({ ...previous, status: 'ready', pictureProblem: 'load-failed' }))
          return
        }
        setPictureDraft('')
        setState({
          status: 'ready',
          picture: result.picture || { kind: 'none' },
          sound: result.sound || { kind: 'none' },
          soundSource: result.soundSource || null,
          pictureProblem: result.pictureProblem ?? null,
          soundProblem: result.soundProblem ?? null,
          pictureSource: result.pictureSource || null,
          notice: t.saved,
        })
      }

      const pictureProblem = state.pictureProblem === 'picker-unavailable'
        ? t.pickerUnavailable
        : (state.pictureProblem !== null && state.pictureProblem !== undefined ? (t.problem[state.pictureProblem] ?? null) : null)
      const soundProblem = state.soundProblem === 'picker-unavailable'
        ? t.pickerUnavailable
        : (state.soundProblem !== null && state.soundProblem !== undefined ? (t.problem[state.soundProblem] ?? null) : null)
      const picture = state.picture || { kind: 'none' }
      const soundActive = state.soundSource === 'bundled'
        || state.soundSource === 'chosen'
        || state.soundSource === 'picture-audio'
        || state.soundSource === 'auto-picture-audio'
      const pictureActive = picture.kind !== 'none'

      const rows = []
      rows.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 14px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, t.intro))

      rows.push(React.createElement('label', {
        key: 'picture',
        style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' },
      }, [
        React.createElement('span', { key: 'label' }, t.pictureLabel),
        React.createElement('div', { key: 'row', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
          React.createElement('input', {
            key: 'input',
            type: 'text',
            value: pictureDraft,
            spellCheck: false,
            placeholder: t.picturePlaceholder,
            disabled: busy,
            onChange: (event) => setPictureDraft(event.target.value),
            style: FIELD,
          }),
          button({ label: t.choose, onClick: () => void choose('picture'), disabled: busy }),
        ]),
      ]))

      const SOUND_MODES = [
        ['auto', t.soundAuto],
        ['file', t.soundFile],
        ['none', t.soundNone],
      ]
      rows.push(React.createElement('div', {
        key: 'sound',
        style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '14px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary, #17181a)' },
      }, [
        React.createElement('span', { key: 'label' }, t.soundLabel),
        React.createElement('div', { key: 'modes', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          SOUND_MODES.map(([value, label]) => React.createElement('label', {
            key: value,
            style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 400, cursor: 'pointer' },
          }, [
            React.createElement('input', {
              key: 'radio',
              type: 'radio',
              name: 'dsh-custom-splash-sound-mode',
              checked: soundMode === value,
              disabled: busy,
              onChange: () => setSoundMode(value),
              style: { margin: 0 },
            }),
            React.createElement('span', { key: 'text', style: { fontWeight: 400 } }, label),
          ]))),
        soundMode === 'file'
          ? React.createElement('div', { key: 'filerow', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
              React.createElement('input', {
                key: 'input',
                type: 'text',
                value: soundDraft,
                spellCheck: false,
                placeholder: t.soundPathPlaceholder,
                disabled: busy,
                onChange: (event) => setSoundDraft(event.target.value),
                style: FIELD,
              }),
              button({ label: t.choose, onClick: () => void choose('sound'), disabled: busy }),
            ])
          : null,
      ]))

      rows.push(React.createElement('div', {
        key: 'sound-options',
        style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px', fontSize: '13px', fontWeight: 400, color: 'var(--dsw-alias-label-secondary, #5c6068)' },
      }, [
        React.createElement('label', {
          key: 'volume',
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
        }, [
          React.createElement('span', { key: 'vlabel', style: { minWidth: '52px' } }, '音量'),
          React.createElement('input', {
            key: 'range',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: volume,
            disabled: busy,
            onChange: (event) => setVolume(Number(event.target.value)),
            style: { flex: 1 },
          }),
          React.createElement('span', { key: 'vval', style: { minWidth: '38px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${Math.round(volume * 100)}%`),
        ]),
        React.createElement('label', {
          key: 'unlock',
          style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
        }, [
          React.createElement('input', {
            key: 'checkbox',
            type: 'checkbox',
            checked: unlockOnGesture,
            disabled: busy,
            onChange: (event) => setUnlockOnGesture(event.target.checked),
            style: { margin: 0 },
          }),
          React.createElement('span', { key: 'text' }, t.intro.split('。')[0] + '。'),
        ]),
      ]))

      rows.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px' },
      }, [
        button({ key: 'save', label: t.save, onClick: () => void save(), disabled: busy, primary: true }),
        button({ key: 'clear', label: t.clearPicture, onClick: () => void clearPicture(), disabled: busy || pictureDraft === '' }),
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

      if (pictureProblem !== null) {
        rows.push(React.createElement('p', {
          key: 'picture-problem',
          role: 'alert',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, pictureProblem))
      }

      if (soundProblem !== null) {
        rows.push(React.createElement('p', {
          key: 'sound-problem',
          role: 'alert',
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
        }, soundProblem))
      }

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
        }, `${t.current}: ${pictureActive ? (state.pictureSource === 'bundled' ? t.bundledPicture : t.saved.slice(0, 0) + t.willPlay) : t.none}`),
        state.pictureSource === 'bundled'
          ? React.createElement('div', { key: 'bundled-picture', style: { marginBottom: '4px' } }, t.bundledPicture)
          : null,
        pictureActive
          ? React.createElement('div', { key: 'picture-file', style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' } },
              `${picture.name ?? ''}${picture.bytes === undefined ? '' : `  ·  ${humanBytes(picture.bytes)}`}`)
          : null,
        React.createElement('div', { key: 'sound-line', style: { marginTop: soundActive ? '6px' : '4px' } },
          `${t.soundLabel}: ${soundActive
            ? (state.soundSource === 'bundled' ? t.bundledSound
              : state.soundSource === 'picture-audio' || state.soundSource === 'auto-picture-audio' ? t.pictureAudio
              : t.saved.slice(0, 0) + t.willPlay)
            : t.soundOff}`),
        soundActive && state.soundSource === 'chosen' && state.sound && state.sound.name
          ? React.createElement('div', { key: 'sound-file', style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' } },
              `${state.sound.name}${state.sound.bytes === undefined ? '' : `  ·  ${humanBytes(state.sound.bytes)}`}`)
          : null,
      ]))

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: '720px' } }, rows)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page is always registered: it is how the media gets chosen.
        ctx.slots.inject(TAB_SLOT, () => ctx.slots.register(
          { name: TAB_SLOT, id: ROW_ID, order: 50, label: () => strings().tab },
          SplashSettings,
        ))

        try {
          globalThis.__DSH_CUSTOM_SPLASH__ = {
            soundPlan,
            fadeDelayFor,
            version: 1,
          }
        } catch { /* a frozen globalThis is not worth failing a boot over */ }

        // The splash itself is registered ONLY when there is something to show,
        // decided from a SYNCHRONOUS read so the overlay is queued before the
        // first paint.
        const initial = payloadSync()
        const initialPicture = (initial && initial.picture) || { kind: 'none' }
        const initialSound = (initial && initial.sound) || { kind: 'none' }
        const initialSoundSource = (initial && initial.soundSource) || null
        const soundActive = initialSound.kind === 'sound'
          || initialSoundSource === 'picture-audio'
          || initialSoundSource === 'auto-picture-audio'
          || initialSoundSource === 'bundled'
        if (initialPicture.kind !== 'none' || soundActive) {
          ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
            { name: OVERLAY_SLOT, id: ROW_ID, order: 900 },
            SplashAnimation,
          ))
        } else {
          releaseCover()
        }
      },
    }
  },
})
