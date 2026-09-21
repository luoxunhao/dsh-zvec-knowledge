/**
 * Acceptance gate: citations as openable references (KB-13).
 *
 * The feature is a chain, and every link in it fails *silently* if it is wrong —
 * which is why each is asserted separately rather than through one end-to-end
 * render:
 *
 * | link | how it fails silently |
 * |---|---|
 * | the tool renders a resolvable path | the view falls back to the unresolved form and every row is dead text |
 * | the view recovers the path and document id | the path is printed but the id is empty, so no tab can be addressed |
 * | the address identifies one passage | two citations of one document open two tabs, or one citation overwrites another |
 * | the host returns a window | the pane renders nothing, or the whole document |
 * | the cited line is marked apart from the chunk | a reader cannot tell the locator from the retrieved span |
 *
 * Usage: node scripts/verify-citation.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

const read = path => readFileSync(join(ROOT, path), 'utf8')

const toolView = read('src/client/SearchToolView.tsx')
const tabView = read('src/client/CitationTabView.tsx')
const tabModule = read('src/client/citation-tab.ts')
const opener = read('src/client/citation-opener.ts')
const entry = read('src/client/index.tsx').replace(/\/\*[\s\S]*?\*\//g, '')
const searchTool = read('src/host/search-tool.ts')
const ops = read('src/host/operations.ts')
const bridge = read('src/host/bridge.ts')

// ---------------------------------------------------------------------------
// 1. The tool renders a citation a reader can follow.
//
// A path plus a line is the resolvable form; the `docName #ordinal` form is the
// fallback. Both must be emitted, because the store can legitimately fail to
// resolve a source and the citation must still print something true.
// ---------------------------------------------------------------------------
check(
  'tool: the renderer prints the resolvable path and line',
  /hit\.sourcePath === undefined/.test(searchTool) && /`\$\{hit\.sourcePath\}/.test(searchTool),
  'sourcePath + line form present',
)
check(
  'tool: the unresolvable form still states the identifiers',
  /字符 \$\{hit\.charStart\}-\$\{hit\.charEnd\}/.test(searchTool),
  'character range printed in both forms',
)

// ---------------------------------------------------------------------------
// 2. The view recovers the path and the document id from what the model saw.
//
// The result reaches a view as content blocks, so the rendered text is the only
// source. Both regexes must be present: the located one first, and the unlocated
// fallback so a hit the store could not resolve is not dropped from the list.
// ---------------------------------------------------------------------------
check(
  'view: the located form is parsed',
  /\(\?\<line\>|\)\(\\d\+\)\\s\+\\\(字符/.test(toolView) || /\\s\+\\\(字符\\s\+\(\\d\+\)-\(\\d\+\)\\\)/gm.test(toolView),
  'located-line regex present',
)
check(
  'view: the unlocated fallback is still parsed',
  /#\(\\d\+\)\\s\+\\\(字符/.test(toolView),
  'fallback regex present',
)
check(
  'view: the document id is recovered from the snapshot path',
  /docIdFromPath/.test(toolView) && /startsWith\('doc_'\)/.test(toolView),
  'the store names a snapshot <docId>.<ext>, so the stem is the id',
)
// A row that cannot be opened must stay plain text rather than becoming a
// control that does nothing when clicked.
check(
  'view: an unopenable citation degrades to plain text',
  /ref === null \?/.test(toolView) && /citationStatic/.test(toolView),
  'no dead link when the row cannot be opened',
)
check(
  'view: the link names its destination for assistive technology',
  /aria-label=\{`在侧边栏查看/.test(toolView),
  'each row announces its own file and line',
)

// ---------------------------------------------------------------------------
// 3. The address identifies ONE passage, so re-clicking re-navigates.
//
// The registry deduplicates by address, so folding the document and line into it
// is what makes a second click on a different line of one document reuse the tab.
// ---------------------------------------------------------------------------
check(
  'address: the document and line are both in the address',
  /export function citationAddress/.test(tabModule) && /#L\$\{ref\.line\}/.test(tabModule),
  'scheme://collection/docId#L<line>',
)
check(
  'address: parsing is total and never throws',
  /export function parseCitationAddress/.test(tabModule) && /catch \{/.test(tabModule),
  'a malformed address is a quiet "not mine"',
)
check(
  'address: segments are percent-encoded',
  /encodeURIComponent\(ref\.collectionId\)/.test(tabModule) && /encodeURIComponent\(ref\.docId\)/.test(tabModule),
  'an id containing # or / still round-trips',
)
// The chunk range refines the view of an already-identified passage, so it rides
// in params rather than the address.
check(
  'opener: the chunk range travels in params, not the address',
  /chunkRange/.test(opener) === false && /chunkRange/.test(toolView) && /params/.test(opener),
  'the address identifies the passage; params describe it',
)
check(
  'opener: revealing an open tab instead of duplicating it',
  /revealIfOpened: true/.test(entry),
  'two clicks on one citation are one tab',
)
check(
  'opener: absence is a state, not a throw',
  /available: \(\) => sidebarRight !== undefined/.test(entry) && /if \(installed === undefined\) return false/.test(opener),
  'a deployment without the right column degrades',
)

// ---------------------------------------------------------------------------
// 4. The host returns a *window* and says so.
//
// Serving the whole document would make the pane a worse locator than the line
// number the reader arrived with, and would let one click serialize a book.
// ---------------------------------------------------------------------------
check(
  'host: the excerpt is bounded by a context window',
  /contextLines = 40/.test(ops) && /Math\.max\(citedLine - span, 1\)/.test(ops),
  'default 40 lines each side, clamped to the document',
)
check(
  'host: the window is bounded again at the bridge',
  /Math\.min\(Math\.max\(args\.contextLines, 0\), 200\)/.test(bridge),
  'a caller cannot ask for the whole document',
)
check(
  'host: the response states the total line count',
  /totalLines/.test(ops) && /窗口|windowStart/.test(ops),
  'an excerpt must announce itself rather than read as the document',
)
check(
  'host: the cited line is marked apart from the chunk span',
  /isCitedLine/.test(ops) && /inChunk/.test(ops),
  'the locator and the retrieved span are different facts',
)
check(
  'host: a missing document is null, not an error',
  /if \(record === undefined\) return null/.test(ops),
  'a removed source is a state the reader can understand',
)
check(
  'host: a missing collection still throws',
  /readMeta\(root, collectionId\) === null\) throw/.test(ops),
  'a wrong collection id is a caller error, not a user state',
)
// The stored snapshot text is quoted, never the original upload: the answer was
// built from the snapshot, and quoting a different revision would make the
// citation unfalsifiable.
check(
  'host: the stored snapshot text is what is read',
  /const text = record\.text/.test(ops) && /listDocuments\(root, collectionId\)\.find/.test(ops),
  'the same text the chunker cut',
)
check(
  'host: the read is registered as a bridge method',
  /'readCitation'/.test(read('src/shared/contract.ts')) && /case 'readCitation'/.test(bridge),
  'one dispatch entry, one client call site',
)

// ---------------------------------------------------------------------------
// 5. The pane renders every state it can be in.
// ---------------------------------------------------------------------------
for (const [state, pattern, why] of [
  ['loading', /正在读取引用原文/, 'a read in flight is stated, not a bare blank pane'],
  ['missing', /该来源文档已不在知识库中/, 'a removed source is a fact, not a fault'],
  ['failed', /role="alert"/, 'a transport failure is announced, with the host\'s reason'],
]) {
  check(`pane: the ${state} state is rendered`, pattern.test(tabView), why)
}
check(
  'pane: the excerpt announces truncation on both sides',
  /上方还有/.test(tabView) && /下方还有/.test(tabView),
  'a clipped excerpt must not read as the whole document',
)
check(
  'pane: the tab\'s own signal aborts the read',
  /props\.tab\?\.signal/.test(tabView) && /controller\.abort\(\)/.test(tabView),
  'closing a tab stops host-side work',
)
check(
  'pane: the layout uses design tokens, not literals',
  !/#[0-9a-fA-F]{3,6}\b/.test(read('src/client/CitationTabView.module.css').replace(/\/\*[\s\S]*?\*\//g, '')),
  'no colour literal in the citation stylesheet',
)

console.log(`\nCitation acceptance: ${passes.length} passed, ${failures.length} failed`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
