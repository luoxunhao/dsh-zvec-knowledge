/**
 * The citation tab's body: the passage a citation points at, with its line marked.
 *
 * The reader's job is to make one claim checkable, so the layout is ordered by
 * what the reader is looking for:
 *
 * 1. **Where this is** — document, line, and how much of the document the excerpt
 *    covers. Stated as `第 374 行 · 共 471 行`, never as a bare `374`, because an
 *    excerpt that does not announce itself reads as the whole document.
 * 2. **The passage** — the window around the cited line, with the citation's own
 *    line and the retrieved chunk's span marked *differently*. They are different
 *    facts: one is the locator the answer printed, the other is what retrieval
 *    actually returned, and collapsing them into one highlight would hide the case
 *    where a citation names a line outside its own chunk.
 * 3. **The provenance** — the store path, the score and the query. Kept last
 *    because it is what a reader checks *after* reading, not before.
 *
 * ## States
 *
 * Every state the reader can be in is rendered explicitly: loading, loaded, the
 * document has been deleted since the answer was written, and the transport
 * failed. The deleted case is not an error — a collection can be rebuilt or a
 * document removed between the answer and the click — so it says so in the plain
 * voice of a fact rather than presenting a failure for the reader to act on.
 *
 * @module dsh-zvec-knowledge/client/CitationTabView
 */

import { useEffect, useState } from 'react'
import type { SidebarRightTabBodyProps } from './slots.ts'
import {
  citationAddress, parseCitationAddress, type CitationParams, type CitationRef,
} from './citation-tab.ts'
import styles from './CitationTabView.module.css'

/**
 * One line of the excerpt, as the host reports it.
 *
 * Mirrors the host's `CitationLine`. Restated rather than imported: the client
 * bundle may not import host code (a host module pulls Node built-ins into the
 * browser), so the two shapes meet at the wire and each states its own side.
 */
interface CitationLineView {
  /** 1-based line number in the full document. */
  number: number
  /** The line's text. */
  text: string
  /** Whether this is the citation's own line. */
  isCitedLine: boolean
  /** Whether this line overlaps the cited chunk. */
  inChunk: boolean
}

/** The host's excerpt, as the wire carries it. */
interface CitationView {
  /** Collection the citation belongs to. */
  collectionId: string
  /** Document id. */
  docId: string
  /** Original file name. */
  docName: string
  /** Lower-case extension. */
  ext: string
  /** Workspace-relative path of the stored snapshot. */
  sourcePath: string
  /** Cited line. */
  line: number
  /** Total lines in the document. */
  totalLines: number
  /** The excerpt's lines. */
  lines: CitationLineView[]
  /** First line number in `lines`. */
  windowStart: number
  /** Chunk character range. */
  chunkCharStart: number
  /** Chunk end offset. */
  chunkCharEnd: number
}

/** The read this body performs; injected so the component is testable. */
export interface CitationReader {
  /**
   * Read one cited passage.
   * @param collectionId - collection identifier.
   * @param docId - cited document id.
   * @param line - cited line.
   * @param range - the cited chunk's character range, when known.
   * @param signal - caller cancellation.
   * @returns the excerpt, or `null` when the document is gone.
   */
  read: (
    collectionId: string,
    docId: string,
    line: number,
    range: { start: number, end: number } | null,
    signal?: AbortSignal,
  ) => Promise<CitationView | null>
}

/** Props for {@link CitationTabView}. */
export interface CitationTabViewProps extends SidebarRightTabBodyProps {
  /** The host read. Optional so the body renders its empty state without a port. */
  reader?: CitationReader
  /**
   * The citation this tab shows.
   *
   * Passed by the owner rather than read off the slot's owner share, because the
   * share's exact composition is the seat's business: the tab body registration
   * narrows it once, at the edge, and hands the component a decided value.
   */
  citation?: CitationRef
  /** The citation's view parameters. */
  params?: CitationParams
}

/** Which state the reader is in. */
type Phase =
  | { kind: 'loading' }
  | { kind: 'loaded', view: CitationView }
  | { kind: 'missing' }
  | { kind: 'failed', message: string }

/**
 * Read the citation reference out of a tab's live information.
 *
 * Tolerant by design: the seat's owner share is not restated in this plugin's
 * types, so the address is recovered from whichever of the two names the seat
 * uses and an unrecognized share degrades to "no citation" rather than throwing
 * inside a pane the user cannot dismiss.
 * @param props - the body's props.
 * @returns the citation, or `null`.
 */
export function citationOf(props: CitationTabViewProps): CitationRef | null {
  if (props.citation !== undefined) return props.citation
  const info = props.tab ?? props.tabInfo
  const address = info?.navigation?.address
  return typeof address === 'string' ? parseCitationAddress(address) : null
}

/**
 * Read the citation's view parameters off the tab's live information.
 * @param props - the body's props.
 * @returns the params, or an empty object.
 */
export function paramsOf(props: CitationTabViewProps): CitationParams {
  if (props.params !== undefined) return props.params
  const info = props.tab ?? props.tabInfo
  const params = info?.navigation?.params
  return typeof params === 'object' && params !== null ? params as CitationParams : {}
}

/** Format the position line. */
function positionLabel(view: CitationView): string {
  return `第 ${view.line} 行 · 共 ${view.totalLines} 行`
}

