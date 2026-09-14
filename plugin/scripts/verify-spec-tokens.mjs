/**
 * Spec-to-implementation token gate.
 *
 * The reason this exists: the two token figures in the design spec (the headline
 * count and the per-group table in 3.1) are claims about the implementation, and
 * nothing was checking them. They had already drifted once — the spec said 51
 * while the code had 148 — and a stale figure is worse than no figure, because a
 * reviewer trusts it.
 *
 * So the spec's table is parsed and compared against `tokens/kb-tokens.json`
 * group by group, plus the headline number. A mismatch fails, which makes the
 * document self-correcting: editing one side without the other is caught here
 * rather than discovered during an audit.
 *
 * The spec path is configurable because the document is a pipeline artifact whose
 * directory carries a run id.
 *
 * Usage: node scripts/verify-spec-tokens.mjs [specPath]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(ROOT, '..')

/**
 * Locate the design spec's markdown source.
 *
 * The pipeline writes it under `output/<run-id>/stage1/final_draft.md`, so the
 * run id is discovered rather than hardcoded — a new pipeline run must not
 * silently skip this check.
 * @returns absolute spec path, or `null` when no pipeline output exists.
 */
function findSpec() {
  const output = join(WORKSPACE, 'output')
  if (!existsSync(output)) return null
  const candidates = []
  for (const runId of readdirSync(output)) {
    const candidate = join(output, runId, 'stage1', 'final_draft.md')
    if (existsSync(candidate)) candidates.push(candidate)
  }
  // Newest run wins when several exist, so the gate follows the live document.
  return candidates.sort().at(-1) ?? null
}

const specPath = process.argv[2] ?? findSpec()
if (specPath === null || !existsSync(specPath)) {
  console.log('design spec source not found under output/; skipping the token cross-check (not a failure)')
  process.exit(0)
}

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

const spec = readFileSync(specPath, 'utf8')
const tokens = JSON.parse(readFileSync(join(ROOT, 'tokens', 'kb-tokens.json'), 'utf8')).tokens

/** Actual counts per group. */
const actual = {}
for (const token of tokens) actual[token.group] = (actual[token.group] ?? 0) + 1
const actualDark = tokens.filter(token => token.dark !== undefined).length

const section = spec.split('### 3.1 令牌总览')[1]?.split('### 3.2')[0]
check('spec: 3.1 token overview section found', section !== undefined, section === undefined ? 'heading missing' : `${section.length} chars`)

if (section !== undefined) {
  // Parse the per-group table rows: `| group | count | type | use |`.
  const claimed = {}
  for (const line of section.split('\n')) {
    const match = /^\|\s*([a-zA-Z]+)\s*\|\s*(\d+)\s*\|/.exec(line)
    if (match !== null) claimed[match[1]] = Number(match[2])
  }

  const groups = [...new Set([...Object.keys(actual), ...Object.keys(claimed)])].sort()
  const mismatched = groups.filter(group => claimed[group] !== actual[group])
  check(
    'spec: every group count matches the implementation',
    mismatched.length === 0,
    mismatched.length === 0
      ? `${groups.length} groups agree`
      : mismatched.map(group => `${group}: spec ${claimed[group] ?? '(absent)'} vs impl ${actual[group] ?? '(absent)'}`).join('; '),
  )

  const claimedTotal = Object.values(claimed).reduce((sum, value) => sum + value, 0)
  check('spec: group counts sum to the implementation total', claimedTotal === tokens.length, `${claimedTotal} vs ${tokens.length}`)

  const headline = /设计令牌共 \*\*(\d+) 项\*\*/.exec(section)?.[1]
  check('spec: headline token count matches', headline === String(tokens.length), `spec ${headline ?? '(absent)'} vs impl ${tokens.length}`)

  // The dark-override figure is a separate claim and drifts independently.
  const darkMatch = /(\d+) 项在深色下取不同值/.exec(section)?.[1]
  check('spec: dark-override count matches', darkMatch === String(actualDark), `spec ${darkMatch ?? '(absent)'} vs impl ${actualDark}`)
}

// The version table states the same figures; a document that disagrees with
// itself is as bad as one that disagrees with the code.
{
  const versionRow = /\| 设计令牌数 \| (\d+)（/.exec(spec)?.[1]
  check('spec: version table agrees with 3.1', versionRow === String(tokens.length), `version table ${versionRow ?? '(absent)'} vs impl ${tokens.length}`)
}

console.log(`\nSpec token cross-check: ${passes.length} passed, ${failures.length} failed`)
console.log(`  spec  ${specPath}\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
