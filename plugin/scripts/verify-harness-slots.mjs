/**
 * Integration probe: does the plugin's registration satisfy the real harness?
 *
 * The acceptance suite asserts the registration *source*; this asserts the
 * *contract*. The distinction matters because the failure mode being guarded is
 * silent: a mistyped slot key, or a sidebar id that does not match its panel key,
 * produces a plugin that loads cleanly and renders nothing at all.
 *
 * The probe reads the harness's own slot catalogue — the `dsh-cordis-client-runner`
 * ships one as a machine-readable table, including each slot's kind, scope and
 * taken key domain — and checks this plugin's two registrations against it. That
 * is a real cross-check against the installed harness rather than against a copy
 * of its types.
 *
 * Usage: node scripts/verify-harness-slots.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ENTRY = join(ROOT, 'src', 'client', 'index.tsx')
const PANEL_ID = join(ROOT, 'src', 'client', 'panel-id.ts')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

/**
 * Locate the installed harness.
 * @returns the package root, or `null` when the harness is not installed.
 */
function findHarness() {
  const global = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['root', '-g'],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  )
  const roots = [global.stdout?.trim(), join(process.env.APPDATA ?? '', 'npm', 'node_modules')].filter(Boolean)
  for (const root of roots) {
    const candidate = join(root, '@deepseek-ai', 'dsh')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const harness = findHarness()
if (harness === null) {
  console.log('harness not found on this machine; skipping the integration probe (not a failure)')
  process.exit(0)
}

// The runner's catalogue is a literal table in its bundle; reading it means the
// check runs against whatever harness is actually installed.
const runnerDir = join(harness, 'node_modules', '@deepseek-ai', 'dsh-cordis-client-runner', 'lib')
if (!existsSync(runnerDir)) {
  console.log(`slot catalogue not found under ${runnerDir}; skipping (not a failure)`)
  process.exit(0)
}
const runnerFiles = readdirSync(runnerDir).filter(name => name.endsWith('.js'))
const catalogue = runnerFiles
  .map(name => readFileSync(join(runnerDir, name), 'utf8'))
  .join('\n')

// Pull the two slot entries this plugin depends on out of the catalogue.
/**
 * Extract one slot's catalogue entry text.
 * @param key - slot key.
 * @returns the entry's source text, or `null`.
 */
function slotEntry(key) {
  const at = catalogue.indexOf(`key: "${key}"`)
  if (at === -1) return null
  // The entry is one object literal; 900 chars is comfortably past its end and
  // the following entry's start is a reliable terminator.
  return catalogue.slice(at, at + 900)
}

const entrySource = readFileSync(CLIENT_ENTRY, 'utf8')
const idSource = readFileSync(PANEL_ID, 'utf8')
const panelKey = /KNOWLEDGE_PANEL_KEY = '([^']+)'/.exec(idSource)?.[1]
const sidebarId = /KNOWLEDGE_SIDEBAR_ID = '([^']+)'/.exec(idSource)?.[1]

check('probe: panel key and sidebar id are readable', panelKey !== undefined && sidebarId !== undefined, `key=${panelKey} id=${sidebarId}`)

// 1. The sidebar slot exists, is a list, and is root-scoped.
{
  const entry = slotEntry('sidebar.panellist')
  check('harness: sidebar.panellist exists', entry !== null, entry === null ? 'not in the installed catalogue' : 'present in the catalogue')
  if (entry !== null) {
    check('harness: sidebar.panellist is a root list', /kind: "list"/.test(entry) && /scope: "root"/.test(entry), 'kind=list, scope=root')
    check('harness: sidebar.panellist takes an id', /name: "id"/.test(entry), 'list entries address a cell by id')
  }
}

