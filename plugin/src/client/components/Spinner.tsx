/**
 * Indeterminate loading indicator.
 *
 * Exists so every loading state in the plugin shows the same spinner without
 * each component restating the animation. The reduced-motion query slows the
 * rotation rather than stopping it: a frozen ring reads as a static border and
 * would hide that the control is busy.
 */

import styles from './Spinner.module.css'

/** Rendered edge length, matching the control sizes the spec defines. */
export type SpinnerSize = 'sm' | 'md' | 'lg'

/** Options accepted by {@link Spinner}. */
export interface SpinnerProps {
  /** Edge length token. */
  size?: SpinnerSize
  /** Accessible label. Omit only when an ancestor already announces the busy state. */
  label?: string
  /** Extra class names from the calling component's CSS module. */
  className?: string
}

/**
 * Draw the loading ring.
 * @param props - size, optional label, and extra classes.
 * @returns the spinner element.
 */
export function Spinner({ size = 'md', label, className }: SpinnerProps): React.JSX.Element {
  const classes = [styles.spinner, styles[size], className].filter(Boolean).join(' ')
  return (
    <span
      className={classes}
      role={label === undefined ? undefined : 'status'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  )
}
