/**
 * PDF → Markdown.
 *
 * The engine gives positioned text runs and nothing else: `getTextContent()`
 * documents neither the order of `items` nor any heading semantics. So structure
 * has to be rebuilt here, in three ordered steps, and the *provenance* of that
 * structure has to be reported honestly rather than assumed:
 *
 * 1. **Line rebuilding** — group runs by the y component of their transform and
 *    sort by x. Flow order alone would interleave the columns of a two-column
 *    page.
 * 2. **Tagged structure first** — with `includeMarkedContent`, a tagged PDF
 *    carries its own H1..H6 / P / Table tags. When present they are the
 *    document's own claim, so they win.
 * 3. **Font-size clustering as fallback** — lines markedly larger than the body
 *    mode become headings. This is a guess, and every line it produces is
 *    reported as `inferred`, never as `structured`, so a reader is never told a
 *    guessed heading was the document's own.
 *
 * **Why the offset model exists.** Every pdf.js `TextItem` carries a transform
 * whose translation is in a bottom-left origin, so "the next line down" is a
 * *smaller* y. That is a detail of the engine, not of the document, and mixing
 * the two conventions is how a rebuild ends up emitting pages backwards. The
 * runs are translated once, at the boundary, into a top-left origin; everything
 * downstream reads y as "distance from the top", and one direction holds for
 * every engine.
 *
 * **Why the asset paths are still managed here.** This module resolves the
 * engine on its own rather than borrowing a helper, because `cMapUrl` and
 * `standardFontDataUrl` need forward-slash absolute paths with a trailing slash,
 * while a worker script would need a `file://` URL — one helper for all of them
 * would be wrong for one of them. The serverless engine bundled with the
 * extraction library has no separate worker, so the worker URL is not part of
 * this module's contract; the trap it exists to avoid is asserted instead by the
 * gate's Latin control, which fails loudly if extraction goes silent.
 *
 * @module dsh-zvec-knowledge/store/parse/pdf
 */

import { readFileSync } from 'node:fs'
import { capBytes } from './cap.ts'
import { gradeMarkdown, type StructureLevel } from './grade.ts'

/** Bounded resource envelope; values arrive from config, never hardcoded here. */
export interface ParseOptions {
  /** Wall-clock ceiling for one document. */
  timeoutMs: number
  /** Page ceiling, so a huge scan cannot monopolise the loop. */
  maxPages: number
  /** Ceiling on produced text bytes. */
  maxTextBytes: number
  /** Cancellation from the build pipeline. */
  signal?: AbortSignal
}

/** One converter's output. */
export interface ParseResult {
  /** The converted Markdown. */
  text: string
  /** How much structure survived; see `grade.ts`. */
  structure: StructureLevel
  /** Whether a ceiling truncated the output. */
  truncated: boolean
  /**
   * Whether this document's conversion failed.
   *
   * A field rather than a throw: the build's parse stage treats one document's
   * failure as data about that document, and an exception there would be caught
   * by the pipeline's outer guard and fail the whole build.
   */
  failed?: boolean
  /** Why conversion failed, in the user's language. Present iff `failed`. */
  error?: string
  /**
   * Whether the structure came from the document's own tag tree.
   *
   * Only PDF sets this. It exists so a gate can assert that an inferred
   * structure is never reported as the document's own claim: a guess that
   * presents itself as `structured` is worse than an honest `inferred`.
   */
  tagged?: boolean
}

/** One text run, already translated into a top-left origin. */
interface Run {
  /** The run's text, trailing whitespace removed. */
  text: string
  /** Left edge, in points from the page's left. */
  x: number
  /** Baseline, in points from the page's top. */
  y: number
  /** Run width in points. */
  width: number
  /** Font size in points. */
  size: number
  /** Marked-content tag in force for this run, when the document is tagged. */
  tag: string | null
  /**
   * Which page the run came from, 0-based.
   *
   * Carried on the run rather than re-derived from the coordinates, because it
   * cannot be re-derived: every page of a document uses the same coordinate
   * range, so runs from page 2 and page 3 are interleaved in y and no
   * threshold can separate them. Reconstructing page boundaries from y was a
   * real bug — it merged a whole book into one "page" and interleaved the text.
   */
  page: number
}

/** One rebuilt line: the runs sharing a baseline. */
interface Line {
  /** The runs, left to right. */
  runs: Run[]
  /** The baseline the runs share. */
  y: number
  /** The line's dominant font size, weighted by character count. */
  size: number
  /** Marked-content tag in force, when the document is tagged. */
  tag: string | null
  /** Page the line came from, 0-based. */
  page: number
}

/** How the engine's content stream describes itself. */
type MarkedItem = {
  /** `beginMarkedContent` / `beginMarkedContentProps` / `endMarkedContent`. */
  type: string
  /** The structure tag, e.g. `H1`, `P`, `Table`, when the document is tagged. */
  tag?: string | null
}

/** What one page's content stream yields, marked content left in place. */
type ContentItem = MarkedItem | {
  /** The run's text. */
  str: string
  /** `[a, b, c, d, e, f]`; `e` and `f` are the translation. */
  transform: number[]
  /** Run width in the text space. */
  width: number
  /** Run height in the text space. */
  height: number
}

/** The engine's per-page content, as much of it as this module reads. */
interface TextContent {
  /** Runs and marked-content markers, in the engine's own order. */
  items: ContentItem[]
}

/** The resolved engine surface, described structurally. */
interface EngineModule {
  /** `Util.transform` composes the page's transform with a run's. */
  Util: { transform: (m1: number[], m2: number[]) => number[] }
}

/** One page, as much of it as this module reads. */
interface EnginePage {
  /** Text content; `includeMarkedContent` keeps the tag tree in `items`. */
  getTextContent: (params?: { includeMarkedContent?: boolean }) => Promise<TextContent>
  /** The page's own transform, used to normalize run coordinates. */
  getViewport: (params: { scale: number }) => { transform: number[] }
  /** Releases the page's resources. */
  cleanup: () => void
}

