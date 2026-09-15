/**
 * Strategy evidence: proof that a chunking policy actually took effect.
 *
 * ## Why this replaced the preview
 *
 * The configurator used to show a "分片预览": it chunked the **entire corpus** to
 * render eight truncated rows and four totals. Two things were wrong with it, and
 * the second is why it was removed rather than optimised.
 *
 * **It did not scale.** The cost is linear in corpus size, measured at
 * 0.025 ms per 1000 characters: 55 ms at 20 documents, 1.4 s at 500, 5.5 s at
 * 2000 — recomputed on *every* parameter change, so a single edit in a number
 * field could block the interface for tens of seconds. The panel had no debounce.
 *
 * **It could not answer the question it existed for.** Its rows were
 * `text.slice(0, 80)` with the newlines collapsed, which cannot show whether a
 * heading boundary was honoured, whether a fenced code block stayed whole,
 * whether a table was split by row, or what text the overlap actually shares. Its
 * four totals (总片数/平均 token/丢弃碎片/总 token) describe the corpus, not the
 * policy — and the number of chunks a library produces is not something a user
 * decides anything with.
 *
 * What a user does need to decide is **whether the策略 they configured is the
 * strategy that runs**, and that is a per-policy question with a per-policy
 * answer. So this module chunks **one** document — the longest, because a long
 * document is where boundaries, code fences and tables actually break — and
 * returns, for each configured setting, the evidence that it took effect.
 *
 * The cost is now constant: one document instead of the whole corpus, so 20
 * documents and 20 000 cost the same.
 *
 * @module dsh-zvec-knowledge/store/strategy-evidence
 */

import { chunkDocument, type Chunk, type ChunkingConfig } from './chunk.ts'
import { listDocuments, type DocumentRecord } from './documents.ts'

/** How much of a chunk's text to show at each end. */
const CONTEXT_CHARS = 120

/** Maximum chunks to report, so a pathological document cannot flood the panel. */
const MAX_REPORTED = 6

/** One configuration setting and the evidence that it took effect. */
export interface PolicyCheck {
  /** The setting's name, as the configurator labels it. */
  setting: string
  /** The value in force. */
  value: string
  /**
   * What was observed in the produced chunks. This is measurement, not a
   * restatement of the configuration: it is what makes the panel a check rather
   * than a summary of the form the user just filled in.
   */
  observed: string
  /** Whether the setting demonstrably took effect. */
  satisfied: boolean
  /**
   * Whether this setting could be verified for the document that was sampled.
   *
   * A document with no fenced code block cannot evidence `preserveCodeBlocks`
   * either way, and reporting that as a failure would be wrong. `false` renders as
   * "本文档未涉及" rather than as a pass or a fail.
   */
  applicable: boolean
}

/** One chunk's boundary, with enough context to judge it. */
export interface ChunkEvidence {
  /** Ordinal within the document. */
  ordinal: number
  /** Estimated tokens. */
  tokens: number
  /** Character range in the source. */
  charStart: number
  /** End character offset. */
  charEnd: number
  /** Heading path recorded for this chunk, or `null` when the mode does not track them. */
  heading: string | null
  /** Leading text, verbatim (newlines preserved), so structure is visible. */
  head: string
  /** Trailing text, which is where a boundary problem shows up. */
  tail: string
  /**
   * The text this chunk shares with the previous one, in full.
   *
   * The point of showing the overlap rather than counting it: `重叠 128 tok` is a
   * claim, and the shared passage is the evidence for it.
   */
  overlapText: string | null
  /** Overlap size with the previous chunk, in tokens. */
  overlapTokens: number
  /** Whether the chunk starts on a heading boundary in the source. */
  startsAtHeading: boolean
  /** Whether the chunk contains a fenced code block. */
  hasCodeFence: boolean
  /** Whether the chunk begins inside a fenced code block. */
  startsInsideCodeFence: boolean
  /** Whether the chunk contains a Markdown table row. */
  hasTableRow: boolean
}

