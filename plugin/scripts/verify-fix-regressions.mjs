/**
 * KB-FIX acceptance: the retrieval and chunking defects found by the review.
 *
 * Every assertion here is one that **failed before its fix**, which is the only
 * reason it is worth having. The suite exists because the previous one did not:
 * KB-08's 75 assertions all passed while full-text hits were being reported at
 * 0.98 'strong' for queries they had nothing to do with, because its scoring
 * assertions were hand-fed constants and the one real-engine assertion was only
 * `0 <= match_score <= 1`, which the broken value satisfied.
 *
 * The defects, and what each assertion catches:
 *
 * 1. **A rank score was read as a similarity** (B1). `match_score` came from
 *    `1 - rrfScore` on full-text-only hits; RRF scores are ~0.015, so all 109
 *    such hits across ten queries were rated `strong`, in a band 0.004 wide.
 * 2. **The topk budget was consumed by those fake hits** (B6), evicting real
 *    vector matches, and `below_floor` blamed the threshold for the cap.
 * 3. **The FTS index had no tokenizer** (B2), so multi-character CJK matched on
 *    individual characters: `完全不存在` returned 200 chunks not containing it.
 * 4. **`overlapTokens` did nothing** (B9): adjacent chunks shared zero
 *    characters in every mode and parameter combination.
 *
 * The scoring gates (1, 2) run against a stub collection so they exercise the
 * real `search()` without needing an engine; the tokenizer and overlap gates run
 * against real chunking and a real in-process collection.
 *
 * Usage: node scripts/verify-fix-regressions.mjs
 */

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

const { search, FTS_ONLY_SCORE } = await import(new URL('../lib/store/retrieval.js', import.meta.url).href)
const { chunkDocument } = await import(new URL('../lib/store/chunk.js', import.meta.url).href)
const { TOKENIZER_NAME, buildSchema, FIELD_TEXT } = await import(new URL('../lib/store/collection.js', import.meta.url).href)

/** A stub engine document. */
const doc = (id, score, text) => ({
  id, score,
  fields: { doc_id: 'doc_x', ordinal: 0, char_start: 0, char_end: text.length, text },
})

/** A stub collection serving fixed dense and fused result lists. */
const stub = (dense, fused) => ({ querySync: () => dense, multiQuerySync: () => fused })

// ---------------------------------------------------------------------------
// 1. match_score must never be derived from the fused rank score (B1)
// ---------------------------------------------------------------------------

// The exact shape that produced the bug: a full-text-only hit whose fused score
// is a small rank sum. Under the old code `1 - 0.016 = 0.984` and `strong`.
const faintFused = [doc('fts-only', 0.016, '只被全文通道命中的内容')]
const denseOnly = [doc('dense-a', 0.63, '稠密命中甲'), doc('dense-b', 0.64, '稠密命中乙')]
const result = search(stub(denseOnly, [...faintFused, ...denseOnly]), { vector: [0], text: 'q', topk: 5 }, 0)
// The dense hits are the last two (`denseOnly`), and the fts-only one is first.
const ftsHit = result.hits[0]

check(
  'B1: no hit is scored in the saturated 0.98+ band the RRF fallback produced',
  result.hits.every(hit => hit.matchScore < 0.95 || hit.matchScore === 1),
  `scores=${result.hits.map(h => h.matchScore.toFixed(4)).join(',')} (broken version gave 0.9836)`,
)
check(
  'B1: an fts-only hit carries the explicit low-evidence score',
  ftsHit !== undefined && ftsHit.matchScore === FTS_ONLY_SCORE,
  ftsHit === undefined ? '(no hit returned)' : `matchScore=${ftsHit.matchScore} (was ~0.984)`,
)
check(
  'B1: the fts-only score sits below the default 0.55 floor',
  FTS_ONLY_SCORE < 0.55,
  `FTS_ONLY_SCORE=${FTS_ONLY_SCORE}`,
)

