/**
 * StatusPill — design spec §4.5.
 *
 * The component maps a lifecycle state to its four token values (fill, border,
 * text, dot) so no caller ever assembles a status marker by hand. That is what
 * keeps the three-piece rule true: a caller chooses `status="ready"`, not three
 * colours, and cannot accidentally produce a marker that is only coloured.
 *
 * `labels` is required rather than derived from the status name, because the
 * visible wording is product copy ("就绪" / "构建中") and the status key is a
 * machine value; deriving one from the other would put Chinese UI text in a
 * constant table inside a component.
 */

import styles from './StatusPill.module.css'

/** Lifecycle states the design spec defines markers for. */
export type StatusKind = 'ready' | 'building' | 'failed' | 'pending' | 'info'

/** Options accepted by {@link StatusPill}. */
export interface StatusPillProps {
  /** Which lifecycle state to report. */
  status: StatusKind
  /** Visible wording for this state. */
  label: string
  /** Dense form for table cells: drops the dot, keeps text and border. */
  dense?: boolean
}

/**
 * Render a lifecycle marker.
 * @param props - status, wording and density.
 * @returns the status pill.
 */
export function StatusPill({ status, label, dense = false }: StatusPillProps): React.JSX.Element {
  return (
    <span className={`${styles.pill} ${styles[status]} ${dense ? styles.dense : ''}`.trim()}>
      {!dense && <span className={styles.dot} />}
      {label}
    </span>
  )
}
