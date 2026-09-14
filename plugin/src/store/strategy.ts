/**
 * Index build service: the host-side operations KB-07's配置器 drives.
 *
 * This module is the seam between the strategy configurator and the engine. It
 * owns three things the UI cannot compute for itself:
 *
 * - **Chunk preview** — the spec calls the preview "提交前唯一的质量校验手段"
 *   (the only quality check before submitting), so it must be produced by the
 *   *same* chunker the build uses. A preview computed by a second implementation
 *   would eventually disagree with the build, which is exactly the failure the
 *   requirement exists to prevent.
 * - **Cost estimate** — chunk count, vector bytes and a build-time estimate,
 *   all derived from the same planned chunks, so the numbers are consistent with
 *   what the build will actually do.
 * - **The rebuild itself** — always into the inactive snapshot slot, so retrieval
 *   keeps answering from the previous snapshot while it runs (KB-10's two-slot
 *   design; the interface only has to *say so*).
 *
 * @module dsh-zvec-knowledge/store/strategy
 */

import { EMBEDDING_DIMENSION, type IndexConfig, type QuantizeKind } from './collection.ts'
import { chunkDocument, previewChunks, type Chunk, type ChunkingConfig, type ChunkingResult } from './chunk.ts'
import { listDocuments, type DocumentRecord } from './documents.ts'
import { readMeta } from './snapshot.ts'

/** Embedding models the configurator offers. */
export interface EmbeddingModel {
  /** Stable id stored in configuration. */
  id: string
  /** Display name. */
  label: string
  /** Output dimension. */
  dimension: number
  /** Distance metric the model is normalized for. */
  metric: 'cosine' | 'ip' | 'l2'
  /** Free-text note shown beside the option. */
  note: string
}

/**
 * The offered embedding models.
 *
 * The list is fixed rather than discovered: the plugin does not own an embedding
 * service (the spec puts model training and selection out of scope), so these are
 * the local options a caller may wire a provider for. `dimension` is fixed at the
 * spec's 1024 for every entry because the collection schema is created with it —
 * a different dimension would need a new collection, not a new setting.
 */
export const EMBEDDING_MODELS: readonly EmbeddingModel[] = [
  { id: 'local-1024', label: '本地嵌入模型（1024 维）', dimension: EMBEDDING_DIMENSION, metric: 'cosine', note: '与集合 schema 一致，无需重建集合' },
]

/** Chunking defaults, from the design spec §10.1. */
export const CHUNKING_DEFAULTS: ChunkingConfig = {
  mode: 'heading',
  chunkTokens: 1024,
  overlapTokens: 128,
  minChunkTokens: 64,
  preserveCodeBlocks: true,
  splitTablesByRow: false,
}

/** Index defaults, from the design spec §10.1 and the measured engine behaviour. */
export const INDEX_DEFAULTS: IndexConfig = {
  kind: 'HNSW',
  m: 32,
  efConstruction: 200,
  quantize: 'INT8',
}

/** Quantizer options with the compression/recall trade-off each implies (§5.6). */
export interface QuantizerOption {
  /** Stored value. */
  value: QuantizeKind
  /** Display label. */
  label: string
  /**
   * The trade-off, stated in the copy.
   *
   * The spec requires the option text to name both the compression ratio and the
   * recall loss. A bare "INT8" would let a user trade retrieval quality away
   * without knowing it, so this field is required rather than optional.
   */
  tradeoff: string
}

/** Quantizer choices, with the engine's real set (there is no PQ family). */
export const QUANTIZER_OPTIONS: readonly QuantizerOption[] = [
  { value: 'INT8', label: 'INT8', tradeoff: '相对 FP32 压缩 4×，召回损失小，推荐默认' },
  { value: 'INT4', label: 'INT4', tradeoff: '相对 FP32 压缩 8×，召回损失明显增大' },
  { value: 'FP16', label: 'FP16', tradeoff: '相对 FP32 压缩 2×，召回损失极小' },
  { value: 'none', label: '不量化', tradeoff: '不压缩，存储占用最高，召回最好' },
]

/** Hybrid retrieval weights, summing to 1 (§5.6). */
export interface HybridWeights {
  /** Weight of the dense vector pass. */
  dense: number
  /** Weight of the full-text pass. */
  fullText: number
}

