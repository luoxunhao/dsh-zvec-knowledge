/**
 * Host-side knowledge-base operations, as a plain callable surface.
 *
 * The browser half talks to the host through {@link KnowledgeBasePort}, whose
 * shape lives in the client bundle. Something has to implement it against the real
 * store, and this module is that something — deliberately transport-free: it
 * returns plain JSON-able values and takes an `AbortSignal`, so the same
 * implementation serves an HTTP route, a tool, or an in-process call without
 * knowing which it is.
 *
 * Two rules it enforces that the UI cannot:
 *
 * - **The store root is resolved per call from the session workspace**, never
 *   from `process.cwd()`. That is the isolation dimension KB-10's acceptance
 *   criterion is about, and putting it here means no caller can bypass it.
 * - **A build never writes into the snapshot being served.** It always targets the
 *   inactive slot, which is what lets retrieval keep answering during a rebuild.
 *
 * @module dsh-zvec-knowledge/host/operations
 */

import { readdirSync } from 'node:fs'
import { resolveStoreRoot } from '../store/paths.ts'
import {
  createCollection as createSnapshotCollection,
  deleteCollection as deleteSnapshotCollection,
  inactiveSlot,
  listCollectionIds,
  openServed,
  readMeta,
  renameCollection as renameSnapshotCollection,
  slotDir,
  withServed,
  type SnapshotMeta,
} from '../store/snapshot.ts'
import { disposeAll, markActive, releaseSlot } from '../store/registry.ts'
import {
  appendDocument, documentId, extensionOf, listDocuments, removeDocument,
  replaceDocuments, summarizeDocuments, validateUpload, type DocumentRecord,
} from '../store/documents.ts'
import {
  CHUNKING_DEFAULTS, INDEX_DEFAULTS, estimateCost, planBuild, storedIndex,
  validateChunking, validateIndex, validateWeights,
  type ChunkingConfig, type CostEstimate, type EmbeddingModel, type HybridWeights, type PreviewResult,
} from '../store/strategy.ts'
import { startBuild, type BuildLogLine, type BuildProgress, type EmbedFn } from '../store/build.ts'
import type { IndexConfig } from '../store/collection.ts'
import { search, type SearchResult } from '../store/retrieval.ts'
import { rmSync } from 'node:fs'

/**
 * One collection as the interface consumes it.
 *
 * Field names follow the design spec's §9.2 mapping: `collection` for the engine's
 * collection, `match_score` for the normalized score. Nothing here exposes a raw
 * vector distance — that is the spec's "不暴露内部数值" rule, and this is the
 * boundary where it is enforced.
 */
export interface CollectionView {
  /** Collection identifier, e.g. `kb_prod_2f8a`. */
  id: string
  /** Human-facing name. */
  name: string
  /** Description. */
  description: string
  /** Index family. */
  indexKind: string
  /** Lifecycle status. */
  status: 'ready' | 'building' | 'failed' | 'pending'
  /** Documents stored. */
  documents: number
  /** Chunks in the active snapshot. */
  chunks: number
  /** Seven-day retrieval hits. */
  hits7d: number
  /** Last build time, ISO-8601, or `null`. */
  builtAt: string | null
  /** Creation time, ISO-8601. */
  createdAt: string
}

/** A retrieval hit as the interface consumes it. */
export interface HitView {
  /** Source document id. */
  docId: string
  /** Source file name, when resolvable. */
  docName: string
  /** Chunk ordinal within the document. */
  ordinal: number
  /** Character range within the source. */
  charStart: number
  /** End character offset. */
  charEnd: number
  /** Chunk text. */
  text: string
  /** Normalized relevance in [0, 1]. Larger is more relevant. */
  matchScore: number
  /** Confidence band. */
  band: 'strong' | 'relevant' | 'fair' | 'low'
}

/** Options for {@link KnowledgeOperations}. */
export interface OperationsOptions {
  /** Session workspace the store root is resolved against. */
  workspaceDir: string
  /** Configured store directory name. */
  stateDir: string
  /** Embedding provider. Required for a build; omitting it makes builds refuse. */
  embed?: EmbedFn
  /** Retrieval hit counter, for the overview's seven-day figure. */
  hitCounter?: HitCounter
}

