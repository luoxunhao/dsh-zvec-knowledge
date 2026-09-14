/**
 * Button — design spec §4.1.
 *
 * Two usage rules from the spec are enforced here rather than left to review,
 * because both are the kind that a later change silently breaks:
 *
 * - **One primary per view.** The spec allows exactly one `primary` button in a
 *   view. A development-mode guard counts mounted primary buttons and warns
 *   when a second appears; it is an approximation of "per view" (mounting is
 *   the closest observable moment), which is what makes it useful rather than
 *   exact.
 * - **Loading keeps its size.** The busy state swaps the leading indicator and
 *   the label text but never the variant or the size, so a button cannot change
 *   its footprint mid-click.
 *
 * The confirmation requirement for `danger` is not expressed here: it needs the
 * caller's dialog, so a `danger` button without a confirmation is a review
 * matter, not something this component can decide.
 */

import { useEffect } from 'react'
import { Spinner } from './Spinner.tsx'
import { Icon, type IconName } from './Icon.tsx'
import styles from './Button.module.css'

/** Visual weight. `primary` carries the view's single main action. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** Control height token from the design spec's three-step scale. */
export type ButtonSize = 'sm' | 'md' | 'lg'

/** Options accepted by {@link Button}. */
export interface ButtonProps {
  /** Visible label. Required: the spec allows no unlabelled button. */
  children: string
  /** Visual weight. Defaults to `secondary` so a view stays free of primaries until it declares one. */
  variant?: ButtonVariant
  /** Control height. `sm` is for in-table actions, `md` is the form default, `lg` for empty states and submits. */
  size?: ButtonSize
  /** Optional leading glyph, hidden while loading. */
  icon?: IconName
  /**
   * Label shown while {@link loading} is true. The spec requires a
   * present-continuous description rather than a frozen imperative label, so
   * this is explicit instead of derived.
   */
  loadingLabel?: string
  /** Busy state: disables interaction and swaps in the spinner. */
  loading?: boolean
  /** Disables interaction and applies the variant's reduced-contrast treatment. */
  disabled?: boolean
  /** Click handler. Not called while `loading` or `disabled`. */
  onClick?: () => void
  /** Button type; defaults to `button` so a button inside a form does not submit it. */
  type?: 'button' | 'submit'
  /** Extra class names from the calling component's CSS module. */
  className?: string
}

/** Mounted `primary` buttons, for the one-primary-per-view development guard. */
let mountedPrimaries = 0

/**
 * Render a button.
 * @param props - variant, size, label, and interaction state.
 * @returns the button element.
 */
export function Button({
  children, variant = 'secondary', size = 'md', icon, loadingLabel,
  loading = false, disabled = false, onClick, type = 'button', className,
}: ButtonProps): React.JSX.Element {
  const inert = disabled || loading

  useEffect(() => {
    if (variant !== 'primary') return
    mountedPrimaries += 1
    if (mountedPrimaries > 1 && process.env.NODE_ENV !== 'production') {
      console.warn(
        `Button: ${mountedPrimaries} primary buttons are mounted. The design spec allows one primary per view (§4.1); `
        + 'demote the others to secondary or ghost.',
      )
    }
    return () => {
      mountedPrimaries -= 1
    }
  }, [variant])

  const classes = [styles.button, styles[variant], styles[size], loading ? styles.loading : '', className]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      disabled={inert}
      aria-busy={loading || undefined}
      onClick={inert ? undefined : onClick}
    >
      {loading
        ? <Spinner size={size === 'lg' ? 'md' : 'sm'} />
        : icon !== undefined && <span className={styles.icon}><Icon name={icon} /></span>}
      <span className={styles.label}>{loading ? (loadingLabel ?? children) : children}</span>
    </button>
  )
}
