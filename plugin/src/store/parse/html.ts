/**
 * HTML → Markdown, the trunk shared by direct HTML uploads and DOCX.
 *
 * The pipeline is `hast-util-from-html` → `hast-util-to-mdast` →
 * `mdast-util-to-markdown`, chosen over `turndown` for one decisive reason: this
 * combination's **defaults are already what the chunker reads** — ATX headings
 * and forced fences — so forgetting to configure something cannot silently
 * degrade the output. Turndown's three relevant defaults are all the opposite
 * (setext headings, indented code, tables unhandled), which produces a document
 * that indexes fine and loses every section path.
 *
 * Four things are set explicitly because their absence is silent:
 * 1. the GFM table extension is registered — without it table nodes are dropped;
 * 2. `setext` is pinned to false, so an upstream default change cannot reach us;
 * 3. `href`s with `javascript:` or `data:` targets are dropped (mammoth's own
 *    README warns that source documents can carry them);
 * 4. output line endings are normalised to `\n`, since a `\r` defeats the
 *    chunker's heading regex.
 *
 * **What each of those four actually costs, measured rather than assumed.** The
 * gate that pins them was written against this dependency set, and two of the
 * four behave differently from the brief's description:
 *
 * - Omitting the GFM table extension does not "drop" table nodes: it **throws**
 *   `Cannot handle unknown node 'table'` from `mdast-util-to-markdown`, because
 *   `hast-util-to-mdast` produces a `table` node that the serializer has no
 *   handler for. A conversion that fails loudly is a better failure than one
 *   that silently loses every table, but it is not a *safe* one here either —
 *   the throw would reach the build's parse stage, and on the DOCX path (Task 5)
 *   it would turn one table-bearing document into a failed conversion. The
 *   extension is registered for both reasons.
 * - `data:` hrefs are not merely untidy, they are the **sharper** of the two
 *   sanitisation problems: a `data:text/html,<script>…</script>` destination is
 *   written out verbatim by the serializer, so an unfiltered `data:` target
 *   injects live markup into the product. `javascript:` is the one mammoth's
 *   README names; both are dropped here, by the same scheme test.
 *
 * **Why the scheme test runs on the tree rather than on the serialized text.** A
 * string-level filter cannot tell a link destination from the words of a
 * paragraph, so it would edit prose that happens to contain the literal
 * `javascript:`. Filtering the `element`'s `href` property before serialization
 * touches exactly the destinations and nothing else — and the properties are
 * already decoded by then, so an entity-encoded `&#106;avascript:` is caught by
 * the same rule rather than slipping past it.
 *
 * **Why `convertHtml` exists alongside the pure function.** `htmlToMarkdown` is
 * the interface Task 5 consumes, and it is deliberately pure: a string in, a
 * string out, no envelope, because mammoth's output arrives as a string and the
 * DOCX converter owns its own file reading. `convertHtml` is the same conversion
 * behind Task 1's `ParseResult` envelope, which is what the build pipeline's
 * dispatch table needs — the pipeline treats one document's failure as data
 * about that document, so a malformed file has to come back as `failed: true`
 * with a reason rather than as a throw that reaches the pipeline's outer guard.
 *
 * @module dsh-zvec-knowledge/store/parse/html
 */

import { readFileSync } from 'node:fs'
import { fromHtml } from 'hast-util-from-html'
import { toMdast } from 'hast-util-to-mdast'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'
import type { Nodes } from 'hast'
import { capBytes } from './cap.ts'
import { gradeMarkdown } from './grade.ts'
import type { ParseOptions, ParseResult } from './pdf.ts'

/**
 * URL schemes that must never reach the product.
 *
 * `javascript:` executes in whatever renders the Markdown. `data:` is the one
 * that smuggles markup: a `data:text/html,<script>…</script>` destination is
 * serialized verbatim, so the payload lands in the indexed text as live HTML.
 * `vbscript:` is included for the same reason as `javascript:` — it is a script
 * scheme, and the cost of naming it is one string.
 */
const BLOCKED_SCHEMES = /^[\u0000-\u0020]*(?:javascript|data|vbscript):/i

/**
 * The serializer's extension list.
 *
 * Built once per call rather than shared as a module constant: the list is a
 * plain array and `mdast-util-to-markdown` does not mutate it, but constructing
 * it here keeps the registration adjacent to the options it feeds, which is
 * where a reader looks for the GFM table extension the whole module warns about.
 * @returns the extension list.
 */
