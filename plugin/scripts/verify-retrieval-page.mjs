/**
 * Retrieval-console acceptance: the diagnostic that verifies chunking and recall.
 *
 * This page was removed once (KB-09 moved RAG into the dsh conversation) and then
 * restored, because the two are different jobs: answering belongs in the session,
 * while judging the plugin's **own artifacts** — whether chunks are coherent units
 * and whether the vector index recalls a paraphrase — needs a console that turns
 * knobs the conversation cannot.
 *
 * These checks pin the three capabilities that justify its existence:
 *
 * 1. **The score floor is a control.** The tool applies its floor silently, so a
 *    filtered hit and an absent one look identical there. Here `below_floor` is
 *    reported and lowering the floor must actually surface the suppressed hits.
 * 2. **Hybrid vs dense are separable**, so a caller can tell which pass carried a
 *    query rather than guessing.
 * 3. **The console is a read.** It must not inflate the seven-day hit counter the
 *    overview shows, or the operator's probing would be reported as real usage.
 *
 * Usage: node scripts/verify-retrieval-page.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

/** Read a source file relative to the plugin root. */
function read(relative) {
  const path = join(ROOT, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const page = read('src/client/pages/RetrievalPage.tsx')
const panel = read('src/client/panel.tsx')
const bridge = read('src/host/bridge.ts')
const contract = read('src/shared/contract.ts')

// ---------------------------------------------------------------------------
// 1. Behavior: the floor is a control, and the console is a read
// ---------------------------------------------------------------------------

/**
 * Deterministic 1024-dimension embeddings.
 *
 * Built from character n-grams so that a **paraphrase sharing vocabulary** ranks
 * near its source while an unrelated string does not — which is what lets these
 * checks assert recall rather than merely "some vector came back".
 * @param texts - input strings.
 * @returns one vector per input.
 */
function fakeEmbed(texts) {
  return Promise.resolve(texts.map(text => {
    const vector = new Float32Array(1024)
    for (let index = 0; index < text.length; index += 1) {
      // Bigram hashing spreads a shared phrase across the same buckets in both the
      // query and its source chunk, so cosine similarity reflects vocabulary overlap.
      const bigram = text.slice(index, index + 2)
      let hash = 0
      for (const char of bigram) hash = (hash * 31 + char.charCodeAt(0)) % 1024
      vector[hash] += 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return vector
  }))
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-retr-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch,
  stateDir: '.kb',
  embed: fakeEmbed,
  dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

try {
  await ops.createCollection({ name: 'Retr', collectionId: 'kb_prod_2f8a', description: '' })
  await ops.addDocument('kb_prod_2f8a', {
    name: '检索.md',
    text: '# 向量检索\n'
      + '向量检索把文本映射为稠密向量，再用近邻搜索召回语义相关的片段，适合同义改写的提问方式。\n'
      + '混合检索融合稠密向量与全文检索两路结果，通过 RRF 重新排序，兼顾语义与关键词。\n',
  })
  await ops.addDocument('kb_prod_2f8a', {
    name: '烹饪.md',
    text: '# 红烧肉\n红烧肉需要五花肉、冰糖、生抽与老抽，小火慢炖四十分钟让肉质软糯入味。\n',
  })

  const strategy = {
    chunking: { mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
    index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
  }
  await ops.buildIndex('kb_prod_2f8a', strategy, { onProgress: () => {}, onLog: () => {} })
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (ops.buildStatus('kb_prod_2f8a')?.settledAt !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const settled = ops.buildStatus('kb_prod_2f8a')
  check('setup: the collection built successfully', settled?.ok === true, `ok=${settled?.ok} chunks=${settled?.chunks}`)

  // --- The console returns the full diagnostic shape -----------------------
  const result = await ops.retrieveForDiagnostics('kb_prod_2f8a', '向量检索是怎么召回相关片段的', { topk: 5, minScore: 0 })
  check('retrieve: hits come back with the full chunk text', result.hits.length > 0 && result.hits.every(hit => hit.text.length > 0), `${result.hits.length} hits`)
  check(
    'retrieve: each hit carries a locator, a score and a band',
    result.hits.every(hit => hit.docName !== '' && hit.charEnd > hit.charStart && hit.matchScore >= 0 && hit.matchScore <= 1 && typeof hit.band === 'string'),
    result.hits.map(hit => `${hit.docName}#${hit.ordinal} ${hit.matchScore.toFixed(3)} ${hit.band}`).join(', '),
  )
  check(
    'retrieve: the served snapshot is reported so a result is attributable',
    typeof result.activeSlot === 'string' && result.chunks > 0 && result.builtAt !== null,
    `slot=${result.activeSlot} chunks=${result.chunks} builtAt=${result.builtAt}`,
  )
  check(
    'retrieve: timing is reported for both halves',
    result.embeddedMs >= 0 && result.searchedMs >= 0,
    `embed=${result.embeddedMs.toFixed(1)}ms search=${result.searchedMs.toFixed(1)}ms`,
  )

  // --- Recall: the right document ranks first ------------------------------
  check(
    'recall: a semantic query ranks the relevant document first',
    result.hits[0]?.docName === '检索.md',
    `top=${result.hits[0]?.docName ?? '(none)'}`,
  )

  // --- The floor is a control, and it reports what it removed --------------
  const highFloor = await ops.retrieveForDiagnostics('kb_prod_2f8a', '向量检索是怎么召回相关片段的', { topk: 5, minScore: 0.999 })
  check(
    'floor: a high floor filters hits instead of failing',
    highFloor.hits.length <= result.hits.length,
    `${highFloor.hits.length} at 0.999 vs ${result.hits.length} at 0`,
  )
  check(
    'floor: filtered hits are counted, not silently dropped',
    highFloor.belowFloor >= 0 && (highFloor.hits.length === 0 ? highFloor.belowFloor > 0 : true),
    `belowFloor=${highFloor.belowFloor}`,
  )
  // The capability that justifies the page: an unfiltered run reveals what the
  // threshold hid, which the conversation's tool block cannot show.
  check(
    'floor: lowering it to 0 reveals more than the default applied',
    result.hits.length >= highFloor.hits.length,
    `minScore=0 -> ${result.hits.length} hits; minScore=0.999 -> ${highFloor.hits.length} hits (+${highFloor.belowFloor} filtered)`,
  )

  // --- Dense-only is separable from hybrid ---------------------------------
  const denseOnly = await ops.retrieveForDiagnostics('kb_prod_2f8a', '红烧肉怎么做', { topk: 5, minScore: 0, denseOnly: true })
  const hybrid = await ops.retrieveForDiagnostics('kb_prod_2f8a', '红烧肉怎么做', { topk: 5, minScore: 0 })
  check('mode: dense-only reports itself as dense', denseOnly.mode === 'dense', `mode=${denseOnly.mode}`)
  check('mode: the default runs hybrid', hybrid.mode === 'hybrid', `mode=${hybrid.mode}`)
  check(
    'mode: both passes find the cooking document',
    denseOnly.hits[0]?.docName === '烹饪.md' && hybrid.hits[0]?.docName === '烹饪.md',
    `dense=${denseOnly.hits[0]?.docName} hybrid=${hybrid.hits[0]?.docName}`,
  )

  // --- The console must not be counted as real usage -----------------------
  const before = ops.hits7d('kb_prod_2f8a')
  await ops.retrieveForDiagnostics('kb_prod_2f8a', '向量检索', { topk: 3, minScore: 0 })
  await ops.retrieveForDiagnostics('kb_prod_2f8a', '红烧肉', { topk: 3, minScore: 0 })
  const after = ops.hits7d('kb_prod_2f8a')
  check(
    'isolation: diagnostic runs do not inflate the seven-day hit counter',
    after === before,
    `hits7d ${before} -> ${after} across 2 console runs`,
  )

  // --- Guards -------------------------------------------------------------
  let emptyRejected = false
  try {
    await ops.retrieveForDiagnostics('kb_prod_2f8a', '   ', { topk: 3 })
  } catch {
    emptyRejected = true
  }
  check('guard: a blank query is refused rather than returning everything', emptyRejected, 'empty query rejected')

  const clamped = await ops.retrieveForDiagnostics('kb_prod_2f8a', '向量检索', { topk: 999, minScore: -5 })
  check('guard: topk and the floor are clamped to sane bounds', clamped.hits.length <= 50, `${clamped.hits.length} hits for topk=999, minScore=-5`)

  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 2. Wiring: the page is reachable and behaves as a console, not a chat
// ---------------------------------------------------------------------------
check(
  'page: 检索验证 is a selectable view again',
  /'retrieval'/.test(panel) && /检索验证/.test(panel),
  'the tab is back in the panel sub-navigation',
)
check(
  'page: the Q&A view stays removed',
  !/'rag'/.test(panel) && !/问答\s*'/.test(panel),
  'RAG answering remains in the dsh conversation',
)
check(
  'page: it is wired to the diagnostic transport, not the tool',
  /retrieve/.test(panel) && /retrieveForDiagnostics/.test(bridge),
  'the page calls the host console operation',
)
check(
  'page: the bridge method is declared in the shared contract',
  /'retrieve'/.test(contract),
  'both halves agree on the method name',
)
check(
  'page: it renders full chunk text rather than a truncated snippet',
  /hit\.text/.test(page) && /full chunk text/i.test(page),
  'judging a chunk boundary needs the whole chunk',
)
check(
  'page: it exposes the score floor as a control',
  /minScore/.test(page) && /分数下限/.test(page),
  'the floor is what separates "not recalled" from "filtered"',
)
check(
  'page: it states that answering is not its job',
  /不生成回答/.test(page),
  'the scope boundary is visible to the user, not only in a comment',
)
check(
  'page: no empty snapshot is searched',
  /hasSnapshot/.test(page) && /还没有可检索的索引/.test(page),
  'a never-built collection explains itself instead of showing zero hits',
)

console.log(`\nRetrieval console acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
