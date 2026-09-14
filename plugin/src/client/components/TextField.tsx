/**
 * TextField — design spec §4.2.
 *
 * One component covers the text input, the search input and the textarea,
 * because the spec defines them as one family: same border, radius, padding and
 * focus treatment, differing only in adornment and whether height is fixed.
 *
 * The validation contract is the part worth stating: an invalid field always
 * renders its reason, because the spec forbids a bare "输入有误" message — a
 * caller that passes `invalid` without `error` gets the danger border and a
 * development-mode warning rather than a field the user cannot diagnose.
 */

import { useId } from 'react'
import { Icon } from './Icon.tsx'
import { Spinner } from './Spinner.tsx'
import styles from './TextField.module.css'

/** Which control to render; each maps to one spec variant. */
export type TextFieldVariant = 'text' | 'search' | 'textarea'

/** Options accepted by {@link TextField}. */
export interface TextFieldProps {
  /** Accessible label, rendered above the control. */
  label: string
  /** Current value. */
  value: string
  /** Called with the next value on every edit. */
  onChange: (value: string) => void
  /** Control variant. Defaults to a single-line text input. */
  variant?: TextFieldVariant
  /** Supporting text below the control, for format or scope hints. */
  hint?: string
  /** Validation reason. Required when {@link invalid} is set. */
  error?: string
  /** Marks the field invalid: danger border plus the reason. */
  invalid?: boolean
  /** Busy state: keeps the box size and shows a trailing indicator. */
  loading?: boolean
  /** Disables interaction and applies the reduced-contrast treatment. */
  disabled?: boolean
  /** Placeholder text. Never a substitute for {@link label}. */
  placeholder?: string
  /** Rows for the textarea variant. */
  rows?: number
}

/**
 * Render a labelled field.
 * @param props - variant, value, validation and state flags.
 * @returns the field element.
 */
export function TextField({
  label, value, onChange, variant = 'text', hint, error, invalid = false,
  loading = false, disabled = false, placeholder, rows = 3,
}: TextFieldProps): React.JSX.Element {
  const id = useId()
  const describedBy = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined

  if (invalid && error === undefined && process.env.NODE_ENV !== 'production') {
    console.warn(
      `TextField(${label}): marked invalid without an "error" reason. The design spec §4.2 requires the message `
      + 'to state why, so the user can act on it.',
    )
  }

  const className = [styles.field, invalid ? styles.invalid : '', loading ? styles.loading : '']
    .filter(Boolean)
    .join(' ')

  const shared = {
    id,
    value,
    disabled: disabled || loading,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    'aria-busy': loading || undefined,
  }

  return (
    <div className={className}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.wrapper}>
        {variant === 'search' && <span className={styles.searchIcon}><Icon name="search" /></span>}
        {variant === 'textarea'
          ? (
              <textarea
                {...shared}
                rows={rows}
                placeholder={placeholder}
                className={`${styles.control} ${styles.textarea}`}
                onChange={event => { onChange(event.target.value) }}
              />
            )
          : (
              <input
                {...shared}
                type={variant === 'search' ? 'search' : 'text'}
                placeholder={placeholder}
                className={`${styles.control} ${variant === 'search' ? styles.search : ''}`}
                onChange={event => { onChange(event.target.value) }}
              />
            )}
        {loading && <span className={styles.trailing}><Spinner size="sm" /></span>}
      </div>
      {error !== undefined && <span className={styles.error} id={`${id}-error`} role="alert">{error}</span>}
      {error === undefined && hint !== undefined && <span className={styles.hint} id={`${id}-hint`}>{hint}</span>}
    </div>
  )
}
