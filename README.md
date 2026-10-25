# DSH 插件合集

[DeepSeek Harness](https://deepseek.com)（DSH）的第三方插件合集，附**官方格式的插件市场索引** [`index.json`](./index.json)。

包含两个插件：

| 插件 | 包名 | 一句话 |
|---|---|---|
| 聊天视频背景 | [`dsh-chat-background`](./plugins/dsh-chat-background) | 循环视频背景（全屏或仅聊天区），从画面主体色自动推导主题并逐帧渐变，界面 12 个配色角色自动适配/手动可调，背景音频，WCAG 对比度保证 |
| 自定义开屏（带声音） | [`dsh-custom-splash`](./plugins/dsh-custom-splash) | 启动时播放自定义开屏动画与声音，播完淡出进入界面 |

## 安装

### 方式一：通过 DSH 插件市场（推荐）

1. 打开 DSH 的 **设置 → 插件**，进入市场（发现）页；
2. 添加索引源，URL 填：

   ```
   https://raw.githubusercontent.com/Renxingdxx/dsh-plugins/main/index.json
   ```

3. 搜索并安装即可。安装参数自动携带 commit 锁定，版本可复现。

> 若你的 DSH 版本没有市场入口，用方式二。

### 方式二：手动添加 Git 仓库

**设置 → 插件 → 添加插件 → 安装第三方插件**，输入：

```
git+https://github.com/Renxingdxx/dsh-plugins.git#<commit>&path:/plugins/dsh-chat-background
```

`<commit>` 用 `main` 也可以；`path:` 换成 `plugins/dsh-custom-splash` 即安装开屏插件。安装后在插件列表里启用。

## 仓库结构

```
index.json                     ← 市场索引（format 1，经官方校验器验证）
plugins/
  dsh-chat-background/         ← 聊天视频背景（独立 npm 包布局）
  dsh-custom-splash/           ← 自定义开屏（独立 npm 包布局）
scripts/make-index.mjs         ← 索引生成器（自举：从 git 树计算 commit 并校验输出）
```

## 更新索引

改动插件后在仓库根运行：

```
node scripts/make-index.mjs
```

它会为每个插件读取其 `package.json` 的 name/version，计算当前内容的 commit，生成并**用官方 `@deepseek-ai/dsh-plugin-market-index` 校验器验证** `index.json`，然后连同代码一起提交。

## 许可

MIT（各插件目录内附 LICENSE）。
