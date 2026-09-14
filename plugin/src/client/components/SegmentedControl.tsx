/**
 * SegmentedControl — design spec §4.3.
 *
 * The spec recommends two to four options; more than four stops being scannable
 * and should become a select, so a longer list is reported in development rather
 * than silently rendered as an unreadable strip.
 *
 * Selection is a native radio group: arrow keys move between segments and the
 * group is announced as one choice, which a row of buttons would not provide.
 */

import { useId } from 'react'
import styles from './SegmentedControl.module.css'

/** One segment. */
export interface SegmentOption<T extends string> {
  /** Value reported on selection. */
  value: T
  /** Visible text. */
  label: string
}

/** Options accepted by {@link SegmentedControl}. */
export interface SegmentedControlProps<T extends string> {
  /** Accessible group name; not rendered. */
  label: string
  /** Currently selected value. */
  value: T
  /** Called with the next selected value. */
  onChange: (value: T) => void
  /** Segments in display order. */
  options: readonly SegmentOption<T>[]
  /** Busy state: freezes the group. */
  loading?: boolean
  /** Disables every segment. */
  disabled?: boolean
}

/**
 * Render an in-view switcher.
 * @param props - group label, selection, options and flags.
 * @returns the segmented control.
 */
export function SegmentedControl<T extends string>({
  label, value, onChange, options, loading = false, disabled = false,
}: SegmentedControlProps<T>): React.JSX.Element {
  const name = useId()

  if (options.length > 4 && process.env.NODE_ENV !== 'production') {
    console.warn(
      `SegmentedControl(${label}): ${options.length} options. The design spec §4.3 recommends 2–4; `
      + 'use a Select beyond that, where the options stay scannable.',
    )
  }

  return (
    <div className={`${styles.group} ${loading ? styles.loading : ''}`.trim()} role="radiogroup" aria-label={label}>
      {options.map(option => (
        <label className={styles.segment} key={option.value}>
          <input
            type="radio"
            name={name}
            className={styles.input}
            value={option.value}
            checked={option.value === value}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            onChange={() => { onChange(option.value) }}
          />
          <span className={styles.text}>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
