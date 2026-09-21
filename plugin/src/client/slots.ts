/**
 * Slot declaration shims for the harness seams this plugin registers into.
 *
 * ## Why this file restates types instead of importing them
 *
 * The harness ships its slot contracts as `declare module` augmentations inside
 * each owning package's client types (`dsh-client-ui-sidebar`,
 * `dsh-client-ui-layout`, `dsh-client-ui-renderer`). Those packages are **not
 * dependencies of this plugin**, and deliberately so: the client purity gate
 * allows only the nine module-table entries to be imported as values, and pulling
 * three more packages in as type-only dependencies would mean the plugin fails to
 * compile for anyone whose profile does not happen to include them.
 *
 * So the three seams this plugin touches are restated here:
 *
 * | seam | authoritative source |
 * |------|----------------------|
 * | `ctx.slots` service | `dsh-client-ui-renderer/lib/types/client/registry.d.ts` |
 * | `sidebar.panellist` | `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` |
 * | `main` (keyed panel slot) | the layout shell's dispatch site |
 *
 * **These declarations are the integration contract.** A harness change to a
 * slot's kind or owner props has to be reflected here, and the mismatch surfaces
 * at the `register` call rather than at runtime — which is exactly why restating
 * them beats casting to `any`.
 *
 * ## What is deliberately *not* restated
 *
 * The harness's `register` is generically typed over `ComposedProps`, which
 * composes four shares (runtime, child-render, store, inject, locale) out of the
 * full slot type graph. Reproducing that graph here would be reproducing the
 * framework, and a subtly wrong copy would be worse than a narrow one. The
 * signature below is therefore narrow: it types the options this plugin passes
 * and the owner share its components receive, which is the part where a mistake
 * is actually likely.
 *
 * @module dsh-zvec-knowledge/client/slots
 */

import type { ReactNode } from 'react'

/**
 * Owner share of the sidebar's global panel row.
 *
 * Restated from `SidebarPanelIconOwnerProps`.
 */
export interface SidebarPanelIconOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is currently selected in the main column. */
  active: boolean
}

/**
 * Owner share of the `main` slot.
 *
 * The layout shell dispatches the main slot with no owner props of its own
 * (`renderSlot('main', {}, { entryKey })`), so the share is empty. It is declared
 * rather than omitted because a slot entry's `owner` is how a registrant states
 * what the parent must pass — asserting emptiness documents that this panel needs
 * nothing from the frame.
 */
export interface MainPanelOwnerProps {
  /** Marker field: the frame passes no owner props to a main panel. */
  children?: never
}

/** Kind/scope declaration shared by every entry in the table below. */
interface SlotEntryDef {
  /** Cardinality. */
  kind: 'single' | 'list' | 'keyed' | 'chain'
  /** Data context. */
  scope: 'root' | 'session-maybe' | 'session'
  /** Owner-supplied props share. */
  owner?: object
}

/**
 * Slot contract table, restated for the two seams this plugin addresses.
 *
 * Declaring only these two keys is correct rather than incomplete: a `SlotMap`
 * entry is a promise about what a registrant may address, and this plugin
 * addresses exactly two.
 */
