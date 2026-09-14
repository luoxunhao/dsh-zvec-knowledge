/**
 * Visual walkthrough renderer for KB-04 / KB-05.
 *
 * Renders the real components to static HTML using React's server renderer, inlines
 * the generated token sheet and the compiled CSS modules, and writes a page the
 * screenshot tool can capture. This is a walkthrough aid, not a gate: the visual
 * truth is the design canvas, and what this catches is the class of mistake that
 * only shows up when the components are composed — a collapsed grid, a pill that
 * overflows its card, a nav row that wraps.
 *
 * CSS-module class names are hashed at build time, so the stylesheet is extracted
 * from the built bundle rather than from source, and the class names are recovered
 * by evaluating the built module the same way the bundle does.
 *
 * Usage: node scripts/render-visual.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tmp', 'visual')

// The bundle is built as a module-loader payload rather than a plain ESM module:
// it calls `window.__ModuleLoader__.load({...})` at top level. The walkthrough
// shims that loader, captures the factory, and invokes it with a minimal
// `require` that resolves only the platform modules the bundle is allowed to use.
/** Stylesheets the bundle injects, captured as it injects them. */
const capturedSheets = []
globalThis.document = {
  documentElement: { setAttribute() {}, removeAttribute() {} },
  createElement: () => {
    const tag = { dataset: {}, style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value }, appendChild() {} }
    // The bundle assigns `tag.textContent = css`; capturing on write is simpler
    // and more faithful than scraping string literals out of the minified bundle.
    Object.defineProperty(tag, 'textContent', {
      set(value) { capturedSheets.push(value) },
      get() { return '' },
    })
    return tag
  },
  head: { appendChild() {} },
  // The bundle probes for an already-injected stylesheet before injecting; the
  // walkthrough reports "absent" every time so every sheet is captured.
  querySelector: () => null,
  querySelectorAll: () => [],
}

/** The factory the bundle registers. */
let factory = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load(entry) {
      factory = entry?.factory ?? entry?.default ?? entry
    },
  },
}

await import(new URL('../lib/client.js', import.meta.url).href)
if (factory === null) throw new Error('client bundle registered no factory on window.__ModuleLoader__')

// `react` and `react/jsx-runtime` are the two modules the bundle requires; both
// are in the client module table and resolvable from this package's deps.
const React = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const client = typeof factory === 'function'
  ? factory(specifier => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`walkthrough: unexpected module request ${specifier}`)
    })
  : factory

const { renderToStaticMarkup } = await import('react-dom/server')

/** Two collections in different lifecycle states, so both pills are exercised. */
const COLLECTIONS = [
  { id: 'kb_prod_2f8a', name: '产品文档', indexKind: 'HNSW', status: 'ready', statusLabel: '就绪',
    stats: { documents: 128, chunks: 3421, hits7d: 942 }, updatedAt: '2026-09-14 11:20' },
  { id: 'kb_docs_9c1e', name: '接口手册', indexKind: 'HNSW', status: 'building', statusLabel: '构建中',
    stats: { documents: 42, chunks: 806, hits7d: 117 }, updatedAt: '2026-09-14 12:04' },
  { id: 'kb_ops_4a77', name: '运维手册', indexKind: 'IVF', status: 'pending', statusLabel: '待构建',
    stats: { documents: 12, chunks: 0, hits7d: 0 }, updatedAt: '2026-09-13 09:41' },
]

const BUILDS = [
  { at: '2026-09-14 12:04', collectionId: 'kb_docs_9c1e', chunks: 806, status: 'building', statusLabel: '构建中' },
  { at: '2026-09-14 11:20', collectionId: 'kb_prod_2f8a', chunks: 3421, status: 'ready', statusLabel: '就绪' },
  { at: '2026-09-13 09:41', collectionId: 'kb_ops_4a77', chunks: 0, status: 'failed', statusLabel: '失败' },
]

/**
 * Render the panel as the host frames it.
 *
 * The harness owns the sidebar and the main column, so this walkthrough draws a
 * *stand-in* frame around the real panel component: a minimal 240px sidebar with
 * the 知识库 row in the position the plugin registers it, and the panel in the
 * main column. What it verifies is that the panel does not draw a second frame of
 * its own and that it fills the column.
 * @param options - theme selection.
 * @returns a complete HTML document string.
 */
