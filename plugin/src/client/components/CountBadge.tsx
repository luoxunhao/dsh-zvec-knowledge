/**
 * CountBadge — design spec §4.4.
 *
 * The two-digit cap is the spec's rule ("数值超过两位时显示 99+"), and it is
 * applied in the component rather than left to callers, because the point is that
 * a badge must never break the layout it annotates — a guarantee no caller can
 * maintain by remembering to format before passing a number.
 */

import styles from './CountBadge.module.css'

/** Options accepted by {@link CountBadge}. */
export interface CountBadgeProps {
  /** Count to display. Negative and non-integer values are not meaningful and render as `0`. */
  value: number
  /** Accent treatment, for the one count that motivates looking at the list. */
  accent?: boolean
  /** Reduced-contrast treatment for a count that is not currently meaningful. */
  disabled?: boolean
}

/**
 * Render a count marker.
 * @param props - value and variant flags.
 * @returns the badge element.
 */
export function CountBadge({ value, accent = false, disabled = false }: CountBadgeProps): React.JSX.Element {
  const text = !Number.isInteger(value) || value <= 0
    ? '0'
    : value > 99 ? '99+' : String(value)
  return <span className={`${styles.badge} ${accent ? styles.accent : ''} ${disabled ? styles.disabled : ''}`.trim()}>{text}</span>
}
