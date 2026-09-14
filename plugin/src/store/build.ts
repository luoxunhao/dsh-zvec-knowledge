/**
 * Index build: the four-stage pipeline, its progress, cancellation and retry.
 *
 * The spec's pipeline is 解析文档 → 切分与嵌入 → 写入索引 → 校验与发布, and the spec
 * is explicit that every stage must report both a node state *and* a stage name —
 * a nameless progress bar is called out as a violation. That is why
 * {@link BuildProgress.stages} carries a label rather than leaving the UI to
 * invent one.
 *
 * Two rules shape the implementation:
 *
 * - **A rebuild never interrupts retrieval.** Writes go into the *inactive*
 *   snapshot slot and the publish stage flips a pointer (see `snapshot.ts`), so a
 *   search in flight keeps reading the previous index. The spec requires the UI
 *   to say retrieval is answering from the last snapshot; this module is what
 *   makes that statement true rather than a hopeful claim.
 * - **Cancellation and failure leave a consistent state.** Both discard the slot
 *   they were writing. The served snapshot is never the write target, so there is
 *   no half-populated index to roll back — only a stale slot to overwrite next
 *   time, which is why the rollback here is a close rather than a delete.
 *
 * @module dsh-zvec-knowledge/store/build
 */

import { rmSync } from 'node:fs'
import type { ZVecCollection } from '@zvec/zvec'
import { chunkDocument, type Chunk, type ChunkingConfig } from './chunk.ts'
import { chunkDocInput, chunkRowFromDoc, FIELD_DOC_ID, FIELD_TEXT, VECTOR_FIELD, documentFilter, type ChunkRow, type IndexConfig } from './collection.ts'
import { publishSlot, resetSlot, slotDir, type Slot } from './snapshot.ts'
import { adopt, releaseSlot } from './registry.ts'

/** The four pipeline stages, in spec order. */
export const STAGES = ['parse', 'chunk', 'index', 'publish'] as const

/** One pipeline stage identifier. */
export type StageId = typeof STAGES[number]

/** Display label for a stage. The spec forbids a stage with no name. */
export const STAGE_LABELS: Record<StageId, string> = {
  parse: '解析文档',
  chunk: '切分与嵌入',
  index: '写入索引',
  publish: '校验与发布',
}

/** Node state within a stage, mirroring the spec's three shapes. */
export type StageState = 'pending' | 'running' | 'done'

/** A stage with its label and current state. */
export interface StageProgress {
  /** Stage identifier. */
  id: StageId
  /** Display label; always present so the UI never renders a bare bar. */
  label: string
  /** Current node state. */
  state: StageState
}

/** Progress snapshot handed to the UI. */
export interface BuildProgress {
  /** Per-stage state, in pipeline order. */
  stages: StageProgress[]
  /** Items finished so far. */
  processed: number
  /** Total items, once known. Zero until the parse stage has measured. */
  total: number
  /** Fraction in [0, 1], derived so the UI cannot disagree with the counts. */
  fraction: number
}

/** One build log line, in the shape the collapsible log renders. */
export interface BuildLogLine {
  /** ISO-8601 timestamp. */
  at: string
  /** Severity, mapped to the spec's colour semantics. */
  level: 'success' | 'running' | 'info' | 'error'
  /** Message text. */
  message: string
}

/** Embedding function the caller supplies; the plugin does not own the model. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>

/** One document's build request. */
export interface DocumentBuildRequest {
  /** Source document id. */
  docId: string
  /** Full document text. */
  text: string
}

/** Build request for a whole collection. */
export interface BuildRequest {
  /** Absolute store root. */
  storeRoot: string
  /** Collection identifier. */
  collectionId: string
  /** Slot to write into; must be the inactive one. */
  slot: Slot
  /** Index configuration for the new snapshot's schema. */
  index: IndexConfig
  /** Documents to index. */
  documents: DocumentBuildRequest[]
  /** Chunking configuration. */
  chunking: ChunkingConfig
  /** Embedding provider. */
  embed: EmbedFn
  /** Progress callback, invoked as stages and counts change. */
  onProgress?: (progress: BuildProgress) => void
  /** Log callback, invoked per line. */
  onLog?: (line: BuildLogLine) => void
}

