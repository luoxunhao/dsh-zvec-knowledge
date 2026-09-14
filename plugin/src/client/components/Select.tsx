/**
 * Select — design spec §4.3.
 *
 * Built on the native `<select>` so keyboard interaction, type-ahead and
 * platform behaviour come for free; only the chevron and the box are drawn by
 * the plugin. A custom listbox would have to reimplement all of that, and the
 * spec asks for appearance, not for a new control model.
 *
 * The long-value rule from the spec is honoured through the native `title`
 * attribute rather than a bespoke tooltip, because the truncation happens in CSS
 * and only the browser knows the untruncated string.
 */

import { useId } from 'react'
import { Icon } from './Icon.tsx'
import { Spinner } from './Spinner.tsx'
import styles from './Select.module.css'

/** One selectable entry. */
export interface SelectOption {
  /** Value submitted with the form. */
  value: string
  /** Text shown in the closed control and the list. */
  label: string
}

/** Options accepted by {@link Select}. */
export interface SelectProps {
  /** Accessible label, rendered above the control. */
  label: string
  /** Current value. */
  value: string
  /** Called with the next value. */
  onChange: (value: string) => void
  /** Selectable entries, in display order. */
  options: readonly SelectOption[]
  /** Busy state: keeps the box size and shows a trailing indicator. */
  loading?: boolean
  /** Disables interaction and applies the reduced-contrast treatment. */
  disabled?: boolean
  /**
   * Supporting text below the control.
   *
   * Used by the strategy configurator to state an option's trade-off (the spec
   * requires the quantizer copy to name both the compression ratio and the recall
   * loss), which is why it sits outside the `<option>` — a native option cannot
   * carry formatted help text.
   */
  hint?: string
}

/**
 * Render a single-value chooser.
 * @param props - label, value, options and state flags.
 * @returns the select element.
 */
export function Select({
  label, value, onChange, options, loading = false, disabled = false, hint,
}: SelectProps): React.JSX.Element {
  const id = useId()
  const selected = options.find(option => option.value === value)

  return (
    <div className={`${styles.field} ${loading ? styles.loading : ''}`.trim()}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.wrapper}>
        <select
          id={id}
          className={styles.control}
          value={value}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          title={selected?.label}
          onChange={event => { onChange(event.target.value) }}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {loading
          ? <span className={styles.trailing}><Spinner size="sm" /></span>
          : <span className={styles.chevron}><Icon name="chevron-down" /></span>}
      </div>
      {hint !== undefined && <span className={styles.hint}>{hint}</span>}
    </div>
  )
}
