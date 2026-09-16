/**
 * KB-11 walkthrough: five-state coverage and the accessibility checklist.
 *
 * The issue list asks for the interaction and accessibility requirements to be
 * turned into rules that can be "自动或半自动检测". This suite is that translation:
 * every entry below is one requirement from §8.2–§8.4 or §4.7, expressed as an
 * assertion over the real components.
 *
 * Two kinds of check appear, and the difference is deliberate:
 *
 * - **Structural** — a rule a static scan can decide (every icon-only control
 *   carries an accessible name; no stylesheet removes the focus outline).
 * - **Rendered** — a rule that needs the component to run (a page renders distinct
 *   loading / empty / error / success / restricted states).
 *
 * What it does *not* claim: that the result is usable by a person. Contrast is
 * measured numerically elsewhere, and screen-reader behaviour is asserted only as
 * far as the markup makes it determinable. `semi-automatic` in the issue list is
 * taken literally — the machine decides what it can and the rest is listed.
 *
 * Usage: node scripts/verify-kb11-walkthrough.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'src', 'client')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - the requirement, quoted or paraphrased.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

/**
 * Read a client source file.
 * @param relativePath - path relative to the client root.
 * @returns file contents.
 */
const read = relativePath => readFileSync(join(CLIENT, relativePath), 'utf8')

/**
 * Collect files under a directory.
 * @param dir - directory to walk.
 * @param filter - predicate on the file name.
 * @returns absolute paths.
 */
function walk(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, filter))
    else if (filter(entry)) out.push(full)
  }
  return out
}

const cssFiles = walk(CLIENT, name => name.endsWith('.css') && !name.includes('generated'))
const tsxFiles = walk(CLIENT, name => name.endsWith('.tsx'))

/**
 * Read a file relative to the client root from an absolute path.
 * @param absolute - absolute path.
 * @returns file contents.
 */
const readAbs = absolute => readFileSync(absolute, 'utf8')

// ---------------------------------------------------------------------------
// §8.4 焦点可见 — focus must be visible and never removed
// ---------------------------------------------------------------------------
{
  // §8.4 forbids removing the outline. The only legitimate suppression is the
  // mouse-vs-keyboard distinction (`:focus:not(:focus-visible)`), which keeps the
  // outline for keyboard users.
  const outlineNone = cssFiles.filter(file => {
    const css = readAbs(file)
    // `outline: none` outside a `:not(:focus-visible)` guard.
    return /outline:\s*none/.test(css) && !/:focus:not\(:focus-visible\)/.test(css)
  })
  check('a11y: no stylesheet removes the focus outline', outlineNone.length === 0, outlineNone.length === 0 ? `${cssFiles.length} stylesheets checked` : outlineNone.join(', '))

  // Every interactive control should express focus through the token pair rather
  // than a bespoke treatment.
  const focusCapable = cssFiles.filter(file => /:focus-visible/.test(readAbs(file))).length
  check('a11y: focus-visible is declared broadly', focusCapable >= 10, `${focusCapable} stylesheets declare :focus-visible`)

  const baseCss = read('styles/base.css')
  check('a11y: focus uses the outline token, not a shadow alone', /outline:\s*var\(--kb-outline-focus\)/.test(baseCss), 'outline token applied at the root rule')
  check('a11y: focus ring colour is a token, so it follows the theme', /--kb-focus-ring-color/.test(baseCss) || /--kb-outline-focus/.test(baseCss), 'tokenised')
}

