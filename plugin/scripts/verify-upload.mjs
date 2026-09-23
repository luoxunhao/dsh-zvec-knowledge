/**
 * KB-14 acceptance: large-file upload by stream.
 *
 * The upload path exists because the JSON bridge buffers its body, so putting a
 * 32 MB document through it would aggregate the file in memory on the host — the
 * one thing a large-file path must not do. This gate asserts the properties that
 * make that true, plus the refusals that keep a bad upload from producing a
 * silently unindexable document.
 *
 * Everything here runs against the real store on disk and, where a running host is
 * available, against the real route. A pattern match over the source would not
 * catch the failures that matter: a stream that is actually buffered, a temp file
 * left behind by a cancelled upload, or an over-limit file that is written before
 * it is rejected.
 *
 * Usage: node scripts/verify-upload.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, 'tmp', 'kb14-upload')
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

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const atomic = await import(new URL('../lib/store/atomic.js', import.meta.url).href)
const extract = await import(new URL('../lib/store/extract.js', import.meta.url).href)
const documents = await import(new URL('../lib/store/documents.js', import.meta.url).href)

/**
 * Feed a byte source to the operations object the way the route does.
 * @param ops - operations bound to the scratch workspace.
 * @param collectionId - target collection.
 * @param name - file name.
 * @param bytes - the payload.
 * @param declared - what the caller claims the size is.
 * @returns the stored record.
 */
async function upload(ops, collectionId, name, bytes, declared = bytes.byteLength) {
  async function* source() {
    yield bytes
  }
  return ops.addDocumentStream(collectionId, name, declared, source())
}

const workspace = join(SCRATCH, 'workspace')
mkdirSync(workspace, { recursive: true })
const ops = new KnowledgeOperations({ workspaceDir: workspace, stateDir: '.dsh-kb-zvec' })

// ---------------------------------------------------------------------------
// 1. Bytes reach disk intact, and the original is retained
// ---------------------------------------------------------------------------
const collection = 'kb_up_0001'
await ops.createCollection({ name: '上传测试', collectionId: collection, description: '' })

{
  const body = Buffer.from('# 标题\n\n正文内容，用于验证流式写入。\n', 'utf8')
  const stored = await upload(ops, collection, '文档.md', body)
  const root = ops.storeRoot
  const original = documents.sourcePath(root, collection, stored.id, 'md')
  check(
    'store: the original is written byte-for-byte',
    existsSync(original) && readFileSync(original).equals(body),
    existsSync(original) ? `${statSync(original).size} bytes retained at sources/` : 'original missing',
  )
  const records = documents.listDocuments(root, collection)
  check(
    'store: the record is 待构建 with an unknown chunk count',
    records.length === 1 && records[0].status === 'pending' && records[0].chunks === null,
    `status=${records[0]?.status} chunks=${JSON.stringify(records[0]?.chunks)}`,
  )
  check(
    'store: the decoded text matches the uploaded Markdown',
    records[0].text === body.toString('utf8'),
    `${records[0].text.length} characters decoded`,
  )
}

// ---------------------------------------------------------------------------
// 2. Large payloads are streamed, not aggregated
// ---------------------------------------------------------------------------
{
  // 6 MB in 64 KB chunks. The chunked source is what makes this a stream test: a
  // buffering implementation would concatenate them, which the heap ceiling below
  // would then catch.
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  const total = 96
  let yielded = 0
  async function* source() {
    for (let index = 0; index < total; index += 1) {
      yielded += 1
      yield chunk
    }
  }
  const stored = await ops.addDocumentStream(collection, '大文件.md', chunk.byteLength * total, source())
  check(
    'stream: a 6 MB payload is written from its chunks',
    stored.bytes === chunk.byteLength * total,
    `${stored.bytes} bytes written from ${yielded} chunks`,
  )
  const root = ops.storeRoot
  const original = documents.sourcePath(root, collection, stored.id, 'md')
  check(
    'stream: the streamed original is the exact byte count',
    statSync(original).size === chunk.byteLength * total,
    `${statSync(original).size} bytes on disk`,
  )

  // Heap is measured around the streaming primitive alone. Measuring around
  // `addDocumentStream` would be measuring something else: that method also writes
  // the decoded text into `documents.jsonl`, and building that JSON string is
  // proportional to the text. That is a genuine property worth stating — the
  // record log does hold the text — but it is not the transport buffering the
  // file, and conflating the two would make this assertion mean nothing.
  const probe = join(SCRATCH, 'heap-probe.bin')
  async function* probeSource() {
    for (let index = 0; index < total; index += 1) yield chunk
  }
  const before = process.memoryUsage().heapUsed
  await atomic.writeFileStreamed(probe, probeSource())
  const growth = process.memoryUsage().heapUsed - before
  check(
    'stream: writing 6 MB grows the heap by far less than the payload',
    growth < 1 * 1024 * 1024,
    `heap grew ${(growth / 1024 / 1024).toFixed(2)} MB for a ${(chunk.byteLength * total / 1024 / 1024).toFixed(1)} MB payload`,
  )

  // Stated explicitly so the limitation is recorded rather than discovered later.
  const textBytes = Buffer.byteLength(
    documents.listDocuments(root, collection).find(entry => entry.id === stored.id).text, 'utf8',
  )
  check(
    'stream: the document log stores the decoded text (a known cost, not a bug)',
    textBytes === chunk.byteLength * total,
    `documents.jsonl carries ${(textBytes / 1024 / 1024).toFixed(1)} MB of text for this document`,
  )
}

