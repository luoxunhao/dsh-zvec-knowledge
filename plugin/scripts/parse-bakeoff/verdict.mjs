/**
 * Compute the Step 8 acceptance criteria from the two sides' JSON.
 *
 * The three criteria, verbatim from the brief:
 *   1. Hanzi coverage >= 95% of the baseline, per document
 *   2. Heading recovery >= 80% of the baseline, for untagged documents
 *   3. Zero false `structured`: every untagged document must be `inferred`,
 *      never `structured`
 *
 * **On the coverage ratio.** The briefed number is `ours / baseline`, and that is
 * what `coverage` below is — it is the ratio the verdict uses. A second ratio,
 * `shared`, is printed beside it because on this corpus the briefed one is not
 * the only informative reading: one baseline decodes `bits_cn.pdf` so badly that
 * it finds 35 Han characters against our 164, so `ours / baseline` exceeds 100%
 * there and would also exceed 100% if we dropped text the baseline had. Printing
 * both makes it visible which question each number answers, rather than silently
 * substituting one for the other. The `shared` ratio divides by the larger of the
 * two counts, so it can never exceed 100% and therefore exposes a loss the
 * briefed ratio would hide.
 *
 * Usage: node scripts/parse-bakeoff/verdict.mjs [outputDir]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', '..')
const DIR = process.argv[2] ?? join(PLUGIN, '..', '.workbuddy', 'tmp')

const ours = JSON.parse(readFileSync(join(DIR, 'bakeoff-ours.json'), 'utf8'))
const base = JSON.parse(readFileSync(join(DIR, 'bakeoff-base.json'), 'utf8'))

/** Percentage with one decimal. */
const pct = n => `${(n * 100).toFixed(1)}%`

const rows = []
let allCoverage = true
let allHeadings = true
let allHonest = true

for (const o of ours) {
  const b = base.find(x => x.name === o.name)
  // The briefed ratio: our extraction against the baseline's.
  const coverage = b.hanzi === 0 ? (o.hanzi === 0 ? 1 : 1) : o.hanzi / b.hanzi
  // The symmetric ratio, floored at 100% only when *both* sides agree.
  const larger = Math.max(o.hanzi, b.hanzi)
  const shared = larger === 0 ? 1 : o.hanzi / larger
  // Criterion 2 is about untagged documents. A document our converter classified
  // from its own tag tree is not making an inference, so the ratio does not apply.
  const inferred = o.tagged !== true
  const headingRatio = b.headings === 0 ? 1 : o.headings / b.headings
  const coverageOk = coverage >= 0.95
  const headingsOk = !inferred || headingRatio >= 0.8
  const honestOk = o.structure !== 'structured' || o.tagged === true
  if (!coverageOk) allCoverage = false
  if (!headingsOk) allHeadings = false
  if (!honestOk) allHonest = false
  rows.push({ o, b, coverage, shared, headingRatio, inferred, coverageOk, headingsOk, honestOk })
}

console.log('| 文档 | 汉字(我方/基线) | 覆盖率 ours/base | 覆盖率 shared | 标题(我方/基线) | 恢复率 | structure | tagged | 判定 |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  const verdict = r.coverageOk && r.headingsOk && r.honestOk ? 'PASS' : 'FAIL'
  const failing = [
    !r.coverageOk ? '覆盖率' : null,
    !r.headingsOk ? '标题恢复' : null,
    !r.honestOk ? '诚实性' : null,
  ].filter(Boolean).join('+')
  console.log(
    `| ${r.o.name} | ${r.o.hanzi} / ${r.b.hanzi} | ${pct(r.coverage)} | ${pct(r.shared)} | ${r.o.headings} / ${r.b.headings} | ${pct(r.headingRatio)} | ${r.o.structure} | ${r.o.tagged} | ${verdict}${failing ? ` (${failing})` : ''} |`,
  )
}

console.log('')
console.log('覆盖率 ours/base 为 brief 原义判据；shared 为对称口径，仅作参照。')
console.log(`criterion 1 (coverage >= 95%, ours/base):  ${allCoverage ? 'PASS' : 'FAIL'}`)
console.log(`criterion 2 (headings >= 80%):           ${allHeadings ? 'PASS' : 'FAIL'}`)
console.log(`criterion 3 (zero false structured):     ${allHonest ? 'PASS' : 'FAIL'}`)
console.log(`OVERALL: ${allCoverage && allHeadings && allHonest ? 'PASS' : 'FAIL'}`)

writeFileSync(
  join(DIR, 'bakeoff-verdict.json'),
  JSON.stringify({ coverageDefinition: 'ours/baseline (briefed)', rows, allCoverage, allHeadings, allHonest }, null, 2),
)
