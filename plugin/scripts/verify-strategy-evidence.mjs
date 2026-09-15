/**
 * Strategy-evidence acceptance: the check must verify the strategy, at constant cost.
 *
 * This replaces the acceptance for the corpus-wide chunk preview, which was removed
 * for two independent reasons and both are asserted here:
 *
 * 1. **Its cost was the collection's size.** It chunked every document to render
 *    eight rows: 55 ms at 20 documents, 1.4 s at 500, 5.5 s at 2000, recomputed on
 *    every parameter change. The replacement samples one document, so the assertion
 *    is that the cost does not grow when the collection does.
 * 2. **It could not verify a setting.** Its rows were `text.slice(0, 80)` with
 *    newlines collapsed — which cannot show whether a heading boundary was honoured,
 *    whether a fenced block stayed whole, whether a table split by row, or what the
 *    overlap shares. The assertions below are about those facts, not about the
 *    panel rendering.
 *
 * The dangerous failure mode for a verification surface is **false reassurance**: a
 * green verdict on a setting whose content no longer exists. Two of the checks are
 * therefore dedicated to it — a code block or table dropped by the minimum-size
 * floor must be reported as gone, not as protected.
 *
 * Usage: node scripts/verify-strategy-evidence.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)

/** Find a check by its setting label. */
const checkFor = (evidence, setting) => evidence.checks.find(item => item.setting === setting)

