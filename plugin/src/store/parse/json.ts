/**
 * JSON → Markdown.
 *
 * A local renderer rather than a dependency: the registry's JSON-to-Markdown
 * packages are unmaintained and carry no structure guarantee, and the semantics
 * wanted here are narrow — wrap small documents whole, walk large ones
 * deterministically. "Deterministically" matters because the derived text is
 * stored and cited: two conversions of the same bytes must produce the same
 * text, so key order is the source's order and never sorted.
 *
 * Small documents become one fenced ```json block (the chunker protects a
 * fence, so the document is never split mid-value). Large ones become a
 * heading per key path with leaf values as list items, which gives heading-mode
 * chunking something to anchor on. Unparseable input is fenced as raw text and
 * reported `flat-text` — the honest answer, since the document is preserved but
 * carries no recoverable structure.
 *
 * @module dsh-zvec-knowledge/store/parse/json
 */

import { readFileSync } from 'node:fs'
import { capBytes } from './cap.ts'
import { gradeMarkdown } from './grade.ts'
import type { ParseOptions, ParseResult } from './pdf.ts'

/**
 * Above this many characters a document is walked into headings instead of
 * fenced whole. A fence the size of a large document would be one protected
 * chunk the chunker cannot split, which defeats section-level retrieval for
 * exactly the documents too big to read in one pass.
 */
const FENCE_LIMIT = 8 * 1024

/**
 * Convert a JSON file.
 *
 * The three outcomes are mutually exclusive and each is honest: a valid small
 * document is fenced `structured`-only-if-graded-so (a single fence carries no
 * heading, so `gradeMarkdown` will call it flat — which is correct, because
 * heading-based chunking has nothing to anchor on); a valid large one becomes
 * key-path headings; an invalid one is preserved raw as `flat-text` with a
 * reason, never discarded.
 * @param file - path of the stored original.
 * @param opts - the resource envelope.
 * @returns the converted Markdown and its verdict.
 */
export async function convertJson(file: string, opts: ParseOptions): Promise<ParseResult> {
  const started = Date.now()
  try {
    if (opts.signal?.aborted) return empty('已取消')

    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')

    if (opts.signal?.aborted) return empty('已取消')

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Unparseable JSON is still text somebody uploaded. Fencing it keeps the
      // chunker from treating `{"` as structure, and `flat-text` says no
      // structure was recovered rather than pretending the fence is one.
      const fenced = '```json\n' + raw + '\n```\n'
      return finish(fenced, opts, started, 'JSON 解析失败：内容不是合法 JSON，已按原文包裹保留。')
    }

    const text = JSON.stringify(parsed) !== undefined && byteLength(parsed) <= FENCE_LIMIT
      ? '```json\n' + JSON.stringify(parsed, null, 2) + '\n```\n'
      : walk(parsed)

    if (opts.signal?.aborted) return empty('已取消')
    if (text.trim() === '') {
      return {
        text: '',
        structure: 'flat-text',
        truncated: false,
        failed: true,
        error: 'JSON 文件中没有可索引的内容（可能是 null、空对象或空数组）。',
      }
    }
    return finish(text, opts, started)
  } catch (error) {
    if (opts.signal?.aborted) return empty('已取消')
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: `JSON 解析失败：${message}`,
    }
  }
}

/**
 * Walk a parsed document into key-path headings.
 *
 * Objects become `## <path>` sections and leaf values become `- key: value`
 * lines; arrays index their elements (`## <path>[0]`). Key order is insertion
 * order: sorting would make the product differ from the source's own ordering,
 * and a re-parse of the same bytes must produce the same text.
 *
 * A section heading is emitted for the object/array itself, then each member.
 * Leaf values therefore sit under a heading their full key path names, which is
 * what gives heading-mode chunking an anchor — the same reason tabular sheets
 * get `## <sheet>` headings.
 * @param value - the parsed JSON value.
 * @returns the walked Markdown.
 */
function walk(value: unknown): string {
  const lines: string[] = []
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 32) {
      lines.push(`## ${path}\n\n- （嵌套过深，已省略）\n`)
      return
    }
    if (node === null || typeof node !== 'object') {
      lines.push(`- ${path}: ${scalar(node)}`)
      return
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        lines.push(`## ${path}\n\n- （空数组）\n`)
        return
      }
      node.forEach((element, index) => visit(element, `${path}[${index}]`, depth + 1))
      return
    }
    const entries = Object.entries(node as Record<string, unknown>)
    if (entries.length === 0) {
      lines.push(`## ${path}\n\n- （空对象）\n`)
      return
    }
    if (path !== '') lines.push(`## ${path}\n`)
    for (const [key, child] of entries) visit(child, path === '' ? key : `${path}.${key}`, depth + 1)
  }
  visit(value, '', 0)
  return lines.join('\n') + '\n'
}

/**
 * Render a leaf value. Strings are quoted so an empty string stays visible as
 * a value rather than collapsing into `- key: `.
 * @param value - the leaf value.
 * @returns its display form.
 */
function scalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * Byte length of a parsed value when serialized — the fence decision compares
 * the *output* size, and a value's serialized form is what the fence would hold.
 * @param value - the parsed JSON value.
 * @returns its serialized byte length.
 */
function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Cap, grade and return. Shared by all three outcomes so the truncation and
 * deadline rules exist once.
 * @param text - the converted Markdown.
 * @param opts - the resource envelope.
 * @param started - when the work began.
 * @param note - an error to attach; present means the document was degraded.
 * @returns the result.
 */
function finish(text: string, opts: ParseOptions, started: number, note?: string): ParseResult {
  if (text.trim() === '') {
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: note ?? 'JSON 文件中没有可索引的内容。',
    }
  }
  // The byte-exact cap shared with pdf/html: an earlier local version tested
  // bytes but sliced by code units, which measured 2.7× the declared ceiling on
  // CJK products (the quota is charged in UTF-8 bytes downstream).
  const { text: capped, truncated } = capBytes(text, opts.maxTextBytes)
  if (Date.now() > started + opts.timeoutMs) {
    return {
      text: capped,
      structure: 'flat-text',
      truncated: true,
      failed: true,
      error: `解析超过 ${opts.timeoutMs} ms 上限，产物可能不完整。${note ?? ''}`,
    }
  }
  if (note !== undefined) {
    // Degraded input keeps its text but cannot claim structure: the verdict
    // must reflect that the fence is a preservation measure, not a finding.
    return { text: capped, structure: 'flat-text', truncated, failed: false, error: note }
  }
  return { text: capped, structure: gradeMarkdown(capped), truncated }
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
