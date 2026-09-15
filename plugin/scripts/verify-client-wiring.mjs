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

const mod = loaded.factory((specifier) => {
  if (specifier === 'react') {
    return {
      createElement: jsx,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

/** Click the composer button and report whether the menu was asked to open. */
function clickComposer(result) {
  const button = result.slots.find(entry => entry.options.name === 'conversation.input.right')
  if (button === undefined) return { present: false }
  const element = button.component({ locked: false })
  const onOpen = element?.props?.onOpen
  if (typeof onOpen !== 'function') return { present: true, openable: false }
  onOpen()
  return { present: true, openable: true, opens: result.toggles.length }
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
  const click = clickComposer(result)
  check('harness shape: the composer button is registered', click.present === true, click.present ? 'present' : 'absent')
  check(
    'harness shape: clicking it opens the trigger menu',
    click.opens === 1,
    click.opens === undefined ? 'no onOpen' : `toggleSource called ${click.opens} time(s) (0 = silent no-op)`,
  )
}

// Degraded harnesses must lose the feature, never the panel.
{
  const result = drive({ exposeSessionOf: false })
  check('degraded: no sessionOf still registers the source', result.sources.length === 1 && result.error === null, result.error ?? 'ok')
  const click = clickComposer(result)
  check('degraded: the button stays present and is a safe no-op', click.present === true && click.opens === 0, `opens=${click.opens}`)
}
{
  const result = drive({ exposeRoot: false })
  check('degraded: no inputTriggers does not throw', result.error === null, result.error ?? 'ok')
  check('degraded: no inputTriggers registers no source', result.sources.length === 0, `${result.sources.length} source(s)`)
  const click = clickComposer(result)
  check('degraded: the button is still registered', click.present === true, click.present ? 'present' : 'absent')
}

// Every registration this plugin makes must still be present.
{
  const result = drive()
  const names = result.slots.map(entry => entry.options.name).sort()
  for (const expected of ['main', 'sidebar.panellist', 'tool.call.toolview', 'conversation.input.right']) {
    check(`slot: ${expected} is registered`, names.includes(expected), names.join(', '))
  }
}

// ---------------------------------------------------------------------------

console.log('')
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
console.log('')
console.log(`Client wiring: ${passes.length} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
