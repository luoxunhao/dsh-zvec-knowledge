/**
 * KB-REF-01 acceptance — the collection-resolution function.
 *
 * ## The defect this file exists to prove fixed
 *
 * A user picks a knowledge base from the `@` menu. The chip serializes to a
 * sentence that *already contains the correct id*:
 *
 *     （用户指定本次回答使用知识库「agent-book」：调用 dsh_kb_search 时
 *       collection 参数传 "kb_agentbook_5eed"）
 *
 * Yet the call that followed passed the **display name** (`agent-book`) as
 * `collection`, the store rejected it as malformed, and the session burned an
 * extra round trip on `discovery_needed` before it could search. Every link in
 * the chain was correct except the last one — "the text mentions the id" to "the
 * parameter actually used the id" — which nothing guaranteed.
 *
 * The fix is to resolve the input in code rather than hope the model copies the
 * sentence. This file is the gate: it exercises the resolution as a **pure
 * function**, free of the store, the embedder and the filesystem, so the rules
 * can be enumerated exhaustively.
 *
 * Per the ticket, this file is written **before** the function exists and is
 * expected to be RED. A gate that never failed proves nothing.
 *
 * Usage: node scripts/verify-collection-resolution.mjs
 */

import { dirname, resolve } from 'node:path'
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

// The function lives in its own module so the gate can import it without pulling
// in the store. Importing it lazily keeps the "not yet implemented" case a
// reported failure rather than an unhandled module-resolution crash — a crash
// would tell the reader nothing about which criteria are unmet.
let resolveCollection
try {
  ;({ resolveCollection } = await import(new URL('../lib/host/resolve-collection.js', import.meta.url).href))
} catch (error) {
  console.log('\nKB-REF-01: resolveCollection is not implemented yet.')
  console.log(`  ${String(error)}\n`)
  console.log('KB-REF-01 acceptance: 0 passed, 1 failed\n')
  console.log('  FAIL  module — lib/host/resolve-collection.js does not exist yet')
  process.exit(1)
}

/** The two knowledge bases this suite reasons about. */
const LISTED = [
  { id: 'kb_agentbook_5eed', name: 'agent-book', builtAt: '2026-09-15T00:00:00.000Z' },
  { id: 'kb_dsh_bdeb', name: 'dsh', builtAt: '2026-09-15T00:00:00.000Z' },
]

/**
 * Run one resolution and describe its outcome compactly.
 * @param input - the raw `collection` value.
 * @param listed - the visible knowledge bases.
 * @returns the result object.
 */
function resolveWith(input, listed = LISTED) {
  return resolveCollection(input, listed)
}

// --- exact id ------------------------------------------------------------