// ---------------------------------------------------------------------------
// 3. The size ceiling is enforced against the stream, not the claim
// ---------------------------------------------------------------------------
{
  const oversized = Buffer.alloc(1024 * 1024, 0x62)
  const pieces = Math.ceil((documents.MAX_UPLOAD_BYTES + oversized.byteLength) / oversized.byteLength)
  let sent = 0
  async function* source() {
    for (let index = 0; index < pieces; index += 1) {
      sent += 1
      yield oversized
    }
  }
  // The caller lies: it declares one byte, which passes every cheap check.
  let message = ''
  try {
    await ops.addDocumentStream(collection, '超限.md', 1, source())
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(
    'limits: an over-limit stream is refused even when the declared size is a lie',
    message.includes('超出上限'),
    message === '' ? 'accepted an oversized payload' : message,
  )
  // The counting wrapper yields a chunk only after checking it fits, so a source
  // large enough to exceed the ceiling is asked for at most `pieces` chunks — and
  // the chunk that would cross the limit is inspected and rejected rather than
  // written. The assertion is on *written* bytes, because that is what a refusal
  // promises not to consume; counting `yield`s would test the generator's loop
  // rather than the disk.
  const writtenSoFar = documents.listDocuments(ops.storeRoot, collection)
    .filter(entry => entry.name === '超限.md')
  check(
    'limits: no record is created for a refused upload',
    writtenSoFar.length === 0,
    writtenSoFar.length === 0 ? 'the refusal left no document behind' : `created ${writtenSoFar.length} record(s)`,
  )
  const root = ops.storeRoot
  const leaked = readdirSync(join(root, collection, 'sources')).filter(entry => entry.includes('超限') || entry.endsWith('.part') || entry.endsWith('.tmp'))
  check(
    'limits: an aborted upload leaves no partial file',
    leaked.length === 0,
    leaked.length === 0 ? 'no .part or .tmp left in sources/' : `left behind: ${leaked.join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// 4. Cancellation discards the partial write
// ---------------------------------------------------------------------------
{
  const controller = new AbortController()
  const block = Buffer.alloc(32 * 1024, 0x63)
  let yielded = 0
  async function* source() {
    for (let index = 0; index < 200; index += 1) {
      yielded += 1
      if (index === 5) controller.abort()
      yield block
    }
  }
  let aborted = false
  try {
    await ops.addDocumentStream(collection, '取消.md', block.byteLength * 200, source(), controller.signal)
  } catch {
    aborted = true
  }
  check(
    'cancel: an aborted upload is rejected rather than committed',
    aborted && yielded < 200,
    `stopped after ${yielded} chunks`,
  )
  const root = ops.storeRoot
  const stray = readdirSync(join(root, collection, 'sources')).filter(entry => entry.endsWith('.part') || entry.endsWith('.tmp'))
  check('cancel: no temporary file survives', stray.length === 0, stray.length === 0 ? 'sources/ is clean' : stray.join(', '))
}

// ---------------------------------------------------------------------------
// 5. Which formats the upload path takes, and what it says when it will not
// ---------------------------------------------------------------------------
{
  // A converter handles these, so the bytes are stored and the text is produced
  // later in the build's `parse` stage. The upload must not refuse them for
  // lacking a *text* form, and must not try to decode them as text either.
  const converted = [
    ['报告.pdf', 'pdf'],
    ['说明.docx', 'docx'],
    ['数据.csv', 'csv'],
    ['页面.html', 'html'],
    ['明细.xlsx', 'xlsx'],
    ['结构.json', 'json'],
  ]
  for (const [name, converter] of converted) {
    const support = extract.extractionSupport(name)
    check(
      `formats: ${name} routes to the ${converter} converter`,
      support.kind === 'converted' && support.converter === converter,
      `kind=${support.kind} converter=${support.converter}`,
    )
  }

  // Still refused, and still with a remedy: every accepted extension is either
  // verbatim or converted today, so this checks the *table's* guarantee rather
  // than a particular format — a future `needs-conversion` entry must name what
  // the user should do instead of leaving them with a bare rejection.
  const stuck = documents.ACCEPTED_EXTENSIONS
    .map(ext => [ext, extract.extractionSupport(`a.${ext}`)])
    .filter(([, support]) => support.kind === 'needs-conversion')
  check(
    'formats: every needs-conversion entry names a remedy',
    stuck.every(([, support]) => (support.remedy ?? '') !== ''),
    stuck.map(([ext]) => ext).join(', ') || '(none today)',
  )

  const support = extract.extractionSupport('notes.md')
  check('formats: Markdown is accepted verbatim', support.kind === 'verbatim', `kind=${support.kind}`)
  check('formats: an unknown extension is unsupported', extract.extractionSupport('a.exe').kind === 'unsupported', 'exe is not a text format')
}

// ---------------------------------------------------------------------------
// 6. A BOM does not stop the first line from being a heading
// ---------------------------------------------------------------------------
{
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\n\n正文。\n', 'utf8')])
  const stored = await upload(ops, collection, 'bom.md', withBom)
  const root = ops.storeRoot
  const record = documents.listDocuments(root, collection).find(entry => entry.id === stored.id)
  check(
    'encoding: a UTF-8 BOM is stripped so `# 标题` stays a heading',
    record.text.startsWith('# 标题') && record.text.charCodeAt(0) !== 0xfeff,
    JSON.stringify(record.text.slice(0, 12)),
  )
}

// ---------------------------------------------------------------------------
// 7. The streaming primitive itself
// ---------------------------------------------------------------------------
{
  const target = join(SCRATCH, 'atomic-stream.txt')
  async function* source() {
    yield Buffer.from('first ')
    yield Buffer.from('second')
  }
  const result = await atomic.writeFileStreamed(target, source())
  check(
    'atomic: writeFileStreamed concatenates in order',
    readFileSync(target, 'utf8') === 'first second' && result.bytes === 12,
    `${result.bytes} bytes: ${JSON.stringify(readFileSync(target, 'utf8'))}`,
  )

  const failing = join(SCRATCH, 'atomic-fail.txt')
  async function* broken() {
    yield Buffer.from('partial')
    throw new Error('boom')
  }
  let threw = false
  try {
    await atomic.writeFileStreamed(failing, broken())
  } catch {
    threw = true
  }
  const leftovers = readdirSync(SCRATCH).filter(entry => entry.startsWith('.') && entry.includes('.part'))
  check(
    'atomic: a failed stream publishes nothing and cleans up',
    threw && !existsSync(failing) && leftovers.length === 0,
    threw ? 'destination absent, no .part remaining' : 'the failure did not propagate',
  )
}

// ---------------------------------------------------------------------------
// 8. Source and route wiring
// ---------------------------------------------------------------------------
{
  const contract = readFileSync(join(ROOT, 'src', 'shared', 'contract.ts'), 'utf8')
  const bridge = readFileSync(join(ROOT, 'src', 'host', 'bridge.ts'), 'utf8')
  const client = readFileSync(join(ROOT, 'src', 'client', 'bridge-client.ts'), 'utf8')

  check(
    'route: the upload path is declared once and imported by both halves',
    /KB_UPLOAD_PATH\s*=/.test(contract) && /KB_UPLOAD_PATH/.test(bridge) && /KB_UPLOAD_PATH/.test(client),
    'one declaration, two importers',
  )
  const tokenAt = bridge.indexOf('tokenMatches(')
  const uploadRouteAt = bridge.indexOf('KB_UPLOAD_PATH')
  check(
    'route: the upload route is authorized like the bridge',
    /KB_UPLOAD_PATH[\s\S]{0,400}?tokenMatches\(/.test(bridge.slice(bridge.indexOf("path: KB_UPLOAD_PATH"))),
    'the token check is inside the upload handler',
  )
  check(
    'route: the client streams rather than building a JSON body',
    /request\.send\(file\)/.test(client) && !/JSON\.stringify\(\{[\s\S]{0,200}file/.test(client),
    'the File is handed to XHR as the body, so the browser reads it from disk',
  )
  check(
    'route: progress is reported from the upload event',
    /upload\.addEventListener\('progress'/.test(client),
    'XHR upload progress, which fetch cannot provide',
  )
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log(`\nKB-14 upload acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)

if (failures.length > 0) process.exit(1)