/** Default hybrid weights: dense-leaning, since the corpus is prose. */
export const HYBRID_DEFAULTS: HybridWeights = { dense: 0.6, fullText: 0.4 }

/** One row of the chunk preview. */
export interface PreviewRow {
  /** Ordinal within its document. */
  ordinal: number
  /** Source document id. */
  docId: string
  /** Estimated tokens. */
  tokens: number
  /** Overlap tokens shared with the previous chunk. */
  overlapTokens: number
  /** Leading text, for recognising the chunk. */
  snippet: string
  /** Character range in the source. */
  charStart: number
  /** End character offset. */
  charEnd: number
}

/** Preview result: leading rows plus the summary the spec requires. */
export interface PreviewResult {
  /** Per-document summaries. */
  documents: { docId: string, name: string, chunks: number, discarded: number, averageTokens: number }[]
  /** Leading chunks across the plan, for the preview list. */
  rows: PreviewRow[]
  /** Total retained chunks. */
  totalChunks: number
  /** Mean tokens per chunk. */
  averageTokens: number
  /** Discarded fragments. */
  discarded: number
  /** Total tokens across retained chunks. */
  totalTokens: number
}

/** Cost estimate shown before the submit button (§5.6). */
export interface CostEstimate {
  /** Total chunks that will be written. */
  chunks: number
  /** Vector storage in bytes, before quantization. */
  rawVectorBytes: number
  /** Vector storage in bytes after quantization. */
  vectorBytes: number
  /** Compression ratio applied, e.g. 4 for INT8. */
  compression: number
  /** Estimated build duration in seconds. */
  estimatedSeconds: number
  /** How the duration was derived, so the figure is auditable. */
  basis: string
}

/** Bytes per vector element, by quantizer. */
const BYTES_PER_ELEMENT: Record<QuantizeKind, number> = {
  // INT8 stores one byte per dimension, INT4 half a byte, FP16 two, FP32 four.
  INT8: 1,
  INT4: 0.5,
  FP16: 2,
  none: 4,
}

/** Measured embedding throughput, in chunks per second, used for the estimate. */
const EMBED_CHUNKS_PER_SECOND = 40

/**
 * Plan a build: chunk every document and produce the preview the configurator shows.
 *
 * One chunking pass feeds both the preview rows and the summary, so the two can
 * never disagree — which is the point of calling `previewChunks` here rather than
 * letting the caller chunk separately.
 * @param documents - the collection's documents.
 * @param config - chunking configuration.
 * @param limit - maximum preview rows.
 * @returns the preview and its summary.
 */
export function planBuild(documents: DocumentRecord[], config: ChunkingConfig, limit = 8): PreviewResult {
  const summaries: PreviewResult['documents'] = []
  const rows: PreviewRow[] = []
  let totalChunks = 0
  let discarded = 0
  let totalTokens = 0

  for (const document of documents) {
    const text = document.text ?? ''
    if (text.trim() === '') {
      summaries.push({ docId: document.id, name: document.name, chunks: 0, discarded: 0, averageTokens: 0 })
      continue
    }
    const { rows: previewRows, summary } = previewChunks(text, config, limit)
    summaries.push({
      docId: document.id,
      name: document.name,
      chunks: summary.chunks.length,
      discarded: summary.discarded,
      averageTokens: summary.averageTokens,
    })
    totalChunks += summary.chunks.length
    discarded += summary.discarded
    totalTokens += summary.totalTokens
    // Only the first document's leading chunks are shown: the preview exists to
    // be read before committing, and a mixed list from every document would be
    // harder to judge than one coherent sample.
    if (rows.length === 0) {
      for (const chunk of previewRows) {
        rows.push({
          ordinal: chunk.ordinal,
          docId: document.id,
          tokens: chunk.tokens,
          overlapTokens: chunk.overlapTokens,
          snippet: chunk.text.slice(0, 80).replace(/\s+/g, ' ').trim(),
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        })
      }
    }
  }

  return {
    documents: summaries,
    rows,
    totalChunks,
    averageTokens: totalChunks === 0 ? 0 : Math.round(totalTokens / totalChunks),
    discarded,
    totalTokens,
  }
}

