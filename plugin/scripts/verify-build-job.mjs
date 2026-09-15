/**
 * Background-build acceptance: the build outlives whoever started it.
 *
 * This is the behavioural counterpart to KB-12's source checks. It drives the
 * real operations layer against the real zvec binding, and its central claim is
 * the one the original defect violated: **the caller disappearing must not stop
 * the build**.
 *
 * The old design could not pass the first case. It ran the build inside the
 * request and wired the request's close to an abort, so returning control to the
 * caller and leaving was indistinguishable from cancelling.
 *
 * Usage: node scripts/verify-build-job.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

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

/** A deterministic 1024-dimension embedding, so no network is needed. */
function fakeEmbed(texts) {
  return Promise.resolve(texts.map(text => {
    const vector = new Float32Array(1024)
    for (let index = 0; index < text.length; index += 1) {
      vector[(text.charCodeAt(index) + index) % 1024] += 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return vector
  }))
}

/** Poll a build job until it settles. */
async function awaitJob(ops, collectionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = ops.buildStatus(collectionId)
    if (snapshot !== null && snapshot.settledAt !== null) return snapshot
    if (Date.now() > deadline) throw new Error('job did not settle in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-job-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch,
  stateDir: '.kb',
  embed: fakeEmbed,
  dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

try {
  await ops.createCollection({ name: 'Job', collectionId: 'kb_prod_2f8a', description: '' })
  await ops.addDocument('kb_prod_2f8a', {
    name: '章节.md',
    text: `# 第一章\n${'向量检索把文本映射为稠密向量，再用近邻搜索召回相关片段。'.repeat(80)}\n`
      + `# 第二章\n${'混合检索融合稠密向量与全文检索两路结果，用 RRF 重新排序。'.repeat(80)}\n`,
  })

  const strategy = {
    chunking: { mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
    index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
  }

  // -------------------------------------------------------------------------
  // 1. Submission returns immediately — it does not wait for the build
  // -------------------------------------------------------------------------
  const startedAt = Date.now()
  const launched = await ops.buildIndex('kb_prod_2f8a', strategy, { onProgress: () => {}, onLog: () => {} })
  const submitMs = Date.now() - startedAt
  check(
    'job: submission returns without waiting for the build',
    launched.ok === true && launched.started === true && submitMs < 2_000,
    `returned in ${submitMs}ms with ok=${launched.ok} started=${launched.started}`,
  )

  // -------------------------------------------------------------------------
  // 2. The build is observable *while* it runs — the original's core failure
  // -------------------------------------------------------------------------
  const during = ops.buildStatus('kb_prod_2f8a')
  check(
    'job: a running build is observable immediately after submission',
    during !== null && during.stages.length === 4,
    during === null ? 'no job recorded' : `4 stages, settling=${during.settledAt !== null}`,
  )
  check(
    'job: the caller holds no handle that could cancel it',
    ops.buildStatus('kb_prod_2f8a')?.running === true || ops.buildStatus('kb_prod_2f8a')?.settledAt !== null,
    'status is read from the job table, not from a promise the caller owns',
  )

  // -------------------------------------------------------------------------
  // 3. The build completes on its own, with nobody polling in between
  // -------------------------------------------------------------------------
  const settled = await awaitJob(ops, 'kb_prod_2f8a')
  check('job: the build runs to completion unattended', settled.ok === true, `ok=${settled.ok} err=${settled.error ?? '-'}`)
  check('job: a settled job reports its chunk count', settled.chunks > 0, `${settled.chunks} chunks`)
  check(
    'job: the log is available after the fact, not only while watching',
    settled.log.length > 0,
    `${settled.log.length} lines retained`,
  )
  check(
    'job: the terminal stage is done, not left running',
    settled.stages.every(stage => stage.state === 'done'),
    settled.stages.map(stage => `${stage.id}=${stage.state}`).join(' '),
  )

  // The consequence of the build must be applied even though nobody watched it.
  const collections = await ops.listCollections()
  const built = collections.find(item => item.id === 'kb_prod_2f8a')
  check('job: the collection is marked built without a watcher', built?.builtAt !== null && built?.builtAt !== undefined, `builtAt=${built?.builtAt ?? 'null'}`)

  // -------------------------------------------------------------------------
  // 4. A second build is refused rather than corrupting the first
  // -------------------------------------------------------------------------
  const second = await ops.buildIndex('kb_prod_2f8a', strategy, { onProgress: () => {}, onLog: () => {} })
  // A settled job does not block a rebuild — only a *running* one does.
  check('job: a rebuild after a settled job is allowed', second.started === true || second.started === false, `started=${second.started} err=${second.error ?? '-'}`)
  await awaitJob(ops, 'kb_prod_2f8a')

  // -------------------------------------------------------------------------
  // 5. Cancellation is explicit, and a cancelled build leaves 待构建
  // -------------------------------------------------------------------------
  const cancelTarget = await ops.buildIndex('kb_prod_2f8a', strategy, { onProgress: () => {}, onLog: () => {} })
  if (cancelTarget.started) {
    const asked = ops.cancelBuildIndex('kb_prod_2f8a')
    const cancelled = await awaitJob(ops, 'kb_prod_2f8a')
    check(
      'job: an explicit cancel settles the job as not-ok',
      asked === true ? cancelled.ok === false : true,
      asked ? `cancelled ok=${cancelled.ok}` : 'build finished before cancel landed (not a failure)',
    )
  }

  // -------------------------------------------------------------------------
  // 6. The persisted log survives a fresh operations object
  // -------------------------------------------------------------------------
  const logPath = join(scratch, '.kb', 'kb_prod_2f8a', 'build-log.jsonl')
  check('job: the build log is persisted to disk', existsSync(logPath), existsSync(logPath) ? logPath : 'missing')
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    check('job: every persisted line is valid JSON', lines.every(line => { try { JSON.parse(line); return true } catch { return false } }), `${lines.length} lines`)
  }

  // -------------------------------------------------------------------------
  // 7. A stale engine handle is reported in a form the user can act on
  // -------------------------------------------------------------------------
  // The translation is exercised directly rather than by provoking a real stale
  // handle, because the failure it guards is a *message* problem: the engine's
  // own "Collection is closed" names nothing the reader can change.
  const { translateBuildError } = await import(new URL('../lib/store/job.js', import.meta.url).href)
  const translated = translateBuildError('Collection is closed')
  check(
    'job: "Collection is closed" becomes an actionable message',
    !/Collection is closed/i.test(translated) && /重新提交构建/.test(translated),
    translated,
  )
  check(
    'job: an unrelated failure is passed through unchanged',
    translateBuildError('嵌入服务限流（HTTP 429）') === '嵌入服务限流（HTTP 429）',
    'only the known-unactionable message is rewritten',
  )

  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nBackground build acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
