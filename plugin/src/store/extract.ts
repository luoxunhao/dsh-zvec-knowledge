/**
 * Turning a stored original into the text the chunker indexes.
 *
 * The plugin's data source is Markdown, and that is a deliberate boundary rather
 * than a limitation: the chunker is Markdown-aware (it reads heading levels and
 * table headers), so a converter that flattens a document into unstructured prose
 * would silently defeat it. Where a format needs converting, the conversion is
 * this plugin's own job — the built-in converters named in {@link ConverterId} run
 * in the build pipeline's `parse` stage — and this module is where a format's
 * bytes are classified before that ever happens.
 *
 * **Why extraction is separate from storage.** The original is kept byte-for-byte
 * and the text is derived from it. Keeping them apart is what makes the derived
 * text recomputable: when a converter improves, every existing document can be
 * reprocessed from its stored original instead of being re-uploaded.
 *
 * **Why the refusals are specific.** A format the list advertises but this module
 * cannot convert must be refused *at upload*, naming the remedy. The alternative
 * is the worst failure mode available: the upload succeeds, the build produces
 * nothing, and the user has no way to tell a scanned document from a broken one.
 *
 * **What is left in `needs-conversion`.** After the built-in converters took over
 * `pdf` / `docx` / `html` / `htm` / `xlsx` / `csv` / `json`, this kind holds only
 * entries this plugin genuinely cannot solve: a format it recognizes, lists and
 * refuses on purpose, where the user has real work to do and no in-process route
 * exists. **There are none today**, and that is a deliberate end state rather
 * than an oversight — {@link ACCEPTED_EXTENSIONS} advertises exactly the formats
 * this module either decodes or converts, and the gate asserts the list and this
 * table's keys agree. Formats named as candidates in the design work (`.doc`,
 * `.epub`, `.rtf`, `.pptx`) are deliberately *not* advertised: they reach the
 * upload path as `unsupported`.
 *
 * The distinction the kind carries is kept sharp for when such an entry arrives,
 * because the remedy is the user's only guidance and the two cases must not read
 * alike:
 *
 * - `unsupported` — "this plugin does not do that". No remedy is possible, since
 *   there is nothing to tell the user to do. Unknown extensions land here.
 * - `needs-conversion` — "you must do X first". The entry **must** carry a
 *   `remedy`, and the gate fails if one does not: an entry that is advertised,
 *   recognized, and then refused without saying what to bring instead is the
 *   worst of both, because the format is on the accepted list, so the user has
 *   every reason to expect it to work.
 *
 * @module dsh-zvec-knowledge/store/extract
 */

import { readFileSync } from 'node:fs'
import { extensionOf } from './documents.ts'

/** How a format is turned into indexable text. */
export type ExtractionKind =
  /** The bytes already are the text; decode and store verbatim. */
  | 'verbatim'
  /** Recognised, and a built-in converter runs at build time. */
  | 'converted'
  /** Recognised, but no converter is wired: refuse with a remedy. */
  | 'needs-conversion'
  /** Not a text format at all. */
  | 'unsupported'

/**
 * Which built-in converter handles a format.
 *
 * The union is the dispatch key the build pipeline uses, so it names a converter
 * rather than a format: `html` serves both `.html` and `.htm`, and adding a
 * format that an existing converter already handles must not add a second id for
 * the same code.
 */
export type ConverterId = 'pdf' | 'docx' | 'html' | 'xlsx' | 'csv' | 'json'

/** What this module can do with one extension. */
export interface ExtractionSupport {
  /** Which handling applies. */
  kind: ExtractionKind
  /** Which converter runs when `kind` is 'converted'. */
  converter?: ConverterId
  /**
   * A cheap upload-time probe that can refuse before a record is written.
   *
   * Deliberately not a parse: this must stay affordable on the request path, so
   * it only answers "is there any text to extract / can this be opened at all".
   * The expensive conversion belongs to the build pipeline.
   * @param file - absolute path of the just-written original.
   */
  preflight?: (file: string) => Promise<{ ok: true } | { ok: false, remedy: string }>
  /** The converter or remedy to name when `kind` is neither verbatim nor converted. */
  remedy?: string
}

/**
 * Formats the plugin advertises, and what it does with each.
 *
 * `md` / `markdown` / `txt` are verbatim: Markdown is the target format and plain
 * text is already at the right level of structure for the paragraph strategy.
 * The office, markup and tabular formats declare the converter that will handle
 * them, which is what the upload path records on the document as `converter` and
 * what the build pipeline dispatches on.
 *
 * Only `pdf` carries a `preflight`, and the reason is that it is the only format
 * whose *bytes* can promise text and deliver none. An empty `.docx`, a `.csv`
 * with no rows, a JSON document of `null`: all are decidable, or at least honest,
 * from the content itself. A scan is not — it is a well-formed PDF of the right
 * size that opens and renders, and no converter in this plugin can read a word of
 * it. That gap is what the probe closes at upload instead of leaving to the user
 * to discover after a build.
 */
