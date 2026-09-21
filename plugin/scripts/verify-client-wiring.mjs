/**
 * KB-FIX-14 acceptance: the client bundle's registrations actually work.
 *
 * ## Why this suite executes the bundle instead of grepping it
 *
 * Every other client test asserts on **source text** — that a symbol is exported,
 * that a slot name appears, that a wrapper marker is present. None of them runs
 * `apply()`. That gap is exactly how the `@`-completion feature shipped broken
 * while every gate stayed green: `triggerRegistryOf` required `toggleSource` on
 * the root `ctx.inputTriggers` service, which the harness's contract gives to the
 * *per-session controller* instead, so the guard rejected a perfectly good registry
 * and the composer button became a clickable control that silently did nothing.
 *
 * A textual assertion cannot catch that. Assigning the wrong set of methods is a
 * mistake about an object's shape, and only calling it reveals the truth, so this
 * suite loads `lib/client.js`, drives `apply()` against contexts shaped like the
 * harness, and clicks the button.
 *
 * Usage: node scripts/verify-client-wiring.mjs
 */

import { dirname, resolve } from 'node:path'
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

// ---------------------------------------------------------------------------
// Load the shipped bundle the way the browser does
// ---------------------------------------------------------------------------

const loaded = {}
globalThis.window = { __ModuleLoader__: { load: (module) => Object.assign(loaded, module) } }

/** A jsx-runtime stub: elements are plain records, enough to read props. */
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })

const fakeElement = {
  dataset: {}, styleSheet: null, textContent: '', rel: '', href: '',
  childNodes: [], nodeType: 1, parentNode: null,
  setAttribute() {}, appendChild() {}, remove() {},
}
globalThis.document = {
  documentElement: { setAttribute() {}, removeAttribute() {}, appendChild() {} },
  head: { appendChild() {}, removeChild() {} },
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ ...fakeElement }),
  createTextNode: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
}
globalThis.HTMLElement = class {}
globalThis.Node = class {}

await import(new URL('../lib/client.js', import.meta.url).href)
check('bundle: registers itself with the module loader', typeof loaded.factory === 'function', `id=${String(loaded.id)}`)

/**
 * State cells and setters recorded by the stub's `useState`.
 *
 * The citation list lives behind a disclosure, so the only way to assert on it is
 * to be able to open it. Tracking the setters is what makes that possible without
 * a real reconciler.
 */
/**
 * The hook state, keyed per component layer and per hook index.
 *
 * React persists `useState` across renders; a stub that mints a fresh cell each
 * call cannot be driven, because flipping a setter would write to a cell the next
 * render never reads. The cells are therefore held per *layer* — one array per
 * depth in the element chain — since each component in that chain is its own
 * instance with its own hook list.
 */
const hookCellsByLayer = []
const stateSetters = new Set()
let hookCursor = 0
let hookLayer = 0

/** Begin a render pass for one component layer. */
function beginRender(layer) {
  hookLayer = layer
  hookCursor = 0
}

/**
 * Every setter the last render pass recorded.
 *
 * The disclosure's setter is the one that opens the card; the test flips them all
 * and re-renders, which is what makes the collapsed subtree reachable.
 * @returns the setters, in registration order.
 */
function setters() {
  return [...stateSetters]
}

/**
 * Forget every hook cell and setter, for a fresh component instance.
 *
 * A new element chain is a new instance: carrying the previous one's cells over
 * would let an earlier block's expanded state leak into a later assertion, which
 * is the kind of cross-test coupling that makes a gate pass for the wrong reason.
 */
function resetHookState() {
  hookCellsByLayer.length = 0
  stateSetters.clear()
}

