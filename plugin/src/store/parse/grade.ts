/**
 * Whether a converted document kept the structure the chunker reads.
 *
 * The chunker scans for ATX headings, locates tables by their separator row and
 * flips a protected region on fenced code. A converter that flattens a document
 * into prose produces text that indexes fine and retrieves badly: every chunk
 * loses its section path. That is the failure this module makes measurable.
 *
 * Deliberately a pure function over text: the answer is a fact about the
 * produced bytes, not about which converter produced them, so it can be asserted
 * in a gate without a parser. That also means it can be broken on purpose and
 * watched going red — see step 6 of the task brief — which is the only reason to
 * believe it is measuring anything at all.
 *
 * @module dsh-zvec-knowledge/store/parse/grade
 */

/** How much document structure survived conversion. */
export type StructureLevel =
  /** Headings, tables and fences all survived. */
  | 'structured'
  /** Some structure was reconstructed by inference, not read from the source. */
  | 'inferred'
  /** No usable structure; heading-based chunking will degrade to one section. */
  | 'flat-text'

/** Matches an ATX heading line, the chunker's own section marker. */
const ATX = /(?:^|\n)#{1,6} \S/g
/** A table row with at least one cell boundary. */
const TABLE_ROW = /^\|.*\|\s*$/m
/** The separator row that follows a table header, as `chunk.ts` requires. */
const TABLE_SEP = /^\|[\s:|-]+\|\s*$/m
/** A fenced code block delimiter, three backticks or three tildes. */
const FENCE = /^(?:```|~~~)/m

/**
 * Grade one converted document.
 *
 * A CRLF line ending is reported as `flat-text` rather than thrown: it is a
 * real, already-recorded silent failure (`^(#{1,6})\s+(.*)$` never matches when
 * `$` sits before `\r`), and the honest answer is "structure not recovered".
 * @param text - the converted Markdown.
 * @returns the highest structure level the text actually supports.
 */
export function gradeMarkdown(text: string): StructureLevel {
  if (text.includes('\r')) return 'flat-text'

  const headings = text.match(ATX)?.length ?? 0
  if (headings === 0) return 'flat-text'

  const hasTable = TABLE_ROW.test(text) && hasSeparatorAfterHeader(text)
  const hasFence = FENCE.test(text)
  // A heading alone is not enough: an outline with no body structure still
  // retrieves as one heading plus flat prose.
  return hasTable || hasFence ? 'structured' : 'inferred'
}

/**
 * Whether some table row is immediately followed by its separator row.
 *
 * Checked pairwise rather than with a single multiline regex so a separator
 * anywhere in the document cannot vouch for a header it does not follow.
 * @param text - the converted Markdown.
 * @returns true when at least one header/separator pair exists.
 */
function hasSeparatorAfterHeader(text: string): boolean {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW.test(lines[i] as string) && TABLE_SEP.test(lines[i + 1] as string)) return true
  }
  return false
}
