/**
 * Tabular formats (XLSX / CSV) → Markdown pipe tables.
 *
 * Both formats share one renderer, {@link rowsToMarkdownTable}, because the
 * output contract is identical and only the reading differs: XLSX arrives as
 * workbook sheets, CSV as rows. The table shape is not a stylistic choice —
 * `chunk.ts` locates tables by their separator row, so a header without one is
 * prose to the chunker, and cells containing `|` or a newline would forge or
 * break that structure. Escaping them is what makes the table honest.
 *
 * Each sheet (or the CSV itself) gets a `## <name>` heading: a heading-mode
 * document with no headings is one giant section, and a two-sheet workbook
 * without per-sheet anchors is indistinguishable from a single mixed table.
 *
 * @module dsh-zvec-knowledge/store/parse/tabular
 */

import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { capBytes } from './cap.ts'
import { gradeMarkdown } from './grade.ts'
import type { ParseOptions, ParseResult } from './pdf.ts'

/** One parsed table in row-major order, header row included. */
export type Rows = string[][]

/**
 * Render rows as a pipe table with a preceding heading.
 *
 * The first row is the header — the formats carry one by construction (a sheet's
 * first row, a CSV header line) — and the separator row is what the chunker
 * reads. Cell values have pipes and newlines escaped, since either would forge
 * or break the row structure the separator anchors.
 * @param rows - the rows, header first.
 * @param title - sheet or file name for the heading; omitted for untitled input.
 * @returns Markdown with a `## <title>` heading and the table.
 */
export function rowsToMarkdownTable(rows: Rows, title?: string): string {
  const heading = title !== undefined && title !== '' ? `## ${title}\n\n` : ''
  if (rows.length === 0) return heading

  // A cell's pipe would start a new column and its newline would start a new
  // row, so both are replaced rather than escaped: an escaped pipe still reads
  // as a column boundary to a naive reader, while a space does not.
  const cell = (value: string) => String(value).replace(/\|/g, '｜').replace(/\n/g, ' ')
  const [header = [], ...body] = rows
  const width = Math.max(header.length, ...body.map((row) => row.length), 1)
  const pad = (row: string[]) => {
    const cells = Array.from({ length: width }, (_, i) => cell(row[i] ?? ''))
    return `| ${cells.join(' | ')} |`
  }

  const lines = [pad(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`]
  for (const row of body) lines.push(pad(row))
  return heading + lines.join('\n') + '\n'
}

/**
 * The shared result shape, applied to a table or a set of tables.
 *
 * The `structure` verdict follows the same rule as the other converters: the
 * text genuinely carries a header/separator table, so `gradeMarkdown` may call
 * it structured when it also has headings — which every multi-sheet workbook
 * does, and a single-sheet CSV does unless it was given a title.
 * @param text - the converted Markdown.
 * @param opts - the resource envelope.
 * @param started - when the caller's work began.
 * @returns the result, capped and graded.
 */
function finish(text: string, opts: ParseOptions, started: number): ParseResult {
  if (text.trim() === '') {
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: '表格中没有可索引的内容（没有数据行，或所有单元格为空）。',
    }
  }
  // The byte-exact cap shared with pdf/html: an earlier local version tested
  // bytes but sliced by code units, which measured 2.3–2.7× the declared
  // ceiling on CJK products (the quota is charged in UTF-8 bytes, so an
  // oversized product here would overdraw the quota charged downstream).
  const { text: capText, truncated } = capBytes(text, opts.maxTextBytes)
  if (Date.now() > started + opts.timeoutMs) {
    return {
      text: capText,
      structure: 'flat-text',
      truncated: true,
      failed: true,
      error: `解析超过 ${opts.timeoutMs} ms 上限，产物可能不完整。`,
    }
  }
  return { text: capText, structure: gradeMarkdown(capText), truncated }
}

/** The XLSX reader's own row shape: cells arrive as values, not strings. */
type SheetRows = (string | number | boolean | null)[][]

/**
 * Convert an XLSX workbook. One `## <sheet>` section per sheet, so a multi-sheet
 * document is retrievable by sheet name.
 *
 * The reader's default call returns **every** sheet as `{sheet, data}` — the
 * multi-sheet walk of the research note is the library's default in 9.x, not an
 * option. A sheet whose only row is the header is skipped: keeping it would
 * index a table with no content, which reads as evidence that is not there.
 * @param file - path of the stored original.
 * @param opts - the resource envelope.
 * @returns the converted Markdown and its verdict.
 */
export async function convertXlsx(file: string, opts: ParseOptions): Promise<ParseResult> {
  const started = Date.now()
  try {
    if (opts.signal?.aborted) return empty('已取消')
    // `read-excel-file` has no root export: Node consumers import the `/node`
    // entry, which is where its types live too.
    const { default: readXlsxFile } = await import('read-excel-file/node')
    const sheets = (await readXlsxFile(file)) as { sheet: string, data: SheetRows }[]
    const sections: string[] = []
    for (const { sheet, data } of sheets) {
      if (opts.signal?.aborted) return empty('已取消')
      const asStrings = data.map((row) => row.map((cell) => (cell === null ? '' : String(cell))))
      if (asStrings.length <= 1) continue
      sections.push(rowsToMarkdownTable(asStrings, sheet))
    }
    return finish(sections.join('\n'), opts, started)
  } catch (error) {
    return failure(error, 'XLSX', opts)
  }
}

/**
 * Convert a CSV file. `header: true` makes papaparse consume the header row so
 * the renderer can re-emit it as the table's first row; `skipEmptyLines` keeps
 * blank separators in the source from becoming empty table rows.
 * @param file - path of the stored original.
 * @param opts - the resource envelope.
 * @returns the converted Markdown and its verdict.
 */
export async function convertCsv(file: string, opts: ParseOptions): Promise<ParseResult> {
  const started = Date.now()
  try {
    if (opts.signal?.aborted) return empty('已取消')
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy' })
    if (parsed.errors.length > 0 && parsed.data.length === 0) {
      return {
        text: '',
        structure: 'flat-text',
        truncated: false,
        failed: true,
        error: `CSV 解析失败：${parsed.errors[0]?.message ?? '未知错误'}`,
      }
    }
    const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '') ?? ''
    return finish(rowsToMarkdownTable(parsed.data, name), opts, started)
  } catch (error) {
    return failure(error, 'CSV', opts)
  }
}

/** An empty, failed product, in step with the other converters. */
function empty(reason: string): ParseResult {
  return {
    text: '',
    structure: 'flat-text',
    truncated: false,
    failed: true,
    error: reason,
  }
}

/**
 * A converter failure, named by format. The parse stage treats one document's
 * failure as data about that document, so this returns rather than throws.
 * @param error - what went wrong.
 * @param label - the format name for the prefix.
 * @param opts - the envelope, for the abort check.
 * @returns the failed result.
 */
function failure(error: unknown, label: string, opts: ParseOptions): ParseResult {
  if (opts.signal?.aborted) return empty('已取消')
  const message = error instanceof Error ? error.message : String(error)
  return {
    text: '',
    structure: 'flat-text',
    truncated: false,
    failed: true,
    error: `${label} 解析失败：${message}`,
  }
}
