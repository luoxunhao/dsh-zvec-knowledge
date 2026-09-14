/**
 * EmptyState — the design spec's empty-state pattern (§8.1).
 *
 * The spec's rule for this state is that it must explain *why* it is empty and
 * what to do next, with a primary action available. That is why `title` and
 * `description` are both required and why the action is passed in rather than
 * inferred: a bare "no data" panel is exactly the failure the rule names.
 *
 * @module dsh-zvec-knowledge/client/components/EmptyState
 */

import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'
import styles from './EmptyState.module.css'

/** Options accepted by {@link EmptyState}. */
export interface EmptyStateProps {
  /** What is empty, in the user's terms. */
  title: string
  /** Why it is empty and what to do next. Required by the spec's empty-state rule. */
  description: string
  /** The next step, normally a button. */
  action?: ReactNode
  /** Optional glyph; defaults to the collection glyph. */
  icon?: IconName
}

/**
 * Render an empty-state panel.
 * @param props - title, explanation, optional action and glyph.
 * @returns the panel.
 */
export function EmptyState({ title, description, action, icon = 'collection' }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{description}</p>
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  )
}
