/**
 * Chunking: three strategies, token accounting, and the preview the spec demands.
 *
 * The spec is explicit that the preview is "提交前唯一的质量校验手段，不允许省略"
 * (the only quality check before submission, not to be omitted), so the chunker
 * produces the same summary the preview shows — one implementation, so the
 * preview cannot disagree with the build.
 *
 * Token counting is deliberately a documented approximation rather than a real
 * tokenizer. Pulling in a BPE vocabulary would tie the chunk boundaries to one
 * embedding model, and the spec's chunk sizes are policy values a user tunes by
 * eye against the preview, not exact budgets. CJK is counted per character and
 * Latin runs per ~4 characters, which matches how the two scripts actually
 * consume tokens; {@link estimateTokens} states the rule so the preview's
 * numbers are auditable rather than magic.
 *
 * @module dsh-zvec-knowledge/store/chunk
 */

/** Chunking strategy, mirroring the configurator's segmented control. */
export type ChunkingMode = 'heading' | 'paragraph' | 'fixed'

/** Chunking configuration (design spec §5.5, §10.1). */
export interface ChunkingConfig {
  /** How a document is split. */
  mode: ChunkingMode
  /** Target chunk size in tokens. */
  chunkTokens: number
  /** Overlap between adjacent chunks in tokens; must stay below `chunkTokens`. */
  overlapTokens: number
  /** Chunks below this size are dropped rather than indexed. */
  minChunkTokens: number
  /** Keep fenced code blocks intact rather than splitting them mid-block. */
  preserveCodeBlocks: boolean
  /** Split tables by row rather than keeping them whole. */
  splitTablesByRow: boolean
}

/** One produced chunk. */
export interface Chunk {
  /** Ordinal within the document, from 0. */
  ordinal: number
  /** Chunk text. */
  text: string
  /** Estimated token count. */
  tokens: number
  /** Start character offset in the source. */
  charStart: number
  /** End character offset (exclusive) in the source. */
  charEnd: number
  /** Overlap with the previous chunk, in tokens. */
  overlapTokens: number
  /** Section heading this chunk came from, when the mode tracks headings. */
  heading: string | null
}

/** Chunking outcome, carrying the preview summary. */
export interface ChunkingResult {
  /** Retained chunks, in document order. */
  chunks: Chunk[]
  /** Chunks dropped for falling below the minimum. */
  discarded: number
  /** Total estimated tokens across retained chunks. */
  totalTokens: number
  /** Mean tokens per retained chunk, rounded. */
  averageTokens: number
  /** Overlap tokens across retained adjacent pairs. */
  totalOverlapTokens: number
}

/**
 * Estimate the token count of a string.
 *
 * CJK characters (and CJK punctuation) are counted one per character, which is
 * the conservative end of what these tokenizers produce; every other run is
 * counted at four characters per token. Both are approximations, and the function
 * is named `estimate` so a caller does not treat the number as exact.
 * @param text - input text.
 * @returns estimated token count.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (isCjk(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * Whether a character is in a CJK range.
 * @param char - single character.
 * @returns true when the character is CJK.
 */
function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x3040 && code <= 0x30ff)   // kana
    || (code >= 0x3400 && code <= 0x4dbf)     // CJK ext A
    || (code >= 0x4e00 && code <= 0x9fff)     // CJK unified
    || (code >= 0xf900 && code <= 0xfaff)     // compatibility ideographs
    || (code >= 0xff00 && code <= 0xffef)     // full-width forms
    || (code >= 0x20000 && code <= 0x2ebef)   // ext B-F
}

/** A source segment before size-based splitting. */
interface Segment {
  text: string
  start: number
  heading: string | null
  /** A fenced code block, which the preserve switch protects. */
  code: boolean
}

/**
 * Split a document according to the configured strategy.
 *
 * Every mode produces segments first and then applies the same size/overlap pass,
 * so the three modes differ only in where boundaries are preferred. That is what
 * keeps the token accounting and the minimum-size rule identical across modes.
 * @param text - full document text.
 * @param config - chunking configuration.
 * @returns chunking result with its preview summary.
 */
