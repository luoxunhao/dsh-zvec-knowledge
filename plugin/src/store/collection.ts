/**
 * Collection schema, chunk rows, and score normalization.
 *
 * This module owns the *shape* of a knowledge collection — which fields exist,
 * how a chunk projects into an engine document, and how an engine distance
 * becomes the spec's `match_score`. Lifecycle (create / open / rename / delete)
 * lives in `snapshot.ts`, which also owns the two-slot snapshot layout.
 *
 * Three engine behaviours are encoded here because each is a silent trap:
 *
 * - **The default metric is inner product, not cosine.** `metricType` defaults to
 *   `IP` on every index family, so it is set explicitly. Leaving it would put
 *   every score on a different scale from the 0.55 threshold.
 * - **There is no `PQ-INT8`.** The engine offers `FP16` / `INT8` / `INT4`; the
 *   spec's "PQ-INT8, 4x compression" is `INT8`. The RaBitQ variants are index
 *   families, not quantizers, and are Linux-only.
 * - **Scores are distances.** The engine returns a value where smaller is more
 *   similar, so {@link toMatchScore} inverts it. The raw value never leaves this
 *   module: the spec forbids exposing a vector distance in any interface.
 *
 * @module dsh-zvec-knowledge/store/collection
 */

import {
  ZVecCollectionSchema,
  ZVecDataType, ZVecIndexType, ZVecMetricType, ZVecQuantizeType,
  type ZVecDoc, type ZVecFieldSchema,
} from '@zvec/zvec'

/**
 * Vector width used when a deployment does not state one.
 *
 * The design spec's illustrative figure. It is a *default*, not a fact about any
 * particular model: the endpoint actually deployed for this project returns 2560,
 * so the configured value is what the schema is built with and this is only the
 * fallback.
 */
export const EMBEDDING_DIMENSION = 1024

/** Vector field name, referenced by every insert and query. */
export const VECTOR_FIELD = 'embedding'

/** Scalar field carrying the source document id, for citation back-references. */
export const FIELD_DOC_ID = 'doc_id'

/** Scalar field carrying the chunk ordinal within its document. */
export const FIELD_ORDINAL = 'ordinal'

/** Scalar field carrying the chunk's start character offset. */
export const FIELD_CHAR_START = 'char_start'

/** Scalar field carrying the chunk's end character offset. */
export const FIELD_CHAR_END = 'char_end'

/** Scalar field holding the chunk text, and the full-text search target. */
export const FIELD_TEXT = 'text'

/**
 * Index families the strategy configurator may select.
 *
 * The spec names HNSW / IVF / DiskANN. The RaBitQ variants exist in the engine
 * but are Linux-only, so they are not offered to users.
 */
export type IndexKind = 'HNSW' | 'IVF' | 'DISKANN'

/** Quantizer choices the engine actually provides. The spec's `PQ-INT8` is `INT8`. */
export type QuantizeKind = 'INT8' | 'INT4' | 'FP16' | 'none'

/** Vector index tuning, mirroring the strategy configurator's fields (§5.6). */
export interface IndexConfig {
  /** Index family. */
  kind: IndexKind
  /** `M` for HNSW; ignored by the other families. Spec default 32. */
  m: number
  /** `efConstruction` for HNSW; ignored by the other families. Spec default 200. */
  efConstruction: number
  /** Quantizer. Spec default `INT8` (the spec's "PQ-INT8" does not exist). */
  quantize: QuantizeKind
}

/**
 * Map a quantizer choice to the engine's enum.
 * @param quantize - configured quantizer.
 * @returns the engine quantize type, or `UNDEFINED` for `none`.
 */
function quantizeType(quantize: QuantizeKind): ZVecQuantizeType {
  switch (quantize) {
    case 'INT8': return ZVecQuantizeType.INT8
    case 'INT4': return ZVecQuantizeType.INT4
    case 'FP16': return ZVecQuantizeType.FP16
    case 'none': return ZVecQuantizeType.UNDEFINED
  }
}

/**
 * Scalar fields every knowledge collection carries.
 *
 * `text` gets an FTS index because hybrid retrieval fuses a dense pass with a
 * full-text pass; `doc_id` and the character range are inverted so citations can
 * be filtered and located without a full scan.
 * @returns field schemas.
 */
function scalarFields(): ZVecFieldSchema[] {
  return [
    { name: FIELD_DOC_ID, dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    { name: FIELD_ORDINAL, dataType: ZVecDataType.INT64 },
    { name: FIELD_CHAR_START, dataType: ZVecDataType.INT64 },
    { name: FIELD_CHAR_END, dataType: ZVecDataType.INT64 },
    { name: FIELD_TEXT, dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS } },
  ]
}

/**
 * Build the engine schema for a knowledge collection.
 *
 * Cosine is set explicitly on every family because the engine's default is inner
 * product. The RaBitQ families are deliberately not reachable from here.
 * @param name - collection name for the engine.
 * @param index - vector index configuration.
 * @returns the engine schema.
 */