/** A loaded document. */
interface EngineDocument {
  /** Page count. */
  numPages: number
  /** Fetch one page, 1-based. */
  getPage: (n: number) => Promise<EnginePage>
  /**
   * The load task, which is how the engine is actually torn down.
   *
   * There is no `destroy()` on the document proxy itself — calling one throws
   * `doc.destroy is not a function`, which the gate caught on its first run.
   * The load task owns the worker port, so it is the thing that has to be
   * released; leaving it open keeps a message port alive per document.
   */
  loadingTask: { destroy: () => Promise<void> }
}

/** The library's entry points that this module uses. */
interface UnpdfSurface {
  /** Loads a document with the Node asset defaults already applied. */
  getDocumentProxy: (data: Uint8Array) => Promise<EngineDocument>
  /** The resolved pdf.js module. */
  getResolvedPDFJS: () => Promise<EngineModule>
}

/**
 * Heading tags a tagged PDF may carry, mapped to their Markdown level.
 *
 * A tagged document states its own structure, so these are read rather than
 * guessed. `P` and `Table` are listed because they are equally authoritative:
 * knowing where a paragraph *begins* is what stops its first line being read as
 * a heading.
 */
const TAG_LEVELS: Record<string, number> = {
  H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6,
}

/** Tags that begin a block whose text is a table rather than prose. */
const TABLE_TAGS = new Set(['Table', 'TR', 'TD', 'TH', 'LTable', 'LTR', 'LTBody'])

/** Tags that name no structure and must be transparent to the rebuild. */
const TRANSPARENT_TAGS = new Set(['Span', 'Link', 'NonStruct', 'Artifact', 'P', 'Sect', 'Part', 'Div', 'Document', 'LBody', 'Code', 'Figure', 'Caption', 'Note', 'TOC', 'TOCI'])

/**
 * Whether a tag tells the rebuild something it could not have inferred.
 *
 * Only headings and table structure qualify. A document whose tag tree contains
 * nothing but inline and grouping tags has not stated its outline, so inferring
 * one from font sizes remains the better answer — and, measured, the only one
 * that produces any structure at all on the tagged documents seen so far.
 * @param tag - the structure tag.
 * @returns true when the tag names a heading or a table part.
 */
function isStructuralTag(tag: string): boolean {
  return TAG_LEVELS[tag] !== undefined || TABLE_TAGS.has(tag)
}

/**
 * Read one document's bytes for the engine.
 *
 * A fresh copy on every call, never a shared view: pdf.js transfers the buffer
 * to its worker, which **detaches** it. Reusing the same `Uint8Array` for a
 * second load produces `DataCloneError: Cannot transfer object of unsupported
 * type` from deep inside the engine — a message that names neither the buffer
 * nor the reuse, and that the gate caught as a total conversion failure. Since
 * the tagged probe and the untagged fallback both load the same file, one
 * buffer per load is the only safe arrangement.
 * @param file - path of the stored original.
 * @returns a detached-safe copy of the file's bytes.
 */
function readBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file))
}

/**
 * Convert one PDF into Markdown.
 *
 * Never throws for a document-level problem: a missing file, an encrypted
 * document, a timeout or a cancellation all come back as `failed` with an
 * `error` in the user's language, because the build pipeline treats one
 * document's failure as data about that document.
 *
 * **One load, one path.** The document is read through the engine's own API
 * once, which both carries the marked-content tags this module needs and lets
 * the page loop check the deadline and the abort signal. It is deliberately not
 * read twice — once through the tagged API and again through the untagged
 * helper — because that doubled the work on every document and made `maxPages`
 * mean two different things depending on which path ran.
 *
 * **On the page ceiling.** `maxPages` bounds the pages this module *reads*: the
 * loop stops at the cap, so nothing beyond it is parsed. What it cannot bound is
 * the engine's own per-page cost for the pages inside the cap, and `timeoutMs`
 * is the ceiling for that. Both are enforced in the loop, not reported after the
 * fact.
 * @param file - absolute or relative path of the stored original.
 * @param opts - the resource envelope, supplied by config.
 * @returns the converted Markdown and how much structure survived.
 */
