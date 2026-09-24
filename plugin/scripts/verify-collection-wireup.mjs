/**
 * KB-REF-02 acceptance — the tool resolves a display name, end to end.
 *
 * KB-REF-01 proved the resolution rules in isolation. This file proves the
 * **wire-up**: that a real `dsh_kb_search` call handed a knowledge base's
 * *display name* searches the right collection on the first attempt, instead of
 * failing with a malformed-id error and spending an extra round trip on
 * `discovery_needed`.
 *
 * It runs against a real store — a temporary workspace, a real collection with
 * a real built index — because the defect being fixed lived precisely in the
 * seam between resolution and retrieval. A unit test with a stubbed store could
 * not have caught it.
 *
 * Usage: node scripts/verify-collection-wireup.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
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

/** A deterministic stand-in for the embedding provider. */
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

/** Poll a build to settlement. */
async function awaitJob(ops, id) {
  let last = null
  for (let i = 0; i < 900; i += 1) {
    const status = ops.buildStatus(id)
    last = status
    if (status !== null && status.settledAt !== null) return status
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error(`build did not settle; last=${JSON.stringify({
    running: last?.running ?? null,
    error: last?.error ?? null,
  })}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'kb-wireup-'))
const ops = new KnowledgeOperations({
  workspaceDir: workspace, stateDir: '.kb', embed: fakeEmbed, dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
  retrievalDefaults: { minScore: 0.55, topk: 8 },
})

const CHUNKING = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1,
}
const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

try {
  // A collection whose *display name* is what a user says, and whose id is the
  // unguessable form the store requires. The two deliberately differ, because
  // the whole defect is the gap between them.
  const NAME = 'agent-book'
  await ops.createCollection({
    name: NAME, collectionId: 'kb_agentbook_5eed', description: 'KB-REF-02 fixture',
  })
  const collectionId = 'kb_agentbook_5eed'
  check(
    'fixture: collection created under a name that differs from its id',
    (await ops.listCollections()).some(item => item.id === collectionId && item.name === NAME),
    `${NAME} -> ${collectionId}`,
  )

  await ops.addDocument(collectionId, {
    name: 'chapter1.md',
    text: '# 智能体基础\n'
      + 'Agent 由大脑、眼睛和手脚构成。LLM 是决策核心，上下文决定它能看到什么，工具决定它能做什么。\n'
      + 'ReAct 循环把思考、行动与观察串起来，让模型持续推进任务。'.repeat(40),
  })
  const started = await ops.buildIndex(
    collectionId, { chunking: CHUNKING, index: INDEX },
    { onProgress: () => {}, onLog: () => {} }, 'full',
  )
  if (!started.ok) throw new Error(`build refused: ${started.error ?? 'unknown'}`)
  const built = await awaitJob(ops, collectionId)
  check(
    'fixture: index built',
    built.ok === true && built.chunks > 0,
    `ok=${built.ok} chunks=${built.chunks} error=${built.error ?? '-'}`,
  )

  // --- the tool as the host registers it ----------------------------------
  //
  // The floor is set to 0 for these probes: the claim under test is the
  // *routing* (a name reaches the right collection), not the score scale, and
  // the synthetic embedder's scores are not comparable to a real model's.
  await ops.setRetrievalSettings(collectionId, { minScore: 0, topk: 8, candidates: 100, mode: 'hybrid' })
  const tool = defineKbSearchTool(ops, 0.55)
  const exec = { signal: new AbortController().signal }

  // --- the defect: a display name must work on the first call -------------

  {
    const out = await tool.execute({ query: 'Agent 是什么', collection: NAME }, exec)
    check(
      'display name: first call succeeds',
      out.ok === true,
      `ok=${out.ok} reason=${out.reason ?? '-'} collection=${out.collection ?? '-'}`,
    )
    check(
      'display name: reported collection is the resolved id',
      out.collection === collectionId,
      `collection=${out.collection}`,
    )
    check(
      'display name: no discovery round trip was needed',
      out.reason !== 'discovery_needed' && out.reason !== 'collection_not_found',
      `reason=${out.reason ?? '-'}`,
    )
  }

  // --- the serialized chip sentence ---------------------------------------

  {
    const sentence = `（用户指定本次回答使用知识库「${NAME}」：调用 dsh_kb_search 时 collection 参数传 "${collectionId}"）`
    const out = await tool.execute({ query: 'Agent 是什么', collection: sentence }, exec)
    check(
      'serialized sentence: resolves to the id',
      out.ok === true && out.collection === collectionId,
      `ok=${out.ok} collection=${out.collection ?? '-'}`,
    )
  }

  // --- a bare id is unchanged (zero regression) ---------------------------

  {
    const out = await tool.execute({ query: 'Agent 是什么', collection: collectionId }, exec)
    check(
      'bare id: unchanged behaviour',
      out.ok === true && out.collection === collectionId,
      `ok=${out.ok} collection=${out.collection ?? '-'}`,
    )
  }

  // --- an unknown name corrects instead of dead-ending --------------------

  {
    const out = await tool.execute({ query: 'Agent 是什么', collection: 'nope' }, exec)
    check(
      'unknown name: reports not-found',
      out.ok === false && out.reason === 'collection_not_found',
      `ok=${out.ok} reason=${out.reason ?? '-'}`,
    )
    check(
      'unknown name: lists what is available so the caller can correct',
      (out.collections ?? []).some(item => item.id === collectionId),
      JSON.stringify(out.collections ?? []),
    )
    check(
      'unknown name: spends no embedding call',
      out.hits.length === 0 && out.mode === 'dense',
      `hits=${out.hits.length} mode=${out.mode}`,
    )
  }

  // --- omitted collection still discovers (untouched path) ----------------

  {
    // A second collection makes the list ambiguous, so discovery must report
    // rather than silently pick one.
    await ops.createCollection({ name: 'second', collectionId: 'kb_second_0001', description: 'fixture' })
    const out = await tool.execute({ query: 'Agent 是什么' }, exec)
    check(
      'omitted collection: still reports discovery rather than picking',
      out.ok === false && out.reason === 'discovery_needed',
      `ok=${out.ok} reason=${out.reason ?? '-'}`,
    )
  }
} finally {
  // The engine holds an exclusive lock per collection directory, so the temp
  // tree cannot be removed until the handles are released. Cleanup is
  // best-effort: a failure here must not mask the acceptance result, and the OS
  // reclaims the temp directory regardless.
  try {
    const { disposeAll } = await import(new URL('../lib/store/registry.js', import.meta.url).href)
    disposeAll()
  } catch {
    // No handles to release.
  }
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Locked by the engine on some platforms; the assertions above already ran.
  }
}

console.log(`\nKB-REF-02 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
process.exit(failures.length > 0 ? 1 : 0)
