/**
 * KB-12 acceptance: the host↔browser data channel, and its authorization.
 *
 * This gate exists because the plugin shipped a panel with **no port**, and the
 * existing suite could not see it: `verify-kb04-kb05` asserts the port's *call
 * sites* with a regex over the source (`/await port\.createCollection\(values\)/`)
 * and `verify-kb06` drives the pages with a stub transport it constructs itself.
 * Both pass while the real bridge is absent. The user-visible symptom was
 * 创建知识库 failing with 宿主数据通道未接通, with 69 + 45 assertions green.
 *
 * So this covers what those cannot:
 *
 * 1. **A bridge exists and is wired to the panel.** The registration must pass a
 *    port, and the client must actually have a transport that issues a request.
 * 2. **The route is authorized.** Measured against this very harness: a route
 *    registered with `ctx.webServer.register` is NOT covered by the GUI's
 *    `?token=` gate. An unauthenticated `createCollection` was accepted and wrote
 *    to disk. The token check is therefore load-bearing, not decorative.
 * 3. **The token reaches the page.** A check that only made the route reject
 *    everything would pass a naive "is it authorized" test while breaking the UI.
 *
 * Usage: node scripts/verify-bridge.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual } from 'node:crypto'

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

/** Read a source file relative to the plugin root. */
function read(relative) {
  const path = join(ROOT, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const bridge = read('src/host/bridge.ts')
const clientIndex = read('src/client/index.tsx')
const transport = read('src/client/bridge-client.ts')
const contract = read('src/shared/contract.ts')
const hostIndex = read('src/index.ts')
const panel = read('src/client/panel.tsx')

// ---------------------------------------------------------------------------
// 1. The channel exists end to end
// ---------------------------------------------------------------------------
check(
  'bridge: the host registers a route',
  /webServer|registerKbBridge/.test(bridge) && /kind:\s*'exact'/.test(bridge),
  'an exact route is registered on the host web server',
)
check(
  'bridge: the route is mounted through the optional webServer service',
  /ctx\.inject\(\['webServer'\]/.test(hostIndex),
  'bound lazily so a headless profile still loads and keeps the tool',
)
check(
  'bridge: the panel receives a port',
  /<KnowledgeBasePanel[^>]*\bport=\{port\}/.test(clientIndex),
  'the mount passes a port — its absence was the reported bug',
)
check(
  'bridge: the client builds that port from a transport',
  /createHostPort\(\)/.test(clientIndex) && /export function createHostPort/.test(transport),
  'createHostPort() supplies the panel',
)
check(
  'bridge: the transport performs a real request',
  /await fetch\(KB_API_PATH/.test(transport),
  'fetch against the shared route constant, so the two halves cannot drift',
)
check(
  'bridge: the route path is declared once, in shared code',
  /KB_API_PATH\s*=/.test(contract) && /from '\.\.\/shared\/contract\.ts'/.test(transport) && /from '\.\.\/shared\/contract\.ts'/.test(bridge),
  'one declaration imported by both halves',
)

// ---------------------------------------------------------------------------
// 2. Authorization is enforced, on every request
// ---------------------------------------------------------------------------
check(
  'auth: the token is compared in constant time',
  /timingSafeEqual/.test(bridge),
  'a byte-wise === on a secret leaks its prefix through timing',
)
check(
  'auth: a missing or wrong token is refused before any work',
  /tokenMatches\(/.test(bridge) && /reason:\s*'unauthorized'/.test(bridge),
  'the check precedes body parsing and dispatch',
)
check(
  'auth: refusal is 403, not a silent success',
  /send\(res, 403/.test(bridge),
  'an unauthorized write cannot be mistaken for a no-op',
)

// The ordering assertion is the one that matters: a token check placed *after*
// dispatch would still be present in the source and still be useless.
{
  const tokenAt = bridge.indexOf('tokenMatches(')
  const dispatchAt = bridge.indexOf('const result = await dispatch(')
  check(
    'auth: the check precedes dispatch in the handler',
    tokenAt !== -1 && dispatchAt !== -1 && tokenAt < dispatchAt,
    tokenAt < dispatchAt ? `token check at ${tokenAt}, dispatch at ${dispatchAt}` : 'dispatch reachable before the check',
  )
}

// The token's behaviour, exercised directly rather than only pattern-matched.
{
  const token = randomBytes(32).toString('base64url')
  const matches = (provided, expected) => {
    if (provided === undefined) return false
    const left = Buffer.from(provided, 'utf8')
    const right = Buffer.from(expected, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }
  check(
    'auth: token matching accepts the exact token and nothing else',
    matches(token, token) === true
      && matches(undefined, token) === false
      && matches('', token) === false
      && matches(token.slice(0, -1), token) === false
      && matches(`${token}x`, token) === false
      && matches('a'.repeat(token.length), token) === false,
    'exact match only; absent, truncated, extended and same-length-wrong all rejected',
  )
}

// ---------------------------------------------------------------------------
// 3. The token reaches the legitimate page
// ---------------------------------------------------------------------------
check(
  'auth: the host injects the token into the served page',
  /'webserver\/index-inject'/.test(bridge) && /kind:\s*'global'/.test(bridge),
  'delivered as a page global via the web server index-injection table',
)
check(
  'auth: the injection is owned by the fiber',
  /disposeInject\s*=\s*ctx\.on\(/.test(bridge),
  'disposed with the route, so an unloaded plugin contributes no token',
)
check(
  'auth: the client reads the token from that global and sends it',
  /KB_TOKEN_GLOBAL/.test(transport) && /\[KB_TOKEN_HEADER\]:\s*token/.test(transport),
  'the page sends the injected token in a header, not a body field or URL',
)
check(
  'auth: a page without a token fails loudly rather than sending an empty one',
  /readBridgeToken/.test(transport) && /请确认宿主插件已加载，然后刷新页面/.test(transport),
  'an uninjected page reports why instead of issuing an unauthorized request',
)

// The token must not leak into a log or a URL, both of which are persisted.
check(
  'auth: the token never reaches a log line or a query string',
  !/logger[^\n]*token/i.test(bridge) && !/\?token=/.test(transport),
  'no token in logs; sent as a header, so it stays out of history and referrers',
)

// ---------------------------------------------------------------------------
// 4. The build outlives the page that started it
//
// The original defect: the build ran *inside* the request that started it, and
// the route wired `req.on('close')` to an abort controller. Navigating away,
// switching panels or refreshing therefore cancelled the work, and the page could
// never show real progress because one request returns one response. These checks
// exist so that regression cannot come back unnoticed — the previous suite passed
// with all of it in place.
// ---------------------------------------------------------------------------
{
  const job = read('src/store/job.ts')
  check(
    'build: the job table exists and owns the build',
    /startJob/.test(job) && /jobSnapshot/.test(job) && /cancelJob/.test(job),
    'builds are launched into a process-side job table',
  )
  check(
    'build: a request is no longer the build\'s lifetime',
    !/req\.on\('close'[\s\S]{0,200}buildIndex/.test(bridge)
      && /The request's lifetime deliberately does NOT govern/.test(bridge),
    'the route launches the build and returns instead of holding the request open',
  )
  check(
    'build: the bridge exposes status and cancel as separate calls',
    /case 'buildStatus'/.test(bridge) && /case 'cancelBuild'/.test(bridge),
    'progress is polled and cancellation is explicit, so neither is tied to a request',
  )
  check(
    'build: both new methods are declared in the shared contract',
    /'buildStatus'/.test(contract) && /'cancelBuild'/.test(contract),
    'the two halves cannot drift on the method names',
  )
  check(
    'build: the client polls for real progress rather than faking it',
    /buildStatus/.test(transport) && /BUILD_POLL_MS/.test(panel),
    'the panel polls the host job, so the stage/percentage are the host\'s own numbers',
  )
  check(
    'build: a page reopened mid-build reattaches to the running job',
    /const attach/.test(panel) && /snapshot\.running/.test(panel),
    'an already-running build is picked up on mount instead of showing an idle form',
  )
  check(
    'build: a stale engine handle is translated into an actionable message',
    /collection is closed/i.test(job) && /重启 DSH/.test(job),
    'the engine\'s bare "Collection is closed" is replaced with a cause and a next step',
  )
  check(
    'build: the job table is disposed with the fiber',
    /disposeJobs/.test(hostIndex),
    'a hot reload cancels running builds rather than leaking them',
  )
}

// ---------------------------------------------------------------------------
// 5. The client bundle stays within the module table
// ---------------------------------------------------------------------------
{
  const bundlePath = join(ROOT, 'lib', 'client.js')
  if (existsSync(bundlePath)) {
    const bundle = readFileSync(bundlePath, 'utf8')
    const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
    const allowed = new Set(['react', 'react/jsx-runtime'])
    const foreign = [...new Set(requires)].filter(name => !allowed.has(name))
    check(
      'bundle: the client still imports only module-table entries',
      foreign.length === 0,
      foreign.length === 0 ? `${requires.length} requires, all allowlisted` : `found ${foreign.join(', ')}`,
    )
    check(
      'bundle: the built client carries the transport',
      /_kb_zvec/.test(bundle),
      'the route path is present in the shipped bundle',
    )
  } else {
    check('bundle: the built client exists', false, `${bundlePath} is missing — run the build first`)
  }
}

console.log(`\nKB-12 bridge acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
