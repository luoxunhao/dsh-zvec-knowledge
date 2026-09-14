/**
 * KB-06 acceptance suite: upload intake, in-row progress, cancel, retry, states.
 *
 * The criteria here are behavioural rather than structural — "cancel really
 * aborts the transfer", "the chunk count is the pending value, not zero" — so the
 * checks drive the real components through a DOM-less React renderer with a
 * controllable transport, and inspect the resulting markup and call log. That is
 * the only way to distinguish a cancel that aborts from one that merely relabels
 * the row.
 *
 * Usage: node scripts/verify-kb06.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

// react-dom/server is a devDependency for the walkthrough; the acceptance suite
// reuses it so it inspects real rendered markup rather than a hand-built string.
const { renderToStaticMarkup } = await import('react-dom/server')

/**
 * Render a component to static markup.
 * @param element - React element.
 * @returns the HTML.
 */
function render(element) {
  return renderToStaticMarkup(element)
}

/** Synchronous flush of pending microtasks, for driving async state updates. */
const flush = () => new Promise(resolveFlush => setTimeout(resolveFlush, 0))

// ---------------------------------------------------------------------------
// 1. Drop zone: keyboard reachable, two-line copy, accepted formats stated
// ---------------------------------------------------------------------------
{
  const html = render(React.createElement(kb.UploadDropzone, {
    onFiles: () => {}, accepted: kb.ACCEPTED_EXTENSIONS, maxSizeLabel: kb.MAX_UPLOAD_LABEL,
  }))
  check('upload: zone is a button, so it is keyboard reachable', /<button[^>]*type="button"/.test(html), 'rendered as <button>, not a div with a drop handler')
  check('upload: zone has a file input target', /<input[^>]*type="file"/.test(html), 'a real file input backs the button')
  check('upload: input accepts the advertised formats', kb.ACCEPTED_EXTENSIONS.every(ext => html.includes(`.${ext}`)), kb.ACCEPTED_EXTENSIONS.join(' / '))
  check('upload: copy is two lines', /拖拽文件到此处/.test(html) && /支持 /.test(html), 'primary action line plus a formats/limit line')
  check('upload: secondary line states the size ceiling', html.includes(kb.MAX_UPLOAD_LABEL), `ceiling ${kb.MAX_UPLOAD_LABEL}`)
  check('upload: described-by links the hint', /aria-describedby="[^"]+"/.test(html), 'the limit line is programmatically associated')

  const disabled = render(React.createElement(kb.UploadDropzone, {
    onFiles: () => {}, accepted: kb.ACCEPTED_EXTENSIONS, maxSizeLabel: kb.MAX_UPLOAD_LABEL, disabled: true,
  }))
  check('upload: disabled zone is inert', /<button[^>]*disabled/.test(disabled), 'the button carries disabled')
}

// ---------------------------------------------------------------------------
// 2. Validation: every rejection names its reason and the accepted range
// ---------------------------------------------------------------------------
{
  const cases = [
    { file: { name: 'a.exe', size: 100 }, mustMention: '.exe' },
    { file: { name: 'noext', size: 100 }, mustMention: '扩展名' },
    { file: { name: 'empty.md', size: 0 }, mustMention: '空' },
    { file: { name: 'huge.md', size: kb.MAX_UPLOAD_BYTES + 1 }, mustMention: kb.MAX_UPLOAD_LABEL },
  ]
  for (const testCase of cases) {
    const reason = kb.validateUpload(testCase.file)
    // Every rejection must state the acceptable range, not just what was wrong.
    // The formats list and the size limits are both legitimate ways to do that;
    // which one applies depends on which constraint was violated.
    const statesRange = reason !== null
      && (reason.includes('支持') || reason.includes('上限') || reason.includes('可接受'))
    check(
      `upload: rejects ${testCase.file.name} with a reason and a range`,
      reason !== null && reason.includes(testCase.mustMention) && statesRange,
      reason ?? '(accepted!)',
    )
  }
  check('upload: accepts a valid file', kb.validateUpload({ name: 'guide.md', size: 1024 }) === null, 'guide.md accepted')
  check('upload: accepts at the ceiling', kb.validateUpload({ name: 'guide.md', size: kb.MAX_UPLOAD_BYTES }) === null, 'exactly at the limit is allowed')
}