export function chunkDocument(text: string, config: ChunkingConfig): ChunkingResult {
  const segments = config.mode === 'heading' ? headingSegments(text)
    : config.mode === 'paragraph' ? paragraphSegments(text)
      : fixedSegments(text)
  const sized = segments.flatMap(segment => splitSegment(segment, config))
  const retained: Chunk[] = []
  /**
   * Heading-only chunks awaiting a body to lead.
   *
   * Held rather than dropped because a heading names a real level of the document;
   * carrying it into the next body is what makes that level retrievable at all.
   */
  let pending: Omit<Chunk, 'ordinal'>[] = []
  /** Source offsets of the pending headings, so a merged chunk cites from the earliest. */
  const pendingStart: number[] = []
  let discarded = 0
  for (const candidate of sized) {
    if (candidate.tokens < config.minChunkTokens) {
      // A section whose whole text is its heading path is not noise to be dropped
      // — it is a real level of the outline, and a query naming it must be able to
      // match. Fold it into the next chunk that is large enough, where it reads as
      // the context line it is, instead of losing it. Anything else below the
      // minimum is genuinely too small to retrieve on and is counted as discarded.
      if (isHeadingOnly(candidate)) {
        pending.push(candidate)
        pendingStart.push(candidate.charStart)
        continue
      }
      discarded += 1
      continue
    }
    const prefix = pending.map(entry => entry.text.trim()).filter(part => part !== '')
    const earliest = pendingStart.length === 0 ? candidate.charStart : Math.min(...pendingStart)
    pending = []
    pendingStart.length = 0
    if (prefix.length === 0) {
      retained.push({ ...candidate, ordinal: retained.length })
      continue
    }
    // The carried headings lead the chunk so the section they name is stated
    // before the content that belongs to it.
    const carried = `${prefix.join('\n')}\n\n${candidate.text}`
    retained.push({
      ...candidate,
      text: carried,
      tokens: estimateTokens(carried),
      charStart: Math.min(candidate.charStart, earliest),
      ordinal: retained.length,
    })
  }
  // Headings left at the very end never found a body; they are still real, so
  // they are emitted rather than silently dropped — a document that ends on a
  // heading should still answer to that heading.
  for (const leftover of pending) {
    retained.push({ ...leftover, ordinal: retained.length })
  }  applyOverlap(retained)
  const totalTokens = retained.reduce((sum, chunk) => sum + chunk.tokens, 0)
  return {
    chunks: retained,
    discarded,
    totalTokens,
    averageTokens: retained.length === 0 ? 0 : Math.round(totalTokens / retained.length),
    totalOverlapTokens: retained.reduce((sum, chunk) => sum + chunk.overlapTokens, 0),
  }
}

/**
 * Whether a chunk's entire content is heading lines.
 *
 * Such a chunk is the outline entry for the section that follows, so it carries
 * structure rather than retrievable prose.
 * @param chunk - the candidate.
 * @returns whether every non-blank line is a heading.
 */
