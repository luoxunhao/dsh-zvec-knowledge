#!/usr/bin/env node
/**
 * The bundled RAG skills: one source of truth, and a registration that works.
 *
 * Two failure modes this covers, neither of which any other gate can see:
 *
 * 1. **The shipped copy drifts from the authored copy.** The skills live at the
 *    repository root — where this workspace's agents discover them — and are copied
 *    into `skills/` so the package can register them. A directory-level exclusion or
 *    a half-finished edit would leave the plugin handing sessions instructions that
 *    no longer match the sources, with nothing failing. So every file is compared
 *    byte for byte, in both directions.
 * 2. **The registration is wrong.** `ctx.skills.register()` throws on a name that is
 *    not kebab-case, and the harness's own file parser rejects the same shape, so a
 *    bad frontmatter would take the plugin's fiber down at load. This gate therefore
 *    runs `registerKbSkills` against a stub registry and checks what it contributed —
 *    including that disposing the effect removes every skill, which is the required
 *    proof for any registry contribution.
 *
 * It also pins the wiring choice that keeps a headless profile alive: `skills` must
 * stay out of the plugin's required `inject` list and be bound through
 * `ctx.inject(['skills'], …)` instead.
 *
 * Usage: node scripts/verify-skill.mjs   (after `npm run build`)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(ROOT, '..')
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

/** Read a UTF-8 file relative to the plugin root, or `''` when absent. */
function read(relative) {
  const path = join(ROOT, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Every file under `dir`, as `/`-separated paths relative to `dir`. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path).map(child => `${entry.name}/${child}`))
    else if (entry.isFile()) out.push(entry.name)
  }
  return out
}

const { parseSkillMarkdown, registerKbSkills, defaultSkillsDir } = await import(
  `file:///${join(ROOT, 'lib', 'host', 'skill-bundle.js').replace(/\\/g, '/')}`
)

/**
 * The skills this package registers: the two that teach a session to retrieve from
 * a knowledge base and cite what it found.
 */
const SHIPPED = ['zvec-rag', 'zvec-rag-loop']

/**
 * Root-level skills that stay in the repository on purpose.
 * `dsh-plugin-development` describes how to build and ship this plugin, which is a
 * contributor's task, not something a knowledge-base session needs.
 */
const NOT_SHIPPED = ['dsh-plugin-development']

