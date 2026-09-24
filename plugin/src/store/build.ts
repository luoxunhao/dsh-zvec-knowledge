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
import { ZVecOpen, type ZVecCollection } from '@zvec/zvec'
import { chunkDocument, type Chunk, type ChunkingConfig } from './chunk.ts'
import { chunkDocInput, chunkRowFromDoc, EMBEDDING_DIMENSION, FIELD_DOC_ID, FIELD_TEXT, TOKENIZER_NAME, VECTOR_FIELD, documentFilter, type ChunkRow, type IndexConfig } from './collection.ts'
import { cloneSlot, publishSlot, resetSlot, slotDir, type Slot } from './snapshot.ts'
import { adopt, releaseSlot } from './registry.ts'
import { listDocuments, patchDocument, type DocumentRecord } from './documents.ts'
import { gradeMarkdown, type StructureLevel } from './parse/grade.ts'
import { convertPdf, type ParseOptions, type ParseResult } from './parse/pdf.ts'
import { convertHtml } from './parse/html.ts'
import { convertDocx } from './parse/docx.ts'
import { admit, type Quota } from './quota.ts'
import type { ConverterId } from './extract.ts'

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

/**
 * Embedding provider.
 *
 * The provider is an external dependency the plugin does not own (the design spec
 * puts model selection out of scope), and in practice it is an HTTP service. Two
 * consequences shape this signature:
 *
 * - **It receives an `AbortSignal`.** A network call can hang, and a build that
 *   cannot be interrupted would pin the fiber until unload. The provider should
 *   pass the signal to its transport; a provider that ignores it still cannot hang
 *   the build, because {@link startBuild} races each batch against the signal.
 * - **It is called in batches.** Batching is the provider's contract rather than a
 *   per-text call, because an embedding API is materially faster and cheaper per
 *   request with several inputs.
 */
export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>

