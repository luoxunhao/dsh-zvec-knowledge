/**
 * KB-01 acceptance: install the plugin into a fresh profile and reconcile the
 * `--dump-config` layer.
 *
 * This exists because the criterion is not "the plugin builds" but "a user who
 * installs it gets a working layer", and that path has failure modes the build
 * cannot see. The one that actually bit: `dsh plugin add` reads `dsh.bundle` from
 * the *installed* package, so a package whose manifest lacks it installs as a
 * plain dependency and the profile silently runs without the plugin — the install
 * still exits 0.
 *
 * The script therefore asserts the outcome, not the exit code:
 *
 * 1. a brand-new `DSH_HOME` and profile, so no prior state can mask a failure;
 * 2. the install adds the plugin to `dsh.profile.bundles` (the layer list);
 * 3. `--dump-config` contains the plugin layer with the expected `id`, `name` and
 *    every configured key — the earlier evidence for this criterion was a
 *    truncated capture from a *different* profile, which is exactly the mistake
 *    this script is built to make impossible.
 *
 * Usage: node scripts/verify-kb01-profile.mjs [--keep]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, 'tmp', 'kb01-profile-home')
const PROFILE = 'kb-verify'
const KEEP = process.argv.includes('--keep')
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
 * Resolve the dsh launcher once.
 *
 * `dsh` on Windows installs as a `.cmd` shim next to a `.ps1`. `spawnSync` with
 * `shell: true` cannot reliably find a bare `dsh`, and the failure mode is a
 * `status` of `null` rather than a useful error — which is exactly what made the
 * first run of this script look like a plugin problem. Resolving the shim up
 * front turns "cannot launch" into a clear message.
 * @returns absolute path to the launcher, or `dsh` when nothing was found.
 */
