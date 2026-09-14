/**
 * DocumentRow — one document in the list, with in-line upload progress (§5.2, §6.3).
 *
 * The spec's rule that shapes this component: **progress is shown in the list row,
 * never in a global overlay.** A modal progress bar blocks the whole page for an
 * operation the user may want to continue working through, and it cannot show two
 * concurrent uploads. So every transfer state a document can be in is expressed
 * inside its own row:
 *
 * | state | what the row shows |
 * |-------|--------------------|
 * | uploading | progress bar + percentage + a cancel action |
 * | cancelled | the transfer stopped, with a retry action |
 * | failed | the reason, with a retry action |
 * | uploaded | 分片数 is the pending marker, not `0` (see `store/documents.ts`) |
 *
 * The progress bar is the shared {@link ProgressBar}, which carries the spec's
 * height, radius, track colour and fill; the row does not restate any of them.
 *
 * @module dsh-zvec-knowledge/client/components/DocumentRow
 */

import { ProgressBar } from './ProgressBar.tsx'
import { Icon } from './Icon.tsx'
import { StatusPill, type StatusKind } from './StatusPill.tsx'
import styles from './DocumentRow.module.css'

/** Transfer state of one file, which is orthogonal to its index status. */
export type TransferState = 'queued' | 'uploading' | 'done' | 'cancelled' | 'failed'

/** One document row as the list renders it. */
export interface DocumentRowData {
  /** Stable id. */
  id: string
  /** File name. */
  name: string
  /** Size in bytes. */
  bytes: number
  /** Lower-case extension, driving the type label. */
  ext: string
  /** Index lifecycle status. */
  status: StatusKind
  /** Visible wording for the index status. */
  statusLabel: string
  /** Chunks indexed, or `null` while the value is genuinely unknown. */
  chunks: number | null
  /** Current transfer state. */
  transfer: TransferState
  /** Upload progress in [0, 1]; meaningful while `transfer` is `uploading`. */
  progress: number
  /** Failure reason, shown in the row when `transfer` or `status` is failed. */
  error?: string
}

/** Options accepted by {@link DocumentRow}. */
export interface DocumentRowProps {
  /** The document. */
  row: DocumentRowData
  /** Cancel an in-flight upload. */
  onCancel?: (id: string) => void
  /** Retry a cancelled or failed upload. */
  onRetry?: (id: string) => void
  /** Remove the document. */
  onRemove?: (id: string) => void
}

/**
 * Format a byte count for the row.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * The chunk-count cell.
 *
 * A pending document shows the em-dash marker rather than `0`: zero chunks is a
 * real (and concerning) outcome, while "not built yet" is not a count at all.
 * @param chunks - chunk count or `null`.
 * @returns the display string.
 */
export function formatChunks(chunks: number | null): string {
  return chunks === null ? '待构建' : String(chunks)
}

/**
 * Render one document row.
 * @param props - the row data and its actions.
 * @returns the row.
 */
export function DocumentRow({ row, onCancel, onRetry, onRemove }: DocumentRowProps): React.JSX.Element {
  const uploading = row.transfer === 'uploading' || row.transfer === 'queued'
  const failed = row.transfer === 'failed' || row.status === 'failed'
  const cancelled = row.transfer === 'cancelled'
  const percent = Math.round(Math.max(0, Math.min(1, row.progress)) * 100)

  return (
    <li className={`${styles.row} ${failed ? styles.rowFailed : ''}`.trim()}>
      <span className={styles.type} aria-hidden="true">
        <Icon name="file" size={18} />
        <span className={`kb-mono ${styles.ext}`}>{row.ext || '—'}</span>
      </span>

      <span className={styles.main}>
        <span className={styles.name} title={row.name}>{row.name}</span>
        {uploading ? (
          // Uploading: the row owns the progress, and there is no overlay.
          <span className={styles.transfer}>
            <span className={styles.bar}>
              <ProgressBar value={row.progress} label={`${row.name} 上传进度`} />
            </span>
            <span className={`kb-mono ${styles.percent}`}>{percent}%</span>
          </span>
        ) : (
          <span className={styles.meta}>
            <span className={`kb-mono ${styles.size}`}>{formatSize(row.bytes)}</span>
            {(cancelled || failed) && row.error !== undefined && (
              // The failure reason is stated in the row, per the negative-validation
              // and failure-state rules; a bare "上传失败" would be unactionable.
              <span className={styles.reason}>
                <Icon name="alert" size={12} /> {row.error}
              </span>
            )}
          </span>
        )}
      </span>

      <span className={`kb-mono ${styles.chunks}`}>{formatChunks(row.chunks)}</span>

      <span className={styles.status}>
        <StatusPill status={row.status} label={row.statusLabel} dense />
      </span>

      <span className={styles.actions}>
        {uploading && onCancel !== undefined && (
          <button
            type="button"
            className={styles.action}
            aria-label={`取消上传 ${row.name}`}
            onClick={() => onCancel(row.id)}
          >
            <Icon name="stop" size={14} />
          </button>
        )}
        {(cancelled || failed) && onRetry !== undefined && (
          <button
            type="button"
            className={styles.action}
            aria-label={`重试上传 ${row.name}`}
            onClick={() => onRetry(row.id)}
          >
            <Icon name="retry" size={14} />
          </button>
        )}
        {!uploading && onRemove !== undefined && (
          <button
            type="button"
            className={styles.action}
            aria-label={`移除 ${row.name}`}
            onClick={() => onRemove(row.id)}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </span>
    </li>
  )
}
