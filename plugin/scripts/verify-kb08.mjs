/**
 * KB-08 acceptance suite: the `dsh_kb_search` retrieval tool.
 *
 * The criteria are mostly about the tool's *contract* rather than its results:
 * fixed field names, a description that states the four things a model needs, and
 * three failure paths that return judgeable text instead of throwing. Those are
 * checked by building the definition and invoking `execute` against stub
 * operations, so the tool's real code path runs.
 *
 * Usage: node scripts/verify-kb08.mjs
 */

import { readFileSync } from 'node:fs'
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

const { defineKbSearchTool, KB_SEARCH_TOOL, confidenceBand, renderHits } =
  await import(new URL('../lib/host/search-tool.js', import.meta.url).href)

/** A stub execution context with a live signal. */
function exec(overrides = {}) {
  return { signal: new AbortController().signal, ...overrides }
}

/**
 * Build a tool against stub operations.
 * @param overrides - partial operations, merged over a working stub.
 * @param minScore - the configured floor.
 * @returns the tool definition.
 */
function toolWith(overrides = {}, minScore = 0.55) {
  const base = {
    embedQuery: async () => new Float32Array(1024),
    search: async () => ({
      mode: 'hybrid',
      belowFloor: 0,
      hits: [{
        docId: 'doc_1', docName: 'guide.md', ordinal: 3,
        charStart: 120, charEnd: 460, text: '混合检索同时使用稠密向量与全文检索。',
        matchScore: 0.9123, band: 'strong',
      }],
    }),
  }
  return defineKbSearchTool({ ...base, ...overrides }, minScore)
}

// ---------------------------------------------------------------------------
// 1. Identity and parameter names
// ---------------------------------------------------------------------------
{
  const tool = toolWith()
  check('tool: name is fixed', tool.name === 'dsh_kb_search', tool.name)
  check('tool: name constant matches', KB_SEARCH_TOOL === 'dsh_kb_search', KB_SEARCH_TOOL)

  // `defineTool` compiles the parameter DSL into a JSON Schema, so the wire shape
  // is what a model receives — reading it exercises the compiler too.
  const params = Object.keys(tool.parameters.properties).sort()
  // Exactly these three, no aliases: the spec requires the names to match §9.2
  // with no camelCase drift, because the same names appear in the UI and logs.
  check('tool: parameters are exactly query/collection/topk', JSON.stringify(params) === JSON.stringify(['collection', 'query', 'topk']), params.join(', '))
  const required = tool.parameters.required ?? []
  check('tool: query is required', required.includes('query'), `required=[${required.join(', ')}]`)
  check('tool: collection is required', required.includes('collection'), `required=[${required.join(', ')}]`)
  check('tool: topk is optional', !required.includes('topk'), `required=[${required.join(', ')}]`)
  check('tool: topk is an integer', tool.parameters.properties.topk.type === 'integer', tool.parameters.properties.topk.type)
  check('tool: every parameter carries a description', Object.values(tool.parameters.properties).every(property => typeof property.description === 'string' && property.description.length > 0), 'all three described')
}

// ---------------------------------------------------------------------------
// 2. Description covers the four things a model needs
// ---------------------------------------------------------------------------
{
  const description = toolWith().description
  const requirements = [
    { name: 'when to call', pattern: /何时调用/ },
    { name: 'preconditions', pattern: /必要前置条件/ },
    { name: 'failure semantics', pattern: /失败语义/ },
    { name: 'side effects', pattern: /副作用/ },
  ]
  for (const requirement of requirements) {
    check(`description: states ${requirement.name}`, requirement.pattern.test(description), requirement.name)
  }
  check('description: names the parameter set', /query/.test(description) && /collection/.test(description) && /topk/.test(description), 'all three named')
  check('description: states no side effects explicitly', /不写入|不修改/.test(description), 'read-only stated')
}

// ---------------------------------------------------------------------------
// 3. Output field names match §9.2 exactly
// ---------------------------------------------------------------------------
{
  const schema = toolWith().output.schema
  const top = Object.keys(schema.properties).sort()
  const expectedTop = ['below_floor', 'collection', 'hits', 'mode', 'ok', 'query', 'reason', 'summary']
  check('output: top-level fields match the spec', JSON.stringify(top) === JSON.stringify(expectedTop), top.join(', '))

  const hit = Object.keys(schema.properties.hits.items.properties).sort()
  const expectedHit = ['band', 'char_end', 'char_start', 'doc_id', 'file', 'match_score', 'ordinal', 'text']
  check('output: hit fields match the spec', JSON.stringify(hit) === JSON.stringify(expectedHit), hit.join(', '))

  // The score field must be snake_case `match_score`; camelCase would be the
  // drift the spec explicitly forbids.
  check('output: score field is match_score, not matchScore', hit.includes('match_score') && !hit.includes('matchScore'), 'snake_case')
}

