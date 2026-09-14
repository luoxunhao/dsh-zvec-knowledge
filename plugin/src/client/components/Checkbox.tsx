/**
 * Checkbox and Radio — design spec §4.3.
 *
 * Both are exported from one module because they share a control box, a state
 * treatment and a label layout; only the selected mark and the corner radius
 * differ, and splitting them would duplicate the whole state set.
 *
 * `Radio` renders one option of a group. The group itself is the caller's
 * markup (a `role="radiogroup"` with a shared `name`), because only the caller
 * knows the question the options answer.
 */

import { useId } from 'react'
import { Icon } from './Icon.tsx'
import styles from './Checkbox.module.css'

/** Options accepted by {@link Checkbox}. */
export interface CheckboxProps {
  /** Option text. */
  label: string
  /** Current state. */
  checked: boolean
  /** Called with the next state. */
  onChange: (checked: boolean) => void
  /** Busy state: blocks interaction and dims the box. */
  loading?: boolean
  /** Disables interaction and applies the reduced-contrast treatment. */
  disabled?: boolean
  /** Dense layout for use inside table cells. */
  dense?: boolean
}

/** Options accepted by {@link Radio}. */
export interface RadioProps extends Omit<CheckboxProps, 'onChange'> {
  /** Called when this option becomes the selected one. */
  onSelect: () => void
  /** Group name shared by every option answering the same question. */
  name: string
}

/**
 * Render a checkbox.
 * @param props - label, state and flags.
 * @returns the checkbox row.
 */
export function Checkbox({
  label, checked, onChange, loading = false, disabled = false, dense = false,
}: CheckboxProps): React.JSX.Element {
  const id = useId()
  return (
    <div className={`${styles.row} ${dense ? styles.dense : ''} ${loading ? styles.loading : ''}`.trim()}>
      <span className={styles.control}>
        <input
          id={id}
          type="checkbox"
          className={styles.input}
          checked={checked}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          onChange={event => { onChange(event.target.checked) }}
        />
        <span className={styles.box}>{checked && <Icon name="check" size={12} />}</span>
      </span>
      <label className={styles.label} htmlFor={id}>{label}</label>
    </div>
  )
}

/**
 * Render one option of a radio group.
 * @param props - label, selected state, group name and flags.
 * @returns the radio row.
 */
export function Radio({
  label, checked, onSelect, name, loading = false, disabled = false, dense = false,
}: RadioProps): React.JSX.Element {
  const id = useId()
  return (
    <div className={`${styles.row} ${styles.radio} ${dense ? styles.dense : ''} ${loading ? styles.loading : ''}`.trim()}>
      <span className={styles.control}>
        <input
          id={id}
          type="radio"
          name={name}
          className={styles.input}
          checked={checked}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          onChange={onSelect}
        />
        <span className={styles.box}>{checked && <span className={styles.dot} />}</span>
      </span>
      <label className={styles.label} htmlFor={id}>{label}</label>
    </div>
  )
}
