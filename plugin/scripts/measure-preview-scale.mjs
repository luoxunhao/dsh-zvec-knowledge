/**
 * Does the preview scale badly, and is the duplication a real cost at scale?
 *
 * The claim under test: with 20 documents the preview costs ~40 ms, which is
 * nothing — but the cost is linear in corpus size, and this collection is small.
 * This extrapolates from the real measured per-character cost to realistic library
 * sizes, and separates the two costs that are conflated in "it re-chunks":
 *
 *   1. the preview pass itself (paid on every parameter change, before any build)
 *   2. the build's own pass (paid once, and unavoidable if the build is to chunk)
 *
 * If the preview is the dominant *interactive* cost, the fix is to stop chunking
 * everything for a preview that shows eight rows.
 *
 * Usage: node scripts/measure-preview-scale.mjs
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const storeRoot = join(workspace, '.dsh-kb-zvec')

const { chunkDocument } = await import(new URL('../lib/store/chunk.js', import.meta.url).href)

if (!existsSync(storeRoot)) {
  console.log('no store at ' + storeRoot)
  process.exit(0)
}

const collectionId = readdirSync(storeRoot).find(name => name.startsWith('kb_'))
const dir = join(storeRoot, collectionId)
const records = readFileSync(join(dir, 'documents.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const config = {
  mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}

const totalChars = records.reduce((sum, record) => sum + (record.text?.length ?? 0), 0)
console.log(`\nbaseline: ${records.length} documents, ${(totalChars / 1024).toFixed(0)} K characters\n`)

/** Median wall-clock for one full chunk pass over every document. */
function timeFullPass(runs = 5) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    for (const record of records) chunkDocument(record.text ?? '', config)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

const passMs = timeFullPass()
const perKChar = passMs / (totalChars / 1024)
console.log(`  one full chunk pass over this corpus : ${passMs.toFixed(1)} ms`)
console.log(`  cost per 1000 characters             : ${perKChar.toFixed(3)} ms\n`)

// A representative chapter is ~110 KB; a book-scale library is thousands of them.
const CHAPTER_CHARS = 110 * 1024
console.log('--- extrapolated (linear in corpus size) ---\n')
console.log('  documents      corpus      one pass    3 params      5 params')
for (const count of [20, 100, 500, 1000, 2000, 5000]) {
  const chars = count * CHAPTER_CHARS
  const one = perKChar * (chars / 1024)
  const three = one * 3
  const five = one * 5
  console.log(
    `  ${String(count).padStart(6)}   `
    + `${(chars / 1024 / 1024).toFixed(1).padStart(7)} MB   `
    + `${one.toFixed(0).padStart(7)} ms   `
    + `${three.toFixed(0).padStart(8)} ms   `
    + `${five.toFixed(0).padStart(8)} ms`,
  )
}

console.log('\n--- what a debounce actually fires ---')
console.log('  the preview recomputes on EVERY parameter change, so dragging a number')
console.log('  field or typing in one step through intermediate values fires it repeatedly.')

console.log('\n--- where the build\'s own pass sits ---')
console.log('  the build chunks once, and that pass is unavoidable: the vectors must be')
console.log('  produced from chunks. It is the preview\'s pass that is duplicated work.')
