/**
 * Switch — design spec §4.3.
 *
 * The spec requires every switch row to carry an explanation, so `description`
 * is modelled as required rather than optional and a missing one is reported in
 * development. A switch whose meaning is only clear from context is the failure
 * mode that rule exists to prevent.
 */

import { useId } from 'react'
import styles from './Switch.module.css'

/** Options accepted by {@link Switch}. */
export interface SwitchProps {
  /** Row title, always visible. */
  label: string
  /** What turning this on changes. Required by the design spec. */
  description: string
  /** Current state. */
  checked: boolean
  /** Called with the next state. */
  onChange: (checked: boolean) => void
  /** Busy state: holds the appearance and blocks interaction. */
  loading?: boolean
  /** Disables interaction and applies the reduced-contrast treatment. */
  disabled?: boolean
}

/**
 * Render a boolean control with its own explanation.
 * @param props - label, description, state and flags.
 * @returns the switch row.
 */
export function Switch({
  label, description, checked, onChange, loading = false, disabled = false,
}: SwitchProps): React.JSX.Element {
  const id = useId()
  const inert = disabled || loading

  if (description.trim() === '' && process.env.NODE_ENV !== 'production') {
    console.warn(`Switch(${label}): empty description. The design spec §4.3 requires switch rows to explain themselves.`)
  }

  return (
    <div className={`${styles.row} ${loading ? styles.loading : ''}`.trim()}>
      <span className={styles.control}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={checked}
          disabled={inert}
          aria-busy={loading || undefined}
          aria-describedby={`${id}-description`}
          onChange={event => { onChange(event.target.checked) }}
        />
        <span className={styles.track} />
        <span className={styles.knob} />
      </span>
      <span className={styles.text}>
        <label className={styles.title} htmlFor={id}>{label}</label>
        <span className={`${styles.description} ${description.trim() === '' ? styles.missingDescription : ''}`.trim()} id={`${id}-description`}>
          {description.trim() === '' ? '缺少说明（规范 4.3 要求开关行必须附文字说明）' : description}
        </span>
      </span>
    </div>
  )
}