export async function convertPdf(file: string, opts: ParseOptions): Promise<ParseResult> {
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  try {
    if (opts.signal?.aborted) return empty('已取消')

    const unpdf = await loadEngine()
    const read = await readRuns(unpdf, readBytes(file), opts, deadline)

    // Checked before rendering *and* after, because both can be the long pole:
    // extraction on a large document, and rendering on a text-heavy one. A
    // cancellation that arrives during either must not be reported as a
    // successful conversion of nothing — that is a silent empty success, the
    // worst available outcome, since the build would record the document as
    // parsed and index no text for it.
    if (opts.signal?.aborted) return empty('已取消')
    if (read.timedOut) return timeoutResult(opts, started)

    const tagged = read.runs.some(run => run.tag !== null && isStructuralTag(run.tag))
    const text = render(read.runs, tagged, opts)

    // An empty product with unreachable engine assets is a deployment defect,
    // not an empty document, and must not be reported as a clean conversion of
    // nothing: the two are indistinguishable downstream, and only one of them is
    // something the user can act on.
    if (text.trim() === '' && !checkAssets().ok) {
      return {
        text: '',
        structure: 'flat-text',
        truncated: false,
        failed: true,
        error: `PDF 未取到任何文本，且解析器的字体资源不可用（${checkAssets().detail}）。请将 pdfjs-dist 一并安装后重试。`,
      }
    }

    // **An empty product is a failure, not a clean conversion of nothing.**
    //
    // This is the single most dangerous outcome this module can produce: the build
    // records the document as parsed, indexes no text for it, and nothing anywhere
    // says why — indistinguishable from a document that legitimately had nothing to
    // index. Measured on the committed `scanned.pdf`, which is a page whose only
    // content is a drawn image: `convertPdf` returned `{text: '', failed: undefined}`
    // and the build marked it 已构建 with zero chunks.
    //
    // The upload preflight refuses a text-free PDF *before* a record is written, so
    // this path is not reachable through the upload UI for the scan case — but the
    // preflight samples at most two pages, and a document whose text begins later
    // than that reaches here. The envelope can also produce it directly: `maxPages:
    // 0`, or a page ceiling below the first page carrying text. Reporting those as
    // successes is the failure mode all of this exists to avoid.
    //
    // The reason is phrased in the user's language and names the likely cause,
    // because "no text" alone leaves them unable to tell a scan from a broken file.
    if (text.trim() === '') {
      return {
        text: '',
        structure: 'flat-text',
        truncated: read.runs.length === 0 && opts.maxPages > 0,
        failed: true,
        error: read.runs.length === 0
          ? `PDF 未提取到任何文字（读到的前 ${Math.min(opts.maxPages, 1)} 页中没有文本层）。`
            + '若这是扫描件，请先用离线 OCR 工具（例如 OCRmyPDF、ABBYY 或 Adobe Acrobat 的「识别文本」）'
            + '生成带文本层的 PDF，再上传；也可以先转成 Markdown 后上传。'
          : 'PDF 提取到了文字对象，但没有任何一行能构成正文。请确认文件未损坏，或改用 Markdown 上传。',
      }
    }

    if (opts.signal?.aborted) return empty('已取消')
    const overran = Date.now() > deadline
    if (overran) return timeoutResult(opts, started, text)

    return finish(text, opts, tagged, started)
  } catch (error) {
    if (isCancellation(error, opts)) return empty('已取消')
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: `PDF 解析失败：${message}`,
    }
  }
}

/**
 * The result for a document that exceeded its wall-clock ceiling.
 *
 * Reported as a failure with whatever text was produced, rather than as a
 * success: a truncated document indexed silently is a document whose content is
 * missing with nothing to point at why.
 * @param opts - the envelope, for the ceiling in the message.
 * @param started - when conversion began.
 * @param partial - text produced before the deadline, when there is any.
 * @returns the failed result.
 */
function timeoutResult(opts: ParseOptions, started: number, partial = ''): ParseResult {
  const { text, truncated } = capBytes(partial, opts.maxTextBytes)
  return {
    text,
    structure: truncated || text === '' ? 'flat-text' : gradeMarkdown(text),
    truncated: true,
    failed: true,
    error: `PDF 解析超时（上限 ${Math.round(opts.timeoutMs / 1000)} 秒，已用 ${Math.round((Date.now() - started) / 1000)} 秒）`,
  }
}

/**
 * Build the result from a rendered text.
 *
 * **On the grade of an inferred document.** `gradeMarkdown` answers "does this
 * text carry the structure the chunker reads", and a pipe table with a separator
 * row does — so a document whose table this module *guessed* from geometry comes
 * back `structured`. That answer is true about the text and false about its
 * provenance, and the brief's honesty requirement is about provenance: an
 * untagged PDF must never present a guess as the document's own claim. So an
 * inference is capped at `inferred` here. The cap costs nothing downstream —
 * `inferred` still means the chunker gets its headings and tables — and it is
 * the difference between reporting what the document said and reporting what
 * this module decided.
 *
 * A tagged document is not capped: its structure really is the document's own.
 * @param raw - the rendered Markdown, before the byte ceiling.
 * @param opts - the envelope.
 * @param tagged - whether the structure came from the tag tree.
 * @param started - when conversion began, for the timeout report.
 * @returns the finished result.
 */
function finish(raw: string, opts: ParseOptions, tagged: boolean, started: number): ParseResult {
  const { text, truncated } = capBytes(raw, opts.maxTextBytes)
  const graded = gradeMarkdown(text)
  // A guess is never the document's own claim: cap an inference at `inferred`.
  const structure: StructureLevel = !tagged && graded === 'structured' ? 'inferred' : graded
  if (Date.now() - started > opts.timeoutMs) {
    return {
      text,
      structure,
      truncated: true,
      failed: true,
      error: `PDF 解析超时（上限 ${Math.round(opts.timeoutMs / 1000)} 秒），已产出前 ${text.length} 个字符`,
    }
  }
  return { text, structure, truncated, tagged }
}

/**
 * An empty, honest result.
 * @param error - why nothing was produced.
 * @returns the result.
 */
function empty(error: string): ParseResult {
  return { text: '', structure: 'flat-text', truncated: false, failed: true, error }
}

/**
 * Whether the engine's auxiliary data is reachable, and where it is.
 *
 * **Why this probe exists.** In Node the engine resolves `cMapUrl` and
 * `standardFontDataUrl` from the installed `pdfjs-dist` package
 * (`import.meta.resolve("pdfjs-dist/package.json")`, then `./cmaps/` and
 * `./standard_fonts/`). Both are **devDependencies** here, so a production
 * install that omits them makes that resolution throw — and the engine swallows
 * it in a bare `catch {}`, then goes on to extract with no cmaps and no standard
 * fonts. A document needing either (a CID-keyed font whose CMap is not embedded,
 * or one of the fourteen standard fonts) then yields **empty or garbled text with
 * no error at all**: the same silent-empty shape as the worker-path trap, and
 * indistinguishable from a genuinely empty document.
 *
 * The gate's Latin control cannot catch it, because no committed fixture needs
 * either resource. So the failure is made loud here instead: the probe runs once
 * per process, logs an attributable line when the assets are missing, and the
 * result is carried on the conversion so a caller can tell the two apart.
 *
 * Measured on the four real Chinese PDFs: all four embed their fonts and need
 * neither resource, so this is a latent risk rather than an observed failure —
 * which is why it is reported rather than worked around, and why promoting
 * `pdfjs-dist` to a runtime dependency (33 MB) was not taken as the fix.
 */