function isHeadingOnly(chunk: Omit<Chunk, 'ordinal'>): boolean {
  const lines = chunk.text.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.length > 0 && lines.every(line => /^#{1,6}\s+/.test(line))
}

/**
 * Split on Markdown headings, keeping each section with its heading path.
 *
 * Two properties this must hold, both of which the first version violated and
 * `verify-chunking` now locks:
 *
 * - **A parent section is never dropped.** The first version emitted a segment
 *   only if the section it had accumulated had a non-blank body, so a `##` that
 *   held nothing but `###` children vanished — and with it every query that
 *   names that section. A heading always opens a segment here, whether or not
 *   the document gives it body text.
 * - **A section knows its ancestors.** A section titled `安装` under `手册` is
 *   indexed as `手册 › 安装`, because a fragment carrying only its nearest
 *   heading states less than the document does, and the embedding has nothing
 *   else to recover the missing context from. A heading stack is what makes this
 *   fall out without a second pass over the text.
 * @param text - full document text.
 * @returns segments.
 */
function headingSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split('\n')

  /**
   * The open heading path, outermost first: level and title, so a shallower
   * heading can pop every deeper entry rather than needing a parallel count.
   */
  const stack: { level: number, title: string }[] = []
  /** The heading line that opened the current section, kept so its text survives. */
  let openHeading: string | null = null
  let current: string[] = []
  let start = 0
  let offset = 0
  let inFence = false

  /** The current heading path rendered for display, or `null` at the top level. */
  const pathOf = (): string | null =>
    stack.length === 0 ? null : stack.map(entry => entry.title).join(' › ')

  /** Flush the pending section, if it holds anything but its own heading line. */
  const flush = (): void => {
    const body = current.join('\n')
    const withoutHeading = openHeading === null ? body : body.replace(openHeading, '')
    // A section is emitted when it has content *or* a heading of its own. The
    // second half is the fix: a parent whose only text is its title is still a
    // real section of the document and must be retrievable by that title.
    if (body.trim() !== '' && (withoutHeading.trim() !== '' || openHeading !== null)) {
      segments.push({ text: body, start, heading: pathOf(), code: false })
    }
    current = []
  }

  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line)
    if (isFence) inFence = !inFence
    // A heading inside a fenced block is code, not structure.
    const match = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line)
    if (match !== null) {
      // The path is captured before the stack changes, so it describes the
      // section being closed rather than the one about to open.
      flush()
      const level = (match[1] as string).length
      const title = (match[2] as string).trim()
      // Pop every entry at this level or deeper: a `##` closes the previous `##`
      // and everything under it, which is what makes the path an outline.
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) stack.pop()
      stack.push({ level, title })
      openHeading = line
      start = offset
      current = [line]
    } else {
      if (current.length === 0) start = offset
      current.push(line)
    }
    offset += line.length + 1
  }
  flush()
  return segments
}

/**
 * Split on blank lines, treating each paragraph as a segment.
 * @param text - full document text.
 * @returns segments.
 */
function paragraphSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    if (value.trim() === '') continue
    segments.push({ text: value, start: match.index ?? 0, heading: null, code: false })
  }
  return segments
}

/**
 * Treat the document as one segment, split purely by size.
 * @param text - full document text.
 * @returns a single segment.
 */
function fixedSegments(text: string): Segment[] {
  if (text.trim() === '') return []
  return [{ text, start: 0, heading: null, code: false }]
}

/**
 * Apply the size budget to one segment.
 *
 * Code blocks are kept whole when the preserve switch is set, because splitting
 * a fenced block mid-way produces chunks that are syntactically meaningless to
 * an embedding model. A code block larger than the budget is still split, since
 * refusing would mean dropping it entirely — a worse outcome than a split block.
 * @param segment - source segment.
 * @param config - chunking configuration.
 * @returns chunks without overlap applied yet.
 */
function splitSegment(segment: Segment, config: ChunkingConfig): Omit<Chunk, 'ordinal'>[] {
  const pieces = config.preserveCodeBlocks ? protectCode(segment.text) : [{ text: segment.text, code: false }]
  const out: Omit<Chunk, 'ordinal'>[] = []
  let cursor = 0
  for (const piece of pieces) {
    const cursorStart = segment.start + cursor
    if (piece.code && estimateTokens(piece.text) <= config.chunkTokens) {
      out.push(makeChunk(piece.text, cursorStart, segment.heading))
      cursor += piece.text.length
      continue
    }
    // A fenced code block is never given overlap: repeating half a code block at
    // the head of the next chunk produces text that is not valid code in either
    // chunk, which is precisely what `preserveCodeBlocks` exists to avoid.
    const overlap = piece.code ? 0 : config.overlapTokens
    for (const window of sizeWindows(piece.text, config.chunkTokens, config.splitTablesByRow, overlap)) {
      out.push(makeChunk(window.text, cursorStart + window.start, segment.heading))
    }
    cursor += piece.text.length
  }
  return out
}