/** Result of a completed build. */
export interface BuildResult {
  /** Whether the build reached the publish stage. */
  ok: boolean
  /** Chunks written to the new snapshot. */
  chunks: number
  /** Distinct documents indexed. */
  docs: number
  /** Chunks discarded for falling below the minimum size. */
  discarded: number
  /** Failure or cancellation reason, when `ok` is false. */
  error?: string
}

/** A running build, exposing cancellation. */
export interface RunningBuild {
  /** Resolves when the build settles for either reason. */
  done: Promise<BuildResult>
  /** Request cancellation; the build settles as not-ok and discards its slot. */
  cancel: () => void
}

/** How often progress is emitted, in chunks, so a large document stays responsive. */
const PROGRESS_INTERVAL = 64

/**
 * Chunk, embed and index a set of documents into a snapshot slot.
 *
 * The returned handle lets a caller cancel a build already in flight; the async
 * work starts immediately either way. Only ids that were actually written are
 * tracked, so a failure reports what it managed to do.
 * @param request - build inputs and callbacks.
 * @returns a handle with the settling promise and a cancel function.
 */
export function startBuild(request: BuildRequest): RunningBuild {
  const controller = new AbortController()
  const stages: StageProgress[] = STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'pending' }))
  let processed = 0
  let total = 0

  /** Publish a progress snapshot. */
  const emit = (): void => {
    request.onProgress?.({
      stages: stages.map(stage => ({ ...stage })),
      processed,
      total,
      fraction: total === 0 ? 0 : Math.min(1, processed / total),
    })
  }

  /** Append a log line. */
  const log = (level: BuildLogLine['level'], message: string): void => {
    request.onLog?.({ at: new Date().toISOString(), level, message })
  }

  /** Move to a stage, marking everything before it done. */
  const enter = (id: StageId): void => {
    const index = STAGES.indexOf(id)
    for (const [position, stage] of stages.entries()) {
      stage.state = position < index ? 'done' : position === index ? 'running' : 'pending'
    }
    log('running', STAGE_LABELS[id])
    emit()
  }

  const done = (async (): Promise<BuildResult> => {
    let handle: ZVecCollection | null = null
    try {
      enter('parse')
      const documents = request.documents.filter(document => document.text.trim() !== '')
      if (documents.length === 0) throw new Error('no readable content: every document is empty')
      if (controller.signal.aborted) return cancelled(0, 0, 0)

      enter('chunk')
      const planned: { docId: string, chunks: Chunk[] }[] = []
      let discarded = 0
      for (const document of documents) {
        const result = chunkDocument(document.text, request.chunking)
        discarded += result.discarded
        planned.push({ docId: document.docId, chunks: result.chunks })
      }
      total = planned.reduce((sum, item) => sum + item.chunks.length, 0)
      log('info', `切分得到 ${total} 片，丢弃 ${discarded} 片碎片`)
      emit()
      if (controller.signal.aborted) return cancelled(0, 0, discarded)

      enter('index')
      // The engine holds an exclusive lock per directory, so the registry is told
      // to release any cached reader on this slot before the directory is recreated.
      releaseSlot(request.storeRoot, request.collectionId, request.slot)
      handle = resetSlot(request.storeRoot, request.collectionId, request.slot, request.index)
      // Adopt immediately: the handle now owns the directory's lock, and a stale
      // registry entry would make the next acquire fail rather than reuse it.
      adopt(request.storeRoot, request.collectionId, request.slot, handle)
      // Embed in batches so a long document does not hold every vector at once,
      // and so progress advances at a rate a user can actually watch.
      const BATCH = 16
      let sinceEmit = 0
      for (const item of planned) {
        for (let offset = 0; offset < item.chunks.length; offset += BATCH) {
          if (controller.signal.aborted) return cancelled(processed, 0, discarded)
          const batch = item.chunks.slice(offset, offset + BATCH)
          const vectors = await request.embed(batch.map(chunk => chunk.text))
          if (vectors.length !== batch.length) {
            throw new Error(`embedding provider returned ${vectors.length} vectors for ${batch.length} chunks`)
          }
          if (controller.signal.aborted) return cancelled(processed, 0, discarded)
          handle.upsertSync(batch.map((chunk, index) => chunkDocInput(toRow(item.docId, chunk), vectors[index] as Float32Array)))
          processed += batch.length
          sinceEmit += batch.length
          if (sinceEmit >= PROGRESS_INTERVAL) {
            sinceEmit = 0
            emit()
          }
        }
      }
      emit()

      enter('publish')
      // The count is read back from the engine rather than from the loop's own
      // tally, so a write the engine silently dropped cannot pass verification.
      const indexed = countChunks(handle)
      if (indexed !== total) {
        throw new Error(`snapshot holds ${indexed} chunks but ${total} were expected`)
      }
      await publishSlot(request.storeRoot, request.collectionId, request.slot, {
        chunks: total,
        docs: documents.length,
      })
      processed = total
      stages[STAGES.indexOf('publish')]!.state = 'done'
      log('success', `索引已发布：${total} 片 / ${documents.length} 篇`)
      emit()
      return { ok: true, chunks: total, docs: documents.length, discarded }
    } catch (error) {
      // A failed build must not leave its staging slot locked: the engine holds
      // an exclusive lock per directory, so an unreleased handle would make the
      // retry fail with a lock error instead of a clean rebuild.
      releaseSlot(request.storeRoot, request.collectionId, request.slot)
      discardSlot(request.storeRoot, request.collectionId, request.slot)
      const message = String(error instanceof Error ? error.message : error)
      log('error', message)
      return { ok: false, chunks: 0, docs: 0, discarded: 0, error: message }
    }

    /**
     * Settle as cancelled.
     *
     * The abandoned slot is discarded and unlocked. Nothing a reader can reach
     * was touched — the write target is always the inactive slot — so retrieval
     * keeps answering from the previous snapshot, which is what the log says.
     * @param written - chunks written before cancellation, for the log.
     * @param docs - documents completed before cancellation.
     * @param dropped - chunks discarded during chunking.
     */
    function cancelled(written: number, docs: number, dropped: number): BuildResult {
      releaseSlot(request.storeRoot, request.collectionId, request.slot)
      discardSlot(request.storeRoot, request.collectionId, request.slot)
      log('info', '构建已取消，检索仍返回上一次快照')
      return { ok: false, chunks: written, docs, discarded: dropped, error: 'cancelled' }
    }
  })()

  return { done, cancel: () => controller.abort() }
}

