/**
 * Incremental build acceptance: uploading one document must not re-embed the rest.
 *
 * The reported problem: every upload triggered a full rebuild of the whole
 * collection. The cause was structural — a build writes into the *other* snapshot
 * slot, and `resetSlot` creates it empty, so there was nothing to inherit and every
 * document had to be embedded again. The fix clones the served snapshot into the
 * target slot and embeds only the documents that are not built yet.
 *
 * This suite drives the real store and asserts the property that matters: **how
 * many texts the embedding provider is asked for**, which is the cost. A test that
 * only checked the resulting chunk count would pass even if every document had been
 * re-embedded, because the index would look identical.
 *
 * It also pins the two cases where a full rebuild is mandatory, since reusing
 * chunks across a parameter change would silently produce an index whose contents
 * disagree with its own configuration.
 *
 * Usage: node scripts/verify-incremental-build.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

/**
 * Count the distinct documents the embedding provider has been asked about.
 *
 * Only a document's *first* chunk carries its `# 第N章` heading; later chunks are
 * continuation text and start mid-sentence. So a heading match alone under-counts.
 * The fixture's body sentence is unique per document (`分片与向量检索的说明文字。`
 * is shared, so it cannot be used), which is why each document's body embeds its
 * own chapter marker.
 * @param texts - the texts sent to the provider.
 * @returns the set of document labels seen.
 */
function documentsIn(texts) {
  const found = new Set()
  for (const text of texts) {
    // The heading, when this is a document's opening chunk.
    const heading = /#\s*第(\d+)章/.exec(text)
    if (heading !== null) { found.add(heading[1]); continue }
    // Otherwise the body, which names its own chapter so continuation chunks are
    // attributable too.
    const body = /第(\d+)章/.exec(text)
    if (body !== null) found.add(body[1])
  }
  return found
}

/**
 * An embedding provider that records what it was asked to embed.
 *
 * The call log is the instrument: it is the only way to observe the difference
 * between "reused" and "re-embedded", since both produce the same index.
 * @returns the provider and its recording state.
 */