function extensions(): ReturnType<typeof gfmTableToMarkdown>[] {
  return [gfmTableToMarkdown()]
}

/**
 * Remove link destinations that carry a blocked scheme.
 *
 * Walked depth-first over the whole tree, with `visit` written locally rather
 * than pulled from `unist-util-visit`: the dependency would be one more package
 * on the runtime path for eight lines of recursion, and this walk needs to see
 * *every* node rather than the filtered subset a query would select.
 *
 * **`code` and `html` nodes are stepped over, not into.** Neither carries an
 * `href`, and the literals inside them are document content — a code sample that
 * demonstrates a `javascript:` URL is illustrating the very thing this filter
 * exists to catch. Rewriting it would silently corrupt the sample.
 *
 * The element keeps its children, so a blocked link degrades to its text: the
 * words survive and only the destination is gone. Dropping the whole element
 * would lose a sentence of prose because of a property of its link.
 * @param tree - the tree to sanitize, mutated in place.
 * @returns whether anything was removed, for the caller's record.
 */
function stripUnsafeHrefs(tree: Nodes): boolean {
  let removed = false
  const walk = (node: Nodes): void => {
    if (node.type === 'element') {
      const href = node.properties?.['href']
      if (typeof href === 'string' && BLOCKED_SCHEMES.test(href)) {
        delete node.properties?.['href']
        removed = true
      }
      // `src` matters for the DOCX path: mammoth inlines images as base64 by
      // default, and an uncapped `data:image/…` is how a few hundred KB of
      // opaque base64 ends up inside `documents.jsonl`, polluting both the
      // vectors and the quota. Task 5 configures mammoth to drop images; this is
      // the backstop for the HTML path, where the `src` arrives from the file.
      const src = node.properties?.['src']
      if (typeof src === 'string' && BLOCKED_SCHEMES.test(src)) {
        delete node.properties?.['src']
        removed = true
      }
      for (const child of node.children) walk(child)
      return
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as Nodes[]) walk(child)
    }
  }
  walk(tree)
  return removed
}

/**
 * Remove nodes that are not document content.
 *
 * **Comments are the surprising one, and they are load-bearing.**
 * `hast-util-from-html` keeps HTML comments in the tree as `comment` nodes, and
 * `hast-util-to-mdast` maps each one to a raw `html` mdast node whose value is
 * the comment verbatim — which `mdast-util-to-markdown` then writes straight
 * into the product. Measured on this dependency set, `<!-- 内部备注 -->` reaches
 * the Markdown unchanged. That is not a rendering detail: everything in the
 * product is chunked, embedded and cited, so a build tool's `<!-- TODO -->` or a
 * template's conditional comment becomes indexable, citable content that is not
 * part of the document. Comments are removed here.
 *
 * **`script` and `style`: kept, but currently unreachable, and the reason is not
 * the tree shape.** An earlier version of this comment claimed their text "is
 * *not* a child text node". Measured, that is false: `fromHtml` gives a
 * `<script>` element an ordinary `text` child (`{type: 'text', value: 'var s=1'}`),
 * exactly like a `<p>`. What actually keeps script bodies out of the product is
 * that `hast-util-to-mdast` has no `script`/`style` handler, so the element
 * contributes nothing. Removing this rule leaves the gate green — verified — so
 * the branch is dead code today.
 *
 * It is kept deliberately, and the honest justification is the forward-looking
 * one: `toMdast` gains handlers over time, and a handler for these two elements
 * would turn every inline `<script>` into indexed text with no gate noticing.
 * The rule costs one comparison per element and states the intent explicitly
 * instead of relying on a dependency's handler table staying empty.
 *
 * **What is *not* removed, and why.** A `<!doctype>` is parsed into a `doctype`
 * node that `hast-util-to-mdast` already drops, so no rule is needed and adding
 * one would be dead code — measured, and the gate asserts the outcome rather than
 * the mechanism. `raw` was written here at first and removed: hast has no `raw`
 * node type, so the comparison could never be true and TypeScript rejected it as
 * an impossible test. A rule that cannot fire must either go or say why it stays;
 * this one goes.
 * @param tree - the tree to prune, mutated in place.
 * @returns how many nodes were removed, for the caller's record.
 */
