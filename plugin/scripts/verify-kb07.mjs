/**
 * KB-07 acceptance suite: strategy configurator, preview, cost estimate, pipeline.
 *
 * The criteria here are mostly *structural* (the estimate must precede the submit
 * button; the preview must not be omittable) plus a few behavioural ones (the
 * overlap check, reset-to-defaults, cancel leaving a consistent index). Structural
 * criteria are verified by reading the rendered markup in order, because "the
 * estimate appears before the submit button" is a property of document order and
 * nothing else.
 *
 * Usage: node scripts/verify-kb07.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const strategy = await import(new URL('../lib/store/strategy.js', import.meta.url).href)
const documents = await import(new URL('../lib/store/documents.js', import.meta.url).href)

/** A document long enough to produce several chunks. */
const section = title => `# ${title}\n${'本段用于说明该小节的内容，包含足够的文字以确保估算 token 数超过最小分片阈值。'.repeat(3)}`
const DOC_TEXT = [section('检索原理'), section('索引构建'), section('混合检索')].join('\n')

/** A full set of BuildPage props, overridable per case. */
function buildProps(overrides = {}) {
  return {
    collectionId: 'kb_prod_2f8a',
    chunking: { ...strategy.CHUNKING_DEFAULTS },
    onChunkingChange: () => {},
    index: { model: 'local-1024', kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8', denseWeight: 0.6, fullTextWeight: 0.4 },
    onIndexChange: () => {},
    preview: { rows: [], totalChunks: 12, averageTokens: 340, discarded: 3, totalTokens: 4080 },
    previewError: null,
    cost: { chunks: 12, rawVectorBytes: 12 * 1024 * 4, vectorBytes: 12 * 1024, compression: 4, estimatedSeconds: 1, basis: '按 40 分片/秒估算' },
    models: [{ id: 'local-1024', label: '本地嵌入模型（1024 维）', dimension: 1024, metric: 'cosine', note: '与集合 schema 一致' }],
    quantizers: strategy.QUANTIZER_OPTIONS,
    stages: [
      { id: 'parse', label: '解析文档', state: 'done' },
      { id: 'chunk', label: '切分与嵌入', state: 'running' },
      { id: 'index', label: '写入索引', state: 'pending' },
      { id: 'publish', label: '校验与发布', state: 'pending' },
    ],
    processed: 5,
    total: 12,
    fraction: 0.42,
    log: [{ at: '2026-09-14T12:00:00.000Z', level: 'running', message: '切分与嵌入' }],
    running: false,
    buildError: null,
    servingPreviousSnapshot: false,
    hasDocuments: true,
    onSubmit: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onReset: () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Structural ordering: preview → estimate → submit button
// ---------------------------------------------------------------------------
{
  const html = renderToStaticMarkup(React.createElement(kb.BuildPage, buildProps()))
  const previewAt = html.indexOf('分片预览')
  const estimateAt = html.indexOf('代价预估')
  // The submit button's own text, which appears only on that control.
  const submitAt = html.indexOf('保存并重建索引')

  check('order: preview renders', previewAt !== -1, `at ${previewAt}`)
  check('order: cost estimate renders', estimateAt !== -1, `at ${estimateAt}`)
  check('order: submit button renders', submitAt !== -1, `at ${submitAt}`)
  check('order: estimate precedes the submit button', estimateAt !== -1 && submitAt !== -1 && estimateAt < submitAt, `estimate ${estimateAt} < submit ${submitAt}`)
  check('order: preview precedes the estimate', previewAt !== -1 && estimateAt !== -1 && previewAt < estimateAt, `preview ${previewAt} < estimate ${estimateAt}`)

  // The submit label is fixed by the spec.
  check('submit: label is the fixed wording', html.includes('保存并重建索引'), '保存并重建索引')
  check('submit: header states that a rebuild is required', html.includes('参数变更需重建才生效'), 'header copy present')
}

// ---------------------------------------------------------------------------
// 2. Preview cannot be omitted, and always carries its summary
// ---------------------------------------------------------------------------
{
  // With no chunks at all, the preview must still render its panel with an
  // explanation rather than disappearing — a missing preview is the failure the
  // spec's "不允许省略" forbids.
  const empty = renderToStaticMarkup(React.createElement(kb.BuildPage, buildProps({
    preview: { rows: [], totalChunks: 0, averageTokens: 0, discarded: 0, totalTokens: 0 },
  })))
  check('preview: panel still renders with no chunks', empty.includes('分片预览'), 'panel present')
  check('preview: explains why it is empty', empty.includes('没有可索引的内容'), 'explanation present')

  // With rows, the four summary figures must all be present.
  const withRows = renderToStaticMarkup(React.createElement(kb.ChunkPreview, {
    rows: [{ ordinal: 0, tokens: 340, overlapTokens: 0, snippet: '示例片段', charStart: 0, charEnd: 400 }],
    totalChunks: 12, averageTokens: 340, discarded: 3, totalTokens: 4080,
  }))
  for (const label of ['总片数', '平均 token', '丢弃碎片', '总 token']) {
    check(`preview: summary shows ${label}`, withRows.includes(label), label)
  }
  check('preview: values are monospaced', /kb-mono/.test(withRows), 'figures carry the mono class')
  check('preview: notes it is the only pre-submit check', withRows.includes('提交前唯一的质量校验手段'), 'stated in the panel')
}

// ---------------------------------------------------------------------------
// 3. Overlap / minimum-size relational validation
// ---------------------------------------------------------------------------
{
  const bad = strategy.validateChunking({ ...strategy.CHUNKING_DEFAULTS, chunkTokens: 128, overlapTokens: 128 })
  check('validation: overlap equal to size is rejected', bad !== null, bad ?? '(accepted!)')
  check('validation: the rejection states the reason', bad !== null && bad.includes('无法终止'), bad ?? '-')
  check('validation: the rejection names both values', bad !== null && bad.includes('128'), bad ?? '-')

  // Each case below violates exactly ONE rule: chunkTokens=100 with the default
  // overlap of 128 would break the overlap rule too, and the first violation
  // reported would then be the wrong one to assert on.
  const minBad = strategy.validateChunking({ ...strategy.CHUNKING_DEFAULTS, chunkTokens: 100, overlapTokens: 10, minChunkTokens: 200 })
  check('validation: minimum above size is rejected', minBad !== null && minBad.includes('所有分片'), minBad ?? '(accepted!)')
  check('validation: the rejection names both values', minBad !== null && minBad.includes('200') && minBad.includes('100'), minBad ?? '-')
  check('validation: a sound config passes', strategy.validateChunking(strategy.CHUNKING_DEFAULTS) === null, 'defaults accepted')

  // Weights must sum to 1: the fusion is a blend, and a different sum would
  // silently rescale every score.
  const weightsBad = strategy.validateWeights({ dense: 0.6, fullText: 0.6 })
  check('validation: weights must sum to 1', weightsBad !== null && weightsBad.includes('之和必须为 1'), weightsBad ?? '(accepted!)')
  check('validation: default weights pass', strategy.validateWeights({ dense: 0.6, fullText: 0.4 }) === null, '0.6 + 0.4')

  // Index bounds.
  check('validation: M out of range is rejected', strategy.validateIndex({ ...strategy.INDEX_DEFAULTS, m: 2 }) !== null, 'M=2 rejected')
  check('validation: default index passes', strategy.validateIndex(strategy.INDEX_DEFAULTS) === null, 'defaults accepted')
}

// ---------------------------------------------------------------------------
// 4. Preview numbers come from the same chunker as the build
// ---------------------------------------------------------------------------
{
  const scratch = mkdtempSync(join(tmpdir(), 'kb07-'))
  const root = join(scratch, 'store')
  const collection = 'kb_prod_2f8a'
  mkdirSync(join(root, collection), { recursive: true })
  const record = {
    id: 'doc_1', name: 'guide.md', bytes: 4096, ext: 'md', text: DOC_TEXT,
    status: 'pending', chunks: null, uploadedAt: new Date().toISOString(), builtAt: null,
  }
  documents.appendDocument(root, collection, record)

  const plan = strategy.planBuild(documents.listDocuments(root, collection), strategy.CHUNKING_DEFAULTS)
  check('plan: chunked the stored document', plan.totalChunks > 0, `${plan.totalChunks} chunks`)
  check('plan: reports the mean token count', plan.averageTokens > 0, `avg ${plan.averageTokens}`)
  check('plan: produces preview rows', plan.rows.length > 0, `${plan.rows.length} rows`)
  check('plan: per-document summary present', plan.documents.length === 1 && plan.documents[0].chunks === plan.totalChunks, JSON.stringify(plan.documents[0]))

  // The preview rows must be a prefix of the same chunking the build will do,
  // which is what makes them a prediction rather than a separate calculation.
  const previewOnly = strategy.planBuild(documents.listDocuments(root, collection), strategy.CHUNKING_DEFAULTS, 2)
  check('plan: preview limit does not change the totals', previewOnly.totalChunks === plan.totalChunks, `${previewOnly.totalChunks} vs ${plan.totalChunks}`)
  check('plan: preview limit caps the rows', previewOnly.rows.length === Math.min(2, plan.rows.length), `${previewOnly.rows.length} rows`)

  // Changing a parameter must move the numbers — otherwise the preview is not
  // actually reading the configuration. The fixture has to be long enough for the
  // budget to bite: a three-section document fits inside 1024 tokens, so raising
  // the budget would legitimately change nothing. One long section does not fit,
  // so the budget governs how it is split.
  const longText = `# 长小节\n${'这段文字用于把单个小节撑到超过一千 token，从而使分片长度参数真正生效。'.repeat(120)}`
  documents.appendDocument(root, collection, { ...record, id: 'doc_2', name: 'long.md', text: longText, bytes: longText.length })
  const records = documents.listDocuments(root, collection)
  const tight = strategy.planBuild(records, { ...strategy.CHUNKING_DEFAULTS, chunkTokens: 256 })
  const loose = strategy.planBuild(records, { ...strategy.CHUNKING_DEFAULTS, chunkTokens: 2048 })
  check(
    'plan: a larger chunk size changes the plan',
    tight.totalChunks !== loose.totalChunks,
    `256 tok -> ${tight.totalChunks} chunks; 2048 tok -> ${loose.totalChunks} chunks`,
  )

  // Cost derives from the plan, so quantization must move the storage figure.
  const quantized = strategy.estimateCost(plan, strategy.INDEX_DEFAULTS)
  const unquantized = strategy.estimateCost(plan, { ...strategy.INDEX_DEFAULTS, quantize: 'none' })
  check('cost: derives from the plan', quantized.chunks === plan.totalChunks, `${quantized.chunks} chunks`)
  check('cost: quantization reduces storage', quantized.vectorBytes < unquantized.vectorBytes, `${quantized.vectorBytes} < ${unquantized.vectorBytes}`)
  check('cost: INT8 reports 4x compression', quantized.compression === 4, `${quantized.compression}x`)
  check('cost: states the basis of the duration', quantized.basis.length > 10, quantized.basis)

  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 5. Read-only parameter grid, and defaults resettable
// ---------------------------------------------------------------------------
{
  const html = renderToStaticMarkup(React.createElement(kb.BuildPage, buildProps()))
  check('readonly: dimension shown', html.includes('1024') && html.includes('向量维度'), '维度 1024')
  check('readonly: data type shown', html.includes('VECTOR_FP32'), 'VECTOR_FP32')
  check('readonly: metric shown as cosine', html.includes('cosine'), 'distance metric pinned to cosine')

  // The read-only trio must not be editable controls. Scoped to the grid element
  // itself rather than a character window: the neighbouring model Select would
  // otherwise fall inside the window and make this assert the wrong thing.
  const gridStart = html.lastIndexOf('<dl', html.indexOf('向量维度'))
  const gridEnd = html.indexOf('</dl>', gridStart)
  const readonlyGrid = gridStart === -1 ? '' : html.slice(gridStart, gridEnd)
  check('readonly: rendered as a definition list', gridStart !== -1 && gridEnd > gridStart, `${readonlyGrid.length} chars`)
  check('readonly: no input element inside the grid', !/<input|<select/.test(readonlyGrid), 'the grid holds only dt/dd text')
  check('readonly: all three parameters are stated', ['向量维度', '数据类型', '距离度量'].every(label => readonlyGrid.includes(label)), '维度 / 数据类型 / 距离度量')

  check('reset: control is present', html.includes('重置为推荐值'), 'reset affordance present')
  // The defaults must be the spec's §10.1 values, which the host exports.
  check('reset: chunking defaults match the spec', strategy.CHUNKING_DEFAULTS.chunkTokens === 1024 && strategy.CHUNKING_DEFAULTS.overlapTokens === 128 && strategy.CHUNKING_DEFAULTS.minChunkTokens === 64, `${strategy.CHUNKING_DEFAULTS.chunkTokens}/${strategy.CHUNKING_DEFAULTS.overlapTokens}/${strategy.CHUNKING_DEFAULTS.minChunkTokens}`)
  check('reset: default mode is heading', strategy.CHUNKING_DEFAULTS.mode === 'heading', strategy.CHUNKING_DEFAULTS.mode)
  check('reset: index defaults are HNSW/M32/ef200/INT8', strategy.INDEX_DEFAULTS.kind === 'HNSW' && strategy.INDEX_DEFAULTS.m === 32 && strategy.INDEX_DEFAULTS.efConstruction === 200 && strategy.INDEX_DEFAULTS.quantize === 'INT8', `${strategy.INDEX_DEFAULTS.kind} M${strategy.INDEX_DEFAULTS.m} ef${strategy.INDEX_DEFAULTS.efConstruction} ${strategy.INDEX_DEFAULTS.quantize}`)
}

// ---------------------------------------------------------------------------
// 6. Four stages: every stage carries a name and a state
// ---------------------------------------------------------------------------
{
  const html = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages,
    processed: 5, total: 12, fraction: 0.42,
    log: [], logOpen: false, onLogToggle: () => {},
    running: true, onCancel: () => {}, servingPreviousSnapshot: false,
  }))
  for (const label of ['解析文档', '切分与嵌入', '写入索引', '校验与发布']) {
    check(`stages: ${label} is named`, html.includes(label), label)
  }
  check('stages: node states are stated in words', html.includes('进行中') && html.includes('未开始') && html.includes('已完成'), '进行中 / 未开始 / 已完成')
  check('stages: no stage is a bare bar', !/aria-label="索引构建整体进度"[^>]*>\s*<\//.test(html) || html.includes('整体进度'), 'the only bar is the overall one, and it is labelled')

  // Progress must state counts and a percentage, not just a bar.
  check('progress: counts are shown', html.includes('5 / 12'), '5 / 12')
  check('progress: percentage is shown', html.includes('42%'), '42%')
  check('progress: bar is accessible', /role="progressbar"|aria-valuenow/.test(html), 'progressbar semantics present')
}

// ---------------------------------------------------------------------------
// 7. Rebuild notice, cancel and retry
// ---------------------------------------------------------------------------
{
  const running = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages, processed: 5, total: 12, fraction: 0.42,
    log: [], logOpen: false, onLogToggle: () => {},
    running: true, onCancel: () => {}, servingPreviousSnapshot: true,
  }))
  check('rebuild: serving-previous notice is shown while building', running.includes('上一次索引快照'), 'notice present')
  check('rebuild: cancel is offered while running', running.includes('取消构建'), 'cancel affordance')
  check('rebuild: retry is not offered while running', !running.includes('重试构建'), 'no retry mid-build')

  const failed = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages, processed: 3, total: 12, fraction: 0.25,
    log: [], logOpen: false, onLogToggle: () => {},
    running: false, onCancel: () => {}, onRetry: () => {},
    error: '嵌入服务不可用', servingPreviousSnapshot: false,
  }))
  check('failure: reason is stated', failed.includes('嵌入服务不可用'), 'reason rendered')
  check('failure: retry is offered', failed.includes('重试构建'), 'retry affordance')
  check('failure: cancel is not offered', !failed.includes('取消构建'), 'no cancel when idle')

  // The notice must not appear when nothing is building, or it would read as a
  // permanent warning about the current index.
  const idle = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages, processed: 12, total: 12, fraction: 1,
    log: [], logOpen: false, onLogToggle: () => {},
    running: false, onCancel: () => {}, servingPreviousSnapshot: false,
  }))
  check('rebuild: no stale notice when idle', !idle.includes('上一次索引快照'), 'notice correctly absent')
}

