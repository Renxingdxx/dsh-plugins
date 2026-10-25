#!/usr/bin/env node
/**
 * Publish this repository to GitHub without a local git install.
 *
 * Reads every file under the repo root (except .git and node_modules), creates
 * them as ONE commit via the Git Data API (blobs → tree → commit → ref), then
 * regenerates index.json pinned to that commit and pushes it as a second
 * commit — the index must pin a commit that already contains the plugin code.
 *
 * Token: environment variable GITHUB_TOKEN (never an argument, never logged).
 *   - Fine-grained PAT: cannot CREATE repositories. Create an empty public
 *     repo named dsh-plugins first, then grant this token Contents (+Topics)
 *     read/write on it.
 *   - Classic PAT with `repo` scope: the script also creates the repo.
 *
 * Usage:
 *   $env:GITHUB_TOKEN='...'; node scripts/publish.mjs [--dry]
 *
 * --dry prints the plan and validates everything locally; no network calls.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// This machine's network stack intercepts TLS with a locally installed root CA
// that Node's bundled certificate store does not trust ("unable to verify the
// first certificate"). Windows trusts it, so re-exec once with
// --use-system-ca when the flag is not already active.
if (!process.execArgv.includes('--use-system-ca') && process.env.DSH_PUBLISH_RELAUNCHED === undefined) {
  const result = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, DSH_PUBLISH_RELAUNCHED: '1' },
  })
  process.exit(result.status ?? 1)
}


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = process.env.GITHUB_OWNER ?? 'Renxingdxx'
const REPO = 'dsh-plugins'
const BRANCH = 'main'
const DRY = process.argv.includes('--dry')

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN && !DRY) {
  console.error('GITHUB_TOKEN is not set. Fine-grained PAT: create the empty repo on the web first.')
  process.exit(1)
}

const EXCLUDE_DIRS = new Set(['.git', 'node_modules'])
const API = 'https://api.github.com'

function listFiles(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue
    const full = join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel))
    else out.push({ rel, full })
  }
  return out
}

async function gh(method, path, body, { accept = 'application/vnd.github+json' } = {}) {
  const init = { method, headers: {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-plugins-publisher',
  } }
  if (!DRY) init.headers.Authorization = `Bearer ${TOKEN}`
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const url = path.startsWith('http') ? path : `${API}${path}`
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) {
    let detail
    try { detail = JSON.parse(text).message } catch { detail = text.slice(0, 200) }
    throw new Error(`${method} ${path} -> ${res.status}: ${detail}`)
  }
  if (text === '') return null
  return JSON.parse(text)
}

function localSha() {
  // A deterministic stand-in for --dry.
  return '0'.repeat(40)
}

async function ensureRepo() {
  if (DRY) { console.log('[dry] repo check/create skipped (offline)'); return null }
  try {
    const repo = await gh('GET', `/repos/${OWNER}/${REPO}`)
    console.log(`repo exists: ${repo.full_name} (${repo.visibility})`)
    return repo
  } catch (error) {
    if (!String(error.message).includes('404')) throw error
  }
  console.log(`creating ${OWNER}/${REPO} ...`)
  return gh('POST', '/user/repos', {
    name: REPO,
    description: 'DSH (DeepSeek Harness) plugins: chat video background with adaptive theme colours, and a custom splash screen with sound. Ships a plugin-market index (index.json).',
    homepage: `https://github.com/${OWNER}/${REPO}#readme`,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  })
}

async function pushTree(files, message, parents) {
  const entries = []
  for (const file of files) {
    const bytes = readFileSync(file.full)
    const blob = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: bytes.toString('base64'),
      encoding: 'base64',
    })
    entries.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write(`  blob ${file.rel} (${blob.sha.slice(0, 8)})\n`)
  }
  const tree = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: entries })
  const commit = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    parents,
  })
  return commit
}

async function setRef(sha, force = false) {
  // The UPDATE endpoint is /git/refs/{ref} (plural); the singular /git/ref/…
  // form only exists for GET — PATCHing it answers 404.
  const refPath = `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`
  let existing = null
  try { existing = await gh('GET', refPath) } catch { existing = null }
  if (existing === null) {
    await gh('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha })
  } else {
    await gh('PATCH', refPath, { sha, force })
  }
}

async function currentHead() {
  try {
    const ref = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
    return ref.object.sha
  } catch { return null }
}

async function main() {
  console.log(`publishing ${ROOT} -> ${OWNER}/${REPO}@${BRANCH}${DRY ? ' [dry run]' : ''}`)
  await ensureRepo()

  const all = listFiles(ROOT).sort((a, b) => a.rel.localeCompare(b.rel))
  const first = all.filter((f) => f.rel !== 'index.json')
  console.log(`commit 1: ${first.length} files (everything except index.json)`)
  let head = DRY ? localSha() : null
  let commit1Sha = DRY ? localSha() : null
  if (!DRY) {
    const parents = await currentHead()
    const commit = await pushTree(first, 'Add DSH plugins: chat video background + custom splash', parents === null ? [] : [parents])
    await setRef(commit.sha, false)
    commit1Sha = commit.sha
    head = commit.sha
    console.log(`commit 1 pushed: ${commit1Sha}`)
  }

  // Regenerate the index pinned to commit 1, then push it as commit 2.
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'make-index.mjs'), '--commit', commit1Sha], { stdio: 'inherit' })
  const indexFile = { rel: 'index.json', full: join(ROOT, 'index.json') }
  if (DRY) { console.log('[dry] index.json regenerated (placeholder commit)'); return }
  const commit2 = await pushTree([indexFile], `Publish market index pinned to ${commit1Sha.slice(0, 10)}`, [head])
  await setRef(commit2.sha, false)
  console.log(`commit 2 pushed: ${commit2.sha} (index.json pins ${commit1Sha})`)

  // Best-effort metadata: description, homepage, topics (needs Topics permission).
  try {
    await gh('PATCH', `/repos/${OWNER}/${REPO}`, {
      description: 'DSH (DeepSeek Harness) plugins: chat video background with adaptive theme colours, and a custom splash screen with sound. Ships a plugin-market index (index.json).',
      homepage: `https://github.com/${OWNER}/${REPO}#readme`,
    })
  } catch (error) { console.warn(`description/homepage: ${error.message}`) }
  try {
    await gh('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: [
      'dsh', 'dsh-plugin', 'dsh-plugins', 'deepseek-harness', 'plugin-market',
      'video-background', 'splash-screen', 'theme-color', 'electron',
    ] }, { accept: 'application/vnd.github.mercy-preview+json' })
    console.log('topics set: dsh-plugin, deepseek-harness, plugin-market, ...')
  } catch (error) { console.warn(`topics skipped: ${error.message}`) }

  const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/index.json`
  console.log(`\nDONE. Market index URL for DSH 设置→插件→市场:\n  ${raw}`)
  console.log(`Install spec (manual add):\n  git+https://github.com/${OWNER}/${REPO}.git#${commit1Sha}&path:/plugins/dsh-chat-background`)
}

await main()
