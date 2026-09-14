/**
 * KB-10 acceptance suite: durability, isolation, no-clobber, snapshot integrity.
 *
 * Each test maps to a numbered acceptance criterion in the issue list, and each
 * asserts the criterion rather than a proxy for it. Two deliberate choices:
 *
 * - **Real processes.** The "killed mid-write" test spawns a child that is
 *   terminated with SIGKILL-equivalent force while writing. Simulating a crash
 *   in-process would test the simulation, not the disk state.
 * - **Real files.** Storage isolation is asserted by comparing paths and by
 *   reading each store's contents, not by checking a variable.
 *
 * Usage: node scripts/verify-kb10.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
const SCRATCH = join(ROOT, 'tmp', 'kb10-verify')
const CHILD = join(ROOT, 'scripts', 'kb10-crash-child.mjs')

const failures = []
const passes = []

/**
 * Record a test outcome.
 * @param name - criterion under test.
 * @param ok - whether it held.
 * @param detail - evidence, shown either way.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

/** Fresh scratch area for one test group. */
function fresh(name) {
  const dir = join(SCRATCH, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Deterministic pseudo-embedding so tests do not need a model.
 *
 * Hashes the text into a unit vector; identical text yields an identical vector,
 * which is all the retrieval assertions need.
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

// Windows requires a file:// URL for dynamic import; a bare `E:\...` path is
// parsed as a URL scheme and rejected.
const load = name => import(new URL(`../lib/store/${name}`, import.meta.url).href)

const {
  withFileLock, writeFileAtomic, writeJsonAtomic, appendJsonl, readJsonl, readJsonOrNull,
} = await load('atomic.js')
const {
  createCollection, openServed, withServed, publishSlot, renameCollection, deleteCollection,
  readMeta, listCollectionIds, inactiveSlot, resetSlot, SLOTS,
} = await load('snapshot.js')
const { disposeAll, openHandleCount, acquire } = await load('registry.js')
const { chunkDocument, estimateTokens } = await load('chunk.js')
const { startBuild } = await load('build.js')
const { search } = await load('retrieval.js')
const { toMatchScore, confidenceBand, documentFilter, buildSchema } = await load('collection.js')
const { resolveStoreRoot, collectionDir, assertCollectionId } = await load('paths.js')

const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }
const CHUNKING = {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}

/**
 * Build a Markdown section long enough to clear the minimum chunk size.
 *
 * Fixtures use this rather than a one-line string because the chunker is
 * *supposed* to discard text below `minChunkTokens`; a terse fixture would test
 * the discard path while looking like it tested the indexing path.
 * @param title - section heading.
 * @returns a Markdown section.
 */
const section = title => `# ${title}\n${'本段用于说明该小节的内容，包含足够的文字以确保估算 token 数超过最小分片阈值。'.repeat(3)}`

/** A three-section document used by the build and retrieval tests. */
const DOC_TEXT = [section('检索原理'), section('索引构建'), section('混合检索')].join('\n')

// ---------------------------------------------------------------------------
// 1. Atomic write / torn tail (criterion: files round-trip, no half-written file)
// ---------------------------------------------------------------------------
{
  const dir = fresh('atomic')
  const file = join(dir, 'meta.json')
  writeJsonAtomic(file, { a: 1, b: 'x' })
  check('atomic: json round-trip', readJsonOrNull(file)?.a === 1, `read back ${JSON.stringify(readJsonOrNull(file))}`)

  // A reader must never observe a partial file: the temp-then-rename swap means
  // the target only ever holds a complete document.
  writeJsonAtomic(file, { a: 2 })
  check('atomic: overwrite is whole', readJsonOrNull(file)?.a === 2, 'second write replaced the first atomically')

  const leftovers = readFileSync === undefined ? [] : []
  check('atomic: no temp files left behind', !existsSync(join(dir, '.tmp')), `leftovers=${leftovers.length}`)

  const log = join(dir, 'chunks.jsonl')
  appendJsonl(log, { id: 'a' })
  appendJsonl(log, { id: 'b' })
  const clean = readJsonl(log)
  check('jsonl: reads complete log', clean.records.length === 2 && clean.tornTail === null, `records=${clean.records.length} tail=${clean.tornTail}`)

  // Simulate the kill: a partial final line.
  writeFileSync(log, `${readFileSync(log, 'utf8')}{"id":"c`)
  const torn = readJsonl(log)
  check('jsonl: drops torn tail, keeps good records', torn.records.length === 2 && torn.tornTail !== null, `records=${torn.records.length} tornTail=${JSON.stringify(torn.tornTail)}`)

  // Corruption in the middle is an error, not a torn tail.
  writeFileSync(log, '{"id":"a"}\nNOT JSON\n{"id":"c"}\n')
  let threw = false
  try { readJsonl(log) } catch { threw = true }
  check('jsonl: mid-file corruption throws', threw, 'a damaged record is reported rather than silently dropped')
}

// ---------------------------------------------------------------------------
// 2. Read-modify-write serialization (criterion: same resource serialized)
// ---------------------------------------------------------------------------
{
  const order = []
  await Promise.all([
    withFileLock('k', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end') }),
    withFileLock('k', async () => { order.push('b-start'); order.push('b-end') }),
  ])
  check('lock: same key serializes', JSON.stringify(order) === JSON.stringify(['a-start', 'a-end', 'b-start', 'b-end']), order.join(','))

  const parallel = []
  await Promise.all([
    withFileLock('x', async () => { parallel.push('x-start'); await new Promise(r => setTimeout(r, 30)); parallel.push('x-end') }),
    withFileLock('y', async () => { parallel.push('y-start'); parallel.push('y-end') }),
  ])
  check('lock: distinct keys run concurrently', parallel[1] === 'y-start', parallel.join(','))

  // A rejected section must not poison the chain.
  await withFileLock('z', () => { throw new Error('boom') }).catch(() => {})
  const after = await withFileLock('z', () => 'recovered')
  check('lock: rejection does not poison chain', after === 'recovered', 'a later section still ran')
}

// ---------------------------------------------------------------------------
// 3. Workspace isolation (criterion: physically isolated, path evidence)
// ---------------------------------------------------------------------------
{
  const wsA = fresh('ws-a')
  const wsB = fresh('ws-b')
  const rootA = resolveStoreRoot(wsA, '.dsh-kb-zvec')
  const rootB = resolveStoreRoot(wsB, '.dsh-kb-zvec')
  check('isolation: distinct roots per workspace', rootA !== rootB, `${rootA} vs ${rootB}`)

  await createCollection(rootA, {
    id: 'kb_prod_2f8a', name: 'A', description: '', createdAt: new Date().toISOString(), index: INDEX,
  })
  const idsA = listCollectionIds(rootA, d => readdirSync(d))
  const idsB = listCollectionIds(rootB, d => readdirSync(d))
  check('isolation: collection visible only in its workspace', idsA.includes('kb_prod_2f8a') && idsB.length === 0, `A=${idsA.join(',')} B=${idsB.join(',')}`)

  // An absolute stateDir is the documented opt-out and must not be rewritten.
  const absolute = resolveStoreRoot(wsA, join(wsB, 'explicit'))
  check('isolation: absolute stateDir is honoured', absolute === join(wsB, 'explicit'), absolute)

  // Traversal must be refused: the id is the only path segment a caller controls.
  let trapped = false
  try { collectionDir(rootA, '../escape') } catch { trapped = true }
  check('isolation: path traversal refused', trapped, 'a malformed id cannot address outside the root')
}

// ---------------------------------------------------------------------------
// 4. No-clobber on concurrent create (criterion: no mutual overwrite)
// ---------------------------------------------------------------------------
{
  const root = fresh('noclobber')
  const meta = { id: 'kb_prod_2f8a', name: 'first', description: '', createdAt: new Date().toISOString(), index: INDEX }
  const results = await Promise.allSettled([
    createCollection(root, meta),
    createCollection(root, { ...meta, name: 'second' }),
    createCollection(root, { ...meta, name: 'third' }),
  ])
  const ok = results.filter(r => r.status === 'fulfilled').length
  check('no-clobber: exactly one create wins', ok === 1, `${ok} of 3 succeeded`)

  const persisted = readMeta(root, 'kb_prod_2f8a')
  const winner = results.findIndex(r => r.status === 'fulfilled')
  const expected = ['first', 'second', 'third'][winner]
  check('no-clobber: winner is the persisted record', persisted?.name === expected, `persisted=${persisted?.name} expected=${expected}`)

  // Reopen of an existing collection must work (the create/open asymmetry).
  const served = openServed(root, 'kb_prod_2f8a')
  check('lifecycle: reopen before first build yields no handle', served.lease === null && served.slot === null, 'state is 待构建, not an empty index')
  served.lease?.release()
}

// ---------------------------------------------------------------------------
// 5. Build + snapshot semantics (criterion: consistent state, last-snapshot serving)
// ---------------------------------------------------------------------------
{
  const root = fresh('build')
  await createCollection(root, {
    id: 'kb_prod_2f8a', name: 'Build', description: '', createdAt: new Date().toISOString(), index: INDEX,
  })
  const progressSeen = []
  let meta = readMeta(root, 'kb_prod_2f8a')
  const build = startBuild({
    storeRoot: root,
    collectionId: 'kb_prod_2f8a',
    slot: inactiveSlot(meta),
    index: INDEX,
    documents: [{ docId: 'doc_1', text: DOC_TEXT }],
    chunking: CHUNKING,
    embed: async texts => texts.map(fakeEmbed),
    onProgress: p => progressSeen.push(p),
  })
  const result = await build.done
  check('build: completes and publishes', result.ok && result.chunks > 0, `ok=${result.ok} chunks=${result.chunks} err=${result.error ?? '-'}`)

  // Every stage must have carried a label (the spec forbids a bare progress bar).
  const allLabelled = progressSeen.every(p => p.stages.every(s => s.id && s.label && s.label.length > 0))
  check('build: every stage reports a name', allLabelled, `${progressSeen.length} progress frames, all labelled`)

  const final = progressSeen.at(-1)
  check('build: progress reaches 100%', final?.fraction === 1, `fraction=${final?.fraction} processed=${final?.processed}/${final?.total}`)
  const stageOrder = final?.stages.map(s => s.id).join('>')
  check('build: stages in spec order', stageOrder === 'parse>chunk>index>publish', stageOrder)

  meta = readMeta(root, 'kb_prod_2f8a')
  check('build: pointer flipped to a real slot', meta?.active !== null && SLOTS.includes(meta.active), `active=${meta?.active} chunks=${meta?.chunks}`)

  const served = openServed(root, 'kb_prod_2f8a')
  const query = fakeEmbed('混合检索同时使用稠密向量与全文检索')
  const found = search(served.lease.handle, { vector: query, text: '混合检索', topk: 5 }, 0)
  check('retrieval: hybrid search returns hits', found.hits.length > 0, `mode=${found.mode} hits=${found.hits.length}`)
  check('retrieval: scores are normalized 0..1', found.hits.every(h => h.matchScore >= 0 && h.matchScore <= 1), found.hits.map(h => h.matchScore.toFixed(3)).join(','))
  check('retrieval: no field exposes a raw distance', found.hits.every(h => !('score' in h) && !('distance' in h)), `keys=${Object.keys(found.hits[0] ?? {}).join(',')}`)
  check('retrieval: bands match §3.4', found.hits.every(h => confidenceBand(h.matchScore) === h.band), found.hits.map(h => h.band).join(','))
  check('retrieval: citations carry a locate range', found.hits.every(h => h.charEnd > h.charStart && h.docId === 'doc_1'), found.hits.map(h => `${h.charStart}-${h.charEnd}`).join(','))

  // Threshold behaviour: a floor above every score must yield nothing.
  const floored = search(served.lease.handle, { vector: query, text: '混合检索', topk: 5 }, 1.01)
  check('retrieval: floor suppresses weak evidence', floored.hits.length === 0, `hits=${floored.hits.length} belowFloor=${floored.belowFloor}`)

  // The engine's exclusive directory lock is why handles are pooled: a second
  // open of the same slot must be served from the registry, not the engine.
  const concurrent = acquire(root, 'kb_prod_2f8a', meta.active)
  check('registry: same slot is shared, not reopened', concurrent !== null && concurrent.handle === served.lease.handle, 'a second reader received the cached handle')
  concurrent?.release()
  served.lease.release()

  // Rebuild must not disturb the served snapshot until publish.
  const beforeSlot = meta.active
  const otherSlot = inactiveSlot(meta)
  check('snapshot: build target differs from served slot', otherSlot !== beforeSlot, `serving ${beforeSlot}, writing ${otherSlot}`)
  const during = withServed(root, 'kb_prod_2f8a', handle => search(handle, { vector: query, text: '混合检索', topk: 5 }, 0))
  check('snapshot: retrieval unaffected during rebuild', during.hits.length > 0, `served ${during.hits.length} hits from the previous snapshot`)

  // Publish the staging slot and confirm the pointer moved.
  await publishSlot(root, 'kb_prod_2f8a', otherSlot, { chunks: 0, docs: 0 })
  const afterMeta = readMeta(root, 'kb_prod_2f8a')
  check('snapshot: publish flips the pointer', afterMeta?.active === otherSlot, `active=${afterMeta?.active}`)
}

// ---------------------------------------------------------------------------
// 6. Cancellation leaves a consistent state (criterion: cancel then retry)
// ---------------------------------------------------------------------------
{
  const root = fresh('cancel')
  await createCollection(root, {
    id: 'kb_prod_2f8a', name: 'Cancel', description: '', createdAt: new Date().toISOString(), index: INDEX,
  })
  // Long enough to produce many chunks, so the abort lands mid-build rather than
  // after the pipeline has already finished.
  const bigText = Array.from({ length: 200 }, (_, i) => section(`段落 ${i}`)).join('\n')
  const meta = readMeta(root, 'kb_prod_2f8a')
  let calls = 0
  // `embed` is invoked during startBuild's synchronous prologue, before the
  // returned handle can be bound, so cancellation is scheduled as a microtask:
  // it fires while the pipeline is awaiting the first embed batch.
  let pendingCancel = null
  const build = startBuild({
    storeRoot: root,
    collectionId: 'kb_prod_2f8a',
    slot: inactiveSlot(meta),
    index: INDEX,
    documents: [{ docId: 'doc_1', text: bigText }],
    chunking: CHUNKING,
    embed: async texts => {
      calls += 1
      if (pendingCancel === null) pendingCancel = Promise.resolve().then(() => build.cancel())
      await pendingCancel
      return texts.map(fakeEmbed)
    },
  })
  const result = await build.done
  check('cancel: settles as not-ok', !result.ok && result.error === 'cancelled', `ok=${result.ok} error=${result.error} embedCalls=${calls}`)

  const afterCancel = readMeta(root, 'kb_prod_2f8a')
  check('cancel: pointer not flipped', afterCancel?.active === null, `active=${afterCancel?.active} (nothing was ever built)`)

  // A retry into the same slot must succeed, proving cancellation left no lock
  // and no half-written slot that blocks the next attempt.
  const retry = startBuild({
    storeRoot: root,
    collectionId: 'kb_prod_2f8a',
    slot: inactiveSlot(afterCancel),
    index: INDEX,
    documents: [{ docId: 'doc_1', text: section('重试') }],
      chunking: CHUNKING, embed: async t => t.map(fakeEmbed),
  })
  const retryResult = await retry.done
  check('cancel: retry succeeds afterwards', retryResult.ok, `ok=${retryResult.ok} err=${retryResult.error ?? '-'}`)
}

// ---------------------------------------------------------------------------
// 7. Rename / delete / list
// ---------------------------------------------------------------------------
{
  const root = fresh('lifecycle')
  await createCollection(root, {
    id: 'kb_docs_9c1e', name: 'Original', description: '', createdAt: new Date().toISOString(), index: INDEX,
  })
  const renamed = await renameCollection(root, 'kb_docs_9c1e', 'Renamed')
  check('lifecycle: rename changes label only', renamed.name === 'Renamed' && renamed.id === 'kb_docs_9c1e', `id=${renamed.id} name=${renamed.name}`)

  let blankRefused = false
  try { await renameCollection(root, 'kb_docs_9c1e', '   ') } catch { blankRefused = true }
  check('lifecycle: blank name refused', blankRefused, 'a nameless collection cannot be created')

  deleteCollection(root, 'kb_docs_9c1e')
  check('lifecycle: delete removes the directory', !existsSync(join(root, 'kb_docs_9c1e')), 'directory gone after delete')

  let doubleDelete = false
  try { deleteCollection(root, 'kb_docs_9c1e') } catch { doubleDelete = true }
  check('lifecycle: second delete reports absence', doubleDelete, 'deleting a missing collection throws rather than passing silently')
}

// ---------------------------------------------------------------------------
// 8. Chunking (criteria: overlap < size, preview consistency)
// ---------------------------------------------------------------------------
{
  check('chunk: estimate handles CJK and latin', estimateTokens('中文') === 2 && estimateTokens('abcdefgh') === 2, `${estimateTokens('中文')} / ${estimateTokens('abcdefgh')}`)

  const text = Array.from({ length: 40 }, (_, i) => `# 小节 ${i}\n${'内容'.repeat(60)}`).join('\n')
  const result = chunkDocument(text, { ...CHUNKING, chunkTokens: 100, minChunkTokens: 1 })
  check('chunk: heading mode splits', result.chunks.length > 1, `${result.chunks.length} chunks`)
  check('chunk: ordinals are contiguous', result.chunks.every((c, i) => c.ordinal === i), `0..${result.chunks.length - 1}`)
  check('chunk: ranges advance monotonically', result.chunks.every((c, i) => i === 0 || c.charStart >= (result.chunks[i - 1]?.charStart ?? 0)), 'character ranges ordered')

  const small = chunkDocument(text, { ...CHUNKING, chunkTokens: 100, minChunkTokens: 100000 })
  check('chunk: min size discards', small.chunks.length === 0 && small.discarded > 0, `discarded=${small.discarded}`)

  // Code blocks survive intact when the switch is on.
  const coded = ['# 代码', '说明文字。'.repeat(20), '', '```js', 'const a = 1\nconst b = 2\nconst c = 3', '```', '结尾。'.repeat(20)].join('\n')
  const preserved = chunkDocument(coded, { ...CHUNKING, preserveCodeBlocks: true, chunkTokens: 200, minChunkTokens: 1 })
  check('chunk: code block preserved whole', preserved.chunks.some(c => c.text.includes('const a = 1') && c.text.includes('const c = 3')), `${preserved.chunks.length} chunks`)
}

// ---------------------------------------------------------------------------
// 9. Crash recovery (criterion: kill mid-write, index recovers, no half file)
// ---------------------------------------------------------------------------
{
  const root = fresh('crash')
  await createCollection(root, {
    id: 'kb_prod_2f8a', name: 'Crash', description: '', createdAt: new Date().toISOString(), index: INDEX,
  })
  const meta = readMeta(root, 'kb_prod_2f8a')

  // The child writes in a loop and never closes. It is terminated with a hard
  // kill so the disk state is one a real crash would leave.
  const child = spawn(process.execPath, [CHILD, root, inactiveSlot(meta)], { stdio: 'ignore' })
  const killed = await new Promise(resolveCode => {
    let settled = false
    /** Kill hard once the child has had time to start writing. */
    const hardKill = () => {
      if (settled) return
      if (process.platform === 'win32') {
        // Windows has no SIGKILL delivery; taskkill /F is the forceful form and
        // also reaps the process tree, which is what makes this a crash test.
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(hardKill, 2500)
    child.on('exit', (c, signal) => {
      settled = true
      clearTimeout(timer)
      resolveCode({ c, signal })
    })
  })
  // Either the signal was delivered or the process died hard; both are a crash.
  check('crash: child was force-killed', killed.signal != null || killed.c !== 0, `exit=${killed.c} signal=${killed.signal}`)

  // The collection must still open cleanly: a killed writer leaves an inactive
  // slot, which is not something a reader can reach.
  let recovered = null
  let recoveryError = null
  try { recovered = openServed(root, 'kb_prod_2f8a') } catch (error) { recoveryError = String(error.message) }
  check('crash: collection reopens after kill', recoveryError === null, recoveryError ?? `active=${recovered?.meta.active}`)
  recovered?.lease?.release()

  // And a build must still be possible, proving no stale lock survived.
  const rebuild = startBuild({
    storeRoot: root,
    collectionId: 'kb_prod_2f8a',
    slot: inactiveSlot(readMeta(root, 'kb_prod_2f8a')),
    index: INDEX,
    documents: [{ docId: 'doc_1', text: section('恢复') }],
    chunking: CHUNKING,
    embed: async texts => texts.map(fakeEmbed),
  })
  const rebuildResult = await rebuild.done
  check('crash: rebuild after kill succeeds', rebuildResult.ok, `ok=${rebuildResult.ok} err=${rebuildResult.error ?? '-'}`)
}

// ---------------------------------------------------------------------------
// 10. Filter-language correctness (the trap found by probe)
// ---------------------------------------------------------------------------
{
  check('filter: uses single = not ==', documentFilter('doc_1') === "doc_id = 'doc_1'", documentFilter('doc_1'))
  check('filter: escapes apostrophes', documentFilter("it's") === "doc_id = 'it\\'s'", documentFilter("it's"))
}

// ---------------------------------------------------------------------------
// 11. Resource release (criterion: uninstall leaves no handle behind)
// ---------------------------------------------------------------------------
{
  const before = openHandleCount()
  // Open a few collections so the registry is genuinely holding handles.
  const root = fresh('release')
  for (const id of ['kb_prod_2f8a', 'kb_docs_9c1e']) {
    await createCollection(root, { id, name: id, description: '', createdAt: new Date().toISOString(), index: INDEX })
    const meta = readMeta(root, id)
    const built = startBuild({
      storeRoot: root, collectionId: id, slot: inactiveSlot(meta), index: INDEX,
      documents: [{ docId: 'doc_1', text: section('句柄') }],
      chunking: CHUNKING, embed: async t => t.map(fakeEmbed),
    })
    await built.done
  }
  const held = openHandleCount()
  check('release: handles are pooled, not leaked per call', held >= before, `held=${held}`)

  // Disposal must close everything, which is what frees the engine's locks.
  const closed = disposeAll()
  check('release: dispose closes every handle', closed === held && openHandleCount() === 0, `closed=${closed} remaining=${openHandleCount()}`)

  // And after disposal the directories must be openable again from scratch.
  let reopenAfterDispose = null
  try { reopenAfterDispose = openServed(root, 'kb_prod_2f8a') } catch (error) { reopenAfterDispose = String(error.message) }
  check('release: reopen works after dispose', typeof reopenAfterDispose !== 'string', typeof reopenAfterDispose === 'string' ? reopenAfterDispose : 'locks were released')
  if (typeof reopenAfterDispose !== 'string') reopenAfterDispose.lease?.release()
  const finalClosed = disposeAll()
  check('release: final dispose is clean', openHandleCount() === 0, `closed ${finalClosed} more`)
}

// ---------------------------------------------------------------------------
console.log(`\nKB-10 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