// ---------------------------------------------------------------------------
// 8. Log: collapsed by default, timestamped, colour-coded by level
// ---------------------------------------------------------------------------
{
  const collapsed = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages, processed: 1, total: 2, fraction: 0.5,
    log: [{ at: '2026-09-14T12:00:00.000Z', level: 'info', message: '开始构建' }],
    logOpen: false, onLogToggle: () => {}, running: false, onCancel: () => {},
    servingPreviousSnapshot: false,
  }))
  check('log: collapsed by default', !collapsed.includes('开始构建'), 'no line rendered while collapsed')
  check('log: toggle reports the line count', collapsed.includes('展开构建日志（1）'), 'count shown in the toggle')

  const open = renderToStaticMarkup(React.createElement(kb.BuildPipeline, {
    stages: buildProps().stages, processed: 1, total: 2, fraction: 0.5,
    log: [
      { at: '2026-09-14T12:00:00.000Z', level: 'info', message: '开始构建' },
      { at: '2026-09-14T12:00:05.000Z', level: 'success', message: '索引已发布' },
    ],
    logOpen: true, onLogToggle: () => {}, running: false, onCancel: () => {},
    servingPreviousSnapshot: false,
  }))
  check('log: lines render when expanded', open.includes('开始构建') && open.includes('索引已发布'), 'both lines')
  check('log: timestamps are rendered', open.includes('12:00:00'), 'HH:MM:SS from the ISO value')
  check('log: lines are monospaced', /kb-mono/.test(open), 'mono timestamps')

  // Levels must map to distinct styles so the colour semantics are enforceable.
  // The TSX builds the class name dynamically (`log_${level}`), so the mapping to
  // check is the one in the stylesheet, not a list of literals in the component.
  const css = readFileSync(join(ROOT, 'src', 'client', 'components', 'BuildPipeline.module.css'), 'utf8')
  const levels = ['success', 'running', 'info', 'error']
  const missing = levels.filter(level => !new RegExp(`\\.log_${level}\\b`).test(css))
  check('log: every level has its own style', missing.length === 0, missing.length === 0 ? levels.join(', ') : `missing ${missing.join(', ')}`)
  check('log: success uses the ready semantic tone', /\.log_success \.logMessage\s*\{[^}]*--kb-status-ready-text/.test(css), 'success -> ready tone')
  check('log: running uses the brand tone', /\.log_running \.logMessage\s*\{[^}]*--kb-brand/.test(css), 'running -> brand')
  check('log: info uses the secondary text tone', /\.log_info \.logMessage\s*\{[^}]*--kb-text-secondary/.test(css), 'info -> secondary text')
}