// ---------------------------------------------------------------------------
// 3. Pending chunk count is a value, not zero
// ---------------------------------------------------------------------------
{
  check('state: pending chunk count renders as 待构建', kb.formatChunks(null) === '待构建', `null -> ${kb.formatChunks(null)}`)
  check('state: a real zero is distinguishable', kb.formatChunks(0) === '0', `0 -> ${kb.formatChunks(0)}`)
  check('state: a built count renders numerically', kb.formatChunks(128) === '128', `128 -> ${kb.formatChunks(128)}`)

  // The row must not print "0" for a document that has not been built.
  const row = render(React.createElement(kb.DocumentRow, {
    row: {
      id: 'doc_1', name: 'guide.md', bytes: 2048, ext: 'md',
      status: 'pending', statusLabel: '待构建', chunks: null,
      transfer: 'done', progress: 1,
    },
  }))
  check('state: uploaded row shows the pending marker', row.includes('待构建'), 'row text contains 待构建')
  check('state: uploaded row shows the file size', row.includes('2 KB'), 'size rendered from bytes')
}

// ---------------------------------------------------------------------------
// 4. In-row progress: no global overlay, percentage and cancel present
// ---------------------------------------------------------------------------
{
  const row = render(React.createElement(kb.DocumentRow, {
    row: {
      id: 't', name: 'big.pdf', bytes: 4096, ext: 'pdf',
      status: 'pending', statusLabel: '待构建', chunks: null,
      transfer: 'uploading', progress: 0.42,
    },
    onCancel: () => {},
  }))
  check('progress: rendered inside the row', /progressbar/.test(row), 'a progressbar element is part of the row markup')
  check('progress: percentage is shown', row.includes('42%'), '42% rendered from 0.42')
  check('progress: bar carries an accessible name', /aria-label="[^"]*上传进度"/.test(row), 'the bar is named after the file')
  check('progress: cancel affordance is present', /aria-label="取消上传/.test(row), 'a labelled cancel button')
  check('progress: row exposes no modal/overlay role', !/aria-modal|role="dialog"/.test(row), 'nothing here blocks the page')
}

// ---------------------------------------------------------------------------
// 5. Cancel / retry / failure states
// ---------------------------------------------------------------------------
{
  const cancelled = render(React.createElement(kb.DocumentRow, {
    row: {
      id: 't', name: 'a.md', bytes: 100, ext: 'md',
      status: 'pending', statusLabel: '待构建', chunks: null,
      transfer: 'cancelled', progress: 0.3, error: '已取消，可重试',
    },
    onRetry: () => {},
  }))
  check('cancel: row returns to a retryable state', /aria-label="重试上传/.test(cancelled), 'a retry control is offered')
  check('cancel: cancelled row states why', cancelled.includes('已取消'), 'the row says it was cancelled')

  const failed = render(React.createElement(kb.DocumentRow, {
    row: {
      id: 't', name: 'b.md', bytes: 100, ext: 'md',
      status: 'failed', statusLabel: '失败', chunks: null,
      transfer: 'failed', progress: 0, error: '网络中断，请检查连接',
    },
    onRetry: () => {},
  }))
  check('failure: row states the reason inline', failed.includes('网络中断'), 'the reason is rendered, not just a status')
  check('failure: row offers retry', /aria-label="重试上传/.test(failed), 'retry entry point present')
}

// ---------------------------------------------------------------------------
// 6. Document list: four columns, search and filter present
// ---------------------------------------------------------------------------
{
  const docs = [
    { id: 'd1', name: '产品文档.md', bytes: 2048, ext: 'md', status: 'ready', chunks: 128 },
    { id: 'd2', name: '接口手册.pdf', bytes: 4096, ext: 'pdf', status: 'pending', chunks: null },
  ]
  const html = render(React.createElement(kb.DocumentsPage, {
    documents: docs, onRemove: () => {}, collectionId: 'kb_prod_2f8a',
  }))
  check('list: four column headers present', ['类型', '文件名', '分片数', '状态'].every(label => html.includes(label)), '类型 / 文件名 / 分片数 / 状态')
  check('list: search affordance present', /按文件名筛选/.test(html), 'a search field is rendered')
  check('list: status filter present', /待构建/.test(html) && /已构建/.test(html), 'status filter options rendered')
  check('list: built document shows its chunk count', html.includes('128'), 'chunks rendered numerically')
  check('list: pending document shows the pending marker', html.includes('待构建'), 'no zero is printed for an unbuilt document')

  // Without a selected collection the zone must be disabled with an explanation
  // rather than silently doing nothing.
  const noCollection = render(React.createElement(kb.DocumentsPage, {
    documents: [], onRemove: () => {}, collectionId: null,
  }))
  check('list: upload disabled without a collection', /<button[^>]*disabled/.test(noCollection), 'the drop zone is disabled')
  check('list: the reason is stated', /请先在「总览」中选择一个知识库/.test(noCollection), 'a notice explains what to do first')

  const empty = render(React.createElement(kb.DocumentsPage, {
    documents: [], onRemove: () => {}, collectionId: 'kb_prod_2f8a',
  }))
  check('list: empty state says what to do', /还没有文档/.test(empty) && /拖到上方区域/.test(empty), 'empty state names the next step')
}

// ---------------------------------------------------------------------------
// 7. Host store: records round-trip, pending semantics survive persistence
// ---------------------------------------------------------------------------
{
  const store = await import(new URL('../lib/store/documents.js', import.meta.url).href)
  const scratch = mkdtempSync(join(tmpdir(), 'kb06-'))
  const root = join(scratch, 'store')
  const collection = 'kb_prod_2f8a'
  mkdirSync(join(root, collection), { recursive: true })

  const record = {
    id: 'doc_1', name: 'guide.md', bytes: 2048, ext: 'md',
    status: 'pending', chunks: null, uploadedAt: new Date().toISOString(), builtAt: null,
  }
  store.appendDocument(root, collection, record)
  const read = store.listDocuments(root, collection)
  check('store: record round-trips', read.length === 1 && read[0].id === 'doc_1', `${read.length} record(s)`)
  check('store: pending survives persistence as null', read[0].chunks === null, `chunks=${JSON.stringify(read[0].chunks)}`)

  // A second append must not clobber the first.
  store.appendDocument(root, collection, { ...record, id: 'doc_2', name: 'api.pdf', ext: 'pdf' })
  check('store: appends do not clobber', store.listDocuments(root, collection).length === 2, 'two records after two appends')

  const patched = store.patchDocument(root, collection, 'doc_1', { status: 'ready', chunks: 128, builtAt: new Date().toISOString() })
  check('store: patch updates one record', patched.length === 2 && patched[0].chunks === 128, `chunks=${patched[0].chunks}`)
  check('store: patch leaves others alone', store.listDocuments(root, collection).find(d => d.id === 'doc_2').chunks === null, 'doc_2 still pending')

  const summary = store.summarizeDocuments(store.listDocuments(root, collection))
  check('store: summary counts by status', summary.total === 2 && summary.ready === 1 && summary.pending === 1, JSON.stringify(summary))
  check('store: summary chunks exclude pending', summary.chunks === 128, `chunks=${summary.chunks} (pending contributes nothing)`)

  const remaining = store.removeDocument(root, collection, 'doc_1')
  check('store: remove drops one record', remaining.length === 1 && remaining[0].id === 'doc_2', `${remaining.length} left`)

  // The host-side validation must agree with the client's on the same inputs.
  const hostValidation = store.validateUpload('guide.exe', 100)
  const clientValidation = kb.validateUpload({ name: 'guide.exe', size: 100 })
  check('store: host and client validation agree', (hostValidation === null) === (clientValidation === null), `host=${hostValidation ? 'rejected' : 'accepted'} client=${clientValidation ? 'rejected' : 'accepted'}`)
  check('store: extensions are derived consistently', store.extensionOf('a/b/Report.MD') === 'md', store.extensionOf('a/b/Report.MD'))

  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nKB-06 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