let assetReport: { ok: boolean, detail: string } | null = null

/**
 * Resolve the engine's auxiliary data directory, once per process.
 * @returns whether the assets are reachable, and where they were found.
 */
function checkAssets(): { ok: boolean, detail: string } {
  if (assetReport !== null) return assetReport
  try {
    const base = import.meta.resolve('pdfjs-dist/package.json')
    assetReport = { ok: true, detail: new URL('./cmaps/', base).href }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    assetReport = { ok: false, detail: reason }
    // Loud and attributable, once, rather than silent and per-document: this is
    // a deployment defect, not a property of any one file.
    console.error(
      '[dsh-zvec-knowledge/pdf] 未能解析 pdfjs-dist 的 cmaps/standard_fonts 资源，' +
        'PDF 中依赖 CMap 或标准字体的文本可能产出空文本或乱码而无任何报错。' +
        `原因：${reason}。修复：将 pdfjs-dist 作为安装依赖一并安装。`,
    )
  }
  return assetReport
}

/**
 * Whether an error is a cancellation rather than a failure.
 * @param error - the thrown value.
 * @param opts - the envelope carrying the signal.
 * @returns true when the caller asked to stop.
 */
function isCancellation(error: unknown, opts: ParseOptions): boolean {
  if (opts.signal?.aborted) return true
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError'
}

/**
 * Load the extraction engine.
 *
 * Imported here rather than at module scope so the dependency is resolved only
 * when a PDF is actually converted: the host loads every store module at
 * startup, and a PDF engine that is not needed must not be on that path.
 * @returns the library surface.
 */
async function loadEngine(): Promise<UnpdfSurface> {
  return (await import('unpdf')) as unknown as UnpdfSurface
}

/**
 * Read runs together with the document's own tag tree.
 *
 * An untagged document yields runs whose `tag` is null, which is the signal to
 * infer structure from font sizes; a tagged one yields the document's own claim,
 * which is stronger than any guess this module could make.
 *
 * The deadline and the abort signal are both checked **per page**, so a
 * cancellation or an overrun stops the work rather than being noticed after it.
 * `getTextContent` for one page is not interruptible — the engine offers no hook
 * — so the finest granularity available is between pages, which is also where
 * the cost accumulates on a long document.
 * @param unpdf - the library surface.
 * @param bytes - the document's bytes; the engine detaches them, so the caller
 *   must not reuse this array afterwards.
 * @param opts - the envelope.
 * @param deadline - the wall-clock instant past which the document has failed.
 * @returns the runs, and whether the deadline stopped the read.
 */
async function readRuns(
  unpdf: UnpdfSurface,
  bytes: Uint8Array,
  opts: ParseOptions,
  deadline: number,
): Promise<{ runs: Run[], timedOut: boolean }> {
  const doc = await unpdf.getDocumentProxy(bytes)
  const pdfjs = await unpdf.getResolvedPDFJS()
  const runs: Run[] = []
  let timedOut = false
  try {
    const limit = Math.min(doc.numPages, Math.max(0, opts.maxPages))
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      if (opts.signal?.aborted) throw abortError()
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: true })
      runs.push(...translate(content.items, page, pdfjs, pageNumber - 1))
      page.cleanup()
    }
  } finally {
    await doc.loadingTask.destroy()
  }
  return { runs, timedOut }
}

/**
 * Normalize engine coordinates into a top-left origin.
 *
 * pdf.js reports each run's translation in the PDF's own bottom-left origin, so
 * a larger y is *higher* on the page — the reverse of reading order. Composing
 * the page's viewport transform is what converts it: a portrait page's viewport
 * is `[1, 0, 0, -1, 0, height]`, which negates y and offsets by the page height,
 * so the composed translation is already a distance from the page's top. Doing
 * it this way rather than negating by hand is also what keeps rotated and
 * non-zero-origin pages correct, since the flip is derived from the page itself
 * instead of assumed.
 * @param items - the content items, marked content included.
 * @param page - the page being read.
 * @param pdfjs - the resolved engine, for `Util.transform`.
 * @param pageIndex - the 0-based page number, carried onto every run.
 * @returns the text runs, tagged ones carrying their active tag.
 */
function translate(items: ContentItem[], page: EnginePage, pdfjs: EngineModule, pageIndex: number): Run[] {
  const pageTransform = page.getViewport({ scale: 1 }).transform
  const runs: Run[] = []
  const stack: string[] = []
  for (const item of items) {
    if (isMarked(item)) {
      if (item.type === 'endMarkedContent') stack.pop()
      else if (item.tag) stack.push(item.tag)
      continue
    }
    if (item.str === '') continue
    const composed = pdfjs.Util.transform(pageTransform, item.transform as number[])
    const x = composed[4] as number
    const y = composed[5] as number
    const size = Math.hypot(composed[2] as number, composed[3] as number) || item.height
    runs.push({
      text: item.str,
      x,
      y,
      width: item.width,
      size,
      tag: currentTag(stack),
      page: pageIndex,
    })
  }
  return runs
}

/**
 * Whether a content item is a marked-content marker rather than a text run.
 * @param item - the item.
 * @returns true when it carries no text.
 */
function isMarked(item: ContentItem): item is MarkedItem {
  return typeof (item as MarkedItem).type === 'string'
}

/**
 * The innermost structure tag that names a block.
 *
 * Inline tags (`Span`, `Link`) sit inside real structure and must not hide it,
 * so the stack is searched outward for the first block-level tag. `document` is
 * pushed by the engine as the root and names nothing.
 * @param stack - the open tag stack, outermost first.
 * @returns the innermost meaningful tag, or null.
 */
