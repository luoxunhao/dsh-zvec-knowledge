/**
 * ProgressBar — the design spec's occupancy and build progress bar (§4.7).
 *
 * `value` is a fraction in [0, 1] rather than a percentage, and the component
 * clamps it. The spec is explicit that a bar must never be the only signal (a
 * nameless bar is called out as a violation), so the visible label is a required
 * prop rather than an optional adornment.
 *
 * @module dsh-zvec-knowledge/client/components/ProgressBar
 */

import styles from './ProgressBar.module.css'

/** Options accepted by {@link ProgressBar}. */
export interface ProgressBarProps {
  /** Completion in [0, 1]; values outside the range are clamped. */
  value: number
  /** Accessible name describing what is progressing. Required. */
  label: string
  /** Tone of the fill. `brand` for work in progress, semantic tones for outcomes. */
  tone?: 'brand' | 'success' | 'warning' | 'danger'
}

/**
 * Render a progress bar.
 * @param props - fraction, accessible name and tone.
 * @returns the bar.
 */
export function ProgressBar({ value, label, tone = 'brand' }: ProgressBarProps): React.JSX.Element {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className={`${styles.fill} ${styles[tone]}`} style={{ width: `${clamped * 100}%` }} />
    </div>
  )
}
