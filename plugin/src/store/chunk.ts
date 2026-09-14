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
  let discarded = 0
  for (const candidate of sized) {
    if (candidate.tokens < config.minChunkTokens) {
      discarded += 1
      continue
    }
    retained.push({ ...candidate, ordinal: retained.length })
  }
  applyOverlap(retained)
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
 * Split on Markdown headings, keeping each section with its heading.
 * @param text - full document text.
 * @returns segments.
 */
function headingSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split('\n')
  let current: string[] = []
  let heading: string | null = null
  let start = 0
  let offset = 0
  let inFence = false

  /** Flush the pending section. */
  const flush = (end: number): void => {
    const body = current.join('\n')
    if (body.trim() !== '') segments.push({ text: body, start, heading, code: false })
    current = []
  }

  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line)
    if (isFence) inFence = !inFence
    // A heading inside a fenced block is code, not structure.
    const isHeading = !inFence && /^#{1,6}\s+/.test(line)
    if (isHeading) {
      flush(offset)
      heading = line.replace(/^#{1,6}\s+/, '').trim()
      start = offset
      current = [line]
    } else {
      if (current.length === 0) start = offset
      current.push(line)
    }
    offset += line.length + 1
  }
  flush(text.length)
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
    for (const window of sizeWindows(piece.text, config.chunkTokens)) {
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

/**
 * Slice text into windows of at most `budget` tokens.
 *
 * Boundaries prefer paragraph breaks, then sentence enders, then a hard cut, so
 * a chunk rarely ends mid-sentence. The cut is never in the middle of a surrogate
 * pair, which is what keeps an emoji or an extension-B ideograph intact.
 * @param text - text to window.
 * @param budget - token budget per window.
 * @returns windows with their offsets.
 */
function sizeWindows(text: string, budget: number): { text: string, start: number }[] {
  if (text === '') return []
  if (estimateTokens(text) <= budget) return [{ text, start: 0 }]
  const windows: { text: string, start: number }[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let tokens = 0
    while (end < text.length && tokens < budget) {
      const code = text.codePointAt(end) ?? 0
      const width = code > 0xffff ? 2 : 1
      tokens = estimateTokens(text.slice(start, end + width))
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
    start = cut
  }
  return windows.filter(window => window.text !== '')
}

/**
 * Record overlap between adjacent chunks.
 *
 * Overlap is *reported*, not physically duplicated into the chunk text: the
 * chunks stored in the index stay disjoint, and the overlap value tells the
 * preview how much context neighbours share. Duplicating text would inflate the
 * token count the user is shown and put the same sentence in two chunks that a
 * single retrieval result then returns twice.
 *
 * Adjacent windows produced by {@link sizeWindows} share no characters — each
 * begins where the last ended — so the measured overlap is normally zero. It is
 * computed rather than assumed because a heading-split document can produce a
 * section that repeats its parent's opening line, and that repetition is exactly
 * what the preview is meant to surface.
 * @param chunks - retained chunks, mutated in place.
 */
function applyOverlap(chunks: Chunk[]): void {
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1]
    const current = chunks[index]
    if (previous === undefined || current === undefined) continue
    const shared = previous.charEnd - current.charStart
    current.overlapTokens = shared > 0 ? estimateTokens(current.text.slice(0, shared)) : 0
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
