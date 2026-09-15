/**
 * Measure the journey the user actually complained about.
 *
 * Symptom 1: leaving the panel during a build and coming back left the UI blank
 * for a long time. Symptom 2: the 索引 page was slow to load. This script drives
 * the host calls the panel makes on re-entry, *while a real build is running*, and
 * reports each one's cost — so "it felt slow" becomes a number that can be watched.
 *
 * Usage: node scripts/measure-reentry.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

/** Deterministic embeddings, so no network is involved. */
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

/** A corpus shaped like the reported one: ten sizeable chapters. */
function corpus() {
  const chapters = []
  for (let chapter = 1; chapter <= 10; chapter += 1) {
    const body = '向量检索把文本映射为稠密向量，再用近邻搜索召回相关片段。混合检索融合稠密与全文两路结果。\n'.repeat(1400)
    chapters.push({ name: `chapter${chapter}.md`, text: `# 第 ${chapter} 章\n${body}` })
  }
  return chapters
}

/** Time one async call, returning the median of `runs`. */
async function time(label, fn, runs = 3) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  console.log(`  ${label.padEnd(44)} ${median.toFixed(1).padStart(9)} ms`)
  return median
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-reentry-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch,
  stateDir: '.kb',
  embed: fakeEmbed,
  dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

const chunking = {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const index = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

try {
  await ops.createCollection({ name: 'Reentry', collectionId: 'kb_prod_2f8a', description: '' })
  const documents = corpus()
  for (const document of documents) await ops.addDocument('kb_prod_2f8a', document)
  const bytes = documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0)
  console.log(`corpus: ${documents.length} documents, ${(bytes / 1024 / 1024).toFixed(2)} MB of text\n`)

  console.log('--- panel open (overview / documents) ---')
  await time('listCollections()', () => ops.listCollections())
  await time('listBuilds()', () => ops.listCollections())
  await time('getUsage()', async () => ops.storageUsage())
  await time('getQuota()', async () => ops.usage())
  await time('listDocuments()', () => ops.listDocuments('kb_prod_2f8a'))

  console.log('\n--- 索引 page open ---')
  await time('storedStrategy()', () => ops.storedStrategy('kb_prod_2f8a'))
  await time('previewChunks()', () => ops.previewChunks('kb_prod_2f8a', chunking))
  await time('estimateCost()  [reuses preview]', () => ops.estimateCost('kb_prod_2f8a', chunking, index))

  console.log('\n--- 索引 page while a BUILD IS RUNNING (the re-entry case) ---')
  await ops.buildIndex('kb_prod_2f8a', { chunking, index }, { onProgress: () => {}, onLog: () => {} })
  const running = ops.buildStatus('kb_prod_2f8a')
  console.log(`  build started: running=${running?.running}`)
  await time('buildStatus()  [one poll]', async () => ops.buildStatus('kb_prod_2f8a'), 20)
  await time('listCollections()  [overview refresh]', () => ops.listCollections())
  await time('listDocuments()  [documents refresh]', () => ops.listDocuments('kb_prod_2f8a'))
  await time('previewChunks()  [unchanged params]', () => ops.previewChunks('kb_prod_2f8a', chunking))

  // Let the build finish so the process exits cleanly.
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (ops.buildStatus('kb_prod_2f8a')?.settledAt !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const settled = ops.buildStatus('kb_prod_2f8a')
  console.log(`\n  build settled: ok=${settled?.ok} chunks=${settled?.chunks}`)
  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
