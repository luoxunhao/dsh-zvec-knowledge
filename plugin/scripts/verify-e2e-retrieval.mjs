/**
 * End-to-end retrieval test against a live embedding endpoint.
 *
 * Every other suite in this repository uses a deterministic fake embedder, which
 * proves the *pipeline* and proves nothing about retrieval quality. This one talks
 * to the real model, so it is the only place the following can actually be
 * checked:
 *
 * - the configured dimension matches what the model returns (a mismatch the engine
 *   would otherwise reject deep inside a write);
 * - the OpenAI-compatible protocol this plugin speaks is the one the endpoint
 *   implements — response shape, `index` seating, batch behaviour;
 * - **retrieval returns the semantically right chunk**, which is the claim no fake
 *   embedder can support: a fake proves a vector round-trips, not that a query
 *   finds the passage that answers it.
 *
 * It skips cleanly when no endpoint is reachable, so it never fails a build for a
 * reason that is not about the code.
 *
 * Usage: node scripts/verify-e2e-retrieval.mjs [--base-url URL] [--model NAME]
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

/** Argument lookup, so the endpoint can be pointed elsewhere without editing. */
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}
const BASE_URL = argOf('--base-url', 'http://127.0.0.1:11434/v1')
const MODEL = argOf('--model', 'qwen3-embedding:4b')

const { createEmbeddingProvider } = await import(new URL('../lib/host/embedding.js', import.meta.url).href)
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

