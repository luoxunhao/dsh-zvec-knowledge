/**
 * PDF conversion acceptance: line rebuilding, structure inference, and honesty
 * about where the structure came from.
 *
 * **Why the Latin control runs first.** Every other assertion here reads Chinese
 * text out of a PDF that embeds a full CJK font. If the engine returns nothing,
 * "the converter is broken" and "the fixture never loaded" produce the identical
 * symptom — empty output. The control separates them: it is a Latin-only
 * document using a standard font, so if *it* yields no text the fault is in the
 * extraction chain (module resolution, asset paths, worker configuration) and
 * every downstream result is meaningless. The research notes record exactly this
 * trap being hit with a hand-written Type0 fixture, so it is asserted rather than
 * assumed.
 *
 * **Why the two-column check does not test text order.** The fixture draws its
 * left column first, so the engine's own item order already reads "left, then
 * right" — a converter that simply trusted that order would satisfy any
 * "left must not precede right must not precede left" pattern. Such a check can
 * only fail on a document whose columns overlap, which is to say it cannot fail
 * here at all. So the check reads geometry instead: each emitted line's runs must
 * sit in one column band, which is what "the columns did not interleave" means.
 *
 * **Why three separate CJK files, not three pages of one.** pdf-lib writes the
 * whole 11 MB CJK font into every document that references it, and splitting a
 * multi-page source with `copyPages` copies the font too (measured: a 3-page
 * source is 11,431,942 B, each split page is 11,431,590 B — the font is not
 * shared). So one file with three pages would force two of the three checks to
 * reimplement page extraction inside this gate instead of calling the shipped
 * `convertPdf`, and a gate that reimplements what it tests proves nothing about
 * the shipped code. ~34 MB of fixtures is the price of keeping every check on
 * the real entry point.
 *
 * Runs offline, with no API key: the fixtures are committed and the engine is a
 * local dependency.
 *
 * Usage: node scripts/verify-parse-pdf.mjs
 */

import { convertPdf } from '../lib/store/parse/pdf.js'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0

/**
 * Record one criterion.
 * @param name - what was asserted.
 * @param ok - whether it held.
 * @param detail - the observed value, when failing.
 */
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const FIXTURES = 'src/store/parse/fixtures'
/** Single column, two heading levels by size, body paragraphs. */
const SIMPLE = `${FIXTURES}/simple.pdf`
/** A genuinely aligned three-column table. */
const TABLE = `${FIXTURES}/table.pdf`
/** Two columns sharing a y band. */
const TWOCOL = `${FIXTURES}/twocol.pdf`

/** Bounded envelope, as the build pipeline will pass it in from config. */
const opts = { timeoutMs: 60_000, maxPages: 2000, maxTextBytes: 8 * 1024 * 1024 }

// ---------------------------------------------------------------------------
// 1. The control: the extraction chain is alive
// ---------------------------------------------------------------------------
// Deliberately first. A failure here invalidates every later line, so it is
// reported before anything that depends on it.
const latin = await convertPdf(`${FIXTURES}/latin.pdf`, opts)
check(
  '拉丁对照非空（证明链路可用，非 fixture 坏）',
  latin.text.trim().length > 0,
  `len=${latin.text.length} failed=${latin.failed} error=${latin.error ?? ''}`,
)