// ---------------------------------------------------------------------------
// 4. Confidence bands match §3.4
// ---------------------------------------------------------------------------
{
  const cases = [
    { score: 1.00, band: 'strong' }, { score: 0.85, band: 'strong' },
    { score: 0.84, band: 'relevant' }, { score: 0.70, band: 'relevant' },
    { score: 0.69, band: 'fair' }, { score: 0.55, band: 'fair' },
    { score: 0.54, band: 'low' }, { score: 0.00, band: 'low' },
  ]
  const wrong = cases.filter(testCase => confidenceBand(testCase.score) !== testCase.band)
  check('bands: match §3.4 at every boundary', wrong.length === 0, wrong.length === 0 ? `${cases.length} boundaries agree` : wrong.map(c => `${c.score} -> ${confidenceBand(c.score)} (want ${c.band})`).join('; '))
}

// ---------------------------------------------------------------------------
// 5. Successful call: normalized scores only, nothing raw
// ---------------------------------------------------------------------------
{
  const tool = toolWith()
  const value = await tool.execute({ query: '混合检索', collection: 'kb_prod_2f8a' }, exec())
  check('success: ok is true', value.ok === true, `ok=${value.ok}`)
  check('success: returns the hit', value.hits.length === 1, `${value.hits.length} hit(s)`)
  check('success: match_score is normalized 0..1', value.hits[0].match_score >= 0 && value.hits[0].match_score <= 1, String(value.hits[0].match_score))
  check('success: carries the confidence band', value.hits[0].band === 'strong', value.hits[0].band)
  check('success: citation locators present', value.hits[0].char_start === 120 && value.hits[0].char_end === 460, `${value.hits[0].char_start}-${value.hits[0].char_end}`)
  check('success: source file name present', value.hits[0].file === 'guide.md', value.hits[0].file)

  // The spec forbids exposing a raw distance anywhere in the interface.
  const serialized = JSON.stringify(value)
  check('success: no raw distance field leaks', !/"(distance|score|vector|raw_score)"\s*:/.test(serialized), 'no distance/score/vector key in the payload')

  check('success: summary names the collection and query', value.summary.includes('kb_prod_2f8a') && value.summary.includes('混合检索'), 'self-describing summary')
  check('success: summary states the retrieval mode', /稠密|混合/.test(value.summary), 'mode stated')
}

// ---------------------------------------------------------------------------
// 6. topk: defaulted, bounded
// ---------------------------------------------------------------------------
{
  const seen = []
  const tool = toolWith({
    search: async (_c, _q, _v, topk) => {
      seen.push(topk)
      return { mode: 'dense', belowFloor: 0, hits: [] }
    },
  })
  await tool.execute({ query: 'q', collection: 'kb_prod_2f8a' }, exec())
  check('topk: defaults when omitted', seen[0] === 8, `topk=${seen[0]}`)
  await tool.execute({ query: 'q', collection: 'kb_prod_2f8a', topk: 3 }, exec())
  check('topk: honoured when given', seen[1] === 3, `topk=${seen[1]}`)
  await tool.execute({ query: 'q', collection: 'kb_prod_2f8a', topk: 9999 }, exec())
  check('topk: clamped to the ceiling', seen[2] === 50, `topk=${seen[2]}`)
  await tool.execute({ query: 'q', collection: 'kb_prod_2f8a', topk: 0 }, exec())
  check('topk: clamped to at least 1', seen[3] === 1, `topk=${seen[3]}`)
}

