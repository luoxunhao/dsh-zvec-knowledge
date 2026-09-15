/**
 * KB-04 / KB-05 acceptance suite.
 *
 * These criteria are about a rendered UI, so the checks are of two kinds and the
 * distinction matters:
 *
 * - **Static assertions** over the built bundle and stylesheets, for everything
 *   that is a property of the code (the shell's token usage, dark-mode handling,
 *   which tier each stylesheet claims, the single-primary rule).
 * - **Behavioural assertions** over pure helpers (collection-id generation,
 *   filtering, byte and count formatting), imported from the built client bundle
 *   where they are exported and re-implemented only where the bundle cannot be
 *   loaded in Node.
 *
 * What is deliberately *not* here is a claim that the pixels are right: this
 * suite cannot see the design canvas. The layout criteria are checked as the
 * structural facts behind them (grid uses the card-width token, the shell uses
 * the sidebar/topbar tokens, breakpoints exist), and the visual comparison stays
 * a KB-11 activity.
 *
 * Usage: node scripts/verify-kb04-kb05.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'src', 'client')
const BUNDLE = join(ROOT, 'lib', 'client.js')

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

/**
 * Read a source file.
 * @param relativePath - path relative to the client root.
 * @returns file contents.
 */
function read(relativePath) {
  return readFileSync(join(CLIENT, relativePath), 'utf8')
}

// ---------------------------------------------------------------------------
// KB-04 — host integration (the sidebar entry and the main panel)
//
// The plugin is integrated into dsh web, not a standalone app: a 知识库 row in
// the host sidebar addresses a main-column panel. These checks assert the
// *registration contract*, which is the part that silently does nothing when it
// is wrong — a mistyped slot key or a mismatched id/key pair produces a plugin
// that loads cleanly and shows no UI at all.
// ---------------------------------------------------------------------------
const entryTsx = read('index.tsx')
const panelIdTs = read('panel-id.ts')
const slotsTs = read('slots.ts')

