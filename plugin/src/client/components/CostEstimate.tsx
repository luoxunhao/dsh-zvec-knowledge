/**
 * CostEstimate — the pre-submit cost line (design spec §5.6).
 *
 * The spec's requirement is ordinal as much as visual: 代价预估 must appear
 * **before** the submit button ("必须出现在提交按钮之前"). That ordering is why
 * this is a component the page places explicitly rather than a decoration hung
 * off the button — a configurator that reveals the cost only after you press
 * "保存并重建索引" has not given you the chance to decide.
 *
 * The build-time figure is presented with its basis, because an unexplained
 * duration invites more trust than it deserves.
 *
 * @module dsh-zvec-knowledge/client/components/CostEstimate
 */

import { Icon } from './Icon.tsx'
import styles from './CostEstimate.module.css'

/** Options accepted by {@link CostEstimate}. */
export interface CostEstimateProps {
  /** Total chunks that will be written. */
  chunks: number
  /** Vector storage before quantization, in bytes. */
  rawVectorBytes: number
  /** Vector storage after quantization, in bytes. */
  vectorBytes: number
  /** Compression ratio applied. */
  compression: number
  /** Estimated build duration in seconds. */
  estimatedSeconds: number
  /** How the duration was derived. */
  basis: string
}

/**
 * Format a byte count.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Format a duration.
 * @param seconds - duration in seconds.
 * @returns a short human-readable duration.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不足 1 秒'
  if (seconds < 60) return `约 ${Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${rest} 秒`
}

/**
 * Render the cost estimate.
 * @param props - chunk count, storage figures and duration.
 * @returns the estimate block.
 */
export function CostEstimate({
  chunks, rawVectorBytes, vectorBytes, compression, estimatedSeconds, basis,
}: CostEstimateProps): React.JSX.Element {
  const saved = rawVectorBytes - vectorBytes
  return (
    <section className={styles.panel} aria-label="代价预估">
      <header className={styles.head}>
        <h4 className={styles.title}>代价预估</h4>
        {compression > 1 && (
          <span className={styles.badge}>量化压缩 {compression}×</span>
        )}
      </header>

      <dl className={styles.grid}>
        <div className={styles.item}>
          <dt className={styles.label}>分片总数</dt>
          <dd className={`kb-mono ${styles.value}`}>{chunks}</dd>
        </div>
        <div className={styles.item}>
          <dt className={styles.label}>向量存储</dt>
          <dd className={`kb-mono ${styles.value}`}>{formatBytes(vectorBytes)}</dd>
          {saved > 0 && (
            // The saving is stated explicitly, so the quantizer's trade-off is
            // visible at the point of decision rather than only in its copy.
            <span className={`kb-mono ${styles.detail}`}>量化后节省 {formatBytes(saved)}</span>
          )}
        </div>
        <div className={styles.item}>
          <dt className={styles.label}>预计构建耗时</dt>
          <dd className={`kb-mono ${styles.value}`}>{formatDuration(estimatedSeconds)}</dd>
          <span className={styles.detail}>{basis}</span>
        </div>
      </dl>

      {chunks === 0 && (
        <p className={styles.warning} role="status">
          <Icon name="alert" size={14} /> 当前参数不会产生任何分片，提交后将得到空索引。
        </p>
      )}
    </section>
  )
}
