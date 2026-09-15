/**
 * KB-13 acceptance: chunking a Markdown source preserves its structure.
 *
 * These three defects were found by probing the built chunker with ordinary
 * Markdown, not by reading the code. They matter because the plugin's accepted
 * data source is now Markdown, which makes `heading` mode the live path — and
 * each defect silently produces an index that cannot answer questions the
 * document plainly contains:
 *
 * 1. **A parent section that holds only child headings is dropped.** For
 *    `# 手册 / ## 安装 / ### Windows`, both 手册 and 安装 disappeared from the
 *    output entirely, so no query about them can ever match.
 * 2. **A chunk carries only its nearest heading.** A section titled `安装` did
 *    not record that it belongs to `手册`, so the embedding sees a weaker
 *    context than the document states.
 * 3. **A table larger than the token budget loses its header.** The second
 *    window of a 40-row table began mid-row (`9 |`), which is a cell with no
 *    column name — the "confident wrong answer" failure mode.
 *
 * Usage: node scripts/verify-chunking.mjs
 */

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

const { chunkDocument } = await import(new URL('../lib/store/chunk.js', import.meta.url).href)

/** The configuration the plugin ships, at a budget small enough to force splits. */
const config = {
  mode: 'heading',
  chunkTokens: 200,
  overlapTokens: 12,
  minChunkTokens: 5,
  preserveCodeBlocks: true,
  splitTablesByRow: true,
}

/** A budget small enough that a modest table must be split. */
const tight = { ...config, chunkTokens: 60 }

const allText = result => result.chunks.map(chunk => chunk.text).join('\n')