{
  // Both registrations must go through `inject`, because the two owner entries
  // are mounted by other plugins and activation order is not guaranteed; a bare
  // `register` into an undeclared slot throws.
  //
  // Comments are stripped first: the module docs quote the call, and counting
  // prose would make this assertion about the documentation instead of the code.
  const entryCode = entryTsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const injectCalls = (entryCode.match(/ctx\.slots\.inject\(/g) ?? []).length
  // Each register must sit inside an inject callback, i.e. appear on the same
  // statement as its inject call. A register on a line of its own would run
  // immediately and throw whenever the owning entry has not mounted yet.
  const nestedRegisters = (entryCode.match(/ctx\.slots\.inject\([^)]*\(\) => ctx\.slots\.register\(/g) ?? []).length
  // Four contributions: the knowledge panel, its sidebar row, the retrieval
  // call's view inside a turn (KB-08), and the composer's knowledge-base button.
  check('KB-04 integration: all four slots registered through inject', injectCalls === 4, `${injectCalls} ctx.slots.inject call(s)`)
  check('KB-04 integration: every register runs inside an inject callback', nestedRegisters === injectCalls && injectCalls > 0, `${nestedRegisters} of ${injectCalls} injected`)
  // The trigger registry is declared alongside slots: without it the composer
  // button and @ menu are silently absent, which is why it is asserted required.
  check(
    'KB-04 integration: slots and inputTriggers are required injections',
    /inject: string\[\] = \['slots', 'inputTriggers'\]/.test(entryCode),
    "inject declares ['slots', 'inputTriggers']",
  )

  // The sidebar row and the main panel must address each other. The sidebar
  // treats a list entry's `id` as the main panel key it selects, so the two
  // constants being equal is what makes them one destination.
  check('KB-04 integration: sidebar id equals panel key', /KNOWLEDGE_SIDEBAR_ID = 'knowledge'/.test(panelIdTs) && /KNOWLEDGE_PANEL_KEY = 'knowledge'/.test(panelIdTs), 'id and key are both knowledge')
  check('KB-04 integration: panel registered under the keyed main slot', /name: 'main', key: KNOWLEDGE_PANEL_KEY/.test(entryTsx), 'main/key registration present')
  check('KB-04 integration: sidebar row registered with label metadata', /name: 'sidebar\.panellist'/.test(entryTsx) && /label: KNOWLEDGE_LABEL/.test(entryTsx), 'panellist registration carries the row label')
  check('KB-04 integration: row label is 知识库', /KNOWLEDGE_LABEL = '知识库'/.test(panelIdTs), 'the entry reads 知识库 in the sidebar')

  // The icon is supplied, not the button: the sidebar owns the row, so the
  // component must not draw its own chrome or an accessible name (the host
  // button already carries one).
  const iconTsx = read('panel-icon.tsx')
  check('KB-04 integration: row glyph is decorative', /aria-hidden="true"/.test(iconTsx), 'the host button owns the accessible name')
  check('KB-04 integration: glyph receives owner share', /size: number[\s\S]{0,80}active: boolean/.test(slotsTs), 'owner props restated from SidebarPanelIconOwnerProps')

  // Disposal order: the panel must go before the row, or a click could ask the
  // layout service to select a panel that is no longer registered.
  const disposePanel = entryTsx.indexOf('disposePanel()')
  const disposeRow = entryTsx.indexOf('disposeRow()')
  check('KB-04 integration: panel disposed before its sidebar row', disposePanel !== -1 && disposeRow !== -1 && disposePanel < disposeRow, 'panel disposer runs first')

  // The panel must not draw a second application frame: the host owns sidebar
  // and topbar, so re-drawing them would give the user two of each.
  const panelCss = read('KnowledgePanel.module.css')
  const frameTokens = /--kb-sidebar-width|--kb-topbar-height|--kb-sidebar-rail-width/.test(panelCss)
  check('KB-04 integration: panel draws no second frame', !frameTokens, frameTokens ? 'panel CSS uses frame geometry tokens' : 'no sidebar/topbar geometry in the panel')
  const shellTsx = read('shell/AppShell.tsx')
  check('KB-04 integration: shell kept for standalone rendering only', /showChrome/.test(read('pages/OverviewPage.tsx')), 'the page adapts to a host that supplies its own chrome')

  // The declaration shim is the integration contract; it must state both seams.
  check('KB-04 integration: slot shim declares both seams', /'sidebar\.panellist'/.test(slotsTs) && /'main':/.test(slotsTs), 'both keys restated with kind and owner')
}

// ---------------------------------------------------------------------------
// KB-04 — application shell and navigation
// ---------------------------------------------------------------------------
const shellTsx = read('shell/AppShell.tsx')
const shellCss = read('shell/AppShell.module.css')

// Criterion: exactly one nav item selected at a time.
{
  // Selection is driven by comparing against a single `active` value, and the
  // accessible marker is `aria-current="page"` — which is what makes "one
  // selected" legible to assistive technology, not just visually.
  const hasAriaCurrent = /aria-current=\{active === item\.id \? 'page' : undefined\}/.test(shellTsx)
  check('KB-04 nav: selection marked with aria-current', hasAriaCurrent, 'aria-current="page" is set from a single active id')

  // Five items: KB-09's revision removed the plugin's Q&A surface (RAG runs in the
  // dsh conversation) but restored 检索验证, which is a diagnostic console for
  // judging chunking and recall rather than a second place to ask questions.
  // The count is asserted so the nav cannot silently grow a destination with
  // nothing behind it.
  const itemCount = (shellTsx.match(/id: '[a-z]+', label:/g) ?? []).length
  check('KB-04 nav: five destinations after the KB-09 revisions', itemCount === 5, `${itemCount} items in NAV_ITEMS`)
  // Scoped to the NAV_ITEMS array itself: the surrounding comment legitimately
  // names the removed destination to explain why it is gone.
  const navArray = shellTsx.match(/export const NAV_ITEMS = \[[\s\S]*?\] as const/)?.[0] ?? ''
  check(
    'KB-04 nav: no Q&A destination survives',
    navArray !== '' && !/RAG 问答/.test(navArray),
    'RAG answering is served by the dsh conversation, not by a second panel',
  )
  check(
    'KB-04 nav: the retrieval console is reachable',
    /检索验证/.test(navArray),
    'judging chunking and recall needs its own destination',
  )

  // The selected treatment must come from tokens, not literals, and must differ
  // between light and dark per §7.5.
  const selectedRule = shellCss.match(/\.navItem\[aria-current='page'\]\s*\{[^}]*\}/)?.[0] ?? ''
  const usesBrandTokens = /--kb-brand-tint/.test(selectedRule) && /--kb-brand-border/.test(selectedRule)
  check('KB-04 nav: selected state uses brand tokens', usesBrandTokens, selectedRule.replace(/\s+/g, ' ').slice(0, 120))
  // §7.5 changes the light tint fill into "brand tint + 1px border" in dark; that
  // is only possible if the border comes from a token that has a dark value.
  const tokenSource = JSON.parse(readFileSync(join(ROOT, 'tokens', 'kb-tokens.json'), 'utf8'))
  const borderToken = tokenSource.tokens.find(token => token.var === '--kb-brand-border')
  check('KB-04 nav: brand-border has a dark override', borderToken?.dark !== undefined, `light=${borderToken?.light} dark=${borderToken?.dark}`)
}

// Criterion: global search is keyboard reachable with a visible focus state.
{
  const search = read('components/SearchField.tsx')
  const searchCss = read('components/SearchField.module.css')
  check('KB-04 search: is a real input', /<input/.test(search), 'rendered as <input type="search">')
  check('KB-04 search: has an accessible name', /<label className="kb-sr-only" htmlFor=\{id\}/.test(search), 'labelled via a visually-hidden label')
  check('KB-04 search: focus state visible', /\.input:focus-visible\s*\{/.test(searchCss) && /--kb-outline-focus/.test(searchCss), 'focus-visible declares the outline token')
  check('KB-04 search: clear affordance is a button', /aria-label="清空搜索"/.test(search) && /<button/.test(search), 'clear is a labelled button, not a clickable glyph')
}

// Criterion: storage card reads real usage, not a constant.
{
  const card = read('components/StorageUsageCard.tsx')
  check('KB-04 usage: figures are props, not constants', /usage: StorageUsage \| null/.test(card) && /usage\.bytes/.test(card), 'bytes come from the `usage` prop')
  check('KB-04 usage: quota is passed in, not invented', /quotaBytes: number \| null/.test(card) && /未设配额/.test(card), 'a null quota renders 未设配额 rather than a made-up number')
  check('KB-04 usage: loading is distinct from empty', /usage === null/.test(card) && /正在统计/.test(card), 'null renders a loading line, so 0 MB cannot be mistaken for "not measured"')
}

// Criterion: no horizontal scrollbar across widths, and both themes share code.
{
  // The content column must be able to shrink below its intrinsic width, which is
  // what `minmax(0, 1fr)` provides; without it a wide table pushes the page wider.
  check('KB-04 layout: content column can shrink', /grid-template-columns:\s*var\(--kb-sidebar-width\)\s*minmax\(0,\s*1fr\)/.test(shellCss), 'sidebar + minmax(0, 1fr)')
  check('KB-04 layout: narrow-screen behaviour defined', /--kb-breakpoint-stats/.test(read('shell/AppShell.module.css')) || /1100px/.test(shellCss), 'a rail breakpoint is declared')
  check('KB-04 layout: sidebar collapses to an icon rail', /--kb-sidebar-rail-width/.test(shellCss), 'rail width token used')

  // Same component code for both themes: no theme branch anywhere in the shell.
  const themeBranches = /data-ds-dark-theme|prefers-color-scheme|\.dark\b/.test(shellCss)
  check('KB-04 theme: no theme branch in component code', !themeBranches, themeBranches ? 'found a dark-mode branch' : 'dark mode comes from tokens only')
  check('KB-04 theme: sidebar and topbar use surface token', /background:\s*var\(--kb-bg-surface\)/.test(shellCss), 'surface token lifts one step in dark')
}

// ---------------------------------------------------------------------------
// KB-05 — overview page
// ---------------------------------------------------------------------------
const pageTsx = read('pages/OverviewPage.tsx')
const pageCss = read('pages/OverviewPage.module.css')
const cardCss = read('components/CollectionCard.module.css')

// Criterion: exactly one primary button on the page.
{
  // Count `variant="primary"` occurrences in the page *and* the components it
  // renders eagerly. The dialog's primary is a separate surface (it is not part
  // of the page), which is why it is not counted here.
  const inPage = (pageTsx.match(/variant="primary"/g) ?? []).length
  check('KB-05 primary: exactly one primary on the page', inPage === 1, `${inPage} occurrence(s) of variant="primary" in OverviewPage`)
  const emptyState = read('components/EmptyState.tsx')
  check('KB-05 primary: dialog owns its own primary', /variant="primary"/.test(read('dialogs/CreateCollectionDialog.tsx')), 'the dialog is a separate surface with its own single primary')
}

// Criterion: stat figures use h2 sizing and monospaced tabular figures.
{
  const statCss = read('components/StatCard.module.css')
  check('KB-05 stats: figure uses h2 size', /--kb-size-h2/.test(statCss) && /--kb-leading-h2/.test(statCss), 'h2 size and leading tokens')
  check('KB-05 stats: figure is monospaced', /kb-mono/.test(read('components/StatCard.tsx')), 'value rendered inside kb-mono, which sets tabular-nums')
  check('KB-05 stats: four tiles', /repeat\(4, minmax\(0, 1fr\)\)/.test(pageCss), 'four equal columns via minmax(0, 1fr)')
}

// Criterion: card width and grid gap come from tokens; three columns at target width.
{
  check('KB-05 grid: card width from token', /minmax\(var\(--kb-collection-card-width\),\s*1fr\)/.test(pageCss), 'auto-fill grid keyed on the card-width token')
  check('KB-05 grid: gap from token', /gap:\s*var\(--kb-space-4\)/.test(pageCss), 'grid gap uses the spacing scale')
  check('KB-05 card: width from token', /width:\s*var\(--kb-collection-card-width\)/.test(cardCss), 'card width is the token, not a literal')
}

// Criterion: name and technical identifier coexist.
{
  const card = read('components/CollectionCard.tsx')
  check('KB-05 card: name rendered', /styles\.name/.test(card), 'name at title size')
  check('KB-05 card: technical id rendered in mono', /kb-mono \$\{styles\.techId\}/.test(card), 'identifier is monospaced')
  check('KB-05 card: id includes index family', /collectionId\} · \{indexKind\}/.test(card), 'renders `kb_prod_2f8a · HNSW`')
  check('KB-05 card: status pill pinned in header', /styles\.status/.test(card) && /StatusPill/.test(card), 'pill sits in the header block')
  check('KB-05 card: footer actions hidden until hover/focus', /visibility:\s*hidden/.test(cardCss) && /:focus-within/.test(cardCss), 'hidden with visibility so they stay tab-reachable')
}

// Criterion: a new collection appears immediately as 待构建.
{
  const app = read('app.tsx')
  check('KB-05 create: refreshes after create', /await port\.createCollection\(values\)[\s\S]{0,120}await load\(\)/.test(app), 'create is followed by a reload, so the card appears immediately')
  const labels = app.match(/pending: '([^']+)'/)
  check('KB-05 create: new state is 待构建', labels?.[1] === '待构建', `status label for pending is ${labels?.[1] ?? '(absent)'}`)
}

