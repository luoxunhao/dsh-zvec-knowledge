/**
 * The byte ceiling every converter applies to its produced text.
 *
 * **Why this is its own module rather than a helper inside `pdf.ts`.** It was
 * inside `pdf.ts` first, and the HTML converter copied it verbatim — the two
 * bodies were identical character-for-character, binary search included. That is
 * the exact duplication this task's own design forbids: the HTML module's
 * docstring says "一份实现、一份测试" about the converters it shares, and the
 * report warns Task 5 not to re-implement failure logic rather than reuse it. The
 * same standard applies here, so the rule now has one home and both converters
 * import it.
 *
 * The duplication was not merely untidy — `maxTextBytes` is a *config* value, so
 * the rule is part of the resource envelope the pipeline enforces. Two copies
 * mean a change to the envelope can be made in one place and silently not the
 * other, which is how a per-document ceiling starts disagreeing with itself
 * between formats.
 *
 * @module dsh-zvec-knowledge/store/parse/cap
 */

/**
 * Apply a byte ceiling to a produced text.
 *
 * Truncation happens on a character boundary, because slicing a multi-byte
 * character in half produces a replacement character that would then be indexed
 * as content. The search is over *code units* against the real `Buffer`
 * byte length rather than a code-point estimate, because the quota is charged in
 * UTF-8 bytes and a surrogate pair is three or four of them — an estimate would
 * cut in the wrong place for exactly the text this plugin is most likely to see.
 *
 * `maxTextBytes <= 0` yields empty rather than unlimited: the ceiling arrives
 * from config, and a zero there is a ceiling of zero, not an absent one. The
 * `truncated` flag still reports whether anything was lost, so a
 * misconfiguration that zeroes the envelope is visible in the result rather than
 * looking like an empty document.
 * @param text - the produced text.
 * @param maxTextBytes - the ceiling from config.
 * @returns the possibly-truncated text and whether it was cut.
 */
export function capBytes(text: string, maxTextBytes: number): { text: string, truncated: boolean } {
  if (maxTextBytes <= 0) return { text: '', truncated: text !== '' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxTextBytes) return { text, truncated: false }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxTextBytes) lo = mid
    else hi = mid - 1
  }
  return { text: text.slice(0, lo), truncated: true }
}
