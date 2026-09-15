/**
 * KB-11 quota acceptance suite: is the restricted state genuinely reachable?
 *
 * The criterion this exists for is §8.2's restricted state — "权限或配额不足时说明
 * 限制来源与解除路径". A state that cannot be triggered is untestable and, in
 * practice, unbuilt; so this suite does not check that a banner component exists,
 * it **makes the store run out of room** and verifies what happens.
 *
 * The enforcement is checked at both growth points rather than one. A quota
 * enforced only on upload would let a rebuild double the footprint that an upload
 * had been refused for — the quota would appear to work in a demo and fail in the
 * situation it exists for.
 *
 * Usage: node scripts/verify-kb11-quota.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - criterion.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

const quota = await import(new URL('../lib/store/quota.js', import.meta.url).href)
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

/**
 * A deterministic unit vector, so a build can run without a real model.
 * @param text - input text.
 * @returns a unit vector of the collection's dimension.
 */
function fakeEmbed(text) {
  const dim = 1024
  const v = new Float32Array(dim)
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = 0; i < dim; i += 1) {
    h ^= h << 13; h >>>= 0
    h ^= h >> 17
    h ^= h << 5; h >>>= 0
    v[i] = ((h % 2000) - 1000) / 1000
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i += 1) v[i] = v[i] / norm
  return v
}