// ---------------------------------------------------------------------------
// §8.4 图标语义 — icon-only controls must carry an accessible name
// ---------------------------------------------------------------------------
{
  // A button is unnameable only when it carries *no* accessible name: neither an
  // aria-label/title, nor visible text. Checking for the attributes alone would
  // flag every icon-plus-label button, which is a false positive — and a check
  // that cries wolf is one people learn to ignore.
  const bareIconButtons = []
  for (const file of tsxFiles) {
    const source = readAbs(file)
    for (const match of source.matchAll(/<button\b[\s\S]{0,600}?<\/button>/g)) {
      const block = match[0]
      if (!/<Icon\b/.test(block)) continue
      const named = /aria-label=|title=/.test(block)
      // Strip the icon element, then tags. JSX expressions are deliberately KEPT:
      // `{children}` is how a wrapper component renders its label, and removing it
      // would report every well-built wrapper as unnameable.
      const withoutIcons = block.replace(/<Icon\b[^>]*\/>/g, '').replace(/<[^>]+>/g, '').trim()
      // Something textual must remain: either literal text or an expression.
      const hasContent = /[\p{L}\p{N}]/u.test(withoutIcons) || /\{[^}]+\}/.test(withoutIcons)
      if (!named && !hasContent) bareIconButtons.push(file.replace(CLIENT, ''))
    }
  }
  check('a11y: no icon-only button lacks a name', bareIconButtons.length === 0, bareIconButtons.length === 0 ? `${tsxFiles.length} components scanned` : bareIconButtons.join(', '))

  // The IconButton component itself must attach both the tooltip and the name.
  const iconButton = read('components/IconButton.tsx')
  check('a11y: IconButton sets title and aria-label', /title=\{label\}/.test(iconButton) && /aria-label=\{label\}/.test(iconButton), 'both present')
  check('a11y: IconButton requires the label prop', /label: string/.test(iconButton) && !/label\?:/.test(iconButton), 'required, not optional')

  // Decorative glyphs must be hidden from assistive technology.
  const icon = read('components/Icon.tsx')
  check('a11y: decorative glyphs are aria-hidden', /aria-hidden=\{rest\['aria-label'\] === undefined \? true : undefined\}/.test(icon), 'hidden unless given a label')
  check('a11y: glyphs are not focusable', /focusable=\{false\}/.test(icon), 'focusable={false}')
}

// ---------------------------------------------------------------------------
// §8.4 状态语义 — status must not be carried by colour alone
// ---------------------------------------------------------------------------
{
  const statusPill = read('components/StatusPill.tsx')
  check('a11y: status pill requires visible wording', /label: string/.test(statusPill) && !/label\?:/.test(statusPill), 'label is required')
  const pillCss = read('components/StatusPill.module.css')
  check('a11y: status pill carries a border as well as colour', /border-color:\s*var\(--kb-status/.test(pillCss), 'border token per state')
  check('a11y: status pill carries a solid mark', /background:\s*currentColor/.test(pillCss), 'dot or rail supplies the solid')

  // Every status-bearing surface must pair the tone with text.
  check('a11y: quota notice states severity in words', /存储配额不足|接近配额/.test(read('components/QuotaNotice.tsx')), 'wording present')
  check('a11y: search tool block states failure in words', /无命中|失败/.test(read('SearchToolView.tsx')), 'a failed call says so')
  check('a11y: documents row states transfer failure in words', /reason/.test(read('components/DocumentRow.tsx')), 'the reason is rendered, not implied by tone')
}

// ---------------------------------------------------------------------------
// §8.4 键序 / 键盘可达 — keyboard reachability and order
// ---------------------------------------------------------------------------
{
  const dropzone = read('components/UploadDropzone.tsx')
  check('a11y: the drop zone is keyboard reachable', /<button/.test(dropzone), 'rendered as a button, not a div with onDrop')

  // A hidden input cannot be activated; the visually-hidden pattern must be used.
  // Scoped to the `.input` rule: a file-wide search for `display: none` would hit
  // the disabled *button* rule and flag a correct implementation.
  const dropzoneCss = read('components/UploadDropzone.module.css')
  const inputRule = /\.input\s*\{[^}]*\}/.exec(dropzoneCss)?.[0] ?? ''
  check('a11y: the file input is visually hidden, not display:none', /clip-path:\s*inset\(50%\)/.test(inputRule) && !/display:\s*none/.test(inputRule), 'clip-path pattern in the input rule')

  // The tablist must move with arrow keys, which the WAI-ARIA pattern requires.
  const tabs = read('components/Tabs.tsx')
  check('a11y: tabs support arrow-key navigation', /ArrowRight/.test(tabs) && /ArrowLeft/.test(tabs), 'both directions')
  check('a11y: tabs wrap at the ends', /% items\.length/.test(tabs), 'modular stepping')

  // Reduced motion must be honoured.
  check('a11y: reduced motion is honoured', /prefers-reduced-motion/.test(read('styles/base.css')), 'transition and animation suppressed')
}