function currentTag(stack: string[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const tag = stack[i] as string
    if (tag === '' || tag === 'Document') continue
    return tag
  }
  return null
}

/**
 * Render runs into Markdown.
 *
 * Runs are grouped into lines by baseline, which is where the page's visual
 * structure is recovered: the engine's item order is not an order at all, so a
 * two-column page read in that order interleaves its columns.
 *
 * Two passes, because the heading rule needs the body size and the body size
 * needs the lines: the first pass builds the geometry, the second decides what
 * each line *is*. A single pass would have to guess a threshold before it had
 * seen the document.
 * @param runs - the positioned runs.
 * @param tagged - whether the runs carry the document's own tags.
 * @param opts - the envelope.
 * @returns the Markdown.
 */
function render(runs: Run[], tagged: boolean, opts: ParseOptions): string {
  const pages = groupPages(runs)
  const out: string[] = []
  for (const page of pages) {
    if (opts.signal?.aborted) break
    const lines = buildLines(page)
    if (lines.length === 0) continue
    const body = bodySize(lines)
    const text = tagged ? renderTagged(lines) : renderInferred(lines, body)
    if (text !== '') out.push(text)
  }
  return out.join('\n\n').replace(/\r\n?/g, '\n')
}

/**
 * Split runs into their pages.
 *
 * Grouped by the page index each run carries, not by coordinates. Every page of
 * a document occupies the same coordinate range, so runs from different pages
 * interleave in y and no threshold can separate them; deriving boundaries from y
 * merged a whole 316-page book into a single "page" and emitted its text
 * interleaved. The page index is the only reliable boundary, and it is recorded
 * at the point where the pages are actually visited.
 * @param runs - the runs, in engine order.
 * @returns one run list per page, in reading order within each.
 */
function groupPages(runs: Run[]): Run[][] {
  if (runs.length === 0) return []
  const byPage = new Map<number, Run[]>()
  for (const run of runs) {
    const bucket = byPage.get(run.page)
    if (bucket) bucket.push(run)
    else byPage.set(run.page, [run])
  }
  const pages: Run[][] = []
  for (const index of [...byPage.keys()].sort((a, b) => a - b)) {
    pages.push((byPage.get(index) as Run[]).sort((a, b) => a.y - b.y || a.x - b.x))
  }
  return pages
}

/**
 * Group runs into lines by shared baseline.
 *
 * The tolerance is half the smallest font size on the page, because a run's
 * baseline moves by a fraction of its own size when a line mixes fonts, and a
 * tolerance fixed in points would merge two closely-spaced lines of small text.
 * @param runs - one page's runs.
 * @returns the lines, top to bottom.
 */
function buildLines(runs: Run[]): Line[] {
  if (runs.length === 0) return []
  const sizes = runs.map(r => r.size).filter(s => s > 0)
  const smallest = sizes.length > 0 ? Math.min(...sizes) : 8
  const tolerance = Math.max(0.5, smallest / 2)
  const ordered = [...runs].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Line[] = []
  let bucket: Run[] = []
  let anchor = (ordered[0] as Run).y
  for (const run of ordered) {
    if (Math.abs(run.y - anchor) > tolerance && bucket.length > 0) {
      lines.push(makeLine(bucket))
      bucket = []
      anchor = run.y
    }
    bucket.push(run)
  }
  if (bucket.length > 0) lines.push(makeLine(bucket))
  return lines
}

/**
 * Freeze one bucket into a line.
 * @param bucket - the runs sharing a baseline.
 * @returns the line.
 */
function makeLine(bucket: Run[]): Line {
  const ordered = [...bucket].sort((a, b) => a.x - b.x)
  const y = ordered.reduce((sum, r) => sum + r.y, 0) / ordered.length
  let weight = 0
  let weighted = 0
  for (const run of ordered) {
    const length = run.text.trim().length
    weight += length
    weighted += run.size * length
  }
  const tag = ordered.find(r => r.tag !== null && !TRANSPARENT_TAGS.has(r.tag))?.tag ?? null
  return { runs: ordered, y, size: weight > 0 ? weighted / weight : (ordered[0] as Run).size, tag, page: (ordered[0] as Run).page }
}

/**
 * The document's body text size.
 *
 * The mode of the character-weighted size distribution, not the mean: a page
 * carries headings, captions, page numbers and table text, and the *most used*
 * size is the one prose is set in. The mean would be dragged upward by a large
 * title and report the body one step too big, which is exactly the error that
 * makes every body line look small enough to be a caption.
 * @param lines - the page's lines.
 * @returns the body size in points, or 0 when the page is empty.
 */
function bodySize(lines: Line[]): number {
  const histogram = new Map<number, number>()
  for (const line of lines) {
    const key = Math.round(line.size * 4) / 4
    histogram.set(key, (histogram.get(key) ?? 0) + line.runs.reduce((n, r) => n + r.text.trim().length, 0))
  }
  let best = 0
  let bestWeight = -1
  for (const [size, weight] of histogram) {
    if (weight > bestWeight) {
      best = size
      bestWeight = weight
    }
  }
  return best
}

/**
 * Render a page whose structure the document itself supplied.
 *
 * The tag tree is the document's own claim, so it is followed rather than
 * second-guessed: an `H2` becomes `##` even if its font size is unremarkable.
 * @param lines - the page's lines.
 * @returns the Markdown for the page.
 */
