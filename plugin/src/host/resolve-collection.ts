/**
 * Resolve what a caller passed as `collection` into a real collection id.
 *
 * ## The defect this exists for
 *
 * A user picks a knowledge base from the `@` menu. The chip serializes to a
 * sentence that already contains the correct id:
 *
 *     （用户指定本次回答使用知识库「agent-book」：调用 dsh_kb_search 时
 *       collection 参数传 "kb_agentbook_5eed"）
 *
 * The call that followed still passed the **display name** (`agent-book`) as
 * `collection`. The store rejected it as malformed, and the session spent an
 * extra round trip on `discovery_needed` before it could search — so the first
 * call of every such conversation failed. Every link in the chain was correct
 * except the one nothing guarded: "the text mentions the id" to "the parameter
 * actually used the id".
 *
 * The id is a `<domain>_<hex>` string a user never sees; the name is what they
 * actually say. Translating between them is therefore a *code* responsibility,
 * not something to hope a model infers from prose.
 *
 * ## Why this is a pure function
 *
 * It touches no store, no embedder and no filesystem. That is what lets the
 * rules be enumerated exhaustively in `verify-collection-resolution.mjs`,
 * including the ambiguity case a real store would make awkward to construct.
 * The caller supplies the visible list; this module only decides.
 *
 * ## Why ambiguity is refused rather than resolved
 *
 * A collection `name` has no uniqueness constraint — only the id is unique. Two
 * knowledge bases named "docs" are legal. Picking the first would silently
 * search the wrong one, and a wrong-corpus answer does not raise an error: it
 * returns confidently off-topic citations, which is far more expensive to
 * notice than an extra round trip. So ambiguity is reported with its candidates
 * and the caller chooses.
 *
 * @module dsh-zvec-knowledge/host/resolve-collection
 */

/**
 * One knowledge base as the resolver sees it.
 *
 * A structural subset of the store's collection view: only the two fields
 * resolution reads. Taking the narrow shape keeps this module independent of
 * the store layer, so it stays testable without one.
 */
export interface ResolvableCollection {
  /** The collection id, shaped `<domain>_<hex>`. */
  id: string
  /** The display name a user picks by. */
  name: string
  /** Build timestamp, or `null` when the collection has no index yet. */
  builtAt?: string | null
}

/** Why an input could not be resolved to exactly one collection. */
export type ResolveFailure =
  /** The caller passed nothing but whitespace. */
  | 'empty'
  /** Several collections matched equally well. */
  | 'ambiguous'
  /** Nothing matched. */
  | 'not_found'

/** The outcome of resolving a `collection` argument. */
export type ResolveResult =
  | { ok: true, id: string, name: string }
  | { ok: false, reason: 'ambiguous', input: string, candidates: ResolvableCollection[] }
  | { ok: false, reason: 'not_found', input: string, available: ResolvableCollection[] }
  | { ok: false, reason: 'empty', input: string }

/**
 * The id shape the store enforces.
 *
 * Duplicated from `store/paths.ts` rather than imported: this module is
 * deliberately free of store imports, and the pattern is a fixed wire contract
 * that both sides must agree on. `verify-collection-resolution.mjs` pins them
 * together so a change to one without the other fails the gate.
 */
const COLLECTION_ID = /^kb_[a-z][a-z0-9]{0,15}_[0-9a-f]{4}$/

/**
 * A quoted string inside the chip's serialized sentence.
 *
 * The serializer emits `collection 参数传 "<id>"`; this pulls the value back
 * out. Both quote styles are accepted because the sentence is prose the
 * serializer may one day reword, and a smart-quote variant would otherwise turn
 * a working chain into a silent `not_found`.
 */
const QUOTED_VALUE = /["'“”‘’]([^"'“”‘’]+)["'“”‘’]/

/**
 * Normalize an input for comparison: trim and casefold.
 *
 * Knowledge-base names are Chinese or Latin and users type them loosely, so
 * case is not a meaningful distinction here.
 * @param value - the raw string.
 * @returns the comparison form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Extract the candidate value from a serialized chip sentence.
 *
 * Returns the original input when no quoted value is present, so a bare name or
 * a bare id passes through unchanged. When the sentence is present, the quoted
 * value is what the id lives in.
 * @param input - the raw `collection` argument.
 * @returns the value to resolve.
 */
function extractValue(input: string): string {
  const match = QUOTED_VALUE.exec(input)
  // `match[1]` is the capture group, which is present whenever the pattern
  // matched — but `noUncheckedIndexedAccess` cannot know that, so the fallback
  // states the invariant instead of asserting it away.
  const captured = match?.[1]
  return captured === undefined ? input : captured
}

/**
 * Resolve a `collection` argument to exactly one collection id.
 *
 * The order is deliberate: an exact id wins outright (it is unambiguous and
 * costs nothing), then an exact name, then a prefix. Each step only runs when
 * the previous one matched nothing, so a collection literally named after
 * another's id cannot shadow it.
 * @param input - the raw `collection` argument, or `null`/`undefined` when omitted.
 * @param listed - the collections currently visible to the caller.
 * @returns the resolution, or the reason it failed plus what to correct with.
 */
export function resolveCollection(
  input: string | null | undefined,
  listed: readonly ResolvableCollection[] | null | undefined,
): ResolveResult {
  // A missing list is a caller bug, not a reason to throw: this runs inside a
  // tool whose contract is to return judgeable text rather than raise, and an
  // exception here would end the turn instead of telling the model what to do.
  const collections = listed ?? []

  const raw = typeof input === 'string' ? input : ''
  if (raw.trim() === '') return { ok: false, reason: 'empty', input: raw }

  const value = extractValue(raw)
  const needle = normalize(value)

  // A quoted value that is itself empty (`collection=""`) leaves nothing to
  // match on; falling back to the whole sentence would be worse than saying so.
  if (needle === '') return { ok: false, reason: 'empty', input: raw }

  // 1. Exact id. Checked first because it is the only form that is already
  //    unambiguous, and a name collision must not be able to shadow it.
  const byId = collections.filter(item => normalize(item.id) === needle)
  if (byId.length === 1) {
    const hit = byId[0]
    if (hit !== undefined) return { ok: true, id: hit.id, name: hit.name }
  }

  // 2. Exact name.
  const byName = collections.filter(item => normalize(item.name) === needle)

  // 3. Unique prefix, over both names and ids: a user who pasted a truncated id
  //    from a log gets the same treatment as one who typed a short name.
  const matches = byName.length > 0
    ? byName
    : collections.filter(item =>
        normalize(item.name).startsWith(needle) || normalize(item.id).startsWith(needle))

  if (matches.length === 1) {
    const hit = matches[0]
    if (hit !== undefined) return { ok: true, id: hit.id, name: hit.name }
  }
  if (matches.length > 1) {
    // Every candidate is returned, not just the first few: the caller's next
    // call has to name one exactly, and a truncated list can withhold the one
    // it wants.
    return { ok: false, reason: 'ambiguous', input: raw, candidates: [...matches] }
  }

  // Nothing matched. The available list is the correction the previous
  // `collection_not_found` dead end was missing.
  return { ok: false, reason: 'not_found', input: raw, available: [...collections] }
}

/** The id pattern, exported so the gate can pin it against `store/paths.ts`. */
export const COLLECTION_ID_PATTERN = COLLECTION_ID