function stripNonContent(tree: Nodes): number {
  let removed = 0
  const prune = (node: Nodes): void => {
    if ('children' in node && Array.isArray(node.children)) {
      const kept: Nodes[] = []
      for (const child of node.children as Nodes[]) {
        if (child.type === 'comment') {
          removed++
          continue
        }
        if (child.type === 'element' && (child.tagName === 'script' || child.tagName === 'style')) {
          removed++
          continue
        }
        prune(child)
        kept.push(child)
      }
      node.children = kept as typeof node.children
    }
  }
  prune(tree)
  return removed
}

/**
 * Convert an HTML string into Markdown.
 *
 * Pure: no filesystem, no envelope, no throw for document-level content. This is
 * the interface the DOCX converter consumes, because mammoth hands back a string
 * and the DOCX converter owns its own file reading and its own failure envelope.
 *
 * @param html - the source HTML; may be a fragment, since the parser is
 *   WHATWG-compatible and repairs real-world markup.
 * @returns the Markdown, `\n`-terminated and free of `\r`.
 */
export function htmlToMarkdown(html: string): string {
  const tree = fromHtml(html)
  stripNonContent(tree)
  stripUnsafeHrefs(tree)
  const mdast = toMdast(tree)
  return toMarkdown(mdast, {
    // The pin that matters most after the extension list. `setext` defaults to
    // `false` today, which is why the brief calls this belt-and-braces — but the
    // chunker reads `^#{1,6} \S` and a setext heading is invisible to it, and the
    // failure is a document that renders correctly and indexes as one section.
    // Pinning it here means an upstream default change cannot reach a corpus.
    setext: false,
    // ATX headings are always six hashes or fewer, so an `h7` cannot exist; the
    // cap is stated rather than left to the serializer's own truncation.
    bullet: '-',
    extensions: extensions(),
    // **Belt against a parser-contract change; not currently reachable, so not
    // pinned by an assertion.** The HTML parser folds CR and CRLF itself, and
    // measured, no input reaches this point carrying a `\r` — not in text, a
    // heading, a table cell, `<pre>`, a `<textarea>`, an attribute, a comment, an
    // image `alt`, nor via the `&#13;` entity. So the `.replace` below cannot
    // fire on any input, and a gate that deletes it stays green; asserting "the
    // product has no CR" would be measuring the parser, not this module.
    //
    // It is kept as defence in depth because the contract is worth enforcing at
    // our own boundary rather than inheriting: `gradeMarkdown` reports any `\r`
    // as `flat-text` before it looks at structure, so a parser that stopped
    // folding would silently flatten every document's structure verdict. The
    // cost is one regex pass over text we already hold.
  }).replace(/\r\n?/g, '\n')
}

/**
 * Convert one HTML file into Markdown, under the pipeline's envelope.
 *
 * Never throws for a document-level problem: a missing file, an unreadable file,
 * a cancellation and an overrun all come back as `failed` with an `error` in the
 * user's language, because the build pipeline treats one document's failure as
 * data about that document and an exception there would fail the whole build.
 *
 * **The two silent outcomes this function exists to forbid**, both inherited
 * from `convertPdf`'s reasoning:
 *
 * - **An untagged inference is never reported as `structured`.** This converter
 *   reads the document's own tag tree, so unlike PDF it never guesses and there
 *   is no inference to cap — `structured` here means the tags really were there.
 *   The rule it still has to honour is the other half: a document with no
 *   structure must report `flat-text` rather than a level its text cannot
 *   support, which `gradeMarkdown` decides.
 * - **An empty product is a failure, never a silent empty success.** A blank page
 *   that converts cleanly to nothing would be recorded as parsed with no text
 *   and no reason — indistinguishable downstream from a document that was
 *   legitimately empty.
 *
 * @param file - path of the stored original.
 * @param opts - the resource envelope, supplied by config.
 * @returns the converted Markdown, how much structure survived, and the verdict.
 */