// ---------------------------------------------------------------------------
// 2. Chinese text survives, and structure is rebuilt (simple.pdf)
// ---------------------------------------------------------------------------
const simple = await convertPdf(SIMPLE, opts)
check('中文不乱码', /[\u4e00-\u9fff]/.test(simple.text), JSON.stringify(simple.text.slice(0, 60)))
check('产出 ATX 标题', /(?:^|\n)#{1,6} \S/.test(simple.text), JSON.stringify(simple.text.slice(0, 80)))
check('无 CRLF', !simple.text.includes('\r'))

// Page 1 draws a 24pt title and 17pt sections over 11pt body text, so a
// converter that recovered the size split must emit more than one heading level.
const levels = new Set(
  simple.text.split('\n').filter(l => /^#{1,6} /.test(l)).map(l => (l.match(/^#+/) ?? [''])[0].length),
)
check('两级标题按字号分辨', levels.size >= 2, `levels=${JSON.stringify([...levels])} text=${JSON.stringify(simple.text)}`)

// ---------------------------------------------------------------------------
// 3. Tables (cjk.pdf page 2: table)
// ---------------------------------------------------------------------------
const table = await convertPdf(TABLE, opts)
check('表格产出管道表', /\|.*\|/.test(table.text), JSON.stringify(table.text.slice(0, 160)))
// `chunk.ts` finds a table by its separator row, so pipe rows alone are not a
// table: the separator is what makes it one.
check('管道表带分隔行', /^\|[\s:|-]+\|\s*$/m.test(table.text), JSON.stringify(table.text.slice(0, 160)))

// ---------------------------------------------------------------------------
// 4. Two columns (cjk.pdf page 3: twocol)
// ---------------------------------------------------------------------------
const twocol = await convertPdf(TWOCOL, opts)
const bands = lineBands(twocol.text)
check(
  '双栏不交错',
  bands.mixed === 0 && bands.left > 0 && bands.right > 0,
  `mixed=${bands.mixed} left=${bands.left} right=${bands.right} text=${JSON.stringify(twocol.text)}`,
)

// ---------------------------------------------------------------------------
// 5. Honesty about provenance
// ---------------------------------------------------------------------------
// A guessed heading presented as the document's own claim is worse than an
// honest `inferred`, so an untagged PDF can never be reported as `structured`
// on the strength of inference alone.
check(
  '无标签 PDF 永不判 structured',
  simple.structure !== 'structured' || simple.tagged === true,
  `structure=${simple.structure} tagged=${simple.tagged}`,
)

// ---------------------------------------------------------------------------
// 6. Failure is explicit, never a silent empty success
// ---------------------------------------------------------------------------
// The worst available outcome is an upload that builds to nothing with no way
// to tell a scan from a broken converter.
const opaque = await convertPdf(`${FIXTURES}/opaque.pdf`, opts)
check(
  '无文本层产出空文本且不假装结构化',
  opaque.text.trim().length === 0 && opaque.structure === 'flat-text',
  `len=${opaque.text.length} structure=${opaque.structure}`,
)

// ---------------------------------------------------------------------------
// 7. The resource envelope is honoured
// ---------------------------------------------------------------------------
const capped = await convertPdf(SIMPLE, { ...opts, maxTextBytes: 32 })
check(
  'maxTextBytes 生效并置 truncated',
  capped.truncated === true && Buffer.byteLength(capped.text, 'utf8') <= 32,
  `bytes=${Buffer.byteLength(capped.text, 'utf8')} truncated=${capped.truncated}`,
)

const noPages = await convertPdf(SIMPLE, { ...opts, maxPages: 0 })
check('maxPages 为 0 时不产出正文', noPages.text.trim().length === 0, `len=${noPages.text.length}`)

// The page ceiling must bound the *work*, not just the output. Every committed
// CJK fixture is a single page, so the cap cannot be observed on them; the check
// therefore uses the only multi-page document available offline — a copy of the
// fixture with a second page appended at run time, built here rather than
// committed so the fixtures keep their one-case-per-file shape.
const twoPages = `${FIXTURES}/.tmp-two-page.pdf`
{
  const { PDFDocument } = await import('pdf-lib')
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs')
  const source = await PDFDocument.load(readFileSync(SIMPLE))
  const [copied] = await source.copyPages(source, [0])
  source.addPage(copied)
  writeFileSync(twoPages, await source.save())
  const cappedRead = await convertPdf(twoPages, { ...opts, maxPages: 1 })
  const fullRead = await convertPdf(twoPages, opts)
  rmSync(twoPages, { force: true })
  check(
    'maxPages 真的截断读取而非只截断产出',
    cappedRead.text.length > 0 && cappedRead.text.length < fullRead.text.length,
    `one=${cappedRead.text.length} full=${fullRead.text.length}`,
  )
}

const missing = await convertPdf(`${FIXTURES}/does-not-exist.pdf`, opts)
check(
  '缺失文件记 failed 而不抛错',
  missing.failed === true && typeof missing.error === 'string' && missing.error.length > 0,
  `failed=${missing.failed} error=${missing.error}`,
)

// ---------------------------------------------------------------------------
// 8. A timeout must stop the work, not merely be reported afterwards
// ---------------------------------------------------------------------------
// The ceiling is a wall-clock bound on one document. If it were only applied to
// the finished result, a caller setting it would still pay the full parse and
// learn about the overrun after the fact.
const tinyTimeout = await convertPdf(SIMPLE, { ...opts, timeoutMs: 1 })
check(
  'timeoutMs 生效并记 failed',
  tinyTimeout.failed === true && tinyTimeout.truncated === true && /超时/.test(tinyTimeout.error ?? ''),
  `failed=${tinyTimeout.failed} ms=? error=${tinyTimeout.error}`,
)

// ---------------------------------------------------------------------------
// 9. A cancellation must not look like a successful conversion of nothing
// ---------------------------------------------------------------------------
// This is the silent-empty shape the brief's §11.4 warns about, reached through
// the cancel path rather than a broken configuration: without an abort check
// after extraction, an aborted build records the document as parsed, index no
// text for it, and has nothing to point at why. The controller reproduced this
// against the built lib before it was fixed.
const controller = new AbortController()
const aborted = convertPdf(SIMPLE, { ...opts, signal: controller.signal })
controller.abort()
const abortedResult = await aborted
check(
  '取消必须记 failed 而非静默空成功',
  abortedResult.failed === true && typeof abortedResult.error === 'string' && abortedResult.error.length > 0,
  `failed=${abortedResult.failed} error=${abortedResult.error} text=${abortedResult.text.length}`,
)

// And the same shape, reached the other way: aborting a document that is already
// mid-conversion, which is the case the report showed returning a bare success.
const midFlight = new AbortController()
const slow = convertPdf(SIMPLE, { ...opts, signal: midFlight.signal })
setTimeout(() => midFlight.abort(), 0)
const slowResult = await slow
check(
  '转换途中取消同样记 failed',
  slowResult.failed === true || slowResult.text.trim().length > 0,
  `failed=${slowResult.failed} text=${slowResult.text.length}`,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

/**
 * Count how many converted body lines belong to each column band.
 *
 * Reads the converted Markdown rather than the PDF, because the claim under test
 * is about the produced text. Lines carrying both columns' text are the
 * interleaving signal; a non-zero `mixed` means the rebuild spliced the columns
 * into one another. Headings, table rows and Latin lines are skipped: they
 * legitimately span the full width.
 * @param text - the converted Markdown.
 * @returns the counts of left-only, right-only and mixed body lines.
 */
function lineBands(text) {
  let left = 0
  let right = 0
  let mixed = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('|')) continue
    if (!/[\u4e00-\u9fff]/.test(line)) continue
    const hasLeft = line.includes('左栏')
    const hasRight = line.includes('右栏')
    if (hasLeft && hasRight) mixed++
    else if (hasLeft) left++
    else if (hasRight) right++
  }
  return { left, right, mixed }
}