/**
 * Build a chunk's engine document id.
 *
 * Namespaced by document so two documents' chunk 0 never collide, which is what
 * lets one document be addressed without touching its neighbours.
 * @param docId - source document id.
 * @param ordinal - chunk ordinal.
 * @returns engine document id.
 */
export function chunkId(docId: string, ordinal: number): string {
  return `${docId}#${ordinal}`
}

/**
 * Project a chunk into a storage row.
 * @param docId - source document id.
 * @param chunk - chunk with its character range.
 * @returns the row to store.
 */
function toRow(docId: string, chunk: Chunk): ChunkRow {
  return {
    id: chunkId(docId, chunk.ordinal),
    docId,
    ordinal: chunk.ordinal,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    text: chunk.text,
  }
}

/**
 * Remove a staging slot's directory after a failed or cancelled build.
 *
 * Removing it is what makes the retry work: the engine's create-and-open demands
 * an absent path, so a leftover directory from a failed attempt would make every
 * later build fail until someone deleted it by hand. The active slot is never
 * passed here.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param slot - slot to discard.
 */
function discardSlot(storeRoot: string, collectionId: string, slot: Slot): void {
  try {
    rmSync(slotDir(storeRoot, collectionId, slot), { recursive: true, force: true })
  } catch {
    // Best effort: the next build's resetSlot clears whatever remains.
  }
}

/**
 * Count the chunks visible through the retrieval path.
 * @param handle - open snapshot handle.
 * @returns chunk count, or 0 when the engine reports nothing.
 */
function countChunks(handle: ZVecCollection): number {
  try {
    return handle.stats.docCount
  } catch {
    return 0
  }
}

/**
 * Filter expression matching one document's chunks, re-exported so a caller does
 * not reach into the collection module for it.
 * @param docId - source document id.
 * @returns filter expression matching that document's chunks.
 */
export function documentChunkFilter(docId: string): string {
  return documentFilter(docId)
}

/** Field names the build writes, re-exported for the verification path. */
export { FIELD_DOC_ID, FIELD_TEXT, VECTOR_FIELD, chunkRowFromDoc }