function renderTagged(lines: Line[]): string {
  const out: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push(paragraph.join(''))
    paragraph = []
  }
  for (const line of lines) {
    const level = line.tag ? TAG_LEVELS[line.tag] : undefined
    const isTable = line.tag !== null && TABLE_TAGS.has(line.tag)
    if (level !== undefined) {
      flush()
      out.push(`${'#'.repeat(level)} ${lineText(line)}`)
    } else if (isTable) {
      flush()
      out.push(formatTableRow(line))
    } else {
      paragraph.push(lineText(line))
    }
  }
  flush()
  return out.join('\n')
}

/**
 * Render a page by inference.
 *
 * Every heading this produces is a guess, which is why the caller reports the
 * whole document as `inferred` rather than `structured`.
 *
 * The heading rule is a ratio against the body size combined with a rank test,
 * not the ratio alone. Measured against the four real Chinese PDFs, the ratio
 * alone recovers nothing on three of them: one has no run at or above 1.2x the
 * body mode, another's most-used size is its *table* text so its headings sit
 * below it, and the third's body mode out-counts its heading size. What holds
 * across all four is the opposite ordering — headings are set at sizes that only
 * a few lines use — so a line is a heading when it is both larger than the body
 * AND among the largest few distinct sizes on its page.
 * @param lines - the page's lines.
 * @param body - the body text size.
 * @returns the Markdown for the page.
 */
function renderInferred(lines: Line[], body: number): string {
  const columns = splitColumns(lines)
  if (columns !== null) {
    // Each column is converted on its own, so a column's own heading inference
    // and paragraph joining are not disturbed by text from the neighbouring
    // column. Concatenating the columns in reading order is what "did not
    // interleave" means here: no output block mixes two columns' text.
    return columns.map(column => renderBlocks(column, body)).filter(t => t !== '').join('\n\n')
  }
  return renderBlocks(lines, body)
}

/**
 * Split a page into its columns, when it has more than one.
 *
 * A page layout and a table are the same shape locally — same runs per line,
 * same cell positions, same alignment across rows — so this cannot be decided by
 * looking at one line. Two properties separate them, and this requires both:
 *
 * - **The gutter is fixed.** A page's columns are set to a text measure, so the
 *   same boundary recurs on every line. A table's columns are only as wide as
 *   their longest cell, so its boundary drifts and repeatedly breaks.
 * - **The gutter is unique.** A page has one column boundary; a table with three
 *   or more columns has several, and they interleave in x with the cells rather
 *   than all falling past the same x.
 *
 * Requiring *all* multi-run lines to agree — not a majority — is what keeps a
 * table from being read as columns: measuring the real corpus, a two-column page
 * agrees on every line while a table breaks the same test within its first few
 * rows.
 *
 * Returns null when the page is not multi-column, so the caller reads the lines
 * in order.
 * @param lines - the page's lines.
 * @returns the columns in reading order, or null when the page is one column.
 */
function splitColumns(lines: Line[]): Line[][] | null {
  const multi = lines.filter(l => l.runs.filter(r => r.text.trim() !== '').length >= 2)
  if (multi.length < 2) return null

  // Candidate gutters: where a second cell could begin on each line, from either
  // a wide whitespace run or a plain positional gap.
  const tally = new Map<number, number>()
  for (const line of multi) {
    for (const boundary of new Set(stripBoundaries(line).map(x => Math.round(x)))) {
      tally.set(boundary, (tally.get(boundary) ?? 0) + 1)
    }
  }
  let gutter: number | null = null
  let best = 0
  for (const [x, n] of tally) {
    if (n > best) {
      best = n
      gutter = x
    }
  }
  // Every multi-run line must place a boundary at (nearly) the same x. A
  // tolerance of a few points absorbs the rounding of different producers.
  if (gutter === null) return null
  let agreeing = 0
  for (const line of multi) {
    if (stripBoundaries(line).some(x => Math.abs(x - gutter) <= 4)) agreeing++
  }
  if (agreeing < multi.length) return null

  // A table's cells are separated by *several* gutters; a two-column page by
  // one. More than one distinct recurring boundary means this is a grid, not a
  // layout, and the table path owns it.
  let recurring = 0
  for (const n of tally.values()) if (n >= multi.length) recurring++
  if (recurring > 1) return null

  const left: Line[] = []
  const right: Line[] = []
  for (const line of lines) {
    const runs = line.runs.filter(r => r.text.trim() !== '')
    if (runs.length === 0) continue
    const leftRuns = runs.filter(r => r.x + r.width / 2 < gutter)
    const rightRuns = runs.filter(r => r.x + r.width / 2 >= gutter)
    if (leftRuns.length > 0) left.push(withRuns(line, leftRuns))
    if (rightRuns.length > 0) right.push(withRuns(line, rightRuns))
  }
  if (left.length === 0 || right.length === 0) return null
  return [left, right]
}

/**
 * Copy a line with a subset of its runs.
 * @param line - the source line.
 * @param runs - the runs to keep.
 * @returns the narrowed line.
 */
function withRuns(line: Line, runs: Run[]): Line {
  return { ...line, runs }
}

/**
 * How wide a gap has to be before it separates two columns rather than two
 * words.
 *
 * The rule appears in four places — deriving cell anchors, splitting cells,
 * splitting columns and joining a line's text — and it has to be the *same* rule
 * in all of them, or the anchors a row is tested against are not the boundaries
 * it was split on. A word space is a fraction of the text size; the gutter that
 * positions a column is a large multiple of it, so the threshold scales with the
 * font rather than being a fixed number of points that would fail on small text.
 * @param size - the font size in points.
 * @returns the minimum separating width in points.
 */
function boundaryWidth(size: number): number {
  return Math.max(6, size)
}

/**
 * The x positions where a line's columns could begin.
 *
 * Both ways a producer separates columns are recognized, because the engine
 * reports them differently depending on how the document was written: a wide
 * whitespace run (the spacing is real text, as pdf-lib emits) or a plain gap
 * between two runs (the spacing is positional, as the two-column fixture emits).
 * Handling only one of them makes the page look single-column.
 * @param line - the line.
 * @returns the boundary positions, in x order.
 */
