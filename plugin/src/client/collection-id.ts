/**
 * Collection identifier generation and validation, shared by the create flow.
 *
 * The spec fixes the identifier's shape as "业务域缩写 + 短哈希" (`kb_prod_2f8a`) and
 * `store/paths.ts` owns the authoritative pattern. This module is the *client-side*
 * producer: it turns a display name into a candidate identifier and validates the
 * result, so the create dialog can show the identifier it is about to use before
 * the user commits.
 *
 * The hash is derived from the name plus a timestamp rather than randomly, which
 * makes two collections created in the same millisecond from the same name still
 * collide-resistant while keeping the value reproducible from its inputs — handy
 * when reconciling a card against a log line.
 *
 * @module dsh-zvec-knowledge/client/collection-id
 */

/** Pattern the store enforces. Kept in sync with `store/paths.ts`. */
export const COLLECTION_ID_PATTERN = /^kb_[a-z][a-z0-9]{0,15}_[0-9a-f]{4}$/

/**
 * Derive a business-domain abbreviation from a display name.
 *
 * Latin names are reduced to their letters and digits; a CJK name has no
 * meaningful ASCII abbreviation, so it falls back to `kb` rather than producing
 * an empty or transliterated guess.
 *
 * The store's pattern requires the domain segment to *start with a letter*, so a
 * name like "123" (or one whose letters are all stripped) is prefixed with `k`.
 * Without that, a purely numeric name generates an id the store rejects — a
 * failure that would only surface when the user pressed create.
 * @param name - display name.
 * @returns the abbreviation segment, always starting with a letter.
 */
export function domainFromName(name: string): string {
  const latin = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (latin === '') return 'kb'
  const lead = /^[a-z]/.test(latin) ? latin : `k${latin}`
  return lead.slice(0, 16)
}

/**
 * Compute a four-character hex discriminator.
 *
 * FNV-1a over the seed: short, dependency-free, and stable for a given input, so
 * the same name and timestamp always produce the same suffix.
 * @param seed - input to hash.
 * @returns four lowercase hex digits.
 */
export function shortHash(seed: string): string {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  // `>>> 0` keeps the value unsigned before formatting.
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4)
}

/**
 * Build a collection identifier for a display name.
 * @param name - display name.
 * @param seed - discriminator seed; defaults to the current time.
 * @returns a validated identifier of the documented shape.
 */
export function buildCollectionId(name: string, seed: string = String(Date.now())): string {
  return `kb_${domainFromName(name)}_${shortHash(`${name}\u0000${seed}`)}`
}

/**
 * Whether an identifier matches the documented shape.
 * @param id - candidate identifier.
 * @returns true when the store would accept it.
 */
export function isValidCollectionId(id: string): boolean {
  return COLLECTION_ID_PATTERN.test(id)
}

/**
 * Validate a display name the user typed.
 *
 * Returns a reason rather than a boolean because the spec forbids a bare
 * "invalid input" message: every rejection has to say what to change.
 * @param name - candidate display name.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateCollectionName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return '请输入知识库名称'
  if (trimmed.length > 40) return '名称最多 40 个字符'
  return null
}

/**
 * Validate an identifier the user edited.
 * @param id - candidate identifier.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateCollectionId(id: string): string | null {
  if (id.trim() === '') return '请输入集合标识'
  if (!isValidCollectionId(id)) {
    return '集合标识格式为 kb_<业务域>_<4 位十六进制>，例如 kb_prod_2f8a'
  }
  return null
}
