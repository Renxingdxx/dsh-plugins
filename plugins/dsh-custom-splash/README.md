# dsh-custom-splash

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一段**自定义开屏动画（带声音）**：启动时先播放你指定的**画面**和**声音**，播完后淡出，露出 DSH 界面。

画面和声音是**两个独立槽位**：可以只换画面、只换声音、或者两个都换。插件自带一段内置动画（GIF）和一段内置音效（WAV），**装上就能用，而且默认就有声音**。

## 它解决什么问题

原版 `dsh-splash-animation` 默认静音，因为 Chromium 在用户首次操作前会拦截带声音的自动播放——开屏恰好发生在交互之前，所以「有画面、没声音」。本插件默认 `muted: false`，并且会：

1. 先尝试**带声音**自动播放；
2. 如果被浏览器拦下，画面照常静音播放，同时在画面上显示一个「点击开启声音」提示；
3. 用户**第一次点击 / 按键 / 触摸**后，自动解除静音并从头播放声音。

所以默认情况下你既能看到动画，也能听到声音。

## 推荐安装法

本插件是本地开发包，用 `link:` 安装最方便：

```
帮我安装本地插件 <本目录的绝对路径>
安装 spec 用 link:<本目录绝对路径>。
优先用 plugin_manager 工具：action=install_bundle，target 填上面的 spec。
如果没有 plugin_manager，就手动改 profile 的 package.json：
1. profile 目录是 <home>/profiles/<profile 名>，<home> 取 resolveDshHome() 的结果
   （默认 $DSH_HOME，未设置时为 ~/.dsh）；
2. 在 dependencies 里加 "dsh-custom-splash": "link:<本目录绝对路径>"，
   并把 "dsh-custom-splash" 加进 dsh.profile.bundles；
3. 在该目录里用 DSH 自带的 pnpm 执行 install；
4. 装完告诉我需要重启 DSH，以及设置页在哪儿。
```

DSH 桌面版的实际 profile 目录是 `%APPDATA%\dsh-desktop\harness\profiles\web`（本机上是 `C:\Users\Administrator\.dsh\profiles\desktop`）。

## 普通安装法

把本目录发布成 npm 包后：

```bash
dsh plugin --profile web add dsh-custom-splash
```

或者手动改 profile 的 `package.json`，把 `dsh-custom-splash` 加进 `dependencies` 和 `dsh.profile.bundles`，然后在该目录执行 `pnpm install`。

装完**重启 DSH** 生效。

## 使用

装好重启后就会播放内置动画 + 内置音效。

打开 **设置 → 插件 → 自定义开屏**：

- **画面**：留空使用内置动画，或点「选择文件…」挑一个视频/动图，也可以直接粘贴路径。
- **声音**：三个模式：
  - **跟随画面**：用画面自带的声音（内置动画时用内置音效；自选视频时用该视频的声音；自选动图时静音）。
  - **使用独立声音文件**：额外挑一个音频文件（`wav`/`mp3`/`ogg`/`opus`/`m4a`/`flac` 等），画面自带的声音会被静音，避免双重声音。
  - **静音**：不播放任何声音。
- **音量**：0–100%。
- **解锁声音**：勾选后，首次点击/按键会自动开启声音；取消勾选则保持静音（除非浏览器本来就允许带声音自动播放）。

点「保存」生效（下次打开或刷新页面即可，无需重启）。点「清除画面」则不再播放画面。

## 行为

| 状态 | 表现 |
|---|---|
| 画面未设置 | 播放内置动画 |
| 画面清空 | 不播放画面（若声音仍设置，则只放声音） |
| 画面设置了路径 | 播放该文件。路径无效则**不播放**，原因显示在设置页 |
| 声音「跟随画面」 | 内置动画→内置音效；自选视频→视频自带声音；自选动图→静音 |
| 声音「独立文件」 | 播放该音频；画面自带声音被静音 |
| 声音「静音」 | 不播放任何声音 |

视频播完会停在最后一帧，然后淡出消失（默认 0.3 秒）。动图没有结束事件，按 `duration` 或 `waitForAppMs` 退出。

### 启动过程

```
原生启动窗 → 黑屏（本插件已接管）→ 播放画面+声音 → 淡出 → 界面
```

插件在页面第一帧就把应用内容盖住，等自己的画面挂上才放开，所以启动时看不到「界面闪一下再出现动画」。

**开屏期间画面拥有输入。** 那段黑屏和动画是覆盖在整个界面上的，点击不会穿透到下面的应用；跳过之后立即恢复。

### 退出方式

默认右下角有一个「跳过」按钮，按 `Esc`、空格或回车也可以提前退出。想改成点任意位置跳过、固定时长自动退出、或干脆不让退出，见下面的 `skip`。

## 配置