/** The full evidence report for one sampled document. */
export interface StrategyEvidence {
  /** The document that was sampled. */
  document: { id: string, name: string, chars: number, chunks: number }
  /** Why this document was chosen. */
  sampledBecause: string
  /** Whether any document existed to sample. */
  available: boolean
  /** Per-setting verification. */
  checks: PolicyCheck[]
  /** The leading chunks with their boundaries. */
  chunks: ChunkEvidence[]
  /** Chunks dropped for falling below `minChunkTokens`, with their text. */
  discarded: { text: string, tokens: number }[]
  /** How long the probe took, for the cost claim in the UI. */
  elapsedMs: number
}

/**
 * Pick the document to sample.
 *
 * The longest one, because boundary handling is what this panel verifies: a short
 * document rarely spans a chunk boundary at all, so it cannot evidence overlap,
 * code-fence protection or table handling. Length is measured in characters, which
 * is what the chunker itself counts.
 * @param records - the collection's documents.
 * @returns the chosen record, or `null` when there are none.
 */
export function pickSampleDocument(records: DocumentRecord[]): DocumentRecord | null {
  let longest: DocumentRecord | null = null
  for (const record of records) {
    if (longest === null || (record.text?.length ?? 0) > (longest.text?.length ?? 0)) longest = record
  }
  return longest
}