/**
 * Build a chunk record.
 * @param text - chunk text.
 * @param charStart - start offset in the source.
 * @param heading - originating heading, if any.
 * @returns the chunk without its ordinal.
 */
function makeChunk(text: string, charStart: number, heading: string | null): Omit<Chunk, 'ordinal'> {
  return {
    text,
    tokens: estimateTokens(text),
    charStart,
    charEnd: charStart + text.length,
    overlapTokens: 0,
    heading,
  }
}

/**
 * Separate fenced code blocks from prose so they can be protected.
 * @param text - segment text.
 * @returns ordered pieces, each flagged as code or prose.
 */
function protectCode(text: string): { text: string, code: boolean }[] {
  const pieces: { text: string, code: boolean }[] = []
  const pattern = /(^|\n)(```[^\n]*\n[\s\S]*?(?:\n```|$)|~~~[^\n]*\n[\s\S]*?(?:\n~~~|$))/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (index > last) pieces.push({ text: text.slice(last, index), code: false })
    pieces.push({ text: match[2] as string, code: true })
    last = index + (match[2] as string).length
  }
  if (last < text.length) pieces.push({ text: text.slice(last), code: false })
  return pieces.filter(piece => piece.text !== '')
}

/** Whether a line is a Markdown table row. */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** Whether a line is the `| --- | --- |` separator under a table's header. */
function isTableSeparator(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')
}

/**
 * Slice text into windows of at most `budget` tokens.
 *
 * Boundaries prefer paragraph breaks, then sentence enders, then a hard cut, so
 * a chunk rarely ends mid-sentence. The cut is never in the middle of a surrogate
 * pair, which is what keeps an emoji or an extension-B ideograph intact.
 *
 * **Tables are handled separately when `repeatTableHeaders` is set.** A generic
 * character window cuts wherever the budget runs out, which inside a table means
 * mid-row — and the continuation then begins with cells whose column names are in
 * the previous chunk. So a table is split on *row* boundaries and every window
 * after the first is prefixed with the header and separator rows. The repeated
 * header is deliberately included in that window's token count, because it is
 * genuinely part of what gets embedded.
 * @param text - text to window.
 * @param budget - token budget per window.
 * @param repeatTableHeaders - whether to split tables on rows and repeat their header.
 * @param overlapTokens - tokens of context each window shares with its predecessor.
 * @returns windows with their offsets.
 */
function sizeWindows(
  text: string,
  budget: number,
  repeatTableHeaders = false,
  overlapTokens = 0,
): { text: string, start: number }[] {
  if (text === '') return []
  if (estimateTokens(text) <= budget) return [{ text, start: 0 }]
  if (repeatTableHeaders) {
    const tableWindows = tableWindowsOf(text, budget)
    if (tableWindows !== null) return tableWindows
  }
  const windows: { text: string, start: number }[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let tokens = 0
    // Counted incrementally rather than by re-measuring `text.slice(start, end)`
    // at every step. The slice form is O(window²) in both scanning and allocation,
    // and on a 167 KB chapter that measured at ~10 s per pass — which the build
    // configurator paid twice on every page open, because it previews and then
    // estimates. `estimateTokens` here is exactly the per-character accounting it
    // performs (`cjk` adds one, others add a quarter), so the numbers are
    // unchanged; only the cost is.
    let cjk = 0
    let other = 0
    while (end < text.length) {
      const code = text.codePointAt(end) ?? 0
      const width = code > 0xffff ? 2 : 1
      const next = text.slice(end, end + width)
      if (next === '') break
      if (isCjk(next)) cjk += 1
      else other += 1
      tokens = cjk + Math.ceil(other / 4)
      if (tokens > budget) break
      end += width
    }
    if (end === start) end = Math.min(text.length, start + 1)
    let cut = end
    if (end < text.length) {
      const window = text.slice(start, end)
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('.'))
      if (boundary > window.length / 2) cut = start + boundary + 1
    }
    windows.push({ text: text.slice(start, cut), start })

    // A window that reached the end of the text is the last one: there is nothing
    // left to cover, and stepping back for an overlap would only re-emit the tail
    // already emitted. Without this the loop would crawl forward one character at
    // a time while `cut` stayed pinned at the end, each iteration producing a
    // near-duplicate chunk — measured at 1551 chunks for a 21-chunk document.
    if (cut >= text.length) break

    // The next window starts `overlapTokens` before this one ended, which is what
    // makes an answer straddling the boundary retrievable whole from either side.
    //
    // The `start + 1` floor is what makes the loop terminate: a cut that landed at
    // or before the current start would otherwise re-emit the same window forever.
    // It is a floor rather than the usual path, because `cut` is normally well
    // past `start`.
    const steppingBack = overlapTokens > 0 ? overlapChars(text, cut, overlapTokens) : 0
    start = Math.max(cut - steppingBack, start + 1)
  }
  return windows.filter(window => window.text !== '')
}

