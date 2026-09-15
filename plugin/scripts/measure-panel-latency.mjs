/**
 * Measure what opening the knowledge panel actually costs today.
 *
 * Purpose: the reported symptoms are a long blank screen when re-entering the
 * panel during a build, and a slow 索引 page. This measures the host calls those
 * two views make, against the *real* collection in this workspace, so the fix is
 * aimed at the measured cost rather than a guess.
 *
 * Usage: node scripts/measure-panel-latency.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

// The workspace this plugin was exercised in: the store root is a sibling of the
// plugin directory, not inside it.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const storeRoot = join(workspace, '.dsh-kb-zvec')
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

const collectionId = readdirSync(storeRoot).find(name => name.startsWith('kb_'))
if (collectionId === undefined) {
  console.log('no collection found; nothing to measure')
  process.exit(0)
}

const documentsPath = join(storeRoot, collectionId, 'documents.jsonl')
console.log(`collection: ${collectionId}`)
console.log(`documents.jsonl: ${(statSync(documentsPath).size / 1024 / 1024).toFixed(2)} MB\n`)

const ops = new KnowledgeOperations({
  workspaceDir: workspace,
  stateDir: '.dsh-kb-zvec',
  // No embedding provider: this measures store reads, not the model.
  dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

/** Time one async call, in milliseconds. */
async function time(label, fn, runs = 5) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  console.log(`${label.padEnd(46)} median ${median.toFixed(1).padStart(8)} ms   (n=${runs})`)
  return median
}

console.log('--- what the panel loads on open (Promise.all of three) ---')
const collections = await time('listCollections()', () => ops.listCollections())
const builds = await time('listBuilds()  [= listCollections again]', () => ops.listCollections())
const usage = await time('getUsage()', async () => ops.storageUsage())
const quota = await time('getQuota()', async () => ops.usage())
console.log(`\n  sequential total would be ~${(collections + builds + usage + quota).toFixed(0)} ms`)
console.log(`  as Promise.all, bounded by the slowest: ~${Math.max(collections, builds, usage, quota).toFixed(0)} ms`)

console.log('\n--- what the 索引 page loads ---')
await time('storedStrategy()', () => ops.storedStrategy(collectionId))
await time('previewChunks()', () => ops.previewChunks(collectionId, {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}))
await time('estimateCost()', () => ops.estimateCost(collectionId, {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}, { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }))

console.log('\n--- what one status poll costs during a build ---')
await time('buildStatus()', async () => ops.buildStatus(collectionId))
console.log('  (at a 1.2 s interval, this is the per-poll overhead)')

console.log('\n--- what a build must read once ---')
await time('listDocuments()', () => ops.listDocuments(collectionId))

ops.dispose()