export interface KnowledgeSlotMap {
  /**
   * Global panel icons in the sidebar.
   *
   * A `list` slot: each `id` addresses the matching main panel, and the sidebar
   * owns the button while resolving its label from this registration's metadata —
   * which is why the label is registration data rather than something the plugin
   * renders.
   */
  'sidebar.panellist': {
    kind: 'list'
    scope: 'root'
    owner: SidebarPanelIconOwnerProps
  }
  /**
   * The central panel area, dispatched by active panel key.
   *
   * A `keyed` slot with an open key domain (the harness reports `conversation` as
   * the only key taken), so registering `key: 'knowledge'` adds a new main panel
   * beside the conversation rather than shadowing it.
   */
  'main': {
    kind: 'keyed'
    scope: 'root'
    owner: MainPanelOwnerProps
  }
  /**
   * One tool call's view inside a turn, dispatched by wire tool name.
   *
   * Restated from `tool.call.toolview` in `dsh-client-ui-tool`'s contract. A
   * `keyed` slot scoped to the session, with an open key domain: registering this
   * plugin's own tool name claims a key nothing else occupies, so it is additive
   * rather than a takeover.
   */
  'tool.call.toolview': {
    kind: 'keyed'
    scope: 'session'
    owner: ToolCallOwnerProps
  }
  /**
   * Compact controls before the composer submit action — the row the shipped
   * permission selector sits in.
   *
   * Restated from `dsh-client-ui-conversation`'s slot contract. A `list` scoped
   * to the session with an owner share of `{ locked: boolean }`: a fresh id adds
   * an entry beside the shipped ones, which is what makes a button additive
   * rather than a takeover.
   */
  'conversation.input.right': {
    kind: 'list'
    scope: 'session'
    owner: ComposerControlOwnerProps
  }
  /**
   * One right-Sidebar tab's body, dispatched with the id of the tab type in force.
   *
   * Restated from `dsh-client-ui-sidebar-right`'s slot contract. This is the seam
   * that lets a citation open as a *tab* in the right column rather than as a
   * dialog: the column already owns docking, splitting, floating and per-session
   * state, and a second overlay surface would duplicate all of it.
   *
   * The key is the tab type's `id` (this package's name), not its `kind` — a kind
   * is a shared discriminator an extension may take over from a builtin, while an
   * id is unique per implementation. Registered under the wrong one, the body
   * silently never renders because nothing dispatches it.
   */
  'sidebar.right.pane.tab': {
    kind: 'keyed'
    scope: 'session'
    owner: SidebarRightTabBodyProps
  }
}

/**
 * Owner share of a composer input control.
 *
 * Restated from `InputControlOwnerProps` in the conversation slot contract. The
 * composer is the only member: it is true while it refuses interaction, which is
 * the one condition under which a control in this row must disable itself.
 */
export interface ComposerControlOwnerProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
}

/**
 * Owner share of an atomic tool view.
 *
 * Restated from `ToolCallOwnerProps`. Only the members this view reads are
 * declared: `callId`, `toolName` and `block` (the frozen call node). The owner
 * also passes `openFile`, `loadImage` and the standard selector hooks, which this
 * view does not use — declaring them would be asserting a contract this plugin
 * does not actually depend on.
 */
export interface ToolCallOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire tool name and keyed dispatch value. */
  toolName: string
  /**
   * The frozen call node.
   *
   * A running call carries `type: 'tool-call'` with raw JSON `arguments`; a
   * settled one carries the result `content` blocks. The view narrows this
   * rather than asserting a shape, because a node it did not expect must not
   * blank the turn.
   */
  block: {
    /** Block discriminant. */
    type?: string
    /** Raw JSON arguments as the model produced them. */
    arguments?: string
    /** Settled content blocks, when the call has finished. */
    content?: { type?: string, text?: string }[]
    /** Whether the result is an error. */
    isError?: boolean
  }
  /** Session workspace root, used for relative path summaries. */
  cwd?: string | undefined
}

/** A slot key this plugin addresses. */
export type KnowledgeSlotKey =
  | 'sidebar.panellist'
  | 'main'
  | 'tool.call.toolview'
  | 'conversation.input.right'
  | 'sidebar.right.pane.tab'

/**
 * Owner share of a right-Sidebar tab body.
 *
 * Restated from `SidebarRightTabInfo`, narrowed to what this tab's body reads.
 * The full share also carries pane identity, presentation state and the tab
 * record; this body needs the navigation it was opened with and the tab's live
 * signal, so declaring only those keeps the dependency honest.
 *
 * `navigation.params` is typed `unknown`: the params map is merge-extensible and
 * filled by the tab type that declares them, and this plugin's own declaration
 * (below) is where the real shape lives. The body narrows it once, at the edge.
 */