/**
 * Convert a token overlap into a character distance back from a cut point.
 *
 * Walks backwards with the same per-character accounting {@link estimateTokens}
 * uses, so the overlap a user configures in tokens means the same thing here as
 * it does everywhere else in the configurator. Returns a distance in characters,
 * never more than the text available before `cut`.
 * @param text - the text being windowed.
 * @param cut - the offset the overlap is measured back from.
 * @param overlapTokens - tokens of overlap requested.
 * @returns characters to step back.
 */
function overlapChars(text: string, cut: number, overlapTokens: number): number {
  let cjk = 0
  let other = 0
  let back = 0
  while (back < cut) {
    const code = text.codePointAt(cut - back - 1) ?? 0
    // A surrogate pair is two code units; stepping one would split it.
    const width = code >= 0xdc00 && code <= 0xdfff && cut - back - 2 >= 0 ? 2 : 1
    const char = text.slice(cut - back - width, cut - back)
    if (isCjk(char)) cjk += 1
    else other += 1
    back += width
    if (cjk + Math.ceil(other / 4) >= overlapTokens) break
  }
  return back
}

/**
 * Window a text whose oversized part is a table, on row boundaries.
 *
 * Returns `null` when the text does not need table treatment, so the caller can
 * fall back to the generic character window. Prose around the table is emitted as
 * its own windows, so a segment that is "paragraph + big table" keeps both.
 * @param text - text to window.
 * @param budget - token budget per window.
 * @returns windows, or `null` when this text has no splittable table.
 */
