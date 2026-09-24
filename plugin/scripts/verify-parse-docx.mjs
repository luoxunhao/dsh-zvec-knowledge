/**
 * DOCX acceptance: the derived style map against the committed fixtures.
 *
 * Task 10 of the research established the one fact that shapes this module: the
 * risk is the style *ID*, not the display language. A Chinese Word writes
 * `w:styleId="Heading1"` with `w:name="标题 1"` and converts correctly under
 * mammoth's default map. What silently loses every heading is a non-Word
 * generator whose style IDs are not `Heading<N>` and whose names are not
 * English — so the fixtures pin both halves: the two default-map-easy cases
 * must not regress, and the two default-map-impossible cases must now convert.
 *
 * Every heading count here was measured twice — once with the default map (the
 * baseline, in `probe-docx-default-map.mjs`), once through the real converter —
 * and the difference between them is the derived map's entire reason to exist.
 *
 * Runs offline: the fixtures are committed, the converter is local.
 *
 * Usage: node scripts/verify-parse-docx.mjs
 */

import { convertDocx } from '../lib/store/parse/docx.js'

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

/** The resource envelope every case shares; generous, since fixtures are tiny. */
const opts = { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 8 * 1024 * 1024 }

/** Heading counts in converted text, by level. */
const headingsOf = (text) => ({
  h1: (text.match(/^# /gm) ?? []).length,
  h2: (text.match(/^## /gm) ?? []).length,
})

const FIXTURES = 'src/store/parse/fixtures'

// ---------------------------------------------------------------------------
// 1. The default-map cases do not regress
// ---------------------------------------------------------------------------
// `Heading1` style IDs convert under mammoth's own map, so the derived map must
// at minimum preserve that. These two are the control group.
const en = await convertDocx(`${FIXTURES}/docx-en.docx`, opts)
const enCounts = headingsOf(en.text)
check('英文样式名（Heading1）→ # 与 ##', enCounts.h1 >= 1 && enCounts.h2 >= 1,
  `h1=${enCounts.h1} h2=${enCounts.h2} failed=${en.failed}`)
check('英文样式名产物无 CRLF', !en.text.includes('\r'))
check('英文样式名不被误判为失败', en.failed !== true, en.error ?? '')

const zh = await convertDocx(`${FIXTURES}/docx-zh.docx`, opts)
const zhCounts = headingsOf(zh.text)
check('中文名 + 英文 styleId（标题 1）→ # 与 ##', zhCounts.h1 >= 1 && zhCounts.h2 >= 1,
  `h1=${zhCounts.h1} h2=${zhCounts.h2} failed=${zh.failed}`)

// ---------------------------------------------------------------------------
// 2. The derived map's reason to exist
// ---------------------------------------------------------------------------
// styleId `1` + name `标题 1`: the default map loses both headings and emits
// exactly `Unrecognised paragraph style` — the only visible signal. Measured
// baseline: h1=0 h2=0 with 2 warnings. The derived map must recover both
// levels via the name-selector form (`p.1` is not a legal CSS identifier).
const nonstd = await convertDocx(`${FIXTURES}/docx-nonstd.docx`, opts)
const nonstdCounts = headingsOf(nonstd.text)
check('数字 styleId（非 Word 生成器）→ 两级标题全部恢复',
  nonstdCounts.h1 >= 1 && nonstdCounts.h2 >= 1,
  `h1=${nonstdCounts.h1} h2=${nonstdCounts.h2}（默认映射基线 0/0）`)
check('数字 styleId 的产物无 CRLF', !nonstd.text.includes('\r'))

// A custom style name marked only by `w:outlineLvl` — mammoth ignores that
// attribute entirely, so without reading styles.xml the heading is gone.
const outline = await convertDocx(`${FIXTURES}/docx-outline.docx`, opts)
const outlineCounts = headingsOf(outline.text)
check('仅 outlineLvl 的自定义样式 → 标题恢复',
  outlineCounts.h1 >= 1 && outlineCounts.h2 >= 1,
  `h1=${outlineCounts.h1} h2=${outlineCounts.h2}（默认映射基线 0/0）`)

// ---------------------------------------------------------------------------
// 3. Verdict honesty
// ---------------------------------------------------------------------------
// A document with headings but no table/fence is `inferred`, never `structured`:
// the levels came from the source's own style table, but nothing else did.
check('有标题无表格的 DOCX 判 inferred（不冒充 structured）',
  zh.structure === 'inferred' && nonstd.structure === 'inferred' && outline.structure === 'inferred',
  `zh=${zh.structure} nonstd=${nonstd.structure} outline=${outline.structure}`)

// ---------------------------------------------------------------------------
// 4. Images and the resource envelope
// ---------------------------------------------------------------------------
// mammoth's default inlines base64, which would put megabytes of opaque text
// into the indexed document. The converter drops the payload and keeps a
// placeholder.
const image = await convertDocx(`${FIXTURES}/docx-withimage.docx`, opts)
check('内嵌图片不产生 base64', !image.text.includes('data:image/'))
check('图片位置保留为占位符', /图片/.test(image.text), image.text.slice(0, 60))
check('含图产物体量可控（无 base64 后应远小于原图）',
  Buffer.byteLength(image.text) < 256 * 1024,
  `${Buffer.byteLength(image.text)} bytes`)

// ---------------------------------------------------------------------------
// 5. A corrupt package fails by name rather than throwing
// ---------------------------------------------------------------------------
// The zip-bomb fixture is a well-formed ZIP whose parts do not parse. mammoth
// throws; the converter must catch and return a verdict, because an exception
// here would propagate to the build's outer guard and fail the whole build —
// the exact containment the parse stage exists to provide.
const bomb = await convertDocx(`${FIXTURES}/docx-zipbomb.docx`, opts)
check('损坏包记 failed 而非抛出', bomb.failed === true && typeof bomb.error === 'string',
  `failed=${bomb.failed} error=${bomb.error ?? '(none)'}`)
check('损坏包的错误以 DOCX 开头（调用方无需再猜格式）', /^DOCX/.test(bomb.error ?? ''),
  bomb.error ?? '(none)')
check('损坏包无文本产物', bomb.text === '')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