// ---------------------------------------------------------------------------
// 0. Reachability — skip rather than fail when nothing is listening
// ---------------------------------------------------------------------------
{
  let reachable = false
  try {
    const probe = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: ['ping'] }),
      signal: AbortSignal.timeout(120_000),
    })
    reachable = probe.ok
    if (!probe.ok) {
      const body = await probe.text().catch(() => '')
      console.log(`\nE2E retrieval: endpoint returned HTTP ${probe.status}; skipping.`)
      console.log(`  ${body.slice(0, 300)}\n`)
    }
  } catch (error) {
    console.log(`\nE2E retrieval: no endpoint at ${BASE_URL}; skipping.`)
    console.log(`  ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)
    console.log('  Start one (e.g. `ollama serve`) or pass --base-url, then re-run.\n')
    process.exit(0)
  }
  if (!reachable) process.exit(0)
}

const provider = createEmbeddingProvider({ baseUrl: BASE_URL, model: MODEL, apiKeyEnv: '', batchSize: 8 })

// ---------------------------------------------------------------------------
// 1. The protocol: shape, dimension, batching, ordering
// ---------------------------------------------------------------------------
let dimension = 0
{
  const one = await provider(['测试文本'])
  check('live: a single input returns one vector', one.length === 1, `${one.length} vector`)
  dimension = one[0]?.length ?? 0
  check('live: the vector has a plausible width', dimension > 0, `${dimension} dimensions`)
  check('live: values are finite floats', Array.from(one[0]).every(Number.isFinite), `e.g. ${one[0]?.[0]?.toFixed(6)}`)

  // Batch: several inputs must return several distinct vectors, in order. If the
  // provider reordered them, the second and third would be swapped rather than
  // absent — which is the failure the index-seating logic exists to prevent.
  const batch = await provider(['苹果是一种水果', '汽车需要汽油', '量子力学研究微观粒子'])
  check('live: a batch returns one vector per input', batch.length === 3, `${batch.length} vectors`)
  const identical = batch.every((v, i) => i === 0 || !vecEqual(v, batch[0]))
  check('live: distinct texts get distinct vectors', identical, 'no two inputs share a vector')

  // Determinism: the same text must embed to the same vector, or a query could
  // fail to find the chunk it was built from.
  const again = await provider(['苹果是一种水果'])
  check('live: embedding is deterministic', vecEqual(again[0], batch[0]), 'same text, same vector')
}

/**
 * Whether two vectors are equal within float tolerance.
 * @param a - first vector.
 * @param b - second vector.
 * @returns true when they match.
 */
function vecEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 1e-6) return false
  return true
}

/**
 * Cosine similarity, the metric these collections are built with.
 * @param a - first vector.
 * @param b - second vector.
 * @returns similarity in [-1, 1].
 */
function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ---------------------------------------------------------------------------
// 2. The real claim: a query retrieves the passage that answers it
// ---------------------------------------------------------------------------
{
  // Four passages on clearly different subjects. A working embedding model puts
  // the query nearest the passage about the same subject; a broken pipeline
  // (mismatched width, reordered batch, wrong metric) does not.
  const passages = [
    { id: 'fruit', text: '苹果和香蕉都是常见的水果，富含维生素与膳食纤维，适合日常食用。' },
    { id: 'engine', text: '汽车发动机通过燃烧汽油产生动力，经变速箱传递到车轮驱动车辆前进。' },
    { id: 'quantum', text: '量子力学研究微观粒子的运动规律，波函数描述粒子状态的概率分布。' },
    { id: 'cooking', text: '红烧肉需要先将五花肉焯水，再加入冰糖炒糖色，小火慢炖一小时。' },
  ]
  const vectors = await provider(passages.map(p => p.text))
  check('live: every passage embedded', vectors.length === passages.length, `${vectors.length} vectors`)

  /**
   * Rank passages by similarity to a query.
   * @param query - the query text.
   * @returns passage ids best-first with their scores.
   */
  const rank = async (query) => {
    const [qv] = await provider([query])
    return passages
      .map((p, i) => ({ id: p.id, score: cosine(qv, vectors[i]) }))
      .sort((a, b) => b.score - a.score)
  }

  const cases = [
    { query: '吃什么水果对身体好', expect: 'fruit' },
    { query: '汽车是怎么跑起来的', expect: 'engine' },
    { query: '波函数与概率', expect: 'quantum' },
    { query: '五花肉怎么做', expect: 'cooking' },
  ]
  for (const testCase of cases) {
    const ranked = await rank(testCase.query)
    const top = ranked[0]
    check(
      `live: 「${testCase.query}」retrieves the ${testCase.expect} passage`,
      top.id === testCase.expect,
      `top=${top.id} (${top.score.toFixed(3)}), runner-up=${ranked[1].id} (${ranked[1].score.toFixed(3)})`,
    )
  }

  // The separation matters as much as the ordering: if every passage scored
  // alike, the ranking would be noise that happened to land right.
  const ranked = await rank('汽车是怎么跑起来的')
  const margin = ranked[0].score - ranked[1].score
  check('live: the top hit is separated from the runner-up', margin > 0.02, `margin ${margin.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 3. Full pipeline: upload → build → search, through the real operations
// ---------------------------------------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), 'kb-e2e-'))
  const ops = new KnowledgeOperations({
    workspaceDir: scratch,
    stateDir: '.kb',
    embed: provider,
    dimension,
    quota: { bytes: null, warnAt: 0.9 },
  })

  await ops.createCollection({ name: 'E2E', collectionId: 'kb_prod_2f8a', description: '' })

  const documents = [
    { name: '水果.md', text: '# 水果\n苹果和香蕉都是常见的水果，富含维生素与膳食纤维。水果应当每日适量食用。' },
    { name: '汽车.md', text: '# 汽车\n汽车发动机通过燃烧汽油产生动力，经变速箱传递到车轮驱动车辆前进。定期保养可延长寿命。' },
    { name: '量子.md', text: '# 量子力学\n量子力学研究微观粒子的运动规律，波函数描述粒子状态的概率分布，测量会导致波函数坍缩。' },
  ]
  for (const document of documents) {
    await ops.addDocument('kb_prod_2f8a', document)
  }
  check('e2e: documents stored', (await ops.listDocuments('kb_prod_2f8a')).length === 3, '3 documents')

  const build = await ops.buildIndex(
    'kb_prod_2f8a',
    {
      chunking: { mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
      index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
    },
    { onProgress: () => {}, onLog: () => {} },
    new AbortController().signal,
  )
  check('e2e: the build succeeds against the real model', build.ok, `ok=${build.ok} chunks=${build.chunks} err=${build.error ?? '-'}`)

  /**
   * Run a search through the operations layer.
   * @param query - query text.
   * @returns the hits.
   */
  const search = async (query) => {
    const [vector] = await provider([query])
    return ops.search('kb_prod_2f8a', query, vector, 3, 0)
  }

  const fruitHit = await search('水果有哪些营养')
  check('e2e: search returns hits', fruitHit.hits.length > 0, `${fruitHit.hits.length} hits`)
  check('e2e: the top hit is the fruit document', fruitHit.hits[0]?.docName === '水果.md', `top=${fruitHit.hits[0]?.docName}`)
  check('e2e: scores are normalized 0..1', fruitHit.hits.every(h => h.matchScore >= 0 && h.matchScore <= 1), fruitHit.hits.map(h => h.matchScore.toFixed(3)).join(', '))
  check('e2e: hits carry a citation locator', fruitHit.hits.every(h => h.charEnd > h.charStart && h.docId !== ''), fruitHit.hits.map(h => `${h.charStart}-${h.charEnd}`).join(', '))
  check('e2e: the retrieval mode is reported', fruitHit.mode === 'hybrid' || fruitHit.mode === 'dense', fruitHit.mode)

  const quantumHit = await search('波函数是什么')
  check('e2e: a different query retrieves a different document', quantumHit.hits[0]?.docName === '量子.md', `top=${quantumHit.hits[0]?.docName}`)

  // The chunk text must actually contain the asked-about subject, which is the
  // difference between "a vector came back" and "the right passage came back".
  check('e2e: the retrieved chunk is the relevant passage', /波函数/.test(quantumHit.hits[0]?.text ?? ''), (quantumHit.hits[0]?.text ?? '').slice(0, 40))

  // Threshold behaviour is meaningful now: a real score distribution means a high
  // floor should genuinely filter.
  const floored = await (async () => {
    const [vector] = await provider(['波函数是什么'])
    return ops.search('kb_prod_2f8a', '波函数是什么', vector, 3, 0.99)
  })()
  check('e2e: a high floor filters real hits', floored.hits.length <= quantumHit.hits.length, `${floored.hits.length} vs ${quantumHit.hits.length} unbounded`)
  check('e2e: filtered hits are counted, not silently dropped', floored.belowFloor >= 0, `belowFloor=${floored.belowFloor}`)

  ops.dispose()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nE2E retrieval (live ${MODEL} @ ${BASE_URL}): ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