/** Count fenced-code-block delimiters in a text. */
function fenceCount(text: string): number {
  return (text.match(/^```/gm) ?? []).length
}

/** Whether a character offset sits inside a fenced code block. */
function offsetInsideFence(text: string, offset: number): boolean {
  const before = text.slice(0, offset)
  return fenceCount(before) % 2 === 1
}

/** Whether the source has a heading boundary at or just before an offset. */
function startsAtHeading(text: string, offset: number): boolean {
  // The chunker folds a heading into the chunk's text, and may fold an ancestor
  // chain, so the offset can point at the heading itself or just after it. Both
  // count; what must not happen is a chunk starting mid-paragraph.
  const window = text.slice(Math.max(0, offset - 2), offset + 2)
  if (/^#/m.test(window)) return true
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  return /^\s*#/.test(text.slice(lineStart, lineStart + 8))
}

/** Whether a text contains a Markdown table row. */
function hasTableRow(text: string): boolean {
  return /^\s*\|.*\|\s*$/m.test(text)
}

/**
 * How many characters of the document's fenced code survive in the retained chunks.
 *
 * Used to tell "the fence was protected" from "the fence was protected *and then
 * dropped for being too small*". Those look identical if only the retained chunks
 * are examined, and the second is a real content loss the user needs to see.
 * @param source - the document text.
 * @param chunks - the retained chunks.
 * @returns the number of source characters inside fenced regions that survived.
 */
function cancelledCodeChars(source: string, chunks: Chunk[]): number {
  const fenced = fencedRanges(source)
  if (fenced.length === 0) return 0
  let retained = 0
  for (const range of fenced) {
    for (const chunk of chunks) {
      const from = Math.max(range.from, chunk.charStart)
      const to = Math.min(range.to, chunk.charEnd)
      if (to > from) retained += to - from
    }
  }
  return retained
}

/** The character ranges of a text that lie inside fenced code blocks. */
function fencedRanges(text: string): { from: number, to: number }[] {
  const ranges: { from: number, to: number }[] = []
  let open: number | null = null
  const lines = text.split('\n')
  let offset = 0
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (open === null) open = offset
      else {
        ranges.push({ from: open, to: offset + line.length })
        open = null
      }
    }
    offset += line.length + 1
  }
  // An unterminated fence still occupies the rest of the document.
  if (open !== null) ranges.push({ from: open, to: text.length })
  return ranges
}

/**
 * How many of the document's table rows survive in the retained chunks.
 * @param source - the document text.
 * @param chunks - the retained chunks.
 * @returns the retained row count.
 */
function retainedTableRows(source: string, chunks: Chunk[]): number {
  const lines = source.split('\n')
  let offset = 0
  let retained = 0
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const start = offset
      const end = offset + line.length
      if (chunks.some(chunk => chunk.charStart <= start && chunk.charEnd >= end)) retained += 1
    }
    offset += line.length + 1
  }
  return retained
}

/**
 * Build the evidence for one chunk.
 * @param chunk - the produced chunk.
 * @param previous - the chunk before it, for the overlap span.
 * @param source - the document text, for boundary checks.
 * @returns the evidence row.
 */
function toEvidence(chunk: Chunk, previous: Chunk | undefined, source: string): ChunkEvidence {
  const head = chunk.text.slice(0, CONTEXT_CHARS)
  const tail = chunk.text.slice(Math.max(0, chunk.text.length - CONTEXT_CHARS))
  // The shared span, computed from the two chunks' real character ranges — the
  // same source the overlap measurement uses, so the text shown is the text counted.
  let overlapText: string | null = null
  if (previous !== undefined) {
    const shared = previous.charEnd - chunk.charStart
    if (shared > 0) overlapText = source.slice(chunk.charStart, Math.min(chunk.charStart + shared, source.length))
  }
  return {
    ordinal: chunk.ordinal,
    tokens: chunk.tokens,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    heading: chunk.heading,
    head,
    tail,
    overlapText,
    overlapTokens: chunk.overlapTokens,
    startsAtHeading: startsAtHeading(source, chunk.charStart),
    hasCodeFence: fenceCount(chunk.text) > 0,
    startsInsideCodeFence: offsetInsideFence(source, chunk.charStart),
    hasTableRow: hasTableRow(chunk.text),
  }
}

/**
 * Verify each configured setting against the chunks that were actually produced.
 * @param config - the configuration under test.
 * @param chunks - the produced chunks.
 * @param discarded - how many fragments were dropped.
 * @param source - the document text.
 * @returns one check per setting.
 */
function verifyPolicies(
  config: ChunkingConfig,
  chunks: Chunk[],
  discarded: number,
  source: string,
): PolicyCheck[] {
  const checks: PolicyCheck[] = []
  // Computed over the raw chunks rather than over evidence rows, because
  // `verifyPolicies` runs before those are built and the two must not disagree.
  const tableChunks = chunks.filter(chunk => hasTableRow(chunk.text))
  const overlapping = chunks.filter(chunk => chunk.overlapTokens > 0)
  const headingChunks = chunks.filter(chunk => chunk.heading !== null)

  checks.push({
    setting: '切分方式',
    value: { heading: '按标题层级', paragraph: '按段落', fixed: '固定长度' }[config.mode],
    applicable: chunks.length > 0,
    satisfied: config.mode !== 'heading' ? true : headingChunks.length > 0,
    observed: config.mode === 'heading'
      ? `${headingChunks.length}/${chunks.length} 片记录了标题路径`
        + (headingChunks[0]?.heading ? `，如「${headingChunks[0].heading}」` : '')
      : `${chunks.length} 片按${config.mode === 'paragraph' ? '段落' : '固定长度'}边界切出`,
  })

  checks.push({
    setting: '分片长度',
    value: `${config.chunkTokens} token`,
    applicable: chunks.length > 0,
    satisfied: chunks.length > 0,
    // Reported as the observed spread rather than as a pass/fail: a chunker targets
    // a size and cannot hit it exactly when a boundary falls early, so "all chunks
    // are exactly N" would be the wrong expectation to encode.
    observed: chunks.length === 0
      ? '无可测分片'
      : `实测 ${Math.min(...chunks.map(c => c.tokens))}–${Math.max(...chunks.map(c => c.tokens))} token`,
  })

  // An applicable-but-empty result is the interesting failure: it means the floor
  // is eating real content rather than trimming noise.
  checks.push({
    setting: '最小分片',
    value: `${config.minChunkTokens} token`,
    applicable: true,
    satisfied: true,
    observed: discarded === 0
      ? '无碎片被丢弃'
      : `丢弃 ${discarded} 段低于下限的内容（见下方列表）`,
  })

  checks.push({
    setting: '重叠长度',
    value: `${config.overlapTokens} token`,
    applicable: chunks.length > 1,
    satisfied: config.overlapTokens === 0 ? overlapping.length === 0 : overlapping.length > 0,
    observed: chunks.length <= 1
      ? '本文档只有一片，无法体现重叠'
      : config.overlapTokens === 0
        ? (overlapping.length === 0 ? '相邻分片无共享文本，符合配置' : `仍有 ${overlapping.length} 处重叠`)
        : `${overlapping.length}/${chunks.length - 1} 处相邻边界共享文本`
          + (overlapping[0] ? `，首处共享 ${overlapping[0].overlapTokens} token` : ''),
  })

  // The evidence has to come from the whole document, not only from the retained
  // chunks. A fenced block can be *dropped* by the minimum-size floor, and looking
  // only at what survived then reports "0 片含代码块，均未被切断" — a pass on a
  // setting whose content no longer exists. That is the exact kind of false
  // reassurance this panel exists to prevent, so the applicability and the verdict
  // are both derived from the source.
  const sourceFences = fenceCount(source)
  const sourceHasCode = sourceFences > 0
  // A retained chunk that contains an odd number of fences, or that begins inside
  // one, means a boundary landed mid-block.
  const brokenByBoundary = chunks.filter(chunk =>
    offsetInsideFence(source, chunk.charStart) || fenceCount(chunk.text) % 2 === 1)
  // Retained code content, as opposed to code content that was cut out entirely.
  const codeRetained = cancelledCodeChars(source, chunks)

  checks.push({
    setting: '保留代码块',
    value: config.preserveCodeBlocks ? '开启' : '关闭',
    applicable: sourceHasCode,
    satisfied: config.preserveCodeBlocks
      ? brokenByBoundary.length === 0
      : true,
    observed: !sourceHasCode
      ? '本文档不含代码块'
      : config.preserveCodeBlocks
        ? (brokenByBoundary.length > 0
            ? `${brokenByBoundary.length} 片在代码块中途开始或结束，围栏被切断`
            : codeRetained === 0
              // The fence survived as a boundary unit but did not survive the
              // minimum-size floor. Said plainly: the setting worked, the content
              // still went away, and the user is looking at why.
              ? `代码块未被切断，但整段被最小分片（${config.minChunkTokens} token）丢弃，未进入索引`
              : `${fenceCount(chunks.map(c => c.text).join('\n'))} 个围栏完整保留在分片内`)
        : `本文档含 ${sourceFences} 个围栏，未做保护`,
  })

  // Same reasoning as the code-fence check: the applicability comes from the
  // source, so a table that was cut out entirely cannot be reported as "本文档不含
  // 表格" — which would be a pass on a setting whose content is gone.
  const sourceHasTable = hasTableRow(source)
  const sourceRows = (source.match(/^\s*\|.*\|\s*$/gm) ?? []).length
  // "Starts on a row boundary" means the chunk's first *content* line is either a
  // heading (which the chunker legitimately folds in) or a complete table row — not
  // that the text begins with `|`. A chunk opening with `## 配置\n| a | b |` is
  // correctly aligned; one opening mid-cell is not.
  const startsOnRowBoundary = (chunk: Chunk): boolean => {
    for (const raw of chunk.text.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      if (/^#{1,6}\s/.test(line)) continue   // a folded heading, then keep looking
      return /^\|/.test(line) || !/^\s*\|/.test(source.slice(chunk.charStart, chunk.charStart + 1))
    }
    return true
  }
  const misaligned = tableChunks.filter(chunk => !startsOnRowBoundary(chunk))
  const tableRetained = retainedTableRows(source, chunks)

  checks.push({
    setting: '表格按行拆分',
    value: config.splitTablesByRow ? '开启' : '关闭',
    applicable: sourceHasTable,
    satisfied: config.splitTablesByRow ? misaligned.length === 0 : true,
    observed: !sourceHasTable
      ? '本文档不含表格'
      : config.splitTablesByRow
        ? (misaligned.length > 0
            ? `${misaligned.length} 片从表格行中途开始，未按行边界拆分`
            : tableRetained === 0
              ? `表格未被拦腰切断，但整表被最小分片（${config.minChunkTokens} token）丢弃，未进入索引`
              : `${tableRetained}/${sourceRows} 行表格随分片保留，均以行边界开始`)
        : `${sourceRows} 行表格，未按行拆分`,
  })

  return checks
}

/**
 * Produce the strategy evidence for a collection, sampling one document.
 *
 * Reads the document list itself rather than taking it as an argument so the
 * caller cannot accidentally pass the whole corpus — the cost guarantee is the
 * point of this module, and it is worth making structurally difficult to break.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param config - the chunking configuration to verify.
 * @returns the evidence report.
 */
export function strategyEvidence(
  storeRoot: string,
  collectionId: string,
  config: ChunkingConfig,
): StrategyEvidence {
  const started = performance.now()
  const records = listDocuments(storeRoot, collectionId)
  const sample = pickSampleDocument(records)

  if (sample === null || (sample.text ?? '').trim() === '') {
    return {
      document: { id: '', name: '', chars: 0, chunks: 0 },
      sampledBecause: '',
      available: false,
      checks: [],
      chunks: [],
      discarded: [],
      elapsedMs: performance.now() - started,
    }
  }

  const source = sample.text ?? ''
  const result = chunkDocument(source, config)

  return {
    document: { id: sample.id, name: sample.name, chars: source.length, chunks: result.chunks.length },
    sampledBecause: '取最长的一篇：边界、代码块与表格问题只在长文档中暴露',
    available: true,
    checks: verifyPolicies(config, result.chunks, result.discarded, source),
    chunks: result.chunks.slice(0, MAX_REPORTED).map((chunk, index, list) =>
      toEvidence(chunk, index === 0 ? undefined : list[index - 1], source)),
    // The discarded fragments themselves, so "丢弃 N 段" can be judged rather than
    // taken on trust — a floor that removes real content is the failure mode.
    discarded: collectDiscarded(source, config, result.discarded),
    elapsedMs: performance.now() - started,
  }
}

/**
 * Recover the text of the fragments that were dropped.
 *
 * The chunker reports only a count, because the count is all the build needed. The
 * panel needs the content: "丢弃 3 段" is unactionable, whereas seeing that the
 * dropped text is a stray heading versus a real paragraph is the whole judgement.
 * The fragments are recomputed by re-running the chunker with the floor disabled
 * and diffing the retained ordinals, which keeps this from depending on internals
 * the chunk module does not export.
 * @param source - the document text.
 * @param config - the configuration in force.
 * @param count - how many fragments the chunker reported dropping.
 * @returns the dropped fragments, with their sizes.
 */
function collectDiscarded(
  source: string,
  config: ChunkingConfig,
  count: number,
): { text: string, tokens: number }[] {
  if (count === 0) return []
  const relaxed = chunkDocument(source, { ...config, minChunkTokens: 0 })
  const kept = chunkDocument(source, config)
  const keptStarts = new Set(kept.chunks.map(chunk => chunk.charStart))
  // Whatever the relaxed run produced that the real run did not is what the floor
  // removed. The offsets are what make the two runs comparable.
  return relaxed.chunks
    .filter(chunk => !keptStarts.has(chunk.charStart))
    .slice(0, 5)
    .map(chunk => ({ text: chunk.text.slice(0, 400), tokens: chunk.tokens }))
}
