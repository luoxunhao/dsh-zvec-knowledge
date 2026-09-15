/**
 * Sanity-check the retrieval console against a REAL embedding model.
 *
 * The stub embedder used by `verify-retrieval-page.mjs` is deliberately artificial
 * (bigram hashing over 1024 buckets), so it produces cosine scores far below what a
 * trained model yields. That makes it fine for asserting *ordering* and *plumbing*,
 * but useless for answering "is the score scale right?" — which is exactly the
 * question a user asking "检索还能用吗" is asking.
 *
 * This runs the same console path against the deployment's real model, so the
 * confidence bands the page renders can be checked against reality.
 *
 * Usage: node scripts/measure-retrieval-real.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = process.env.KB_EMBED_BASE_URL ?? 'http://127.0.0.1:1234/v1'
const MODEL = process.env.KB_EMBED_MODEL ?? 'text-embedding-v4'

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const { createEmbeddingProvider } = await import(new URL('../lib/host/embedding.js', import.meta.url).href)

/** Probe the endpoint before building anything. */
async function probe() {
  try {
    const response = await fetch(`${BASE_URL.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: ['探测'], encoding_format: 'float' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const payload = await response.json()
    const width = payload?.data?.[0]?.embedding?.length
    return { ok: true, width }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

const status = await probe()
if (!status.ok) {
  console.log(`\nEmbedding endpoint unavailable (${BASE_URL}, model=${MODEL}): ${status.reason}`)
  console.log('Set KB_EMBED_BASE_URL / KB_EMBED_MODEL, or skip this check.\n')
  process.exit(0)
}
console.log(`\nmodel: ${MODEL} @ ${BASE_URL} (dimension ${status.width})\n`)

const provider = createEmbeddingProvider({
  baseUrl: BASE_URL, model: MODEL, apiKeyEnv: '', timeoutMs: 30_000, maxRetries: 1,
})

const scratch = mkdtempSync(join(tmpdir(), 'kb-real-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', embed: provider,
  dimension: status.width ?? 1024, quota: { bytes: null, warnAt: 0.9 },
})

try {
  await ops.createCollection({ name: 'Real', collectionId: 'kb_prod_2f8a', description: '' })
  await ops.addDocument('kb_prod_2f8a', {
    name: '检索.md',
    text: '# 向量检索\n向量检索把文本映射为稠密向量，再用近邻搜索召回语义相关的片段，因此同义改写的提问也能命中。\n'
      + '# 混合检索\n混合检索融合稠密向量与全文检索两路结果，通过 RRF 重新排序，兼顾语义与关键词匹配。\n',
  })
  await ops.addDocument('kb_prod_2f8a', {
    name: '烹饪.md',
    text: '# 红烧肉\n红烧肉需要五花肉、冰糖、生抽与老抽，小火慢炖四十分钟让肉质软糯入味，最后大火收汁。\n',
  })

  await ops.buildIndex('kb_prod_2f8a', {
    chunking: { mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1, preserveCodeBlocks: true, splitTablesByRow: false },
    index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
  }, { onProgress: () => {}, onLog: () => {} })
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (ops.buildStatus('kb_prod_2f8a')?.settledAt !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const settled = ops.buildStatus('kb_prod_2f8a')
  console.log(`build: ok=${settled?.ok} chunks=${settled?.chunks}\n`)

  // A paraphrase that shares almost no characters with the source, which is the
  // case only a real semantic model can retrieve.
  const queries = [
    '同义改写的问法为什么也能搜到',
    '红烧肉怎么炖才软',
    '两种检索方式是怎么融合的',
  ]
  for (const query of queries) {
    const result = await ops.retrieveForDiagnostics('kb_prod_2f8a', query, { topk: 3, minScore: 0 })
    const top = result.hits[0]
    console.log(`「${query}」`)
    console.log(`  mode=${result.mode}  hits=${result.hits.length}  belowFloor=${result.belowFloor}  ${(result.embeddedMs + result.searchedMs).toFixed(0)}ms`)
    for (const hit of result.hits) {
      console.log(`    ${hit.matchScore.toFixed(3)}  ${hit.band.padEnd(8)} ${hit.docName}#${hit.ordinal}  ${hit.text.slice(0, 34).replace(/\s+/g, ' ')}…`)
    }
    console.log()

    // The page's whole purpose: a strong top hit means the band is meaningful.
    if (top !== undefined && top.matchScore < 0.5) {
      console.log(`  NOTE: top score ${top.matchScore.toFixed(3)} is low for a relevant hit — check the model/dimension match.`)
    }
  }

  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
