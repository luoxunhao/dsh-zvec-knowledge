/**
 * Break down what the 索引 page's preview actually does, and how long each part takes.
 *
 * The question this answers: how can 20 documents be "estimated" in under a second?
 * The premise is wrong — the preview does not estimate, it *chunks*. This separates
 * the two costs that people assume are inside it (running the embedding model, and
 * writing vectors) from the one cost that is actually there (computing chunk
 * boundaries over text already in memory), so the number is explained rather than
 * asserted.
 *
 * Usage: node scripts/measure-preview-cost.mjs
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const storeRoot = join(workspace, '.dsh-kb-zvec')

const { chunkDocument } = await import(new URL('../lib/store/chunk.js', import.meta.url).href)
const { planBuild, estimateCost } = await import(new URL('../lib/store/strategy.js', import.meta.url).href)

if (!existsSync(storeRoot)) {
  console.log('no store at ' + storeRoot)
  process.exit(0)
}

const collectionId = readdirSync(storeRoot).find(name => name.startsWith('kb_'))
const dir = join(storeRoot, collectionId)
const records = readFileSync(join(dir, 'documents.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const totalChars = records.reduce((sum, record) => sum + (record.text?.length ?? 0), 0)
const config = {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const index = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

console.log(`\ncollection ${collectionId}: ${records.length} documents, ${(totalChars / 1024 / 1024).toFixed(2)} M characters\n`)

/** Median of several runs, in milliseconds. */
function median(fn, runs = 5) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

// 1. Reading the documents off disk — the part that scales with collection size.
const readMs = median(() => {
  const raw = readFileSync(join(dir, 'documents.jsonl'), 'utf8')
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
})
console.log('  read + parse documents.jsonl   ' + readMs.toFixed(1).padStart(8) + ' ms   ← disk + JSON')

// 2. Chunking every document. This is what the preview really does.
const chunkMs = median(() => {
  let chunks = 0
  for (const record of records) chunks += chunkDocument(record.text ?? '', config).chunks.length
})
console.log('  chunk all documents            ' + chunkMs.toFixed(1).padStart(8) + ' ms   ← the actual work')

// 3. The summary + cost arithmetic — pure integer maths over the plan.
const plan = planBuild(records, config)
const costMs = median(() => estimateCost(plan, index, 2560))
console.log('  estimate cost (arithmetic)     ' + costMs.toFixed(3).padStart(8) + ' ms   ← multiplications')

console.log(`\n  plan: ${plan.totalChunks} chunks across ${records.length} documents`)

// 4. What the preview does NOT do. A real query embedding is one HTTP round trip.
const PROBE_QUERY = '向量检索是怎么召回相关片段的'
const embedStarted = performance.now()
let embedOk = true
try {
  const response = await fetch('http://127.0.0.1:11434/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-embedding:4b', input: [PROBE_QUERY], encoding_format: 'float' }),
    signal: AbortSignal.timeout(30_000),
  })
  embedOk = response.ok
} catch {
  embedOk = false
}
const embedMs = performance.now() - embedStarted
console.log('')
if (embedOk) {
  console.log('  ONE real embedding call        ' + embedMs.toFixed(1).padStart(8) + ' ms   ← 1 text, one HTTP round trip')
  console.log(`  a full build would need        ${plan.totalChunks} such texts, batched`)
} else {
  console.log('  embedding endpoint unreachable; skipping the comparison')
}

console.log('\n--- why the preview is fast ---')
console.log('  it never calls the embedding model, and never touches the vector engine.')
console.log('  it re-cuts text that is already in memory (documents.jsonl is read anyway)')
console.log('  and counts characters. The expensive stages are in the build, not here.')
