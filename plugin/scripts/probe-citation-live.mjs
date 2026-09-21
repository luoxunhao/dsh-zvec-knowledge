/**
 * Live probe: does `readCitation` return the right window from the real store?
 *
 * The acceptance gates assert the read's *shape* in source. This one exercises the
 * actual implementation against the actual collection on disk, because the
 * properties that matter here are numeric and a source pattern cannot see them:
 * that the window really contains the cited line, that the chunk span maps to the
 * right lines, and that the excerpt bounds hold at the document's edges.
 *
 * Usage: node scripts/probe-citation-live.mjs <collectionId> <docId> <line>
 */

import { resolve } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const collectionId = process.argv[2] ?? 'kb_agentbook_5eed'
const docId = process.argv[3] ?? 'doc_ffb5b037'
const line = Number(process.argv[4] ?? 374)

// The compiled host half — the same module the running plugin loads.
const { KnowledgeOperations } = await import(`file://${resolve(ROOT, 'lib/host/operations.js').replace(/\\/g, '/')}`)

const workspaceDir = resolve(ROOT, '..')
const operations = new KnowledgeOperations({ workspaceDir, stateDir: '.dsh-kb-zvec' })

const failures = []
const passes = []
const check = (name, ok, detail) => {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

const view = operations.readCitation(collectionId, docId, line, null, 40)

check('read: a view is returned for a real document', view !== null, view === null ? 'returned null' : `docName=${view.docName}`)
if (view !== null) {
  check('read: the source path names a file that exists',
    existsSync(resolve(workspaceDir, view.sourcePath)) || existsSync(view.sourcePath),
    view.sourcePath)
  check('read: the cited line is inside the window',
    view.lines.some(item => item.number === line && item.isCitedLine),
    `window ${view.windowStart}-${view.windowStart + view.lines.length - 1}, cited ${view.line}`)
  check('read: exactly one line is marked cited',
    view.lines.filter(item => item.isCitedLine).length === 1,
    `${view.lines.filter(item => item.isCitedLine).length} marked`)
  check('read: the window is bounded by the requested context',
    view.lines.length <= 81, `${view.lines.length} lines for context=40`)
  check('read: the total line count is plausible', view.totalLines > 0, `${view.totalLines} lines`)
  check('read: line numbers are contiguous from the window start',
    view.lines.every((item, index) => item.number === view.windowStart + index),
    `starts at ${view.windowStart}`)

  // The line number must agree with an independent count of newlines in the
  // stored source — the same rule the tool's citation printing relies on.
  const fs = await import('node:fs')
  const path = existsSync(resolve(workspaceDir, view.sourcePath)) ? resolve(workspaceDir, view.sourcePath) : view.sourcePath
  const text = fs.readFileSync(path, 'utf8')
  const independent = text.split(/\r\n|\n|\r/)
  check('read: the line count agrees with an independent count',
    independent.length === view.totalLines, `${independent.length} vs ${view.totalLines}`)
  const cited = view.lines.find(item => item.isCitedLine)
  check('read: the cited line text matches the file verbatim',
    cited !== undefined && independent[line - 1] === cited.text,
    cited === undefined ? 'no cited line' : JSON.stringify(cited.text.slice(0, 60)))

  // Chunk-range mapping: the range must be one that really contains the cited
  // line, so the probe derives it from the line's own offsets rather than using a
  // constant. Pairing an unrelated range with a line is what a hardcoded value
  // did here, and it read as a mapping bug when the mapping was correct.
  const rangeStart = independent.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0)
  const rangeEnd = rangeStart + (independent[line - 1]?.length ?? 0)
  const ranged = operations.readCitation(collectionId, docId, line, { start: rangeStart, end: rangeEnd }, 5)
  if (ranged !== null) {
    const marked = ranged.lines.filter(item => item.inChunk)
    check('read: a chunk range marks a contiguous block of lines', marked.length > 0,
      `${marked.length} line(s) marked in chunk for ${rangeStart}-${rangeEnd}`)
    check('read: the range marks the cited line itself',
      marked.some(item => item.isCitedLine),
      `cited line ${line} marked: ${marked.some(item => item.isCitedLine)}`)
  }

  // A range entirely above the window must mark nothing — the marks are derived
  // from the range, not painted on unconditionally.
  const elsewhere = operations.readCitation(collectionId, docId, line, { start: 0, end: 1 }, 5)
  check('read: a range outside the window marks nothing',
    elsewhere !== null && elsewhere.lines.every(item => !item.inChunk),
    elsewhere === null ? 'null' : `${elsewhere.lines.filter(item => item.inChunk).length} marked`)

  console.log(`\n  document: ${view.docName}  (${view.totalLines} lines, ${view.ext})`)
  console.log(`  cited:    line ${view.line} of ${view.totalLines}`)
  console.log(`  window:   ${view.windowStart}-${view.windowStart + view.lines.length - 1}`)
  console.log('  excerpt:')
  for (const item of view.lines.slice(0, 6)) {
    const mark = item.isCitedLine ? '>' : item.inChunk ? '|' : ' '
    console.log(`   ${mark} ${String(item.number).padStart(4)} ${item.text.slice(0, 88)}`)
  }
}

// Edge cases that a windowed read must survive.
const first = operations.readCitation(collectionId, docId, 1, null, 40)
check('edge: line 1 clamps the window at the start', first !== null && first.windowStart === 1,
  first === null ? 'null' : `windowStart=${first.windowStart}`)

const huge = operations.readCitation(collectionId, docId, 999999, null, 40)
check('edge: a line past the end clamps rather than throwing',
  huge !== null && huge.line === huge.totalLines, huge === null ? 'null' : `line=${huge.line}/${huge.totalLines}`)

const zero = operations.readCitation(collectionId, docId, 0, null, 40)
check('edge: line 0 clamps to 1 rather than throwing', zero !== null && zero.line === 1,
  zero === null ? 'null' : `line=${zero.line}`)

const absent = operations.readCitation(collectionId, 'doc_does_not_exist', 1, null, 40)
check('edge: an unknown document returns null, not a throw', absent === null, String(absent))

let threw = false
try {
  operations.readCitation('kb_nope_0000', docId, 1, null, 40)
} catch {
  threw = true
}
check('edge: an unknown collection throws', threw, threw ? 'threw as expected' : 'did not throw')

console.log(`\nLive citation probe: ${passes.length} passed, ${failures.length} failed`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