/**
 * Render one citation tab.
 * @param props - the citation and the host read.
 * @returns the reader.
 */
export function CitationTabView(props: CitationTabViewProps): React.JSX.Element {
  const ref = citationOf(props)
  const params = paramsOf(props)
  const reader = props.reader

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    // Without a port the pane states that rather than showing a spinner that never
    // resolves: a host that never wired the bridge is a configuration fact.
    if (reader === undefined || ref === null) {
      setPhase({ kind: 'failed', message: '宿主数据通道未接通，无法读取引用原文。' })
      return
    }
    let cancelled = false
    const controller = new AbortController()
    // The tab's own signal aborts when the record disappears or the plugin
    // unloads; the local controller covers the effect's own cleanup. Both are
    // honoured because either can happen first.
    const external = props.tab?.signal ?? props.tabInfo?.signal
    const onAbort = (): void => controller.abort()
    external?.addEventListener('abort', onAbort, { once: true })

    setPhase({ kind: 'loading' })
    void (async () => {
      try {
        const range = params.chunkRange ?? null
        const view = await reader.read(ref.collectionId, ref.docId, ref.line, range, controller.signal)
        if (cancelled) return
        setPhase(view === null ? { kind: 'missing' } : { kind: 'loaded', view })
      } catch (cause) {
        if (cancelled) return
        // A cancellation is not a failure to report: the reader left the tab.
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setPhase({ kind: 'failed', message: String(cause instanceof Error ? cause.message : cause) })
      }
    })()

    return () => {
      cancelled = true
      external?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }, [reader, ref?.collectionId, ref?.docId, ref?.line, params.chunkRange?.start, params.chunkRange?.end])

  if (ref === null) {
    return (
      <div className={`kb-root ${styles.body}`}>
        <p className={styles.notice}>这个标签页没有指向任何引用，可能来自旧版本的地址。</p>
      </div>
    )
  }

  return (
    <div className={`kb-root ${styles.body}`}>
      <header className={styles.header}>
        <h2 className={styles.docName} title={params.docName ?? ref.docId}>
          {params.docName ?? ref.docId}
        </h2>
        <p className={`kb-mono ${styles.position}`}>
          {phase.kind === 'loaded' ? positionLabel(phase.view) : `第 ${ref.line} 行`}
        </p>
        {(params.band !== undefined || params.score !== undefined) && (
          <p className={styles.badges}>
            {params.band !== undefined && (
              <span className={styles.band} data-band={params.band}>{params.band}</span>
            )}
            {params.score !== undefined && (
              <span className={`kb-mono ${styles.score}`}>{params.score.toFixed(2)}</span>
            )}
          </p>
        )}
      </header>

      {phase.kind === 'loading' && (
        <p className={styles.notice} role="status">正在读取引用原文…</p>
      )}

      {phase.kind === 'missing' && (
        // A removed document is a fact, not a fault: the collection can be
        // rebuilt between the answer and the click, and telling the reader that
        // is more useful than an error they cannot act on.
        <p className={styles.notice}>
          该来源文档已不在知识库中（可能已被删除或重建）。引用本身仍可在上文的归档路径中找到。
        </p>
      )}

      {phase.kind === 'failed' && (
        <p className={styles.error} role="alert">{phase.message}</p>
      )}

      {phase.kind === 'loaded' && (
        <>
          {phase.view.windowStart > 1 && (
            <p className={styles.truncation}>… 上方还有 {phase.view.windowStart - 1} 行未显示</p>
          )}
          <ol className={styles.lines} start={phase.view.windowStart}>
            {phase.view.lines.map(line => (
              <li
                key={line.number}
                className={styles.line}
                data-cited={line.isCitedLine ? 'true' : undefined}
                data-in-chunk={line.inChunk ? 'true' : undefined}
              >
                <span className={`kb-mono ${styles.lineNo}`} aria-hidden="true">{line.number}</span>
                <span className={styles.lineText}>{line.text === '' ? '\u00a0' : line.text}</span>
              </li>
            ))}
          </ol>
          {phase.view.windowStart + phase.view.lines.length - 1 < phase.view.totalLines && (
            <p className={styles.truncation}>
              … 下方还有 {phase.view.totalLines - (phase.view.windowStart + phase.view.lines.length - 1)} 行未显示
            </p>
          )}

          <footer className={styles.provenance}>
            {params.query !== undefined && (
              <p className={styles.provenanceRow}>
                <span className={styles.provenanceLabel}>命中查询</span>
                <span className={`kb-mono ${styles.provenanceValue}`}>{params.query}</span>
              </p>
            )}
            <p className={styles.provenanceRow}>
              <span className={styles.provenanceLabel}>归档路径</span>
              <span className={`kb-mono ${styles.provenanceValue}`}>{phase.view.sourcePath}</span>
            </p>
            {phase.view.chunkCharStart >= 0 && (
              <p className={styles.provenanceRow}>
                <span className={styles.provenanceLabel}>命中片段</span>
                <span className={`kb-mono ${styles.provenanceValue}`}>
                  字符 {phase.view.chunkCharStart}-{phase.view.chunkCharEnd}
                </span>
              </p>
            )}
          </footer>
        </>
      )}
    </div>
  )
}

/** Exported for the acceptance suite. */
export { citationAddress, positionLabel }