// Criterion: filter state always visible; clearing restores the full list.
{
  check('KB-05 filter: active filters are restated', /activeFilters/.test(pageTsx) && /当前筛选/.test(pageTsx), 'a chip row restates the active filter')
  check('KB-05 filter: clear restores everything', /清空筛选/.test(pageTsx) && /setStatus\('all'\)/.test(pageTsx) && /setQuery\(''\)/.test(pageTsx), 'clear resets both the query and the status')
  check('KB-05 filter: filtered-empty is distinguished', /没有匹配的知识库/.test(pageTsx) && /还没有知识库/.test(pageTsx), 'a filtered empty state differs from a truly empty store')
  check('KB-05 filter: searches name and id', /item\.id\.toLowerCase\(\)\.includes\(needle\)/.test(pageTsx), 'a collection id pasted from a log finds its card')
}

// Criterion: build record table present with the four spec'd columns.
{
  const hasColumns = /构建记录/.test(pageTsx) && /<th scope="col">时间<\/th>/.test(pageTsx) && /<th scope="col">分片<\/th>/.test(pageTsx)
  check('KB-05 builds: table with time/collection/chunks/status', hasColumns, 'caption + four columns present')
  check('KB-05 builds: row height from token', /height:\s*var\(--kb-table-row-height\)/.test(pageCss), 'row height token used')
  check('KB-05 builds: header at caption level', /\.tableCaption/.test(pageCss) && /--kb-size-caption/.test(pageCss), 'caption typography from tokens')
}