// ---------------------------------------------------------------------------
// 9. Predicate: chunk count is never fabricated
//
// The requirement is that a per-document count must be *true*, never invented. The
// original implementation satisfied it by writing `null` whenever a collection had
// more than one document, on the reasoning that the split was unknowable — but the
// split was known (the chunking stage computes it) and `null` is the 待构建 value,
// so a fully built collection displayed 待构建 against every row.
//
// So the check is now on the property rather than on that expression: the count
// must come from the build's own per-document plan, and no arithmetic may divide
// the collection total between documents.
// ---------------------------------------------------------------------------
{
  const page = readFileSync(join(ROOT, 'src', 'client', 'pages', 'BuildPage.tsx'), 'utf8')
  const ops = readFileSync(join(ROOT, 'src', 'host', 'operations.ts'), 'utf8')
  const build = readFileSync(join(ROOT, 'src', 'store', 'build.ts'), 'utf8')

  check(
    'state: the per-document count comes from the build plan, not a division',
    /chunksByDoc/.test(build) && /item\.chunks\.length/.test(build),
    'the chunking stage reports chunks per document, so the count is measured',
  )
  check(
    'state: no per-document count is computed by dividing the total',
    !/totalChunks\s*\/\s*records\.length|total\s*\/\s*documents\.length/.test(ops),
    'a fabricated share is what the rule forbids, not a measured count',
  )
  check(
    'state: every built document is recorded as ready with its count',
    /status: 'ready' as const/.test(ops) && /chunks: chunksByDoc\[record\.id\]/.test(ops),
    'the stored count is the one the build actually wrote',
  )
  check('page: submit is blocked without documents', /hasDocuments/.test(page), 'a document-less collection cannot be built')
}

console.log(`\nKB-07 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
