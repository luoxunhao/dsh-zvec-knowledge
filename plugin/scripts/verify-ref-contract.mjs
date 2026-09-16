/**
 * KB-REF-03 / KB-REF-04 acceptance — the stated contract and the chip shape.
 *
 * Two claims, both about text rather than logic, and both checked against the
 * **shipped artifacts** rather than the source: the tool description the model
 * actually receives, and the serialization the chip actually produces.
 *
 * ## KB-REF-03
 *
 * The description is the only place a model learns the calling convention. It
 * previously said `collection` was "集合标识，形如 kb_prod_2f8a" — which is
 * exactly why a model handed a display name had no reason to think it would
 * work. Now that the tool resolves names (KB-REF-02), the description must say
 * so, or the capability stays undiscoverable.
 *
 * ## KB-REF-04
 *
 * The chip's serialized form changed from a sentence to a parameter fragment.
 * **This file does not and cannot claim the model will obey it** — that is a
 * model behaviour, outside this repository's reach. What is checked is the
 * shape, plus the degradation branches. The correctness of the chain rests on
 * KB-REF-02's resolution, which `verify-collection-wireup.mjs` proves.
 *
 * Usage: node scripts/verify-ref-contract.mjs
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

// --- KB-REF-03: the tool description -------------------------------------

{
  // Read the description off the **registered definition**, not off the source
  // file: the source could contain the sentence while the registration drops or
  // rewords it, and the model only ever sees the latter.
  const { defineKbSearchTool } = await import(new URL('../lib/host/search-tool.js', import.meta.url).href)
  const tool = defineKbSearchTool(
    { embedQuery: async () => new Float32Array(8), search: async () => ({ hits: [], mode: 'dense', belowFloor: 0, ftsOnlyHits: 0 }) },
    0.55,
  )
  const description = String(tool.description ?? '')
  // The registration compiles the value-schema DSL into a JSON Schema object,
  // so the parameter descriptions live under `properties`.
  const props = tool.parameters?.properties ?? {}
  const paramText = String(props.collection?.description ?? '')

  check(
    'KB-REF-03: description says collection may be an id or a name',
    /名称/.test(description) && /标识/.test(description),
    'both forms named in the description',
  )
  check(
    'KB-REF-03: description says the host resolves it',
    /解析/.test(description),
    'resolution is attributed to the host',
  )
  check(
    'KB-REF-03: description covers the @ reference case',
    /@/.test(description) && /不要改写|直接使用/.test(description),
    'the @ path and the "do not rewrite" instruction are both present',
  )
  check(
    'KB-REF-03: description no longer implies id-only',
    !/collection（可选，集合标识，形如/.test(description),
    'the id-only phrasing is gone',
  )
  check(
    'KB-REF-03: parameter text agrees with the description',
    /名称/.test(paramText) && /标识/.test(paramText) && /解析/.test(paramText),
    paramText,
  )
  check(
    'KB-REF-03: failure semantics name both collection failure kinds',
    /collection_not_found/.test(description) && /collection_ambiguous/.test(description),
    'both reasons are documented',
  )
  check(
    'KB-REF-03: parameter names are unchanged',
    props.query?.type === 'string' && props.collection?.type === 'string' && props.topk?.type === 'integer',
    `query/collection/topk = ${props.query?.type}/${props.collection?.type}/${props.topk?.type}`,
  )
}

// --- KB-REF-04: the chip serialization ----------------------------------

{
  // `kb-trigger.tsx` is client code, but `serializeKbReference` is a pure
  // function; the compiled client bundle is not importable here, so the module
  // is read for its emitted form via the host build graph. The client build
  // appends the function to `lib/client.js`, which is a bundle rather than a
  // module — so the *source* is the artifact under test for this one claim, and
  // the check is written to match the function body rather than a rendering of
  // it.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(resolve(ROOT, 'src/client/kb-trigger.tsx'), 'utf8')

  check(
    'KB-REF-04: serialization leads with the parameter fragment',
    /serializeKbReference\(collection: string, name: string\): string \{\s*return `collection="\$\{collection\}"/
      .test(source),
    'return value starts with collection="<id>"',
  )
  check(
    'KB-REF-04: serialization still carries the human-readable name',
    /知识库「\$\{name\}」/.test(source),
    'the display name remains for traceability',
  )
  // The check is scoped to the function body: the JSDoc above it deliberately
  // quotes the old sentence to explain why the shape changed, and matching that
  // would make the gate fail on its own documentation.
  const body = /export function serializeKbReference[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  check(
    'KB-REF-04: the old prose shape is gone from the implementation',
    body !== '' && !/用户指定本次回答使用知识库/.test(body),
    body === '' ? 'function body not found' : 'the sentence form was removed',
  )
  check(
    'KB-REF-04: clipboard form is still the plain @name',
    /clipboardText: ref => `@\$\{ref\}`/.test(source),
    'copy/cut keeps the human form, as the ticket requires',
  )
  check(
    'KB-REF-04: serialization still observes the abort signal',
    /if \(signal\.aborted\) return Promise\.reject/.test(source),
    'an aborted attempt is refused rather than silently sent',
  )
  check(
    'KB-REF-04: name lookup failure degrades to the id',
    /name = ref/.test(source) && /catch \{/.test(source),
    'a failed lookup does not block the send',
  )
}

console.log(`\nKB-REF-03 / KB-REF-04 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
process.exit(failures.length > 0 ? 1 : 0)
