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

import { existsSync, readdirSync } from 'node:fs'
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
  SLOTS,
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
  CHUNKING_DEFAULTS, INDEX_DEFAULTS, QUANTIZER_OPTIONS, estimateCost, planBuild, storedIndex,
  validateChunking, validateIndex,
  type ChunkingConfig, type CostEstimate, type EmbeddingModel, type PreviewResult, type QuantizerOption,
} from '../store/strategy.ts'
import { startBuild, type BuildLogLine, type BuildProgress, type EmbedFn } from '../store/build.ts'
import { strategyEvidence as buildStrategyEvidence, type StrategyEvidence } from '../store/strategy-evidence.ts'
import {
  awaitJobSettled, cancelJob, disposeJobs, jobSnapshot, logPathFor, startJob,
  type JobSnapshot,
} from '../store/job.ts'
import { EMBEDDING_DIMENSION, TOKENIZER_NAME, documentFilter, type IndexConfig } from '../store/collection.ts'
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
  /**
   * Model identifier the deployment configured, for the configurator's read-only
   * grid. Optional because a deployment may wire a provider with no name (a test
   * double, an in-process model), and the grid states that rather than inventing
   * one.
   */
  embeddingModel?: string
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
  private readonly embeddingModel: string | undefined
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
    this.embeddingModel = options.embeddingModel
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
      ...(this.embeddingModel === undefined ? {} : { embeddingModel: this.embeddingModel }),
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
        // Through `documentFilter` rather than an inline template. The id is
        // user-controlled (it derives from an uploaded file name), so the escaping
        // here is load-bearing: a hand-copied version that drifted from the shared
        // one would end the string literal early and let a crafted file name change
        // what the delete expression matches.
        handle.deleteByFilterSync(documentFilter(id))
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
   * Evidence that each configured chunking policy actually took effect.
   *
   * Replaces the corpus-wide preview, which chunked every document to render eight
   * truncated rows — linear cost for a question it could not answer. This samples
   * the single longest document, so the cost is constant regardless of collection
   * size, and reports per-policy observations instead of corpus totals.
   * @param collectionId - collection identifier.
   * @param chunking - the configuration to verify.
   * @returns the evidence report.
   */
  async strategyEvidence(collectionId: string, chunking: ChunkingConfig): Promise<StrategyEvidence> {
    const reason = validateChunking(chunking)
    if (reason !== null) throw new Error(reason)
    // Aliased on import: an unaliased name would resolve to this method, and the
    // call would recurse until the stack overflowed instead of reporting anything.
    return buildStrategyEvidence(this.storeRoot, collectionId, chunking)
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
   * The embedding endpoint's real shape, for the configurator's read-only grid.
   *
   * The page needs the **dimension it is actually indexing at**, and it cannot
   * derive that: the schema is created host-side from the deployment config, and a
   * collection's width is fixed at creation. The client previously held its own
   * hardcoded `1024` option list, so a deployment on a 2560-wide model displayed
   * 1024 while the cost estimator on the same page computed with 2560 — two
   * contradictory numbers, and the displayed one was the wrong one and not
   * correctable by the user, because the field is read-only.
   *
   * `dimension` is what the schema is built at (so a deployment that states none
   * reports the spec's illustrative default, which is what it will really get).
   * `model` and `metric` are reported so the grid can stop inventing them.
   * @returns the embedding shape in force for this deployment.
   */
  embeddingInfo(): { dimension: number, model: string | null, metric: string } {
    return {
      dimension: this.bound().dimension,
      // Absent when no endpoint is configured — a real state the UI must be able
      // to show, rather than a plausible-looking model name.
      model: this.embeddingModel ?? null,
      metric: 'cosine',
    }
  }

  /**
   * The quantizer choices, with the copy the spec requires for each.
   *
   * Served from here so the trade-off text has one source. It previously existed
   * twice — here and as a client-side constant — which is how the client came to
   * display a compression claim the engine does not honour while the host's own
   * copy could have been corrected independently. §5.6 requires the option text to
   * name both the compression ratio and the recall loss, so a divergence between
   * the two copies is a user-visible correctness problem, not a cosmetic one.
   * @returns quantizer options in display order.
   */
  quantizerOptions(): readonly QuantizerOption[] {
    return QUANTIZER_OPTIONS
  }

  /**
   * Whether an incremental build is possible, and why not when it is not.
   *
   * The decision is deliberately the host's rather than the page's: the page cannot
   * see the stored strategy, and getting this wrong is silent. Reusing chunks that
   * were cut with different parameters produces an index whose contents disagree
   * with its own configuration, and every chunk is still a valid vector — so
   * nothing fails, the answers are just quietly wrong.
   *
   * Only two conditions block it, and both are hard requirements rather than
   * preferences:
   *
   * 1. **Nothing is built yet.** There is no snapshot to inherit from.
   * 2. **The strategy changed.** Different chunking re-cuts every document, and a
   *    different index family or quantizer needs a different schema.
   *
   * A collection whose metadata predates the recorded chunking config is treated as
   * changed, because an unknown value cannot be proven equal.
   * @param collectionId - collection identifier.
   * @param chunking - the strategy the caller wants to build with.
   * @param index - the index configuration the caller wants to build with.
   * @returns whether incremental is possible, and the reason when it is not.
   */
  incrementalViability(
    collectionId: string,
    chunking: ChunkingConfig,
    index: IndexConfig,
  ): { possible: boolean, reason: string } {
    const meta = readMeta(this.storeRoot, collectionId)
    if (meta === null) return { possible: false, reason: `知识库 ${collectionId} 不存在` }
    if (meta.active === null) return { possible: false, reason: '该知识库尚未构建过，本次为首次全量构建' }

    const storedIndexConfig = meta.index
    if (storedIndexConfig.kind !== index.kind
      || storedIndexConfig.quantize !== index.quantize
      || storedIndexConfig.m !== index.m
      || storedIndexConfig.efConstruction !== index.efConstruction) {
      return { possible: false, reason: '索引参数已变更，需要全量重建' }
    }

    // `== null` rather than `=== null`: a collection written before the field
    // existed has **no** `chunking` key at all, so `readMeta` yields `undefined`
    // and a `=== null` guard does not fire. Execution then reached `sameChunking`,
    // which reads `config.mode` on it and threw
    // "Cannot read properties of undefined (reading 'mode')" — surfacing in the
    // panel as a failed build plan, which disables every build control because the
    // page cannot say whether an incremental build is allowed. Both absent and
    // null mean the same thing here: the parameters are not known.
    if (meta.chunking == null) {
      return { possible: false, reason: '无法确认上次构建使用的切分参数，为安全起见全量重建' }
    }
    if (!sameChunking(meta.chunking, chunking)) {
      return { possible: false, reason: '切分参数已变更，需要全量重建' }
    }

    // The tokenizer is a schema property of the FTS index, and an incremental
    // build clones the previous slot — so it would silently inherit the old
    // tokenizer and keep the bad CJK segmentation that `TOKENIZER_NAME` fixes.
    // A collection built before this field existed records `null`, which cannot
    // be proven equal and is therefore treated as changed.
    if (meta.tokenizer !== TOKENIZER_NAME) {
      return { possible: false, reason: `全文分词器已变更（${meta.tokenizer ?? '未记录'} → ${TOKENIZER_NAME}），需要全量重建` }
    }

    return { possible: true, reason: '' }
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
   * @param mode - `incremental` embeds only the documents that are not built yet,
   *   inheriting the rest from the served snapshot; `full` re-embeds everything.
   *   Either way the host downgrades to a full build when the strategy no longer
   *   matches what the stored chunks were cut with, and reports that in the log.
   * @returns the launch outcome; `ok` means "started", not "finished".
   */
  async buildIndex(
    collectionId: string,
    strategy: { chunking: ChunkingConfig, index: IndexConfig },
    handlers: {
      onProgress: (progress: BuildProgress) => void
      onLog: (line: BuildLogLine) => void
    },
    mode: 'incremental' | 'full' = 'incremental',
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

    // Which documents actually need embedding. The point of the whole exercise:
    // uploading one document into a twenty-document collection should cost one
    // document's embedding work, not twenty.
    //
    // A document counts as already built when its status is `ready`, which is only
    // set after a publish — so a document added since the last build is `pending`
    // and is picked up here. Anything else (a failure, a cancelled build) is
    // re-embedded, which is the safe direction.
    const viability = self.incrementalViability(collectionId, strategy.chunking, strategy.index)
    const useIncremental = mode === 'incremental' && viability.possible
    const pending = records.filter(record => record.status !== 'ready')
    const toEmbed = useIncremental ? pending : records

    // A full build is required, but the caller asked for incremental. Saying so is
    // the difference between "your upload was cheap" and "this silently re-cut
    // everything"; the reason is logged so the build log explains itself.
    if (mode === 'incremental' && !viability.possible) {
      handlers.onLog({
        at: new Date().toISOString(),
        level: 'info',
        message: `回退为全量重建：${viability.reason}`,
      })
    } else if (useIncremental && pending.length < records.length) {
      handlers.onLog({
        at: new Date().toISOString(),
        level: 'info',
        message: `增量构建：本次重建 ${pending.length} 篇，复用已构建的 ${records.length - pending.length} 篇`,
      })
    }

    // Nothing to do is a real outcome, not an error: it means every document is
    // already indexed under the current strategy. Reported rather than silently
    // starting a build that would embed zero chunks.
    if (toEmbed.length === 0) {
      handlers.onLog({
        at: new Date().toISOString(),
        level: 'success',
        message: '所有文档均已构建且参数未变更，无需重建',
      })
      return { ok: true, started: false, chunks: 0, error: undefined }
    }

    // A build writes a whole snapshot, so admission is checked against its planned
    // footprint rather than zero. Without this a rebuild could double a store that
    // an upload had already been refused for — the quota would look unenforced at
    // exactly the moment it matters most.
    const plan = planBuild(toEmbed, strategy.chunking)
    const projectedBytes = estimateCost(plan, strategy.index, self.dimension).vectorBytes
      + toEmbed.reduce((sum, record) => sum + Buffer.byteLength(record.text, 'utf8'), 0)
    const admission = admit(root, self.quota, projectedBytes, '重建该知识库的索引')
    if (!admission.allowed) return { ok: false, started: false, chunks: 0, error: admission.reason ?? '存储配额不足' }

    const slot = inactiveSlot(meta)
    const incrementalFrom = useIncremental && meta.active !== null ? meta.active : undefined
    const launch = startJob(
      collectionId,
      logPathFor(root, collectionId),
      hooks => startBuild({
        storeRoot: root,
        collectionId,
        slot,
        index: strategy.index,
        documents: toEmbed.map(record => ({ docId: record.id, text: record.text })),
        // The collection's own total, which incremental builds would otherwise
        // under-report as just the documents they embedded.
        allDocCount: records.length,
        ...(incrementalFrom === undefined ? {} : { incrementalFrom }),
        // A re-uploaded document's id is new, so it cannot collide with an old one.
        // The ids that *can* collide are the ones already in the inherited snapshot
        // being rebuilt, which is exactly `toEmbed` minus the genuinely new.
        ...(incrementalFrom === undefined
          ? {}
          : { replacedDocIds: toEmbed.filter(record => record.chunks !== null).map(record => record.id) }),
        chunking: strategy.chunking,
        // An incremental build cloned the served slot, so the published snapshot's
        // FTS index still carries *that* slot's tokenizer — which `incrementalViability`
        // has already proved equals the current one. A full build creates a fresh
        // schema and takes the default. Passing it explicitly keeps the recorded
        // value truthful either way.
        ...(useIncremental ? { tokenizer: meta.tokenizer ?? TOKENIZER_NAME } : {}),
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
    // if nobody is polling. Only the embedded documents change status; the inherited
    // ones keep the counts they already had.
    void afterJobSettles(root, collectionId, slot, toEmbed, useIncremental)
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
 * Mark documents as built after a successful publish, with their chunk counts.
 *
 * **Read-modify-write over the whole log, never a replace with just the built
 * subset.** `replaceDocuments` swaps the entire document log, so writing only the
 * documents this build embedded would delete every other document from the
 * collection. An incremental build passes a subset here by definition, so this is
 * the difference between "reused the old chunks" and "silently destroyed the
 * documents it did not touch".
 *
 * The per-document split comes from the build's own chunking plan, so the stored
 * figure is what was actually written rather than a share computed afterwards.
 * @param root - store root.
 * @param collectionId - collection identifier.
 * @param built - the documents this build embedded.
 * @param chunksByDoc - chunks written per document id.
 * @param meta - metadata after publish.
 */
function markPublished(
  root: string,
  collectionId: string,
  built: DocumentRecord[],
  chunksByDoc: Record<string, number>,
  meta: SnapshotMeta | null,
): void {
  const at = meta?.builtAt ?? new Date().toISOString()
  // Keyed by id so the merge below is a lookup rather than a scan per document.
  const builtById = new Map(built.map(record => [record.id, record]))
  // The log as it stands, which for an incremental build includes every document
  // this build did not touch. Those keep their recorded state; the built ones are
  // refreshed from what the build actually did.
  const current = listDocuments(root, collectionId)
  const updated = current.map(record => {
    const rebuilt = builtById.get(record.id)
    if (rebuilt === undefined) return record
    return {
      ...record,
      status: 'ready' as const,
      // Falls back to the previously stored count when the build did not report one
      // for this document (a document whose text was empty, say). Falling back to
      // `null` instead would put the row back into 待构建 for no reason.
      chunks: chunksByDoc[record.id] ?? rebuilt.chunks ?? record.chunks,
      builtAt: at,
    }
  })
  // A document the build embedded but which is somehow absent from the log is added
  // rather than dropped: losing a record is worse than an unexpected row.
  const currentIds = new Set(current.map(record => record.id))
  for (const record of built) {
    if (currentIds.has(record.id)) continue
    updated.push({
      ...record,
      status: 'ready' as const,
      chunks: chunksByDoc[record.id] ?? record.chunks,
      builtAt: at,
    })
  }
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
 * @param records - the documents this build embedded. In an incremental build that
 *   is a subset; the inherited documents already hold their counts and status.
 * @param incremental - whether this build inherited chunks from the other slot.
 */
async function afterJobSettles(
  root: string,
  collectionId: string,
  slot: 'a' | 'b',
  records: DocumentRecord[],
  incremental: boolean,
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
    // A full build released the slot it wrote (the next build recreates it); an
    // incremental one keeps it, because that snapshot is now the served one and
    // holding its handle is what keeps the directory locked against a stale reader.
    if (!incremental) releaseSlot(root, collectionId, slot)

    // Reclaim the slot that is now stale.
    //
    // The build wrote `slot` and the publish flipped the pointer to it, so the
    // *other* slot holds the previous snapshot — reachable by nobody and never
    // cleaned up. Leaving it cost real disk: measured on a 20-document collection,
    // the stale slot held 24.24 MB of a 62.01 MB store (39%), and the quota check
    // counts it, so a user could be refused an upload by a directory they cannot
    // see or delete.
    //
    // Safe by construction, and this is the only moment it is: the next build's
    // write target is exactly this slot (`inactiveSlot` now returns it), so it
    // would be cleared by `resetSlot` or `cloneSlot` regardless. Deleting it here
    // only moves that work earlier. What must never happen is deleting a slot a
    // build is *reading from* — but a build reads the active slot, and this is the
    // inactive one, after the pointer has already moved.
    reclaimStaleSlot(root, collectionId)
  }
}

/**
 * Remove the snapshot slot that is no longer served.
 *
 * Reads the active slot from metadata rather than trusting the caller's view, so a
 * concurrent publish cannot make this delete the wrong directory: if the pointer
 * has moved again in the meantime, the slot this would have removed is now the
 * served one and is left alone.
 *
 * Best-effort by design. A failure here leaves disk occupied but nothing broken,
 * and `resetSlot` clears the directory on the next build anyway — which is the
 * same guarantee the code relied on before this existed.
 * @param root - absolute store root.
 * @param collectionId - collection identifier.
 */
function reclaimStaleSlot(root: string, collectionId: string): void {
  try {
    const meta = readMeta(root, collectionId)
    if (meta === null || meta.active === null) return
    const stale: 'a' | 'b' = meta.active === SLOTS[0] ? SLOTS[1] : SLOTS[0]
    const dir = slotDir(root, collectionId, stale)
    if (!existsSync(dir)) return
    // The handle must go first: the engine holds an exclusive lock per directory,
    // and on Windows an open handle makes the removal fail rather than leaving the
    // directory behind for the next build to reuse.
    releaseSlot(root, collectionId, stale)
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Disk not reclaimed this time; the next build clears the slot it writes into.
  }
}

/**
 * Whether two chunking configurations are equivalent.
 *
 * Compared field by field rather than by JSON text: the stored value and the
 * caller's value are built independently, so key order is not something either can
 * promise, and a text comparison would report a spurious change — forcing a full
 * rebuild of every document for no reason.
 *
 * A missing side is **not** equal. That direction is the safe one: an unreadable
 * stored value means the current parameters cannot be proven to match, and
 * reporting "changed" costs a full rebuild while reporting "same" would reuse
 * chunks cut with parameters nobody can name. Callers should check the stored side
 * before calling, but tolerating its absence here is what stops a malformed
 * metadata file from throwing out of a read-only viability question.
 * @param left - one configuration.
 * @param right - the other.
 * @returns whether they describe the same chunking.
 */
function sameChunking(left: ChunkingConfig | null | undefined, right: ChunkingConfig): boolean {
  if (left == null || right == null) return false
  return left.mode === right.mode
    && left.chunkTokens === right.chunkTokens
    && left.overlapTokens === right.overlapTokens
    && left.minChunkTokens === right.minChunkTokens
    && left.preserveCodeBlocks === right.preserveCodeBlocks
    && left.splitTablesByRow === right.splitTablesByRow
}

/** Removes a staging slot's contents; used by tests and recovery paths. */
export function discardStaging(storeRoot: string, collectionId: string, slot: 'a' | 'b'): void {
  rmSync(slotDir(storeRoot, collectionId, slot), { recursive: true, force: true })
  markActive(storeRoot, collectionId, slot)
}

export type { ChunkingConfig, EmbeddingModel, IndexConfig, PreviewResult, CostEstimate }
export { CHUNKING_DEFAULTS, INDEX_DEFAULTS }
