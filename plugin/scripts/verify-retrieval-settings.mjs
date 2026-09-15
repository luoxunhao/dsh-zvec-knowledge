/**
 * Retrieval-settings acceptance: the threshold is UI-configurable and takes effect.
 *
 * The reported defect: the score floor lived only in deployment configuration, so
 * tuning retrieval meant editing a YAML file and restarting. The retrieval console
 * had a floor *control*, but it applied to the console's own queries only — the
 * conversation's `dsh_kb_search` still used the config value. A threshold tuned in
 * the UI was decorative.
 *
 * This suite drives the real store and the real tool path, asserting the property
 * that matters: **after a save through the operations layer, the tool applies the
 * new floor**. A test that only checked the stored metadata would pass while the
 * tool kept the old value, which is exactly the defect.
 *
 * Usage: node scripts/verify-retrieval-settings.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const { defineKbSearchTool } = await import(new URL('../lib/host/search-tool.js', import.meta.url).href)

/** Deterministic embeddings, so no network is involved. */
function fakeEmbed(texts) {
  return Promise.resolve(texts.map(text => {
    const vector = new Float32Array(1024)
    for (let index = 0; index < text.length; index += 1) {
      vector[(text.charCodeAt(index) + index) % 1024] += 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return vector
  }))
}

/** Poll a build job until it settles. */
async function awaitJob(ops, id) {
  for (let i = 0; i < 900; i += 1) {
    const s = ops.buildStatus(id)
    if (s !== null && s.settledAt !== null) return s
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('build did not settle')
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-settings-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', embed: fakeEmbed, dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
  // The deployment's own default, as the config would supply it.
  retrievalDefaults: { minScore: 0.55, topk: 8 },
})

const CHUNKING = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

try {
  await ops.createCollection({ name: 'Cfg', collectionId: 'kb_prod_2f8a', description: '' })
  await ops.addDocument('kb_prod_2f8a', {
    name: 'context.md',
    text: '# 上下文\n'
      + `${'上下文决定模型在每个决策点能看到什么信息。'.repeat(60)}\n`
      + 'OpenAI 研究员翁家翌曾精辟地总结：人和模型一样，最重要的是 Context。\n'
      + `${'团队协作中最大的问题也是上下文的不一致。'.repeat(40)}\n`,
  })
  await ops.buildIndex('kb_prod_2f8a', { chunking: CHUNKING, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'full')
  await awaitJob(ops, 'kb_prod_2f8a')

  // -------------------------------------------------------------------------
  // 1. Resolution: the collection has no setting, so the deployment default applies
  // -------------------------------------------------------------------------
  const initial = ops.retrievalSettings('kb_prod_2f8a')
  check(
    'resolve: a collection without its own setting reports the deployment default',
    initial.minScore === 0.55 && initial.topk === 8 && initial.source === 'deployment',
    `minScore=${initial.minScore} topk=${initial.topk} source=${initial.source}`,
  )

  // -------------------------------------------------------------------------
  // 2. THE POINT: the tool applies the saved floor
  //
  // The tool is built once with the deployment default, exactly as the harness
  // registers it. If it still used that captured value, a floor saved through the
  // operations layer would be decorative — the reported defect.
  //
  // The comparison uses a saved floor of 0, because the deployment default (0.55)
  // does filter this fixture: the query is a bare name, which is semantically thin
  // for an embedding model and scores low. So "nothing under the default, hits
  // under the saved floor" is exactly the observable the defect is about.
  // -------------------------------------------------------------------------
  const tool = defineKbSearchTool(ops, 0.55)
  const exec = { signal: new AbortController().signal }
  // With no collection setting yet, the deployment default is in force.
  const underDefault = await tool.execute({ query: '翁家翌', collection: 'kb_prod_2f8a' }, exec)
  check(
    'tool: the deployment default does filter this query (the two floors are separable)',
    underDefault.ok === false && underDefault.below_floor > 0,
    `ok=${underDefault.ok} below_floor=${underDefault.below_floor}`,
  )

  // Save a floor of 0 — the console's "show everything" setting — and the same
  // tool call must return the hits the default was hiding.
  await ops.setRetrievalSettings('kb_prod_2f8a', { minScore: 0, topk: 12 })
  const underSaved = await tool.execute({ query: '翁家翌', collection: 'kb_prod_2f8a' }, exec)
  check(
    'tool: the saved floor is applied, not the registration default',
    underSaved.ok === true && underSaved.hits.length > 0,
    `ok=${underSaved.ok} hits=${underSaved.hits.length} (was below_floor=${underDefault.below_floor} under the default)`,
  )
  check(
    'tool: the hits it now returns are the ones the default filtered',
    underSaved.hits.every(hit => hit.match_score >= 0) && underSaved.hits[0]?.match_score > 0,
    `top hit: ${underSaved.hits[0]?.file}#${underSaved.hits[0]?.ordinal} ${underSaved.hits[0]?.match_score}`,
  )

  // -------------------------------------------------------------------------
  // 3. Save, and the settings report themselves as the collection's own
  // -------------------------------------------------------------------------
  const stored = await ops.setRetrievalSettings('kb_prod_2f8a', { minScore: 0.3, topk: 12 })
  check(
    'save: the stored settings are what was written',
    stored.minScore === 0.3 && stored.topk === 12 && stored.source === 'collection',
    `minScore=${stored.minScore} topk=${stored.topk} source=${stored.source}`,
  )
  const reread = ops.retrievalSettings('kb_prod_2f8a')
  check(
    'resolve: after a save the collection value wins over the default',
    reread.minScore === 0.3 && reread.topk === 12 && reread.source === 'collection',
    `source=${reread.source}`,
  )

  // The settings survive a fresh operations object, because they are metadata on
  // disk rather than process state.
  const second = new KnowledgeOperations({
    workspaceDir: scratch, stateDir: '.kb', embed: fakeEmbed, dimension: 1024,
    quota: { bytes: null, warnAt: 0.9 },
    retrievalDefaults: { minScore: 0.55, topk: 8 },
  })
  const persisted = second.retrievalSettings('kb_prod_2f8a')
  check(
    'persist: the settings survive a new operations object',
    persisted.minScore === 0.3 && persisted.source === 'collection',
    `a fresh object reads minScore=${persisted.minScore}`,
  )

  // -------------------------------------------------------------------------
  // 4. Validation refuses values that would silence the collection
  // -------------------------------------------------------------------------
  let refused = false
  try { await ops.setRetrievalSettings('kb_prod_2f8a', { minScore: 3, topk: 12 }) } catch { refused = true }
  check('guard: a floor above 1 is refused', refused, 'minScore=3 rejected')
  refused = false
  try { await ops.setRetrievalSettings('kb_prod_2f8a', { minScore: 0.3, topk: 500 }) } catch { refused = true }
  check('guard: a topk beyond 50 is refused', refused, 'topk=500 rejected')
  // A refused write must not have been partially applied.
  const afterRefusal = ops.retrievalSettings('kb_prod_2f8a')
  check(
    'guard: a refused write leaves the previous settings intact',
    afterRefusal.minScore === 0.3 && afterRefusal.topk === 12,
    `still minScore=${afterRefusal.minScore} topk=${afterRefusal.topk}`,
  )

  // -------------------------------------------------------------------------
  // 5. Two collections can hold different floors
  // -------------------------------------------------------------------------
  await second.createCollection({ name: 'Other', collectionId: 'kb_prod_0002', description: '' })
  await second.setRetrievalSettings('kb_prod_0002', { minScore: 0.7, topk: 4 })
  const a = second.retrievalSettings('kb_prod_2f8a')
  const b = second.retrievalSettings('kb_prod_0002')
  check(
    'scope: two collections keep independent floors',
    a.minScore === 0.3 && b.minScore === 0.7,
    `kb_prod_2f8a=${a.minScore} kb_prod_0002=${b.minScore}`,
  )

  ops.dispose()
  second.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// The UI must expose the editor; a backend channel with no surface is the
// half-built state this feature started in.
{
  const { existsSync, readFileSync } = await import('node:fs')
  const page = readFileSync(join(ROOT, 'src', 'client', 'pages', 'RetrievalPage.tsx'), 'utf8')
  check(
    'ui: the console exposes the effective settings editor',
    /会话检索设置/.test(page) && /保存并生效/.test(page),
    'a settings card with a save action is present',
  )
  check(
    'ui: it states which source is in force',
    /部署默认值/.test(page) && /本知识库的检索设置/.test(page),
    'the page says whether the value is the collection\'s or the default',
  )
  const contract = readFileSync(join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8')
  check(
    'contract: both methods are declared',
    /'retrievalSettings'/.test(contract) && /'setRetrievalSettings'/.test(contract),
    'the two halves cannot drift on the method names',
  )
}

console.log(`\nRetrieval settings acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