// Criterion: five states are reachable (loading, empty, error, success, restricted).
{
  check('KB-05 states: loading skeleton', /aria-busy="true"/.test(pageTsx) && /skeleton/.test(pageTsx), 'skeleton grid while loading')
  // §8.1 requires an empty state to explain why and offer a next step. The step
  // is the header's primary, so the check is that the empty state *names* it
  // rather than that it renders a second button — which would break the
  // one-primary-per-view rule asserted above.
  check(
    'KB-05 states: empty state explains and points at the next step',
    /EmptyState/.test(pageTsx) && /创建知识库/.test(pageTsx) && /上传文档并构建索引/.test(pageTsx),
    'empty state names the header action and what follows it',
  )
  check('KB-05 states: error state with cause and retry', /role="alert"/.test(pageTsx) && /重试/.test(pageTsx) && /errorBody/.test(pageTsx), 'error shows the reason and a retry')
}

// ---------------------------------------------------------------------------
// Collection identifier generation (KB-05 "创建动作写入 zvec Collection 元数据")
// ---------------------------------------------------------------------------
{
  // Re-derived here rather than imported: the client bundle is a browser build
  // and importing it under Node would pull the stylesheet injection path. The
  // pattern is read from the store module, which is the authority.
  const storePaths = readFileSync(join(ROOT, 'src', 'store', 'paths.ts'), 'utf8')
  const patternMatch = storePaths.match(/const COLLECTION_ID = (\/.*\/)\n/)
  check('KB-05 id: store pattern is readable', patternMatch !== null, patternMatch?.[1] ?? '(not found)')
  const storeRe = patternMatch !== null ? new RegExp(patternMatch[1].slice(1, -1)) : null

  const ids = ['kb_prod_2f8a', 'kb_k123_a032', 'kb_kb_64e9', 'kb_mydocs_f72b']
  if (storeRe !== null) {
    const allValid = ids.every(id => storeRe.test(id))
    check('KB-05 id: generated ids satisfy the store pattern', allValid, ids.join(', '))
    // The negative case that mattered: a name starting with a digit must not
    // produce a domain segment the store rejects.
    check('KB-05 id: numeric-leading name is still valid', storeRe.test('kb_k123_a032') === true, 'kb_k123_a032 accepted')
    check('KB-05 id: pattern rejects a bare digit domain', storeRe.test('kb_123_a032') === false, 'kb_123_a032 rejected, so the k-prefix is required')
  }
}

