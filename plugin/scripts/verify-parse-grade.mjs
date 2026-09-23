/**
 * Document-parsing acceptance: the structure judge.
 *
 * Every converter that follows is judged by `gradeMarkdown`, so the judge has to
 * be worth trusting before any converter is measured against it. A judge that
 * answers `structured` for anything is worse than no judge at all: it would let a
 * converter that flattens a document into prose pass every later task, and the
 * damage — one section per document, section paths gone — only shows up at
 * retrieval time, where nothing points back at the converter.
 *
 * So this gate asserts both directions. The positive samples pin what "structure
 * survived" means; the negative samples pin what it must *not* mean, each one a
 * real conversion failure (`turndown`'s default setext headings, turndown's
 * indented code blocks, a table without its separator row, CRLF output). Step 6
 * of the task additionally proves the judge is not a tautology by breaking it on
 * purpose and watching the positive sample go red.
 *
 * Uses the `check(name, ok, detail)` two-column accounting the other gates use.
 * Runs offline, with no API key: the judge is a pure function over text.
 *
 * Usage: node scripts/verify-parse-grade.mjs
 */

import { gradeMarkdown } from '../lib/store/parse/grade.js'

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

/**
 * Grade a sample and render the answer for a failure line.
 * @param text - the converted Markdown.
 * @returns the level, as a quoted string.
 */
const level = text => JSON.stringify(gradeMarkdown(text))

// ---------------------------------------------------------------------------
// 1. A document that kept its structure is recognised
// ---------------------------------------------------------------------------
// ATX heading, pipe table (header row + separator row), three-backtick fence:
// the three constructs `chunk.ts` reads, all present and all well-formed.
const good = [
  '# 标题',
  '',
  '正文段落。',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '```',
].join('\n')

check('合格样本判 structured', gradeMarkdown(good) === 'structured', level(good))

// ---------------------------------------------------------------------------
// 2. Structure that did not survive is not credited
// ---------------------------------------------------------------------------
// setext heading: what `turndown` emits by default when `headingStyle` is not set
// to `atx`. The chunker only reads `#`-prefixed headings, so this is one section.
const setext = '标题\n====\n\n正文'
check('setext 标题不合格（不得 structured）', gradeMarkdown(setext) !== 'structured', level(setext))

// Indented code block: the other turndown default. No fence, so no protected
// region, so the code's own `#` characters would be read as headings later.
const indented = '# 标题\n\n    缩进代码\n'
check('缩进代码不算围栏', gradeMarkdown(indented) !== 'structured', level(indented))

// A table missing its separator row: `chunk.ts` locates tables by the separator,
// so this renders as prose to the chunker even though it looks like a table.
const noSep = '# 标题\n\n| 列A | 列B |\n| 1 | 2 |\n'
check('缺分隔行的表不合格', gradeMarkdown(noSep) !== 'structured', level(noSep))

// CRLF: `^(#{1,6})\s+(.*)$` never matches when `$` sits before `\r`. The judge
// reports the honest answer — structure not recovered — rather than throwing.
const crlf = '# 标题\r\n\r\n正文\r\n'
check('CRLF 判 flat-text', gradeMarkdown(crlf) === 'flat-text', level(crlf))

// Prose, plus the empty document, which is flat too.
const prose = '就是一段话，没有结构。'
check('纯段落判 flat-text', gradeMarkdown(prose) === 'flat-text', level(prose))
check('空文档判 flat-text', gradeMarkdown('') === 'flat-text', level(''))

// A heading with no body structure: real headings, so not flat, but nothing was
// recovered beyond the outline the source gave us.
const outline = '# 标题\n\n正文\n\n## 小节\n\n更多正文\n'
check('仅 ATX 标题判 inferred', gradeMarkdown(outline) === 'inferred', level(outline))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