{
  const result = resolveWith('kb_agentbook_5eed')
  check(
    'exact id: resolves to itself',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

// --- display name --------------------------------------------------------

{
  const result = resolveWith('agent-book')
  check(
    'display name: resolves to its id',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

{
  const result = resolveWith('AGENT-BOOK')
  check(
    'display name: case-insensitive',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

{
  const result = resolveWith('  agent-book  ')
  check(
    'display name: surrounding whitespace tolerated',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

// --- unique prefix -------------------------------------------------------

{
  // `agent` matches only kb_agentbook_5eed; `dsh` matches only kb_dsh_bdeb.
  const result = resolveWith('agent')
  check(
    'unique prefix: resolves to the single match',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

// --- the serialized sentence --------------------------------------------

{
  const template = '（用户指定本次回答使用知识库「agent-book」：调用 dsh_kb_search 时 collection 参数传 "kb_agentbook_5eed"）'
  const result = resolveWith(template)
  check(
    'serialized sentence: extracts the id from the quotes',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

{
  // A sentence whose quoted value is a *name* rather than an id: the extraction
  // hands the name back through the same resolution, so it still lands.
  const template = 'collection="agent-book"（知识库「agent-book」，用户已通过 @ 指定）'
  const result = resolveWith(template)
  check(
    'serialized sentence: a quoted name also resolves',
    result.ok === true && result.id === 'kb_agentbook_5eed',
    JSON.stringify(result),
  )
}

// --- ambiguity -----------------------------------------------------------

{
  const ambiguous = [
    { id: 'kb_alpha_1111', name: 'docs', builtAt: null },
    { id: 'kb_beta_2222', name: 'docs', builtAt: null },
  ]
  const result = resolveWith('docs', ambiguous)
  check(
    'ambiguity: duplicate name is refused, not silently picked',
    result.ok === false && result.reason === 'ambiguous',
    JSON.stringify(result),
  )
  check(
    'ambiguity: carries every candidate',
    Array.isArray(result.candidates) && result.candidates.length === 2,
    JSON.stringify(result.candidates),
  )
}

{
  // A prefix matching two knowledge bases is the same failure.
  const two = [
    { id: 'kb_docs_a_1111', name: 'docs-a', builtAt: null },
    { id: 'kb_docs_b_2222', name: 'docs-b', builtAt: null },
  ]
  const result = resolveWith('docs', two)
  check(
    'ambiguity: a prefix matching two is refused',
    result.ok === false && result.reason === 'ambiguous',
    JSON.stringify(result),
  )
}

// --- no match ------------------------------------------------------------

{
  const result = resolveWith('nope')
  check(
    'no match: reports not-found',
    result.ok === false && result.reason === 'not_found',
    JSON.stringify(result),
  )
  check(
    'no match: carries the available list so the caller can correct',
    Array.isArray(result.available) && result.available.length === 2,
    JSON.stringify(result.available),
  )
}

// --- empty input ---------------------------------------------------------

{
  const empty = resolveWith('')
  check(
    'empty: reports empty-input',
    empty.ok === false && empty.reason === 'empty',
    JSON.stringify(empty),
  )
  const blank = resolveWith('   ')
  check(
    'empty: whitespace-only counts as empty',
    blank.ok === false && blank.reason === 'empty',
    JSON.stringify(blank),
  )
}

// --- no candidates at all ------------------------------------------------

{
  const result = resolveWith('anything', [])
  check(
    'empty store: reports not-found rather than throwing',
    result.ok === false && result.reason === 'not_found',
    JSON.stringify(result),
  )
}

// --- pattern parity with the store ---------------------------------------

{
  // The resolver restates the id pattern rather than importing it, so that it
  // stays free of store imports. That restatement is only safe while the two
  // agree, and this pins them **behaviourally**: the store's own validator is
  // the authority, so a change to `store/paths.ts` alone fails here instead of
  // silently mis-resolving truncated ids.
  //
  // Behavioural rather than string equality because the store keeps its regex
  // private — comparing source text would mean adding an export purely for the
  // test's benefit, and would still not prove the two accept the same language.
  const { assertCollectionId } = await import(new URL('../lib/store/paths.js', import.meta.url).href)
  const { COLLECTION_ID_PATTERN: RESOLVER_PATTERN } = await import(
    new URL('../lib/host/resolve-collection.js', import.meta.url).href
  )

  const samples = [
    'kb_agentbook_5eed', 'kb_dsh_bdeb', 'kb_prod_2f8a', 'kb_k123_a032',
    'kb_mydocs_f72b', 'agent-book', 'kb_123_a032', 'kb_UPPER_abcd',
    'kb_agentbook_5EE', 'kb_agentbook_5e', 'kb__5eed', '',
  ]
  const disagreements = samples.filter((sample) => {
    let storeAccepts = true
    try {
      assertCollectionId(sample)
    } catch {
      storeAccepts = false
    }
    return storeAccepts !== RESOLVER_PATTERN.test(sample)
  })
  check(
    'parity: resolver id pattern agrees with the store validator',
    disagreements.length === 0,
    disagreements.length === 0
      ? `${samples.length} sample ids agree`
      : `disagree on: ${disagreements.join(', ')}`,
  )
}

// --- never throws --------------------------------------------------------

{
  let threw = false
  try {
    resolveWith('agent-book', null)
  } catch {
    threw = true
  }
  check('robustness: never throws on a missing list', threw === false, `threw=${threw}`)
}

console.log(`\nKB-REF-01 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
process.exit(failures.length > 0 ? 1 : 0)
