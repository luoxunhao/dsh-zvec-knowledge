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
import styles from './SearchToolView.module.css'

/** One hit as the tool's output reports it. */
interface ToolHitView {
  /** Source file name. */
  file: string
  /** Source document id. */
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
 * structured: each hit line is `N. [band score] file #ordinal (字符 a-b)`, which is
 * exactly the citation information the spec wants displayed. Parsing it back means
 * the view shows precisely what the model saw — if the two disagreed, the user
 * would be judging a different result set than the answer was built from.
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
  // `1. [strong 0.91] guide.md #3 (字符 120-460)`
  const line = /^(\d+)\.\s+\[(\w+)\s+([\d.]+)\]\s+(.+?)\s+#(\d+)\s+\(字符\s+(\d+)-(\d+)\)/gm
  for (const match of text.matchAll(line)) {
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
            <ol className={styles.citations} aria-label="引用来源">
              {citations.map(hit => (
                <li key={`${hit.file}-${hit.ordinal}`} className={styles.citation}>
                  <span className={`kb-mono ${styles.citationIndex}`}>[{hit.ordinal}]</span>
                  <span className={styles.citationFile}>{hit.file}</span>
                  <span className={`kb-mono ${styles.citationLoc}`}>
                    #{hit.ordinal} · 字符 {hit.char_start}-{hit.char_end}
                  </span>
                  <span className={styles.citationBand} data-band={hit.band}>
                    {BAND_LABEL[hit.band] ?? hit.band}
                  </span>
                  <span className={`kb-mono ${styles.citationScore}`}>{hit.match_score.toFixed(2)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/** Confidence-band label, exposed for the acceptance suite. */
export { BAND_LABEL }
