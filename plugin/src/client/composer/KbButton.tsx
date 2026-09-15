/**
 * The composer's knowledge-base button.
 *
 * Sits in the `conversation.input.right` slot — the same row of compact controls
 * as the shipped permission selector — and opens the `@` menu filtered to this
 * plugin's source, exactly as the shipped command button opens the `/` menu via
 * `toggleSource`.
 *
 * A button rather than a picker of its own because the menu already exists: the
 * input-trigger pipeline owns candidate fetch, keyboard arbitration and the chip
 * insert, and a second picker would re-implement all of it and drift.
 *
 * @module dsh-zvec-knowledge/client/composer/KbButton
 */

import { Icon } from '../components/Icon.tsx'
import styles from './KbButton.module.css'

/** Options accepted by {@link KbButton}. */
export interface KbButtonProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
  /** Opens the knowledge-base menu at the end of the draft. */
  onOpen: () => void
}

/**
 * Render the knowledge-base control.
 * @param props - the locked state and the open action.
 * @returns the button.
 */
export function KbButton({ locked, onOpen }: KbButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.button}
      disabled={locked}
      aria-label="插入知识库引用"
      title="插入知识库引用（也可以直接输入 @ 检索）"
      onClick={onOpen}
    >
      <Icon name="database" size={16} />
      <span className={styles.label}>知识库</span>
    </button>
  )
}