// ---------------------------------------------------------------------------
// 1. One source of truth: repository root and packaged copy are the same bytes
// ---------------------------------------------------------------------------
{
  const packagedRoot = join(ROOT, 'skills')
  const packaged = existsSync(packagedRoot)
    ? readdirSync(packagedRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(packagedRoot, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
      .sort()
    : []
  const authoredRoots = readdirSync(WORKSPACE, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(WORKSPACE, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()

  check('skills: the package registers exactly the declared set',
    JSON.stringify(packaged) === JSON.stringify([...SHIPPED].sort()),
    `packaged ${packaged.join(', ') || '(none)'}, declared ${SHIPPED.join(', ')}`)
  check('skills: every declared skill has an authored source at the repository root',
    SHIPPED.every(name => authoredRoots.includes(name)),
    `root carries ${authoredRoots.join(', ')}`)
  check('skills: no root skill is neither shipped nor excluded',
    authoredRoots.every(name => SHIPPED.includes(name) || NOT_SHIPPED.includes(name)),
    'a new root skill must be added to one of the two lists, so the choice is recorded')

  for (const name of packaged) {
    const from = join(WORKSPACE, name)
    const to = join(packagedRoot, name)
    if (!existsSync(from)) { check(`skills/${name}: authored source exists`, false, `${from} is missing`); continue }
    const sourceFiles = walk(from)
    const shippedFiles = walk(to)
    check(`skills/${name}: same file list`, JSON.stringify(sourceFiles) === JSON.stringify(shippedFiles),
      `source ${sourceFiles.length} / packaged ${shippedFiles.length}`)
    const differing = sourceFiles.filter(file => !shippedFiles.includes(file)
      || !existsSync(join(to, file))
      || readFileSync(join(from, file), 'utf8') !== readFileSync(join(to, file), 'utf8'))
    check(`skills/${name}: every file is byte-identical`, differing.length === 0,
      differing.length === 0 ? `${sourceFiles.length} files compared` : `drifted: ${differing.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Registration: what a session actually receives
// ---------------------------------------------------------------------------
{
  const registered = new Map()
  const stub = {
    register(skill) {
      if (registered.has(skill.name)) throw new Error(`duplicate registration ${skill.name}`)
      registered.set(skill.name, skill)
      return () => registered.delete(skill.name)
    },
  }
  const result = registerKbSkills(stub, { skillsDir: defaultSkillsDir() })

  check('register: the package contributes both RAG skills', result.names.length === 2
    && result.names.includes('zvec-rag') && result.names.includes('zvec-rag-loop'),
    result.names.join(', ') || '(none)')
  check('register: the service received exactly what the result reports',
    registered.size === result.names.length, `${registered.size} in the registry`)

  const loop = registered.get('zvec-rag-loop')
  check('register: content is the body without frontmatter',
    typeof loop?.content === 'string' && !loop.content.startsWith('---')
      && loop.content.includes('检索前') && !loop.content.includes('name: zvec-rag-loop'),
    `content starts "${String(loop?.content).slice(0, 24).replace(/\n/g, ' ')}…"`)
  check('register: description reaches the routing surface',
    typeof loop?.description === 'string' && loop.description.length > 40 && !loop.description.includes('\n'),
    `${loop?.description?.length ?? 0} chars, single line`)
  check('register: a source path is recorded for every skill',
    [...registered.values()].every(skill => existsSync(skill.path)),
    [...registered.values()].map(skill => skill.path.split(/[\\/]/).slice(-2).join('/')).join(', '))

  const base = loop?.resourceBase
  check('register: the loop skill gets a directory resource base',
    base?.kind === 'directory' && existsSync(base.path), String(base?.path ?? '(absent)'))
  check('register: a script the skill names is actually shipped beside it',
    base?.kind === 'directory' && existsSync(join(base.path, 'scripts', 'kb-inspect.mjs'))
      && loop.content.includes('scripts/kb-inspect.mjs'),
    'SKILL.md references scripts/kb-inspect.mjs and the packaged skill carries it')

  result.dispose()
  check('register: disposal removes every contribution', registered.size === 0,
    registered.size === 0 ? 'registry empty after dispose' : `left: ${[...registered.keys()].join(', ')}`)
  result.dispose()
  check('register: disposal is idempotent', registered.size === 0, 'a second dispose is a no-op')

  // A name the harness would reject must fail here rather than at load.
  let threw = false
  try {
    parseSkillMarkdown('---\nname: Bad_Name\ndescription: x\n---\nbody\n', 'inline/SKILL.md')
  } catch { threw = true }
  check('register: an invalid skill name fails rather than passing through', threw,
    'parseSkillMarkdown threw on a non-kebab name, as ctx.skills.register would')

  let missingThrew = false
  try {
    registerKbSkills(stub, { skillsDir: join(ROOT, 'no-such-skills') })
  } catch { missingThrew = true }
  check('register: a missing skills directory fails loud', missingThrew,
    'a broken install is reported at load instead of registering nothing quietly')
}

// ---------------------------------------------------------------------------
// 3. Wiring: skills stay an optional service
// ---------------------------------------------------------------------------
{
  const host = read('src/index.ts')
  const injectLine = /export const inject[^=]*=\s*\[([^\]]*)\]/.exec(host)?.[1] ?? '(absent)'
  check('wiring: the host does not require the skills service',
    !injectLine.includes('skills'), `inject = [${injectLine.trim()}]`)
  check('wiring: skills are bound lazily through ctx.inject',
    /ctx\.inject\(\['skills'[\s\S]{0,400}registerKbSkills/.test(host),
    'a profile without the skill plugin still loads and keeps dsh_kb_search')
  check('wiring: the skill registration is owned by an effect',
    /skillCtx\.effect\([\s\S]{0,200}registered\.dispose\(\)/.test(host),
    'unload removes the registrations with the fiber')
}

console.log(`\nBundled skill acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
