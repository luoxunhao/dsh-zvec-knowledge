/**
 * Tabular/JSON acceptance: XLSX, CSV and the JSON renderer.
 *
 * The contract under test is shared, so the assertions are grouped by what they
 * protect rather than by format: the pipe-table shape the chunker reads
 * (header + separator, cells escaped), the per-sheet/per-file heading that gives
 * heading-mode chunking an anchor, CRLF removal, the honest empty-product
 * failure, and the JSON renderer's three outcomes (fence / walk / preserve).
 *
 * Every fixture is committed and authored by this repository, so the gate is
 * hermetic: nothing here depends on a machine-local file.
 *
 * Usage: node scripts/verify-parse-tabular.mjs
 */

import { convertXlsx, convertCsv, rowsToMarkdownTable } from '../lib/store/parse/tabular.js'
import { convertJson } from '../lib/store/parse/json.js'

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

const opts = { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 8 * 1024 * 1024 }
const FIXTURES = 'src/store/parse/fixtures'

// ---------------------------------------------------------------------------
// 1. The shared table renderer
// ---------------------------------------------------------------------------
const table = rowsToMarkdownTable([['列A', '列B'], ['1', '2']], 'Sheet1')
check('表头行存在', table.includes('| 列A | 列B |'))
check('分隔行紧随表头', /^\|[\s:|-]+\|\s*$/m.test(table))
check('表名成为 ## 标题', /^## Sheet1$/m.test(table))

// A cell containing a pipe would forge a column boundary; one containing a
// newline would forge a row. Both are replaced, because the table shape is
// what the chunker anchors on.
const hostile = rowsToMarkdownTable([['a|b', 'c\nd']])
check('单元格内竖线被替换', !hostile.includes('| a|b'))
check('单元格内换行被替换（同一行内）', hostile.includes('c d') && !/a\|b.*\n[^|]*d/.test(hostile))

// ---------------------------------------------------------------------------
// 2. CSV
// ---------------------------------------------------------------------------
const csv = await convertCsv(`${FIXTURES}/sample.csv`, opts)
check('CSV 产出管道表', /^\|[\s:|-]+\|\s*$/m.test(csv.text))
check('CSV 表头在表中', csv.text.includes('名称'))
check('CSV 无 CRLF', !csv.text.includes('\r'))
check('CSV 的引号内换行被压平为空格', !csv.text.includes('多行\n说明'))
check('CSV 的文件名成为标题', /^## sample$/m.test(csv.text))

// A quoted-delimiter CSV: the same fixture with CRLF endings must land identically.
const crlf = await convertCsv(`${FIXTURES}/crlf.csv`, opts)
check('CRLF CSV 归一化为 LF', !crlf.text.includes('\r') && crlf.text.trim() !== '')

// ---------------------------------------------------------------------------
// 3. XLSX
// ---------------------------------------------------------------------------
const xlsx = await convertXlsx(`${FIXTURES}/sample.xlsx`, opts)
check('XLSX 每个 sheet 一个标题', /^## 设备清单$/m.test(xlsx.text) && /^## 维保记录$/m.test(xlsx.text),
  (xlsx.text.match(/^## /gm) ?? []).join(','))
check('XLSX 表格含表头与分隔行', /^\|[\s:|-]+\|\s*$/m.test(xlsx.text))
check('XLSX 成功而未失败', xlsx.failed !== true, xlsx.error ?? '')

// ---------------------------------------------------------------------------
// 4. The honest empty-product failure
// ---------------------------------------------------------------------------
// An empty file parses to nothing; the converter must refuse rather than index
// a document with no content — the worst available outcome, since nothing
// distinguishes it from a clean conversion of nothing.
const emptyCsv = await convertCsv(`${FIXTURES}/empty.csv`, opts)
check('空 CSV 明确失败而非静默产空索引', emptyCsv.failed === true, `failed=${emptyCsv.failed}`)
check('空 CSV 的失败具名格式', /^CSV/.test(emptyCsv.error ?? ''))

// ---------------------------------------------------------------------------
// 5. JSON: three outcomes, each honest
// ---------------------------------------------------------------------------
const small = await convertJson(`${FIXTURES}/small.json`, opts)
check('小 JSON 整篇三反引号围栏', /^```json/m.test(small.text))

const big = await convertJson(`${FIXTURES}/big.json`, opts)
check('大 JSON 走键路径标题（walk 路径）', (big.text.match(/^## /gm) ?? []).length >= 100,
  `${(big.text.match(/^## /gm) ?? []).length} headings`)
check('大 JSON 的键路径标题可检索（判 inferred）', big.structure === 'inferred', big.structure)

// Unparseable JSON is preserved raw and reported flat — the honest answer,
// since the document survives but carries no recoverable structure.
const bad = await convertJson(`${FIXTURES}/bad.json`, opts)
check('非法 JSON 保留原文（围栏包裹）', bad.text.includes('```json') && bad.text.includes('{not json'))
check('非法 JSON 判 flat-text 且不失败（降级而非丢弃）',
  bad.structure === 'flat-text' && bad.failed !== true,
  `structure=${bad.structure} failed=${bad.failed}`)

// A `null` document parses fine and fences as `null` — one line with no
// heading, so `gradeMarkdown` calls it flat. That is the honest verdict: the
// document survives verbatim, and there is genuinely nothing to anchor on. It
// is not refused, because the content question ("is one word of content worth
// indexing?") belongs to the user, not the converter.
const nullDoc = await convertJson(`${FIXTURES}/null.json`, opts)
check('null JSON 如实保留为围栏且判 flat-text',
  nullDoc.text.includes('```json') && nullDoc.structure === 'flat-text' && nullDoc.failed !== true,
  `structure=${nullDoc.structure} failed=${nullDoc.failed}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