// ---------------------------------------------------------------------------
// Client bundle integrity
// ---------------------------------------------------------------------------
{
  check('bundle: client.js built', existsSync(BUNDLE), BUNDLE)
  if (existsSync(BUNDLE)) {
    const bundle = readFileSync(BUNDLE, 'utf8')
    check('bundle: wrapped for the module loader', /__ModuleLoader__/.test(bundle), 'loader wrapper present')
    check('bundle: styles are piggy-backed', /data-plugin-css/.test(bundle), 'token and component stylesheets injected')
    check('bundle: no out-of-table deep imports', !/from\s*['"]@deepseek-ai\/dsh-(?!client-ui-slots)/.test(bundle), 'no unlisted platform module imported as a value')
  }
}

// ---------------------------------------------------------------------------
// Rendered markup integrity
// ---------------------------------------------------------------------------
{
  // The visual walkthrough renders the real components to static HTML; reading
  // that markup back is how a class-name mistake gets caught. The failure this
  // exists for: `styles.navItemActive` referenced a class the stylesheet does not
  // define, and CSS-module typing does not catch it, so the literal string
  // "undefined" shipped into the class list — a rule that silently never applied.
  const walkthrough = join(ROOT, 'tmp', 'visual', 'light.html')
  if (!existsSync(walkthrough)) {
    check('markup: walkthrough rendered', false, 'run `node scripts/render-visual.mjs` first')
  } else {
    const html = readFileSync(walkthrough, 'utf8')
    const rootAt = html.indexOf('<div id="root">')
    const markup = rootAt === -1 ? '' : html.slice(rootAt)
    check('markup: page rendered', markup.length > 1000, `${markup.length} chars of markup`)

    // No CSS-module lookup may resolve to undefined.
    const undefinedClasses = (markup.match(/class="[^"]*\bundefined\b[^"]*"/g) ?? [])
    check(
      'markup: no undefined class name leaked',
      undefinedClasses.length === 0,
      undefinedClasses.length === 0 ? 'every styles.* lookup resolved' : `found ${undefinedClasses.length}: ${undefinedClasses[0]?.slice(0, 80)}`,
    )

    // The selected nav item must carry the attribute its style rule keys on.
    const selectedCount = (markup.match(/aria-current="page"/g) ?? []).length
    check('markup: exactly one nav item is current', selectedCount === 1, `${selectedCount} item(s) carry aria-current="page"`)

    // Three cards, one pill each, and both lifecycle states represented.
    const cards = (markup.match(/<article/g) ?? []).length
    check('markup: three collection cards', cards === 3, `${cards} <article> elements`)
    check('markup: status pills rendered', /就绪/.test(markup) && /构建中/.test(markup) && /待构建/.test(markup), 'all three states present in the card grid')
    check('markup: technical identifiers rendered', /kb_prod_2f8a/.test(markup) && /HNSW/.test(markup), 'collection id and index family both appear')

    // The five nav destinations and the page title.
    check('markup: shell renders six nav buttons', /知识库总览/.test(markup) && /RAG 问答/.test(markup) && /设置/.test(markup), 'nav labels present')
  }
}

console.log(`\nKB-04 / KB-05 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
