/**
 * Reproduce the shipped load failure and prove the fix.
 *
 * The bug was that `apply()` threw while *building the tool definition*:
 * `resolveWorkspace` read `ctx.workspaceDir`, an undeclared property on a cordis
 * context proxy, which throws `cannot get property "workspaceDir" without inject`.
 * The throw escaped `ctx.effect(...)` and failed the whole plugin load, so an
 * entire profile refused to start.
 *
 * Two things therefore have to hold, and this script asserts both:
 *
 * 1. **`apply()` must not touch an undeclared context property.** Loading the
 *    plugin against a context that lacks the host's services must succeed.
 * 2. **The workspace must resolve per call, from the execution context.** The
 *    store root has to follow the session workspace, not `process.cwd()` and not
 *    whatever workspace happened to be in scope at registration time.
 *
 * Usage: node scripts/verify-load-safety.mjs
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const passes = []
const failures = []

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

const cordis = await import('@deepseek-ai/cordis')

/**
 * A minimal tool registry standing in for `@deepseek-ai/dsh-tools`.
 *
 * Only what the plugin uses: `register`, returning a disposer. Keeping the fake
 * this small is deliberate — if `apply()` needed more of the service than this,
 * the test should fail rather than quietly grow a second implementation.
 */
function fakeTools() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {
        const at = registered.indexOf(definition)
        if (at !== -1) registered.splice(at, 1)
      }
    },
  }
}

const tools = fakeTools()
const root = new cordis.Context()
root.provide('tools', tools)

// The session service the plugin resolves its workspace through, shaped like the
// real `SessionStore`: `list()` returning sessions that carry `header.cwd`.
const workspace = resolve(ROOT, 'tmp', 'load-safety-workspace')
mkdirSync(workspace, { recursive: true })
root.provide('sessions', {
  list: () => [{ header: { cwd: workspace } }],
})

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

// 1. Loading must not throw. This is the exact call that used to fail with
//    `cannot get property "workspaceDir" without inject`.
let loadError = null
try {
  root.plugin({
    name: 'zvec-knowledge-probe',
    inject: ['tools'],
    apply,
  }, {
    stateDir: '.dsh-kb-zvec',
    chunking: { mode: 'heading', chunkTokens: 1024, overlapTokens: 128, minChunkTokens: 64 },
    retrieval: { topk: 8, minScore: 0.55 },
    quota: { bytes: null, warnAt: 0.9 },
  })
  // The tool registration happens in an effect, which the fiber runs on activation.
  await new Promise(resolve => setTimeout(resolve, 50))
} catch (error) {
  loadError = error
}

check(
  'load: apply() does not throw on a context without workspaceDir',
  loadError === null,
  loadError === null ? 'plugin loaded, profile would boot' : `threw: ${loadError.message}`,
)

// 2. The tool must actually have been registered — a load that "succeeds" by
//    skipping the registration is not a fix.
check(
  'load: dsh_kb_search is registered',
  tools.registered.some(definition => definition.name === 'dsh_kb_search'),
  `${tools.registered.length} tool(s): ${tools.registered.map(d => d.name).join(', ') || '(none)'}`,
)

// 3. `ctx.workspaceDir` really does throw *on an injected fiber*, which is why the
//    read had to go — and, importantly, why it did NOT throw in the probe above.
//    The plugin declares `inject: ['tools']`, so its context resolves services
//    through the inject gate; a fiber with no `inject` at all reads `undefined`
//    and masks the bug entirely. A scratch implementation that forgot the
//    `inject` declaration would therefore load clean and fail in production,
//    which is exactly how this shipped.
const injectedThrew = await new Promise(done => {
  const ctx = root.plugin({
    name: 'undeclared-read-probe',
    inject: ['tools'],
    apply(fiberCtx) {
      try {
        void fiberCtx.workspaceDir
        done(false)
      } catch {
        done(true)
      }
    },
  }, {})
  void ctx
})
check(
  'context: reading an undeclared property throws on an injected fiber',
  injectedThrew === true,
  injectedThrew === true
    ? 'ctx.workspaceDir throws without inject — the diagnosed cause'
    : 'no longer throws — revisit the fix rationale',
)

// 4. The workspace must be resolved per call and follow the session, so a second
//    workspace lands in a second store rather than in the first one's.
const first = new KnowledgeOperations({ workspaceDir: () => workspace, stateDir: '.dsh-kb-zvec' })
check(
  'workspace: a call-resolved workspace roots the store under it',
  first.storeRoot === join(workspace, '.dsh-kb-zvec'),
  first.storeRoot,
)

const other = resolve(ROOT, 'tmp', 'load-safety-workspace-2')
let current = workspace
const switching = new KnowledgeOperations({ workspaceDir: () => current, stateDir: '.dsh-kb-zvec' })
const before = switching.storeRoot
current = other
const after = switching.storeRoot
check(
  'workspace: the store root follows the session, not the registration time',
  before === join(workspace, '.dsh-kb-zvec') && after === join(other, '.dsh-kb-zvec'),
  `${before} -> ${after}`,
)

// 5. Repeated calls in one workspace must reuse one bound object. The engine locks
//    a collection directory exclusively, so a fresh object per call would try to
//    open a second handle onto a lock the one object already owns.
const second = new KnowledgeOperations({ workspaceDir: () => workspace, stateDir: '.dsh-kb-zvec' })
check(
  'workspace: repeated calls reuse one object (no second engine lock)',
  second.bound() === second.bound() && second.storeRoot === second.bound().storeRoot,
  'bound() is stable for one resolved workspace',
)

// 6. One operation must resolve the workspace exactly once and then hold it. This
//    is the invariant that matters: a method that read the workspace twice could
//    read from one store and write to another if the session set changed between
//    the two reads. Resolution is NOT memoized on the object — that would pin the
//    plugin to the first session's workspace forever, which is the bug this whole
//    change exists to prevent — so it is asserted per operation instead.
let resolutions = 0
let liveWorkspace = workspace
const counting = new KnowledgeOperations({
  workspaceDir: () => {
    resolutions += 1
    return liveWorkspace
  },
  stateDir: '.dsh-kb-zvec',
})
resolutions = 0
await counting.listDocuments('kb_prod_2f8a')
const afterList = resolutions
resolutions = 0
counting.usage()
const afterUsage = resolutions
check(
  'workspace: one operation resolves the workspace once',
  afterList === 1 && afterUsage === 1,
  `listDocuments=${afterList} resolution(s), usage=${afterUsage} resolution(s)`,
)

// 7. A later call must observe a changed session workspace. Memoizing the identity
//    on the object would pass every other assertion here and still break isolation.
liveWorkspace = other
check(
  'workspace: a later call follows the session to a new workspace',
  counting.storeRoot === join(other, '.dsh-kb-zvec'),
  counting.storeRoot,
)

rmSync(resolve(ROOT, 'tmp', 'load-safety-workspace'), { recursive: true, force: true })
rmSync(other, { recursive: true, force: true })

console.log(`\nload-safety: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
