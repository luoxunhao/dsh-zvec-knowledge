/**
 * NumberField — a labelled numeric input for the strategy configurators (§5.5, §5.6).
 *
 * Extracted rather than reusing {@link TextField} because a numeric parameter has
 * requirements a text field cannot express: it must report a *range* in its
 * rejection, clamp to a step, and — the part that matters here — keep a
 * half-typed value from being committed. Typing "10" into a field whose minimum is
 * 16 passes through "1", and a component that validated on every keystroke would
 * flash an error the user is already fixing.
 *
 * So the draft is held locally and only reported upward when it parses and is in
 * range; the invalid state is shown but never propagated.
 *
 * @module dsh-zvec-knowledge/client/components/NumberField
 */

import { useEffect, useId, useState } from 'react'
import styles from './NumberField.module.css'

/** Options accepted by {@link NumberField}. */
export interface NumberFieldProps {
  /** Visible label. */
  label: string
  /** Current committed value. */
  value: number
  /** Called with the next valid value. Never called with an out-of-range draft. */
  onChange: (value: number) => void
  /** Minimum accepted value. */
  min: number
  /** Maximum accepted value. */
  max: number
  /** Stepper increment. */
  step?: number
  /** Supporting text below the control. */
  hint?: string
  /** Disables the control. */
  disabled?: boolean
  /** Busy state: the value is being applied elsewhere. Keeps the box size stable. */
  loading?: boolean
}

/**
 * Render a numeric parameter input.
 * @param props - label, value, bounds and callbacks.
 * @returns the field.
 */
export function NumberField({
  label, value, onChange, min, max, step = 1, hint, disabled = false, loading = false,
}: NumberFieldProps): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)

  // Follow external changes (a reset-to-recommended, or a value clamped by a
  // sibling field) without fighting the user's in-progress edit.
  useEffect(() => { setDraft(String(value)) }, [value])

  /** Validate and commit a draft. */
  const commit = (next: string): void => {
    setDraft(next)
    if (next.trim() === '') {
      // An empty box is an in-progress edit, not an error worth shouting about.
      setError(null)
      return
    }
    const parsed = Number(next)
    if (!Number.isFinite(parsed)) {
      setError('请输入数字')
      return
    }
    if (parsed < min || parsed > max) {
      setError(`取值需在 ${min} 到 ${max} 之间，当前为 ${parsed}`)
      return
    }
    setError(null)
    onChange(parsed)
  }

  const invalid = error !== null
  return (
    <div className={`${styles.field} ${loading ? styles.loading : ''}`.trim()}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        className={`${styles.input} ${invalid ? styles.invalid : ''}`.trim()}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={error !== null ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined}
        onChange={event => commit(event.target.value)}
        onBlur={() => {
          // A blurred field with an unusable draft snaps back to the committed
          // value, so the control never sits showing something it did not accept.
          if (error !== null || draft.trim() === '') setDraft(String(value))
        }}
      />
      {error !== null && <span className={styles.error} id={`${id}-error`} role="alert">{error}</span>}
      {error === null && hint !== undefined && <span className={styles.hint} id={`${id}-hint`}>{hint}</span>}
    </div>
  )
}
