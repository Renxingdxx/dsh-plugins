#!/usr/bin/env node
/**
 * Generate index.json — the DSH plugin-market index (format 1) for this repo.
 *
 * The index pins every plugin version to an exact git commit, so the commit
 * must already contain the plugin code: commit the plugins first, then run
 * this script and commit the produced index.json.
 *
 * Usage (from the repository root):
 *   node scripts/make-index.mjs                       # commit = git rev-parse HEAD
 *   node scripts/make-index.mjs --commit <sha40>      # explicit commit
 *   node scripts/make-index.mjs --validator <path>    # also run the official
 *                                                     # @deepseek-ai/dsh-plugin-market-index
 *                                                     # validator (ESM path or DSH app.asar)
 *
 * Output is deterministic apart from publishTimestamp defaults (commit date).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'Renxingdxx'
const REPO = 'dsh-plugins'
const BRANCH = 'main'
const REPO_URL = `https://github.com/${OWNER}/${REPO}`
export const INDEX_URL = `${REPO_URL}/raw/${BRANCH}/index.json`

/** The plugins this index publishes: directory name → market metadata. */
const PLUGINS = [
  {
    dir: 'dsh-chat-background',
    title: {
      en: 'Chat video background',
      zh: '聊天视频背景',
    },
    description: {
      en: 'Loop a video behind the chat (fullscreen or chat-only). Derives the theme from the video\'s dominant colour with per-frame easing — backgrounds, text, buttons and code blocks all glide. Twelve UI colour roles adapt automatically with WCAG contrast guarantees or take manual colours; frosted panels, region blending, Windows titlebar transparency, background audio (video sound or a custom file), and a floating play button.',
      zh: '循环播放视频背景（全屏或仅聊天区）。从画面主体色自动推导主题色并逐帧缓动——背景、文字、按钮、代码块平滑渐变。12 个界面配色角色自动适配（保证 WCAG 对比度）或手动指定；区域混合、磨砂面板、全屏模式 Windows 标题栏透明、背景音频（视频原声/自定义）与浮动播放按钮。',
    },
    keywords: ['chat', 'background', 'video', 'theme', 'dominant-color', 'audio', 'wallpaper', 'wcag'],
    labels: ['dsh-plugin', 'appearance', 'with-assets'],
    category: 'appearance',
    sortKeys: { popularity: 2 },
  },
  {
    dir: 'dsh-custom-splash',
    title: {
      en: 'Custom splash screen (with sound)',
      zh: '自定义开屏（带声音）',
    },
    description: {
      en: 'Plays a boot animation with sound before the interface appears, then fades out. Picture and sound are two independent slots, each with built-in defaults; the plugin auto-unmutes on the first click or keypress when the browser blocks audible autoplay.',
      zh: '界面出现前先播放一段开屏动画与声音，播完淡出。画面与声音是两个独立槽位，均自带内置素材；浏览器拦截带声自动播放时，首次点击/按键自动解锁声音。',
    },
    keywords: ['splash', 'boot', 'startup', 'animation', 'sound', 'audio', 'video'],
    labels: ['dsh-plugin', 'appearance', 'with-assets'],
    category: 'appearance',
    sortKeys: { popularity: 1 },
  },
]

const CATEGORIES = {
  appearance: { title: { en: 'Appearance', zh: '外观' } },
  utility: { title: { en: 'Utility', zh: '工具' } },
}

/** The DSH plugin tag: the label every plugin here carries, shown in the market. */
const LABELS = {
  'dsh-plugin': { title: { en: 'DSH plugin', zh: 'DSH 插件' } },
  appearance: { title: { en: 'Appearance', zh: '外观' } },
  'with-assets': { title: { en: 'Bundled assets', zh: '内置素材' } },
}

const SORT_KEYS = {
  popularity: { title: { en: 'Popularity', zh: '热度' }, order: 'desc' },
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function readArg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null
}

/** base64 data URL for the plugin's icon.svg, inlined as the market allows (≤32 KiB). */
function iconDataUrl(pluginDir) {
  const file = join(ROOT, 'plugins', pluginDir, 'icon.svg')
  const bytes = readFileSync(file)
  if (bytes.length * 1.34 > 32 * 1024) throw new Error(`icon for ${pluginDir} exceeds the 32 KiB inline budget`)
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

function packageJson(pluginDir) {
  return JSON.parse(readFileSync(join(ROOT, 'plugins', pluginDir, 'package.json'), 'utf8'))
}

function buildIndex(commit, commitUnix) {
  return {
    format: 1,
    title: { en: 'Renxingdxx\'s DSH plugins', zh: 'Renxingdxx 的 DSH 插件' },
    description: {
      en: 'Community plugins for DeepSeek Harness: a chat video background with adaptive theme colours, and a custom splash screen with sound.',
      zh: 'DeepSeek Harness 第三方插件合集：自动适配主题色的聊天视频背景，与带声音的自定义开屏动画。',
    },
    metadata: { categories: CATEGORIES, labels: LABELS, sortKeys: SORT_KEYS },
    plugins: PLUGINS.map((entry) => {
      const pkg = packageJson(entry.dir)
      return {
        name: pkg.name,
        title: entry.title,
        description: entry.description,
        icon: iconDataUrl(entry.dir),
        author: OWNER,
        homepage: `${REPO_URL}/tree/${BRANCH}/plugins/${entry.dir}`,
        repository: { url: REPO_URL, directory: `plugins/${entry.dir}` },
        metadata: {
          category: entry.category,
          labels: entry.labels,
          keywords: entry.keywords,
          sortKeys: entry.sortKeys,
        },
        versions: [{
          version: pkg.version,
          publishTimestamp: commitUnix,
          source: {
            type: 'git',
            url: REPO_URL,
            commit,
            path: `plugins/${entry.dir}`,
          },
          // `>=X.Y-Z` is the documented way to accept prerelease hosts:
          // a plain `>=0.2.1` would NOT match DSH 0.2.1-rc.3.
          engines: { dsh: '>=0.2.1-0' },
        }],
      }
    }),
  }
}

async function validate(index, validatorPath) {
  const { parseMarketIndex } = await import(pathToFileURL(resolve(validatorPath)).href)
  parseMarketIndex(index, INDEX_URL)
  console.log('official validator: OK')
}

const COMMIT_RE = /^[0-9a-f]{40}$/

async function main() {
  let commit = readArg('--commit')
  let stamp = null
  if (commit === null) {
    commit = git(['rev-parse', 'HEAD'])
    stamp = Number(git(['log', '-1', '--format=%ct']))
  }
  if (!COMMIT_RE.test(commit)) throw new Error(`commit must be a lowercase 40-hex SHA, got ${JSON.stringify(commit)}`)
  if (stamp === null) {
    try { stamp = Number(git(['log', '-1', '--format=%ct'])) } catch { stamp = Math.floor(Date.now() / 1000) }
  }
  const index = buildIndex(commit, stamp)
  const target = join(ROOT, 'index.json')
  writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const bytes = statSync(target).size
  console.log(`wrote index.json (${bytes} bytes) pinning ${commit}`)
  for (const plugin of index.plugins) {
    console.log(`  ${plugin.name}@${plugin.versions[0].version} → git+${REPO_URL}.git#${commit}&path:/${plugin.versions[0].source.path}`)
  }
  const validator = readArg('--validator')
  if (validator !== null) await validate(index, resolve(validator))
}

await main()