/**
 * Estimate the build's cost from a plan.
 *
 * The estimate is derived from the plan rather than from the document bytes, so
 * changing the chunk size visibly moves it — which is what makes it useful as a
 * pre-submit check instead of decoration.
 * @param plan - the planned build.
 * @param index - index configuration (quantizer drives the storage figure).
 * @returns the estimate.
 */
export function estimateCost(plan: PreviewResult, index: IndexConfig): CostEstimate {
  const bytesPerElement = BYTES_PER_ELEMENT[index.quantize]
  const rawVectorBytes = plan.totalChunks * EMBEDDING_DIMENSION * 4
  const vectorBytes = Math.round(plan.totalChunks * EMBEDDING_DIMENSION * bytesPerElement)
  // Embedding dominates; the write and publish stages are proportional to it but
  // an order of magnitude cheaper. Stating the basis keeps the figure honest
  // rather than presenting a precise number with no provenance.
  const estimatedSeconds = Math.max(1, Math.round(plan.totalChunks / EMBED_CHUNKS_PER_SECOND))
  return {
    chunks: plan.totalChunks,
    rawVectorBytes,
    vectorBytes,
    compression: bytesPerElement === 4 ? 1 : 4 / bytesPerElement,
    estimatedSeconds,
    basis: `按 ${EMBED_CHUNKS_PER_SECOND} 分片/秒的嵌入吞吐估算，仅计嵌入阶段，不含解析与写入开销`,
  }
}

/**
 * Validate a chunking configuration relationally.
 *
 * The overlap rule is the one the spec calls out explicitly. It is checked here
 * rather than only in the widget because the widget is not the only caller.
 * @param config - chunking configuration.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateChunking(config: ChunkingConfig): string | null {
  if (config.chunkTokens <= 0) return '分片长度必须大于 0'
  if (config.overlapTokens < 0) return '重叠长度不能为负'
  if (config.overlapTokens >= config.chunkTokens) {
    return `重叠长度（${config.overlapTokens}）必须小于分片长度（${config.chunkTokens}），否则切分无法终止`
  }
  if (config.minChunkTokens < 0) return '最小分片不能为负'
  if (config.minChunkTokens > config.chunkTokens) {
    return `最小分片（${config.minChunkTokens}）不能大于分片长度（${config.chunkTokens}），否则所有分片都会被丢弃`
  }
  return null
}

/**
 * Validate hybrid retrieval weights.
 * @param weights - the weights.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateWeights(weights: HybridWeights): string | null {
  if (!(weights.dense >= 0 && weights.dense <= 1)) return '稠密权重必须在 0 到 1 之间'
  if (!(weights.fullText >= 0 && weights.fullText <= 1)) return '全文权重必须在 0 到 1 之间'
  // The spec fixes the sum at 1: the fusion is a weighted blend, and weights that
  // do not sum to 1 would silently rescale every score.
  const sum = weights.dense + weights.fullText
  if (Math.abs(sum - 1) > 1e-6) {
    return `稠密与全文权重之和必须为 1，当前为 ${Number(sum.toFixed(2))}`
  }
  return null
}

/**
 * Validate index configuration.
 * @param index - index configuration.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateIndex(index: IndexConfig): string | null {
  if (!Number.isInteger(index.m) || index.m < 4 || index.m > 128) {
    return 'M 必须是 4 到 128 之间的整数'
  }
  if (!Number.isInteger(index.efConstruction) || index.efConstruction < 16 || index.efConstruction > 2048) {
    return 'efConstruction 必须是 16 到 2048 之间的整数'
  }
  return null
}

/**
 * Read the strategy a collection was last built with.
 *
 * A rebuild must be able to show what it is changing, and a reopen cannot accept
 * a schema — so the index configuration is read back from the collection's
 * metadata rather than re-derived from defaults.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @returns the stored index configuration, or the defaults when unknown.
 */
export function storedIndex(storeRoot: string, collectionId: string): IndexConfig {
  return readMeta(storeRoot, collectionId)?.index ?? INDEX_DEFAULTS
}

/**
 * Summarize what a rebuild would index.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @returns document count and total bytes.
 */
export function buildScope(storeRoot: string, collectionId: string): { documents: number, bytes: number } {
  const records = listDocuments(storeRoot, collectionId)
  return {
    documents: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
  }
}

/** Re-exported so a caller does not reach into the chunker for the summary type. */
export type { ChunkingResult, Chunk, ChunkingConfig }