/** One document's build request. */
export interface DocumentBuildRequest {
  /** Source document id. */
  docId: string
  /**
   * Full document text, when it is already materialised.
   *
   * For a `verbatim` format the upload path decoded it, so the parse stage finds
   * the text here and converts nothing. For a `converted` format it is empty at
   * upload time — the derived text does not exist yet — and the parse stage
   * produces it from {@link source}.
   */
  text: string
  /**
   * Where to re-read the text from, when the text is not already materialised.
   *
   * Optional so callers that already hold text — including the existing
   * build-job gates — keep working unchanged.
   */
  source?: {
    /** Absolute path of the stored original. */
    file: string
    /** Which converter to run. */
    converter: ConverterId
    /** Force re-conversion even when `text` is already present. */
    reparse: boolean
  }
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
  /**
   * Vector width the embedding model returns.
   *
   * Passed in rather than read from a constant because the schema is created at
   * this width and the engine rejects anything else — so a mismatch must be caught
   * here with a message that names the model, not deep inside the engine.
   */
  dimension?: number
  /** Documents to index. */
  documents: DocumentBuildRequest[]
  /**
   * Where the parsed text is written back and a per-document failure is recorded.
   *
   * Optional because a caller that holds no document records — the pre-existing
   * build-job gates, an in-process `startBuild` — has nowhere to write and nothing
   * to fail. Omitted, the parse stage still converts and still keeps one bad
   * document from failing the build; it simply has no log to write the outcome to.
   */
  documentsFile?: {
    /** Absolute store root, as the documents module resolves paths against. */
    storeRoot: string
    /** Collection whose document log is written. */
    collectionId: string
  }
  /**
   * The resource envelope each conversion runs inside.
   *
   * Supplied by the caller rather than defaulted here, because these are
   * deployment tunables and the harness treats a `DEFAULT_*` constant in plugin
   * source as a missing configuration field. Required only in the sense that a
   * conversion cannot run without one: a request carrying no `source` never
   * converts, so it needs none.
   */
  parse?: ParseOptions
  /**
   * Storage quota, re-checked when parsing produces real text.
   *
   * **Why the parse stage checks it at all.** Admission at upload charges the
   * *original* bytes, because the derived text does not exist yet. A PDF is the
   * extreme case: admitted for 900 KB of bytes, it can produce megabytes of text
   * that then join the published snapshot. Without this second check the quota
   * would be enforced against a document that had not yet declared its real size,
   * which is exactly the state it exists to refuse.
   *
   * Omitted means unlimited, the same statement as `{bytes: null}` — so a caller
   * that says nothing is never refused.
   */
  quota?: Quota
  /**
   * Slot to inherit existing chunks from, for an incremental build.
   *
   * Set to the slot being served when only the listed documents need embedding:
   * the snapshot is cloned into `slot` and the other documents' chunks are carried
   * over. Omit it for a full build, which creates `slot` empty and embeds every
   * document in `documents`.
   */
  incrementalFrom?: Slot
  /**
   * Documents whose previously indexed chunks must be dropped first.
   *
   * Only meaningful with {@link incrementalFrom}. A cloned slot still holds the
   * chunks of any document being rebuilt — a re-uploaded file, or one whose text
   * changed — and leaving them would make the superseded revision retrievable.
   */
  replacedDocIds?: string[]
  /**
   * Total documents in the collection after this build.
   *
   * Distinct from `documents.length` because an incremental build embeds only the
   * changed documents while the collection holds all of them; without this the
   * published document count would report just the newly built ones. Defaults to
   * the number embedded, which is correct for a full build.
   */
  allDocCount?: number
  /** Chunking configuration. */
  chunking: ChunkingConfig
  /**
   * Tokenizer the published snapshot's full-text index uses.
   *
   * Passed in rather than read from the constant because an incremental build
   * inherits the tokenizer of the slot it cloned, which may be an older one. The
   * value is recorded in collection metadata so the next viability check can
   * compare it against what the code now wants and force a full rebuild when they
   * differ. Omit to record the current default (a fresh full build).
   */
  tokenizer?: string
  /**
   * Which parser produced the text this snapshot indexes.
   *
   * Recorded on the published snapshot so the next viability check can compare it
   * against the documents as they now stand and force a full rebuild when they
   * differ. The mixture is invisible otherwise, and it would silently invalidate
   * every stored citation line number — see the field's note in `snapshot.ts`.
   *
   * Derived here at publish time, from {@link parserFrom}, rather than passed in
   * ready-made: the summary describes what the documents were parsed *by*, and
   * the verdicts it summarizes are written by this build's own parse stage. A
   * caller reading the log before launching the build would record `unparsed` for
   * every document whose text the build has not produced yet.
   */
  parserFrom?: {
    /** Absolute store root, as the documents module resolves paths against. */
    storeRoot: string
    /** Collection whose document log is read. */
    collectionId: string
  }
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
  /**
   * Chunks written per source document id.
   *
   * Reported because the split is already known here — `planned` holds one entry
   * per document after the chunking stage — and discarding it left the caller
   * unable to record a real count. With more than one document the caller wrote
   * `null` for every row, and `null` is the 待构建 value, so a collection that had
   * built perfectly displayed 待构建 against every document.
   *
   * Empty when nothing was published (failure or cancellation).
   */
  chunksByDoc: Record<string, number>
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
  // Resolved once: the same width is used to create the schema and to validate
  // every batch, so the two checks cannot disagree about what was expected.
  const expectedWidth = request.dimension ?? EMBEDDING_DIMENSION
  const stages: StageProgress[] = STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'pending' }))
  let processed = 0
  let total = 0
  /**
   * Highest fraction published so far.
   *
   * `total` means two different things over a build's life — documents while the
   * parse stage runs, chunks afterwards — so the ratio `processed / total` is not
   * monotonic across the switch. A progress bar that goes backwards reads as a
   * glitch, and it is entirely avoidable: what a fraction is *for* is to say how
   * far along the build is, so it is only ever allowed to grow.
   */
  let fractionFloor = 0

  /** The fraction a pair of counts implies, bounded like the published one. */
  const fractionOf = (done: number, all: number): number => (all === 0 ? 0 : Math.min(1, done / all))

  /** Publish a progress snapshot. */
  const emit = (): void => {
    fractionFloor = Math.max(fractionFloor, fractionOf(processed, total))
    request.onProgress?.({
      stages: stages.map(stage => ({ ...stage })),
      processed,
      total,
      fraction: fractionFloor,
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
    // Hoisted out of the try so the cancellation path can report the count it
    // reached before stopping, rather than losing it at the catch boundary.
    let discarded = 0
    try {
      total = request.documents.length
      // Reported by *document* first, because the chunk count is not known until
      // the chunking stage runs and a bar that only moves after chunking looks
      // stalled when chunking is the slow half. The chunking stage then re-bases
      // `total` to the chunk count; `fraction` is held monotonic across that
      // switch so the bar never runs backwards.
      //
      // Written straight into the function-scoped `total` rather than into a
      // shadowing local, and **before** `enter('parse')` emits. `emit` closes over
      // the outer `total`, so a shadowing local here is written and then never
      // read — the bar sits at 0/0 for the whole parse stage while everything
      // else looks correct. And `enter` emits on its own, so setting the total
      // afterwards means the stage's first published snapshot is `0 / 0`: the
      // count is already known at this point (the documents arrived with the
      // request), so publishing zero first is simply wrong.
      enter('parse')
      // `let`, not `const`: the parse stage rebuilds the list from what it was
      // able to convert, and everything downstream reads the rebuilt list.
      let requests = await parseDocuments(request, controller.signal, () => {
        processed += 1
        emit()
      })
      const documents = requests.filter(document => document.text.trim() !== '')
      if (documents.length === 0) throw new Error('no readable content: every document is empty')
      if (controller.signal.aborted) return cancelled(0, 0, 0)

      enter('chunk')
      const planned: { docId: string, chunks: Chunk[] }[] = []
      for (const document of documents) {
        const result = chunkDocument(document.text, request.chunking)
        discarded += result.discarded
        planned.push({ docId: document.docId, chunks: result.chunks })
      }
      // Re-based from documents to chunks, with `processed` moved to the whole
      // document count first so the derived fraction is unchanged at the boundary
      // even when a document produced no chunks. The floor below then absorbs the
      // remaining case — chunk count smaller than document count — where the bare
      // ratio would dip.
      processed = Math.max(processed, documents.length)
      total = planned.reduce((sum, item) => sum + item.chunks.length, 0)
      fractionFloor = Math.max(fractionFloor, fractionOf(processed, total))
      log('info', `切分得到 ${total} 片，丢弃 ${discarded} 片碎片`)
      emit()
      if (controller.signal.aborted) return cancelled(0, 0, discarded)

      enter('index')
      // Two ways to arrive at a writable slot, and the difference is the whole
      // point of an incremental build:
      //
      // - `incremental` clones the served snapshot, so the chunks already indexed
      //   are inherited and only the listed documents are re-embedded. Uploading
      //   one document into a twenty-document collection then costs one document's
      //   embedding work instead of all twenty.
      // - otherwise the slot is created empty and every document is embedded.
      //
      // Either way the engine holds an exclusive lock per directory, so the registry
      // is told to release any cached reader on the target slot first.
      releaseSlot(request.storeRoot, request.collectionId, request.slot)
      if (request.incrementalFrom !== undefined) {
        const copied = cloneSlot(
          request.storeRoot, request.collectionId, request.incrementalFrom, request.slot,
        )
        log('info', `已复制上一份快照（${(copied / 1024 / 1024).toFixed(1)} MB），仅重建变更的文档`)
        handle = ZVecOpen(slotDir(request.storeRoot, request.collectionId, request.slot))
        // The cloned slot may still hold chunks for a document being replaced — a
        // re-upload of the same file, or a document whose content changed. Its old
        // chunks are removed before the new ones are written, or the previous
        // revision's text would stay retrievable and be cited.
        for (const document of documents) {
          if (!request.replacedDocIds?.includes(document.docId)) continue
          handle.deleteByFilterSync(documentFilter(document.docId))
        }
      } else {
        handle = resetSlot(request.storeRoot, request.collectionId, request.slot, request.index, expectedWidth)
      }
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
          // The signal is passed to the provider *and* raced against, because a
          // provider that ignores it (an HTTP client without cancellation, say)
          // would otherwise hang the build until the fiber unloads.
          const vectors = await raceAbort(request.embed(batch.map(chunk => chunk.text), controller.signal), controller)
          if (vectors.length !== batch.length) {
            throw new Error(`embedding provider returned ${vectors.length} vectors for ${batch.length} chunks`)
          }
          // The collection's schema is fixed at creation, so a provider that
          // returns a different width would otherwise fail deep inside the engine
          // with an error that says nothing about the model having changed.
          const width = vectors[0]?.length ?? 0
          if (width !== expectedWidth) {
            throw new Error(
              `嵌入模型返回 ${width} 维向量，但集合 schema 按 ${expectedWidth} 维创建。`
              + '换用不同维度的模型需要新建知识库，不能就地重建。',
            )
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
      // An incremental build's slot holds the inherited chunks *plus* the ones just
      // written, so the total is the engine's own figure and only the *added* part
      // is what this build embedded. Asserting `indexed === total` here would fail
      // on every incremental build by exactly the number of reused chunks.
      const inherited = request.incrementalFrom === undefined ? 0 : indexed - total
      if (request.incrementalFrom === undefined && indexed !== total) {
        throw new Error(`snapshot holds ${indexed} chunks but ${total} were expected`)
      }
      if (inherited < 0) {
        // The slot holds fewer chunks than this build wrote, which means the clone
        // did not carry what it should have — a silently wrong index is worse than
        // a failed build.
        throw new Error(`快照中的分片数（${indexed}）少于本次写入（${total}），增量构建的基准快照不完整`)
      }
      const publishedChunks = indexed
      // Read from the log *here*, after the parse stage has written every verdict:
      // the summary has to describe the whole document set — including the
      // documents an incremental build inherited and never embedded — and the
      // parse stage's own verdicts only exist from this point on.
      const parserSummary = request.parserFrom === undefined
        ? null
        : recordParser(listDocuments(request.parserFrom.storeRoot, request.parserFrom.collectionId))
      // The collection's document total, which for an incremental build is larger
      // than the number embedded here.
      const allDocCount = request.allDocCount ?? documents.length
      await publishSlot(request.storeRoot, request.collectionId, request.slot, {
        chunks: publishedChunks,
        docs: allDocCount,
        chunking: request.chunking,
        // What the published snapshot's FTS index actually uses. A full build
        // creates the schema here so it is the current constant; an incremental
        // build cloned the served slot and inherited *its* tokenizer, so the
        // caller passes that value through. Recording the truth rather than the
        // preference is what lets the next viability check notice a mismatch.
        tokenizer: request.tokenizer ?? TOKENIZER_NAME,
        ...(parserSummary === null ? {} : { parser: parserSummary }),
      })
      processed = total
      stages[STAGES.indexOf('publish')]!.state = 'done'
      log('success', request.incrementalFrom === undefined
        ? `索引已发布：${publishedChunks} 片 / ${allDocCount} 篇`
        : `增量发布：新增 ${total} 片，复用 ${inherited} 片，共 ${publishedChunks} 片 / ${allDocCount} 篇`)
      emit()
      return {
        ok: true,
        chunks: publishedChunks,
        docs: allDocCount,
        discarded,
        // The per-document split, from the chunking stage's own plan. Reported
        // rather than recomputed so the stored count cannot disagree with what was
        // actually written.
        chunksByDoc: Object.fromEntries(planned.map(item => [item.docId, item.chunks.length])),
      }
    } catch (error) {
      // A failed build must not leave its staging slot locked: the engine holds
      // an exclusive lock per directory, so an unreleased handle would make the
      // retry fail with a lock error instead of a clean rebuild.
      releaseSlot(request.storeRoot, request.collectionId, request.slot)
      discardSlot(request.storeRoot, request.collectionId, request.slot)
      // A cancellation that surfaced as a rejected race settles the same way as
      // one the loop noticed between batches, so the two paths cannot diverge.
      if (error instanceof BuildCancelled) return cancelled(processed, 0, discarded)
      const message = String(error instanceof Error ? error.message : error)
      log('error', message)
      return { ok: false, chunks: 0, docs: 0, discarded: 0, chunksByDoc: {}, error: message }
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
      // Empty: a cancelled build publishes nothing, so no document acquired a count.
      return { ok: false, chunks: written, docs, discarded: dropped, chunksByDoc: {}, error: 'cancelled' }
    }
  })()

  return { done, cancel: () => controller.abort() }
}

/**
 * Summarize the parser a document set was produced by.
 *
 * The set of converter ids plus the set of structure verdicts, sorted and joined
 * — a *summary* rather than a digest of every document, because those two sets
 * are exactly what an incremental build could silently mix. Two documents
 * converted by the same converter with the same verdict are interchangeable as
 * far as the index is concerned; the moment either set differs from what the
 * served snapshot recorded, the snapshot holds text from more than one parser and
 * a full rebuild is the only honest answer.
 *
 * A document with no `converter` was decoded verbatim from text, which is a
 * parser too — and one that can equally be swapped for a real converter later.
 * @param records - the documents as they stand.
 * @returns the summary recorded in the snapshot's metadata.
 */
function recordParser(records: DocumentRecord[]): { converter: string, structure: string } {
  const converters = [...new Set(records.map(record => record.converter ?? 'verbatim'))].sort()
  const structures = [...new Set(records.map(record => record.structure ?? 'unparsed'))].sort()
  return { converter: converters.join(','), structure: structures.join(',') }
}

/**
 * Convert every document that is not already text, one guarded conversion each.
 *
 * **The single most important property of this function is that it does not
 * throw for a document-level problem.** `startBuild`'s outer `try/catch` discards
 * the staging slot and fails the entire build, so a conversion failure that
 * escaped from here would make one unreadable PDF destroy a collection's whole
 * index — the upload that started it is not even the one that would suffer. So
 * each document is converted inside its own guard and a failure is recorded *on
 * that document*: its status becomes `failed` with the converter's own reason,
 * and the build continues with the rest.
 *
 * What still fails the build is a *systemic* fault: the document log cannot be
 * written, the process is out of memory. Those are not properties of one file,
 * and retrying the build would not fix them.
 *
 * Documents that carry no {@link DocumentBuildRequest.source} are taken as they
 * are — that is the pre-existing caller, which already holds its text.
 * @param request - the build request, for the source files, envelope and log.
 * @param signal - the build's cancellation signal.
 * @param onDocument - invoked once per document, for progress.
 * @returns the documents that survived, with their text materialised.
 */
async function parseDocuments(
  request: BuildRequest,
  signal: AbortSignal,
  onDocument: () => void,
): Promise<DocumentBuildRequest[]> {
  const kept: DocumentBuildRequest[] = []
  for (const document of request.documents) {
    if (signal.aborted) return kept
    // **There is deliberately no "already failed, so skip it" check here.** An
    // earlier revision had one, reading the document log for a `failed` status and
    // `continue`-ing before the guards below. It was wrong in a way that is worth
    // recording, because it looked like a sensible optimisation:
    //
    // A failure is often *transient* — a partial upload, a write that hit ENOSPC, a
    // converter bug fixed in the next release — and the stored original is kept
    // byte-for-byte precisely so the text can be re-derived when the cause is gone.
    // A skip here means the original is never re-read, so the document is
    // permanently poisoned across every future build with no way to recover except
    // deleting it and re-uploading under a new id. Measured: with the check in
    // place, an explicit `mode: 'full'` rebuild left a document `failed` while a
    // perfectly good original sat on disk.
    //
    // Deciding which documents to *submit* is the caller's job, where the
    // incremental/full distinction actually lives — see `buildIndex`, which skips
    // known-failed documents on the incremental branch only. This function converts
    // what it is given and judges each one honestly.
    //
    // A document whose text is already present and which is not being reparsed
    // needs no conversion at all, and must not be charged for one.
    if (document.source === undefined || (!document.source.reparse && document.text.trim() !== '')) {
      kept.push(document)
      onDocument()
      continue
    }
    try {
      const outcome = await convertOne(document, request)
      if (outcome.failed === true) {
        failOne(request, document, outcome.error ?? '解析未产出文本')
      } else {
        const reason = admitParsedText(request, document, outcome.text)
        if (reason !== null) {
          failOne(request, document, reason)
        } else {
          keep(request, document, outcome.text, outcome.structure)
          kept.push({ ...document, text: outcome.text })
        }
      }
    } catch (error) {
      // A systemic fault — an unwritable document log, a broken engine import —
      // is reported to the caller rather than swallowed into a per-document
      // failure, because "this document is bad" would be a false statement about
      // a file that is fine.
      if (isSystemic(error)) throw error
      failOne(request, document, describeFailure(error, document.source.converter))
    }
    onDocument()
    // One document at a time is not enough on its own: a conversion is
    // synchronous for most of its cost, so without this an empty await queue
    // would still hold the host's loop for the length of a whole corpus.
    await yieldToEventLoop()
  }
  return kept
}

/**
 * Run one document's converter.
 *
 * The dispatch table is exhaustive over {@link ConverterId}, which is the whole
 * reason it exists as a type: a format the upload path advertises but whose
 * converter is not implemented yet must fail here, loudly and by name, rather
 * than produce an empty text that would be indexed as a document with no
 * content. That is the failure mode this table is shaped to prevent — a
 * successful-looking build of nothing.
 * @param document - the document, with its source.
 * @param request - the build request, for the envelope.
 * @returns the converter's result.
 */
async function convertOne(
  document: DocumentBuildRequest,
  request: BuildRequest,
): Promise<ParseResult> {
  const source = document.source as NonNullable<DocumentBuildRequest['source']>
  const options: ParseOptions = { ...envelope(request) }
  // The signal is attached only when the caller supplied one, so an aborted
  // conversion is reported by the converter as a failure rather than looked for
  // here — the converter knows where in its own work the cancellation landed.
  if (request.parse?.signal !== undefined) options.signal = request.parse.signal
  switch (source.converter) {
    case 'pdf':
      return convertPdf(source.file, options)
    case 'html':
      // `.html` and `.htm` both land here — `extract.ts` gives them one
      // converter id on purpose, since they are one format. The DOCX converter
      // does **not** come through this case: it reads the OOXML itself
      // and hands mammoth's HTML to the trunk's string entry, so it owns its own
      // envelope and its own failure modes.
      return convertHtml(source.file, options)
    case 'docx':
      return convertDocx(source.file, options)
    default:
      // xlsx / csv / json are declared by `extract.ts` and have no
      // implementation yet. Returning an empty success here would be the worst
      // available outcome: the build reports the document as parsed, indexes no
      // text for it, and nothing says why.
      return {
        text: '',
        structure: 'flat-text',
        truncated: false,
        failed: true,
        error: `${source.converter} 转换器尚未实现，该文档无法解析（已声明但无实现的格式编号）`,
      }
  }
}

/** The conversion envelope, with the tiers always present. */
function envelope(request: BuildRequest): ParseOptions {
  const parse = request.parse
  return {
    timeoutMs: parse?.timeoutMs ?? 0,
    maxPages: parse?.maxPages ?? 0,
    maxTextBytes: parse?.maxTextBytes ?? 0,
  }
}

/**
 * Decide whether a document's freshly produced text still fits the quota.
 *
 * The second half of a two-phase check. Upload admitted the *original* bytes,
 * because at that moment the derived text did not exist; parsing is where it
 * starts to exist, so this is the only place the real footprint can be measured.
 * A document that no longer fits fails *itself* — the rest of the collection is
 * unaffected, which is the same containment rule the conversion guard follows.
 * @param request - the build request, for the quota.
 * @param document - the document whose text was just produced.
 * @param text - that text.
 * @returns the refusal reason, or `null` when the document may be kept.
 */
function admitParsedText(
  request: BuildRequest,
  document: DocumentBuildRequest,
  text: string,
): string | null {
  const where = request.documentsFile
  if (request.quota === undefined || where === undefined) return null
  const admission = admit(
    where.storeRoot,
    request.quota,
    Buffer.byteLength(text, 'utf8'),
    `解析文档 ${document.docId} 的正文`,
  )
  return admission.allowed ? null : admission.reason ?? '存储配额不足'
}

/**
 * Record a successful parse on the document and in the build log.
 *
 * **This write is the document's verdict, so it must clear a previous failure.**
 * `failOne` writes `status: 'failed'` and a reason; a document that is later
 * re-converted successfully — which is the whole point of a full rebuild re-reading
 * the stored original — has to come back out of that state, or the record holds
 * perfectly good text while still displaying the previous build's error. Measured
 * before this was fixed: after repairing a stored original and rebuilding, the record
 * held 63 characters of text and the build had indexed two chunks for it, yet the
 * status still read `failed` with the old reason.
 *
 * `error: undefined` is written explicitly rather than omitted: `patch` merges, so
 * leaving the key out would preserve the old message. `JSON.stringify` drops an
 * undefined value, so the field is genuinely removed from the record, not written as
 * `null`.
 *
 * The status is set back to `pending`, not straight to `ready`: a build's own parse
 * stage does not decide that a document is *published*. `markPublished` does that
 * after the snapshot is live, and a document that failed to be embedded must not be
 * marked ready by the stage that merely produced its text.
 * @param request - the build request, for the log target.
 * @param document - the parsed document.
 * @param text - the produced Markdown.
 * @param structure - how much structure survived.
 */
function keep(
  request: BuildRequest,
  document: DocumentBuildRequest,
  text: string,
  structure: StructureLevel,
): void {
  patch(request, document.docId, {
    text,
    structure,
    parsedAt: new Date().toISOString(),
    status: 'pending',
    error: undefined,
    ...(document.source === undefined ? {} : { converter: document.source.converter }),
  })
}

/**
 * Mark one document as failed, leaving every other document alone.
 *
 * Both halves matter and they are written together: the log is what the panel
 * shows, and the log line is what makes the failure visible in the build's own
 * output. A build that quietly indexed fourteen of fifteen documents and said
 * nothing would be indistinguishable from a complete one.
 * @param request - the build request, for the log target.
 * @param document - the document that failed.
 * @param reason - why, in the user's language.
 */
function failOne(request: BuildRequest, document: DocumentBuildRequest, reason: string): void {
  patch(request, document.docId, { status: 'failed', error: reason, chunks: null })
}

/**
 * Apply a read-modify-write to one document record.
 *
 * Best effort, and logged when it fails: the document log is diagnostics for the
 * *next* build and for the panel, while the index in flight is the artifact this
 * build exists to produce. Throwing here would convert an unwritable log into a
 * failed build, which is the systemic failure this stage is careful not to
 * manufacture.
 * @param request - the build request, for the log target.
 * @param docId - the document to patch.
 * @param fields - the fields to change.
 */
function patch(
  request: BuildRequest,
  docId: string,
  fields: Parameters<typeof patchDocument>[3],
): void {
  const where = request.documentsFile
  if (where === undefined) return
  try {
    patchDocument(where.storeRoot, where.collectionId, docId, fields)
  } catch (error) {
    request.onLog?.({
      at: new Date().toISOString(),
      level: 'error',
      message: `文档状态写入失败（${docId}）：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * Whether a failure is the store's rather than the document's.
 *
 * The distinction decides who pays for it. A missing file, a broken PDF and an
 * unsupported converter are all properties of one document, so the document
 * fails. An out-of-memory, a closed engine handle or anything else that is not
 * about the file at hand is systemic, and reporting it as "this document is bad"
 * would be a false statement that also hides a real fault.
 * @param error - the thrown value.
 * @returns true when the build as a whole should fail.
 */
function isSystemic(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'RangeError'
    || /out of memory|heap|ENOSPC|EBUSY/i.test(error.message)
}

/**
 * Turn a thrown conversion failure into something a user can act on.
 *
 * The converter id is named because it is the actionable part: "the pdf
 * converter failed" tells the reader which format to work around, while a bare
 * stack trace names nothing they can change.
 * @param error - the thrown value.
 * @param converter - which converter was running.
 * @returns the reason, in the user's language.
 */
function describeFailure(error: unknown, converter: ConverterId): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${converter} 转换失败：${message}`
}

/**
 * Yield the event loop between two documents.
 *
 * The host runs one fiber per plugin, and a corpus-wide parse is minutes of
 * nearly-synchronous work. `setImmediate` gives the loop a turn between
 * documents, so the progress the parse stage emits can actually be delivered
 * rather than queued behind the whole build.
 * @returns a promise resolved on the loop's next turn.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

/**
 * Reject as soon as the build's controller aborts, whatever the work is doing.
 *
 * Observing a signal only *between* awaits is not enough: an embedded HTTP client
 * that never returns would leave the await pending forever and the cancellation
 * would never be seen. Racing makes the abort immediate regardless of provider
 * behaviour.
 * @param work - the in-flight operation.
 * @param controller - the build's controller.
 * @returns the work's result, or a rejection once aborted.
 */
async function raceAbort<T>(work: Promise<T>, controller: AbortController): Promise<T> {
  if (controller.signal.aborted) throw new BuildCancelled()
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new BuildCancelled()), { once: true })
  })
  return Promise.race([work, aborted])
}

/**
 * Raised when a build is cancelled mid-operation.
 *
 * A distinct type rather than a message, because the catch block has to tell a
 * cancellation from a genuine failure: one settles as "cancelled", the other as an
 * error, and matching on text would break the moment a provider's message happens
 * to contain the wrong word.
 */
export class BuildCancelled extends Error {
  /** Creates the cancellation marker. */
  constructor() {
    super('build cancelled')
    this.name = 'BuildCancelled'
  }
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

/** Field names the build writes, re-exported for the verification path. */
export { FIELD_DOC_ID, FIELD_TEXT, VECTOR_FIELD, chunkRowFromDoc }
