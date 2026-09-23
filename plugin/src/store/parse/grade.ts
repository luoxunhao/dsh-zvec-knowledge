/**
 * Whether a converted document kept the structure the chunker reads.
 *
 * The chunker scans for ATX headings, locates tables by their separator row and
 * flips a protected region on fenced code. A converter that flattens a document
 * into prose produces text that indexes fine and retrieves badly: every chunk
 * loses its section path. That is the failure this module makes measurable.
 *
 * **The judge must agree with the chunker, not merely admire the same syntax.**
 * Each rule below is a transcription of a rule `chunk.ts` actually applies, and
 * the differences are load-bearing:
 *
 * - `chunk.ts` ignores a heading inside a fence ("A heading inside a fenced block
 *   is code, not structure"), so a `#` in a code sample cannot be the heading
 *   that earns `structured` here either.
 * - `chunk.ts` protects a fenced region as a *closed pair*, so a lone delimiter
 *   protects nothing and is not evidence of surviving structure.
 * - `chunk.ts` locates a table by a separator row that has a genuine header row
 *   above it, so two separator rows in a row describe no table.
 *
 * A judge that only tested "does this text contain fence/table/heading syntax"
 * would say `structured` about documents the chunker turns into one flat section.
 * That is the over-credit this module was rewritten to remove, and the gate pins
 * each case.
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
const ATX = /^#{1,6} \S/
/** A table row with at least one cell boundary. */
const TABLE_ROW = /^\|.*\|\s*$/
/** The separator row that follows a table header, as `chunk.ts` requires. */
const TABLE_SEP = /^\|[\s:|-]+\|\s*$/
/** A fenced code block delimiter; `chunk.ts` toggles on a line starting with one. */
const FENCE = /^\s*(?:```|~~~)/
/**
 * A *closed* fenced block: an opening delimiter, then anything, then a closing
 * one. Deliberately does not match a lone opening delimiter, because an unclosed
 * fence protects nothing and is therefore not surviving structure.
 *
 * Unlike `protectCode` in `chunk.ts` — which has to consume the text before the
 * end and so needs its `|$` unclosed-at-EOF alternative — nothing here needs the
 * body, so the delimiters are matched without it.
 */
const FENCE_PAIR = /(?:^|\n)\s*(?:```|~~~)[\s\S]*?\n\s*(?:```|~~~)/

/**
 * Grade one converted document.
 *
 * **On CRLF.** A `\r` anywhere is reported as `flat-text` immediately, before any
 * structural test. This is a conservative *contract* about the bytes this plugin
 * produces, not a claim about current chunker behavior: `chunkDocument` calls
 * `normalizeNewlines` first, and the upload path stores text with the newlines
 * already normalized, so today's chunker survives CRLF (see `verify-upload.mjs`,
 * which asserts the stored text carries none). The contract exists because
 * `\r`-free output is cheap to guarantee and expensive to notice: the chunker's
 * heading, fence and paragraph rules are all line-ending-sensitive, so the one
 * safe reading of "there is a CR in here" is "do not claim structure survived".
 * @param text - the converted Markdown.
 * @returns the highest structure level the text actually supports.
 */
export function gradeMarkdown(text: string): StructureLevel {
  if (text.includes('\r')) return 'flat-text'

  const lines = text.split('\n')

  // Headings are counted outside fenced regions only, mirroring the chunker's
  // own scan: a `#` inside a code sample is not a section marker.
  const headings = countHeadingsOutsideFences(lines)
  if (headings === 0) return 'flat-text'

  const hasTable = hasSeparatorAfterHeader(lines)
  const hasFence = FENCE_PAIR.test(text)
  // A heading alone is not enough: an outline with no body structure still
  // retrieves as one heading plus flat prose.
  return hasTable || hasFence ? 'structured' : 'inferred'
}

/**
 * Count ATX heading lines that are not inside a fenced code block.
 *
 * Kept pairwise with the counting loop rather than as a standalone line filter so
 * the fence state cannot drift from the lines being counted — the same reason
 * `chunk.ts` toggles its flag in the same loop that reads headings.
 * @param lines - the document's lines, `\n`-separated.
 * @returns the number of heading lines outside every fence.
 */
function countHeadingsOutsideFences(lines: string[]): number {
  let inFence = false
  let count = 0
  for (const line of lines) {
    // The delimiter line toggles and is never itself a heading, matching the
    // chunker's ordering exactly: toggle first, then test the line.
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && ATX.test(line)) count += 1
  }
  return count
}

/**
 * Whether some table header row is immediately followed by its separator row.
 *
 * Checked pairwise rather than with a single multiline regex so a separator
 * anywhere in the document cannot vouch for a header it does not follow.
 *
 * Two further conditions come from `isTableSeparator` in `chunk.ts`, which
 * requires the separator to contain a `-` — so `| : | : |` cannot serve as one —
 * and are joined by the header rule the chunker gets for free from its
 * `isTableRow(headerLine)` check: a header must carry at least one character that
 * is not itself table punctuation. Without that, `| --- | --- |` followed by
 * `| --- | --- |` reads as a table whose header is the first separator.
 * @param lines - the document's lines, `\n`-separated.
 * @returns true when at least one header/separator pair exists.
 */
function hasSeparatorAfterHeader(lines: string[]): boolean {
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i] as string
    const next = lines[i + 1] as string
    if (TABLE_ROW.test(header) && isRealHeader(header) && TABLE_SEP.test(next) && next.includes('-')) {
      return true
    }
  }
  return false
}

/**
 * Whether a table row carries content, rather than only table punctuation.
 *
 * `| --- | --- |` and `| : | : |` are both well-formed rows and neither names a
 * column, so neither can be a header.
 * @param line - the candidate header row.
 * @returns true when the row holds at least one real character.
 */
function isRealHeader(line: string): boolean {
  return /[^\s|:—-]/.test(line)
}
