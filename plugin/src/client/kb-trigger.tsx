/**
 * The knowledge-base trigger source: `@` completion plus the composer button.
 *
 * ## The problem it solves
 *
 * `dsh_kb_search` takes a `collection` id shaped like `kb_agentbook_5eed` — a
 * string a user never sees and a model cannot guess. Before this source existed,
 * the only way the right id reached the model was a prior failed call. The user's
 * phrasing ("在智能体书籍里查…") carries the *name*, and nothing translated it
 * into the *id*.
 *
 * This source makes the id a first-class part of the draft: the user types `@`,
 * picks a knowledge base from the menu (or presses the composer button), and a
 * chip carrying the id enters the text. On submit the host serializes the chip
 * into an instruction the model reads, so the collection parameter arrives
 * without either side guessing.
 *
 * ## Why one source serves two entrances
 *
 * The composer button and the `@` menu are the same feature at different
 * distances: the button is one click for the common case, the keyboard is faster
 * once learned, and both must present the same list or the two surfaces drift.
 * Registering one trigger source gives both — the button calls the pipeline's
 * `toggleSource` with this source's name, which is how the shipped permission
 * button opens the command menu.
 *
 * ## Why the pipeline's types are restated here
 *
 * `@deepseek-ai/dsh-client-ui-input-trigger` is a *host plugin*, not one of the
 * module-table entries a third-party client may import (see `tsdown.config.ts`'s
 * PLATFORM_MODULES and the purity gate that enforces it). The shapes this source
 * touches are therefore restated below, exactly as `client/slots.ts` restates the
 * slot registry — with a comment pointing at the authoritative file, so a harness
 * change surfaces as a mismatch here rather than as a silently dead menu.
 *
 * @module dsh-zvec-knowledge/client/kb-trigger
 */

import type { KnowledgeBasePort, HostCollection } from './app.tsx'

/** The source name this registration owns; the button opens the menu by it. */
export const KB_TRIGGER_SOURCE = 'kb'

/**
 * One menu candidate, restated from
 * `dsh-client-ui-input-trigger/lib/types/types.d.ts` (`InputTriggerCandidate`).
 */
export interface TriggerCandidate {
  readonly name: string
  readonly description?: string
  /** The menu maps this to its own glyph set; 'file' is the file-shaped one. */
  readonly icon?: 'file' | 'folder' | 'session'
  readonly hint?: string
  readonly section?: string
  /** Opaque source-owned pick payload, returned through onPick. */
  readonly value?: string
}

/**
 * One pick, restated from the same file (`InputTriggerPick`). The pipeline hands
 * the candidate back, so the fields below are the ones this source reads.
 */
export interface TriggerPick {
  readonly candidate: TriggerCandidate
}

/**
 * A reference insert, restated from
 * `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`
 * (`ReferenceInsert`). This is the pick outcome that turns a candidate into a
 * chip in the draft.
 */
export interface TriggerInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/**
 * The reference codec, restated from `InputTriggerSource.codec`
 * (`ReferenceCodec`). `serialize` runs at submit time per chip occurrence, and a
 * rejection blocks the send rather than silently downgrading.
 */
export interface TriggerCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/**
 * The source contract, narrowed to the members this module implements. Restated
 * from `InputTriggerSource` in the same host file; the host reads the object
 * structurally, so the restatement is what the purity gate allows.
 */
export interface KbTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session: unknown, request: { query: string, signal: AbortSignal }): Promise<readonly TriggerCandidate[]>
  onPick(pick: TriggerPick): { insert: TriggerInsert } | 'handled' | undefined
  /** Synchronous hot name roll; `undefined` = not warm, never a fetch. */
  lexicon?(): readonly string[] | undefined
  readonly codec: TriggerCodec
}

/**
 * The root service face, restated from
 * `dsh-client-ui-input-trigger/lib/types/client/contract.d.ts`
 * (`InputTriggerServiceContract`).
 *
 * **A source sees `registerSource` alone.** The contract says so verbatim: "sources
 * see registerSource alone, the conversation wiring layer resolves its per-session
 * controller through sessionOf". That distinction is the whole reason this module
 * has two interfaces instead of one — see {@link triggerRegistryOf}.
 */