// ---------------------------------------------------------------------------
// 1. Measurement
// ---------------------------------------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), 'kb11-quota-'))
  const dir = join(scratch, 'store')
  mkdirSync(join(dir, 'nested'), { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(1000))
  writeFileSync(join(dir, 'nested', 'b.txt'), 'y'.repeat(500))

  const measured = quota.measureDirectory(dir)
  check('measure: counts the whole tree', measured.bytes === 1500, `${measured.bytes} bytes for 1000 + nested 500`)
  check('measure: reports completeness', measured.complete === true, 'complete')
  check('measure: an absent directory is zero, not an error', quota.measureDirectory(join(scratch, 'nope')).bytes === 0, '0 for a missing path')

  // Unlimited: no fraction, and never blocked.
  const unlimited = quota.quotaState(dir, { bytes: null, warnAt: 0.9 })
  check('state: unlimited reports null limit', unlimited.limit === null && unlimited.fraction === null, 'limit/fraction null')
  check('state: unlimited is never near or over', !unlimited.nearLimit && !unlimited.exceeded, 'neither flag set')

  // Limited: fraction and the two thresholds.
  const half = quota.quotaState(dir, { bytes: 3000, warnAt: 0.9 })
  check('state: fraction reflects usage', Math.abs((half.fraction ?? 0) - 0.5) < 1e-9, `${half.fraction}`)
  check('state: below the warning threshold', !half.nearLimit && !half.exceeded, 'neither flag set at 50%')

  const near = quota.quotaState(dir, { bytes: 1600, warnAt: 0.9 })
  check('state: crosses the warning threshold', near.nearLimit && !near.exceeded, `${((near.fraction ?? 0) * 100).toFixed(0)}% with warnAt 0.9`)

  const over = quota.quotaState(dir, { bytes: 1000, warnAt: 0.9 })
  check('state: reports exceeded past the limit', over.exceeded, `${over.used} > ${over.limit}`)

  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 2. Admission: the refusal must state the limit AND the remedy
// ---------------------------------------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), 'kb11-admit-'))
  writeFileSync(join(scratch, 'x.bin'), 'x'.repeat(1000))
  const configured = { bytes: 2000, warnAt: 0.9 }

  const ok = quota.admit(scratch, configured, 500, '上传该文档')
  check('admit: allows an operation that fits', ok.allowed && ok.reason === null, '500 bytes into 1000/2000')

  const refused = quota.admit(scratch, configured, 5000, '上传该文档')
  check('admit: refuses an operation that does not fit', !refused.allowed, '5000 bytes into 1000/2000')
  // `formatBytes` renders 2000 as "2.0 KB" (one decimal below 10), so the
  // assertion is on the rendered figure rather than a rounded spelling.
  check('admit: the reason names the limit', refused.reason.includes(quota.formatBytes(2000)), refused.reason)
  check('admit: the reason names current usage', refused.reason.includes(quota.formatBytes(1000)), refused.reason)
  check('admit: the reason names the shortfall', /尚缺/.test(refused.reason), refused.reason)
  // §8.2's actual requirement: the message must give the解除路径.
  check('admit: the reason gives the remedy', /删除|调高/.test(refused.reason), refused.reason)
  check('admit: the reason says what was blocked', refused.reason.includes('上传该文档'), refused.reason)
  check('admit: the state travels with the refusal', refused.state.limit === 2000, `limit=${refused.state.limit}`)

  // An unlimited store never refuses, whatever the size.
  check('admit: unlimited never refuses', quota.admit(scratch, { bytes: null, warnAt: 0.9 }, 1e12, '上传').allowed, 'no limit set')

  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 3. The restricted state is reachable through the real host operations
// ---------------------------------------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), 'kb11-live-'))
  // A quota small enough that a couple of documents exhaust it, which is what
  // makes the state reachable in a test rather than only in principle.
  const ops = new KnowledgeOperations({
    workspaceDir: scratch,
    stateDir: '.kb',
    embed: async texts => texts.map(fakeEmbed),
    quota: { bytes: 60 * 1024, warnAt: 0.5 },
  })

  await ops.createCollection({ name: 'Quota', collectionId: 'kb_prod_2f8a', description: '' })
  // A freshly created collection writes its metadata, so "empty" means "only the
  // metadata", not zero — asserting zero would be asserting the wrong thing.
  const fresh = ops.usage()
  check('live: a fresh store is far below its limit', fresh.used < fresh.limit, `${fresh.used} / ${fresh.limit}`)

  // Fill it with documents until the quota refuses one.
  let refusedWith = null
  let accepted = 0
  for (let i = 0; i < 40; i += 1) {
    const text = `# 文档 ${i}\n${'这段文字用于占用存储配额，使受限状态可以被真实触发。'.repeat(40)}`
    try {
      await ops.addDocument('kb_prod_2f8a', { name: `doc${i}.md`, bytes: text.length, text })
      accepted += 1
    } catch (error) {
      refusedWith = String(error instanceof Error ? error.message : error)
      break
    }
  }

  check('live: uploads are accepted until the quota bites', accepted > 0, `${accepted} documents stored`)
  check('live: the quota actually refused an upload', refusedWith !== null, refusedWith ?? '(never refused — the state is unreachable!)')
  check('live: the refusal explains the limit', refusedWith !== null && /配额/.test(refusedWith), refusedWith?.slice(0, 60) ?? '-')
  check('live: the refusal gives the remedy', refusedWith !== null && /删除|调高/.test(refusedWith), refusedWith?.slice(-40) ?? '-')

  const state = ops.usage()
  // The store is *near* its limit rather than over it: the refused upload would
  // have crossed the line, which is why it was refused. Both facts matter, and
  // conflating them would mean asserting a state the enforcement never produces.
  check('live: the store reports as near its limit', state.nearLimit, `${state.used} / ${state.limit}`)
  check('live: the fraction is computed', state.fraction !== null && state.fraction > 0.9, `${state.fraction?.toFixed(2)}`)

  // The sidebar card's figures come from the same measurement, so the meter and
  // the refusal cannot disagree.
  const usage = ops.storageUsage()
  check('live: storage usage reports the same numbers', usage.bytes === state.used && usage.quotaBytes === state.limit, `${usage.bytes} / ${usage.quotaBytes}`)

  // A build is the second growth point, and it must also be refused. The store is
  // already over its limit here, so a build that ignores the quota would proceed.
  const build = await ops.buildIndex(
    'kb_prod_2f8a',
    {
      chunking: { mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
      index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
    },
    { onProgress: () => {}, onLog: () => {} },
  )
  check('live: a build is refused too, not just an upload', !build.ok && !build.started, `ok=${build.ok} started=${build.started}`)
  check('live: the build refusal explains the quota', /配额/.test(build.error ?? ''), build.error ?? '(no error)')

  ops.dispose()
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 4. Config validation
// ---------------------------------------------------------------------------
{
  const { assertValidConfig } = await import(new URL('../lib/config.js', import.meta.url).href)
  /** A minimal valid config, overridable per case. */
  const base = {
    stateDir: '.kb',
    chunking: { mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64 },
    retrieval: { topk: 8, minScore: 0.55 },
    quota: { bytes: null, warnAt: 0.9 },
  }

  check('config: unlimited quota is valid', (() => { try { assertValidConfig(base); return true } catch { return false } })(), 'bytes: null')
  check('config: a positive quota is valid', (() => { try { assertValidConfig({ ...base, quota: { bytes: 1024, warnAt: 0.9 } }); return true } catch { return false } })(), 'bytes: 1024')
  check('config: zero is rejected', (() => { try { assertValidConfig({ ...base, quota: { bytes: 0, warnAt: 0.9 } }); return false } catch { return true } })(), 'bytes: 0 refused')
  check('config: negative is rejected', (() => { try { assertValidConfig({ ...base, quota: { bytes: -1, warnAt: 0.9 } }); return false } catch { return true } })(), 'bytes: -1 refused')
  check('config: warnAt above 1 is rejected', (() => { try { assertValidConfig({ ...base, quota: { bytes: null, warnAt: 1.5 } }); return false } catch { return true } })(), 'warnAt: 1.5 refused — it could never fire')
  check('config: warnAt of 0 is rejected', (() => { try { assertValidConfig({ ...base, quota: { bytes: null, warnAt: 0 } }); return false } catch { return true } })(), 'warnAt: 0 refused — it would always fire')
}

// ---------------------------------------------------------------------------
// 5. The interface presents the state with its source and remedy
// ---------------------------------------------------------------------------
{
  globalThis.document = {
    documentElement: { setAttribute() {}, removeAttribute() {} },
    createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
    head: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  globalThis.window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load() {} } }
  const React = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const kb = await import(new URL('../lib/client.js', import.meta.url).href)
    .then(async module => module) .catch(() => null)

  const noticeSource = readFileSync(join(ROOT, 'src', 'client', 'components', 'QuotaNotice.tsx'), 'utf8')
  check('ui: the notice names the limit source', /存储配额/.test(noticeSource), 'wording says it is a quota, not "space"')
  check('ui: the notice gives the解除路径', /解除方式/.test(noticeSource), 'explicit remedy line')
  check('ui: the remedy names both routes', /删除/.test(noticeSource) && /quota\.bytes/.test(noticeSource), 'delete files, or raise the config')
  check('ui: the notice shows the numbers', /formatBytes\(state\.used\)[\s\S]{0,40}formatBytes\(state\.limit\)/.test(noticeSource), 'used / limit')
  check('ui: nothing renders when unlimited and unblocked', /if \(state\.limit === null && blocked === null\) return null/.test(noticeSource), 'no permanent banner')
  check('ui: exceeded is announced as an alert', /exceeded \? 'alert' : 'status'/.test(noticeSource), 'role switches with severity')

  // The drop zone must be disabled while blocked, so the user is not invited to
  // pick a file that will be refused.
  const documentsSource = readFileSync(join(ROOT, 'src', 'client', 'pages', 'DocumentsPage.tsx'), 'utf8')
  check('ui: upload intake is disabled while blocked', /disabled=\{noCollection \|\| quotaBlocked\}/.test(documentsSource), 'drop zone honours the block')
  check('ui: the page states the consequence', /上传已暂停/.test(documentsSource), 'local explanation present')
}

console.log(`\nKB-11 quota acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