export interface SidebarRightTabBodyProps {
  /**
   * The tab's live information: the seat passes these as the body's owner share.
   *
   * Optional because the seat's exact prop composition is not restated here; the
   * body falls back to its navigation params when it is absent rather than
   * crashing a pane that the user cannot dismiss.
   */
  tab?: SidebarRightTabLiveInfo
  /** The same information under the name the seat's hook context exposes. */
  tabInfo?: SidebarRightTabLiveInfo
}

/** The live subset of a tab's information this body reads. */
export interface SidebarRightTabLiveInfo {
  /** Where the tab was last navigated to, carrying the opener's params. */
  navigation?: {
    /** The address opened. */
    address?: string
    /** The opener's parameters, shaped by the tab kind. */
    params?: unknown
  }
  /** Aborted when the record disappears or the plugin unloads. */
  signal?: AbortSignal
  /** Dismiss this tab. */
  actions?: {
    /** Close this tab. */
    close?: () => void
  }
}

/**
 * Options for a `sidebar.right.pane.tab` (keyed) registration.
 *
 * Separate from {@link KeyedRegisterOptions} because this slot is owned by the
 * right Sidebar rather than the layout shell, and its dispatch key is a tab
 * type's `id`. Folding the two together would let a caller pass a tab id to the
 * main panel, which the layout would ignore silently.
 */
export interface RightTabRegisterOptions {
  /** Target slot key. */
  name: 'sidebar.right.pane.tab'
  /** The tab type's `id`, which is what the seat dispatches on. */
  key: string
}

/** Options for a `main` or `tool.call.toolview` (keyed) registration. */
export interface KeyedRegisterOptions {
  /** Target slot key. */
  name: 'main' | 'tool.call.toolview'
  /** Dispatch key: the panel id, or the wire tool name. */
  key: string
}

/**
 * Options for a `conversation.input.right` (list) registration.
 *
 * Distinct from {@link ListRegisterOptions} because the two list slots have
 * different owner shares — the sidebar resolves a label, the composer hands down
 * a lock flag — and a shared interface would make one of them lie.
 */
export interface ComposerControlRegisterOptions {
  /** Target slot key. */
  name: 'conversation.input.right'
  /** The entry's cell id; a fresh id adds it beside the shipped controls. */
  id: string
}

/** Options for a `sidebar.panellist` (list) registration. */
export interface ListRegisterOptions {
  /** Target slot key. */
  name: 'sidebar.panellist'
  /** Cell id; doubles as the main panel key the row addresses. */
  id: string
  /** Ascending position among the rows. */
  order?: number
  /** Row label, resolved by the sidebar from this metadata. */
  label: string
}

/**
 * The registration surface this plugin uses.
 *
 * Narrower than the harness's `SlotRegistry`, which also exposes `install`,
 * `renderSlot`, inspection and subscription. Declaring only the used surface
 * keeps this file honest about what the plugin depends on; adding a method here
 * is the moment someone confirms the harness really provides it.
 */
export interface SlotRegistry {
  /**
   * Register a contribution into a declared slot.
   * @param options - target slot and its kind-specific fields.
   * @param component - the component; receives the slot's owner share.
   * @returns a disposer removing the contribution.
   */
  register(
    options: KeyedRegisterOptions | ListRegisterOptions | ComposerControlRegisterOptions | RightTabRegisterOptions,
    component: (props: never) => ReactNode,
  ): () => void
  /**
   * Install an effect for each declaration lifetime of a slot.
   *
   * The callback runs as soon as the slot is declared, which is what makes
   * registration order between plugins irrelevant. The returned disposer cancels
   * a pending wait and removes any active contribution.
   * @param key - declared slot key to depend on.
   * @param callback - creates the contribution's disposer(s).
   * @returns disposer for the wait and the contribution.
   */
  inject(key: KnowledgeSlotKey, callback: () => (() => void) | Iterable<() => void>): () => void
}
