/**
 * StorageUsageCard — the sidebar's storage occupancy card (design spec §6.1).
 *
 * The acceptance criterion for this card is that its numbers come from real
 * persisted usage rather than a hardcoded constant, so the component takes
 * measured bytes and a configured quota as props and renders `null` while the
 * measurement is still in flight. Rendering `0 MB` during loading would be
 * indistinguishable from a genuinely empty store, which is the failure this
 * avoids.
 *
 * The quota is passed in rather than assumed: the design spec gives no quota
 * figure, so inventing a default here would put a made-up number in the UI.
 *
 * @module dsh-zvec-knowledge/client/components/StorageUsageCard
 */

import { ProgressBar } from './ProgressBar.tsx'
import styles from './StorageUsageCard.module.css'

/** Measured storage figures for one workspace. */
export interface StorageUsage {
  /** Bytes occupied by every collection under the store root. */
  bytes: number
  /** Configured quota in bytes, or `null` when no quota is configured. */
  quotaBytes: number | null
}

/** Options accepted by {@link StorageUsageCard}. */
export interface StorageUsageCardProps {
  /** Measured usage, or `null` while it is loading. */
  usage: StorageUsage | null
}

/**
 * Format a byte count for display.
 *
 * Binary units (KiB steps) are used because the figure describes files on disk,
 * and the label says `MB` rather than `MiB` because the design spec's copy does.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // One decimal below 10 so small stores do not collapse to "0 MB", none above
  // so the number does not jitter as it grows.
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Render the storage card.
 * @param props - measured usage.
 * @returns the card, or a loading placeholder while usage is unknown.
 */
export function StorageUsageCard({ usage }: StorageUsageCardProps): React.JSX.Element {
  if (usage === null) {
    return (
      <div className={styles.card} aria-busy="true">
        <div className={styles.head}>
          <span className={styles.title}>存储用量</span>
        </div>
        <p className={styles.loading}>正在统计…</p>
      </div>
    )
  }

  const quota = usage.quotaBytes
  const fraction = quota !== null && quota > 0 ? usage.bytes / quota : null
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>存储用量</span>
        {fraction !== null && fraction >= 0.9 && (
          <span className={styles.warn}>接近上限</span>
        )}
      </div>
      <div className={styles.bar}>
        <ProgressBar
          value={fraction ?? 0}
          label={quota === null ? '已用存储' : '存储配额占用'}
          tone={fraction !== null && fraction >= 0.9 ? 'warning' : 'brand'}
        />
      </div>
      <p className={`kb-mono ${styles.figures}`}>
        {formatBytes(usage.bytes)}
        <span className={styles.sep}> / </span>
        {quota === null ? '未设配额' : formatBytes(quota)}
      </p>
    </div>
  )
}