/** Tracks retrieval hits so the overview's seven-day figure is real, not a placeholder. */
export interface HitCounter {
  /** Record one retrieval. */
  record: (collectionId: string, hits: number) => void
  /** Hits in the last seven days for a collection. */
  hits7d: (collectionId: string) => number
}

/**
 * In-memory hit counter.
 *
 * Deliberately in-memory and documented as such: persisting it would mean a
 * write per query, and the spec asks for a seven-day statistic, not an auditable
 * ledger. A restart resets it, which the overview's label does not overstate.
 */
export function createHitCounter(now: () => number = Date.now): HitCounter {
  const events: { at: number, collectionId: string, hits: number }[] = []
  const WINDOW = 7 * 24 * 60 * 60 * 1000
  return {
    record: (collectionId, hits) => {
      events.push({ at: now(), collectionId, hits })
    },
    hits7d: (collectionId) => {
      const cutoff = now() - WINDOW
      return events
        .filter(event => event.collectionId === collectionId && event.at >= cutoff)
        .reduce((sum, event) => sum + event.hits, 0)
    },
  }
}

/** The host operations the browser half and the retrieval tool both call. */
export class KnowledgeOperations {
  private readonly workspaceDir: string
  private readonly stateDir: string
  private readonly embed: EmbedFn | undefined
  private readonly hitCounter: HitCounter

  /**
   * @param options - workspace, state directory, embedding provider and counter.
   */
  constructor(options: OperationsOptions) {
    this.workspaceDir = options.workspaceDir
    this.stateDir = options.stateDir
    this.embed = options.embed
    this.hitCounter = options.hitCounter ?? createHitCounter()
  }

  /** The resolved store root for this workspace. */
  get storeRoot(): string {
    return resolveStoreRoot(this.workspaceDir, this.stateDir)
  }

  /**
   * List every collection with its statistics.
   * @returns collections, newest first.
   */
  async listCollections(): Promise<CollectionView[]> {
    const root = this.storeRoot
    const ids = listCollectionIds(root, dir => readdirSync(dir))
    const views: CollectionView[] = []
    for (const id of ids) {
      const meta = readMeta(root, id)
      if (meta === null) continue
      const records = listDocuments(root, id)
      const summary = summarizeDocuments(records)
      views.push(toView(meta, summary, this.hitCounter.hits7d(id)))
    }
    return views.sort((left, right) => (right.createdAt > left.createdAt ? 1 : -1))
  }

  /**
   * Create a collection.
   * @param values - name, identifier and description.
   * @returns the created collection's view.
   * @throws {Error} when the identifier exists or the fields are invalid.
   */
  async createCollection(values: { name: string, collectionId: string, description: string }): Promise<CollectionView> {
    const meta = await createSnapshotCollection(this.storeRoot, {
      id: values.collectionId,
      name: values.name,
      description: values.description,
      createdAt: new Date().toISOString(),
      index: INDEX_DEFAULTS,
    })
    return toView(meta, summarizeDocuments([]), 0)
  }

  /**
   * Delete a collection and its stored documents.
   * @param id - collection identifier.
   */
  async deleteCollection(id: string): Promise<void> {
    deleteSnapshotCollection(this.storeRoot, id)
  }

  /**
   * Rename a collection's display name.
   * @param id - collection identifier.
   * @param name - new display name.
   */
  async renameCollection(id: string, name: string): Promise<void> {
    await renameSnapshotCollection(this.storeRoot, id, name)
  }

