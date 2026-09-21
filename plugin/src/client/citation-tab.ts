/**
 * The right Sidebar's citation tab: a tab *type*, not a tab.
 *
 * A citation in an answer is a locator — `doc_ffb5b037.md:374` — and the reason a
 * reader clicks it is to check one claim against the passage it was built from.
 * This module makes that click open a tab in the right column.
 *
 * ## Why a tab type instead of a dialog
 *
 * The obvious implementation is a modal the tool view owns. It is the wrong shape
 * for three reasons the column already solves:
 *
 * 1. **Two citations must be comparable.** A reader checking a claim often wants
 *    the previous citation still on screen. A modal is exclusive; a docked tab is
 *    not, and two panes can hold two sources side by side.
 * 2. **The column survives navigation.** Citations are opened from a turn, and a
 *    reader who scrolls the conversation or switches session should not lose the
 *    passage they were reading. The right Sidebar's state is per session and
 *    owned by the shell; a dialog's state belongs to the component that rendered
 *    it and dies with it.
 * 3. **It is a seam the product already declares.** `sidebar.right.pane.tab` is a
 *    published slot and `ctx.sidebarRight` a published service, so this is
 *    additive. A custom overlay would reimplement docking, splitting, floating,
 *    keyboard dismissal and per-session restore, and would then have to keep
 *    working as the shell's real column changes.
 *
 * ## Why the address carries the parameters
 *
 * A right-Sidebar tab is identified by its **address**, and two opens of one
 * address are *the same tab* — that is what makes opening idempotent. So the
 * citation is folded into the address rather than passed as navigation params:
 * `dsh-kb-citation://<collection>/<docId>#L<line>`. Clicking `:275` and then
 * `:374` of one document therefore opens one tab and re-navigates it, instead of
 * accumulating a tab per line the reader checks.
 *
 * The chunk range travels in `params` rather than the address because it refines
 * the *view* of an already-identified passage rather than identifying a different
 * one — and a range is not something a user would ever type into an address box.
 *
 * @module dsh-zvec-knowledge/client/citation-tab
 */

/** The tab kind this type owns. */
export const CITATION_KIND = 'kb-citation'

/**
 * This implementation's identity in the tab system.
 *
 * This — not {@link CITATION_KIND} — is the key the body registers under in
 * `sidebar.right.pane.tab`: a kind is a shared discriminator an extension may take
 * over from a builtin, while an id is unique per implementation.
 */
export const CITATION_ID = 'dsh-zvec-knowledge/citation'

/** Address scheme prefix for a citation tab. */
export const CITATION_SCHEME = 'dsh-kb-citation://'

/** One citation as a tab address carries it. */
export interface CitationRef {
  /** Collection the cited document belongs to. */
  collectionId: string
  /** Cited document's id. */
  docId: string
  /** 1-based line the citation named. */
  line: number
}

/** The citation's view parameters, delivered through `navigation.params`. */
export interface CitationParams {
  /** Character range of the cited chunk, so the reader can mark the passage. */
  chunkRange?: { start: number, end: number }
  /** The confidence band the citation printed, for the reader's own judgement. */
  band?: string
  /** The normalized score the citation printed. */
  score?: number
  /** The query that produced the citation, so the tab is self-describing. */
  query?: string
  /** Display name of the source document, for the chip before the read lands. */
  docName?: string
}

/**
 * Compose the address for one citation.
 *
 * Percent-encoded per segment: a collection id is `kb_<domain>_<hex>` and safe,
 * but a document id is derived from a file name and the rule here must hold for
 * any id the store mints, including one the user named with a `#`.
 * @param ref - the citation to address.
 * @returns the address.
 */
export function citationAddress(ref: CitationRef): string {
  return `${CITATION_SCHEME}${encodeURIComponent(ref.collectionId)}/${encodeURIComponent(ref.docId)}#L${ref.line}`
}

/**
 * Parse a citation address.
 *
 * Returns `null` rather than throwing: `canOpen` runs on every routing decision
 * for every address the globs matched, so a malformed one has to be a cheap
 * "not mine" — an exception here would break routing for other plugins' tabs.
 * @param address - the address to parse.
 * @returns the reference, or `null` when this is not a well-formed citation.
 */
export function parseCitationAddress(address: string): CitationRef | null {
  if (!address.startsWith(CITATION_SCHEME)) return null
  const rest = address.slice(CITATION_SCHEME.length)
  const hashAt = rest.indexOf('#L')
  if (hashAt === -1) return null
  const path = rest.slice(0, hashAt)
  const line = Number(rest.slice(hashAt + 2))
  if (!Number.isInteger(line) || line < 1) return null
  const slashAt = path.indexOf('/')
  if (slashAt === -1) return null
  try {
    const collectionId = decodeURIComponent(path.slice(0, slashAt))
    const docId = decodeURIComponent(path.slice(slashAt + 1))
    if (collectionId === '' || docId === '') return null
    return { collectionId, docId, line }
  } catch {
    // A `%` sequence that is not valid percent-encoding: not one of our addresses.
    return null
  }
}

/**
 * The chip text for a citation tab.
 *
 * Deliberately the *document* name plus the line, not the whole path: the strip
 * is narrow, and the line is the part that distinguishes two citations of one
 * document — which is the only distinction a reader is making here.
 * @param address - the tab's address.
 * @returns the chip text.
 */
export function citationTitle(address: string): string {
  const ref = parseCitationAddress(address)
  if (ref === null) return '引用'
  return `${ref.docId}:${ref.line}`
}
