/**
 * Structural access to the right Sidebar's service.
 *
 * ## Why this file does not import the package
 *
 * The client purity gate allows only the module table's entries to be imported as
 * values, and `@deepseek-ai/dsh-client-ui-sidebar-right` is not one of them. A
 * value import would either fail the build's purity gate or produce a `require`
 * the browser module table cannot answer.
 *
 * The plugin does not need the import: it needs two methods. So the service is
 * read **structurally** — the same approach `kb-trigger.tsx` takes to the input
 * trigger registry — and the two methods are declared here with the narrowest
 * signatures this plugin actually calls.
 *
 * ## Why an absent service is tolerated
 *
 * `ctx.sidebarRight` is contributed by a package this plugin does not depend on.
 * A deployment can load the web shell without the right column, and a plugin that
 * threw on its absence would take the whole knowledge panel down because a
 * *different* feature is unavailable. So absence yields `undefined` and the caller
 * degrades: the tool view renders citations as text rather than dead links.
 *
 * ## Why these two methods and not the whole interface
 *
 * `registerTabType` is the registry's stage one — what a tab type IS. `openTab`
 * is navigation. Between them they are the entire surface this plugin uses;
 * declaring anything more would be asserting a contract the plugin does not
 * depend on, and the assertion would be the thing that breaks.
 *
 * @module dsh-zvec-knowledge/client/sidebar-right
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CitationTabDefinition } from './citation-definition.ts'

/** Options for {@link SidebarRightLike.openTab}. */
export interface OpenTabOptions {
  /**
   * The content identity, which for a page is the address the package records it
   * under.
   *
   * Supplied explicitly rather than left to the service's own composition so that
   * two citations of one document are one tab re-navigated, not two tabs — the
   * behaviour the whole address design exists to produce.
   */
  contentId?: string
  /** Chip text captured into the layout record at open time. */
  title?: string
  /** Reveal an already-open tab of this content instead of duplicating it. */
  revealIfOpened?: boolean
  /** The navigation parameters, shaped by the tab kind. */
  params?: unknown
}

/**
 * The right Sidebar surface this plugin uses.
 *
 * Narrow by construction; see the module note.
 */
export interface SidebarRightLike {
  /**
   * Register a tab type for the caller's lifetime.
   * @param definition - the type to register.
   * @returns a disposer removing it.
   */
  registerTabType: (definition: CitationTabDefinition) => () => void
  /**
   * Open a page type by kind, revealing the column.
   * @param kind - the registered kind.
   * @param options - content identity, chip text and navigation parameters.
   */
  openTab: (kind: string, options?: OpenTabOptions) => void
}

/**
 * Read the right Sidebar service off a client context, if it is loaded.
 *
 * Structural rather than typed against the package: the two methods are checked
 * for shape, and anything missing means "not the surface this plugin knows", which
 * degrades to unavailable instead of throwing at a call site far from here.
 * @param ctx - the client context.
 * @returns the service, or `undefined` when it is absent or unrecognized.
 */
export function sidebarRightOf(ctx: ClientContext): SidebarRightLike | undefined {
  const candidate = (ctx as unknown as Record<string, unknown>).sidebarRight
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const service = candidate as Partial<SidebarRightLike>
  if (typeof service.registerTabType !== 'function') return undefined
  if (typeof service.openTab !== 'function') return undefined
  return service as SidebarRightLike
}