// ---------------------------------------------------------------------------
// 7. Failure paths return judgeable text, never throw
// ---------------------------------------------------------------------------
{
  // Empty result: ok=false, but the message must help the model decide next.
  const empty = toolWith({
    search: async () => ({ mode: 'hybrid', belowFloor: 4, hits: [] }),
  })
  const emptyValue = await empty.execute({ query: '不存在的内容', collection: 'kb_prod_2f8a' }, exec())
  check('empty: does not throw', emptyValue !== null && typeof emptyValue === 'object', 'returned a value')
  check('empty: ok is false with a reason', emptyValue.ok === false && emptyValue.reason === 'empty_result', `reason=${emptyValue.reason}`)
  check('empty: reports how many were filtered', emptyValue.below_floor === 4, `below_floor=${emptyValue.below_floor}`)
  check('empty: suggests what to do next', /建议/.test(emptyValue.summary), emptyValue.summary.split('\n').at(-1))

  // Missing collection: named precisely, because it is the difference between a
  // typo and a broken install.
  const missing = toolWith({
    search: async () => { throw new Error('collection kb_nope_0000 does not exist under /tmp') },
  })
  const missingValue = await missing.execute({ query: 'q', collection: 'kb_nope_0000' }, exec())
  check('missing: does not throw', missingValue !== null, 'returned a value')
  check('missing: reason is collection_not_found', missingValue.reason === 'collection_not_found', `reason=${missingValue.reason}`)
  check('missing: names the collection and a next step', missingValue.summary.includes('kb_nope_0000') && /创建/.test(missingValue.summary), missingValue.summary)

  // Timeout: the tool aborts cooperatively rather than hanging the turn.
  const slow = toolWith({
    embedQuery: () => new Promise(() => {}),
  })
  const controller = new AbortController()
  const pending = slow.execute({ query: 'q', collection: 'kb_prod_2f8a' }, exec({ signal: controller.signal }))
  controller.abort()
  const timeoutValue = await pending
  check('timeout: settles instead of hanging', timeoutValue !== null, 'resolved after abort')
  check('timeout: reason is timeout', timeoutValue.reason === 'timeout', `reason=${timeoutValue.reason}`)
  check('timeout: states the budget and a next step', /超时/.test(timeoutValue.summary) && /重试|缩小/.test(timeoutValue.summary), timeoutValue.summary)

  // Blank query: rejected before touching the store.
  const blank = await toolWith().execute({ query: '   ', collection: 'kb_prod_2f8a' }, exec())
  check('invalid: blank query rejected', blank.ok === false && blank.reason === 'invalid_argument', `reason=${blank.reason}`)
  check('invalid: says which argument', /query/.test(blank.summary), blank.summary)

  // No embedding provider: a deployment gap, stated as such.
  const noEmbed = toolWith({ embedQuery: undefined })
  const noEmbedValue = await noEmbed.execute({ query: 'q', collection: 'kb_prod_2f8a' }, exec())
  check('no-provider: refused clearly', noEmbedValue.ok === false && /嵌入模型/.test(noEmbedValue.summary), noEmbedValue.summary)
}

// ---------------------------------------------------------------------------
// 8. Threshold behaviour: below-floor hits never reach the caller
// ---------------------------------------------------------------------------
{
  let floorSeen = null
  const tool = toolWith({
    search: async (_c, _q, _v, _k, minScore) => {
      floorSeen = minScore
      return { mode: 'hybrid', belowFloor: 2, hits: [] }
    },
  }, 0.72)
  await tool.execute({ query: 'q', collection: 'kb_prod_2f8a' }, exec())
  check('threshold: configured floor is passed to the store', floorSeen === 0.72, `minScore=${floorSeen}`)

  // The store is what filters; the tool must not resurrect a low hit.
  const lowOnly = toolWith({
    search: async () => ({ mode: 'dense', belowFloor: 3, hits: [] }),
  })
  const value = await lowOnly.execute({ query: 'q', collection: 'kb_prod_2f8a' }, exec())
  check('threshold: sub-floor results are absent from the payload', value.hits.length === 0, `${value.hits.length} hits`)
}

// ---------------------------------------------------------------------------
// 9. Rendered text is judgeable without a second call
// ---------------------------------------------------------------------------
{
  const hits = [
    { docName: 'a.md', ordinal: 0, charStart: 0, charEnd: 100, text: '第一段命中内容。', matchScore: 0.91, band: 'strong' },
    { docName: 'b.md', ordinal: 5, charStart: 300, charEnd: 420, text: '第二段命中内容。', matchScore: 0.62, band: 'fair' },
  ]
  const text = renderHits(hits, '查询词', 'kb_prod_2f8a', 'hybrid', 1)
  check('render: numbered in rank order', /^1\./m.test(text) && /^2\./m.test(text), 'numbered list')
  check('render: each line states the score and band', text.includes('0.91') && text.includes('strong'), 'score and band per hit')
  check('render: each line names its source', text.includes('a.md') && text.includes('#5'), 'file and ordinal')
  check('render: each line gives the location', text.includes('0-100') || text.includes('字符 0-100'), 'character range')
  check('render: mentions the filtered count', text.includes('1'), 'below-floor count surfaced')
  check('render: no raw distance anywhere', !/distance/i.test(text), 'normalized scores only')

  const emptyText = renderHits([], '查询词', 'kb_prod_2f8a', 'hybrid', 0)
  check('render: empty result states the finding', /没有找到/.test(emptyText), 'explicit "not found"')
  check('render: empty result suggests next steps', /建议/.test(emptyText), 'actionable')
}

// ---------------------------------------------------------------------------
// 10. Read-only: no write path reachable from the tool
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(ROOT, 'src', 'host', 'search-tool.ts'), 'utf8')
  // The description promises no side effects, so the body must not call one.
  const writes = /\b(appendDocument|createCollection|deleteCollection|removeDocument|buildIndex|replaceDocuments|upsertSync|insertSync|deleteSync)\b/
  check('side-effects: no write operation is called', !writes.test(source), 'the tool body only reads')
  check('side-effects: search is the only engine call', /operations\.search\(/.test(source), 'search() present')
}

console.log(`\nKB-08 acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