export function buildSchema(name: string, index: IndexConfig, dimension: number = EMBEDDING_DIMENSION): ZVecCollectionSchema {
  const common = { metricType: ZVecMetricType.COSINE, quantizeType: quantizeType(index.quantize) }
  const byKind = {
    HNSW: { indexType: ZVecIndexType.HNSW, ...common, m: index.m, efConstruction: index.efConstruction },
    IVF: { indexType: ZVecIndexType.IVF, ...common, nList: 10, nIters: 10 },
    DISKANN: { indexType: ZVecIndexType.DISKANN, ...common, maxDegree: 100, listSize: 50 },
  }[index.kind]
  return new ZVecCollectionSchema({
    name,
    vectors: {
      name: VECTOR_FIELD,
      dataType: ZVecDataType.VECTOR_FP32,
      // The width comes from the configured embedding model rather than a
      // constant: the engine rejects vectors of another size, so this is the one
      // place the model's shape has to be recorded.
      dimension,
      indexParams: byKind,
    },
    fields: scalarFields(),
  })
}

/**
 * Convert an engine distance into the spec's normalized `match_score`.
 *
 * The engine returns a distance where smaller is more similar (a query equal to
 * a document scores 0, an orthogonal one scores 1). The spec's `match_score` is a
 * 0..1 similarity where larger is more relevant, so this inverts. Reading the raw
 * value as a similarity would rank the worst hit first and push every hit past
 * the 0.55 floor that is meant to keep weak evidence out of RAG.
 * @param distance - raw engine score.
 * @returns normalized score in [0, 1].
 */
export function toMatchScore(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  return Math.max(0, Math.min(1, 1 - distance))
}

/** Confidence bands from the design spec §3.4. */
export type ConfidenceBand = 'strong' | 'relevant' | 'fair' | 'low'

/**
 * Classify a normalized score into the spec's four confidence bands.
 * @param matchScore - normalized score in [0, 1].
 * @returns the band.
 */
export function confidenceBand(matchScore: number): ConfidenceBand {
  if (matchScore >= 0.85) return 'strong'
  if (matchScore >= 0.70) return 'relevant'
  if (matchScore >= 0.55) return 'fair'
  return 'low'
}

/** A chunk row as stored in the engine. */
export interface ChunkRow {
  /** Engine document id, `<docId>#<ordinal>`. */
  id: string
  /** Source document id. */
  docId: string
  /** Ordinal within the source document. */
  ordinal: number
  /** Start character offset within the source text. */
  charStart: number
  /** End character offset within the source text. */
  charEnd: number
  /** Chunk text. */
  text: string
}

/**
 * Build the engine document input for a chunk row.
 * @param row - chunk row.
 * @param vector - embedding for the chunk text.
 * @returns engine document input.
 */
export function chunkDocInput(row: ChunkRow, vector: Float32Array | number[]): {
  id: string
  vectors: Record<string, Float32Array | number[]>
  fields: Record<string, string | number>
} {
  return {
    id: row.id,
    vectors: { [VECTOR_FIELD]: vector },
    fields: {
      [FIELD_DOC_ID]: row.docId,
      [FIELD_ORDINAL]: row.ordinal,
      [FIELD_CHAR_START]: row.charStart,
      [FIELD_CHAR_END]: row.charEnd,
      [FIELD_TEXT]: row.text,
    },
  }
}

/**
 * Project an engine hit into a chunk row.
 * @param doc - engine document returned by a query.
 * @returns the chunk row, or `null` when required fields are absent.
 */
export function chunkRowFromDoc(doc: ZVecDoc): ChunkRow | null {
  const fields = doc.fields ?? {}
  const docId = fields[FIELD_DOC_ID]
  const text = fields[FIELD_TEXT]
  if (typeof docId !== 'string' || typeof text !== 'string') return null
  return {
    id: doc.id,
    docId,
    ordinal: Number(fields[FIELD_ORDINAL] ?? 0),
    charStart: Number(fields[FIELD_CHAR_START] ?? 0),
    charEnd: Number(fields[FIELD_CHAR_END] ?? 0),
    text,
  }
}

/**
 * Quote a string for the engine's filter language.
 *
 * The filter language rejects `==` and takes a single `=` as equality, with
 * single-quoted string literals (verified in `scripts/zvec-probe-filter.mjs`).
 * An unescaped apostrophe would end the literal early and change the
 * expression's meaning, so backslashes and quotes are escaped.
 * @param value - raw string.
 * @returns the string safe to embed in a single-quoted literal.
 */
export function escapeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Build a filter expression matching one document's chunks.
 * @param docId - source document id.
 * @returns filter expression.
 */
export function documentFilter(docId: string): string {
  return `${FIELD_DOC_ID} = '${escapeLiteral(docId)}'`
}
