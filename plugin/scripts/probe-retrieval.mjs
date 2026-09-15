/**
 * Run one query against the live collection at a chosen floor.
 *
 * The conversation tool applies `minScore` silently, so a query that misses says
 * only "no results" — it cannot distinguish "the index does not recall this" from
 * "the threshold ate it". This script answers that directly for the real store.
 *
 * Usage: node scripts/probe-retrieval.mjs "查询文本" [minScore] [topk]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The store root is overridable so a probe can run against a *copy* of the store:
// the engine takes an exclusive lock per collection directory, so the live store is
// unreadable while DSH is running — which is the normal state to investigate in.
const storeRoot = process.env.KB_STORE_ROOT ?? join(workspace, '.dsh-kb-zvec')
// `stateDir` is resolved against the workspace, so an absolute override needs its
// own workspace/stateDir pair rather than a single path.
const wsDir = process.env.KB_STORE_ROOT === undefined ? workspace : resolve(storeRoot, '..')
const stateDir = process.env.KB_STORE_ROOT === undefined ? '.dsh-kb-zvec' : storeRoot.split(/[\\/]/).pop()

const query = process.argv[2] ?? '向量数据库'
const minScore = Number(process.argv[3] ?? 0)
const topk = Number(process.argv[4] ?? 10)

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const { createEmbeddingProvider } = await import(new URL('../lib/host/embedding.js', import.meta.url).href)

// Read the deployment's own embedding settings from the profile's cordis patch, so
// this probe queries through the same model the running plugin uses rather than a
// stand-in. A probe that used a different model would answer a different question.
const patchPath = process.env.KB_PATCH ?? join(
  process.env.DSH_HOME ?? '',
  'profiles', 'dsh-my-desktop', 'node_modules', 'dsh-zvec-knowledge', 'cordis.patch.yml',
)
let embedding = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-embedding:4b', dimension: 2560 }
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  const read = key => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim()
  embedding = {
    baseUrl: read('baseUrl') ?? embedding.baseUrl,
    model: read('model') ?? embedding.model,
    dimension: Number(read('dimension') ?? embedding.dimension),
  }
}

const collectionId = readdirSync(storeRoot).find(name => name.startsWith('kb_'))
if (collectionId === undefined) {
  console.log('no collection in the store')
  process.exit(0)
}

const meta = JSON.parse(readFileSync(join(storeRoot, collectionId, 'meta.json'), 'utf8'))
console.log(`collection: ${collectionId} (${meta.name})`)
console.log(`active slot: ${meta.active}  chunks: ${meta.chunks}  docs: ${meta.docs}`)
console.log(`builtAt: ${meta.builtAt}`)
console.log(`model: ${embedding.model} @ ${embedding.baseUrl} (dim ${embedding.dimension})`)
console.log(`query: 「${query}」  minScore=${minScore}  topk=${topk}\n`)

const provider = createEmbeddingProvider({
  baseUrl: embedding.baseUrl,
  model: embedding.model,
  apiKeyEnv: '',
  timeoutMs: 30_000,
  maxRetries: 1,
})

const ops = new KnowledgeOperations({
  workspaceDir: wsDir,
  stateDir,
  embed: provider,
  dimension: embedding.dimension,
  quota: { bytes: null, warnAt: 0.9 },
})

try {
  const result = await ops.retrieveForDiagnostics(collectionId, query, { topk, minScore })
  console.log(`mode=${result.mode}  hits=${result.hits.length}  belowFloor=${result.belowFloor}  ${(result.embeddedMs + result.searchedMs).toFixed(0)}ms\n`)
  if (result.hits.length === 0) {
    console.log('no hits above the floor. Lower minScore (arg 2) to see what was filtered.')
  }
  for (const hit of result.hits) {
    console.log(`${hit.matchScore.toFixed(3)}  ${hit.band.padEnd(8)}  ${hit.docName} #${hit.ordinal}  (字符 ${hit.charStart}-${hit.charEnd})`)
    console.log(`    ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 110)}…`)
  }
} catch (error) {
  console.log(`retrieval failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  ops.dispose()
}