const SUPPORT: Record<string, ExtractionSupport> = {
  md: { kind: 'verbatim' },
  markdown: { kind: 'verbatim' },
  txt: { kind: 'verbatim' },
  pdf: { kind: 'converted', converter: 'pdf', preflight: pdfPreflight },
  docx: { kind: 'converted', converter: 'docx' },
  html: { kind: 'converted', converter: 'html' },
  htm: { kind: 'converted', converter: 'html' },
  xlsx: { kind: 'converted', converter: 'xlsx' },
  csv: { kind: 'converted', converter: 'csv' },
  json: { kind: 'converted', converter: 'json' },
}

/**
 * How many leading pages the preflight may read before concluding "scan".
 *
 * A scan is text-free from page one to the last page, so a single page would be
 * enough to *recognize* one — but one page is not enough to **clear** a document.
 * Measured over eighteen real PDFs on this machine, two (11%) open with a
 * text-free cover page and carry their text from page two: `go-test.pdf` (76
 * pages, page 1 empty, 29 of its first 30 pages carrying text) and `gotips.pdf`
 * (253 pages, page 1 empty, 50,038 characters once converted). A page-one probe
 * refuses both, and the remedy it gives — "run OCR on it" — is wrong advice about
 * a document with a perfectly good text layer.
 *
 * The direction of the error that remains is deliberate. This bound stops at the
 * first page carrying text, so a normal document pays for exactly one page and a
 * scan pays for two; a document whose text begins later than this is still
 * refused wrongly, which is accepted because the alternative is unbounded work on
 * the request path — the thing the probe exists to avoid. A scan never reaches
 * the bound at all, because no page of it has text.
 */
const PREFLIGHT_PAGES = 2

/**
 * Refuse a PDF that cannot yield text, before a record is written.
 *
 * Only affordable checks: open the document, read a page or two, count non-blank
 * runs. A scan has no text layer, so the honest answer at upload time is "this
 * plugin has no OCR" rather than a successful upload that builds to nothing —
 * the worst available failure, since the user cannot tell a scan from a broken
 * plugin.
 *
 * **Why this samples rather than parses.** The question is whether the document
 * has a text layer, and that is settled by the first page that carries any text:
 * a scan has none anywhere, a text document has one almost immediately. So the
 * loop stops there, costing a normal document one page and a scan
 * {@link PREFLIGHT_PAGES}. The build's envelope — `timeoutMs`, `maxPages`,
 * `maxTextBytes` — stays with the build, where a full conversion belongs.
 *
 * **Why the build's page ceiling is not consulted.** `maxPages` is the *build*
 * envelope. A probe that honored it would read zero pages when it is configured
 * to zero and then report every PDF as a scan. The probe's cost is bounded by
 * {@link PREFLIGHT_PAGES} instead, which is what makes the config knob
 * unnecessary here.
 * @param file - absolute path of the stored original.
 * @returns ok, or a refusal naming the remedy.
 */
async function pdfPreflight(file: string): Promise<{ ok: true } | { ok: false, remedy: string }> {
  let doc: PreflightDocument
  try {
    const unpdf = (await import('unpdf')) as unknown as PreflightSurface
    doc = await unpdf.getDocumentProxy(new Uint8Array(readFileSync(file)))
  } catch (error) {
    return { ok: false, remedy: passwordRemedy(error) ?? openRemedy(error) }
  }
  try {
    // A document with no pages has nothing to extract and no page to read; saying
    // so here is cheaper and clearer than letting the build discover it.
    if (doc.numPages === 0) {
      return { ok: false, remedy: 'PDF 没有任何页面，无法提取文本。请确认文件未损坏后重新导出。' }
    }
    const limit = Math.min(doc.numPages, PREFLIGHT_PAGES)
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      let content: PreflightContent
      try {
        content = await page.getTextContent()
      } finally {
        page.cleanup()
      }
      // Runs, not characters: a scanned page reports a handful of empty runs (one
      // per image), and an empty run is not text however many of them there are.
      const runs = content.items.filter(item => typeof item.str === 'string' && item.str.trim() !== '').length
      if (runs > 0) return { ok: true }
    }
    return {
      ok: false,
      remedy:
        `PDF 前 ${limit} 页没有文本层，扫描件无法提取文字，而本插件不含 OCR。` +
        '请先用离线 OCR 工具（例如 OCRmyPDF、ABBYY 或 Adobe Acrobat 的「识别文本」）' +
        '生成带文本层的 PDF，再上传；也可以先转成 Markdown 后上传。',
    }
  } catch (error) {
    return { ok: false, remedy: passwordRemedy(error) ?? openRemedy(error) }
  } finally {
    // The load task owns the worker port; the document proxy has no `destroy()`.
    await doc.loadingTask.destroy().catch(() => {})
  }
}