export interface InputTriggerRegistry {
  registerSource(src: KbTriggerSource): () => void
  /**
   * Resolve the lazy controller owned by one session scope.
   *
   * Not used by this module's own registrations, but declared because its presence
   * is how a caller can tell the root service apart from a stub, and because the
   * composer button needs the controller it returns.
   */
  sessionOf(actx: unknown): InputTriggerControllerLike
}

/**
 * The per-session controller, narrowed to the one method the button uses.
 *
 * Restated from `InputTriggerController` (`lib/types/client/controller.d.ts`).
 * `toggleSource` lives here and **not** on the root service: an earlier revision
 * looked for it on the root, so {@link triggerRegistryOf} always returned
 * `undefined`, the source never registered, and the composer button rendered as a
 * clickable control that silently did nothing.
 */
export interface InputTriggerControllerLike {
  /** Opens a menu containing exactly one registered source. */
  toggleSource(
    source: string,
    hit: {
      trigger: '@', query: string, quoted: boolean,
      position: 'leading' | 'inline',
      span: { start: number, end: number, draftRev: number },
    },
  ): void
}

/**
 * Read the trigger registry off a client context.
 *
 * Requires `registerSource` **only**. An earlier version also required
 * `toggleSource` here, which the root service never has — so the guard rejected a
 * perfectly good registry and disabled the entire feature with no error anywhere.
 * Demanding a method from the wrong object is worse than not checking at all,
 * because the failure is silent.
 * @param ctx - the plugin's client context.
 * @returns the registry, or `undefined` when the harness does not provide it.
 */
export function triggerRegistryOf(ctx: unknown): InputTriggerRegistry | undefined {
  const registry = (ctx as { inputTriggers?: Partial<InputTriggerRegistry> }).inputTriggers
  if (registry?.registerSource === undefined) return undefined
  return registry as InputTriggerRegistry
}

/**
 * Resolve the per-session controller the composer button drives.
 *
 * The button needs `toggleSource`, which only the controller has. Resolution is
 * best-effort: on a harness whose `sessionOf` is absent or throws, the button
 * still renders (the `@` keyboard path is unaffected) and simply does not open a
 * menu, which is a smaller failure than taking the panel down with it.
 * @param registry - the root service, when present.
 * @param ctx - the plugin's client context, used as the session scope.
 * @returns the controller, or `undefined` when it cannot be resolved.
 */
export function triggerControllerOf(
  registry: InputTriggerRegistry | undefined,
  ctx: unknown,
): InputTriggerControllerLike | undefined {
  if (registry?.sessionOf === undefined) return undefined
  try {
    const controller = registry.sessionOf(ctx)
    return typeof controller?.toggleSource === 'function' ? controller : undefined
  } catch {
    // A scope that is not a session, or a harness that throws for one: the button
    // degrades to a no-op rather than escaping into the render.
    return undefined
  }
}

/**
 * The serialization wrapped around one picked knowledge base.
 *
 * Stated as an instruction with the exact parameter value, not as a bare id: a
 * model reading `kb_agentbook_5eed` still has to infer what it is for, and the
 * parameter name is the part that makes the next tool call correct.
 * @param collection - the picked collection's id.
 * @param name - the picked collection's display name.
 * @returns the text the model receives in place of the chip.
 */
export function serializeKbReference(collection: string, name: string): string {
  return `（用户指定本次回答使用知识库「${name}」：调用 dsh_kb_search 时 collection 参数传 "${collection}"）`
}

/**
 * Report which composer entrances are live, once.
 *
 * The failure this exists for is invisible: a plugin that cannot reach the
 * trigger service draws no menu, throws nothing, and leaves a button that appears
 * functional. A single line naming what was found turns that into something a user
 * can read and report, instead of a feature that "does nothing".
 *
 * It is written to the console rather than the DOM because it is a diagnostic for
 * whoever is debugging, not product copy.
 * @param state - what the registration actually found.
 */
export function reportClientDiagnostics(state: {
  triggerRegistry: boolean
  sourceRegistered: boolean
}): void {
  // eslint-disable-next-line no-console
  console.info(
    '[dsh-zvec-knowledge] composer entrances:',
    `triggerRegistry=${state.triggerRegistry ? 'yes' : 'NO'}`,
    `@sourceRegistered=${state.sourceRegistered ? 'yes' : 'NO'}`,
    '(the 知识库 button writes the draft directly and does not depend on these)',
  )
}