const mod = loaded.factory((specifier) => {
  if (specifier === 'react') {
    return {
      createElement: jsx,
      useState: (initial) => {
        const cells = hookCellsByLayer[hookLayer] ?? (hookCellsByLayer[hookLayer] = [])
        const index = hookCursor
        hookCursor += 1
        if (cells[index] === undefined) {
          cells[index] = typeof initial === 'function' ? initial() : initial
        }
        const setter = (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next
        }
        // Recorded when the hook is *created*, not when the setter is called: the
        // test needs the setter in order to call it at all, so registering it
        // lazily would leave the list empty exactly when it is first needed.
        stateSetters.add(setter)
        return [cells[index], setter]
      },
      useEffect: () => {}, useMemo: (fn) => fn(), useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }), Fragment: 'Fragment',
    }
  }
  if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
  return {}
})

check('bundle: exports an apply()', typeof mod.apply === 'function', typeof mod.apply)
check(
  'bundle: declares the services it reads',
  Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('inputTriggers'),
  JSON.stringify(mod.inject),
)

// ---------------------------------------------------------------------------
// Drive apply() against contexts shaped like the harness
// ---------------------------------------------------------------------------

/**
 * Run the bundle's apply() against a harness-shaped context.
 * @param options - which parts of the harness to expose.
 * @returns the recorded registrations.
 */