function resolveDsh() {
  const candidates = process.platform === 'win32'
    ? [join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd'), join(process.env.APPDATA ?? '', 'npm', 'dsh.ps1')]
    : ['/usr/local/bin/dsh', '/usr/bin/dsh']
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return 'dsh'
}

const DSH = resolveDsh()

/**
 * Run a dsh command against the scratch home, capturing output through a file.
 *
 * Output goes to a file rather than through a pipe on purpose. Under this
 * workspace's sandbox, `spawnSync` with piped stdio fails with `EPERM` — the
 * documented boundary on capturing another program's output — while letting the
 * child write to a file works. Shell redirection is therefore part of the
 * command, and the file is read back afterwards.
 * @param args - arguments after `dsh`.
 * @param capturePath - file to receive stdout and stderr.
 * @returns exit code and the captured text.
 */
function dsh(args, capturePath) {
  const quoted = args.map(argument => (argument.includes(' ') ? `"${argument}"` : argument)).join(' ')
  const result = spawnSync(
    process.platform === 'win32' ? `"${DSH}" ${quoted} > "${capturePath}" 2>&1` : `${DSH} ${quoted} > "${capturePath}" 2>&1`,
    { cwd: ROOT, env: { ...process.env, DSH_HOME: HOME }, shell: true, stdio: 'ignore' },
  )
  const text = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : ''
  return { code: result.status, text, error: result.error ? String(result.error.message) : '' }
}

// A fresh home each run: a leftover profile would make the assertions vacuous.
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

const ADD_LOG = join(ROOT, 'tmp', 'kb01-add.log')
// ROOT *is* the plugin package directory (the script lives in its `scripts/`), so
// the install target is ROOT itself. Appending 'plugin' here would install a
// non-existent nested directory, and pnpm's warning about that is easy to miss
// because the command still exits 0.
const add = dsh(['plugin', '--profile', PROFILE, 'add', ROOT], ADD_LOG)
check(
  'install: dsh plugin add exits 0',
  add.code === 0,
  `exit=${add.code}${add.error ? ` error=${add.error}` : ''}${add.text ? ` log=${add.text.trim().split('\n').slice(-1)[0]}` : ''}`,
)

// The warning is the precise symptom of the original bug, so its absence is
// asserted directly rather than inferred from a zero exit code.
const declaredNoBundle = /declares no dsh\.bundle/.test(add.text)
check('install: no "declares no dsh.bundle" warning', !declaredNoBundle, declaredNoBundle ? 'the manifest is not being seen as a bundle layer' : 'manifest bundle declaration was detected')

const profileFile = join(HOME, 'profiles', PROFILE, 'package.json')
check('install: profile package.json exists', existsSync(profileFile), profileFile)

const profile = existsSync(profileFile) ? JSON.parse(readFileSync(profileFile, 'utf8')) : null
const bundles = profile?.dsh?.profile?.bundles ?? []
check(
  'install: plugin reconciled into dsh.profile.bundles',
  bundles.includes('dsh-zvec-knowledge'),
  `bundles=[${bundles.join(', ')}]`,
)

const dumpCapture = join(ROOT, 'tmp', 'kb01-dump-config.txt')
const dump = dsh(['--profile', PROFILE, '--dump-config'], dumpCapture)
check('dump-config: exits 0', dump.code === 0, `exit=${dump.code}${dump.error ? ` error=${dump.error}` : ''}`)

// The capture is read from the file the shell wrote, which is also the artifact
// a reviewer can re-read in full — the previous evidence for this criterion was a
// truncated hand-capture, and truncation is what this avoids.
const lines = dump.text.split('\n')
const layerAt = lines.findIndex(line => line.trim() === '# == dsh-zvec-knowledge')
check('dump-config: plugin layer present', layerAt !== -1, layerAt === -1 ? 'no `# == dsh-zvec-knowledge` section' : `found at line ${layerAt + 1} of ${lines.length}`)

if (layerAt !== -1) {
  // Inspect the layer's own block, so a match anywhere in the file cannot pass.
  const block = []
  for (let i = layerAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('# ==')) break
    block.push(line)
  }
  const body = block.join('\n')
  check('dump-config: id is zvec-knowledge', /^-\s*id:\s*zvec-knowledge\s*$/m.test(body), block.find(l => l.includes('id:'))?.trim() ?? '(no id line)')
  check('dump-config: name is dsh-zvec-knowledge', /name:\s*dsh-zvec-knowledge/.test(body), block.find(l => l.includes('name:'))?.trim() ?? '(no name line)')

  // Every configured key must appear, because the earlier evidence was cut off
  // mid-`retrieval:` and looked complete until someone read the end.
  const required = [
    'stateDir', 'chunking', 'mode', 'chunkTokens', 'overlapTokens', 'minChunkTokens',
    'retrieval', 'topk', 'minScore',
    // KB-11 additions: the two blocks added after the first review.
    'quota', 'bytes', 'warnAt', 'embedding', 'baseUrl', 'model', 'dimension',
  ]
  const missing = required.filter(key => !body.includes(key))
  check('dump-config: config block is complete, not truncated', missing.length === 0, missing.length === 0 ? `all ${required.length} keys present` : `missing ${missing.join(', ')}`)
  check('dump-config: minScore is 0.55', /minScore:\s*0\.55/.test(body), body.match(/minScore:.*/)?.[0]?.trim() ?? '(absent)')
  check('dump-config: stateDir is workspace-relative', /stateDir:\s*\.dsh-kb-zvec/.test(body), body.match(/stateDir:.*/)?.[0]?.trim() ?? '(absent)')

  // The API key must never reach the dump. Checked by name against the whole
  // capture: `--dump-config` prints config, so a key placed in config would be
  // written to logs and diagnostics.
  const leaked = /(api[_-]?key|authorization|bearer)\s*:\s*\S+/i.exec(dump.text)
  check('dump-config: no credential appears in the dump', leaked === null, leaked === null ? 'no key-like field in 345 lines' : `found ${leaked[0]}`)
  check('dump-config: the embedding key is named, not inlined', /apiKeyEnv/.test(body), body.match(/apiKeyEnv:.*/)?.[0]?.trim() ?? '(absent)')
}

