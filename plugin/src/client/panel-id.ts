/**
 * The main-panel key this plugin owns.
 *
 * The harness types a registered panel key as `Branded<'MainPanelId'>` — a
 * compile-time-only phantom brand from `@deepseek-ai/dsh-brand`. That package is
 * present in this tree only transitively (via `dsh-client-ui-slots`), so the
 * plugin does not import it: depending on a package that is not a declared
 * dependency would break the moment the transitive edge moves.
 *
 * The brand is restated locally instead. It cannot interoperate with the
 * harness's own brand by construction — the brand symbol is module-private — so
 * the one place a branded value crosses the boundary (`ctx.layout.selectPanel`)
 * does a single narrow cast, with a comment saying why. One documented cast at
 * the boundary is cheaper and more honest than an undeclared dependency.
 *
 * @module dsh-zvec-knowledge/client/panel-id
 */

declare const KB_BRAND: unique symbol

/** A string carrying a compile-time-only brand, restated from the harness. */
type LocalBranded<B extends string> = string & { readonly [KB_BRAND]: B }

/** A registered main-panel key. */
export type MainPanelId = LocalBranded<'MainPanelId'>

/**
 * This plugin's panel key.
 *
 * `knowledge` rather than `kb` so the key reads as a destination in a log line.
 * The sidebar row's visible label is supplied separately as registration
 * metadata, because the sidebar resolves row text from list metadata rather than
 * from anything the panel renders.
 */
export const KNOWLEDGE_PANEL_KEY = 'knowledge' as MainPanelId

/**
 * Sidebar entry id.
 *
 * Equal to the panel key on purpose: the sidebar treats `id` as the address of
 * the main panel it opens, so keeping them equal makes the row and the panel one
 * thing rather than two that must be kept in sync.
 */
export const KNOWLEDGE_SIDEBAR_ID = 'knowledge'

/** Visible sidebar row label. */
export const KNOWLEDGE_LABEL = '知识库'

/**
 * Row order among the sidebar's global panel icons.
 *
 * Ascending, default 0. 100 places the knowledge entry after the built-in panels
 * rather than displacing them, which is the polite position for a plugin that is
 * not the primary surface.
 */
export const KNOWLEDGE_ORDER = 100
