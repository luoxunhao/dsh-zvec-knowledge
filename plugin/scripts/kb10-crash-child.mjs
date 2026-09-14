/**
 * Crash-recovery child: writes to a snapshot slot, then hangs to be killed.
 *
 * The parent force-kills this process while it is mid-write, so the on-disk
 * state is whatever a real crash would leave. The child deliberately keeps the
 * engine handle open and writes in a loop without ever publishing: the parent's
 * assertion is that a killed writer leaves nothing a reader can reach, and that a
 * later build still succeeds.
 *
 * Usage: node scripts/kb10-crash-child.mjs <storeRoot> <slot>
 */

import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [storeRoot, slot] = process.argv.slice(2)

const { resetSlot } = await import(join(ROOT, 'lib', 'store', 'snapshot.js'))
const { chunkDocInput } = await import(join(ROOT, 'lib', 'store', 'collection.js'))

const handle = resetSlot(storeRoot, 'kb_prod_2f8a', slot, {
  kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8',
})

/** Deterministic unit vector, matching the verifier's fake embedding. */
function fakeEmbed(text) {
  const dim = 1024
  const v = new Float32Array(dim)
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = 0; i < dim; i += 1) {
    h ^= h << 13; h >>>= 0
    h ^= h >> 17
    h ^= h << 5; h >>>= 0
    v[i] = ((h % 2000) - 1000) / 1000
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i += 1) v[i] = v[i] / norm
  return v
}

// Write continuously so the kill lands mid-write rather than between writes.
let ordinal = 0
for (;;) {
  const text = `崩溃测试分片 ${ordinal}，用于制造写入中途被强制终止的现场。`
  handle.upsertSync(chunkDocInput({
    id: `doc_1#${ordinal}`,
    docId: 'doc_1',
    ordinal,
    charStart: ordinal * 40,
    charEnd: ordinal * 40 + text.length,
    text,
  }, fakeEmbed(text)))
  ordinal += 1
  // Signal readiness once writing, then keep going. Never close: closing would
  // flush cleanly and the parent would be testing a graceful shutdown.
  if (ordinal % 50 === 0) process.stdout.write(`wrote ${ordinal}\n`)
}
