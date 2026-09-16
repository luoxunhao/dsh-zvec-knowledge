/**
 * Collection-discovery and composer-entrance acceptance.
 *
 * Three defects/features covered here, all from one review:
 *
 * 1. **The model could not discover collections.** `collection` was required with
 *    a format (`kb_agentbook_5eed`) no model can guess, and a wrong guess
 *    returned `collection_not_found` — a dead end with nothing to correct with.
 *    Now: omitted means "one built collection searches it; several return a list".
 * 2. **Exact matches died silently under the floor.** A full-text-only hit scores
 *    a fixed low value, so a proper-name query lost its *exact* match to a
 *    threshold tuned for the dense scale, and the output said nothing about why.
 *    The output now carries `fts_only_hits`.
 * 3. **The composer and `@` menu give the id a legitimate path into the draft.**
 *    The trigger source turns a picked knowledge base into a chip that serializes
 *    to an instruction naming the exact parameter value.
 *
 * Usage: node scripts/verify-discovery.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

async function awaitJob(ops, id) {
  for (let i = 0; i < 900; i += 1) {
    const s = ops.buildStatus(id)
    if (s !== null && s.settledAt !== null) return s
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('build did not settle')
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-discovery-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', embed: fakeEmbed, dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
  retrievalDefaults: { minScore: 0.55, topk: 8 },
})

const CHUNKING = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }
const exec = { signal: new AbortController().signal }

try {
  // One built collection and one empty one: the shape where the old tool simply
  // failed — the model had no way to learn either id.
  await ops.createCollection({ name: '智能体书籍', collectionId: 'kb_agentbook_5eed', description: '' })
  await ops.createCollection({ name: '产品文档', collectionId: 'kb_docs_0001', description: '' })
  await ops.addDocument('kb_agentbook_5eed', {
    name: 'context.md',
    text: '# 上下文\n' + '上下文决定模型在每个决策点能看到什么。'.repeat(60)
      + '\nOpenAI 研究员翁家翌曾精辟地总结：人和模型一样，最重要的是 Context。\n'
      + '团队协作中最大的问题也是上下文的不一致。'.repeat(30),
  })
  await ops.buildIndex('kb_agentbook_5eed', { chunking: CHUNKING, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'full')
  await awaitJob(ops, 'kb_agentbook_5eed')

  const tool = defineKbSearchTool(ops, 0.55)

  // -------------------------------------------------------------------------
  // 1. Discovery: no collection named, several present
  // -------------------------------------------------------------------------
  const discovery = await tool.execute({ query: '上下文' }, exec)
  check(
    'discovery: omitting collection returns the list, not a dead end',
    discovery.reason === 'discovery_needed' && Array.isArray(discovery.collections) && discovery.collections.length === 2,
    `reason=${discovery.reason} collections=[${(discovery.collections ?? []).map(c => c.id).join(', ')}]`,
  )
  check(
    'discovery: the list carries name and built state',
    (discovery.collections ?? []).every(c => typeof c.name === 'string' && typeof c.built === 'boolean')
      && (discovery.collections ?? []).find(c => c.id === 'kb_agentbook_5eed')?.built === true
      && (discovery.collections ?? []).find(c => c.id === 'kb_docs_0001')?.built === false,
    (discovery.collections ?? []).map(c => `${c.id}: built=${c.built}`).join(' '),
  )
  check(
    'discovery: the summary names the collections for the model',
    /kb_agentbook_5eed/.test(discovery.summary) && /kb_docs_0001/.test(discovery.summary) && /未构建/.test(discovery.summary),
    discovery.summary.slice(0, 110),
  )

  // -------------------------------------------------------------------------
  // 2. Discovery with one collection: searches it directly
  //
  // Exercised on a second store: one built collection must be searched directly,
  // with no second round trip. The main fixture keeps two so the list path is
  // what the first call sees.
  // -------------------------------------------------------------------------
  const singleScratch = mkdtempSync(join(tmpdir(), 'kb-discovery-single-'))
  const singleOps = new KnowledgeOperations({
    workspaceDir: singleScratch, stateDir: '.kb', embed: fakeEmbed, dimension: 1024,
    quota: { bytes: null, warnAt: 0.9 },
    retrievalDefaults: { minScore: 0.55, topk: 8 },
  })
  try {
    await singleOps.createCollection({ name: '唯一库', collectionId: 'kb_only_0003', description: '' })
    await singleOps.addDocument('kb_only_0003', {
      name: 'a.md',
      text: '# A\n' + '上下文决定模型在每个决策点能看到什么。'.repeat(60),
    })
    await singleOps.buildIndex('kb_only_0003', { chunking: CHUNKING, index: INDEX }, { onProgress: () => {}, onLog: () => {} }, 'full')
    await awaitJob(singleOps, 'kb_only_0003')
    // The floor is set to 0 for this probe: the claim under test is the *routing*
    // (one built collection searched directly), not the score scale, and the
    // synthetic embedder's scores are not comparable to a real model's.
    await singleOps.setRetrievalSettings('kb_only_0003', { minScore: 0, topk: 8, candidates: 100, mode: 'hybrid' })
    const singleTool = defineKbSearchTool(singleOps, 0.55)
    const single = await singleTool.execute({ query: '上下文' }, exec)
    check(
      'discovery: a single built collection is searched without a second round trip',
      single.collection === 'kb_only_0003' && single.ok === true,
      `searched ${single.collection}, hits=${single.hits.length}`,
    )
  } finally {
    // Best effort: the engine's directory lock can outlive dispose on Windows, and
    // a leftover temp directory is not a test failure.
    try { rmSync(singleScratch, { recursive: true, force: true }) } catch { /* locked */ }
  }

  // -------------------------------------------------------------------------
  // 3. The exact-match signal
  //
  // `ftsOnlyHits` counts hits the full-text pass produced that carry no vector
  // evidence. The end-to-end path above rarely produces one: the dense pass runs
  // first and its candidate window usually covers the whole small store, so every
  // FTS hit also has a dense score. The direct store call pins the candidate
  // window low, which is exactly how a large corpus loses FTS hits out of the
  // dense top-k in production — the situation the count was added for.
  // -------------------------------------------------------------------------
  const { search: searchStore } = await import(new URL('../lib/store/retrieval.js', import.meta.url).href)
  // The handle is only valid inside the lease, so the probe runs under it rather
  // than taking the handle out — the released handle would fail on first use.
  const probed = await ops.withServedHandle('kb_agentbook_5eed', async handle => {
    if (handle === null) return null
    // `embedQuery` returns one vector, not a list of them — destructuring would
    // take the first *number*, and the engine would refuse it.
    const vector = await ops.embedQuery('翁家翌')
    // A tiny candidate window: the dense pass sees 2, the full-text pass sees all.
    return searchStore(handle, { vector, text: '翁家翌', topk: 5, candidates: 2 }, 0)
  })
  check('fts: the direct probe ran', probed !== null, probed === null ? 'nothing built' : 'searched')
  // The live store's dense window may still cover every FTS hit (the synthetic
  // embedder scores the very text that matched), so `ftsOnlyHits` there can be 0
  // for true reasons. The *mechanism* — a hit with no dense score is counted, not
  // dropped — is asserted through the store layer with the dense pass stubbed.
  {
    const hits = [
      { id: 'dense-1', score: 0.1, fields: { doc_id: 'doc_a', text: 'dense match', ordinal: 0, char_start: 0, char_end: 11 } },
      { id: 'fts-1', score: 0.03, fields: { doc_id: 'doc_b', text: 'exact token match', ordinal: 1, char_start: 0, char_end: 17 } },
    ]
    const stub = {
      querySync: () => hits.slice(0, 1),
      multiQuerySync: () => hits,
    }
    const probed2 = searchStore(stub, { vector: [0.1, 0.2], text: 'exact token', topk: 5 }, 0)
    check(
      'fts: full-text-only hits are counted when the dense window misses them',
      probed2.ftsOnlyHits === 1 && probed2.hits.length === 2,
      `hits=${probed2.hits.length} ftsOnlyHits=${probed2.ftsOnlyHits} (dense saw only dense-1)`,
    )
    check(
      'fts: the full-text-only hit scores the fixed FTS value, not a rank reading',
      probed2.hits.find(h => h.docId === 'doc_b')?.matchScore === 0.2,
      `doc_b=${probed2.hits.find(h => h.docId === 'doc_b')?.matchScore}`,
    )
  }
  // And the end-to-end output carries whatever the real run produced.
  const endToEnd = await tool.execute({ query: '翁家翌', collection: 'kb_agentbook_5eed' }, exec)
  check(
    'fts: the end-to-end output always carries the field',
    typeof endToEnd.fts_only_hits === 'number' && endToEnd.fts_only_hits >= 0,
    `fts_only_hits=${endToEnd.fts_only_hits} (0 is a true answer when the dense window covered everything)`,
  )

  // -------------------------------------------------------------------------
  // 4. The trigger source: one list for the menu and the button
  // -------------------------------------------------------------------------
  const triggerSource = readFileSync(join(ROOT, 'src', 'client', 'kb-trigger.tsx'), 'utf8')
  const buttonSource = readFileSync(join(ROOT, 'src', 'client', 'composer', 'KbButton.tsx'), 'utf8')
  const entrySource = readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8')

  check(
    'trigger: the source registers under @ and is named for the button to open',
    /trigger: '@'/.test(triggerSource) && /KB_TRIGGER_SOURCE = 'kb'/.test(triggerSource),
    `trigger=@ name=kb`,
  )
  check(
    'trigger: candidates come from the port and filter by name or id',
    /port\.listCollections\(\)/.test(triggerSource) && /item\.name\.toLowerCase\(\)\.includes\(needle\)/.test(triggerSource),
    'the menu shows real collections, filtered',
  )
  check(
    'trigger: a pick inserts a chip carrying the collection id',
    /insert:\s*\{/.test(triggerSource) && /ref: id/.test(triggerSource),
    'the id rides the chip, not a guess',
  )
  check(
    'trigger: serialization names the exact parameter value',
    /collection 参数传/.test(triggerSource) && /dsh_kb_search/.test(triggerSource),
    'the model reads which parameter to set',
  )
  check(
    'trigger: built collections sort ahead of unbuilt ones',
    /Number\(right\.built\) - Number\(left\.built\)/.test(triggerSource),
    'a quick Enter should not land on a base that answers nothing',
  )
  check(
    'trigger: the pipeline types are restated, not imported',
    !/from '@deepseek-ai\/dsh-client-ui-input-trigger/.test(triggerSource)
      && /dsh-client-ui-input-trigger\/lib\/types/.test(triggerSource),
    'the client may only import module-table entries; the contract is restated with its source',
  )
  check(
    'button: it writes the draft through the slot input actions',
    /inputActions/.test(entrySource) && /setDraft/.test(buttonSource),
    'the sanctioned composer path, not the trigger controller',
  )
  check(
    'button: it no longer resolves a trigger controller',
    !/triggerControllerOf/.test(entrySource) && !/toggleSource/.test(entrySource),
    'sessionOf needs a session scope this slot does not receive; the old path was a silent no-op',
  )
  check(
    'button: a single collection is inserted without a menu',
    /list\.length === 1/.test(buttonSource),
    'the common single-base deployment never sees a picker',
  )
  check(
    'button: the lock comes from the input phase, since the owner share is empty',
    /phase/.test(entrySource) && /locked=\{busy/.test(entrySource),
    'renderSlot passes {} for this slot, so owner.locked would always be undefined',
  )
  check(
    'diagnostics: the entrances report whether they are live',
    /reportClientDiagnostics/.test(triggerSource) && /reportClientDiagnostics\(/.test(entrySource),
    'a button that silently does nothing is otherwise indistinguishable from a broken one',
  )

  // The slots shim declares the new contract, and the catalogue cross-check in
  // verify:slots reads the installed harness — here we check the declaration.
  const slotsShim = readFileSync(join(ROOT, 'src', 'client', 'slots.ts'), 'utf8')
  check(
    'slots: conversation.input.right is declared with its owner',
    /'conversation\.input\.right'/.test(slotsShim) && /ComposerControlOwnerProps/.test(slotsShim),
    'restated from the conversation contract',
  )
  check(
    'slots: the list-register type covers the composer variant',
    /ComposerControlRegisterOptions/.test(slotsShim),
    'the composer list has a different owner than the sidebar list',
  )

  // The tool description must teach the model the new contract.
  const toolSource = readFileSync(join(ROOT, 'src', 'host', 'search-tool.ts'), 'utf8')
  check(
    'tool: the description states collection is optional and why',
    /collection 参数：可省略/.test(toolSource),
    'a model only knows what the description says',
  )
  check(
    'tool: the description explains fts_only_hits',
    /fts_only_hits 是仅有全文精确匹配/.test(toolSource),
    'the count is useless if the model cannot interpret it',
  )

  ops.dispose()
} finally {
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* locked */ }
}

console.log(`\nDiscovery & entrance acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