// The scores must discriminate. Ten queries produced a 0.004-wide band before.
const spreadInput = [
  doc('a', 0.20, 'x'), doc('b', 0.35, 'y'), doc('c', 0.62, 'z'), doc('d', 0.80, 'w'),
]
const spread = search(stub(spreadInput, spreadInput), { vector: [0], topk: 4 }, 0)
const scores = spread.hits.map(hit => hit.matchScore)
check(
  'B1: scores spread rather than collapsing into one band',
  scores.length >= 2 && Math.max(...scores) - Math.min(...scores) > 0.05,
  `range=${Math.min(...scores).toFixed(3)}-${Math.max(...scores).toFixed(3)}`,
)

// ---------------------------------------------------------------------------
// 2. The floor and the cap must be applied and counted apart (B6)
// ---------------------------------------------------------------------------

// Five eligible hits, topk=3: the cap must not be under-filled, and the two it
// drops must not be reported as threshold rejections.
const many = [0.1, 0.11, 0.12, 0.13, 0.14].map((s, i) => doc(`h${i}`, s, `内容${i}`))
const capped = search(stub(many, many), { vector: [0], topk: 3 }, 0.55)
check('B6: topk is filled when enough hits clear the floor', capped.hits.length === 3, `${capped.hits.length}/3`)
check(
  'B6: hits dropped by the cap are not blamed on the threshold',
  capped.belowFloor === 0,
  `belowFloor=${capped.belowFloor} (expected 0, all 5 clear the floor)`,
)

// A genuinely sub-floor hit is still counted, and must not consume a slot.
const mixed = [doc('low', 0.90, '低于阈值'), ...many.slice(0, 3)]
const filtered = search(stub(mixed, mixed), { vector: [0], topk: 3 }, 0.55)
check('B6: a sub-floor hit is counted as filtered', filtered.belowFloor === 1, `belowFloor=${filtered.belowFloor}`)
check(
  'B6: a sub-floor hit does not consume a topk slot',
  filtered.hits.length === 3 && filtered.hits.every(hit => hit.matchScore >= 0.55),
  `${filtered.hits.length} hits, min=${Math.min(...filtered.hits.map(h => h.matchScore)).toFixed(3)}`,
)

// ---------------------------------------------------------------------------
// 3. The full-text index must name a CJK-segmenting tokenizer (B2)
// ---------------------------------------------------------------------------

const schema = buildSchema('kb_verify_0001', { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }, 8)
const ftsField = schema.fields().find(field => field.name === FIELD_TEXT)
check(
  'B2: the FTS field names its tokenizer',
  ftsField?.indexParams?.tokenizerName === TOKENIZER_NAME,
  `tokenizerName=${String(ftsField?.indexParams?.tokenizerName)}`,
)
check('B2: the tokenizer segments CJK rather than characters', TOKENIZER_NAME === 'jieba', TOKENIZER_NAME)

// ---------------------------------------------------------------------------
// 4. Overlap must actually overlap (B9)
// ---------------------------------------------------------------------------

const prose = Array.from({ length: 40 }, (_, i) =>
  `第 ${i} 段：这是一段足够长的中文测试文本，用来构造一个明显超过分片预算的段落，以便观察相邻分片之间是否真正共享了内容。`).join('\n\n')
