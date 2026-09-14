/**
 * ChunkPreview — the pre-submit quality check (design spec §5.5).
 *
 * The spec is emphatic about this component: "预览是提交前唯一的质量校验手段，
 * 不允许省略" — the only quality check before submitting, not to be omitted. So it
 * renders nothing but real chunker output (supplied by the host, produced by the
 * same chunker the build uses) and always shows the summary, because a preview
 * without totals cannot be used to judge whether the parameters are right.
 *
 * The summary is the part that makes the parameters legible: total chunks, mean
 * tokens per chunk and discarded fragments together say whether the chunk size is
 * too small (many tiny chunks), too large (few chunks, low mean) or whether the
 * minimum is discarding real content.
 *
 * @module dsh-zvec-knowledge/client/components/ChunkPreview
 */

import { Icon } from './Icon.tsx'
import styles from './ChunkPreview.module.css'

/** One preview row, mirroring the host's shape. */
export interface PreviewRowData {
  /** Ordinal within the document. */
  ordinal: number
  /** Estimated tokens. */
  tokens: number
  /** Overlap tokens shared with the previous chunk. */
  overlapTokens: number
  /** Leading text. */
  snippet: string
  /** Character range in the source. */
  charStart: number
  /** End character offset. */
  charEnd: number
}

/** Options accepted by {@link ChunkPreview}. */
export interface ChunkPreviewProps {
  /** Leading chunks to show. */
  rows: PreviewRowData[]
  /** Total retained chunks. */
  totalChunks: number
  /** Mean tokens per chunk. */
  averageTokens: number
  /** Discarded fragments. */
  discarded: number
  /** Total tokens across retained chunks. */
  totalTokens: number
  /** Whether the preview is being recomputed. */
  loading?: boolean
  /** Reason the preview is unavailable, e.g. an invalid configuration. */
  error?: string | null
}

/**
 * Render the chunk preview.
 * @param props - preview rows and the summary.
 * @returns the preview panel.
 */
export function ChunkPreview({
  rows, totalChunks, averageTokens, discarded, totalTokens, loading = false, error = null,
}: ChunkPreviewProps): React.JSX.Element {
  return (
    <section className={styles.panel} aria-label="分片预览">
      <header className={styles.head}>
        <h4 className={styles.title}>分片预览</h4>
        <span className={styles.note}>提交前唯一的质量校验手段</span>
      </header>

      {error !== null ? (
        <p className={styles.error} role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      ) : loading ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="正在计算分片预览" />
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          当前参数下没有可索引的内容。请检查文档是否为空，或最小分片是否过高。
        </p>
      ) : (
        <>
          <ul className={styles.rows}>
            {rows.map(row => (
              <li key={`${row.ordinal}-${row.charStart}`} className={styles.row}>
                <span className={`kb-mono ${styles.ordinal}`}>#{row.ordinal}</span>
                <span className={`kb-mono ${styles.tokens}`}>{row.tokens} tok</span>
                <span className={`kb-mono ${styles.overlap}`}>
                  {row.overlapTokens > 0 ? `重叠 ${row.overlapTokens}` : '无重叠'}
                </span>
                <span className={`kb-mono ${styles.range}`}>{row.charStart}–{row.charEnd}</span>
                <span className={styles.snippet} title={row.snippet}>{row.snippet}</span>
              </li>
            ))}
          </ul>

          {/* The summary always renders with the rows: a preview without totals
              cannot answer "are these parameters right?", which is its purpose. */}
          <dl className={styles.summary}>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>总片数</dt>
              <dd className={`kb-mono ${styles.summaryValue}`}>{totalChunks}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>平均 token</dt>
              <dd className={`kb-mono ${styles.summaryValue}`}>{averageTokens}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>丢弃碎片</dt>
              <dd className={`kb-mono ${styles.summaryValue}`}>{discarded}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>总 token</dt>
              <dd className={`kb-mono ${styles.summaryValue}`}>{totalTokens}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  )
}
