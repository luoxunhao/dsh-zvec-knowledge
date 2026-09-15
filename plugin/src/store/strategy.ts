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

/**
 * Quantizer choices, with the engine's real set (there is no PQ family).
 *
 * **The copy describes what was measured, not what the spec assumed.** §5.6 asks
 * each option to state its compression ratio and recall loss, and the previous
 * text said INT8 compresses "相对 FP32 压缩 4×" — the FP32→INT8 arithmetic, which
 * is not what the engine does. A controlled experiment (same 749-chunk corpus, same
 * real embeddings, one collection per quantizer, measured after close so no
 * write-ahead log inflates the figure) found:
 *
 * | quantizer | index | qindex | total | 召回@10 |
 * |-----------|-------|--------|-------|---------|
 * | 不量化     | 8.54 MB | — | 11.73 MB | 基线 |
 * | FP16      | 8.54 MB | 4.95 MB | 16.68 MB | 100% |
 * | INT8      | 8.54 MB | 4.98 MB | 16.72 MB | 99.2% |
 *
 * So quantization leaves the vector index byte-identical and **adds** a second
 * artifact: the store grows by ~42% rather than shrinking by 4×. Its benefit is
 * query speed, not footprint. Stating the old figure would have been actively
 * misleading to anyone choosing a quantizer to save disk.
 */
export const QUANTIZER_OPTIONS: readonly QuantizerOption[] = [
  { value: 'INT8', label: 'INT8', tradeoff: '索引体积不变，另增约 40% 量化索引；查询更快，召回实测损失约 1%，推荐默认' },
  { value: 'INT4', label: 'INT4', tradeoff: '索引体积不变，另增量化的辅助结构；查询最快，召回损失明显增大（未实测具体幅度）' },
  { value: 'FP16', label: 'FP16', tradeoff: '索引体积不变，另增约 40% 量化索引；查询更快，召回实测无损失' },
  { value: 'none', label: '不量化', tradeoff: '索引体积最小（无量化索引），召回最好，但查询较慢' },
]

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
 * @param dimension - vector width; the storage figure scales with it, so a
 * deployment on a wider model sees the real cost rather than the default's.
 * @returns the estimate.
 */
export function estimateCost(plan: PreviewResult, index: IndexConfig, dimension: number = EMBEDDING_DIMENSION): CostEstimate {
  const bytesPerElement = BYTES_PER_ELEMENT[index.quantize]
  const rawVectorBytes = plan.totalChunks * dimension * 4
  const vectorBytes = Math.round(plan.totalChunks * dimension * bytesPerElement)
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
 *
 * **Order matters, and this order is deliberate.** Checking `overlap >= chunk`
 * first meant that lowering the chunk size below the *default* overlap reported
 * "重叠长度（128）必须小于分片长度（64）" — naming the wrong parameter, because
 * the user had not touched the overlap at all. The genuinely broken relation in
 * that configuration is `minChunkTokens > chunkTokens`, so the checks that depend
 * only on the field the user changed come first, and the cross-field overlap rule
 * last. Each violation then names the parameter actually at fault.
 * @param config - chunking configuration.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateChunking(config: ChunkingConfig): string | null {
  if (config.chunkTokens <= 0) return '分片长度必须大于 0'
  if (config.overlapTokens < 0) return '重叠长度不能为负'
  if (config.minChunkTokens < 0) return '最小分片不能为负'
  if (config.minChunkTokens > config.chunkTokens) {
    return `最小分片（${config.minChunkTokens}）不能大于分片长度（${config.chunkTokens}），否则所有分片都会被丢弃`
  }
  // Last, because it compares two fields and would otherwise be blamed for a
  // configuration whose real problem is one of the relations above.
  if (config.overlapTokens >= config.chunkTokens) {
    return `重叠长度（${config.overlapTokens}）必须小于分片长度（${config.chunkTokens}），否则切分无法终止`
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