/**
 * The refusal for a PDF that needs a password, when that is what failed.
 *
 * Recognised by the engine's own error name rather than by the message text,
 * because the message is translated and rewritten between engine versions while
 * `PasswordException` is part of its API. Measured against a pypdf-encrypted
 * document, the engine throws it from `getDocumentProxy` — decryption is checked
 * when the document is *loaded*, not when a page is read — so it always arrives
 * at the caller that loads the document rather than midway through a page loop.
 * The `?? openRemedy` fallback below is therefore a safety net for an engine that
 * moves that check, not the main path.
 * @param error - the thrown value.
 * @returns the remedy, or null when the failure was something else.
 */
function passwordRemedy(error: unknown): string | null {
  const name = error instanceof Error ? error.name : ''
  if (name !== 'PasswordException') return null
  return 'PDF 已加密或需要打开口令，本插件无法解密。请先用阅读器输入口令并「另存为」一份不含权限保护的副本，再上传该副本。'
}

/**
 * The refusal for a PDF that could not be opened at all.
 *
 * **Deliberately not a scan remedy.** A probe that cannot open a document must
 * not tell the user it is a scan: the two need opposite actions, and the OCR
 * advice is unfollowable for a file that is intact but unreadable *here*. The
 * engine's own reason is carried into the message for that reason — when the
 * cause is a broken deployment (the engine's fonts and CMaps live in
 * `pdfjs-dist`, which is a devDependency; see `checkAssets` in `parse/pdf.ts`),
 * the message says so instead of blaming the upload.
 *
 * **Why this module has no `checkAssets` of its own.** That probe exists in
 * `parse/pdf.ts` because a *conversion* can succeed with empty output when the
 * assets are missing — the engine swallows the resolution failure and extracts
 * nothing, which is indistinguishable from a genuinely empty document. The
 * preflight's failure is not silent in that way: opening the document is what
 * needs the assets, so an unreachable engine surfaces here as a thrown error and
 * reaches this message. A second probe would add a code path without changing
 * what the user is told.
 * @param error - the thrown value.
 * @returns the remedy, naming the engine's reason so it can be acted on.
 */
function openRemedy(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `PDF 无法打开：${detail}。请确认文件是完整的 PDF，必要时重新导出后再上传。`
}

/**
 * Look up how one file name would be handled.
 * @param name - file name.
 * @returns the support entry; unknown extensions report as unsupported.
 */
export function extractionSupport(name: string): ExtractionSupport {
  const ext = extensionOf(name)
  if (ext === '') return { kind: 'unsupported' }
  return SUPPORT[ext] ?? { kind: 'unsupported' }
}

/** One page's text content, as much of it as the probe reads. */
interface PreflightContent {
  /** The page's text runs and marked-content markers. */
  items: PreflightItem[]
}

/** A run, or a marker; only `str` is read, and markers carry none. */
interface PreflightItem {
  /** The run's text; absent on a marked-content marker. */
  str?: string
}

/** One page, as much of it as the probe reads. */
interface PreflightPage {
  /** The page's text content. */
  getTextContent: () => Promise<PreflightContent>
  /** Releases the page's resources. */
  cleanup: () => void
}

/** A loaded document, as much of it as the probe reads. */
interface PreflightDocument {
  /** Page count. */
  numPages: number
  /** Fetch one page, 1-based. */
  getPage: (n: number) => Promise<PreflightPage>
  /** The load task, which is what actually releases the worker port. */
  loadingTask: { destroy: () => Promise<void> }
}

/**
 * The engine surface the probe uses.
 *
 * Described structurally and imported lazily, exactly as `parse/pdf.ts` does it:
 * the host loads every store module at startup, and a PDF engine that is not
 * needed must not be on that path. Duplicating the two-line shape here rather
 * than re-exporting it keeps the parser module free to change its own surface.
 */
interface PreflightSurface {
  /** Loads a document with the Node asset defaults already applied. */
  getDocumentProxy: (data: Uint8Array) => Promise<PreflightDocument>
}

/**
 * Decode a stored original into the text to chunk.
 *
 * Only called for formats {@link extractionSupport} reports as `verbatim`; the
 * upload path refuses the others before a record is ever written — including the
 * ones a converter will handle, whose text does not exist until the build
 * pipeline's `parse` stage runs. A conversion format reaching here is therefore a
 * programming error rather than user input.
 *
 * It does not re-check that: this function decodes whatever bytes it is handed.
 * The format decision belongs to the caller, which is the only place that knows
 * which document is being uploaded; repeating it here would put the same rule in
 * two places and let them drift.
 * @param file - absolute path of the stored original.
 * @returns the decoded text.
 * @throws {Error} when the file cannot be read.
 */
export function extractVerbatim(file: string): string {
  const buffer = readFileSync(file)
  // A BOM is not content: left in place it becomes the first character of the
  // first chunk and of the first heading line, which stops `# 标题` from being
  // recognised as a heading at all.
  const text = buffer.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
