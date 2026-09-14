/**
 * CollectionCard — the knowledge-base card (design spec §5.1).
 *
 * The card's job is to answer "what is this collection and what state is it in"
 * without a click, and the spec encodes that in a fixed anatomy: header (icon,
 * name, technical identifier, status pill pinned top-right), a scale row of
 * monospaced figures, an internal divider, and a footer whose actions are hidden
 * until the card is hovered or focused.
 *
 * Two rules are structural rather than cosmetic:
 *
 * - **Name and technical identifier coexist.** The name serves a human, the
 *   identifier (`kb_prod_2f8a · HNSW`) serves log correlation. Dropping either
 *   makes one of the two jobs impossible, so both are required props.
 * - **Actions are hidden, not removed.** They stay in the tab order and reappear
 *   on focus, so a keyboard user is not locked out of a card's operations by a
 *   hover-only affordance.
 *
 * @module dsh-zvec-knowledge/client/components/CollectionCard
 */

import { Icon, type IconName } from './Icon.tsx'
import { StatusPill, type StatusKind } from './StatusPill.tsx'
import styles from './CollectionCard.module.css'

/** Figures shown on the card's scale row. */
export interface CollectionCardStats {
  /** Documents in the collection. */
  documents: number
  /** Chunks across every document. */
  chunks: number
  /** Retrieval calls that produced hits in the last seven days. */
  hits7d: number
}

/** Options accepted by {@link CollectionCard}. */
export interface CollectionCardProps {
  /** Human-facing name. */
  name: string
  /** Technical identifier, e.g. `kb_prod_2f8a`. */
  collectionId: string
  /** Index family shown alongside the identifier, e.g. `HNSW`. */
  indexKind: string
  /** Lifecycle state. */
  status: StatusKind
  /** Visible wording for the status. */
  statusLabel: string
  /** Scale figures. */
  stats: CollectionCardStats
  /** Last modification time, preformatted for display. */
  updatedAt: string
  /** Called when the card itself is activated. */
  onOpen?: () => void
  /** Called when the delete action is chosen. Omit to hide the action. */
  onDelete?: () => void
  /** Whether this card is the one selected in the grid. */
  selected?: boolean
}

/**
 * Format a count for the scale row.
 * @param value - raw count.
 * @returns a compact string; large values are abbreviated so the row cannot wrap.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}

/**
 * Render a knowledge-base card.
 * @param props - identity, state, figures and actions.
 * @returns the card.
 */
export function CollectionCard({
  name, collectionId, indexKind, status, statusLabel, stats, updatedAt,
  onOpen, onDelete, selected = false,
}: CollectionCardProps): React.JSX.Element {
  return (
    <article className={`${styles.card} ${selected ? styles.selected : ''}`.trim()}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name="collection" size={18} />
        </span>
        <div className={styles.identity}>
          <h3 className={styles.name}>
            <button type="button" className={styles.nameButton} onClick={onOpen}>{name}</button>
          </h3>
          <p className={`kb-mono ${styles.techId}`}>
            {collectionId} · {indexKind}
          </p>
        </div>
        <div className={styles.status}>
          <StatusPill status={status} label={statusLabel} />
        </div>
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>文档</dt>
          <dd className={`kb-mono ${styles.statValue}`}>{formatCount(stats.documents)}</dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>分片</dt>
          <dd className={`kb-mono ${styles.statValue}`}>{formatCount(stats.chunks)}</dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>近七日命中</dt>
          <dd className={`kb-mono ${styles.statValue}`}>{formatCount(stats.hits7d)}</dd>
        </div>
      </dl>

      <div className={styles.footer}>
        <span className={styles.updated}>
          <Icon name="clock" size={14} />
          <span className={`kb-mono ${styles.updatedText}`}>{updatedAt}</span>
        </span>
        <span className={styles.actions}>
          {onDelete !== undefined && (
            <button type="button" className={styles.action} onClick={onDelete} aria-label={`删除 ${name}`}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </span>
      </div>
    </article>
  )
}
