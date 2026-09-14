/**
 * The sidebar row glyph.
 *
 * The sidebar owns the button; this plugin supplies only what goes inside it, so
 * the component draws a mark and nothing else — no wrapper element, no margin, no
 * own sizing beyond the requested edge. The host positions and styles the row, and
 * a glyph that also styled itself would fight it.
 *
 * `active` is passed so the mark can follow the selection. It is expressed with
 * `currentColor`, which the row already sets for its own selected/unselected
 * treatment: inheriting that is how the mark stays consistent with the other
 * panel icons across both themes without a theme branch here.
 *
 * @module dsh-zvec-knowledge/client/panel-icon
 */

import { Icon } from './components/Icon.tsx'

/** Options accepted by {@link KnowledgeIcon}. */
export interface KnowledgeIconProps {
  /** Requested square edge in pixels, supplied by the sidebar row. */
  size: number
  /** Whether the knowledge panel is the selected main panel. */
  active: boolean
}

/**
 * Draw the sidebar entry's mark.
 * @param props - requested size and selection state.
 * @returns the glyph.
 */
export function KnowledgeIcon({ size, active }: KnowledgeIconProps): React.JSX.Element {
  return (
    <span
      // The label lives on the host's button, so the glyph must stay decorative:
      // announcing it twice is worse than not announcing it at all.
      aria-hidden="true"
      data-kb-nav-icon={active ? 'active' : 'idle'}
    >
      <Icon name="database" size={size} />
    </span>
  )
}