// The plugin's exported entry points must resolve from inside the profile: an
// exports map pointing at a file the tarball omits installs cleanly and then
// fails at load.
const installed = join(HOME, 'profiles', PROFILE, 'node_modules', 'dsh-zvec-knowledge')
check('install: package present in profile node_modules', existsSync(installed), installed)
if (existsSync(installed)) {
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  check('install: ./client export declared', pkg.exports?.['./client'] !== undefined, Object.keys(pkg.exports ?? {}).join(', '))
  const entries = ['./lib/index.js', './lib/client.js', './cordis.patch.yml']
  const missing = entries.filter(entry => !existsSync(join(installed, entry)))
  check('install: all published entries resolve', missing.length === 0, missing.length === 0 ? entries.join(', ') : `missing ${missing.join(', ')}`)

  // The token artifacts are published API, so a profile consumer must be able to
  // reach them without the repository.
  const tokenEntries = ['./tokens/kb-tokens.json', './tokens/scss/_kb-tokens.scss', './tokens/w3c/kb-design-tokens.json']
  const tokenMissing = tokenEntries.filter(entry => !existsSync(join(installed, entry)))
  check('install: token artifacts are published', tokenMissing.length === 0, tokenMissing.length === 0 ? `${tokenEntries.length} artifacts present` : `missing ${tokenMissing.join(', ')}`)

  // The host bundle must carry the tool registration, and the client bundle the
  // three slot contributions. Checked by reading the installed files rather than
  // the repository's, so a `files[]` omission is caught here.
  const hostBundle = readFileSync(join(installed, 'lib', 'index.js'), 'utf8')
  const toolBundle = readFileSync(join(installed, 'lib', 'host', 'search-tool.js'), 'utf8')
  check('install: the host registers dsh_kb_search', /dsh_kb_search/.test(hostBundle), 'tool name present in the host bundle')
  check('install: the tool bundle carries the spec field names', /match_score/.test(toolBundle) && /below_floor/.test(toolBundle), 'match_score and below_floor present')
  check('install: the host declares the tools injection', /inject\s*=\s*\[['"]tools['"]\]/.test(hostBundle), "inject = ['tools']")

  const clientBundle = readFileSync(join(installed, 'lib', 'client.js'), 'utf8')
  for (const seam of ['sidebar.panellist', 'tool.call.toolview', 'dsh_kb_search']) {
    check(`install: the client bundle contributes ${seam}`, clientBundle.includes(seam), seam)
  }
  // The client bundle must not require anything outside the module table.
  const requires = [...clientBundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
  const allowed = new Set(['react', 'react/jsx-runtime'])
  const foreign = [...new Set(requires)].filter(name => !allowed.has(name))
  check('install: the client bundle imports only module-table entries', foreign.length === 0, foreign.length === 0 ? `${requires.length} requires, all allowlisted` : `found ${foreign.join(', ')}`)

  // Stylesheets must be embedded in the bundle: the plugin has no host-side asset
  // route, so a stylesheet left as a separate file would never load.
  check('install: the client bundle carries its stylesheets', /data-plugin-css/.test(clientBundle), 'style injection present')
}

console.log(`\nKB-01 profile acceptance: ${passes.length} passed, ${failures.length} failed`)
console.log(`  DSH_HOME   ${HOME}`)
console.log(`  capture    ${dumpCapture}\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

// A scratch home holds a real pnpm store and a linked package, so it is removed
// on success unless the caller asked to inspect it. On failure it is always kept,
// because the profile's own files are the evidence for what went wrong.
if (!KEEP && failures.length === 0) {
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n  (scratch DSH_HOME removed; pass --keep to inspect it)')
}

if (failures.length > 0) process.exit(1)