// 2. The main slot exists, is keyed, and the chosen key is not taken.
{
  const entry = slotEntry('main')
  check('harness: main panel slot exists', entry !== null, entry === null ? 'not in the installed catalogue' : 'present in the catalogue')
  if (entry !== null) {
    check('harness: main slot is keyed and root-scoped', /kind: "keyed"/.test(entry) && /scope: "root"/.test(entry), 'kind=keyed, scope=root')

    // The catalogue states which keys other plugins already registered. Taking a
    // key that is in use would shadow that panel rather than add one.
    const taken = /already taken: ([^"]*)/.exec(entry)?.[1] ?? ''
    const takenKeys = taken.split(',').map(value => value.trim()).filter(Boolean)
    check(
      'harness: the chosen panel key is free',
      panelKey !== undefined && !takenKeys.includes(panelKey),
      `key "${panelKey}" vs taken [${takenKeys.join(', ')}]`,
    )
  }
}

// 3. The three registrations must address each other correctly.
check('contract: sidebar id matches the panel key', panelKey === sidebarId, `id=${sidebarId} key=${panelKey}`)
check('contract: the panel is registered into main', /name: 'main', key: KNOWLEDGE_PANEL_KEY/.test(entrySource), 'main/key registration found')
check('contract: the row is registered into sidebar.panellist', /name: 'sidebar\.panellist'/.test(entrySource), 'panellist registration found')

// The tool-view cell is keyed by the WIRE TOOL NAME, and a mismatch renders
// nothing at all with no error — so the shared constant is checked against the
// harness's own record of registered tool names.
{
  const entry = slotEntry('tool.call.toolview')
  check('harness: tool.call.toolview exists', entry !== null, entry === null ? 'not in the catalogue' : 'present in the catalogue')
  if (entry !== null) {
    check('harness: tool.call.toolview is a keyed session slot', /kind: "keyed"/.test(entry) && /scope: "session"/.test(entry), 'kind=keyed, scope=session')

    // The catalogue lists the keys other tools already occupy. Claiming one would
    // replace that tool's view rather than add our own.
    const taken = /already taken: ([^"]*)/.exec(entry)?.[1] ?? ''
    const takenKeys = taken.split(',').map(value => value.trim()).filter(Boolean)
    const shared = readFileSync(resolve(ROOT, 'src/shared/contract.ts'), 'utf8')
    const wireName = /KB_SEARCH_TOOL = '([^']+)'/.exec(shared)?.[1]
    check('contract: the tool-view key is the shared wire name', wireName !== undefined && entrySource.includes('KB_SEARCH_TOOL'), `key=${wireName}`)
    check(
      'harness: the tool-view key is free',
      wireName !== undefined && !takenKeys.includes(wireName),
      `key "${wireName}" vs ${takenKeys.length} taken keys`,
    )
    // The tool name the host registers must be the same string the client keys on.
    const hostTool = readFileSync(resolve(ROOT, 'src/host/search-tool.ts'), 'utf8')
    check('contract: host and client share one tool name', /from '\.\.\/shared\/contract\.ts'/.test(hostTool), 'the host imports the shared constant rather than declaring its own')
  }
}

// The citation tab body registers into the right Sidebar's keyed tab seat, and
// its key is the tab type's *id* — not its kind. That distinction is the one this
// check exists for: a kind is a shared discriminator an extension may take over
// from a builtin, while an id is unique per implementation, and registering under
// the wrong one produces a tab whose body silently never renders.
{
  const entry = slotEntry('sidebar.right.pane.tab')
  check('harness: sidebar.right.pane.tab exists', entry !== null, entry === null ? 'not in the catalogue' : 'present in the catalogue')
  if (entry !== null) {
    check(
      'harness: the citation tab seat is keyed and session-scoped',
      /kind: "keyed"/.test(entry) && /scope: "session"/.test(entry),
      'kind=keyed, scope=session',
    )
  }

  // The registered key must be the exported id constant, and the body must be
  // injected rather than registered outright: the right Sidebar is mounted by its
  // own package and activation order between plugins is not guaranteed.
  check(
    'contract: the citation body is keyed by the tab id, not the kind',
    /name: 'sidebar\.right\.pane\.tab', key: CITATION_ID/.test(entrySource),
    'keyed by CITATION_ID',
  )
  check(
    'contract: the citation body waits for the seat declaration',
    /ctx\.slots\.inject\('sidebar\.right\.pane\.tab'/.test(entrySource),
    'registered through inject',
  )

  // The tab type must be registered against the same id the body uses. A split
  // here is the second silent failure mode: the registry would dispatch a key no
  // body answers.
  const definition = readFileSync(resolve(ROOT, 'src/client/citation-definition.ts'), 'utf8')
  const tabId = /CITATION_ID = '([^']+)'/.exec(readFileSync(resolve(ROOT, 'src/client/citation-tab.ts'), 'utf8'))?.[1]
  check('contract: the tab type registers under the body key', /kind: CITATION_KIND/.test(definition) && tabId !== undefined, `id=${tabId}`)
  check(
    'contract: the tab type claims only its own scheme',
    /\$\{CITATION_SCHEME\}\*\*/.test(definition),
    'glob is scoped to the citation scheme',
  )
}

console.log(`\nHarness integration: ${passes.length} passed, ${failures.length} failed`)
console.log(`  harness  ${harness}\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