// ---------------------------------------------------------------------------
// 1. A parent section with only child headings must survive
// ---------------------------------------------------------------------------
{
  const text = [
    '# 手册',
    '',
    '## 安装',
    '',
    '### Windows',
    '',
    '第一步：下载安装包。',
    '',
    '### macOS',
    '',
    '第一步：拖入应用目录。',
  ].join('\n')

  const result = chunkDocument(text, config)
  const body = allText(result)
  check(
    'nesting: a parent section holding only child headings is not dropped',
    body.includes('手册') && body.includes('安装'),
    body.includes('手册') && body.includes('安装')
      ? 'both 手册 and 安装 reach the index'
      : `lost: ${[!body.includes('手册') && '手册', !body.includes('安装') && '安装'].filter(Boolean).join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// 2. A chunk must know the heading path it sits under
// ---------------------------------------------------------------------------
{
  const text = '# 手册\n\n## 安装\n\n详细步骤说明文字，足够长以超过最小分片限制。\n\n## 卸载\n\n卸载步骤说明文字。'
  const result = chunkDocument(text, config)
  const section = result.chunks.find(chunk => chunk.heading?.includes('安装'))
  check(
    'ancestry: a chunk records its ancestor headings, not only the nearest one',
    section !== undefined && section.heading?.includes('手册') === true,
    section === undefined ? 'no chunk for 安装' : `heading=${JSON.stringify(section.heading)}`,
  )
}

// ---------------------------------------------------------------------------
// 3. A split table repeats its header on every continuation window
// ---------------------------------------------------------------------------
{
  const rows = Array.from({ length: 40 }, (_, index) => `| 区域${index} | ${1000 + index} |`).join('\n')
  const text = ['## 明细', '', '| 地区 | 销量 |', '| --- | --- |', rows].join('\n')
  const result = chunkDocument(text, { ...tight, chunkTokens: 120 })

  check(
    'tables: a table larger than the budget is actually split',
    result.chunks.length > 1,
    `${result.chunks.length} chunk(s) for a 40-row table`,
  )

  // Every window that contains table rows must also carry the header, or its
  // cells reach the index with no column names.
  const tableChunks = result.chunks.filter(chunk => chunk.text.includes('|'))
  const headerless = tableChunks.filter(chunk => !/\|\s*地区\s*\|\s*销量\s*\|/.test(chunk.text))
  check(
    'tables: every window carrying rows repeats the header',
    tableChunks.length > 0 && headerless.length === 0,
    headerless.length === 0
      ? `${tableChunks.length} table window(s), all with the header`
      : `${headerless.length} of ${tableChunks.length} window(s) start with a bare cell: ${JSON.stringify(headerless[0]?.text.slice(0, 40))}`,
  )

  // No window may begin mid-row: a window's first line must be a whole line of
  // the source, which for a table means it starts with `|`.
  const brokenStarts = tableChunks.filter(chunk => !chunk.text.trimStart().startsWith('|') && !chunk.text.trimStart().startsWith('##'))
  check(
    'tables: no window begins in the middle of a row',
    brokenStarts.length === 0,
    brokenStarts.length === 0
      ? 'every table window starts on a row boundary'
      : `starts mid-row: ${JSON.stringify(brokenStarts[0]?.text.slice(0, 40))}`,
  )
}

// ---------------------------------------------------------------------------
// 4. The repairs must not disturb the ordinary cases
// ---------------------------------------------------------------------------
{
  const flat = 'ordinary prose with no headings at all, repeated. '.repeat(30)
  const result = chunkDocument(flat, config)
  check(
    'regression: heading-less prose still chunks and keeps its text',
    result.chunks.length > 0 && allText(result).includes('ordinary prose'),
    `${result.chunks.length} chunk(s)`,
  )

  const md = '# 标题\n\n正文内容。'.repeat(1)
  const simple = chunkDocument(md, config)
  check(
    'regression: a simple single-section document yields one chunk',
    simple.chunks.length === 1 && simple.chunks[0]?.heading === '标题',
    simple.chunks.length === 1 ? 'one chunk, heading kept' : `${simple.chunks.length} chunks`,
  )

  // A fenced block containing a `#` line must not be read as a heading.
  const fenced = '# 真实标题\n\n```sh\n# 这是注释不是标题\n```\n\n正文。'
  const fencedResult = chunkDocument(fenced, config)
  const headings = fencedResult.chunks.map(chunk => chunk.heading)
  check(
    'regression: a # inside a fenced block is still not a heading',
    headings.every(heading => heading === null || !heading.includes('注释')),
    `headings=${JSON.stringify(headings)}`,
  )
}

// ---------------------------------------------------------------------------
// 5. Chunking stays linear in document size
//
// The windower originally measured its candidate window by re-slicing and
// re-counting `text.slice(start, end)` at every character, which is O(n²) in both
// scanning and allocation. On a 167 KB chapter that took ~10 s per pass, and the
// build configurator paid it twice per page open (preview, then estimate) — the
// reported "索引 page is slow" and the long blank screen on re-entry.
//
// A wall-clock budget is asserted rather than an operation count because the
// regression is only visible as latency: scaling from 1x to 4x input must not
// scale the cost by anything near 16x.
// ---------------------------------------------------------------------------
{
  const unit = '向量检索把文本映射为稠密向量，再用近邻搜索召回相关片段，混合检索融合两路结果。\n'
  const small = `# 章\n${unit.repeat(400)}`
  const large = `# 章\n${unit.repeat(1600)}`

  const timeOf = (text) => {
    const started = process.hrtime.bigint()
    chunkDocument(text, config)
    return Number(process.hrtime.bigint() - started) / 1e6
  }

  // One warm-up pass each, so JIT compilation is not counted as a regression.
  timeOf(small)
  timeOf(large)

  const smallMs = Math.min(...[0, 1, 2].map(() => timeOf(small)))
  const largeMs = Math.min(...[0, 1, 2].map(() => timeOf(large)))
  const ratio = largeMs / Math.max(smallMs, 0.01)

  check(
    'performance: a 4x larger document does not cost 16x',
    ratio < 8,
    `4x input cost ${ratio.toFixed(1)}x (${smallMs.toFixed(1)} ms -> ${largeMs.toFixed(1)} ms)`,
  )
  check(
    'performance: a 160 KB chapter chunks in well under a second',
    largeMs < 1000,
    `${largeMs.toFixed(1)} ms for ${Math.round(large.length / 1024)} KB`,
  )
}

console.log(`\nKB-13 chunking acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