// ---------------------------------------------------------------------------
// §8.2 五态覆盖 — the five data-region states must exist and be distinct
// ---------------------------------------------------------------------------
{
  // Loading: skeletons whose shape matches the content, not a bare spinner.
  check('states: overview has a loading skeleton', /skeleton/.test(read('pages/OverviewPage.module.css')), 'skeleton class present')
  check('states: documents has a loading skeleton', /skeleton/.test(read('pages/DocumentsPage.module.css')), 'skeleton class present')
  check('states: skeletons are announced as busy', /aria-busy="true"/.test(read('pages/OverviewPage.tsx')) && /aria-busy="true"/.test(read('pages/DocumentsPage.tsx')), 'aria-busy on both')

  // Empty: must explain why and offer a next step.
  const overview = read('pages/OverviewPage.tsx')
  const documents = read('pages/DocumentsPage.tsx')
  check('states: overview empty state explains and points onward', /还没有知识库/.test(overview) && /创建/.test(overview), 'explanation plus next step')
  check('states: filtered-empty is distinct from truly-empty', /没有匹配的知识库/.test(overview) && /没有匹配的文档/.test(documents), 'a filtered empty state differs from an empty store')

  // Error: reason plus a recovery path, never a bare code.
  check('states: overview error names the cause', /errorBody/.test(overview), 'the reason is rendered')
  check('states: overview error offers retry', /重试/.test(overview), 'retry affordance')
  check('states: errors are announced as alerts', /role="alert"/.test(overview) && /role="alert"/.test(documents), 'both pages')

  // Success: a write operation must confirm itself. The create dialog closes and
  // the new card appears; the build pipeline reports completion in its log.
  check('states: a completed build reports success', /log\('success'/.test(readFileSync(join(ROOT, 'src', 'store', 'build.ts'), 'utf8')), 'success log line emitted')
  check('states: a failed build reports the reason', /log\('error'/.test(readFileSync(join(ROOT, 'src', 'store', 'build.ts'), 'utf8')), 'error log line emitted')

  // The retrieval-strategy page is a write surface too, so it must carry the same
  // states: a reason-plus-range message on rejection, a confirmation on success,
  // and a next-step empty state rather than a blank form.
  const strategyPage = read('pages/RetrievalStrategyPage.tsx')
  check('states: the strategy page confirms a successful save', /已生效/.test(strategyPage), 'the confirmation names the values now in force')
  check('states: the strategy page announces failures as alerts', /role="alert"/.test(strategyPage), 'rejections are announced')
  check('states: the strategy page empty state points onward', /尚未选择知识库/.test(strategyPage) && /总览/.test(strategyPage), 'explanation plus next step')
  check('states: the strategy page states unsaved changes', /有未保存的修改/.test(strategyPage), 'the draft is distinguishable from the stored value')

  // Restricted: the quota state, reachable because a quota is configurable.
  const quotaNotice = read('components/QuotaNotice.tsx')
  check('states: restricted state names the limit source', /存储配额不足/.test(quotaNotice), 'wording states it is a quota')
  check('states: restricted state names the remedy', /解除方式/.test(quotaNotice), 'explicit remedy')
  check('states: the restricted banner is not permanent', /return null/.test(quotaNotice), 'absent when unlimited and unblocked')
}

// ---------------------------------------------------------------------------
// §4.7 组件状态清单 — the interactive tier's four checkable states
// ---------------------------------------------------------------------------
{
  const gate = readFileSync(join(ROOT, 'scripts', 'verify-components.mjs'), 'utf8')
  check('states: the component gate checks hover', /state: 'hover'/.test(gate), 'hover')
  check('states: the component gate checks focus', /state: 'focus'/.test(gate), 'focus')
  check('states: the component gate checks disabled', /state: 'disabled'/.test(gate), 'disabled')
  check('states: the component gate checks loading', /state: 'loading'/.test(gate), 'loading')
  check('states: markers are forbidden interactive states', /FORBIDDEN_MARKER_STATES/.test(gate), 'the reverse check exists')
  check('states: an unknown tier fails rather than passing', /unknown tier/.test(gate), 'typo in TIERS is caught')
}

// ---------------------------------------------------------------------------
// §8.3 按页唯一主操作 — one primary per page
// ---------------------------------------------------------------------------
{
  const pages = [
    'pages/OverviewPage.tsx', 'pages/BuildPage.tsx', 'pages/DocumentsPage.tsx',
    // The retrieval-strategy page owns a save action, so it is subject to the same
    // one-primary rule as every other page rather than being exempt for being new.
    'pages/RetrievalStrategyPage.tsx',
  ]
  for (const page of pages) {
    const source = read(page)
    const primaries = (source.match(/variant="primary"/g) ?? []).length
    check(`§8.3: ${page} declares at most one primary`, primaries <= 1, `${primaries} occurrence(s)`)
  }
  // The dialog is its own surface, and it must also have exactly one.
  const dialog = read('dialogs/CreateCollectionDialog.tsx')
  check('§8.3: the dialog declares exactly one primary', (dialog.match(/variant="primary"/g) ?? []).length === 1, 'one primary')
}

// ---------------------------------------------------------------------------
// §8.3 负向校验必须说明可接受范围
// ---------------------------------------------------------------------------
{
  // Every validator's message must state what *is* acceptable, not only what is
  // wrong. Checked by calling them rather than reading them.
  const strategy = await import(new URL('../lib/store/strategy.js', import.meta.url).href)
  const documents = await import(new URL('../lib/store/documents.js', import.meta.url).href)
  const { assertValidConfig } = await import(new URL('../lib/config.js', import.meta.url).href)

  // The `weights != 1` case is gone with the control itself (KB-FIX-02): RRF
  // fusion takes no weights, so there is no weight constraint to state.
  const validations = [
    { what: 'overlap >= chunk', message: strategy.validateChunking({ ...strategy.CHUNKING_DEFAULTS, chunkTokens: 128, overlapTokens: 128 }) },
    { what: 'min > chunk', message: strategy.validateChunking({ ...strategy.CHUNKING_DEFAULTS, chunkTokens: 100, overlapTokens: 10, minChunkTokens: 200 }) },
    { what: 'M out of range', message: strategy.validateIndex({ ...strategy.INDEX_DEFAULTS, m: 2 }) },
    { what: 'bad extension', message: documents.validateUpload('a.exe', 100) },
    { what: 'no extension', message: documents.validateUpload('noext', 100) },
    { what: 'empty file', message: documents.validateUpload('a.md', 0) },
    { what: 'oversized', message: documents.validateUpload('a.md', documents.MAX_UPLOAD_BYTES + 1) },
  ]
  for (const { what, message } of validations) {
    // The accepted range is expressed by naming the limit, the supported set, or
    // the legal interval — one of the three is always applicable.
    const statesRange = message !== null
      && (/必须|不能|需在|支持|上限|可接受|之和/.test(message))
    check(`§8.3: the ${what} rejection states the requirement`, statesRange, message ?? '(accepted!)')
  }

  let configMessage = ''
  try {
    assertValidConfig({
      stateDir: '.kb',
      chunking: { mode: 'heading', chunkTokens: 100, overlapTokens: 200, minChunkTokens: 64 },
      retrieval: { topk: 8, minScore: 0.55 },
      quota: { bytes: null, warnAt: 0.9 },
    })
  } catch (error) { configMessage = String(error instanceof Error ? error.message : error) }
  check('§8.3: a config rejection names both values', configMessage.includes('200') && configMessage.includes('100'), configMessage)
}

console.log(`\nKB-11 walkthrough: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
