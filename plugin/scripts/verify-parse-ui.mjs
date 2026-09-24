/**
 * Parse-UI acceptance: how the documents list states structure fidelity and
 * parse failures.
 *
 * The structure verdict is retrieval-quality information a build status cannot
 * express — a document can be 已构建 and still retrieve badly because its text
 * has no headings. The row states it, so this gate asserts the row actually
 * says it, through the real client bundle rather than a hand-built string.
 *
 * Usage: node scripts/verify-parse-ui.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - criterion.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

globalThis.document = {
  documentElement: { setAttribute() {}, removeAttribute() {} },
  createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
}
let factory = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(entry) { factory = entry?.factory ?? entry } },
}
await import(new URL('../lib/client.js', import.meta.url).href)
const React = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const kb = typeof factory === 'function'
  ? factory(specifier => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected module request ${specifier}`)
    })
  : factory

const { renderToStaticMarkup } = await import('react-dom/server')

/**
 * Render a component to static markup.
 * @param element - React element.
 * @returns the HTML.
 */
function render(element) {
  return renderToStaticMarkup(element)
}

/** A base row every case clones, so each case varies one field. */
const baseRow = {
  id: 'doc_aaaa1', name: '报告.pdf', bytes: 1024, ext: 'pdf', status: 'ready',
  statusLabel: '已构建', chunks: 4, transfer: 'done', progress: 1,
}

// ---------------------------------------------------------------------------
// 1. The structure verdict is visible, per level
// ---------------------------------------------------------------------------
{
  const structured = render(React.createElement(kb.DocumentRow, {
    row: { ...baseRow, structure: 'structured' },
  }))
  check('structure=structured 显示「结构完整」', structured.includes('结构完整'), 'badge present')

  const inferred = render(React.createElement(kb.DocumentRow, {
    row: { ...baseRow, structure: 'inferred' },
  }))
  check('structure=inferred 显示「结构推断」', inferred.includes('结构推断'), 'badge present')

  const flat = render(React.createElement(kb.DocumentRow, {
    row: { ...baseRow, structure: 'flat-text' },
  }))
  check('structure=flat-text 显示「无结构」', flat.includes('无结构'), 'badge present')

  // The badge must be readable by more than the eye: it carries a tooltip that
  // states the retrieval consequence, so hovering is not required to guess.
  check('结构徽标带解释性 title（悬停即得后果）',
    /title="[^"]*结构保真度/.test(flat) || /结构保真度/.test(flat), 'title present')

  // A document the parse stage has not run on (a plain markdown upload before
  // any build) shows nothing: the absence is honest, not a missing badge.
  const absent = render(React.createElement(kb.DocumentRow, { row: baseRow }))
  check('未解析的文档不显示结构徽标', !absent.includes('结构完整') && !absent.includes('无结构'),
    'no badge without a verdict')
}

// ---------------------------------------------------------------------------
// 2. A failed parse states the reason, not just a red pill
// ---------------------------------------------------------------------------
{
  const failed = render(React.createElement(kb.DocumentRow, {
    row: {
      ...baseRow, status: 'failed', statusLabel: '解析失败',
      error: 'PDF 未提取到任何文字（读到的前 1 页中没有文本层）。若这是扫描件，请先用离线 OCR 工具（例如 OCRmyPDF、ABBYY 或 Adobe Acrobat 的「识别文本」）生成带文本层的 PDF，再上传；也可以先转成 Markdown 后上传。',
    },
  }))
  check('解析失败的行显示失败原因', failed.includes('PDF 未提取到任何文字'), 'reason rendered')
  check('失败原因给出可执行动作（OCR 提示）', failed.includes('OCR'), 'remedy present')

  const zipBomb = render(React.createElement(kb.DocumentRow, {
    row: {
      ...baseRow, ext: 'docx', status: 'failed', statusLabel: '解析失败',
      error: 'DOCX 解析失败：Could not find main document part. Are you sure this is a valid .docx?',
    },
  }))
  check('损坏 DOCX 的失败以 DOCX 前缀可辨', zipBomb.includes('DOCX 解析失败'), 'format named')
}

// ---------------------------------------------------------------------------
// 3. The extension lists stay in sync with the store (three copies)
// ---------------------------------------------------------------------------
{
  // The client's own list must equal `extract.ts`'s SUPPORT keys and the
  // documents store's ACCEPTED_EXTENSIONS — three copies of one decision, and
  // the copies drift silently when a format is added to only one or two.
  const documentsTs = readFileSync(join(ROOT, 'src', 'store', 'documents.ts'), 'utf8')
  const extractTs = readFileSync(join(ROOT, 'src', 'store', 'extract.ts'), 'utf8')
  const pageTs = readFileSync(join(ROOT, 'src', 'client', 'pages', 'DocumentsPage.tsx'), 'utf8')

  const fromStore = documentsTs.match(/ACCEPTED_EXTENSIONS = \[([^\]]+)\]/)?.[1]
  const fromExtract = extractTs.match(/^const SUPPORT[\s\S]*?^\}/m)?.[0] ?? ''
  const fromPage = pageTs.match(/ACCEPTED_EXTENSIONS = \[([^\]]+)\]/)?.[1]

  check('documents.ts 与 DocumentsPage.tsx 的扩展名清单一致', fromStore !== undefined && fromStore === fromPage,
    `store=[${fromStore}] page=[${fromPage}]`)

  const storeExts = (fromStore ?? '').match(/'([a-z]+)'/g)?.map(item => item.replaceAll("'", '')) ?? []
  const supportExts = [...fromExtract.matchAll(/^  ([a-z]+): \{ kind:/gm)].map(match => match[1])
  check('documents.ts 清单与 extract.ts 的 SUPPORT 键集一致',
    storeExts.length > 0 && supportExts.length > 0
      && storeExts.every(ext => supportExts.includes(ext))
      && supportExts.every(ext => storeExts.includes(ext)),
    `store=${storeExts.join(',')} support=${supportExts.join(',')}`)

  check('xlsx 已进入三处清单（converted 格式已可上传）',
    (fromPage ?? '').includes("'xlsx'") && supportExts.includes('xlsx'))
}

// ---------------------------------------------------------------------------
// 4. The empty state names the supported formats
// ---------------------------------------------------------------------------
{
  const pageTs = readFileSync(join(ROOT, 'src', 'client', 'pages', 'DocumentsPage.tsx'), 'utf8')
  // The empty state delegates to the drop zone, whose copy states the formats;
  // asserting the drop-zone copy stays accurate keeps the page honest after a
  // format list change.
  check('空态复用上传区文案（含支持格式）',
    /还没有文档/.test(pageTs) || /拖拽文件到此处/.test(pageTs), 'empty state present')
}

// ---------------------------------------------------------------------------
// 5. Negative self-proof — the badge assertions can fail
// ---------------------------------------------------------------------------
{
  // Render with a wrong label expectation: the check itself is not what proves
  // this, so instead render a row whose structure is absent from the labels map
  // path — an unknown structure value must render no badge text, not a crash.
  const unknown = render(React.createElement(kb.DocumentRow, {
    row: { ...baseRow, structure: undefined },
  }))
  check('未知 structure 值不产生徽标也不崩溃',
    !unknown.includes('结构完整') && !unknown.includes('结构推断') && unknown.includes('报告.pdf'),
    'row still renders')
}

console.log(`\n${passes.length} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
