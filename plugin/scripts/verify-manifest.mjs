/**
 * Post-build manifest gate.
 *
 * The plugin contract has failure modes that only surface after publication:
 * an `exports` entry pointing at a file the build never emitted, a `dsh.client`
 * block whose platform is missing or whose `./client` entry does not exist, or
 * a patch layer that is not a top-level array (which the loader silently
 * refuses to treat as a bundle layer). All three are checked here against the
 * built tree, so `pnpm verify` fails in the repository instead of in a user's
 * profile.
 *
 * Usage: node scripts/verify-manifest.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/**
 * Record a failure.
 * @param message - what is wrong, phrased as the fix's target.
 */
function fail(message) {
  failures.push(message)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

if (typeof manifest.name !== 'string' || manifest.name.length === 0) fail('package.json: name is required')
if (manifest.type !== 'module') fail('package.json: type must be "module"')

// Every published entry the loader or a user can resolve must exist on disk.
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  const targets = typeof value === 'string'
    ? [value]
    : Object.values(value).filter(entry => typeof entry === 'string')
  for (const target of targets) {
    const file = join(ROOT, target)
    if (!existsSync(file)) fail(`exports["${key}"] points at a missing file: ${target}`)
  }
}

// `files` decides what the published tarball carries, so an entry outside it is
// missing for a real install even though it exists in the working tree.
const listed = manifest.files ?? []
for (const target of ['./lib/index.js', './lib/client.js', './cordis.patch.yml']) {
  const covered = listed.some(entry => target === `./${entry}` || target.startsWith(`./${entry}/`))
  if (!covered) fail(`files[] does not publish ${target}`)
  if (!existsSync(join(ROOT, target))) fail(`declared artifact is not built: ${target}`)
}

// Every `files[]` entry must match something, or the manifest silently publishes
// less than it claims. This catches a renamed directory that the exports map was
// updated for but `files` was not.
for (const entry of listed) {
  const target = join(ROOT, entry)
  if (!existsSync(target)) fail(`files[] lists ${entry}, which does not exist in the package`)
}

// The token artifacts are part of the published surface (a consumer can import
// them), so they must be listed in `files` and present. Checking them by export
// key rather than by path keeps this tied to the contract, not to the layout.
for (const key of ['./scss', './tokens.json', './tokens.w3c.json']) {
  const target = manifest.exports?.[key]
  if (target === undefined) {
    fail(`exports["${key}"] is missing: the token source and its derived surfaces are published API`)
    continue
  }
  if (!existsSync(join(ROOT, target))) {
    fail(`exports["${key}"] points at a missing file: ${target} (run \`npm run tokens\`)`)
    continue
  }
  // `files` entries are directory-or-file prefixes, so either the exact path or
  // any ancestor directory listed there counts as covering it.
  const rel = target.replace(/^\.\//, '')
  const covered = listed.some(entry => {
    const normalized = entry.replace(/\/$/, '')
    return rel === normalized || rel.startsWith(`${normalized}/`)
  })
  if (!covered) fail(`exports["${key}"] resolves to ${target} but files[] does not publish it`)
}

const client = manifest.dsh?.client
if (client === undefined) fail('dsh.client is required: this plugin ships a web client half')
else {
  if (client.platform !== 'web') fail(`dsh.client.platform must be "web", received ${String(client.platform)}`)
  if (manifest.exports?.['./client'] === undefined) fail('dsh.client is declared but exports["./client"] is not')
  const external = client.external
  if (external !== undefined && (!Array.isArray(external) || external.some(item => typeof item !== 'string'))) {
    fail('dsh.client.external must be an array of module specifiers')
  }
}

const patchPath = manifest.dsh?.bundle?.patch
if (patchPath === undefined) fail('dsh.bundle.patch is required: without it the package never becomes a profile layer')
else {
  const file = join(ROOT, patchPath)
  if (!existsSync(file)) fail(`dsh.bundle.patch points at a missing file: ${patchPath}`)
  else {
    const source = readFileSync(file, 'utf8')
    // The loader requires a top-level array; a bare mapping is parsed but never
    // applied, which is the failure this records.
    const firstContentLine = source.split('\n').find(line => line.trim() !== '' && !line.trimStart().startsWith('#')) ?? ''
    if (!firstContentLine.trimStart().startsWith('-')) fail(`${patchPath} must be a top-level array (first content line must start with "-")`)
    if (!source.includes(`name: '${manifest.name}'`) && !source.includes(`name: "${manifest.name}"`)) {
      fail(`${patchPath} insert row does not name ${manifest.name}`)
    }
  }
}

const main = join(ROOT, manifest.main ?? '')
if (manifest.main !== undefined && (!existsSync(main) || statSync(main).size === 0)) {
  fail(`main is missing or empty: ${manifest.main}`)
}

if (failures.length > 0) {
  console.error(`manifest gate failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`manifest gate passed (${relative(ROOT, ROOT) || '.'})`)