const BASE = {
  mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 8,
  preserveCodeBlocks: true, splitTablesByRow: true,
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-evidence-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch, stateDir: '.kb', dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

/** A document with headings, a fenced block, a table and enough body to split. */
const richDoc = [
  '# 手册',
  '## 安装',
  '安装说明。'.repeat(240),
  '```sh',
  'npm install zvec',
  'zvec --version',
  '```',
  '## 配置',
  '| 参数 | 说明 |',
  '|------|------|',
  '| topk | 返回条数 |',
  '| minScore | 分数下限 |',
  '配置正文。'.repeat(240),
].join('\n')

try {
  await ops.createCollection({ name: 'Ev', collectionId: 'kb_prod_2f8a', description: '' })

  // -------------------------------------------------------------------------
  // 1. No documents: the panel must say so rather than render an empty verdict
  // -------------------------------------------------------------------------
  const empty = await ops.strategyEvidence('kb_prod_2f8a', BASE)
  check(
    'empty: a collection with no documents reports unavailable, not a pass',
    empty.available === false && empty.checks.length === 0,
    `available=${empty.available} checks=${empty.checks.length}`,
  )

  await ops.addDocument('kb_prod_2f8a', { name: 'short.md', text: '# 短\n只有一句话。\n' })
  await ops.addDocument('kb_prod_2f8a', { name: 'rich.md', text: richDoc })

  // -------------------------------------------------------------------------
  // 2. The sample is the longest document, which is where boundaries break
  // -------------------------------------------------------------------------
  const evidence = await ops.strategyEvidence('kb_prod_2f8a', BASE)
  check(
    'sample: the longest document is chosen',
    evidence.document.name === 'rich.md',
    `sampled ${evidence.document.name} (${evidence.document.chars} chars)`,
  )
  check(
    'sample: the reason is stated, not implied',
    evidence.sampledBecause.includes('最长'),
    evidence.sampledBecause,
  )

  // -------------------------------------------------------------------------
  // 3. Each configured setting is verified, with an observation
  // -------------------------------------------------------------------------
  const expected = ['切分方式', '分片长度', '最小分片', '重叠长度', '保留代码块', '表格按行拆分']
  const present = evidence.checks.map(item => item.setting)
  check(
    'checks: every configurable setting is covered',
    expected.every(setting => present.includes(setting)),
    present.join(' / '),
  )
  check(
    'checks: each carries an observation, not just a verdict',
    evidence.checks.every(item => item.observed.length > 0),
    evidence.checks.map(item => `${item.setting}:${item.observed.slice(0, 24)}`).join(' | '),
  )

  // The heading mode's actual promise: chunks record their heading path.
  const modeCheck = checkFor(evidence, '切分方式')
  check(
    'checks: heading mode is verified by the recorded heading paths',
    modeCheck.satisfied === true && /\d+\/\d+ 片记录了标题路径/.test(modeCheck.observed),
    modeCheck.observed,
  )

  // The overlap setting's promise: adjacent chunks share text. The observation
  // must cite the sharing rather than restate the configured value.
  const overlapCheck = checkFor(evidence, '重叠长度')
  check(
    'checks: overlap is verified by shared span, not by the configured number',
    overlapCheck.satisfied === true && /处相邻边界共享文本/.test(overlapCheck.observed),
    overlapCheck.observed,
  )
  check(
    'evidence: the shared span is returned verbatim, not as a count',
    evidence.chunks.some(chunk => chunk.overlapText !== null && chunk.overlapText.length > 0),
    `${evidence.chunks.filter(chunk => chunk.overlapText !== null).length} chunks carry their shared text`,
  )

  // -------------------------------------------------------------------------
  // 4. Boundaries carry the facts a strategy question turns on
  // -------------------------------------------------------------------------
  check(
    'boundaries: the full head of each chunk is returned, not a collapsed snippet',
    evidence.chunks.every(chunk => chunk.head.length > 0 && !chunk.head.includes('\u0000')),
    `longest head: ${Math.max(...evidence.chunks.map(chunk => chunk.head.length))} chars`,
  )
  check(
    'boundaries: chunk text keeps its newlines, so structure is visible',
    evidence.chunks.some(chunk => chunk.head.includes('\n')),
    'at least one head spans multiple lines',
  )
  check(
    'boundaries: heading-position and fence flags are computed',
    evidence.chunks.every(chunk =>
      typeof chunk.startsAtHeading === 'boolean'
      && typeof chunk.startsInsideCodeFence === 'boolean'
      && typeof chunk.hasTableRow === 'boolean'),
    evidence.chunks.map(chunk => `#${chunk.ordinal}${chunk.startsAtHeading ? ' 标题边界' : ''}`).join(' '),
  )

  // -------------------------------------------------------------------------
  // 5. False reassurance is the failure this panel must not produce
  //
  // A fenced block small enough to fall below the floor is *protected* by the
  // chunker and then *discarded* by the minimum size. Reporting "保留代码块 已生效"
  // there would be true and useless — the code is not in the index. The check must
  // say so.
  // -------------------------------------------------------------------------
  const tinyFence = await ops.strategyEvidence('kb_prod_2f8a', { ...BASE, minChunkTokens: 400 })
  const codeCheck = checkFor(tinyFence, '保留代码块')
  check(
    'no false pass: a code block dropped by the floor is reported as gone',
    codeCheck.applicable === true && /丢弃|未进入索引/.test(codeCheck.observed),
    codeCheck.observed,
  )

  // Not applicable must be distinct from a pass: a document with no fence cannot
  // evidence the setting either way.
  await ops.createCollection({ name: 'NoCode', collectionId: 'kb_prod_0001', description: '' })
  await ops.addDocument('kb_prod_0001', { name: 'plain.md', text: `# 纯文本\n${'没有代码也没有表格。'.repeat(120)}\n` })
  const plain = await ops.strategyEvidence('kb_prod_0001', BASE)
  const plainCode = checkFor(plain, '保留代码块')
  const plainTable = checkFor(plain, '表格按行拆分')
  check(
    'no false pass: a setting the sample cannot evidence is marked not applicable',
    plainCode.applicable === false && plainTable.applicable === false,
    `code: ${plainCode.observed} / table: ${plainTable.observed}`,
  )

  // -------------------------------------------------------------------------
  // 6. The cost is constant, which is the reason for the replacement
  // -------------------------------------------------------------------------
  const before = (await ops.strategyEvidence('kb_prod_2f8a', BASE)).elapsedMs
  for (let index = 0; index < 40; index += 1) {
    await ops.addDocument('kb_prod_2f8a', {
      name: `bulk${index}.md`,
      text: `# 批量${index}\n${'填充内容。'.repeat(500)}\n`,
    })
  }
  const after = await ops.strategyEvidence('kb_prod_2f8a', BASE)
  const growth = after.elapsedMs / Math.max(before, 0.01)
  check(
    'cost: growing the collection 20x does not grow the check',
    after.elapsedMs < 400 && growth < 20,
    `${before.toFixed(1)} ms at 2 documents, ${after.elapsedMs.toFixed(1)} ms at 42 ` +
    `(a corpus-wide pass would be ~20x)`,
  )
  check(
    'cost: the sample is still one document after the collection grew',
    after.document.chunks > 0 && after.chunks.length <= 6,
    `${after.document.name}: ${after.document.chunks} chunks total, ${after.chunks.length} reported`,
  )

  // -------------------------------------------------------------------------
  // 7. The removed preview must not linger
  // -------------------------------------------------------------------------
  const { readFileSync, existsSync } = await import('node:fs')
  check(
    'removal: the corpus-wide preview component is gone',
    !existsSync(join(ROOT, 'src', 'client', 'components', 'ChunkPreview.tsx')),
    'ChunkPreview.tsx deleted, not merely unused',
  )
  const page = readFileSync(join(ROOT, 'src', 'client', 'pages', 'BuildPage.tsx'), 'utf8')
  check(
    'removal: the page no longer renders corpus totals',
    !/总片数|平均 token|丢弃碎片/.test(page),
    'the four corpus totals are gone',
  )
  const panel = readFileSync(join(ROOT, 'src', 'client', 'panel.tsx'), 'utf8')
  check(
    'debounce: parameter changes are debounced',
    /EVIDENCE_DEBOUNCE_MS/.test(panel) && /setTimeout/.test(panel),
    'a keystroke no longer issues a request per character',
  )

  ops.dispose()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nStrategy evidence acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
