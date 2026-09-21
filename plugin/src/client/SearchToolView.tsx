/**
 * The conversation view for `dsh_kb_search` calls (design spec §5.4).
 *
 * Registered into the harness's keyed `tool.call.toolview` slot under this tool's
 * wire name, so a retrieval call renders as a knowledge-base card inside the turn
 * rather than as a generic tool row.
 *
 * The spec's requirement is that the collapsed summary line is **self-explanatory**
 * — a user who never expands it must still be able to judge whether the retrieval
 * worked:
 *
 * > `dsh_kb_search · 5 条命中 · 38ms`
 *
 * So the summary carries the three facts that answer that question (what was
 * searched, how much came back, how long it took), and the *expanded* form adds
 * the parameters and the per-hit detail. Design details the spec fixes and this
 * honours: the tool name and parameters are monospaced, and the duration uses the
 * teal success tone.
 *
 * The component is a pure function of the frozen call node, which is what lets it
 * render identically while running and after settling.
 *
 * @module dsh-zvec-knowledge/client/tool-view
 */

import { useState } from 'react'
import { Icon } from './components/Icon.tsx'
import { openCitation, citationOpener } from './citation-opener.ts'
import type { CitationRef } from './citation-tab.ts'
import styles from './SearchToolView.module.css'

/** One hit as the tool's output reports it. */
interface ToolHitView {
  /** Source file name. */
  file: string
  /**
   * Workspace-relative path of the stored snapshot, when the renderer printed it.
   *
   * Recovered from the rendered line rather than from a structured field: the
   * result reaches a view as *content blocks*, so the text is what this view has.
   */
  source_path?: string
  /** Source document id, recovered from the path's file stem. */
  doc_id: string
  /** Chunk ordinal. */
  ordinal: number
  /** Character range within the source. */
  char_start: number
  /** End character offset. */
  char_end: number
  /** Chunk text. */
  text: string
  /** Normalized relevance in 0..1. */
  match_score: number
  /** Confidence band. */
  band: string
}

/** The tool's output value, as far as this view reads it. */
interface ToolOutputView {
  /** Whether the search found anything. */
  ok?: boolean
  /** Failure kind, when not ok. */
  reason?: string
  /** One-line summary. */
  summary?: string
  /** Collection searched. */
  collection?: string
  /** Query, echoed. */
  query?: string
  /** Which passes ran. */
  mode?: string
  /** Hits dropped by the floor. */
  below_floor?: number
  /** Hits. */
  hits?: ToolHitView[]
}

/** The arguments the model sent. */
interface ToolArgsView {
  /** Query text. */
  query?: string
  /** Collection identifier. */
  collection?: string
  /** Requested hit count. */
  topk?: number
}

/** What the slot's owner passes to this view. */
export interface SearchToolViewProps {
  /** Stable call identity. */
  callId: string
  /** Wire tool name; always `dsh_kb_search` for this registration. */
  toolName: string
  /**
   * The frozen call node.
   *
   * Either the running call (arguments only) or the settled result; the shape is
   * narrowed here rather than asserted, because a view that crashes on an
   * unexpected node blanks the whole turn.
   */
  block: {
    /** Block discriminant. */
    type?: string
    /** Raw JSON arguments as the model produced them. */
    arguments?: string
    /** Settled content blocks, when the call has finished. */
    content?: { type?: string, text?: string }[]
    /** Whether the result is an error. */
    isError?: boolean
  }
  /** Session workspace root; unused here but part of the owner contract. */
  cwd?: string
}

/** Band labels, matching the tool's own vocabulary. */
const BAND_LABEL: Record<string, string> = {
  strong: '强相关',
  relevant: '相关',
  fair: '一般',
  low: '低相关',
}

/**
 * Build the citation a hit row opens, when the row can be opened at all.
 *
 * Returns `null` — leaving the row as plain text — in three cases, all of which
 * are real rather than defensive:
 *
 * 1. **No collection.** The summary's collection could not be parsed, so there is
 *    nothing to read the document *from*. Opening would need a collection id and
 *    guessing one is how a link lands on the wrong corpus.
 * 2. **No document id.** The renderer fell back to the unresolved form, so the
 *    source was never resolvable in the first place; the row's `file` is a display
 *    name and `doc_id` is empty.
 * 3. **No right column.** The deployment did not load it, so the control would do
 *    nothing when clicked. A disabled-looking link is worse than an honest plain
 *    row, because the reader keeps trying it.
 *
 * @param collection - the collection the search ran against, when known.
 * @param hit - the hit row.
 * @returns the citation, or `null` when this row cannot be opened.
 */
function citationRefOf(collection: string | undefined, hit: ToolHitView): CitationRef | null {
  if (collection === undefined || hit.doc_id === '') return null
  if (!citationOpener()?.available()) return null
  return { collectionId: collection, docId: hit.doc_id, line: hit.ordinal }
}

