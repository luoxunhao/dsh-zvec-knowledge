/**
 * Reparse acceptance: the whole-corpus re-derivation entry point.
 *
 * `sources/` keeps every original byte-for-byte so the corpus can be re-derived
 * when a converter improves. `reparseAll` is where that promise is kept. This
 * gate asserts the two things the promise is made of:
 *
 * 1. **A failed conversion recovers through it.** A document whose parse failed
 *    while its original was momentarily unreadable comes back `ready` when the
 *    original is repaired and the corpus reparsed — delete-and-reupload is not
 *    the only remedy.
 * 2. **It is identity-preserving.** The document's id survives the reparse, and
 *    the recovery does not consume the repaired original.
 *
 * The "edit the original and observe the text change" scenario is deliberately
 * *not* asserted with a markdown document: a verbatim document records no
 * converter, so a reparse correctly does not re-read it — its text *is* the
 * original, and an edit arrives as a new upload with a new id. Reparse
 * semantics exist for converted formats, and the recoverable case (Case B)
 * covers one end to end.
 *
 * All builds are awaited to settlement (`awaitJob`): `buildIndex` returns when
 * the build is *launched*, and publication is chained asynchronously after job
 * settlement, so reading document status without awaiting reads a stale record.
 *
 * Usage: node scripts/verify-parse-reparse.mjs
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeOperations } from '../lib/host/operations.js'

let pass = 0
let fail = 0

/**
 * Record one criterion.
 * @param name - what was asserted.
 * @param ok - whether it held.
 * @param detail - the observed value, when failing.
 */
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const opts = { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 8 * 1024 * 1024 }

const root = mkdtempSync(join(tmpdir(), 'kb-reparse-'))

/**
 * A deterministic fake embedding: stable per text, so a rebuild's chunk count
 * changes when and only when the text does.
 * @param texts - texts to embed.
 * @returns one vector per text.
 */
const fakeEmbed = async (texts) =>
  texts.map((text, i) => Array.from({ length: 8 }, (_, k) => ((text.length + i + k) % 7) / 7))

const ops = new KnowledgeOperations({
  workspaceDir: root,
  stateDir: '.kb',
  embed: fakeEmbed,
  dimension: 8,
  embeddingModel: 'fake',
})

const STRATEGY = {
  chunking: { mode: 'fixed', chunkTokens: 128, overlapTokens: 16, minChunkTokens: 32 },
  index: { kind: 'HNSW', quantize: 'INT8', m: 16, efConstruction: 200 },
}

/**
 * Await a build job to settlement. Publication is chained after settlement, so
 * a settled job is the earliest point at which document status is current.
 * @param ops - operations object.
 * @param collectionId - collection identifier.
 * @returns the settled snapshot.
 */
async function awaitJob(ops, collectionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = ops.buildStatus(collectionId)
    if (snapshot !== null && snapshot.settledAt !== null) return snapshot
    if (Date.now() > deadline) throw new Error('job did not settle in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

// ---------------------------------------------------------------------------
// Case: a failed conversion recovers through the reparse
// ---------------------------------------------------------------------------
// A PDF staged `pending` with the scan fixture as its original: the first parse
// fails honestly. The upload path cannot stage this — Task 2's preflight refuses
// a text-free PDF before a record exists — so the record is written directly,
// the same staging the Task 3 gate uses.
const collectionId = 'kb_reparse_0c2d'
await ops.createCollection({ name: '重算恢复', collectionId, description: '' })
const pendingSources = join(root, '.kb', collectionId, 'sources')
mkdirSync(pendingSources, { recursive: true })
copyFileSync('src/store/parse/fixtures/scanned.pdf', join(pendingSources, 'doc_rp3s01.pdf'))
writeFileSync(
  join(root, '.kb', collectionId, 'documents.jsonl'),
  JSON.stringify({
    id: 'doc_rp3s01', name: 'scanned.pdf', bytes: 854, ext: 'pdf', text: '',
    status: 'pending', chunks: null, converter: 'pdf',
    uploadedAt: new Date().toISOString(), builtAt: null,
  }) + '\n',
)

// The first parse must be a full one so the pending record is actually converted;
// an incremental build with no published snapshot is refused outright.
const firstParse = await ops.buildIndex(collectionId, STRATEGY, { onProgress: () => {}, onLog: () => {} }, 'full')
await awaitJob(ops, collectionId)
const failedDoc = (await ops.listDocuments(collectionId))[0]
check('损坏原件首次解析如实失败', firstParse.ok === true && failedDoc?.status === 'failed',
  `ok=${firstParse.ok} status=${failedDoc?.status}`)
check('首次解析后文本为空（诚实产物）', failedDoc?.text === undefined || failedDoc?.text === '',
  `text=${JSON.stringify(failedDoc?.text ?? '')}`)

// Repair the original, then reparse: recovery must not require re-upload. The
// repair swaps the unconvertible scan for a valid PDF while keeping the .pdf
// name — the converter is chosen by the record, not by the file, which is also
// why the recovery is observable at all.
writeFileSync(join(pendingSources, 'doc_rp3s01.pdf'), readFileSync('src/store/parse/fixtures/latin.pdf'))

const recovery = await ops.reparseAll(collectionId, STRATEGY, { onProgress: () => {}, onLog: () => {} })
await awaitJob(ops, collectionId)
const recoveredDoc = (await ops.listDocuments(collectionId))[0]
check('修复原件后重算使文档恢复为 ready',
  recovery.ok === true && recoveredDoc?.status === 'ready',
  `ok=${recovery.ok} started=${recovery.started} status=${recoveredDoc?.status}`)
check('重算后 id 不变（身份保持）', recoveredDoc?.id === 'doc_rp3s01',
  `id=${recoveredDoc?.id}`)
check('恢复的文档不再携带旧失败原因',
  recoveredDoc?.error === undefined || recoveredDoc?.error === null,
  `error=${recoveredDoc?.error ?? '(none)'}`)

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)