function tableWindowsOf(text: string, budget: number): { text: string, start: number }[] | null {
  const lines = text.split('\n')
  const offsets: number[] = []
  let running = 0
  for (const line of lines) {
    offsets.push(running)
    running += line.length + 1
  }

  // Locate every table by its separator row, so an oversized table is found even
  // when it is not the first thing in the segment.
  const tables: { from: number, to: number, header: string[] }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableSeparator(lines[index] as string)) continue
    const headerLine = index - 1
    if (headerLine < 0 || !isTableRow(lines[headerLine] as string)) continue
    let end = index + 1
    while (end < lines.length && isTableRow(lines[end] as string)) end += 1
    tables.push({ from: headerLine, to: end, header: [lines[headerLine] as string, lines[index] as string] })
    index = end - 1
  }
  const oversized = tables.filter(table =>
    estimateTokens(lines.slice(table.from, table.to).join('\n')) > budget)
  if (oversized.length === 0) return null

  const windows: { text: string, start: number }[] = []
  let cursor = 0

  /** Emit the non-table run `lines[cursor, until)` through the generic windower. */
  const emitProse = (until: number): void => {
    if (until <= cursor) return
    const body = lines.slice(cursor, until).join('\n')
    const from = offsets[cursor] as number
    for (const window of sizeWindows(body, budget)) {
      windows.push({ text: window.text, start: from + window.start })
    }
  }

  for (const table of oversized) {
    emitProse(table.from)
    const prefix = table.header.join('\n')
    const firstRow = table.from + table.header.length
    let rowStart = firstRow
    while (rowStart < table.to) {
      // Every window repeats the header, including the first: the header lines are
      // part of `lines[table.from, firstRow)` and are therefore not in `rows`, so
      // building each window the same way is what keeps them identical in shape.
      let rowEnd = rowStart
      // The header is measured once and each row's own token count added, rather
      // than re-joining and re-measuring the growing block per row — the same
      // quadratic shape the generic windower had. A table long enough to matter
      // (hundreds of rows) is exactly the case this path exists for.
      const prefixTokens = estimateTokens(prefix)
      let blockTokens = prefixTokens
      while (rowEnd < table.to) {
        const row = lines[rowEnd] as string
        const candidate = blockTokens + estimateTokens(`\n${row}`)
        // Always take at least one row, even when a single row exceeds the budget:
        // dropping it would lose data, and a one-row window with its header is
        // still a truthful answer to "what is this cell".
        if (rowEnd > rowStart && candidate > budget) break
        blockTokens = candidate
        rowEnd += 1
        if (blockTokens > budget) break
      }
      const rows = lines.slice(rowStart, rowEnd)
      // A continuation's text is prefixed for readability, but its offset still
      // points at the first genuine row, so citation ranges stay in the source.
      windows.push({ text: `${prefix}\n${rows.join('\n')}`, start: offsets[rowStart] as number })
      rowStart = rowEnd
    }
    cursor = table.to
  }
  emitProse(lines.length)

  return windows.filter(window => window.text.trim() !== '')
}

/**
 * Measure the overlap between adjacent chunks.
 *
 * Overlap is produced by {@link sizeWindows}, which starts each window
 * `overlapTokens` before the previous one ended; this function *measures* what
 * that produced rather than being the thing that implements it. It has to be a
 * measurement because the overlap a user configures is a target and the achieved
 * overlap depends on where the boundary rules actually put each cut.
 *
 * The text is genuinely shared, so a sentence spanning a boundary is retrievable
 * whole from at least one of the two chunks. That is the entire purpose of the
 * setting, and an earlier revision in which this function was the only
 * implementation made the configured value do nothing at all: adjacent windows
 * shared zero characters in all twelve mode/parameter combinations measured, and
 * across 176 boundaries in four real documents 88 sentences were cut and 100% of
 * them were unrecoverable from any single chunk.
 *
 * The shared span is computed from the two chunks' character ranges, which is
 * what makes it robust to a heading being folded into a chunk's text.
 * @param chunks - retained chunks, mutated in place.
 */
function applyOverlap(chunks: Chunk[]): void {
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1]
    const current = chunks[index]
    if (previous === undefined || current === undefined) continue
    // `charStart` can precede the previous chunk's end only when the two really
    // do share text; the check is on the offsets rather than on the text so a
    // coincidence of repeated wording is not mistaken for an overlap.
    const shared = previous.charEnd - current.charStart
    current.overlapTokens = shared > 0
      ? estimateTokens(current.text.slice(0, Math.min(shared, current.text.length)))
      : 0
  }
}

/**
 * Produce the preview rows the configurator shows before submission.
 *
 * Returns the leading chunks rather than all of them, because the preview exists
 * to be read before committing to a long build.
 * @param text - document text.
 * @param config - chunking configuration.
 * @param limit - maximum preview rows.
 * @returns preview rows and the full summary.
 */
export function previewChunks(
  text: string,
  config: ChunkingConfig,
  limit = 5,
): { rows: Chunk[], summary: ChunkingResult } {
  const summary = chunkDocument(text, config)
  return { rows: summary.chunks.slice(0, limit), summary }
}
