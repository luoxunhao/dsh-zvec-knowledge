/**
 * IconButton — design spec §4.6.
 *
 * The spec forbids an icon-only control without a tooltip and an accessible
 * name, so `label` is a required prop and the tooltip is derived from it rather
 * than asked for separately: two required strings for one fact is how they drift
 * apart. Screenshotting a row of icon buttons that all say nothing is the
 * failure this prevents.
 *
 * `title` is used for the tooltip rather than a custom overlay because the host
 * may render the plugin at any density, and the native tooltip never clips.
 */

import { Spinner, type SpinnerSize } from './Spinner.tsx'
import { Icon, type IconName } from './Icon.tsx'
import styles from './IconButton.module.css'

/** Rendered size: the page control, or the compact form for embedding. */
export type IconButtonSize = 'md' | 'compact'

/** Options accepted by {@link IconButton}. */
export interface IconButtonProps {
  /** Which glyph to draw. */
  icon: IconName
  /** Accessible name and tooltip text. Required. */
  label: string
  /** Called on activation. Not called while busy or disabled. */
  onClick?: () => void
  /** Brand-tinted variant, reserved for high-frequency critical actions. */
  primary?: boolean
  /** Rendered size. */
  size?: IconButtonSize
  /** Busy state: shows a spinner in the same box. */
  loading?: boolean
  /** Disables interaction and applies the reduced-contrast treatment. */
  disabled?: boolean
}

/**
 * Render an icon-only control.
 * @param props - glyph, accessible name and state flags.
 * @returns the icon button.
 */
export function IconButton({
  icon, label, onClick, primary = false, size = 'md', loading = false, disabled = false,
}: IconButtonProps): React.JSX.Element {
  const inert = disabled || loading
  const glyph = size === 'compact' ? 12 : 16
  const spinnerSize: SpinnerSize = size === 'compact' ? 'sm' : 'md'
  const classes = [
    styles.button, styles[size], primary ? styles.primary : '', loading ? styles.loading : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={classes}
      title={label}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={inert}
      onClick={inert ? undefined : onClick}
    >
      {loading ? <Spinner size={spinnerSize} /> : <Icon name={icon} size={glyph} />}
    </button>
  )
}