在 profile 的 `cordis.patch.yml` 里写覆盖项即可调整细节（Windows 上通常是 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`）：

```yaml
- id: dsh-custom-splash
  config:
    src: D:/wallpapers/opening.webm
    audio: D:/music/opening.mp3
    muted: false
    volume: 0.8
    unlockOnGesture: true
    fadeOutMs: 600
    skip: click
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `src` | 空 | 画面路径。空 = 使用内置动画；清空后不再播放画面 |
| `audio` | 空 | 声音路径。空 = 跟随画面；清空 = 静音 |
| `muted` | `false` | 总静音开关 |
| `volume` | `0.7` | 音量 0–1 |
| `unlockOnGesture` | `true` | 首次点击/按键后自动解除静音 |
| `fadeOutMs` | `300` | 播完后渐隐时长 |
| `fadeInMs` | `320` | 出现时淡入时长 |
| `skip` | `button` | `button` / `click` / `auto` / `never` |
| `skipAfterMs` | `1200` | 仅 `skip: auto` 时有效 |
| `fit` | `cover` | `cover` 铺满裁切 / `contain` 完整显示 / `fill` 拉伸 |
| `background` | `#000000` | 画面底色 |
| `playbackRate` | `1` | 播放倍速 0.1–4 |
| `duration` | `0` | 最长播放毫秒数，`0` = 播放到结束 |
| `maxReplays` | `0` | 重复播放次数 |
| `holdAfterEndMs` | `0` | 播完到开始渐隐之间的停顿 |
| `waitForAppMs` | `2500` | 动图/纯声音的兜底退出时长 |

字段填写有误只会退回默认值，不会导致启动失败。

## 声音是怎么工作的

浏览器（Chromium）的安全策略规定：**在用户与页面交互之前，不允许带声音的媒体自动播放**。开屏发生在交互之前，所以直接 `play()` 带声音会被拒绝。

本插件的策略：

1. 先尝试**带声音**自动播放：声音来自画面自带音轨，或来自独立的声音文件；
2. 若被拒绝，画面立即改为静音播放（画面不受影响），声音元素设为静音待命；
3. 监听 `pointerdown` / `keydown` / `touchstart`；第一次触发时解除静音、把声音从头播放；
4. 在画面上显示「点击开启声音」提示，用户知道该点哪里。

如果浏览器本来就允许带声音自动播放（例如某些桌面配置），声音会直接响起，不需要点击。

## 支持的格式

**画面**（`<video>` 或 `<img>`）：

- 视频：`mp4`、`m4v`、`webm`、`mov`、`mkv`、`ogv`、`ogm`、`mpg`、`mpeg`、`ts`
- 动图/静态图：`gif`、`apng`、`webp`、`avif`、`png`、`jpg`、`jpeg`、`svg`、`bmp`、`ico`

**声音**（`<audio>`）：`wav`、`mp3`、`ogg`、`oga`、`opus`、`m4a`、`aac`、`flac`、`webma`、`weba`

**推荐**：画面用 `webm`(VP9) 或 `mp4`(H.264)，声音用 `mp3` 或 `wav`，跨平台都能播。

`mov` 和 `mkv` 只是容器，能否播放取决于内部编码。转码命令：

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
ffmpeg -i input.mov -c:a libmp3lame -q:a 2 opening.mp3
```

## 内置素材

`assets/default.gif`（480×270，约 2.6 秒）和 `assets/default.wav`（约 2.6 秒）是仓库用 `tools/generate-default-assets.py` 生成的示例素材，不属于 MIT 授权范围；二次分发或 fork 时请自行替换。重新生成：

```bash
python tools/generate-default-assets.py
```

## 常见问题

**有画面但没声音**

Chromium 要求先与页面交互才允许带声音的自动播放。确认设置里「解锁声音」已勾选，然后在开屏画面上点一下或按任意键，声音就会响起。如果浏览器本身就允许带声音自动播放，则无需操作。

**点「选择文件…」没有反应**

对话框在运行 DSH 的机器上弹出，如果你是从另一台机器访问浏览器界面就看不到它，直接手输路径即可。

**启动时一直黑屏，过十来秒才出现界面**

说明插件的界面部分没能启动，遮盖由兜底机制在约 10 秒后自行撤掉。常见原因是安装不完整（`client.js` 没到位）或插件在加载时被停用。重装一次即可。

**开屏动画被别的插件挡住了**

本插件把画面挂到 `<body>` 下（React portal），而不是留在槽位容器里，这样它的层级不会被槽位祖先的层叠上下文限制住。

**声音和画面对不上**

声音元素与画面元素是两个独立的媒体元素，`<audio>` 使用独立的声音文件时，画面自带的声音会被静音以避免双重声音。若仍有重叠，检查是否误把同一段音频同时设成了画面和声音。

## 开发与自测

插件没有构建步骤，宿主半和浏览器半都是手写的 ES module。仓库自带两个自测脚本，不需要 Electron 或网络：

```bash
node tools/verify-contract.mjs   # 宿主半：配置归一化、媒体解析、路由、Range、状态文件
node tools/verify-client.mjs     # 浏览器半：模块注册、开屏挂载决策、声音解锁策略
npm run verify                   # 两个一起跑
```

内置素材由脚本生成，改动画/音色后重新运行：

```bash
python tools/generate-default-assets.py
```

## 许可

MIT，覆盖插件代码。内置素材见上节。
