/**
 * Measure how much work an incremental build could avoid.
 *
 * The reported problem: uploading one document rebuilds every document. This
 * counts the embedding work a full rebuild performs against what a build that only
 * processed the *new* documents would perform, using the real chunk counts already
 * recorded in the live store.
 *
 * Usage: node scripts/measure-rebuild-waste.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const storeRoot = join(workspace, '.dsh-kb-zvec')

if (!existsSync(storeRoot)) {
  console.log('no store at ' + storeRoot)
  process.exit(0)
}

const collectionId = readdirSync(storeRoot).find(name => name.startsWith('kb_'))
const dir = join(storeRoot, collectionId)
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const records = readFileSync(join(dir, 'documents.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const totalChunks = records.reduce((sum, record) => sum + (record.chunks ?? 0), 0)
const textBytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.text ?? '', 'utf8'), 0)
const newest = records.reduce((latest, record) => (record.builtAt > latest ? record.builtAt : latest), '')

// One document represents "the new upload": the smallest, as a conservative floor.
const smallest = records.reduce((min, record) => ((record.chunks ?? 0) < (min.chunks ?? Infinity) ? record : min), records[0])

console.log(`\ncollection ${collectionId}: ${records.length} documents, ${meta.chunks} chunks indexed`)
console.log(`stored text: ${(textBytes / 1024 / 1024).toFixed(2)} MB\n`)

console.log('--- a full rebuild today ---')
console.log(`  documents embedded : ${records.length} (every one)`)
console.log(`  chunks embedded    : ${totalChunks}`)
console.log(`  text read          : ${(textBytes / 1024 / 1024).toFixed(2)} MB`)

console.log('\n--- what uploading one document actually needs ---')
console.log(`  new document       : ${smallest.name} (${smallest.chunks} chunks)`)
console.log(`  chunks embedded    : ${smallest.chunks} (reuse the other ${totalChunks - smallest.chunks})`)

const waste = (totalChunks - smallest.chunks) / totalChunks
console.log(`\n  redundant work     : ${(waste * 100).toFixed(1)}% of the embedding pass`)

// The embedding pass dominates a build: the estimate's own basis is a fixed
// chunks-per-second figure, so the ratio of chunks is the ratio of that stage.
console.log(`\n  at 40 chunks/s (the estimator's own figure):`)
console.log(`    full rebuild     : ${Math.round(totalChunks / 40)} s`)
console.log(`    incremental      : ${Math.round(smallest.chunks / 40)} s`)