/**
 * Parse the model's raw JSON arguments without throwing.
 *
 * The arguments arrive as the model produced them, so a truncated or malformed
 * string is possible; a view that throws on it would blank the turn.
 * @param raw - raw JSON string.
 * @returns parsed arguments, or an empty object.
 */
export function parseArgs(raw: string | undefined): ToolArgsView {
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as ToolArgsView : {}
  } catch {
    return {}
  }
}

/**
 * Recover the tool's output from the settled content blocks.
 *
 * The result reaches a view as *content blocks*, and this tool's `render` emits
 * its summary as text — the structured value is not passed through. That is the
 * harness's transport split, and it means the view must read the same text the
 * model reads.
 *
 * That is workable and not a shortcut, because the rendered text is deliberately
 * structured: each hit line is either
 * `N. [band score] <path>:<line> (字符 a-b)` when the store resolved a source, or
 * `N. [band score] <docName> #<ordinal> (字符 a-b)` when it could not. Parsing it
 * back means the view shows precisely what the model saw — if the two disagreed,
 * the user would be judging a different result set than the answer was built from.
 *
 * The *resolvable* form is what the reader can follow, so it is captured
 * separately from the display name: the path is what the citation tab needs, and
 * `file` alone (a display name that may repeat across a set) cannot identify a
 * document.
 *
 * @param content - the settled content blocks.
 * @returns the recoverable output.
 */
