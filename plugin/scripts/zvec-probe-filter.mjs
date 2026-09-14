/**
 * Filter-expression syntax probe.
 *
 * `zvec-probe10.mjs` showed the obvious guess (`collection == 'x'`) is rejected
 * by the parser with a syntax error, so the operator spelling has to come from
 * the engine rather than from habit. Getting this wrong is silent in the worst
 * way: a collection-scoped query that throws is at least loud, but a filter that
 * happens to parse and matches nothing would look like "no results".
 *
 * Usage: node scripts/zvec-probe-filter.mjs
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'tmp', 'zvec-probe-filter-data')

const zvec = await import('@zvec/zvec')
const { ZVecCreateAndOpen, ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecMetricType } = zvec

rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(dirname(DATA_DIR), { recursive: true })

const schema = new ZVecCollectionSchema({
  name: 'kb_probe',
  vectors: { name: 'embedding', dataType: ZVecDataType.VECTOR_FP32, dimension: 4,
    indexParams: { indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE, m: 32, efConstruction: 200 } },
  fields: [
    { name: 'collection', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    { name: 'ordinal', dataType: ZVecDataType.INT64, indexParams: { indexType: ZVecIndexType.INVERT } },
  ],
})

const c = ZVecCreateAndOpen(DATA_DIR, schema)
c.insertSync([
  { id: 'a0', vectors: { embedding: [1, 0, 0, 0] }, fields: { collection: 'kb_prod_2f8a', ordinal: 0 } },
  { id: 'a1', vectors: { embedding: [0.9, 0.1, 0, 0] }, fields: { collection: 'kb_prod_2f8a', ordinal: 1 } },
  { id: 'b0', vectors: { embedding: [1, 0, 0, 0] }, fields: { collection: 'kb_docs_9c1e', ordinal: 2 } },
])

const candidates = [
  "collection = 'kb_prod_2f8a'",
  'collection == "kb_prod_2f8a"',
  "collection = \"kb_prod_2f8a\"",
  "collection LIKE 'kb_prod%'",
  "collection IN ('kb_prod_2f8a')",
  "collection = 'kb_prod_2f8a' AND ordinal >= 0",
  'ordinal = 1',
  "SELECT * WHERE collection = 'kb_prod_2f8a'",
]

for (const filter of candidates) {
  let outcome
  try {
    const hits = c.querySync({ fieldName: 'embedding', vector: [1, 0, 0, 0], topk: 10, filter })
    outcome = `OK -> ${hits.length} hit(s): ${hits.map(h => h.id).join(', ') || '(none)'}`
  } catch (error) {
    outcome = `THREW ${String(error?.code ?? '')} ${String(error?.message ?? error).split('\n')[0].slice(0, 140)}`
  }
  console.log(`${filter}\n    ${outcome}\n`)
}

c.closeSync()
