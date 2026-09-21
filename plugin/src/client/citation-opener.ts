/**
 * Opening a citation as a right-Sidebar tab.
 *
 * The tool view (a turn's `dsh_kb_search` card) needs to open a tab in the right
 * column. It may not import `@deepseek-ai/dsh-client-ui-sidebar-right` as a value:
 * the client purity gate allows only the module table's entries, and that package
 * is not one of them. Nor may it read `ctx.sidebarRight` itself — a slot
 * component receives an owner share, not a Cordis context.
 *
 * So the two are joined here, at plugin activation, and the join is **inverted**:
 * `apply()` installs an opener once, and the tool view asks this module for it.
 * The alternative — passing an `openCitation` prop down through the slot — is not
 * available, because the slot's owner share is composed by the harness and a
 * plugin cannot add to it. A module-level holder is the honest shape for "one
 * instance per loaded plugin", the same reasoning the panel's shared state uses.
 *
 * **Absence is a state, not a failure.** `ctx.sidebarRight` is optional: a
 * deployment can load the web shell without the right column. When it is absent
 * the holder keeps `undefined`, the tool view renders citations as plain text
 * rather than dead links, and nothing throws. A citation that cannot be opened is
 * still a citation — it carries the path and line a reader can follow by hand.
 *
 * @module dsh-zvec-knowledge/client/citation-opener
 */

import type { CitationParams, CitationRef } from './citation-tab.ts'

/** What opening a citation does. */
export interface CitationOpener {
  /**
   * Open a citation in the right column, revealing it.
   * @param ref - the citation to open.
   * @param params - the citation's view parameters.
   */
  open: (ref: CitationRef, params: CitationParams) => void
  /**
   * Whether the column is available at all.
   *
   * Read by the tool view so it can decide between a link and plain text before
   * rendering, rather than rendering a control that silently does nothing.
   * @returns whether an opener is installed.
   */
  available: () => boolean
}

/**
 * The installed opener, or `undefined` when the right column is not loaded.
 *
 * Module-level and singular by design: it stands for the loaded plugin instance,
 * which is exactly one per page.
 */
let installed: CitationOpener | undefined

/**
 * Install the opener for this plugin instance.
 *
 * Called once from `apply()`, inside the same effect that owns the tab type's
 * registration — the opener is useless without the type, and the two must leave
 * together.
 * @param opener - the opener to install.
 * @returns a disposer that uninstalls exactly this opener.
 */
export function installCitationOpener(opener: CitationOpener): () => void {
  installed = opener
  return () => {
    // Guarded so a later installation is not torn down by an earlier one's
    // disposer: activation order is not guaranteed, and clearing unconditionally
    // would let a stale disposer blind the live instance.
    if (installed === opener) installed = undefined
  }
}

/**
 * The installed opener, if any.
 * @returns the opener, or `undefined`.
 */
export function citationOpener(): CitationOpener | undefined {
  return installed
}

/**
 * Open a citation, when the column is available.
 * @param ref - the citation to open.
 * @param params - the citation's view parameters.
 * @returns whether the citation was opened.
 */
export function openCitation(ref: CitationRef, params: CitationParams = {}): boolean {
  if (installed === undefined) return false
  installed.open(ref, params)
  return true
}

/** Reset the holder; for tests only. */
export function resetCitationOpener(): void {
  installed = undefined
}
