/**
 * Inline icon set.
 *
 * The plugin carries its own icons rather than depending on a host icon
 * package: `@deepseek-ai/dsh-client-ui-primitives` is a platform module, but its
 * icon surface is not part of the documented plugin contract, and a value
 * import of anything outside the module table fails the client purity gate.
 * Inline paths keep the bundle honest and the icon set reviewable.
 *
 * Every icon draws with `currentColor` and inherits its size, so an icon inside
 * a disabled control dims with the control instead of staying fully opaque.
 */

import type { SVGProps } from 'react'

/** The icons this plugin draws. */
export type IconName =
  | 'search'
  | 'close'
  | 'chevron-down'
  | 'check'
  | 'plus'
  | 'refresh'
  | 'file'
  | 'collection'
  | 'alert'
  | 'info'
  | 'clock'

/** Options accepted by {@link Icon}. */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /** Which glyph to draw. */
  name: IconName
  /** Rendered edge length in pixels; the design spec uses 16 and 18. */
  size?: number
}

/** Path data per glyph, authored on a 24×24 grid. */
const GLYPHS: Record<IconName, readonly string[]> = {
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M16.2 16.2 21 21'],
  close: ['M6 6 18 18', 'M18 6 6 18'],
  'chevron-down': ['M6 9.5 12 15.5 18 9.5'],
  check: ['M5 12.5 9.5 17 19 7'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4.5V9h-4.5'],
  file: ['M7 3h7l4 4v14H7z', 'M14 3v4h4'],
  collection: ['M12 3 3 8l9 5 9-5-9-5z', 'M3 13.5 12 18.5l9-5'],
  alert: ['M12 4 21 20H3z', 'M12 10v4.5', 'M12 17.3v.2'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6', 'M12 7.4v.2'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5.5l3.5 2'],
}

/**
 * Draw one icon.
 *
 * Decorative by default: the glyph is accompanied by visible text or by an
 * `aria-label` on the interactive ancestor, so repeating the shape as a label
 * would only make screen readers say it twice. Pass `aria-label` to override
 * when the icon is the only content, as in an icon button.
 * @param props - glyph name, size, and standard SVG attributes.
 * @returns the icon element.
 */
export function Icon({ name, size = 16, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest['aria-label'] === undefined ? true : undefined}
      focusable={false}
      {...rest}
    >
      {GLYPHS[name].map(path => <path key={path} d={path} />)}
    </svg>
  )
}