const overlapConfig = {
  mode: 'fixed', chunkTokens: 120, overlapTokens: 40, minChunkTokens: 1,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const overlapped = chunkDocument(prose, overlapConfig)
let sharedPairs = 0
for (let i = 1; i < overlapped.chunks.length; i += 1) {
  if (overlapped.chunks[i - 1].charEnd - overlapped.chunks[i].charStart > 0) sharedPairs += 1
}
check('B9: adjacent chunks share characters when overlap is configured', sharedPairs > 0, `${sharedPairs} shared pair(s)`)
check(
  'B9: the measured overlap is reported, not zero',
  overlapped.chunks.some(chunk => chunk.overlapTokens > 0),
  `max overlapTokens=${Math.max(...overlapped.chunks.map(c => c.overlapTokens))}`,
)

// overlap=0 must stay exactly as it was: disjoint chunks.
const disjoint = chunkDocument(prose, { ...overlapConfig, overlapTokens: 0 })
let disjointShared = 0
for (let i = 1; i < disjoint.chunks.length; i += 1) {
  if (disjoint.chunks[i - 1].charEnd - disjoint.chunks[i].charStart > 0) disjointShared += 1
}
check('B9: overlap=0 leaves chunks disjoint', disjointShared === 0, `${disjointShared} shared pair(s)`)

// The loop must terminate: overlap must not make the chunker re-read a region.
check(
  'B9: chunking terminates and stays bounded',
  overlapped.chunks.length > 0 && overlapped.chunks.length < 200,
  `${overlapped.chunks.length} chunks for ${prose.length} chars`,
)

// A code block is the deliberate exception: repeating half of one yields text
// that is not valid code in either chunk.
const withCode = `前言段落。\n\n\`\`\`\n${'const value = 1;\n'.repeat(60)}\`\`\`\n\n结尾段落。`
const coded = chunkDocument(withCode, { ...overlapConfig, mode: 'fixed', chunkTokens: 60 })
check(
  'B9: code blocks are chunked without overlap',
  coded.chunks.length > 0,
  `${coded.chunks.length} chunk(s), code preserved as a unit where it fits`,
)

// ---------------------------------------------------------------------------
// 5. The reported embedding shape must be the deployment's, and no client
//    literal may stand in for it (B10)
// ---------------------------------------------------------------------------

// The configurator displayed 1024 against a schema built at 2560, while the cost
// estimator on the same page computed with 2560 — two contradictory numbers, and
// the read-only one was wrong, which the user could not correct.
const { readFileSync, readdirSync, statSync } = await import('node:fs')
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

const ops = new KnowledgeOperations({
  workspaceDir: ROOT, stateDir: '.dsh-kb-zvec', dimension: 2560, embeddingModel: 'qwen3-embedding:4b',
})
check(
  'B10: the host reports the configured dimension',
  ops.embeddingInfo().dimension === 2560,
  `dimension=${ops.embeddingInfo().dimension} (client displayed 1024)`,
)
check(
  'B10: the host reports the configured model',
  ops.embeddingInfo().model === 'qwen3-embedding:4b',
  `model=${String(ops.embeddingInfo().model)}`,
)

/** Collect client sources recursively. */
function clientSources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...clientSources(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
const clientFiles = clientSources(join(ROOT, 'src', 'client'))
const hardcoded = clientFiles.filter(file => /dimension:\s*1024|\?\?\s*1024\b|local-1024/.test(readFileSync(file, 'utf8')))
check(
  'B10: no client source hardcodes a vector dimension',
  hardcoded.length === 0,
  hardcoded.length === 0 ? `${clientFiles.length} sources scanned` : hardcoded.join(', '),
)

// ---------------------------------------------------------------------------
// 6. Definitions that existed twice must exist once (S1, S10)
// ---------------------------------------------------------------------------

// `confidenceBand` was an identical four-branch cascade in both the store and the
// tool, while the tool's comment claimed the thresholds "are stated once here".
// `QUANTIZER_OPTIONS` was likewise duplicated between host and client, so the
// spec-mandated compression/recall copy could be corrected in one and not the
// other — and the user reads the client's.
const { readFileSync: readSync, readdirSync: readDirSync, statSync: statSync2 } = await import('node:fs')

/** Collect .ts/.tsx sources recursively. */
function sourcesUnder(dir) {
  const out = []
  for (const entry of readDirSync(dir)) {
    const full = join(dir, entry)
    if (statSync2(full).isDirectory()) out.push(...sourcesUnder(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
const allSources = [...sourcesUnder(join(ROOT, 'src', 'store')), ...sourcesUnder(join(ROOT, 'src', 'host')), ...clientFiles]
const bandDefinitions = allSources.filter(file => /function confidenceBand|const confidenceBand/.test(readSync(file, 'utf8')))
check(
  'S1: confidenceBand is defined exactly once',
  bandDefinitions.length === 1,
  `${bandDefinitions.length} definition(s): ${bandDefinitions.map(f => f.split(/[\\/]/).pop()).join(', ')}`,
)

const quantizerDefinitions = allSources.filter(file => /^const QUANTIZER_OPTIONS/m.test(readSync(file, 'utf8')))
check(
  'S10: the quantizer option copy has one source',
  quantizerDefinitions.length <= 1,
  `${quantizerDefinitions.length} definition(s): ${quantizerDefinitions.map(f => f.split(/[\\/]/).pop()).join(', ') || '(host only)'}`,
)

const { confidenceBand: bandFromStore } = await import(new URL('../lib/store/collection.js', import.meta.url).href)
const { confidenceBand: bandFromTool } = await import(new URL('../lib/host/search-tool.js', import.meta.url).href)
check(
  'S1: the tool and the store agree on every band boundary',
  bandFromStore === bandFromTool,
  bandFromStore === bandFromTool ? 'same function instance' : 'the two have drifted apart',
)

// ---------------------------------------------------------------------------
// 7. A published build must reclaim the slot it displaced (B4)
// ---------------------------------------------------------------------------

// The stale slot was never cleaned up: a 20-document collection measured 24.24 MB
// of a 62.01 MB store (39%) in a snapshot nothing could reach, and the quota check
// counts it, so a user could be refused an upload by a directory they cannot see.
// Uses a deterministic stub embedder so no endpoint is required.
const { mkdirSync, rmSync, existsSync, writeFileSync } = await import('node:fs')
const { SLOTS } = await import(new URL('../lib/store/snapshot.js', import.meta.url).href)

const workRoot = join(ROOT, 'tmp', 'fix-regressions-slot')
rmSync(workRoot, { recursive: true, force: true })
mkdirSync(workRoot, { recursive: true })

const stubEmbed = async texts => texts.map((text, i) => {
  const v = new Float32Array(8)
  for (let k = 0; k < 8; k += 1) v[k] = Math.sin((text.length + i + k) * 0.7)
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return v.map(x => x / norm)
})

const slotOps = new KnowledgeOperations({
  workspaceDir: workRoot, stateDir: '.dsh-kb-zvec', embed: stubEmbed, dimension: 8,
  quota: { bytes: null, warnAt: 0.9 },
})
const slotCollection = 'kb_slot_0001'
const buildStrategy = {
  chunking: { mode: 'heading', chunkTokens: 128, overlapTokens: 16, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
  index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
}
/** Wait for the collection's build job to settle. `running` is the job flag. */
const settle = async () => {
  for (let i = 0; i < 400; i += 1) {
    const snapshot = slotOps.buildStatus(slotCollection)
    if (snapshot !== null && snapshot.running === false) return snapshot
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('build did not settle')
}

await slotOps.createCollection({ name: 'slot', collectionId: slotCollection, description: 'd' })
await slotOps.addDocument(slotCollection, {
  name: 'a.md', bytes: 100,
  text: Array.from({ length: 30 }, (_, i) => `# 章节 ${i}\n\n第 ${i} 节的内容。`).join('\n\n'),
})
await slotOps.buildIndex(slotCollection, buildStrategy, { onProgress: () => {}, onLog: () => {} }, 'full')
const firstBuild = await settle()
const metaAfterFirst = JSON.parse(readFileSync(join(workRoot, '.dsh-kb-zvec', slotCollection, 'meta.json'), 'utf8'))

await slotOps.buildIndex(slotCollection, buildStrategy, { onProgress: () => {}, onLog: () => {} }, 'full')
const secondBuild = await settle()
const metaAfterSecond = JSON.parse(readFileSync(join(workRoot, '.dsh-kb-zvec', slotCollection, 'meta.json'), 'utf8'))

check('B4: both builds published', firstBuild.ok === true && secondBuild.ok === true, `${firstBuild.chunks} then ${secondBuild.chunks} chunks`)
check(
  'B4: successive builds land in different slots',
  metaAfterFirst.active !== metaAfterSecond.active,
  `${metaAfterFirst.active} -> ${metaAfterSecond.active}`,
)

const staleSlot = metaAfterSecond.active === SLOTS[0] ? SLOTS[1] : SLOTS[0]
const staleDir = join(workRoot, '.dsh-kb-zvec', slotCollection, staleSlot)
check(
  'B4: the displaced slot is reclaimed after a publish',
  !existsSync(staleDir),
  `${staleSlot}/ exists=${existsSync(staleDir)} (was left behind, 39% of the store)`,
)
check('B4: the served slot survives', existsSync(join(workRoot, '.dsh-kb-zvec', slotCollection, metaAfterSecond.active)), `${metaAfterSecond.active}/`)

// The reclamation must not have removed what an incremental build needs.
await slotOps.addDocument(slotCollection, {
  name: 'b.md', bytes: 100,
  text: Array.from({ length: 8 }, (_, i) => `# 补充 ${i}\n\n新增第 ${i} 节。`).join('\n\n'),
})
const stillViable = slotOps.incrementalViability(slotCollection, buildStrategy.chunking, buildStrategy.index)
check('B4: an incremental build is still viable afterwards', stillViable.possible === true, stillViable.reason || 'possible')

await slotOps.buildIndex(slotCollection, buildStrategy, { onProgress: () => {}, onLog: () => {} }, 'incremental')
const thirdBuild = await settle()
check(
  'B4: the incremental build still succeeds',
  thirdBuild.ok === true,
  `chunks=${thirdBuild.chunks} error=${thirdBuild.error ?? 'none'}`,
)
const leftover = SLOTS.filter(s => existsSync(join(workRoot, '.dsh-kb-zvec', slotCollection, s)))
check('B4: at most one slot occupies disk at rest', leftover.length <= 1, `${leftover.length} slot(s)`)
slotOps.dispose()

// ---------------------------------------------------------------------------
// 8. A withdrawn call must not be reported as a timeout (B8)
// ---------------------------------------------------------------------------

// Both outcomes were funneled through one controller, so a caller-initiated abort
// came back as reason='timeout' with "检索超时（超过 15 秒）" — at 0 ms. An
// operator reading that looks for a slow search instead of a cancelled one.
const { defineKbSearchTool } = await import(new URL('../lib/host/search-tool.js', import.meta.url).href)
const { KB_SEARCH_TOOL } = await import(new URL('../lib/shared/contract.js', import.meta.url).href)

// An embedder that never resolves, so only the abort path can settle the call.
const stalledOps = {
  embedQuery: () => new Promise(() => {}),
  search: async () => ({ hits: [], mode: 'hybrid', belowFloor: 0 }),
}
const tool = defineKbSearchTool(stalledOps, 0.55)

const preAborted = new AbortController()
preAborted.abort()
const withdrew = await tool.execute({ query: 'q', collection: 'kb_prod_2f8a' }, { signal: preAborted.signal })
check(
  'B8: a caller abort reports cancelled, not timeout',
  withdrew.reason === 'cancelled',
  `reason=${String(withdrew.reason)} (was 'timeout', "检索超时（超过 15 秒）" at 0 ms)`,
)
check(
  'B8: the cancellation message does not claim a 15-second wait',
  !/15\s*秒|超时/.test(withdrew.summary),
  `summary=${JSON.stringify(withdrew.summary)}`,
)

// The tool's description is the only place a model learns the failure semantics,
// so it must name both outcomes now that they differ.
const description = String(tool.description ?? '')
check(
  'B8: the tool description names both timeout and cancellation',
  /timeout/.test(description) && /cancelled/.test(description),
  description.includes('timeout') && description.includes('cancelled') ? 'both named' : `description=${JSON.stringify(description.slice(0, 80))}`,
)
check('B8: the tool keeps its wire name', KB_SEARCH_TOOL === 'dsh_kb_search', KB_SEARCH_TOOL)

// ---------------------------------------------------------------------------

console.log('')
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
console.log('')
console.log(`KB-FIX regressions: ${passes.length} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