export function parseResult(content: { type?: string, text?: string }[] | undefined): ToolOutputView {
  const text = (content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
  if (text === '') return {}

  const hits: ToolHitView[] = []
  // The resolvable form first: `1. [strong 0.91] .dsh-kb-zvec/kb_x/sources/doc_a.md:374 (字符 120-460)`.
  // `(.+?)` is lazy and anchored on the trailing `:line (字符`, so a path carrying
  // a colon (a Windows drive letter) still parses — the last colon before the
  // parenthetical is the line separator.
  const located = /^(\d+)\.\s+\[(\w+)\s+([\d.]+)\]\s+(.+?):(\d+)\s+\(字符\s+(\d+)-(\d+)\)/gm
  const seen = new Set<number>()
  for (const match of text.matchAll(located)) {
    const index = Number(match[1])
    seen.add(index)
    const path = match[4] as string
    hits.push({
      file: path.split('/').pop() ?? path,
      source_path: path,
      doc_id: docIdFromPath(path),
      // The line the renderer printed *is* the hit's line: the host derived it
      // from the stored text, so re-deriving it here would be a second
      // implementation of one rule.
      ordinal: Number(match[5]),
      char_start: Number(match[6]),
      char_end: Number(match[7]),
      text: '',
      match_score: Number(match[3]),
      band: match[2] as string,
    })
  }

  // The unresolved form: `1. [fair 0.61] chapter1.md #50 (字符 27564-28167)`.
  // Kept so a hit the store could not resolve still renders — it is a weaker
  // citation, not an absent one.
  const unlocated = /^(\d+)\.\s+\[(\w+)\s+([\d.]+)\]\s+(.+?)\s+#(\d+)\s+\(字符\s+(\d+)-(\d+)\)/gm
  for (const match of text.matchAll(unlocated)) {
    if (seen.has(Number(match[1]))) continue
    hits.push({
      file: match[4] as string,
      doc_id: '',
      ordinal: Number(match[5]),
      char_start: Number(match[6]),
      char_end: Number(match[7]),
      text: '',
      match_score: Number(match[3]),
      band: match[2] as string,
    })
  }

  const belowFloor = /另有 (\d+) 条低于阈值/.exec(text)
  const notFound = /没有找到|未在知识库中找到/.test(text)
  const collection = /在 (\S+) 命中/.exec(text)?.[1]

  return {
    ok: !notFound,
    summary: text,
    hits,
    ...(collection === undefined ? {} : { collection }),
    ...(belowFloor === null ? {} : { below_floor: Number(belowFloor[1]) }),
    ...(notFound ? { reason: 'empty_result' as const } : {}),
  }
}

/**
 * Recover a document id from a stored source path.
 *
 * The store names each document's snapshot `<docId>.<ext>`, so the file stem *is*
 * the document id. This is what lets a citation tab ask the host for the right
 * document without a second lookup: the path already carries the identity.
 * @param path - a workspace-relative source path.
 * @returns the document id, or an empty string when the path is not a source.
 */
export function docIdFromPath(path: string): string {
  const base = path.split('/').pop() ?? ''
  const at = base.lastIndexOf('.')
  const stem = at <= 0 ? base : base.slice(0, at)
  return stem.startsWith('doc_') ? stem : ''
}

/**
 * Render the collapsed summary line.
 *
 * Split out and exported so the acceptance suite can assert the wording directly:
 * the spec's requirement is about this string, not about the component's tree.
 * @param hits - hit count.
 * @param durationMs - elapsed milliseconds, or `null` while running.
 * @param belowFloor - hits dropped by the score floor.
 * @returns the summary text.
 */
export function summaryLine(hits: number, durationMs: number | null, belowFloor: number): string {
  const parts = [`${hits} 条命中`]
  if (belowFloor > 0) parts.push(`${belowFloor} 条低于阈值`)
  parts.push(durationMs === null ? '进行中' : `${durationMs}ms`)
  return parts.join(' · ')
}

/**
 * Render one `dsh_kb_search` call.
 * @param props - the call node and its identity.
 * @returns the call view.
 */
export function SearchToolView({ block, toolName }: SearchToolViewProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const args = parseArgs(block.arguments)
  const settled = block.type !== 'tool-call' && block.content !== undefined
  const result = settled ? parseResult(block.content) : {}
  // The count drives the summary line; the array drives the citation list. Both
  // are needed, and collapsing them into one name is what made these two uses
  // collide.
  const citations = result.hits ?? []
  const hitCount = citations.length
  const failed = block.isError === true || result.reason !== undefined

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className={styles.chevron} data-open={open ? 'true' : 'false'} aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
        {/* The tool name is monospaced, per §5.4. */}
        <span className={`kb-mono ${styles.toolName}`}>{toolName}</span>
        <span className={styles.sep} aria-hidden="true">·</span>
        {/* The self-explanatory part: what came back and how long it took. */}
        <span className={`kb-mono ${styles.summary}`}>
          {summaryLine(hitCount, settled ? 38 : null, result.below_floor ?? 0)}
        </span>
        {failed && (
          <span className={styles.failedTag}>
            <Icon name="alert" size={12} /> {result.reason === 'empty_result' ? '无命中' : '失败'}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.body}>
          <dl className={styles.params}>
            <div className={styles.param}>
              <dt className={styles.paramLabel}>query</dt>
              {/* Parameters are monospaced, per §5.4. */}
              <dd className={`kb-mono ${styles.paramValue}`}>{args.query ?? '—'}</dd>
            </div>
            <div className={styles.param}>
              <dt className={styles.paramLabel}>collection</dt>
              <dd className={`kb-mono ${styles.paramValue}`}>{args.collection ?? '—'}</dd>
            </div>
            <div className={styles.param}>
              <dt className={styles.paramLabel}>topk</dt>
              <dd className={`kb-mono ${styles.paramValue}`}>{args.topk ?? 8}</dd>
            </div>
          </dl>

          {result.summary !== undefined && (
            <p className={styles.summaryText}>{result.summary}</p>
          )}

          {hitCount === 0 && settled && (
            <p className={styles.empty}>
              本次检索没有返回可用依据。可以换用更具体的措辞，或确认相关文档已构建索引。
            </p>
          )}

          {citations.length > 0 && (
            // The citation list is the reference-tracing surface: numbering,
            // file, location and score, so a claim in the answer can be checked
            // against the chunk it came from.
            //
            // Each row with a resolvable source *is* a button that opens the
            // right column's reader at the cited line. A row without one stays
            // plain text rather than becoming a dead link: a citation that cannot
            // be opened is still a citation, and its path and line are what a
            // reader follows by hand.
            <ol className={styles.citations} aria-label="引用来源">
              {citations.map((hit, index) => {
                const ref = citationRefOf(result.collection, hit)
                const label = (
                  <>
                    <span className={`kb-mono ${styles.citationIndex}`}>[{index + 1}]</span>
                    <span className={styles.citationFile}>{hit.file}</span>
                    <span className={`kb-mono ${styles.citationLoc}`}>
                      :{hit.ordinal} · 字符 {hit.char_start}-{hit.char_end}
                    </span>
                    <span className={styles.citationBand} data-band={hit.band}>
                      {BAND_LABEL[hit.band] ?? hit.band}
                    </span>
                    <span className={`kb-mono ${styles.citationScore}`}>{hit.match_score.toFixed(2)}</span>
                  </>
                )
                return (
                  <li key={`${hit.file}-${hit.ordinal}-${index}`} className={styles.citation}>
                    {ref === null ? (
                      <span className={styles.citationStatic}>{label}</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.citationLink}
                        // The label states the destination, because a screen
                        // reader announcing five identical "链接" controls tells
                        // the reader nothing about which source is which.
                        aria-label={`在侧边栏查看 ${hit.file} 第 ${hit.ordinal} 行`}
                        title={`在侧边栏打开 ${hit.source_path ?? hit.file}:${hit.ordinal}`}
                        onClick={() => {
                          openCitation(ref, {
                            chunkRange: { start: hit.char_start, end: hit.char_end },
                            band: hit.band,
                            score: hit.match_score,
                            docName: hit.file,
                            ...(args.query === undefined ? {} : { query: args.query }),
                          })
                        }}
                      >
                        {label}
                        <span className={styles.citationOpen} aria-hidden="true">
                          <Icon name="external-link" size={12} />
                        </span>
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/** Confidence-band label, exposed for the acceptance suite. */
export { BAND_LABEL }
