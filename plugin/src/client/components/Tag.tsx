/**
 * Tag — design spec §4.4.
 *
 * Removal goes through the shared {@link IconButton}, never through a clickable
 * tag: the spec requires icon-only controls to carry a tooltip and an accessible
 * name (§4.6), and a clickable tag has nowhere to put either. The tag passes only
 * the label; the button owns the affordance.
 */

import { IconButton } from './IconButton.tsx'
import styles from './Tag.module.css'

/** Which palette a tag draws from. */
export type TagTone = 'neutral' | 'brand'

/** Options accepted by {@link Tag}. */
export interface TagProps {
  /** Visible text. */
  children: string
  /** Palette. Defaults to the neutral fill. */
  tone?: TagTone
  /** Called when the tag is removed. Omit for a fixed tag. */
  onRemove?: () => void
  /** Accessible name of the remove control; required when {@link onRemove} is set. */
  removeLabel?: string
}

/**
 * Render a classification label.
 * @param props - text, tone and optional removal.
 * @returns the tag element.
 */
export function Tag({ children, tone = 'neutral', onRemove, removeLabel }: TagProps): React.JSX.Element {
  const removable = onRemove !== undefined
  if (removable && removeLabel === undefined && process.env.NODE_ENV !== 'production') {
    console.warn(`Tag(${children}): removable without removeLabel. The design spec §4.6 requires icon-only controls to carry an accessible name.`)
  }

  return (
    <span className={`${styles.tag} ${styles[tone]} ${removable ? styles.removable : ''}`.trim()}>
      {children}
      {removable && (
        <IconButton
          icon="close"
          size="compact"
          label={removeLabel ?? `移除 ${children}`}
          onClick={onRemove}
        />
      )}
    </span>
  )
}
