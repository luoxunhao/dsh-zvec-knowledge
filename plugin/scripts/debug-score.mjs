/**
 * Why does a query for 翁家翌 score 0.200?
 *
 * The name appears three times in chapter2.md, inside a substantive paragraph
 * that is directly on-topic. A 0.2 on a hit that names the queried entity is
 * either (a) the normal scale of this embedding model, or (b) a defect — a chunk
 * boundary that separated the name from its context, or a scoring path that is
 * not measuring what it claims.
 *
 * This rebuilds a minimal store from the *real* chapter text, indexes it through
 * the deployment's real model, and reports the scores for the paragraph that
 * contains the name — with the chunk boundaries visible, so (a) and (b) are
 * distinguishable.
 *
 * Usage: node scripts/debug-score.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const { createEmbeddingProvider } = await import(new URL('../lib/host/embedding.js', import.meta.url).href)

const provider = createEmbeddingProvider({
  baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-embedding:4b',
  apiKeyEnv: '', timeoutMs: 60_000, maxRetries: 1,
})

const scratch = mkdtempSync(join(tmpdir(), 'kb-score-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', embed: provider, dimension: 2560,
  quota: { bytes: null, warnAt: 0.9 },
})

const CHUNKING = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 128, minChunkTokens: 64,
  preserveCodeBlocks: true, splitTablesByRow: false,
}
const INDEX = { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' }

try {
  await ops.createCollection({ name: 'Score', collectionId: 'kb_prod_2f8a', description: '' })

  // The chapter that actually contains the name. There are two files named
  // chapter2.md in this collection (an English one and a Chinese one), so the
  // selection is by content, not by name.
  const live = readFileSync(join(workspace, '.dsh-kb-zvec', 'kb_agentbook_5eed', 'documents.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const chapter2 = live.find(r => r.text.includes('翁家翌'))
  if (chapter2 === undefined) { console.log('no document contains the name'); process.exit(1) }
  console.log(`using ${chapter2.name} (${chapter2.id}, ${(chapter2.text.length / 1024).toFixed(0)} KB, CRLF=${chapter2.text.includes('\r\n')})\n`)
  await ops.addDocument('kb_prod_2f8a', { name: 'chapter2.md', text: chapter2.text })
  console.log('document stored.\n')

  const logs = []
  await ops.buildIndex('kb_prod_2f8a', { chunking: CHUNKING, index: INDEX }, {
    onProgress: () => {}, onLog: l => logs.push(`${l.level}: ${l.message}`),
  }, 'full')
  for (let i = 0; i < 900; i += 1) {
    if (ops.buildStatus('kb_prod_2f8a')?.settledAt !== null) break
    await new Promise(r => setTimeout(r, 100))
  }
  const settled = ops.buildStatus('kb_prod_2f8a')
  if (settled === null) { console.log('build never started:'); for (const l of logs) console.log('  ' + l); process.exit(1) }
  console.log(`indexed: ok=${settled.ok} chunks=${settled.chunks} err=${settled.error ?? '-'}`)
  for (const l of logs) console.log('  ' + l)
  console.log()

  // Which chunk holds the name?
  const nameAt = chapter2.text.indexOf('翁家翌')
  console.log(`「翁家翌」 appears at char ${nameAt}\n`)

  const queries = ['翁家翌', '翁家翌 context', '谁说人和模型一样最重要的是Context']
  for (const q of queries) {
    const result = await ops.retrieveForDiagnostics('kb_prod_2f8a', q, { topk: 3, minScore: 0 })
    console.log(`「${q}」  mode=${result.mode}`)
    for (const hit of result.hits) {
      const covers = hit.charStart <= nameAt && nameAt < hit.charEnd
      console.log(`  ${hit.matchScore.toFixed(3)} ${hit.band.padEnd(6)} #${hit.ordinal} (${hit.charStart}–${hit.charEnd})${covers ? '  ← contains 翁家翌' : ''}`)
    }
    // The best hit's text, so the boundary is visible.
    const top = result.hits[0]
    if (top) {
      console.log(`  top text head: ${JSON.stringify(top.text.slice(0, 100))}`)
    }
    console.log()
  }
  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
