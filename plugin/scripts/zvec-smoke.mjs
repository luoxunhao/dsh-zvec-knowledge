/**
 * zvec capability probe.
 *
 * The design spec assumes a vector database with a cosine metric, an HNSW
 * index, a PQ-INT8 quantizer and a normalized 0..1 hit score. This script
 * checks each of those against the real binding on the machine that has to run
 * it, because three of them do not survive contact with the API:
 *
 * - the default metric is inner product, not cosine, so it must be set per
 *   index or every score is on the wrong scale;
 * - there is no `PQ-INT8` quantizer — the binding offers FP16/INT8/INT4 plus a
 *   RaBitQ index family, so the spec's "PQ-INT8, 4x compression" line is INT8;
 * - scores come back as raw IP/cosine values, not the 0..1 `match_score` the
 *   UI and the RAG threshold are defined against, so normalization is plugin
 *   work rather than a database feature.
 *
 * It also proves the part that cannot be assumed: that the win32-x64 native
 * binding loads at all in this environment.
 *
 * Usage: node scripts/zvec-smoke.mjs [reportPath]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = process.argv[2] ?? join(ROOT, 'zvec-smoke-report.json')
// Outside `lib/` on purpose: `lib` is published, and a probe that wrote its
// scratch collection there shipped 5.3 MB of index files inside the tarball.
const DATA_DIR = join(ROOT, 'tmp', 'zvec-smoke-data')

const report = {
  ok: false,
  binding: {},
  indexTypes: [],
  quantizeTypes: [],
  metricTypes: [],
  query: {},
  normalization: {},
  persistence: {},
  errors: [],
}

try {
  const zvec = await import('@zvec/zvec')
  const { ZVecCreateAndOpen, ZVecOpen, ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecMetricType, ZVecQuantizeType } = zvec

  report.binding = {
    resolved: true,
    exportCount: Object.keys(zvec).length,
    hasCreateAndOpen: typeof ZVecCreateAndOpen === 'function',
  }
  report.indexTypes = Object.entries(ZVecIndexType ?? {}).map(([k, v]) => `${k}=${v}`)
  report.quantizeTypes = Object.entries(ZVecQuantizeType ?? {}).map(([k, v]) => `${k}=${v}`)
  report.metricTypes = Object.entries(ZVecMetricType ?? {}).map(([k, v]) => `${k}=${v}`)

  const DIM = 8
  const schema = new ZVecCollectionSchema({
    name: 'kb_prod_2f8a',
    vectors: {
      name: 'embedding',
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: DIM,
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE,
        m: 32,
        efConstruction: 200,
      },
    },
  })

  // `ZVecCreateAndOpen` creates the directory itself and rejects a path that
  // already exists, so the probe clears the leaf and leaves its parent alone.
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(dirname(DATA_DIR), { recursive: true })

  const collection = ZVecCreateAndOpen(DATA_DIR, schema)
  report.collection = { opened: true, name: schema.name, dimension: DIM, metric: 'COSINE', index: 'HNSW m=32 efConstruction=200' }

  /** Unit vectors so cosine similarity has a known answer (the query equals doc_1). */
  const normalize = (v) => {
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
    return v.map(x => x / norm)
  }
  const docs = [
    { id: 'chunk_0', raw: [1, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'chunk_1', raw: [0.9, 0.1, 0, 0, 0, 0, 0, 0] },
    { id: 'chunk_2', raw: [0.5, 0.5, 0, 0, 0, 0, 0, 0] },
    { id: 'chunk_3', raw: [0, 0, 1, 0, 0, 0, 0, 0] },
  ]
  const inserted = collection.insertSync(
    docs.map(doc => ({ id: doc.id, vectors: { embedding: normalize(doc.raw) } })),
  )
  report.insert = { count: docs.length, status: JSON.stringify(inserted) }

  const queryVector = normalize([1, 0, 0, 0, 0, 0, 0, 0])
  const results = collection.querySync({ fieldName: 'embedding', vector: queryVector, topk: 4 })
  report.query = {
    returned: results.length,
    raw: results.map(hit => ({ id: hit.id, score: hit.score })),
    /** The returned `score` is a distance, so a correct list ascends. */
    orderedByDistance: results.every((hit, i) => i === 0 || results[i - 1].score <= hit.score),
  }

  /**
   * The binding returns a DISTANCE, not a similarity: a query identical to a
   * document scores 0 and an orthogonal one scores 1, and the list arrives
   * best-first. The design spec's `match_score` is a 0..1 similarity where
   * higher is better (spec §3.4), so the plugin inverts and clamps. Reading
   * `score` as a similarity would rank the worst hit first and push every hit
   * through the 0.55 floor that is meant to keep weak evidence out of RAG.
   */
  const toMatchScore = distance => Math.max(0, Math.min(1, 1 - distance))
  const band = score => (score >= 0.85 ? 'strong' : score >= 0.70 ? 'relevant' : score >= 0.55 ? 'fair' : 'low')
  report.normalization = {
    method: 'matchScore = clamp(1 - zvec distance)',
    rawSemantics: 'distance (lower is more similar); results already sorted best-first',
    bands: Object.fromEntries(results.map(hit => {
      const matchScore = toMatchScore(hit.score)
      return [hit.id, { distance: hit.score, matchScore, band: band(matchScore) }]
    })),
    identicalQueryScoresOne: results.length > 0 && toMatchScore(results[0].score) === 1,
    orthogonalScoresZero: results.length === 4 && toMatchScore(results[3].score) === 0,
  }

  if (typeof collection.closeSync === 'function') collection.closeSync()
  else if (typeof collection.close === 'function') collection.close()

  // `ZVecCreateAndOpen` refuses an existing path, so a reopen goes through
  // `ZVecOpen`, which takes no schema — the created one is persisted with the
  // collection. That asymmetry is why persistence is asserted here rather than
  // assumed.
  const reopened = ZVecOpen(DATA_DIR)
  const persisted = reopened.querySync({ fieldName: 'embedding', vector: queryVector, topk: 4 })
  report.persistence = {
    reopened: true,
    hitsAfterReopen: persisted.length,
    survivesRestart: persisted.length === results.length && persisted[0]?.id === results[0]?.id,
  }
  if (typeof reopened.closeSync === 'function') reopened.closeSync()

  report.ok = report.binding.hasCreateAndOpen
    && results.length === 4
    && report.query.orderedByDistance
    && report.normalization.identicalQueryScoresOne
    && report.normalization.orthogonalScoresZero
    && report.persistence.survivesRestart
} catch (error) {
  report.errors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n') })
}

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