function stripBoundaries(line: Line): number[] {
  const out: number[] = []
  let previousEnd: number | null = null
  for (const run of line.runs) {
    if (run.text.trim() === '') {
      if (run.width > boundaryWidth(run.size)) out.push(run.x + run.width)
      previousEnd = run.x + run.width
      continue
    }
    if (previousEnd !== null && run.x - previousEnd > boundaryWidth(run.size)) out.push(run.x)
    previousEnd = run.x + run.width
  }
  return out
}

/**
 * Convert a run of lines into Markdown blocks.
 * @param lines - the lines, already narrowed to one column.
 * @param body - the body text size.
 * @returns the Markdown.
 */
function renderBlocks(lines: Line[], body: number): string {
  const sizes = [...new Set(lines.map(l => Math.round(l.size * 4) / 4))].sort((a, b) => b - a)
  const headingSizes = new Set(sizes.filter(s => s > body + 0.5).slice(0, 6))
  const out: string[] = []
  let paragraph: string[] = []
  let lastSize = -1
  let table: string[][] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push(paragraph.join(''))
    paragraph = []
  }
  const flushTable = (): void => {
    if (table.length === 0) return
    out.push(renderTable(table))
    table = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    const level = headingLevel(line, body, headingSizes)
    if (level !== null) {
      flushTable()
      flush()
      out.push(`${'#'.repeat(level)} ${lineText(line)}`)
      lastSize = body
      continue
    }
    const tableStart = detectTable(lines, i)
    if (tableStart !== null) {
      flush()
      table.push(...tableStart.rows)
      i += tableStart.consumed - 1
      lastSize = body
      continue
    }
    flushTable()
    // Two consecutive lines are joined into one paragraph only when they were
    // set at the same size: a size change is a block change, and joining across
    // it would splice a caption onto the prose it captions.
    if (lastSize >= 0 && Math.abs(line.size - lastSize) > 0.5) flush()
    paragraph.push(lineText(line))
    lastSize = line.size
  }
  flushTable()
  flush()
  return out.join('\n')
}

/**
 * The heading level for a line, or null when it is body text.
 * @param line - the line.
 * @param body - the body size.
 * @param headingSizes - sizes eligible to be headings on this page.
 * @returns a level 1..6, or null.
 */
function headingLevel(line: Line, body: number, headingSizes: Set<number>): number | null {
  if (body <= 0) return null
  const size = Math.round(line.size * 4) / 4
  if (!headingSizes.has(size)) return null
  // A heading is a short line. A large-size paragraph is a pull quote or a
  // display block, and promoting it would invent a section that does not exist.
  if (line.runs.reduce((n, r) => n + r.text.trim().length, 0) > 40) return null
  const ranked = [...headingSizes].sort((a, b) => b - a)
  const rank = ranked.indexOf(size)
  return Math.min(6, Math.max(1, rank + 1))
}

/**
 * Join one line's runs into readable text.
 *
 * Whether two adjacent runs need a space between them depends on the scripts
 * they use: Latin words must not be glued together, while Chinese glyphs are
 * already spaced by their own advance width and inserting a space would corrupt
 * every sentence. The gap between runs is the other signal — a wide gap is a
 * column boundary rather than a word boundary, so it becomes a separator the
 * table detector can see.
 * @param line - the line.
 * @returns the line's text.
 */
function lineText(line: Line): string {
  let text = ''
  let previousEnd: number | null = null
  let previousChar = ''
  for (const run of line.runs) {
    const piece = run.text.replace(/\s+/g, ' ').trim()
    if (piece === '') continue
    if (previousEnd !== null) {
      const gap = run.x - previousEnd
      const nextChar = piece[0] as string
      if (gap > boundaryWidth(run.size)) text += '\t'
      else if (needsSpace(previousChar, nextChar)) text += ' '
    }
    text += piece
    previousEnd = run.x + run.width
    previousChar = piece[piece.length - 1] as string
  }
  return text
}

/**
 * Whether two adjacent characters need a space between them.
 *
 * A space is inserted only at a boundary where neither side is CJK: Chinese
 * text has no word spaces, so adding one at every run boundary would break every
 * sentence in the document at an arbitrary point.
 * @param left - the character before the boundary.
 * @param right - the character after it.
 * @returns true when a space belongs there.
 */
function needsSpace(left: string, right: string): boolean {
  if (left === '' || right === '') return false
  if (isCjk(left) || isCjk(right)) return false
  if (/[\s(\[{]/.test(left) || /[\s)\]}.,;:!?、。，；：！？]/.test(right)) return false
  return true
}

/**
 * Whether a character is CJK, and so carries its own spacing.
 * @param ch - the character.
 * @returns true for Han and full-width punctuation.
 */
function isCjk(ch: string): boolean {
  return /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)
}

/**
 * Whether a line opens a table, and what the table's rows are.
 *
 * Three conditions, each earned by a failure it prevents:
 *
 * - **Cells align in x.** A table's columns are columns: every row's cells start
 *   at the same positions. A two-column page satisfies the count and content
 *   tests below — it is, after all, two columns of text — but its right-hand
 *   cells start wherever each line happens to end, so requiring alignment is
 *   what stops a column layout being rewritten as a table and its columns
 *   interleaved row by row. That was a real failure this gate caught.
 * - **Two or more columns with two or more content rows.** Measured against the
 *   real corpus, a run-count rule alone reads a table of contents and a block of
 *   code as tables, because dot leaders and alignment padding both look like
 *   cells.
 * - **A non-empty header.** `chunk.ts` identifies a table by a header row
 *   followed by a separator row, so a header with a blank cell would emit a
 *   column that names nothing.
 *
 * A one-row table cannot be represented at all, which is why two content rows
 * are required rather than merely prudent.
 * @param lines - the page's lines.
 * @param start - the index to test from.
 * @returns the rows and how many lines were consumed, or null.
 */