  /**
   * List a collection's documents.
   * @param collectionId - collection identifier.
   * @returns documents, newest first.
   */
  async listDocuments(collectionId: string): Promise<{
    id: string, name: string, bytes: number, ext: string,
    status: 'pending' | 'building' | 'ready' | 'failed', chunks: number | null, error?: string
  }[]> {
    return listDocuments(this.storeRoot, collectionId)
      .map(record => ({
        id: record.id,
        name: record.name,
        bytes: record.bytes,
        ext: record.ext,
        status: record.status,
        // `null` passes through unchanged: it is the 待构建 value, not a zero.
        chunks: record.chunks,
        ...(record.error === undefined ? {} : { error: record.error }),
      }))
      .sort((left, right) => (right.id > left.id ? 1 : -1))
  }

  /**
   * Store one uploaded document.
   *
   * Validation happens here rather than only in the browser, because the host is
   * the only place that can be trusted; the browser's copy exists to give faster
   * feedback, not to be the gate.
   * @param collectionId - collection identifier.
   * @param values - file name, byte size and extracted text.
   * @returns the stored document.
   * @throws {Error} when the upload is rejected.
   */
  async addDocument(
    collectionId: string,
    values: { name: string, bytes: number, text: string },
  ): Promise<{ id: string, name: string, bytes: number, ext: string, status: 'pending', chunks: null }> {
    if (readMeta(this.storeRoot, collectionId) === null) {
      throw new Error(`知识库 ${collectionId} 不存在`)
    }
    const reason = validateUpload(values.name, values.bytes)
    if (reason !== null) throw new Error(reason)
    if (values.text.trim() === '') {
      throw new Error('文档解析后没有文本内容，无法建立索引')
    }
    const record: DocumentRecord = {
      id: documentId(values.name),
      name: values.name,
      bytes: values.bytes,
      ext: extensionOf(values.name),
      text: values.text,
      status: 'pending',
      chunks: null,
      uploadedAt: new Date().toISOString(),
      builtAt: null,
    }
    appendDocument(this.storeRoot, collectionId, record)
    return {
      id: record.id, name: record.name, bytes: record.bytes, ext: record.ext,
      status: 'pending', chunks: null,
    }
  }

