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
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
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
  replaceDocuments, sourcePath, summarizeDocuments, validateUpload,
  MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, type DocumentRecord,
} from '../store/documents.ts'
import { extractVerbatim, extractionSupport } from '../store/extract.ts'
import { writeFileStreamed } from '../store/atomic.ts'
import {
  CHUNKING_DEFAULTS, INDEX_DEFAULTS, estimateCost, planBuild, storedIndex,
  validateChunking, validateIndex, validateWeights,
  type ChunkingConfig, type CostEstimate, type EmbeddingModel, type HybridWeights, type PreviewResult,
} from '../store/strategy.ts'
import { startBuild, type BuildLogLine, type BuildProgress, type EmbedFn } from '../store/build.ts'
import {
  awaitJobSettled, cancelJob, disposeJobs, jobSnapshot, logPathFor, startJob,
  type JobSnapshot,
} from '../store/job.ts'
import { EMBEDDING_DIMENSION, type IndexConfig } from '../store/collection.ts'
import { admit, quotaState, type Quota, type QuotaState } from '../store/quota.ts'
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
  /**
   * Session workspace the store root is resolved against.
   *
   * A string pins the store to one workspace for the object's whole life. Pass
   * {@link workspaceFromCall} instead when the operations object outlives a single
   * call — a registered tool, for instance — because the workspace belongs to the
   * *calling session* and a tool registration sees no session at registration time.
   */
  workspaceDir: string | (() => string)
  /** Configured store directory name. */
  stateDir: string
  /** Embedding provider. Required for a build; omitting it makes builds refuse. */
  embed?: EmbedFn
  /**
   * Vector width the provider returns.
   *
   * Carried alongside the provider because the schema, the cost estimate and the
   * batch validation must all agree on it; deriving it from the provider's output
   * would be too late for the first two.
   */
  dimension?: number
  /** Retrieval hit counter, for the overview's seven-day figure. */
  hitCounter?: HitCounter
  /**
   * Storage quota.
   *
   * Enforced here rather than in the interface, because the interface is not the
   * only writer — the tool layer and any future caller go through these methods,
   * so this is the one place a quota cannot be bypassed.
   */
  quota?: Quota
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
  private readonly workspace: string | (() => string)
  private readonly stateDir: string
  private readonly embed: EmbedFn | undefined
  private readonly dimension: number
  private readonly hitCounter: HitCounter
  private readonly quota: Quota
  /**
   * Operations objects already built for a workspace, when the workspace is
   * resolved per call rather than pinned.
   *
   * Retrieval runs per call, so without this a caller that resolves the workspace
   * dynamically would construct — and, for a tool, would have to re-register — a
   * fresh object on every invocation. Keyed by workspace, which is the same key the
   * caller's own cache uses: the handle registry is process-wide, so two objects for
   * one workspace would still contend for one engine lock.
   */
  private readonly perWorkspace = new Map<string, KnowledgeOperations>()

  /**
   * The most recent build plan, keyed by collection and chunking config.
   *
   * The configurator calls `previewChunks` and `estimateCost` back to back on
   * every parameter change, and both need the same chunking pass. Without this the
   * corpus is chunked twice per edit — measured at ~28 ms each on a 1.2 MB
   * collection, so ~19 s before the chunker itself was fixed. Holding one entry
   * per collection is enough because the two calls differ only in the index
   * config, and the plan does not depend on it.
   *
   * Invalidated whenever the document set changes, since a plan is a property of
   * the corpus as well as of the config.
   */
  private readonly planCache = new Map<string, { key: string, plan: PreviewResult }>()

  /**
   * @param options - workspace, state directory, embedding provider and counter.
   */
  constructor(options: OperationsOptions) {
    this.workspace = options.workspaceDir
    this.stateDir = options.stateDir
    this.embed = options.embed
    this.dimension = options.dimension ?? EMBEDDING_DIMENSION
    this.hitCounter = options.hitCounter ?? createHitCounter()
    this.quota = options.quota ?? { bytes: null, warnAt: 0.9 }
  }

  /**
   * The object bound to one concrete workspace for the duration of one operation.
   *
   * For a pinned workspace this is the receiver itself. For a call-resolved one it
   * is the cached object for whichever workspace the resolver names *right now*.
   *
   * There is deliberately no memoization on this object: each operation resolves
   * once and then holds the returned instance in a local, which is what keeps one
   * operation on one workspace. Caching the resolved identity here instead would
   * pin the plugin to the first session's workspace for the process's lifetime —
   * the opposite of the per-session isolation this resolution exists for.
   * @returns operations bound to the workspace.
   * @throws {Error} when the resolved workspace is not an absolute path.
   */
  private bound(): KnowledgeOperations {
    const source = this.workspace
    if (typeof source === 'string') return this
    const workspace = source()
    if (!isAbsolute(workspace)) {
      throw new Error(`workspaceDir must be an absolute path, received ${JSON.stringify(workspace)}`)
    }
    const existing = this.perWorkspace.get(workspace)
    if (existing !== undefined) return existing
    const created = new KnowledgeOperations({
      workspaceDir: workspace,
      stateDir: this.stateDir,
      ...(this.embed === undefined ? {} : { embed: this.embed }),
      dimension: this.dimension,
      hitCounter: this.hitCounter,
      quota: this.quota,
    })
    this.perWorkspace.set(workspace, created)
    return created
  }

  /** The workspace this object's store is rooted in, as of this call. */
  get workspaceDir(): string {
    const source = this.workspace
    return typeof source === 'string' ? source : source()
  }

  /** The resolved store root for this workspace. */
  get storeRoot(): string {
    return resolveStoreRoot(this.bound().workspaceDir, this.stateDir)
  }

  /**
   * The store's current quota state.
   *
   * Exposed so the interface can render the meter and the restricted state from
   * the same measurement the enforcement uses — two measurements would eventually
   * disagree, and the disagreement would look like a quota that fires at random.
   * @returns the quota state.
   */
  usage(): QuotaState {
    const self = this.bound()
    return quotaState(self.storeRoot, self.quota)
  }

  /**
   * Measured usage for the sidebar card.
   *
   * Reports the configured limit alongside the figure so the card can show
   * "used / limit" rather than a bare number, and `null` when unlimited — a
   * different statement from a limit of zero.
   * @returns bytes used and the configured limit.
   */
  storageUsage(): { bytes: number, quotaBytes: number | null } {
    const state = this.usage()
    return { bytes: state.used, quotaBytes: state.limit }
  }

  /**
   * List every collection with its statistics.
   * @returns collections, newest first.
   */
  async listCollections(): Promise<CollectionView[]> {
    const self = this.bound()
    const root = self.storeRoot
    const ids = listCollectionIds(root, dir => readdirSync(dir))
    const views: CollectionView[] = []
    for (const id of ids) {
      const meta = readMeta(root, id)
      if (meta === null) continue
      const records = listDocuments(root, id)
      const summary = summarizeDocuments(records)
      views.push(toView(meta, summary, self.hitCounter.hits7d(id)))
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
    const meta = await createSnapshotCollection(this.bound().storeRoot, {
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
    deleteSnapshotCollection(this.bound().storeRoot, id)
  }

  /**
   * Rename a collection's display name.
   * @param id - collection identifier.
   * @param name - new display name.
   */
  async renameCollection(id: string, name: string): Promise<void> {
    await renameSnapshotCollection(this.bound().storeRoot, id, name)
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
    const root = this.storeRoot
    return listDocuments(root, collectionId)
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
    // Bound once: the workspace must not be resolved twice inside one call, or a
    // session that changed workspace mid-call would read one store and write another.
    const self = this.bound()
    const root = self.storeRoot
    if (readMeta(root, collectionId) === null) {
      throw new Error(`知识库 ${collectionId} 不存在`)
    }
    const reason = validateUpload(values.name, values.bytes)
    if (reason !== null) throw new Error(reason)
    if (values.text.trim() === '') {
      throw new Error('文档解析后没有文本内容，无法建立索引')
    }
    // Admission is checked against the *stored text* rather than the source file
    // size: the text is what occupies the store, and for a compressed source the
    // two differ substantially in either direction.
    const admission = admit(root, self.quota, Buffer.byteLength(values.text, 'utf8'), '上传该文档')
    if (!admission.allowed) throw new Error(admission.reason ?? '存储配额不足')
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
    appendDocument(root, collectionId, record)
    return {
      id: record.id, name: record.name, bytes: record.bytes, ext: record.ext,
      status: 'pending', chunks: null,
    }
  }

  /**
   * Accept one uploaded document as a byte stream.
   *
   * The large-file path: bytes are written straight to a temp file and renamed
   * into place, so a 32 MB document is never held in memory — not by the route, not
   * by this method, and not by the JSON bridge (whose body limit exists precisely
   * because a buffered upload would be aggregated on the host).
   *
   * Ordering is deliberate. Everything that can refuse the upload without writing
   * anything is checked first: the collection exists, the name and declared size are
   * acceptable, and the format is one this module can actually turn into text. Only
   * then is the body streamed. A refusal therefore costs no disk I/O and leaves no
   * partial file.
   *
   * The size limit is enforced *while* streaming rather than from the declared size,
   * because the declared size is caller-supplied: trusting it would let a caller
   * declare 1 KB and send a gigabyte. Exceeding it aborts the write and removes the
   * temp file.
   * @param collectionId - collection identifier.
   * @param name - original file name.
   * @param declaredBytes - size the caller claims, checked for the cheap rejections.
   * @param body - the file's bytes.
   * @param signal - aborts the upload.
   * @returns the stored document record, in 待构建 state.
   * @throws {Error} when the upload is refused.
   */
  async addDocumentStream(
    collectionId: string,
    name: string,
    declaredBytes: number,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ id: string, name: string, bytes: number, ext: string, status: 'pending', chunks: null }> {
    const self = this.bound()
    const root = self.storeRoot
    if (readMeta(root, collectionId) === null) {
      throw new Error(`知识库 ${collectionId} 不存在`)
    }
    const reason = validateUpload(name, declaredBytes)
    if (reason !== null) throw new Error(reason)
    const support = extractionSupport(name)
    if (support.kind !== 'verbatim') {
      // Named precisely, with the remedy: this is the difference between a user
      // converting the file and a user concluding the plugin is broken.
      throw new Error(support.remedy ?? `无法处理 .${extensionOf(name)} 格式的文件`)
    }
    const id = documentId(name)
    const ext = extensionOf(name)
    const target = sourcePath(root, collectionId, id, ext)

    // The ceiling is applied to what actually arrives, not to what was declared.
    // The check runs *before* a chunk is yielded, so the over-limit chunk is never
    // written at all: testing after the write would let one chunk beyond the limit
    // reach the temp file before the abort, which is bytes on disk that a refusal
    // promised not to consume.
    let received = 0
    const counted = (async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of body) {
        if (received + chunk.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`文件超出上限 ${MAX_UPLOAD_LABEL}`)
        }
        received += chunk.byteLength
        yield chunk
      }
    })()

    const written = await writeFileStreamed(target, counted, signal)
    if (written.bytes === 0) {
      throw new Error(`文件为空，没有可索引的内容（可接受 1 B 至 ${MAX_UPLOAD_LABEL}）`)
    }

    let text: string
    try {
      text = extractVerbatim(target)
    } catch (error) {
      // The original is unreadable or not text; nothing was published, so removing
      // it keeps the collection free of a document that can never be built.
      rmSync(target, { force: true })
      throw new Error(`无法读取文件内容：${error instanceof Error ? error.message : String(error)}`)
    }
    if (text.trim() === '') {
      rmSync(target, { force: true })
      throw new Error('文档没有可索引的文本内容（空白文件或仅有 BOM）')
    }

    // Admission is measured against what will actually occupy the store — the
    // retained original plus its decoded text — because both are written.
    const footprint = written.bytes + Buffer.byteLength(text, 'utf8')
    const admission = admit(root, self.quota, footprint, '上传该文档')
    if (!admission.allowed) {
      rmSync(target, { force: true })
      throw new Error(admission.reason ?? '存储配额不足')
    }

    const record: DocumentRecord = {
      id,
      name,
      bytes: written.bytes,
      ext,
      text,
      status: 'pending',
      chunks: null,
      uploadedAt: new Date().toISOString(),
      builtAt: null,
    }
    appendDocument(root, collectionId, record)
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
    const root = this.storeRoot
    removeDocument(root, collectionId, id)
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
    return this.planFor(collectionId, chunking)
  }

  /**
   * The build plan for a collection and chunking config, chunked at most once.
   *
   * Shared by {@link previewChunks} and {@link estimateCost} because the two are
   * called together and need the same pass; the cache key includes the document
   * count and the newest upload time so an added or removed document invalidates
   * it without the store having to notify anyone.
   * @param collectionId - collection identifier.
   * @param chunking - chunking configuration.
   * @returns the preview rows and summary.
   */
  private planFor(collectionId: string, chunking: ChunkingConfig): PreviewResult {
    const documents = listDocuments(this.storeRoot, collectionId)
    const key = `${documents.length}|${documents[documents.length - 1]?.uploadedAt ?? ''}|${JSON.stringify(chunking)}`
    const cached = this.planCache.get(collectionId)
    if (cached !== undefined && cached.key === key) return cached.plan
    const plan = planBuild(documents, chunking)
    this.planCache.set(collectionId, { key, plan })
    return plan
  }

  /**
   * Estimate a build's cost.
   * @param collectionId - collection identifier.
   * @param chunking - chunking configuration.
   * @param index - index configuration.
   * @returns the estimate.
   */
  async estimateCost(collectionId: string, chunking: ChunkingConfig, index: IndexConfig): Promise<CostEstimate> {
    const self = this.bound()
    // Reuses the preview's chunking pass rather than re-chunking: the two calls
    // arrive together from the configurator, and the plan is independent of `index`.
    const plan = await self.previewChunks(collectionId, chunking)
    return estimateCost(plan, index, self.dimension)
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
   * Start an index build into the inactive snapshot slot.
   *
   * **This returns as soon as the build is launched, not when it finishes.** The
   * build runs as a host-side job (see `store/job.ts`), so its lifetime is not
   * tied to the HTTP request that started it: a page that navigates away, switches
   * to another panel or is refreshed no longer cancels the work. The caller polls
   * {@link buildStatus} for progress and {@link cancelBuildIndex} to stop it.
   *
   * The build target is always the slot that is *not* being served, which is what
   * makes "retrieval keeps answering from the previous snapshot" true rather than
   * aspirational. On success the pointer flips atomically.
   * @param collectionId - collection identifier.
   * @param strategy - chunking and index configuration.
   * @param handlers - progress and log callbacks, retained for the job's lifetime.
   * @returns the launch outcome; `ok` means "started", not "finished".
   */
  async buildIndex(
    collectionId: string,
    strategy: { chunking: ChunkingConfig, index: IndexConfig },
    handlers: {
      onProgress: (progress: BuildProgress) => void
      onLog: (line: BuildLogLine) => void
    },
  ): Promise<{ ok: boolean, started: boolean, chunks: number, error?: string }> {
    // One binding for the whole build. A build spans many awaits and writes a
    // snapshot, several slot pointers and a document log: resolving the workspace
    // again midway could publish a snapshot into a different store than the one it
    // was written into.
    const self = this.bound()
    const embed = self.embed
    if (embed === undefined) {
      return { ok: false, started: false, chunks: 0, error: '宿主未提供嵌入模型，无法构建索引' }
    }
    const chunkingReason = validateChunking(strategy.chunking)
    if (chunkingReason !== null) return { ok: false, started: false, chunks: 0, error: chunkingReason }
    const indexReason = validateIndex(strategy.index)
    if (indexReason !== null) return { ok: false, started: false, chunks: 0, error: indexReason }

    const root = self.storeRoot
    const meta = readMeta(root, collectionId)
    if (meta === null) return { ok: false, started: false, chunks: 0, error: `知识库 ${collectionId} 不存在` }

    const records = listDocuments(root, collectionId)
    if (records.length === 0) return { ok: false, started: false, chunks: 0, error: '该知识库还没有文档' }

    // A build writes a whole snapshot, so admission is checked against its planned
    // footprint rather than zero. Without this a rebuild could double a store that
    // an upload had already been refused for — the quota would look unenforced at
    // exactly the moment it matters most.
    const plan = planBuild(records, strategy.chunking)
    const projectedBytes = estimateCost(plan, strategy.index, self.dimension).vectorBytes
      + records.reduce((sum, record) => sum + Buffer.byteLength(record.text, 'utf8'), 0)
    const admission = admit(root, self.quota, projectedBytes, '重建该知识库的索引')
    if (!admission.allowed) return { ok: false, started: false, chunks: 0, error: admission.reason ?? '存储配额不足' }

    const slot = inactiveSlot(meta)
    const launch = startJob(
      collectionId,
      logPathFor(root, collectionId),
      hooks => startBuild({
        storeRoot: root,
        collectionId,
        slot,
        index: strategy.index,
        documents: records.map(record => ({ docId: record.id, text: record.text })),
        chunking: strategy.chunking,
        embed,
        dimension: self.dimension,
        onProgress: hooks.onProgress,
        onLog: hooks.onLog,
      }),
    )
    if (!launch.started) {
      return { ok: false, started: false, chunks: 0, error: launch.reason ?? '构建未能启动' }
    }

    // The harness callbacks are superseded by the job's own record: a caller that
    // supplied them would otherwise receive progress it can no longer deliver,
    // since the request has already returned.
    void handlers

    // Publication is the job's business, so it is chained here rather than left to
    // the caller: the pointer flip and the document-status update must happen even
    // if nobody is polling.
    void afterJobSettles(root, collectionId, slot, records)
    return { ok: true, started: true, chunks: 0 }
  }

  /**
   * One collection's running or last build job.
   * @param collectionId - collection identifier.
   * @returns the snapshot, or `null` when no build has run in this process.
   */
  buildStatus(collectionId: string): JobSnapshot | null {
    return jobSnapshot(collectionId)
  }

  /**
   * Cancel a running build.
   * @param collectionId - collection identifier.
   * @returns whether a running job was asked to stop.
   */
  cancelBuildIndex(collectionId: string): boolean {
    return cancelJob(collectionId)
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
    const self = this.bound()
    const root = self.storeRoot
    if (readMeta(root, collectionId) === null) {
      throw new Error(`知识库 ${collectionId} 不存在`)
    }
    const names = new Map(listDocuments(root, collectionId).map(record => [record.id, record.name]))
    const result: SearchResult = withServed(root, collectionId, handle => {
      if (handle === null) return { hits: [], mode: 'dense' as const, belowFloor: 0 }
      return search(handle, { vector, text: query, topk }, minScore)
    })
    self.hitCounter.record(collectionId, result.hits.length)
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
    const embed = this.bound().embed
    if (embed === undefined) throw new Error('宿主未提供嵌入模型')
    const vectors = await embed([text])
    const first = vectors[0]
    if (first === undefined) throw new Error('嵌入模型未返回向量')
    return first
  }

  /**
   * Run a retrieval for the diagnostic console.
   *
   * Distinct from {@link search} in three ways that matter for *validation*, as
   * opposed to answering:
   *
   * 1. **It embeds the query itself.** The tool-facing `search` takes a vector
   *    because the tool embeds through a different path; here the whole point is to
   *    exercise the same end-to-end recall a real query would.
   * 2. **The floor is a parameter, not a constant.** Lowering it to 0 is how a
   *    check answers "did the index simply not rank this, or did the threshold eat
   *    it?" — a question the conversation's tool block cannot show, because there
   *    the floor is applied silently.
   * 3. **It reports the served snapshot and timing**, so a result can be attributed
   *    to a specific build rather than to "whatever was live at the time".
   *
   * It deliberately does not generate an answer: RAG belongs to the dsh
   * conversation (KB-09). This exists to judge the plugin's own artifacts — whether
   * chunking produced sensible units and whether vector recall works — which the
   * tool-call block cannot show, since it renders only what one query happened to
   * match.
   * @param collectionId - collection identifier.
   * @param query - query text.
   * @param options - topk, floor and whether to force dense-only.
   * @returns hits, the mode that ran, the floor's effect, and index facts.
   * @throws {Error} when the collection is unknown or no embedding provider exists.
   */
  async retrieveForDiagnostics(
    collectionId: string,
    query: string,
    options: { topk?: number, minScore?: number, denseOnly?: boolean } = {},
  ): Promise<{
    hits: HitView[]
    mode: 'hybrid' | 'dense'
    belowFloor: number
    embeddedMs: number
    searchedMs: number
    activeSlot: string | null
    chunks: number
    builtAt: string | null
  }> {
    const self = this.bound()
    const root = self.storeRoot
    const meta = readMeta(root, collectionId)
    if (meta === null) throw new Error(`知识库 ${collectionId} 不存在`)
    if (query.trim() === '') throw new Error('查询内容不能为空')

    const topk = Math.min(Math.max(options.topk ?? 8, 1), 50)
    // Clamped to [0, 1] because a negative floor would be meaningless and a floor
    // above 1 would silently return nothing, which reads as a broken index.
    const minScore = Math.min(Math.max(options.minScore ?? 0, 0), 1)

    const embedStarted = performance.now()
    const vector = await self.embedQuery(query)
    const embeddedMs = performance.now() - embedStarted

    const names = new Map(listDocuments(root, collectionId).map(record => [record.id, record.name]))
    const searchStarted = performance.now()
    const result: SearchResult = withServed(root, collectionId, handle => {
      // A dense-only run is how a caller separates the two recall paths: if dense
      // alone misses and hybrid finds it, the full-text index is carrying the query.
      if (handle === null) return { hits: [], mode: 'dense' as const, belowFloor: 0 }
      return search(handle, {
        vector,
        ...(options.denseOnly === true ? {} : { text: query }),
        topk,
      }, minScore)
    })
    const searchedMs = performance.now() - searchStarted

    // The console is a *read*, so it must not inflate the retrieval statistics the
    // overview shows: a hit counter that counted diagnostic runs would make the
    // seven-day figure describe the operator's probing rather than real use.
    return {
      mode: result.mode,
      belowFloor: result.belowFloor,
      embeddedMs,
      searchedMs,
      activeSlot: meta.active,
      chunks: meta.chunks,
      builtAt: meta.builtAt,
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
   * The seven-day hit figure for the overview.
   * @param collectionId - collection identifier.
   * @returns hit count.
   */
  hits7d(collectionId: string): number {
    return this.bound().hitCounter.hits7d(collectionId)
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
    const root = this.storeRoot
    const meta = readMeta(root, collectionId)
    if (meta === null) throw new Error(`知识库 ${collectionId} 不存在`)
    return slotDir(root, collectionId, inactiveSlot(meta))
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
 * Mark every document as built after a successful publish, with its chunk count.
 *
 * The per-document split comes from the build's own chunking plan, so the stored
 * figure is what was actually written rather than a share computed afterwards.
 *
 * This previously recorded a count only when the build indexed a single document
 * and wrote `null` otherwise, on the reasoning that the split was unknown. It was
 * not unknown — the build had it and discarded it — and `null` is the 待构建
 * value, so a collection with several documents displayed 待构建 against every row
 * even though the whole of it had built successfully.
 * @param root - store root.
 * @param collectionId - collection identifier.
 * @param records - the documents that were built.
 * @param chunksByDoc - chunks written per document id.
 * @param meta - metadata after publish.
 */
function markPublished(
  root: string,
  collectionId: string,
  records: DocumentRecord[],
  chunksByDoc: Record<string, number>,
  meta: SnapshotMeta | null,
): void {
  const at = meta?.builtAt ?? new Date().toISOString()
  const updated = records.map(record => ({
    ...record,
    status: 'ready' as const,
    // Falls back to the previously stored count when the build did not report one
    // for this document (a document whose text was empty, say). Falling back to
    // `null` instead would put the row back into 待构建 for no reason.
    chunks: chunksByDoc[record.id] ?? record.chunks,
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

/**
 * Wait for a launched job to settle, then apply its consequences.
 *
 * Publication must not depend on anyone still watching: the browser that started
 * the build may be gone by the time it finishes, and the snapshot pointer flip and
 * document-status update are part of the build, not of the response. So this is
 * chained at launch time rather than driven by a poll.
 *
 * It awaits the job's own settlement promise rather than polling the snapshot. The
 * polling version left a window of up to one interval after the build finished in
 * which the record still described the previous state — a reader in that window saw
 * a completed build still marked 待构建, which is exactly the symptom this fixes.
 *
 * Chapter two of the same rule: a *successful* build releases its staging slot's
 * handle, while a failed or cancelled one leaves the slot already discarded by
 * `startBuild`. Closing the successful one is what lets the next build recreate
 * that directory — the engine demands an absent path.
 * @param root - absolute store root.
 * @param collectionId - collection identifier.
 * @param slot - the slot the build wrote into.
 * @param records - the documents that were built.
 */
async function afterJobSettles(
  root: string,
  collectionId: string,
  slot: 'a' | 'b',
  records: DocumentRecord[],
): Promise<void> {
  await awaitJobSettled(collectionId)
  const snapshot = jobSnapshot(collectionId)
  if (snapshot?.ok === true) {
    // A published build moves every document to 已构建 with its real chunk count; a
    // cancelled or failed one leaves them 待构建, because nothing was published.
    markPublished(
      root, collectionId, records, snapshot.chunksByDoc,
      readMeta(root, collectionId),
    )
    releaseSlot(root, collectionId, slot)
  }
}

/** Removes a staging slot's contents; used by tests and recovery paths. */
export function discardStaging(storeRoot: string, collectionId: string, slot: 'a' | 'b'): void {
  rmSync(slotDir(storeRoot, collectionId, slot), { recursive: true, force: true })
  markActive(storeRoot, collectionId, slot)
}

export type { ChunkingConfig, EmbeddingModel, HybridWeights, IndexConfig, PreviewResult, CostEstimate }
export { CHUNKING_DEFAULTS, INDEX_DEFAULTS, validateWeights }
