/**
 * One live query, at a chosen floor, through the deployment's own endpoint.
 *
 * Diagnostic only. The live store is locked by the running DSH process, so this
 * opens a *second connection to the engine* through the deployed plugin's HTTP
 * bridge — the same surface the 检索验证 page uses — rather than the store files.
 *
 * Usage: node scripts/probe-live.mjs "查询" [minScore] [topk]
 * Requires the bridge token, which is injected into the served page: read it once
 * from the GUI (view-source for __DSH_KB_BRIDGE_TOKEN__), or pass KB_TOKEN.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const query = process.argv[2] ?? '翁家翌'
const minScore = Number(process.argv[3] ?? 0)
const topk = Number(process.argv[4] ?? 5)
const collection = process.env.KB_COLLECTION ?? 'kb_agentbook_5eed'

const token = process.env.KB_TOKEN ?? ''
if (token === '') {
  console.log('set KB_TOKEN to the page\'s __DSH_KB_BRIDGE_TOKEN__ value, and')
  console.log('KB_WEB to the web origin if it is not the default.')
  console.log('e.g.  KB_TOKEN=... node scripts/probe-live.mjs "翁家翌" 0 5')
  process.exit(2)
}
const web = process.env.KB_WEB ?? 'http://127.0.0.1:9281'

const response = await fetch(`${web.replace(/\/+$/, '')}/api/_kb_zvec`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kb-bridge-token': token },
  body: JSON.stringify({
    method: 'retrieve',
    args: { collectionId: collection, query, minScore, topk },
  }),
  signal: AbortSignal.timeout(60_000),
})
const payload = await response.json()
if (!payload.ok) {
  console.log(`bridge error: ${payload.error ?? response.status}`)
  process.exit(1)
}
const result = payload.result
console.log(`\n「${query}」 minScore=${minScore}`)
console.log(`mode=${result.mode} hits=${result.hits.length} belowFloor=${result.belowFloor} slot=${result.activeSlot} chunks=${result.chunks} builtAt=${result.builtAt}\n`)
for (const hit of result.hits) {
  console.log(`${hit.matchScore.toFixed(3)}  ${hit.band.padEnd(6)}  ${hit.docName} #${hit.ordinal}  (${hit.charStart}–${hit.charEnd})`)
  console.log(`    ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 110)}…`)
}