function detectTable(lines: Line[], start: number): { rows: string[][], consumed: number } | null {
  const head = lines[start] as Line
  const headCells = cellsOf(head)
  if (headCells === null || headCells.length < 2) return null
  if (!headCells.every(c => c !== '')) return null
  const anchors = cellAnchors(head)
  if (anchors === null) return null
  const rows: string[][] = [headCells]
  let i = start + 1
  while (i < lines.length && rows.length < 200) {
    const line = lines[i] as Line
    const cells = cellsOf(line)
    if (cells === null || cells.length !== headCells.length) break
    if (!alignedWith(line, anchors, head.size)) break
    rows.push(cells)
    i++
  }
  if (rows.length < 3) return null
  return { rows, consumed: i - start }
}

/**
 * Whether a line's cells start where the header's do.
 *
 * The tolerance is generous relative to the gap that created the boundary — a
 * cell is a whole word or phrase, so its start moves by at most a fraction of a
 * character width when the text inside it changes length. A two-column page
 * fails this decisively: its second band begins wherever the first ended, which
 * for prose of varying length is tens of points away.
 * @param line - the candidate row.
 * @param anchors - the header's cell start positions.
 * @param size - the font size, for the tolerance.
 * @returns true when every cell lines up.
 */
function alignedWith(line: Line, anchors: number[], size: number): boolean {
  const own = cellAnchors(line)
  if (own === null || own.length !== anchors.length) return false
  const tolerance = Math.max(3, size / 2)
  for (let i = 0; i < anchors.length; i++) {
    if (Math.abs((own[i] as number) - (anchors[i] as number)) > tolerance) return false
  }
  return true
}

/**
 * Split a line into table cells, when it is shaped like a table row.
 *
 * A cell boundary is a **wide whitespace run**, not a position gap. Measured on
 * a generated table, the engine reports the spacing between columns as a run of
 * its own — `{str: " ", x: 62, width: 118}`, ending exactly where the next cell
 * begins, so the gap between runs is *zero*. A rule that looked only at gaps saw
 * no boundaries at all and rendered every table as one tab-joined line.
 *
 * The width test is what separates columns from words: a space inside a sentence
 * is a couple of points wide, while the gutter that positions a column is a
 * large fraction of the text size. A plain gap is accepted too, because a
 * producer that positions cells without emitting the filler run would otherwise
 * be unreadable.
 * @param line - the line.
 * @returns the cells, or null when the line is not row-shaped.
 */
function cellsOf(line: Line): string[] | null {
  if (line.runs.length < 2) return null
  const cells: string[] = []
  let current = ''
  let previousEnd: number | null = null
  let boundaries = 0
  for (const run of line.runs) {
    const piece = run.text.replace(/\s+/g, ' ').trim()
    if (piece === '') {
      // Whitespace positions the next cell. Whether it is *wide* is the whole
      // question, so it is measured rather than ignored.
      if (current !== '' && run.width > boundaryWidth(run.size)) {
        cells.push(current.trim())
        current = ''
        boundaries++
      }
      previousEnd = run.x + run.width
      continue
    }
    if (previousEnd !== null && run.x - previousEnd > boundaryWidth(run.size) && current !== '') {
      cells.push(current.trim())
      current = ''
      boundaries++
    }
    current += current === '' ? piece : (needsSpace(current.slice(-1), piece[0] as string) ? ` ${piece}` : piece)
    previousEnd = run.x + run.width
  }
  if (current !== '') cells.push(current.trim())
  if (boundaries === 0) return null
  return cells
}

/**
 * The x position where each of a line's cells begins.
 *
 * Derived the same way {@link cellsOf} splits them, so a row can only be
 * accepted as aligned when it was split on the same boundaries its header was.
 * Computing the two independently is what allowed a two-column page to satisfy
 * the row test while its anchors came from somewhere else entirely.
 * @param line - the line.
 * @returns the anchors, in cell order, or null when the line is not row-shaped.
 */
function cellAnchors(line: Line): number[] | null {
  const anchors: number[] = []
  let previousEnd: number | null = null
  let started = false
  for (const run of line.runs) {
    const piece = run.text.trim()
    if (piece === '') {
      if (started && run.width > boundaryWidth(run.size)) started = false
      previousEnd = run.x + run.width
      continue
    }
    if (!started && (previousEnd === null || run.x - previousEnd >= 0)) {
      anchors.push(run.x)
      started = true
    }
    previousEnd = run.x + run.width
  }
  return anchors.length >= 2 ? anchors : null
}

/**
 * Render a cell grid as a Markdown pipe table.
 *
 * The separator row is not decoration: `chunk.ts` locates a table by it, so a
 * grid emitted without one renders as prose to the chunker and loses its column
 * names.
 * @param rows - the grid, header first.
 * @returns the table's Markdown.
 */
function renderTable(rows: string[][]): string {
  const width = Math.max(...rows.map(r => r.length))
  const padded = rows.map(r => [...r, ...Array(width - r.length).fill('')])
  const header = padded[0] as string[]
  const body = padded.slice(1)
  const lines = [
    `| ${header.map(escapeCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(r => `| ${r.map(escapeCell).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/**
 * Escape a cell so it cannot break the row it sits in.
 * @param cell - the raw cell text.
 * @returns the cell with pipes escaped.
 */
function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|')
}

/**
 * Render one line as a table row, for the tagged path.
 * @param line - the line.
 * @returns a pipe row.
 */
function formatTableRow(line: Line): string {
  const cells = cellsOf(line) ?? [lineText(line)]
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

/**
 * Build the error used to unwind a cancelled conversion.
 * @returns an AbortError-shaped error.
 */
function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