  /**
   * Remove a document and its chunks.
   *
   * Both halves are needed: dropping the record alone would leave the document's
   * chunks retrievable, which would surface as citations to a deleted file.
   * @param collectionId - collection identifier.
   * @param id - document id.
   */
  async removeDocument(collectionId: string, id: string): Promise<void> {
    removeDocument(this.storeRoot, collectionId, id)
    const root = this.storeRoot
    try {
      withServed(root, collectionId, handle => {
        if (handle === null) return
        handle.deleteByFilterSync(`doc_id = '${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      })
    } catch {
      // The snapshot may not exist yet; the record removal is what mattered.
    }
  }

  /**
   * Compute the chunk preview for a candidate strategy.
   * @param collectionId - collection identifier.
   * @param chunking - chunking configuration.
   * @returns preview rows and summary.
   */
  async previewChunks(collectionId: string, chunking: ChunkingConfig): Promise<PreviewResult> {
    const reason = validateChunking(chunking)
    if (reason !== null) throw new Error(reason)
    return planBuild(listDocuments(this.storeRoot, collectionId), chunking)
  }

  /**
   * Estimate a build's cost.
   * @param collectionId - collection identifier.
   * @param chunking - chunking configuration.
   * @param index - index configuration.
   * @returns the estimate.
   */
  async estimateCost(collectionId: string, chunking: ChunkingConfig, index: IndexConfig): Promise<CostEstimate> {
    const plan = await this.previewChunks(collectionId, chunking)
    return estimateCost(plan, index)
  }

  /**
   * Read the strategy a collection was last built with.
   * @param collectionId - collection identifier.
   * @returns stored index configuration.
   */
  async storedStrategy(collectionId: string): Promise<IndexConfig> {
    return storedIndex(this.storeRoot, collectionId)
  }

  /**
   * Run the index build into the inactive snapshot slot.
   *
   * The build target is always the slot that is *not* being served, which is what
   * makes "retrieval keeps answering from the previous snapshot" true rather than
   * aspirational. On success the pointer flips atomically.
   * @param collectionId - collection identifier.
   * @param strategy - chunking and index configuration.
   * @param handlers - progress and log callbacks.
   * @param signal - aborts the build.
   * @returns the outcome.
   */
  async buildIndex(
    collectionId: string,
    strategy: { chunking: ChunkingConfig, index: IndexConfig },
    handlers: {
      onProgress: (progress: BuildProgress) => void
      onLog: (line: BuildLogLine) => void
    },
    signal: AbortSignal,
  ): Promise<{ ok: boolean, chunks: number, error?: string }> {
    if (this.embed === undefined) {
      return { ok: false, chunks: 0, error: '宿主未提供嵌入模型，无法构建索引' }
    }
    const chunkingReason = validateChunking(strategy.chunking)
    if (chunkingReason !== null) return { ok: false, chunks: 0, error: chunkingReason }
    const indexReason = validateIndex(strategy.index)
    if (indexReason !== null) return { ok: false, chunks: 0, error: indexReason }

    const root = this.storeRoot
    const meta = readMeta(root, collectionId)
    if (meta === null) return { ok: false, chunks: 0, error: `知识库 ${collectionId} 不存在` }

    const records = listDocuments(root, collectionId)
    if (records.length === 0) return { ok: false, chunks: 0, error: '该知识库还没有文档' }

    const slot = inactiveSlot(meta)
    const running = startBuild({
      storeRoot: root,
      collectionId,
      slot,
      index: strategy.index,
      documents: records.map(record => ({ docId: record.id, text: record.text })),
      chunking: strategy.chunking,
      embed: this.embed,
      onProgress: handlers.onProgress,
      onLog: handlers.onLog,
    })

    const onAbort = (): void => running.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await running.done
      // A published build moves every document to 已构建 with its real chunk
      // count; a cancelled or failed one leaves them 待构建, because nothing was
      // published.
      if (result.ok) {
        const published = readMeta(root, collectionId)
        markPublished(root, collectionId, records, result.chunks, published)
        releaseSlot(root, collectionId, slot)
      }
      return { ok: result.ok, chunks: result.chunks, ...(result.error === undefined ? {} : { error: result.error }) }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Run a hybrid retrieval.
   *
   * Returns normalized `matchScore` values only; the engine's raw distance never
   * leaves the store layer, which is the spec's "不暴露内部数值" rule.
   * @param collectionId - collection identifier.
   * @param query - query text.
   * @param vector - query embedding.
   * @param topk - maximum hits.
   * @param minScore - normalized floor; hits below it are counted, not returned.
   * @returns hits and the mode that produced them.
   */
  async search(
    collectionId: string,
    query: string,
    vector: Float32Array | number[],
    topk: number,
    minScore: number,
  ): Promise<{ hits: HitView[], mode: 'hybrid' | 'dense', belowFloor: number }> {
    const root = this.storeRoot
    if (readMeta(root, collectionId) === null) {
      throw new Error(`知识库 ${collectionId} 不存在`)
    }
    const names = new Map(listDocuments(root, collectionId).map(record => [record.id, record.name]))
    const result: SearchResult = withServed(root, collectionId, handle => {
      if (handle === null) return { hits: [], mode: 'dense' as const, belowFloor: 0 }
      return search(handle, { vector, text: query, topk }, minScore)
    })
    this.hitCounter.record(collectionId, result.hits.length)
    return {
      mode: result.mode,
      belowFloor: result.belowFloor,
      hits: result.hits.map(hit => ({
        docId: hit.docId,
        docName: names.get(hit.docId) ?? hit.docId,
        ordinal: hit.ordinal,
        charStart: hit.charStart,
        charEnd: hit.charEnd,
        text: hit.text,
        matchScore: hit.matchScore,
        band: hit.band,
      })),
    }
  }

  /**
   * Embed one query string.
   *
   * Separate from the build's batch `embed` because a query is embedded one at a
   * time and on the latency-critical path: the tool cannot wait for a batch to
   * fill, and the build cannot afford a per-text provider round trip.
   * @param text - the query.
   * @returns the query vector.
   * @throws {Error} when no provider is configured.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    if (this.embed === undefined) throw new Error('宿主未提供嵌入模型')
    const vectors = await this.embed([text])
    const first = vectors[0]
    if (first === undefined) throw new Error('嵌入模型未返回向量')
    return first
  }

  /**
   * The seven-day hit figure for the overview.
   * @param collectionId - collection identifier.
   * @returns hit count.
   */
  hits7d(collectionId: string): number {
    return this.hitCounter.hits7d(collectionId)
  }

  /**
   * Release every pooled engine handle.
   *
   * Called from the plugin's fiber disposer: the engine holds an exclusive lock
   * per collection directory, so a leaked handle makes the collection unopenable
   * until the process exits.
   * @returns number of handles closed.
   */
  dispose(): number {
    return disposeAll()
  }

  /**
   * The chunk count currently served for a collection.
   * @param collectionId - collection identifier.
   * @returns chunk count, or 0 when nothing is built.
   */
  servedChunks(collectionId: string): number {
    return withServed(this.storeRoot, collectionId, handle => {
      if (handle === null) return 0
      try {
        return handle.stats.docCount
      } catch {
        return 0
      }
    })
  }

  /**
   * The slot directory a build would write into.
   * @param collectionId - collection identifier.
   * @returns absolute path, for diagnostics.
   */
  stagingDir(collectionId: string): string {
    const meta = readMeta(this.storeRoot, collectionId)
    if (meta === null) throw new Error(`知识库 ${collectionId} 不存在`)
    return slotDir(this.storeRoot, collectionId, inactiveSlot(meta))
  }
}

/**
 * Project stored metadata into the interface's view.
 * @param meta - snapshot metadata.
 * @param summary - document summary.
 * @param hits7d - seven-day hit count.
 * @returns the view.
 */
function toView(meta: SnapshotMeta, summary: ReturnType<typeof summarizeDocuments>, hits7d: number): CollectionView {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    indexKind: meta.index.kind,
    // A collection with no active snapshot is 待构建 regardless of what its
    // documents say — there is nothing to retrieve from yet.
    status: meta.active === null ? 'pending' : summary.failed > 0 ? 'failed' : 'ready',
    documents: summary.total,
    chunks: meta.chunks,
    hits7d,
    builtAt: meta.builtAt,
    createdAt: meta.createdAt,
  }
}

/**
 * Mark every document as built after a successful publish.
 *
 * The chunk count is recorded per document only when the build indexed a single
 * document (the common case for a rebuild-after-upload); with several documents
 * the totals are known but the split is not, so each is marked built with its
 * own count left `null` rather than receiving a fabricated share.
 * @param root - store root.
 * @param collectionId - collection identifier.
 * @param records - the documents that were built.
 * @param totalChunks - chunks published across all of them.
 * @param meta - metadata after publish.
 */
function markPublished(
  root: string,
  collectionId: string,
  records: DocumentRecord[],
  totalChunks: number,
  meta: SnapshotMeta | null,
): void {
  const at = meta?.builtAt ?? new Date().toISOString()
  const updated = records.map(record => ({
    ...record,
    status: 'ready' as const,
    chunks: records.length === 1 ? totalChunks : null,
    builtAt: at,
  }))
  try {
    // Through the documents module's own helper so the rewrite is atomic; a
    // partial rewrite of the log is the one failure an append cannot express.
    replaceDocuments(root, collectionId, updated)
  } catch {
    // Best effort: the index published successfully, and a stale status line is
    // recoverable by the next rebuild.
  }
}

/** Removes a staging slot's contents; used by tests and recovery paths. */
export function discardStaging(storeRoot: string, collectionId: string, slot: 'a' | 'b'): void {
  rmSync(slotDir(storeRoot, collectionId, slot), { recursive: true, force: true })
  markActive(storeRoot, collectionId, slot)
}

export type { ChunkingConfig, EmbeddingModel, HybridWeights, IndexConfig, PreviewResult, CostEstimate }
export { CHUNKING_DEFAULTS, INDEX_DEFAULTS, validateWeights }
