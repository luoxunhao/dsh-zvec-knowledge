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
}

/** A slot key this plugin addresses. */
export type KnowledgeSlotKey = keyof KnowledgeSlotMap

/** Options for a `main` (keyed) registration. */
export interface KeyedRegisterOptions {
  /** Target slot key. */
  name: 'main'
  /** Dispatch key; the layout service selects this panel by it. */
  key: string
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
    options: KeyedRegisterOptions | ListRegisterOptions,
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
