/**
 * KB-10 API probe — the questions the smoke test did not answer.
 *
 * `zvec-smoke.mjs` proved the basics (HNSW + COSINE, distance semantics, reopen).
 * KB-10 needs four more answers before its design can be fixed, and each is the
 * kind whose absence produces code that looks right and silently does nothing:
 *
 * 1. Does `ZVecCreateAndOpen` really throw when the path exists, and with which
 *    code? The create/reopen dispatch in the store depends on being able to tell
 *    "already exists" apart from every other failure.
 * 2. Does an FTS field index accept Chinese text, and does `multiQuerySync` with
 *    `rerank: 'rrf'` merge dense + full-text hits? That is the spec's hybrid
 *    pipeline, so it must be the engine's own fusion rather than a hand-rolled one.
 * 3. Are scalar fields filterable (`filter` expression syntax) once an INVERT
 *    index exists? Collections need per-collection scoping.
 * 4. Does `deleteSync` + `stats.docCount` behave so a delete is observable?
 *
 * Usage: node scripts/zvec-probe10.mjs [reportPath]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = process.argv[2] ?? join(ROOT, 'tmp', 'zvec-probe10.json')
const DATA_DIR = join(ROOT, 'tmp', 'zvec-probe10-data')

const report = { ok: false, checks: {}, errors: [] }

/** Unit vectors so cosine has a known answer. */
const norm = v => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / n)
}

try {
  const zvec = await import('@zvec/zvec')
  const {
    ZVecCreateAndOpen, ZVecOpen, ZVecCollectionSchema,
    ZVecDataType, ZVecIndexType, ZVecMetricType, ZVecQuantizeType, isZVecError,
  } = zvec

  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(dirname(DATA_DIR), { recursive: true })

  const schema = new ZVecCollectionSchema({
    name: 'kb_prod_2f8a',
    vectors: {
      name: 'embedding',
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 4,
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE,
        m: 32,
        efConstruction: 200,
        quantizeType: ZVecQuantizeType.INT8,
      },
    },
    fields: [
      { name: 'collection', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'doc_id', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'text', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS } },
      { name: 'ordinal', dataType: ZVecDataType.INT64 },
    ],
  })

  const collection = ZVecCreateAndOpen(DATA_DIR, schema)
  report.checks.schemaAccepted = { fts: true, invert: true, int8Quantize: true }

  // 1. Create-and-open on an existing path must fail, and distinguishably.
  try {
    ZVecCreateAndOpen(DATA_DIR, schema)
    report.checks.createOnExisting = { threw: false, note: 'did NOT throw — create/reopen cannot be dispatched on this' }
  } catch (error) {
    report.checks.createOnExisting = {
      threw: true,
      code: isZVecError(error) ? error.code : null,
      name: String(error?.name ?? ''),
      message: String(error?.message ?? '').slice(0, 200),
    }
  }

  const docs = [
    { id: 'c0', v: [1, 0, 0, 0], text: '向量数据库的检索原理', ord: 0 },
    { id: 'c1', v: [0.9, 0.1, 0, 0], text: '混合检索与融合排序', ord: 1 },
    { id: 'c2', v: [0.5, 0.5, 0, 0], text: '索引构建流水线', ord: 2 },
    { id: 'c3', v: [0, 0, 1, 0], text: 'unrelated content about weather', ord: 3 },
  ]
  collection.insertSync(docs.map(d => ({
    id: d.id,
    vectors: { embedding: norm(d.v) },
    fields: { collection: 'kb_prod_2f8a', doc_id: 'doc_1', text: d.text, ordinal: d.ord },
  })))
  report.checks.docCount = collection.stats.docCount

  // 2. Hybrid: dense + full-text merged by the engine's own RRF.
  const qv = norm([1, 0, 0, 0])
  const dense = collection.querySync({ fieldName: 'embedding', vector: qv, topk: 4 })
  report.checks.denseQuery = { returned: dense.length, ids: dense.map(d => d.id), scores: dense.map(d => d.score) }

  try {
    const fts = collection.querySync({ fieldName: 'text', fts: { matchString: '检索' }, topk: 4 })
    report.checks.ftsQuery = { returned: fts.length, ids: fts.map(d => d.id), scores: fts.map(d => d.score) }
  } catch (error) {
    report.checks.ftsQuery = { error: String(error?.message ?? error).slice(0, 300) }
  }

  try {
    const hybrid = collection.multiQuerySync({
      queries: [
        { fieldName: 'embedding', vector: qv, numCandidates: 10 },
        { fieldName: 'text', fts: { matchString: '检索' }, numCandidates: 10 },
      ],
      topk: 4,
      rerank: { type: 'rrf' },
    })
    report.checks.hybridRrf = { returned: hybrid.length, ids: hybrid.map(d => d.id), scores: hybrid.map(d => d.score) }
  } catch (error) {
    report.checks.hybridRrf = { error: String(error?.message ?? error).slice(0, 300) }
  }

  // 3. Scalar filtering, which is how one collection's chunks stay scoped.
  try {
    const filtered = collection.querySync({
      fieldName: 'embedding', vector: qv, topk: 4, filter: "collection == 'kb_prod_2f8a'", outputFields: ['text', 'ordinal'],
    })
    report.checks.filter = { returned: filtered.length, fieldsPresent: filtered[0] ? Object.keys(filtered[0].fields ?? {}) : [] }
  } catch (error) {
    report.checks.filter = { error: String(error?.message ?? error).slice(0, 300) }
  }

  // 4. Delete observability.
  try {
    collection.deleteSync(['c3'])
    report.checks.delete = { docCountAfter: collection.stats.docCount }
  } catch (error) {
    report.checks.delete = { error: String(error?.message ?? error).slice(0, 300) }
  }

  collection.closeSync()

  // Reopen proves schema (incl. FTS/INVERT) persisted with the collection.
  const reopened = ZVecOpen(DATA_DIR)
  report.checks.reopen = {
    docCount: reopened.stats.docCount,
    fields: reopened.schema.fields().map(f => f.name),
    vectors: reopened.schema.vectors().map(v => v.name),
  }
  reopened.closeSync()

  report.ok = report.checks.createOnExisting?.threw === true
    && report.checks.denseQuery?.returned === 4
    && (report.checks.hybridRrf?.returned ?? 0) > 0
    && report.checks.filter?.returned === 4
    && report.checks.delete?.docCountAfter === 3
} catch (error) {
  report.errors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n') })
}

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