export async function convertHtml(file: string, opts: ParseOptions): Promise<ParseResult> {
  const started = Date.now()
  // The deadline is an *instant*, computed once, matching `convertPdf` — not
  // `Date.now() - started > opts.timeoutMs`. The two differ when the ceiling is
  // zero: the elapsed-time form compares `0 > 0` and reports a successful
  // conversion of a document that was never allowed any time at all. A zero
  // ceiling here means zero, which is the same reading `capBytes` takes of a zero
  // byte ceiling. Found by the gate's own timeout assertion, which was added
  // because mutation testing showed this arm was covered by nothing.
  //
  // Checked once, after the work, rather than also before the read: a guard
  // before the read was written and then deleted, because mutation testing showed
  // deleting it changed no gate result — the post-work check already covers the
  // zero-ceiling case, so the early return was unreachable. A rule that cannot
  // fire is worse than no rule, because it reads as coverage.
  const deadline = started + opts.timeoutMs
  try {
    if (opts.signal?.aborted) return empty('已取消')

    const html = readFileSync(file, 'utf8')

    return await convertHtmlText(html, opts, 'HTML', started, deadline)
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return empty('已取消')
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: `HTML 解析失败：${message}`,
    }
  }
}

/**
 * Convert an in-memory HTML string — the shared trunk's string entry.
 *
 * Everything after "bytes to HTML" lives here so that there is exactly one copy
 * of the failure-verdict logic: the empty-product failure, the timeout result,
 * the abort checks and the catch-all. `convertHtml` (file) and `convertDocx`
 * (mammoth's HTML) are both thin callers; a second implementation of any of
 * those verdicts would let the two paths drift, which is how a converter ends
 * up reporting a success the other one would have refused.
 *
 * @param html - the HTML text to convert.
 * @param opts - the resource envelope, supplied by config.
 * @param sourceLabel - format name for error prefixes, e.g. `'HTML'` / `'DOCX'`.
 * @param started - when the caller's work began, so the deadline covers the
 *   caller's own I/O and not just this function's parsing.
 * @param deadline - the absolute wall-clock instant after which the product
 *   cannot be claimed complete.
 * @returns the converted Markdown and its verdict.
 */
export async function convertHtmlText(
  html: string,
  opts: ParseOptions,
  sourceLabel: string,
  started: number,
  deadline: number,
): Promise<ParseResult> {
  try {
    if (opts.signal?.aborted) return empty('已取消')

    const raw = htmlToMarkdown(html)

    if (opts.signal?.aborted) return empty('已取消')
    if (raw.trim() === '') {
      return {
        text: '',
        structure: 'flat-text',
        truncated: false,
        failed: true,
        error: `${sourceLabel} 文件中没有可索引的文本内容（没有正文元素，或正文为空）。`
          + '请确认文件不是只含脚本/样式的页面，或改为上传 Markdown。',
      }
    }

    const { text, truncated } = capBytes(raw, opts.maxTextBytes)

    // The deadline is tested after the work as well, not only before it: a
    // conversion that ran long produced a text whose completeness cannot be
    // claimed, and reporting it as a clean success is how a truncated document is
    // indexed with nothing to point at why.
    if (Date.now() > deadline) return timeoutResult(opts, started, text)

    return { text, structure: gradeMarkdown(text), truncated }
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return empty('已取消')
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: `${sourceLabel} 解析失败：${message}`,
    }
  }
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
 * The result for a document that exceeded its wall-clock ceiling.
 *
 * Reported as a failure with whatever text was produced, rather than as a
 * success: a document indexed from a conversion that was cut short has content
 * missing with nothing to point at why.
 *
 * **Never graded above `flat-text`.** The text may well contain ATX headings and
 * a pipe table, so `gradeMarkdown` would happily answer `structured` — but that
 * answer is about a document that was only partly converted, and the section a
 * cut landed inside may have lost the heading that made it a section. Claiming a
 * structure level from half a document is a claim this module cannot support, so
 * the verdict is pinned to the honest floor here. This mirrors `pdf.ts`'s
 * `timeoutResult`, which reaches the same conclusion about a timed-out PDF.
 * @param opts - the envelope, for the ceiling in the message.
 * @param started - when conversion began.
 * @param partial - text produced before the deadline, when there is any.
 * @returns the failed result.
 */
function timeoutResult(opts: ParseOptions, started: number, partial = ''): ParseResult {
  const elapsed = Math.round((Date.now() - started) / 1000)
  return {
    text: partial,
    structure: 'flat-text',
    truncated: true,
    failed: true,
    error: `HTML 解析超时（上限 ${Math.round(opts.timeoutMs / 1000)} 秒，已用 ${elapsed} 秒）`,
  }
}