function drive({ exposeRoot = true, exposeSessionOf = true } = {}) {
  const sources = []
  const toggles = []
  const slots = []
  const controller = {
    toggleSource: (name, hit) => { toggles.push({ name, hit }) },
    pick: () => {}, dismiss: () => {}, refreshOpenMenu: () => {},
  }
  const inputTriggers = {
    registerSource: (source) => { sources.push(source); return () => {} },
    // The harness contract gives `sessionOf` (not `toggleSource`) on the root.
    ...(exposeSessionOf ? { sessionOf: () => controller } : {}),
  }
  const slotsService = {
    inject: (_key, callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    register: (options, component) => { slots.push({ options, component }); return () => {} },
  }
  const ctx = {
    slots: slotsService,
    ...(exposeRoot ? { inputTriggers } : {}),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get(name) {
      if (name === 'slots') return slotsService
      if (name === 'inputTriggers') return inputTriggers
      return undefined
    },
  }
  let error = null
  try { mod.apply(ctx) } catch (cause) { error = String(cause?.message ?? cause) }
  return { error, sources, toggles, slots }
}

/**
 * Drive the composer button with the shares the slot actually provides.
 *
 * The button no longer reaches the trigger controller: `conversation.input.right`
 * hands its entry an empty owner share, so the session-scoped `sessionOf` call it
 * used to make always failed and the failure was swallowed. It writes the draft
 * through `inputActions.setDraft` instead, which `SessionStandardProps` documents
 * as the session's stable public input actions.
 * @param result - the drive() result.
 * @returns what the component received and did.
 */
function driveComposer(result) {
  const button = result.slots.find(entry => entry.options.name === 'conversation.input.right')
  if (button === undefined) return { present: false }
  const drafts = []
  const shares = {
    // Standard session shares. `useInput` is a selector hook; the draft is what
    // the button appends to.
    useInput: (select) => select({ draft: '已有内容', phase: 'plain' }),
    inputActions: { setDraft: (text) => { drafts.push(text) } },
  }
  const element = button.component(shares)
  // The registration renders `<KbButton …/>`, and a component reference is a
  // function in the element tree — a stub runtime does not call it. Invoking it
  // here is what reaches the control the user actually clicks.
  const rendered = typeof element?.type === 'function' ? element.type(element.props) : element
  const kids = rendered?.props?.children
  const control = (Array.isArray(kids) ? kids : [kids]).find(
    kid => kid != null && (kid.type === 'button' || kid.props?.onClick !== undefined),
  )
  const onClick = control?.props?.onClick
  return {
    present: true,
    clickable: typeof onClick === 'function',
    click: onClick,
    drafts,
    disabled: control?.props?.disabled,
  }
}

// The shape the harness actually provides. This is the case that was broken.
{
  const result = drive()
  check('harness shape: apply() does not throw', result.error === null, result.error ?? 'ok')
  check('harness shape: the @ trigger source is registered', result.sources.length === 1, `${result.sources.length} source(s)`)
  const source = result.sources[0]
  check('harness shape: the source declares the @ trigger', source?.trigger === '@', String(source?.trigger))
  check('harness shape: the source exposes candidates()', typeof source?.candidates === 'function', typeof source?.candidates)
  check('harness shape: the source exposes a codec', typeof source?.codec?.serialize === 'function', typeof source?.codec?.serialize)
  const click = driveComposer(result)
  check('harness shape: the composer button is registered', click.present === true, click.present ? 'present' : 'absent')
  check(
    'harness shape: the button is wired to the session input actions',
    click.clickable === true && click.disabled === false,
    click.clickable ? `disabled=${click.disabled}` : 'no onClick on the control',
  )
}

// Degraded harnesses must lose the feature, never the panel.
{
  const result = drive({ exposeSessionOf: false })
  check('degraded: no sessionOf still registers the source', result.sources.length === 1 && result.error === null, result.error ?? 'ok')
  const click = driveComposer(result)
  // The button no longer depends on the controller at all, so it stays live —
  // which is the improvement: the entrances are independent of each other.
  check(
    'degraded: the button still works without the trigger controller',
    click.present === true && click.clickable === true,
    `present=${click.present} clickable=${click.clickable}`,
  )
}
{
  const result = drive({ exposeRoot: false })
  check('degraded: no inputTriggers does not throw', result.error === null, result.error ?? 'ok')
  check('degraded: no inputTriggers registers no source', result.sources.length === 0, `${result.sources.length} source(s)`)
  const click = driveComposer(result)
  check('degraded: the button is still registered', click.present === true, click.present ? 'present' : 'absent')
}

/**
 * Render a component to the depth the citation assertions need.
 *
 * Each component layer gets its own hook cursor, because hooks belong to the
 * component instance that called them: sharing one cursor across layers would let
 * an outer component's `useState` overwrite an inner one's. A stub runtime does not
 * reconcile, so this walks the element chain explicitly.
 * @param element - the element to render.
 * @param depth - how many component layers to expand.
 * @returns the expanded tree.
 */
function renderDeep(element, depth = 4) {
  let node = element
  for (let level = 0; level < depth; level += 1) {
    if (node == null || typeof node !== 'object') break
    if (typeof node.type !== 'function') break
    beginRender(level)
    const before = node
    node = node.type(node.props)
    if (node === before) break
  }
  return node
}

/** Every click handler reachable from a rendered tree. */
function handlersOf(node) {
  const found = []
  const walk = value => {
    if (value == null || typeof value !== 'object') return
    if (typeof value.props?.onClick === 'function') found.push(value.props.onClick)
    for (const child of Object.values(value)) walk(child)
  }
  walk(node)
  return found
}

/** Serialize a tree for textual assertions. */
function treeOf(node) {
  return JSON.stringify(node, (key, value) => (typeof value === 'function' ? '[fn]' : value))
}

// Every registration this plugin makes must still be present.
{
  const result = drive()
  const names = result.slots.map(entry => entry.options.name).sort()
  for (const expected of ['main', 'sidebar.panellist', 'tool.call.toolview', 'conversation.input.right', 'sidebar.right.pane.tab']) {
    check(`slot: ${expected} is registered`, names.includes(expected), names.join(', '))
  }
}

// ---------------------------------------------------------------------------
// The citation chain, driven end to end.
//
// This is the part no textual gate can see. The chain is
//   rendered tool result → parsed hit → citation reference → openTab call,
// and every link is a *shape* fact: whether the regex recovered the path, whether
// the document id came out of it, whether the service lookup found what the
// harness really exposes. Driving it catches a broken link; grepping cannot.
// ---------------------------------------------------------------------------

/**
 * Drive apply() with the right Sidebar exposed, and capture what it registers.
 * @returns the drive result plus the captured tab types and opens.
 */
function driveWithSidebar() {
  const tabTypes = []
  const opens = []
  const sidebarRight = {
    registerTabType: (definition) => { tabTypes.push(definition); return () => {} },
    openTab: (kind, options) => { opens.push({ kind, options }) },
  }
  const sources = []
  const slots = []
  const slotsService = {
    inject: (_key, callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    register: (options, component) => { slots.push({ options, component }); return () => {} },
  }
  const ctx = {
    slots: slotsService,
    sidebarRight,
    inputTriggers: { registerSource: (source) => { sources.push(source); return () => {} }, sessionOf: () => undefined },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get: (name) => (name === 'slots' ? slotsService : undefined),
  }
  let error = null
  try { mod.apply(ctx) } catch (cause) { error = String(cause?.message ?? cause) }
  return { error, tabTypes, opens, slots }
}

/** The rendered result text for a real `dsh_kb_search` call, as the model reads it. */
const RESULT_TEXT = [
  '查询「LangGraph 是什么」在 kb_agentbook_5eed 命中 2 条（稠密 + 全文混合）。',
  '1. [fair 0.73] .dsh-kb-zvec/kb_agentbook_5eed/sources/doc_ffb5b037.md:374 (字符 23252-24156)',
  '   | **LangChain / LangGraph** | 通用 LLM 应用框架 | 工作流 + 自主 |',
  '2. [fair 0.61] .dsh-kb-zvec/kb_agentbook_5eed/sources/doc_f51780f4.md:110 (字符 5595-6067)',
  '   MCP 是 Anthropic 于 2024 年底发布的开放标准。',
].join('\n')

{
  const result = driveWithSidebar()
  check('citation: apply() accepts a context with the right Sidebar', result.error === null, result.error ?? 'ok')
  check('citation: the tab type is registered', result.tabTypes.length === 1, `${result.tabTypes.length} type(s)`)

  const definition = result.tabTypes[0]
  check('citation: the type declares the citation kind', definition?.kind === 'kb-citation', String(definition?.kind))
  check(
    'citation: the type claims the citation scheme at extension band',
    Array.isArray(definition?.patterns) && definition.patterns.every(pattern => pattern.startsWith('dsh-kb-citation://'))
      && definition?.priority === 'extension',
    JSON.stringify(definition?.patterns),
  )

  // The body registration must be keyed by the type's id — the silent-failure
  // case this whole seam turns on.
  const body = result.slots.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  check('citation: the body is registered under the seat', body !== undefined, body === undefined ? 'absent' : 'present')
  check(
    'citation: the body key is the type id, not the kind',
    body?.options.key === definition?.id && definition?.id !== definition?.kind,
    `key=${body?.options.key} kind=${definition?.kind}`,
  )

  // The tool view, rendered from the real result text.
  //
  // The citation list sits behind the card's disclosure, so the card's own state
  // is driven open first — clicking its toggle — and then the tree is re-rendered.
  // Asserting on a collapsed card would assert on the wrong subtree.
  const toolView = result.slots.find(entry => entry.options.name === 'tool.call.toolview')
  const renderCard = () => {
    const card = toolView.component({
      callId: 'call-1',
      toolName: 'dsh_kb_search',
      block: {
        arguments: JSON.stringify({ query: 'LangGraph 是什么', collection: 'kb_agentbook_5eed' }),
        content: [{ type: 'text', text: RESULT_TEXT }],
      },
    })
    return renderDeep(card, 3)
  }

  resetHookState()
  let expanded = renderCard()
  // The disclosure starts closed; open it, then re-render so the list is present.
  const toggles = handlersOf(expanded)
  check('citation: the card opens with a disclosure toggle', toggles.length >= 1, `${toggles.length} handler(s)`)
  for (const setter of setters()) setter(value => !value)
  expanded = renderCard()

  const tree = treeOf(expanded)

  check('citation: the tool card renders', expanded != null, expanded == null ? 'null' : 'rendered')
  check(
    'citation: the locatable form is recovered as a path, not a display name',
    tree.includes('doc_ffb5b037') && tree.includes('doc_f51780f4'),
    'both document ids recovered from the rendered paths',
  )
  check(
    'citation: the unresolvable fallback is not used for a resolvable hit',
    !tree.includes('#374') && !/\b#50\b/.test(tree),
    'the `name #ordinal` form is absent for located hits',
  )

  // Now click the first citation and see where it goes.
  check('citation: nothing is opened before a click', result.opens.length === 0, `${result.opens.length} open(s)`)

  // The card's own toggle is first in document order; the citation rows follow.
  const all = handlersOf(expanded)
  check('citation: each citation row is a real control', all.length >= 3, `${all.length} click handler(s)`)
  const citationClicks = all.slice(1)

  if (citationClicks.length > 0) {
    citationClicks[0]()
    check('citation: clicking a citation opens a tab', result.opens.length === 1, `${result.opens.length} open(s)`)
    const opened = result.opens[0]
    check('citation: it opens the citation kind', opened?.kind === 'kb-citation', String(opened?.kind))
    check(
      'citation: the address carries the collection, document and line',
      opened?.options?.contentId === 'dsh-kb-citation://kb_agentbook_5eed/doc_ffb5b037#L374',
      String(opened?.options?.contentId),
    )
    check(
      'citation: the chunk range travels as a navigation param',
      opened?.options?.params?.chunkRange?.start === 23252 && opened?.options?.params?.chunkRange?.end === 24156,
      JSON.stringify(opened?.options?.params?.chunkRange),
    )
    check(
      'citation: the query is carried so the pane is self-describing',
      opened?.options?.params?.query === 'LangGraph 是什么',
      String(opened?.options?.params?.query),
    )
    check('citation: an already-open citation is revealed, not duplicated',
      opened?.options?.revealIfOpened === true, String(opened?.options?.revealIfOpened))

    // Two citations of DIFFERENT documents must address two different tabs.
    if (citationClicks.length >= 2) {
      citationClicks[1]()
      check('citation: a different document addresses a different tab',
        result.opens.length === 2 && result.opens[1].options.contentId !== result.opens[0].options.contentId,
        `${result.opens[1]?.options?.contentId}`)
    }
  }
}

// A deployment without the right column must lose the link, never the card.
{
  const sources = []
  const slots = []
  const slotsService = {
    inject: (_key, callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    register: (options, component) => { slots.push({ options, component }); return () => {} },
  }
  const ctx = {
    slots: slotsService,
    inputTriggers: { registerSource: (source) => { sources.push(source); return () => {} }, sessionOf: () => undefined },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get: (name) => (name === 'slots' ? slotsService : undefined),
  }
  let error = null
  try { mod.apply(ctx) } catch (cause) { error = String(cause?.message ?? cause) }
  check('degraded: no sidebarRight does not throw', error === null, error ?? 'ok')

  // A fresh component instance: the hook cells from the previous block belong to
  // a different render chain, and reusing them would carry its expanded state in.
  resetHookState()
  const toolView = slots.find(entry => entry.options.name === 'tool.call.toolview')
  const renderCard = () => renderDeep(toolView.component({
    callId: 'call-1',
    toolName: 'dsh_kb_search',
    block: {
      arguments: JSON.stringify({ query: 'x', collection: 'kb_agentbook_5eed' }),
      content: [{ type: 'text', text: RESULT_TEXT }],
    },
  }), 3)
  let expanded = renderCard()
  for (const setter of setters()) setter(value => !value)
  expanded = renderCard()

  // The card's own expand toggle is still a button, so the citation rows are
  // what must be gone. Counted against the with-sidebar case: 2 citations + 1
  // toggle there, so a bare toggle here.
  check(
    'degraded: citations render as plain text, not dead links',
    handlersOf(expanded).length === 1,
    `${handlersOf(expanded).length} click handler(s) (expect only the expand toggle)`,
  )
  const tree = treeOf(expanded)
  check('degraded: the citation text is still shown', tree.includes('doc_ffb5b037'), 'the row still names its source')
  check(
    'degraded: the source path is still printed for a reader to follow by hand',
    tree.includes('sources/doc_ffb5b037.md'),
    'the citation remains traceable without the column',
  )
}

// ---------------------------------------------------------------------------

console.log('')
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
console.log('')
console.log(`Client wiring: ${passes.length} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