/** One collection as the menu shows it. */
export interface KbCandidate {
  /** The collection id, which is what the chip carries. */
  id: string
  /** The display name, which is what the user picks by. */
  name: string
  /** Whether the collection has a built index. */
  built: boolean
}

/** The collection names last seen, for the lexicon roll. */
let lexiconCache: string[] | undefined

/**
 * Refresh the lexicon roll from one collection list.
 *
 * Called after a candidate fetch, so the synchronous lexicon hook never issues a
 * request of its own.
 * @param collections - the current collections.
 */
export function refreshKbLexicon(collections: HostCollection[]): void {
  lexiconCache = collections.map(item => item.name)
}

/**
 * Fetch and shape the candidate list.
 *
 * The list is fetched per keystroke through the shared port — the same channel
 * the panel uses — because collections change while a session is open, and a
 * warm-then-stale cache would offer a deleted base. The menu filters by both the
 * name and the id, since a user who copied the id out of the overview card
 * pastes that.
 * @param port - the host data channel.
 * @param query - the live text after the trigger character.
 * @returns the matching candidates, best first.
 */
export async function kbCandidates(port: KnowledgeBasePort, query: string): Promise<KbCandidate[]> {
  let collections: HostCollection[]
  try {
    collections = await port.listCollections()
  } catch {
    // An unreachable channel leaves the menu empty rather than erroring: the
    // composer is still usable, and the panel is where the user fixes the port.
    return []
  }
  // The fetch doubles as the lexicon's warm-up: the roll is synchronous and must
  // not fetch, so the candidate path — which fetches anyway — refreshes it.
  refreshKbLexicon(collections)
  const needle = query.trim().toLowerCase()
  const matched = needle === ''
    ? collections
    : collections.filter(item =>
        item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
  // Built collections sort first: an unbuilt one answers nothing, so it should
  // not be the row a quick Enter lands on.
  return matched
    .map(item => ({ id: item.id, name: item.name, built: item.builtAt !== null }))
    .sort((left, right) => Number(right.built) - Number(left.built))
}

/**
 * The reference codec: how a picked chip reads on the clipboard and to the model.
 * @param port - the host channel, for resolving a chip's display name.
 * @returns the codec for knowledge-base chips.
 */
export function kbReferenceCodec(port: KnowledgeBasePort): TriggerCodec {
  return {
    // The clipboard form is what the user sees if they cut the chip, so it names
    // the base rather than exposing the internal id.
    clipboardText: ref => `@${ref}`,
    serialize: (ref, signal) => {
      if (signal.aborted) return Promise.reject(new Error('序列化已取消'))
      return (async () => {
        // The name is cosmetic in the instruction, so a lookup failure degrades to
        // the id rather than blocking the send: the id alone makes the call right.
        let name = ref
        try {
          const collections = await port.listCollections()
          name = collections.find(item => item.id === ref)?.name ?? ref
        } catch {
          // See above: the id is what matters.
        }
        return serializeKbReference(ref, name)
      })()
    },
  }
}

/**
 * Build the trigger source.
 * @param port - the host data channel shared with the rest of the client.
 * @returns the source, ready for the trigger registry.
 */
export function createKbTriggerSource(port: KnowledgeBasePort): KbTriggerSource {
  return {
    trigger: '@',
    name: KB_TRIGGER_SOURCE,
    // After the shipped file/session group: those answer "what am I talking
    // about", this answers "where should the answer come from".
    order: 20,
    showGroupTitle: true,

    candidates: async (_session, request) => {
      const matches = await kbCandidates(port, request.query)
      const rows: TriggerCandidate[] = matches.map(item => ({
        name: item.name,
        description: item.built ? item.id : `${item.id} · 未构建`,
        icon: 'file',
        value: item.id,
      }))
      return rows
    },

    onPick: (pick: TriggerPick) => {
      const id = pick.candidate.value ?? pick.candidate.name
      return {
        insert: {
          source: KB_TRIGGER_SOURCE,
          ref: id,
          label: pick.candidate.name,
          // Clipboard form follows the codec, so a cut chip pastes as `@名称`.
          clipboardText: `@${pick.candidate.name}`,
        },
      }
    },

    lexicon: () => lexiconCache,
    codec: kbReferenceCodec(port),
  }
}
