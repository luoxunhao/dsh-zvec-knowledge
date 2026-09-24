/**
 * HTML → Markdown acceptance: the four silent settings, and the two silent
 * failure modes they exist to prevent.
 *
 * **Why this gate is shaped around four settings rather than around "does it
 * convert".** A conversion that loses every table, or emits setext headings, or
 * leaks a `javascript:` link still produces a document that looks like Markdown
 * and indexes without complaint — the loss is only visible to the *chunker*,
 * which reads `#` and `| --- |` and nothing else. So each setting is asserted
 * through its consequence in the product, not through the option being passed.
 *
 * **The `javascript:` case is a security assertion, not a tidiness one.**
 * Measured on this dependency set (see the report), `data:` targets survive into
 * the output as a raw `<script>` tag inside a link destination. A source
 * document can carry that, and Task 5's DOCX path inherits it from mammoth —
 * mammoth's own README warns that "source documents can contain links with
 * `javascript:` targets" and that it performs no sanitisation.
 *
 * **On the gfm-table extension.** The brief predicted the failure is silent
 * ("without it, table nodes are dropped entirely"). Measured, it is worse than
 * silent: `mdast-util-to-markdown` **throws** `Cannot handle unknown node
 * 'table'` when it meets a table node with no registered handler. Both are
 * unpinned by the type system, and both are caught by the assertions below —
 * under the throw, the whole conversion fails rather than degrading. The report
 * records the discrepancy.
 *
 * **The negative self-proof.** Comment out the `gfmTableToMarkdown()` entry in
 * `html.ts` and the first two table assertions go red; that is the check that
 * this gate would notice the one omission most likely to be quietly wrong.
 *
 * Runs offline: no network, no API key, no fixture files — the input is a literal
 * string and the whole conversion is pure.
 *
 * Usage: node scripts/verify-parse-html.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

// Imported from the built output, like every other gate in this repository: the
// claim is about what ships, and `lib/` is what ships.
let htmlToMarkdown
let convertHtml
try {
  const html = await import(new URL('../lib/store/parse/html.js', import.meta.url).href)
  htmlToMarkdown = html.htmlToMarkdown
  convertHtml = html.convertHtml
} catch (error) {
  console.log(`\n  FAIL the module is not built — ${error.message}`)
  console.log('\n0 passed, 1 failed')
  process.exit(1)
}

// ===========================================================================
// The brief's case, verbatim: every format criterion in one document.
// ===========================================================================
// Wrapped, because the single most important omission in this module — the
// GFM table extension — makes the *conversion itself* throw rather than degrade,
// so an unwrapped gate does not report "tables are missing", it reports a stack
// trace and exits before the first assertion. That is exactly what the negative
// self-proof measured. A gate whose failure mode is a crash cannot tell the two
// cases apart, so the call is guarded and a throw becomes a legible red line.
const convert = (html) => {
  try {
    return htmlToMarkdown(html)
  } catch (error) {
    return `<<threw: ${error instanceof Error ? error.message : String(error)}>>`
  }
}

const out = convert(`
<h1>标题一</h1><h2>标题二</h2>
<p>正文</p>
<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>
<pre><code class="language-ts">const x = 1</code></pre>
<script>alert(1)</script><style>p{}</style>
<a href="javascript:alert(1)">坏链</a>
`)

check('h1 → #', /(?:^|\n)# /.test(out), JSON.stringify(out))
check('h2 → ##', /(?:^|\n)## /.test(out), JSON.stringify(out))
check('表格 → 管道表', /\|.*\|/.test(out), JSON.stringify(out))
check('表头后有分隔行', /^\|[\s:|-]+\|\s*$/m.test(out), JSON.stringify(out))
check('pre/code → 三反引号围栏', /^```/m.test(out), JSON.stringify(out))
check('script 不进入产物', !out.includes('alert'), JSON.stringify(out))
check('style 不进入产物', !out.includes('p{}'), JSON.stringify(out))
check('javascript: 链接被丢弃', !out.includes('javascript:'), JSON.stringify(out))
check('无 CRLF', !out.includes('\r'), JSON.stringify(out))

// ===========================================================================
// 1. setext: false — pinned, because a setext heading is invisible to the chunker
// ===========================================================================
// The chunker's heading regex is `^#{1,6} \S`. A setext heading (`标题` followed
// by a line of `===`) satisfies the author and not the chunker, and no downstream
// gate would notice: the text is perfectly readable Markdown. So the pin is
// asserted by consequence — no underline-only heading may appear anywhere.
const headings = [
  '<h1>a b c</h1><h2>d e f</h2><h3>g</h3><h4>h</h4><h5>i</h5><h6>j</h6>',
  '<h1>标题一</h1><h2>标题二</h2>',
]
for (const sample of headings) {
  const produced = convert(sample)
  const levels = [...produced.matchAll(/^(#{1,6}) /gm)].map(match => match[1].length)
  check(
    `setext=false: ${sample.slice(0, 28)}… emits only ATX headings`,
    levels.length > 0 && !/^[^\n#|].*\n(=+|-{2,})\s*$/m.test(produced),
    JSON.stringify(produced),
  )
}

// ===========================================================================
// 2. The GFM table extension — the whole reason the first two checks exist
// ===========================================================================
// A bare `<table>` with no `<thead>` is the shape mammoth emits for a DOCX table
// and the shape real-world HTML carries. Asserted on its own, because the brief's
// case above would still pass this if the assertion were the only one: it is not
// enough that *a* table survived, it must be *this* table, with its cells.
const bare = convert(
  '<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>',
)
check(
  'gfm-table: a bare <table> becomes a pipe table with its header and both rows',
  /\|\s*列A\s*\|\s*列B\s*\|/.test(bare) && /\|\s*1\s*\|\s*2\s*\|/.test(bare),
  JSON.stringify(bare),
)
check(
  'gfm-table: the separator row follows the header, as `gradeMarkdown` requires',
  /^\|[\s:|-]*-\s*\|[\s:|-]*\|?\s*$/m.test(bare),
  JSON.stringify(bare),
)
// A document with a table and NO heading must not be graded `structured` by
// accident — asserted by the grader below, but the table's own presence is what
// makes the next check meaningful.
const withHeadingAndTable = convert(
  '<h1>章节</h1><table><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>',
)
check(
  'gfm-table: heading + table is graded `structured` by the shared judge',
  (await import(new URL('../lib/store/parse/grade.js', import.meta.url).href))
    .gradeMarkdown(withHeadingAndTable) === 'structured',
  JSON.stringify(withHeadingAndTable),
)

// ===========================================================================
// 3. href sanitisation — `javascript:` AND `data:`
// ===========================================================================
// Both are asserted separately. `javascript:` is the one mammoth's README names;
// `data:` is the one that actually smuggles markup through, because a `data:`
// target can be `data:text/html,<script>…</script>` and the serializer writes it
// out as a link destination. Measured on this dependency set: both survive
// untouched when nothing filters them.
const jsLink = convert('<a href="javascript:alert(1)">坏链</a>')
// The assertion is about the *destination*, not about the link syntax: the
// serializer is given an element with no `href`, and what it does with that is
// the serializer's business (measured: it emits `[坏链]()`, an empty
// destination). What must hold is that the scheme and its payload are gone and
// the link's own words survived — dropping the element entirely would lose a
// sentence of prose because of a property of its link.
check(
  'href: a javascript: link keeps its text and loses its payload',
  jsLink.includes('坏链') && !jsLink.includes('javascript:') && !jsLink.includes('alert'),
  JSON.stringify(jsLink),
)
const dataLink = convert('<a href="data:text/html,<script>alert(1)</script>">坏链</a>')
check(
  'href: a data: link is dropped, so its payload cannot reach the output',
  !dataLink.includes('data:') && !dataLink.includes('<script') && !dataLink.includes('alert'),
  JSON.stringify(dataLink),
)
// The filter must not be a blunt instrument: a link the corpus legitimately
// carries — relative, http(s), mailto, an anchor — has to survive with its
// destination, or the fix trades a security bug for a silent content loss.
const goodLink = convert(
  '<p><a href="/a/b">相对</a> <a href="https://example.com/x">绝对</a> '
  + '<a href="mailto:a@b.c">邮件</a> <a href="#s">锚点</a></p>',
)
check(
  'href: relative, https, mailto and anchor destinations all survive',
  goodLink.includes('](/a/b)') && goodLink.includes('](https://example.com/x)')
    && goodLink.includes('](mailto:a@b.c)') && goodLink.includes('](#s)'),
  JSON.stringify(goodLink),
)
// Case-insensitivity, because a filter that only matches lowercase is trivially
// bypassed by a source document that writes `JavaScript:`.
const mixed = convert('<a href="JaVaScRiPt:alert(1)">x</a>')
check(
  'href: the scheme filter is case-insensitive',
  !/javascript:/i.test(mixed),
  JSON.stringify(mixed),
)
// Whitespace and control characters inside a URL are another bypass route; the
// HTML parser resolves entities, so an encoded `&#106;avascript:` reaches the
// filter already decoded and must be caught by the same test.
const entity = convert('<a href="&#106;avascript:alert(1)">x</a>')
check(
  'href: an entity-encoded javascript: scheme is caught after decoding',
  !/javascript:/i.test(entity),
  JSON.stringify(entity),
)
// A `data:` that is a legitimate inline image is a different question from a
// `data:` link, and Task 5 asserts the image side separately. Here the rule is
// stated for hrefs; the assertion is that no `data:` destination survives.
const dataImg = convert('<img src="data:image/png;base64,AAAA" alt="图">')
check(
  'href: an inline base64 image destination does not reach the output',
  !dataImg.includes('data:image/'),
  JSON.stringify(dataImg),
)

// ===========================================================================
// 4. Line endings — a `\r` defeats the chunker's heading regex
// ===========================================================================
// **What these two checks do and do NOT prove, stated honestly after mutation
// testing.** Deleting the `.replace(/\r\n?/g, '\n')` from `htmlToMarkdown` leaves
// this gate at 36 passed / 0 failed — measured. The reason is that the HTML
// parser folds CR and CRLF before this module ever sees the text, so the checks
// below are measuring *the parser's* contract, not this module's code.
//
// An earlier version of this comment claimed the check "is written so it would
// still fail if the parser stopped normalising". That was false, and a comment
// asserting a guard that does not exist is worse than no comment, because the
// next reader trusts it. The honest statement: these assertions pin the
// *observable product contract* (a converted document carries no `\r`, which is
// what the chunker and `gradeMarkdown` require) and they are satisfied by the
// parser. The `.replace` is kept as defence in depth and is deliberately NOT
// claimed as covered here.
//
// Kept anyway, because the contract is worth asserting at our own boundary:
// `gradeMarkdown` returns `flat-text` for any `\r` before it looks at structure,
// so if a future parser release stopped folding, every document's structure
// verdict would silently flatten — and this pair of checks is what would notice.
const crlf = convert('<h1>章节</h1>\r\n<p>正文</p>\r\n<pre><code>a\r\nb</code></pre>\r\n')
check('CRLF input produces no CR in the product', !crlf.includes('\r'), JSON.stringify(crlf))
// The CR paths a converter could plausibly leak are asserted individually rather
// than trusted to the one sample above: `<pre>` is where a producer most often
// preserves a literal CR, and a table cell goes through the gfm-table serializer.
// Measured, all three are already clean before any normalisation of ours.
for (const [name, sample] of [
  ['a paragraph', '<p>a\r\nb</p>'],
  ['a <pre> block', '<pre><code>a\r\nb</code></pre>'],
  ['a table cell', '<table><tr><th>h</th></tr><tr><td>a\r\nb</td></tr></table>'],
  ['an attribute value', '<img alt="a\r\nb" src="x.png">'],
  ['a numeric CR entity', '<p>a&#13;b</p>'],
]) {
  const produced = convert(sample)
  check(
    `CR: ${name} yields no CR in the product`,
    !produced.includes('\r'),
    JSON.stringify(produced),
  )
}
// And the grader agrees: `gradeMarkdown` reports any `\r` as `flat-text` before
// looking at structure, so a `\r` in the product is a structure loss even when
// the headings are all present.
const { gradeMarkdown } = await import(new URL('../lib/store/parse/grade.js', import.meta.url).href)
check(
  'CRLF input still grades as structured, so the headings survived the normalisation',
  gradeMarkdown(crlf) !== 'flat-text',
  JSON.stringify(crlf),
)

// ===========================================================================
// 5. script/style are not content, and neither is a comment
// ===========================================================================
const hostile = convert(
  '<h1>标题</h1><script>var secret = "SENTINEL-SCRIPT"</script>'
  + '<style>.x{color:red}</style><!-- SENTINEL-COMMENT --><p>正文</p>',
)
check('script bodies never reach the product', !hostile.includes('SENTINEL-SCRIPT'), JSON.stringify(hostile))
check('style bodies never reach the product', !hostile.includes('color:red'), JSON.stringify(hostile))
// **Comments are asserted because they DO leak by default**, which is the
// opposite of what one expects: `hast-util-to-mdast` maps a `comment` node to a
// raw `html` mdast node carrying the comment verbatim, and the serializer writes
// it through. Measured on this dependency set, `<!-- 内部备注 -->` reached the
// Markdown unchanged — so a build tool's `<!-- TODO -->` or a template's
// conditional comment would be chunked, embedded and citable as document
// content. This assertion is the reason `stripNonContent` exists.
check(
  'comments never reach the product (they leak by default)',
  !hostile.includes('SENTINEL-COMMENT') && !hostile.includes('<!--'),
  JSON.stringify(hostile),
)
// A doctype is neither content nor a comment. Measured, `hast-util-to-mdast`
// already drops `doctype` nodes, so no rule is needed in the converter — but the
// outcome is asserted here so that a future release that stopped dropping them
// would turn this red rather than quietly land `<!doctype html>` in the index.
//
// The content half of the assertion is written without `\b`: JavaScript's word
// boundary is defined against `[A-Za-z0-9_]`, so a Han character is a non-word
// character on *both* sides and `\b标题\b` can never match. That mistake made
// this check red against a correct product, which is its own small lesson about
// writing assertions in a non-Latin corpus.
const doctype = convert('<!doctype html><h1>标题</h1><p>正文</p>')
check(
  'a doctype does not reach the product as literal markup',
  !/<!doctype/i.test(doctype) && doctype.includes('标题') && doctype.includes('正文'),
  JSON.stringify(doctype),
)

// ===========================================================================
// 6. Fences: forced, so an inline `<code>` is not mistaken for a block
// ===========================================================================
const fenced = convert('<p>前</p><pre><code class="language-ts">const x = 1</code></pre><p>后</p>')
check(
  'fence: a <pre><code class="language-ts"> becomes a ```ts fence',
  /^```ts\s*$/m.test(fenced) && /^const x = 1$/m.test(fenced),
  JSON.stringify(fenced),
)
check(
  'fence: the block is closed, so `gradeMarkdown` counts it as surviving structure',
  (fenced.match(/^```/gm) ?? []).length >= 2,
  JSON.stringify(fenced),
)
// An indented code block would satisfy a reader and be invisible to the chunker's
// fence toggle. `mdast-util-to-markdown` forces a fence whenever a language is
// defined, the content is empty, or it has leading/trailing blank lines; a plain
// single-line `<pre>` is the case that could fall back, so it is asserted.
const plainPre = convert('<pre><code>line one</code></pre>')
check(
  'fence: even a fence-less <pre> is emitted as a fenced block, not indented code',
  /^```/m.test(plainPre) && !/^ {4}line one$/m.test(plainPre),
  JSON.stringify(plainPre),
)

// ===========================================================================
// 7. The envelope — the shared shape, and the two silent outcomes it forbids
// ===========================================================================
// `convertHtml` is the file-level entry the build pipeline's dispatch table
// calls. It reuses Task 1's `ParseOptions` / `ParseResult` rather than defining
// its own, so the parse stage has one result shape to read.
const scratch = mkdtempSync(join(tmpdir(), 'kb-parse-html-'))
const opts = { timeoutMs: 30_000, maxPages: 0, maxTextBytes: 8 * 1024 * 1024 }
try {
  const file = join(scratch, 'ok.html')
  writeFileSync(file, '<h1>标题</h1><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>')
  const ok = await convertHtml(file, opts)
  check(
    'envelope: a real file converts to the same text and is not a failure',
    ok.failed !== true && /^# 标题$/m.test(ok.text) && ok.structure === 'structured',
    `failed=${ok.failed} structure=${ok.structure} text=${JSON.stringify(ok.text)}`,
  )
  check(
    'envelope: the structure is the document’s own, so it is not capped to `inferred`',
    ok.structure === 'structured',
    `structure=${ok.structure}`,
  )

  // A missing file must be `failed` with a reason, never a throw: the build's
  // parse stage treats one document's failure as data about that document, and an
  // exception there reaches the pipeline's outer guard and fails the whole build.
  const missing = await convertHtml(join(scratch, 'nope.html'), opts)
  check(
    'envelope: a missing file returns failed with a reason instead of throwing',
    missing.failed === true && typeof missing.error === 'string' && missing.error.length > 0,
    `failed=${missing.failed} error=${missing.error ?? '(none)'}`,
  )

  // An empty product must be `failed`, never a silent empty success — the worst
  // outcome available, because the build records the document as parsed and
  // indexes nothing for it with no way to tell it from a legitimately empty file.
  const blank = join(scratch, 'blank.html')
  writeFileSync(blank, '<!doctype html><html><head><title>t</title></head><body>   </body></html>')
  const empty = await convertHtml(blank, opts)
  check(
    'envelope: an empty product is failed, not a silent empty success',
    empty.failed === true && empty.text === '' && typeof empty.error === 'string',
    `failed=${empty.failed} text=${JSON.stringify(empty.text)} error=${empty.error ?? '(none)'}`,
  )

  // An untagged inference is never reported as `structured`: this converter reads
  // the document's own tags, so unlike PDF it never *infers* — but a document with
  // no structure at all must still report `flat-text` honestly rather than
  // claiming a level the text does not support.
  const flat = join(scratch, 'flat.html')
  writeFileSync(flat, '<p>只有正文，没有任何标题、表格或代码块。</p><p>第二段。</p>')
  const flatResult = await convertHtml(flat, opts)
  check(
    'envelope: a document with no structure reports flat-text, honestly',
    flatResult.failed !== true && flatResult.structure === 'flat-text',
    `failed=${flatResult.failed} structure=${flatResult.structure}`,
  )

  // Cancellation is reported as a failure with a reason, checked before any work
  // is done so a cancelled build does not convert every remaining document.
  const controller = new AbortController()
  controller.abort()
  const cancelled = await convertHtml(file, { ...opts, signal: controller.signal })
  check(
    'envelope: an already-aborted signal fails with a cancellation reason',
    cancelled.failed === true && cancelled.text === '' && typeof cancelled.error === 'string',
    `failed=${cancelled.failed} error=${cancelled.error ?? '(none)'}`,
  )

  // The byte ceiling is enforced, and a truncated product is reported as such.
  const capped = await convertHtml(file, { ...opts, maxTextBytes: 8 })
  check(
    'envelope: the byte ceiling truncates and reports it',
    capped.truncated === true && Buffer.byteLength(capped.text, 'utf8') <= 8,
    `truncated=${capped.truncated} bytes=${Buffer.byteLength(capped.text, 'utf8')}`,
  )
  // The ceiling has to be honoured on a character boundary, so a multi-byte cut
  // does not leave a replacement character to be indexed as content. Asserted on
  // a Chinese document, where every character is 3 bytes — the case a byte-count
  // estimate gets wrong.
  const cjk = join(scratch, 'cjk.html')
  writeFileSync(cjk, `<h1>章节</h1><p>${'中文正文内容。'.repeat(200)}</p>`)
  const cjkCut = await convertHtml(cjk, { ...opts, maxTextBytes: 100 })
  check(
    'envelope: a multi-byte cut lands on a character boundary, leaving no U+FFFD',
    cjkCut.truncated === true
      && Buffer.byteLength(cjkCut.text, 'utf8') <= 100
      && !cjkCut.text.includes('\uFFFD'),
    `bytes=${Buffer.byteLength(cjkCut.text, 'utf8')} replacement=${cjkCut.text.includes('\uFFFD')}`,
  )

  // **The timeout arm.** Every other check in this section passes a comfortable
  // `timeoutMs`, so the `failed` branch for an overrun was asserted by nothing —
  // mutation testing on the sibling defects in this round made the same gap
  // visible here.
  //
  // A zero ceiling does NOT make the overrun deterministic, despite what an
  // earlier comment here claimed: the whole conversion can finish within the
  // same millisecond `started` was taken, `Date.now() > deadline` is then false,
  // and the arm never fires — measured at ~4% of stress runs (the final review's
  // stress test confirmed the Task-4 reviewer's unreported flake). The arm is
  // driven deterministically instead, with a genuinely slow conversion: a large
  // document (many parser nodes) under a 1 ms ceiling cannot possibly finish
  // before the deadline, so the branch always fires and the check is stable.
  //
  // It must be `failed` with a reason and must NOT be a silent empty success: the
  // build would otherwise record the document as parsed while indexing nothing.
  const slowFile = join(scratch, 'slow.html')
  const slowBody = Array.from({ length: 2000 }, (_, i) => `<p>段落 ${i}，用于撑大解析树。</p>`).join('')
  writeFileSync(slowFile, `<h1>超时样本</h1>${slowBody}`)
  const timedOut = await convertHtml(slowFile, { ...opts, timeoutMs: 1 })
  check(
    'envelope: an overrun is failed with a reason, not a silent empty success',
    timedOut.failed === true && typeof timedOut.error === 'string' && timedOut.error.length > 0,
    `failed=${timedOut.failed} error=${timedOut.error ?? '(none)'}`,
  )
  check(
    'envelope: the timeout reason names the ceiling in the user’s language',
    /超时/.test(timedOut.error ?? ''),
    timedOut.error ?? '(none)',
  )
  // The arm must report what it produced rather than discarding it silently, and
  // a truncated-or-overrun product is never claimed as `structured`.
  check(
    'envelope: an overrun is marked truncated and not graded as surviving structure',
    timedOut.truncated === true && timedOut.structure === 'flat-text',
    `truncated=${timedOut.truncated} structure=${timedOut.structure}`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ===========================================================================
// 8. The shared byte ceiling, pinned where both converters depend on it
// ===========================================================================
// `capBytes` was moved out of `pdf.ts` into `parse/cap.ts` in fix round 1: the
// HTML converter had copied it character-for-character, binary search included.
// One implementation now serves both, and its contract is asserted here directly
// rather than only through whichever converter happens to call it — because a
// shared helper whose only coverage is indirect is one refactor away from being
// changed for one caller and silently not the other.
const { capBytes } = await import(new URL('../lib/store/parse/cap.js', import.meta.url).href)

check(
  'capBytes: a text under the ceiling is returned untouched and not marked truncated',
  (() => {
    const r = capBytes('abc', 100)
    return r.text === 'abc' && r.truncated === false
  })(),
  JSON.stringify(capBytes('abc', 100)),
)
check(
  'capBytes: a zero ceiling yields empty and reports the loss, rather than meaning unlimited',
  (() => {
    const r = capBytes('abc', 0)
    return r.text === '' && r.truncated === true
  })(),
  JSON.stringify(capBytes('abc', 0)),
)
check(
  'capBytes: an empty text under a zero ceiling is not falsely reported as truncated',
  (() => {
    const r = capBytes('', 0)
    return r.text === '' && r.truncated === false
  })(),
  JSON.stringify(capBytes('', 0)),
)
// The reason the binary search exists: cutting a multi-byte character in half
// leaves a replacement character that would be indexed as content. Three-byte
// characters make every byte boundary a wrong one except every third.
check(
  'capBytes: a cut through multi-byte text never leaves a U+FFFD replacement',
  (() => {
    const cjk = '中文正文内容。'.repeat(50)
    for (let ceiling = 1; ceiling <= 40; ceiling++) {
      const r = capBytes(cjk, ceiling)
      if (r.truncated !== true || Buffer.byteLength(r.text, 'utf8') > ceiling || r.text.includes('\uFFFD')) {
        return false
      }
    }
    return true
  })(),
  'every ceiling from 1 to 40 bytes lands on a character boundary',
)
check(
  'capBytes: an emoji (a surrogate pair) is not split either',
  (() => {
    const emoji = '😀'.repeat(20)
    for (let ceiling = 1; ceiling <= 20; ceiling++) {
      const r = capBytes(emoji, ceiling)
      if (r.truncated !== true || Buffer.byteLength(r.text, 'utf8') > ceiling || r.text.includes('\uFFFD')) {
        return false
      }
    }
    return true
  })(),
  'every ceiling from 1 to 20 bytes lands on a code-point boundary',
)

// ===========================================================================
// 9. The PDF converter still works after the shared-helper extraction
// ===========================================================================
// `pdf.ts` is reviewed and frozen except for sanctioned changes, and this round
// made one: `cap` became an import of `capBytes`. `verify-parse-pdf.mjs` covers
// the converter's own behaviour, but this gate asserts the specific thing the
// refactor could have broken — that the PDF path still truncates at the ceiling
// it is given, through the same helper. A frozen file that was edited needs its
// edit verified from outside, not assumed.
{
  const { convertPdf } = await import(new URL('../lib/store/parse/pdf.js', import.meta.url).href)
  const latin = 'src/store/parse/fixtures/latin.pdf'
  const full = await convertPdf(latin, { timeoutMs: 30_000, maxPages: 10, maxTextBytes: 8 * 1024 * 1024 })
  check(
    'shared ceiling: the PDF converter still produces text after the extraction',
    full.failed !== true && full.text.trim().length > 0 && full.truncated === false,
    `failed=${full.failed} len=${full.text.length} truncated=${full.truncated}`,
  )
  const cut = await convertPdf(latin, { timeoutMs: 30_000, maxPages: 10, maxTextBytes: 16 })
  check(
    'shared ceiling: the PDF converter truncates through the shared helper',
    cut.truncated === true && Buffer.byteLength(cut.text, 'utf8') <= 16 && !cut.text.includes('\uFFFD'),
    `truncated=${cut.truncated} bytes=${Buffer.byteLength(cut.text, 'utf8')}`,
  )
  const none = await convertPdf(latin, { timeoutMs: 30_000, maxPages: 10, maxTextBytes: 0 })
  check(
    'shared ceiling: a zero ceiling makes the PDF converter produce empty, as it did before',
    none.text === '' && none.truncated === true,
    `text=${JSON.stringify(none.text)} truncated=${none.truncated}`,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