function renderHostPanel({ theme }) {
  const panel = React.createElement(client.KnowledgeBasePanel, {
    state: client.panelState,
    port: {
      listCollections: async () => COLLECTIONS,
      listBuilds: async () => BUILDS,
      getUsage: async () => ({ bytes: 18_432_000, quotaBytes: 104_857_600 }),
      createCollection: async () => {},
      deleteCollection: async () => {},
    },
  })

  // A deliberately plain frame: the point is to see the panel's own geometry, so
  // the stand-in chrome uses the token surfaces without imitating host components.
  const body = `<div class="host-frame">
    <aside class="host-sidebar">
      <div class="host-brand">DeepSeek Harness</div>
      <button class="host-row" type="button"><span class="host-glyph">▤</span>会话</button>
      <button class="host-row host-row-active" type="button" aria-current="page"><span class="host-glyph">▥</span>知识库</button>
      <button class="host-row" type="button"><span class="host-glyph">▦</span>设置</button>
    </aside>
    <div class="host-main">${renderToStaticMarkup(panel)}</div>
  </div>`

  const css = extractStyles()

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>KB panel in host</title>
<style>${css}</style>
<style>
html,body{margin:0;padding:0;background:var(--kb-bg-app)}
.host-frame{display:grid;grid-template-columns:240px minmax(0,1fr);height:100vh}
.host-sidebar{display:flex;flex-direction:column;gap:4px;padding:12px;background:var(--kb-bg-surface);border-right:1px solid var(--kb-border-subtle)}
.host-brand{font:600 14px var(--kb-font-sans);color:var(--kb-text-primary);padding:8px 12px}
.host-row{display:flex;align-items:center;gap:12px;height:34px;padding:0 12px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--kb-text-secondary);font:14px var(--kb-font-sans);text-align:left;cursor:pointer}
.host-row-active{background:var(--kb-brand-tint);border-color:var(--kb-brand-border);color:var(--kb-brand);font-weight:500}
.host-glyph{opacity:.8}
.host-main{min-width:0;overflow:hidden}
</style>
</head><body${theme === 'dark' ? ' data-ds-dark-theme' : ''}>${body}</body></html>`
}

/**
 * Render the documents page with a mix of transfer and index states.
 *
 * The interesting states are the ones that only exist mid-operation: an upload in
 * flight, a cancelled one, a rejected format, and a stored document whose chunk
 * count is still unknown. Rendering them together is how the row heights and the
 * pending marker get checked visually rather than argued about.
 * @param options - theme selection.
 * @returns a complete HTML document string.
 */
function renderDocuments({ theme }) {
  const documents = [
    { id: 'd1', name: '产品需求文档.md', bytes: 184_320, ext: 'md', status: 'ready', chunks: 342 },
    { id: 'd2', name: '接口手册.pdf', bytes: 2_411_724, ext: 'pdf', status: 'pending', chunks: null },
    { id: 'd3', name: '运维手册.docx', bytes: 512_000, ext: 'docx', status: 'failed', chunks: null, error: '解析失败：文档已加密' },
  ]
  const page = React.createElement(client.DocumentsPage, {
    documents,
    onRemove: () => {},
    collectionId: 'kb_prod_2f8a',
  })
  const css = extractStyles()
  const inner = renderToStaticMarkup(page)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>KB-06 documents</title>
<style>${css}</style>
<style>html,body{margin:0;padding:0;background:var(--kb-bg-app)}#root{padding:24px;width:1200px}</style>
</head><body${theme === 'dark' ? ' data-ds-dark-theme' : ''}><div id="root">${inner}</div></body></html>`
}

/**
 * Render one page variant to a full HTML document.
 * @param options - theme and whether to render the dialog.
 * @returns a complete HTML document string.
 */
function renderPage({ theme, withDialog }) {
  const app = React.createElement(client.KnowledgeBaseApp, {
    port: {
      listCollections: async () => COLLECTIONS,
      listBuilds: async () => BUILDS,
      getUsage: async () => ({ bytes: 18_432_000, quotaBytes: 104_857_600 }),
      createCollection: async () => {},
      deleteCollection: async () => {},
    },
  })

  // The app loads asynchronously; this renderer has no effects, so the page is
  // rendered directly with data already resolved instead.
  const page = React.createElement(client.OverviewPage, {
    collections: COLLECTIONS.map(item => ({
      id: item.id,
      name: item.name,
      indexKind: item.indexKind,
      status: item.status,
      statusLabel: item.statusLabel,
      stats: item.stats,
      updatedAt: item.updatedAt,
    })),
    builds: BUILDS,
    hits7d: 1059,
    loading: false,
    error: null,
    onCreate: () => {},
    onOpen: () => {},
    onDelete: () => {},
    onRetry: () => {},
  })

  const shell = React.createElement(client.AppShell, {
    usage: { bytes: 18_432_000, quotaBytes: 104_857_600 },
    title: '知识库',
    active: 'overview',
    onNavigate: () => {},
    query: '',
    onQueryChange: () => {},
  }, page)

  const body = renderToStaticMarkup(shell)
  const dialog = withDialog
    ? renderToStaticMarkup(React.createElement(client.CreateCollectionDialog, {
        open: true, onClose: () => {}, onCreate: () => {}, existingIds: ['kb_prod_2f8a'],
      }))
    : ''

  // The token sheet and compiled component CSS are read from the built artifact:
  // class names are hashed by the CSS-module transform, so the source stylesheets
  // cannot be inlined directly.
  const css = extractStyles()

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>KB-04 / KB-05</title>
<style>${css}</style>
<style>html,body{margin:0;padding:0;background:var(--kb-bg-app)}#root{width:1440px}</style>
</head><body${theme === 'dark' ? ' data-ds-dark-theme' : ''}>
<div id="root">${body}</div>
${dialog}
</body></html>`
}

/**
 * The stylesheets captured during bundle evaluation.
 *
 * Read from the injector rather than scraped from the bundle text: the
 * CSS-module transform hashes class names at build time, so the *compiled* sheet
 * is the only one whose selectors match the rendered markup.
 * @returns concatenated CSS text.
 */
function extractStyles() {
  if (capturedSheets.length === 0) {
    throw new Error('no stylesheets were captured; the bundle injected none')
  }
  return capturedSheets.join('\n')
}

mkdirSync(OUT, { recursive: true })
const variants = [
  ['light', { theme: 'light', withDialog: false }, renderPage],
  ['dark', { theme: 'dark', withDialog: false }, renderPage],
  ['dialog', { theme: 'light', withDialog: true }, renderPage],
  // The host-framed variants are the ones that show the real integration: the
  // panel body inside a sidebar'd shell, which is how the plugin actually ships.
  ['host-light', { theme: 'light' }, renderHostPanel],
  ['host-dark', { theme: 'dark' }, renderHostPanel],
  ['documents', { theme: 'light' }, renderDocuments],
  ['documents-dark', { theme: 'dark' }, renderDocuments],
]
for (const [name, options, render] of variants) {
  const file = join(OUT, `${name}.html`)
  writeFileSync(file, render(options), 'utf8')
  console.log(`wrote ${file}`)
}
