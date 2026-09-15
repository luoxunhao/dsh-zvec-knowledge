/**
 * Turning a stored original into the text the chunker indexes.
 *
 * The plugin's data source is Markdown, and that is a deliberate boundary rather
 * than a limitation: the chunker is Markdown-aware (it reads heading levels and
 * table headers), so a converter that flattens a document into unstructured prose
 * would silently defeat it. Producing the Markdown is therefore someone else's
 * job — a hosted converter, a script, a `pandoc` invocation — and this module
 * handles the formats that need no conversion at all.
 *
 * **Why extraction is separate from storage.** The original is kept byte-for-byte
 * and the text is derived from it. Keeping them apart is what makes the derived
 * text recomputable: when this module gains a real converter, every existing
 * document can be reprocessed from its stored original instead of being
 * re-uploaded.
 *
 * **Why the refusals are specific.** A format the list advertises but this module
 * cannot convert must be refused *at upload*, naming the remedy. The alternative
 * is the worst failure mode available: the upload succeeds, the build produces
 * nothing, and the user has no way to tell a scanned document from a broken one.
 *
 * @module dsh-zvec-knowledge/store/extract
 */

import { readFileSync } from 'node:fs'
import { extensionOf } from './documents.ts'

/** How a format is turned into indexable text. */
export type ExtractionKind =
  /** The bytes already are the text; decode and store verbatim. */
  | 'verbatim'
  /** Recognised, but no converter is wired: refuse with a remedy. */
  | 'needs-conversion'
  /** Not a text format at all. */
  | 'unsupported'

/** What this module can do with one extension. */
export interface ExtractionSupport {
  /** Which handling applies. */
  kind: ExtractionKind
  /** The converter or remedy to name when `kind` is not `verbatim`. */
  remedy?: string
}

/**
 * Formats the plugin advertises, and what it does with each.
 *
 * `md` / `markdown` / `txt` are verbatim: Markdown is the target format and plain
 * text is already at the right level of structure for the paragraph strategy.
 * The office and PDF formats are listed because the UI advertises them, but the
 * honest statement is that they need conversion first — claiming support and
 * producing an empty index would be worse than saying so.
 */
const SUPPORT: Record<string, ExtractionSupport> = {
  md: { kind: 'verbatim' },
  markdown: { kind: 'verbatim' },
  txt: { kind: 'verbatim' },
  html: {
    kind: 'needs-conversion',
    remedy: 'HTML 请先转换为 Markdown（标题层级会变成 #/##，这是切分器识别章节的依据）',
  },
  htm: {
    kind: 'needs-conversion',
    remedy: 'HTML 请先转换为 Markdown（标题层级会变成 #/##，这是切分器识别章节的依据）',
  },
  json: {
    kind: 'needs-conversion',
    remedy: 'JSON 请先在代码块中包裹（```json）后另存为 .md 上传',
  },
  csv: {
    kind: 'needs-conversion',
    remedy: 'CSV 请先转换为 Markdown 表格（表头行 + |---| 分隔行），否则表格的列名会丢失',
  },
  pdf: {
    kind: 'needs-conversion',
    remedy: 'PDF 请先转换为 Markdown。扫描件无文本层，需要先做 OCR',
  },
  docx: {
    kind: 'needs-conversion',
    remedy: 'DOCX 请先转换为 Markdown（例如 pandoc 或 mammoth），以保留标题层级',
  },
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

/**
 * Decode a stored original into the text to chunk.
 *
 * Only called for formats {@link extractionSupport} reports as `verbatim`; the
 * upload path refuses the others before a record is ever written, so a
 * conversion format reaching here is a programming error rather than user input.
 * @param file - absolute path of the stored original.
 * @returns the decoded text.
 * @throws {Error} when the file cannot be read or is not a verbatim format.
 */
export function extractVerbatim(file: string): string {
  const buffer = readFileSync(file)
  // A BOM is not content: left in place it becomes the first character of the
  // first chunk and of the first heading line, which stops `# 标题` from being
  // recognised as a heading at all.
  const text = buffer.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
