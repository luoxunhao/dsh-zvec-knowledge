/**
 * SearchField — the design spec's search input (§4.2).
 *
 * A separate component from `TextField` rather than a `variant` of it, because
 * the two differ in structure and not only in styling: a search field carries a
 * leading glyph and a clear affordance, and both have to be positioned inside the
 * control. Folding that into `TextField` would put conditional children into a
 * component whose whole value is that it is boring.
 *
 * The clear button is a real `<button>` with an accessible name, not a click
 * handler on the glyph, so it is reachable by keyboard — the spec's rule that an
 * icon-only affordance must never be mouse-only.
 *
 * @module dsh-zvec-knowledge/client/components/SearchField
 */

import { useId } from 'react'
import { Icon } from './Icon.tsx'
import { Spinner } from './Spinner.tsx'
import styles from './SearchField.module.css'

/** Options accepted by {@link SearchField}. */
export interface SearchFieldProps {
  /** Current query text. */
  value: string
  /** Called as the query changes. */
  onValueChange: (value: string) => void
  /** Accessible name. Required: a search box with no name is unusable by voice. */
  label: string
  /** Placeholder text describing what can be searched. */
  placeholder?: string
  /** Disables the control. */
  disabled?: boolean
  /** Busy state: a search is being executed. Keeps the box size stable. */
  loading?: boolean
  /** Called when Enter is pressed, for owners that search on submit. */
  onSubmit?: () => void
}

/**
 * Render a search input.
 * @param props - value, change handler, label and state flags.
 * @returns the search field.
 */
export function SearchField({
  value, onValueChange, label, placeholder, disabled = false, loading = false, onSubmit,
}: SearchFieldProps): React.JSX.Element {
  const id = useId()
  const inert = disabled || loading
  const className = [styles.field, disabled ? styles.disabled : '', loading ? styles.loading : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={className}>
      <label className="kb-sr-only" htmlFor={id}>{label}</label>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="search" size={16} />
      </span>
      <input
        id={id}
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        disabled={inert}
        aria-busy={loading || undefined}
        onChange={event => onValueChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onSubmit?.()
        }}
      />
      {loading && <span className={styles.spinner}><Spinner size="sm" /></span>}
      {value !== '' && !inert && (
        <button
          type="button"
          className={styles.clear}
          aria-label="清空搜索"
          onClick={() => onValueChange('')}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  )
}
