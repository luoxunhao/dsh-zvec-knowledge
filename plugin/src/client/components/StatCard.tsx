/**
 * StatCard — the overview page's summary tile (design spec §6.2).
 *
 * The spec fixes the figure's typography (h2 level, tabular monospace) because
 * four of these sit in a row and the numbers have to line up across them; a
 * proportional figure would make the row look ragged. The value is therefore
 * rendered inside a `kb-mono` span at h2 size rather than with a bespoke font
 * rule.
 *
 * @module dsh-zvec-knowledge/client/components/StatCard
 */

import { Icon, type IconName } from './Icon.tsx'
import styles from './StatCard.module.css'

/** Options accepted by {@link StatCard}. */
export interface StatCardProps {
  /** Metric label. */
  label: string
  /** Rendered figure, already formatted. */
  value: string
  /** Optional secondary line explaining the figure. */
  detail?: string
  /** Optional leading glyph. */
  icon?: IconName
}

/**
 * Render a statistic tile.
 * @param props - label, figure, optional detail and glyph.
 * @returns the tile.
 */
export function StatCard({ label, value, detail, icon }: StatCardProps): React.JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {icon !== undefined && (
          <span className={styles.icon} aria-hidden="true">
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      {/* The figure is the tile's accessible value; the visible text is what a
          screen reader reads, so no duplicate aria-label is added. */}
      <p className={`kb-mono ${styles.value}`}>{value}</p>
      {detail !== undefined && <p className={styles.detail}>{detail}</p>}
    </div>
  )
}