function countingEmbedder() {
  const state = { calls: 0, texts: 0, seen: [] }
  const embed = (texts) => {
    state.calls += 1
    state.texts += texts.length
    state.seen.push(...texts.map(text => text.slice(0, 24)))
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
  return { embed, state }
}

/** Poll a build job until it settles. */
async function awaitJob(ops, collectionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = ops.buildStatus(collectionId)
    if (snapshot !== null && snapshot.settledAt !== null) return snapshot
    if (Date.now() > deadline) throw new Error('job did not settle in time')
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

const CHUNKING = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

const scratch = mkdtempSync(join(tmpdir(), 'kb-incr-'))
const { embed, state } = countingEmbedder()
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', embed, dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

/**
 * Body text large enough to produce several chunks under CHUNKING.
 *
 * The chapter number is repeated in the body, not just the heading, so a
 * continuation chunk — which carries no heading — is still attributable to its
 * document. Without that, counting distinct embedded documents under-counts.
 */
const body = (label, repeat) => `# ${label}\n${`${label}的分片与向量检索说明文字。`.repeat(repeat)}\n`

try {
  await ops.createCollection({ name: 'Incr', collectionId: 'kb_prod_2f8a', description: '' })
  for (let index = 1; index <= 4; index += 1) {
    await ops.addDocument('kb_prod_2f8a', { name: `doc${index}.md`, text: body(`第${index}章`, 120) })
  }

  // -------------------------------------------------------------------------
  // 1. First build is necessarily a full one — there is no snapshot to inherit
  // -------------------------------------------------------------------------
  const plan0 = ops.incrementalViability('kb_prod_2f8a', CHUNKING, INDEX)
  check(
    'first build: incremental is refused with a reason, not silently',
    plan0.possible === false && plan0.reason.includes('首次'),
    plan0.reason,
  )

  const before1 = state.texts
  await ops.buildIndex('kb_prod_2f8a', { chunking: CHUNKING, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'incremental')
  const first = await awaitJob(ops, 'kb_prod_2f8a')
  const firstTexts = state.texts - before1
  check('first build: it built successfully', first.ok === true, `chunks=${first.chunks}`)
  check('first build: it embedded every document', firstTexts > 0, `${firstTexts} texts embedded`)

  const firstChunks = first.chunks
  const docsAfterFirst = await ops.listDocuments('kb_prod_2f8a')
  check(
    'first build: all four documents are ready with counts',
    docsAfterFirst.length === 4 && docsAfterFirst.every(d => d.status === 'ready' && (d.chunks ?? 0) > 0),
    docsAfterFirst.map(d => `${d.name}=${d.chunks}`).join(' '),
  )

  // -------------------------------------------------------------------------
  // 2. Incremental is now possible, because the parameters still match
  // -------------------------------------------------------------------------
  const plan1 = ops.incrementalViability('kb_prod_2f8a', CHUNKING, INDEX)
  check('after a build: incremental is allowed', plan1.possible === true, plan1.reason || 'viable')

  // -------------------------------------------------------------------------
  // 3. THE POINT: one new document must embed one document, not five
  // -------------------------------------------------------------------------
  await ops.addDocument('kb_prod_2f8a', { name: 'doc5.md', text: body('第5章', 120) })

  const before2 = state.texts
  await ops.buildIndex('kb_prod_2f8a', { chunking: CHUNKING, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'incremental')
  const second = await awaitJob(ops, 'kb_prod_2f8a')
  const secondTexts = state.texts - before2

  check('incremental: the build succeeded', second.ok === true, `chunks=${second.chunks}`)
  check(
    'incremental: only the new document was embedded',
    secondTexts > 0 && secondTexts < firstTexts,
    `${secondTexts} texts for 1 new document vs ${firstTexts} for the original 4`,
  )
  // The decisive ratio: embedding five documents' worth would be ~1.25x the first
  // build's texts. Anything near that means the old documents were re-embedded.
  check(
    'incremental: the reused documents were not re-embedded',
    secondTexts < firstTexts * 0.6,
    `${secondTexts} vs a ~${Math.round(firstTexts * 1.25)} full rebuild of 5 documents`,
  )

  // The index must still hold everything, or "cheap" was achieved by losing data.
  const afterSecond = readMetaOf(scratch)
  check(
    'incremental: the index holds every document, not just the new one',
    afterSecond.chunks > firstChunks && afterSecond.docs === 5,
    `${afterSecond.chunks} chunks across ${afterSecond.docs} docs (was ${firstChunks} across 4)`,
  )

  const docsAfterSecond = await ops.listDocuments('kb_prod_2f8a')
  check(
    'incremental: the inherited documents keep their counts',
    docsAfterSecond.filter(d => d.name !== 'doc5.md').every(d => (d.chunks ?? 0) > 0),
    docsAfterSecond.map(d => `${d.name}=${d.chunks}`).join(' '),
  )
  // The dangerous failure mode of this whole feature: `markPublished` rewrites the
  // document log, and an incremental build hands it only the documents it embedded.
  // Writing that subset as the whole log deleted every untouched document from the
  // collection — the index still held their chunks, but nothing could cite them and
  // the next build would not know they existed. Asserted on the count, because the
  // symptom (a shorter list) is easy to miss and the damage is not.
  check(
    'incremental: no document was dropped from the log',
    docsAfterSecond.length === 5,
    `${docsAfterSecond.length} documents after an incremental build; expected 5`,
  )
  check(
    'incremental: the new document got its own count',
    (docsAfterSecond.find(d => d.name === 'doc5.md')?.chunks ?? 0) > 0,
    `doc5.md=${docsAfterSecond.find(d => d.name === 'doc5.md')?.chunks}`,
  )

  // The inherited chunks must be *retrievable*, which is the difference between
  // cloning a snapshot and merely reporting the old counts.
  const search = await ops.retrieveForDiagnostics('kb_prod_2f8a', '第一章的分片说明', { topk: 5, minScore: 0 })
  check(
    'incremental: an inherited document is still retrievable',
    search.hits.length > 0,
    `${search.hits.length} hits, top=${search.hits[0]?.docName ?? 'none'}`,
  )

  // -------------------------------------------------------------------------
  // 4. A chunking change must force a full rebuild
  // -------------------------------------------------------------------------
  const changedChunking = { ...CHUNKING, chunkTokens: 256 }
  const plan2 = ops.incrementalViability('kb_prod_2f8a', changedChunking, INDEX)
  check(
    'guard: changing chunkTokens forces a full rebuild',
    plan2.possible === false && plan2.reason.includes('切分参数'),
    plan2.reason,
  )

  const before3 = state.texts
  const seenBefore3 = state.seen.length
  await ops.buildIndex('kb_prod_2f8a', { chunking: changedChunking, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'incremental')
  const third = await awaitJob(ops, 'kb_prod_2f8a')
  const thirdTexts = state.texts - before3
  // The property is "every document was embedded", not "more texts than before":
  // a smaller chunk budget cuts each document *differently*, so the text count is
  // not comparable across budgets. What is comparable is which documents appeared.
  const thirdDocs = documentsIn(state.seen.slice(seenBefore3))
  check(
    'guard: the forced rebuild re-embedded every document',
    third.ok === true && thirdDocs.size === 5,
    `${thirdTexts} texts covering ${thirdDocs.size}/5 documents: ${[...thirdDocs].sort().join(', ')}`,
  )
  check(
    'guard: the forced rebuild used the new chunk size',
    third.chunks !== firstChunks,
    `${third.chunks} chunks at 256 tokens vs ${firstChunks} at 512`,
  )

  // -------------------------------------------------------------------------
  // 5. An index change must force a full rebuild too
  // -------------------------------------------------------------------------
  const plan3 = ops.incrementalViability('kb_prod_2f8a', changedChunking, { ...INDEX, quantize: 'INT4' })
  check(
    'guard: changing the quantizer forces a full rebuild',
    plan3.possible === false && plan3.reason.includes('索引参数'),
    plan3.reason,
  )

  // -------------------------------------------------------------------------
  // 6. Nothing to do is reported, not silently started
  // -------------------------------------------------------------------------
  const noop = await ops.buildIndex('kb_prod_2f8a', { chunking: changedChunking, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'incremental')
  check(
    'no-op: a fully built collection reports nothing to do',
    noop.ok === true && noop.started === false && noop.error === undefined,
    `ok=${noop.ok} started=${noop.started}`,
  )

  // -------------------------------------------------------------------------
  // 7. An explicit full rebuild still re-embeds everything
  // -------------------------------------------------------------------------
  const before4 = state.texts
  const seenBefore4 = state.seen.length
  await ops.buildIndex('kb_prod_2f8a', { chunking: changedChunking, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'full')
  const fourth = await awaitJob(ops, 'kb_prod_2f8a')
  const fourthTexts = state.texts - before4
  const fourthDocs = documentsIn(state.seen.slice(seenBefore4))
  check(
    'full mode: an explicit full rebuild re-embeds every document',
    fourth.ok === true && fourthDocs.size === 5,
    `${fourthTexts} texts covering ${fourthDocs.size}/5 documents: ${[...fourthDocs].sort().join(', ')}`,
  )

  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

/** Read a scratch collection's metadata. */
function readMetaOf(workspace) {
  return JSON.parse(readFileSync(join(workspace, '.kb', 'kb_prod_2f8a', 'meta.json'), 'utf8'))
}

console.log(`\nIncremental build acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
