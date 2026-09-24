/**
 * Real-corpus measurement: how expensive is the upload-path PDF preflight?
 *
 * `npm run verify:parse-preflight` asserts that the probe reaches the right
 * answer; it cannot assert that reaching it is cheap, and "cheap" is the design
 * point the brief calls out — a full extraction on the request path would block
 * the host's event loop. So this measures wall-clock *and* the longest
 * synchronous stall, against a large real document and against the committed
 * fixtures, with a full conversion of the same file alongside for comparison.
 *
 * The stall is the number that matters, not the wall clock: a `setInterval`
 * cannot fire while synchronous work holds the loop, so the gap between
 * consecutive ticks is the longest block — an upload-path probe that blocks for
 * seconds stalls every other request however fast its total looks.
 *
 * Not a gate: it needs real documents that cannot be committed (the same inputs
 * the bake-off uses). See `README.md` for where they come from.
 *
 * Usage: node scripts/parse-bakeoff/preflight-cost.mjs [largePdfPath]
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', '..')

// Imported by absolute URL: this script lives outside the compiled output, so a
// bare relative specifier would resolve against the script's own directory.
const { extractionSupport } = await import(pathToFileURL(join(PLUGIN, 'lib', 'store', 'extract.js')).href)
const { convertPdf } = await import(pathToFileURL(join(PLUGIN, 'lib', 'store', 'parse', 'pdf.js')).href)

const LARGE = process.argv[2] ?? join(PLUGIN, 'src', 'store', 'parse', 'fixtures', 'simple.pdf')
const ENCRYPTED = process.argv[3] ?? join(PLUGIN, 'src', 'store', 'parse', 'fixtures', 'encrypted.pdf')

/**
 * Measure one call's wall clock and its longest synchronous stall.
 *
 * A `setInterval` cannot fire while synchronous work holds the loop, so the gap
 * between consecutive ticks is the longest block. That is the number that
 * matters here: an upload-path probe that blocks for seconds is a probe that
 * stalls every other request, however fast its wall clock looks.
 * @param run - the async call to measure.
 * @returns wall-clock ms and longest synchronous block ms.
 */
async function measure(run) {
  let last = Date.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = Date.now()
    worst = Math.max(worst, now - last - 20)
    last = now
  }, 20)
  const started = Date.now()
  const result = await run()
  const total = Date.now() - started
  clearInterval(timer)
  return { total, worst, result }
}

const pdf = extractionSupport('a.pdf')

console.log(`preflight on ${LARGE} (${statSync(LARGE).size} B)`)
const cold = await measure(() => pdf.preflight(LARGE))
console.log(`  cold: total ${cold.total} ms, longest synchronous block ${cold.worst} ms, ok=${cold.result.ok}`)
const warm = await measure(() => pdf.preflight(LARGE))
console.log(`  warm: total ${warm.total} ms, longest synchronous block ${warm.worst} ms, ok=${warm.result.ok}`)

console.log('\nfull conversion of the same file, for comparison')
const full = await measure(() =>
  convertPdf(LARGE, { timeoutMs: 600_000, maxPages: 2000, maxTextBytes: 64 * 1024 * 1024 }),
)
console.log(`  convert: total ${full.total} ms, longest synchronous block ${full.worst} ms, chars=${full.result.text.length}`)

if (ENCRYPTED !== null) {
  console.log(`\npreflight on encrypted ${ENCRYPTED}`)
  const locked = await measure(() => pdf.preflight(ENCRYPTED))
  console.log(`  total ${locked.total} ms, ok=${locked.result.ok}`)
  console.log(`  remedy: ${locked.result.remedy ?? '(accepted!)'}`)
}
