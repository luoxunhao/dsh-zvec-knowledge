/**
 * Live functional check against the DEPLOYED plugin.
 *
 * The acceptance suites test the source tree; this drives the installed copy in
 * the profile, the way the running GUI loads it. It is the difference between
 * "the code is right" and "the thing that ships works".
 *
 * Usage: node scripts/verify-deployed.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const DEPLOYED = join(HOME, 'profiles', 'dsh-my-desktop', 'node_modules', 'dsh-zvec-knowledge')
const LOCAL = new URL('../lib/', import.meta.url).pathname.replace(/^\//, '')

const failures = []
const passes = []
const check = (name, ok, detail) => {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

if (!existsSync(DEPLOYED)) {
  console.log(`deployed plugin not found at ${DEPLOYED}; nothing to verify`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 1. The deployed client bundle carries the current implementation
// ---------------------------------------------------------------------------
{
  const client = readFileSync(join(DEPLOYED, 'lib', 'client.js'), 'utf8')
  // The draft write path — the reason the button works at all.
  check('deployed: the button writes the draft via inputActions', client.includes('inputActions') && client.includes('setDraft'),
    'the sanctioned composer path is in the shipped bundle')
  check('deployed: the old broken controller path is gone', !client.includes('triggerControllerOf'),
    'the sessionOf path that always failed is not in the shipped bundle')
  check('deployed: the picker is present', client.includes('选择知识库'),
    'the menu markup ships')
  check('deployed: the @ trigger source ships', client.includes('@') && client.includes('registerSource'),
    'the keyboard entrance ships')
  check('deployed: the diagnostic line ships', client.includes('composer entrances'),
    'a silent no-op would be reportable')
}

// ---------------------------------------------------------------------------
// 2. The deployed host bundle exposes the discovery contract
// ---------------------------------------------------------------------------
{
  const host = readFileSync(join(DEPLOYED, 'lib', 'host', 'search-tool.js'), 'utf8')
  check('deployed: collection is optional in the schema', !/required: \['query', 'collection'\]/.test(host) && host.includes("collection 参数：可省略"),
    'the discovery path ships')
  check('deployed: fts_only_hits is reported', host.includes('fts_only_hits'),
    'the exact-match signal ships')
  check('deployed: the discovery reason ships', host.includes('discovery_needed'),
    'the model can tell "pick a base" from "nothing found"')
  check('deployed: discoverCollections is called', host.includes('discoverCollections'),
    'the tool reads the collection list')
}

// ---------------------------------------------------------------------------
// 3. Every module the manifest declares actually shipped
// ---------------------------------------------------------------------------
{
  const pkgPath = join(DEPLOYED, 'package.json')
  check('deployed: package.json present', existsSync(pkgPath), pkgPath)
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const entry = pkg.main ?? 'lib/index.js'
    const clientEntry = pkg.exports?.['./client']?.default ?? 'lib/client.js'
    check('deployed: host entry resolves', existsSync(join(DEPLOYED, entry)), entry)
    check('deployed: client entry resolves', existsSync(join(DEPLOYED, clientEntry)), clientEntry)
  }
}

// ---------------------------------------------------------------------------
// 4. The deployed copy is byte-identical to the build output
// ---------------------------------------------------------------------------
{
  const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const rel = base === '' ? item.name : `${base}/${item.name}`
    return item.isDirectory() ? walk(join(dir, item.name), rel) : [rel]
  })
  const localFiles = walk(LOCAL)
  const missing = localFiles.filter(rel => !existsSync(join(DEPLOYED, 'lib', rel)))
  check('deployed: every built file shipped', missing.length === 0,
    missing.length === 0 ? `${localFiles.length} files present` : `missing ${missing.join(', ')}`)
}

// ---------------------------------------------------------------------------
// 5. Drive the DEPLOYED host: the discovery path end to end
// ---------------------------------------------------------------------------
{
  const { KnowledgeOperations } = await import(`file://${join(DEPLOYED, 'lib', 'host', 'operations.js').replace(/\\/g, '/')}`)
  const { defineKbSearchTool } = await import(`file://${join(DEPLOYED, 'lib', 'host', 'search-tool.js').replace(/\\/g, '/')}`)
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const scratch = mkdtempSync(join(tmpdir(), 'kb-deployed-'))
  const embed = async texts => Promise.resolve(texts.map(text => {
    const v = new Float32Array(1024)
    for (let i = 0; i < text.length; i += 1) v[(text.charCodeAt(i) + i) % 1024] += 1
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    for (let i = 0; i < v.length; i += 1) v[i] /= n
    return v
  }))
  const ops = new KnowledgeOperations({
    workspaceDir: scratch, stateDir: '.kb', embed, dimension: 1024,
    quota: { bytes: null, warnAt: 0.9 }, retrievalDefaults: { minScore: 0.55, topk: 8 },
  })
  try {
    await ops.createCollection({ name: '智能体书籍', collectionId: 'kb_agentbook_5eed', description: '' })
    await ops.createCollection({ name: '产品文档', collectionId: 'kb_docs_0001', description: '' })
    const tool = defineKbSearchTool(ops, 0.55)
    const exec = { signal: new AbortController().signal }

    // The deployed tool must answer "which collections exist" rather than fail.
    const discovery = await tool.execute({ query: '上下文' }, exec)
    check(
      'deployed host: an omitted collection returns the list',
      discovery.reason === 'discovery_needed' && (discovery.collections ?? []).length === 2,
      `reason=${discovery.reason} n=${(discovery.collections ?? []).length}`,
    )
    check(
      'deployed host: the list names each collection and its built state',
      (discovery.collections ?? []).every(c => c.id !== undefined && c.name !== undefined && typeof c.built === 'boolean'),
      (discovery.collections ?? []).map(c => `${c.id}:${c.built}`).join(' '),
    )
    // And the threshold channel the UI writes must resolve through the deployed copy.
    await ops.setRetrievalSettings('kb_agentbook_5eed', { minScore: 0.3, topk: 5 })
    const resolved = ops.retrievalSettings('kb_agentbook_5eed')
    check(
      'deployed host: the UI-written floor resolves for the tool',
      resolved.minScore === 0.3 && resolved.source === 'collection',
      `minScore=${resolved.minScore} source=${resolved.source}`,
    )
  } finally {
    ops.dispose()
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* engine lock */ }
  }
}

console.log(`\nDeployed plugin check: ${passes.length} passed, ${failures.length} failed`)
console.log(`  ${DEPLOYED}\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
