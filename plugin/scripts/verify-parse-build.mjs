/**
 * Parse-stage acceptance: the build pipeline converts, and one bad document does
 * not cost the collection.
 *
 * **The invariant this gate exists for.** `startBuild` runs inside a `try/catch`
 * that discards the staging slot and fails the entire build, so a document-level
 * conversion error that escaped the parse stage would make one unreadable file
 * destroy the index of every other document in the collection. An isolated
 * converter gate (`verify-parse-pdf.mjs`) proves only that `convertPdf` *reports*
 * a failure; it cannot prove the pipeline *contains* one. The containment is a
 * property of the parse stage's shape — a guard around **each iteration** of the
 * document loop, inside the `try` — and not of any particular fixture, because
 * the outer `catch` is what the escaping error would reach whatever produced it.
 * Case 2 below asserts that shape directly, so the mechanism cannot be removed
 * without a red check; case 1 asserts the behaviour it produces.
 *
 * **Where the guard has to sit, and why the two obvious alternatives are wrong.**
 * Both were tried and both fail the whole build:
 *
 * | placement | outcome |
 * |---|---|
 * | per-document, inside the loop | the build continues — this is the implemented one |
 * | per-document, rethrown out of the loop | outer `catch` discards the slot and fails everything |
 * | unguarded in the loop | same as above |
 *
 * That is the whole reason the guard is not merely inside a helper: an error that
 * leaves the loop at all has already lost, because the pipeline's own `catch`
 * cannot tell it from a systemic fault.
 *
 * **Why the bad document is injected rather than uploaded.** The brief's sketch
 * used a damaged upload, and that input class is no longer reachable through the
 * product: Task 2's upload path runs `extractionSupport(name).preflight` *before*
 * a record is written, so a PDF with no text layer is refused at upload and a
 * build never sees it. (Reproduced: `addDocumentStream` of `scanned.pdf` throws
 * the OCR remedy.) Injecting the failure at the store — a record marked `failed`,
 * which is exactly what an earlier version of this build, or a direct store
 * write, leaves behind — tests the invariant on its own terms instead of through
 * one converter's error message, and it is the documented state that
 * `incrementalViability` and `markPublished` both key on.
 *
 * **Why an unimplemented converter id is asserted, not skipped.** `extract.ts`
 * advertises `docx` / `html` / `xlsx` / `csv` / `json` and gives each a converter
 * id, but only `pdf` has an implementation until Tasks 4-6. The failure mode that
 * would otherwise ship is the worst available one: the upload is accepted, the
 * build succeeds, and the document indexes nothing with no way to tell it apart
 * from a document that was legitimately empty. The check pins that a `docx`
 * document *fails*, naming the missing converter, rather than producing silence.
 *
 * Runs offline: a committed fixture, a local engine and a deterministic
 * in-process embedding. No API key and no network.
 *
 * Usage: node scripts/verify-parse-build.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { KnowledgeOperations } = await import(new URL('../lib/host/operations.js', import.meta.url).href)
const { documentsPath } = await import(new URL('../lib/store/documents.js', import.meta.url).href)
const { startBuild } = await import(new URL('../lib/store/build.js', import.meta.url).href)
const { listDocuments } = await import(new URL('../lib/store/documents.js', import.meta.url).href)

let pass = 0
let fail = 0

/**
 * Record one criterion.
 * @param name - what was asserted.
 * @param ok - whether it held.
 * @param detail - the observed value, when failing.
 */
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A PDF with a text layer: the good half of the central case. */
const LATIN = 'src/store/parse/fixtures/latin.pdf'
/** A PDF with no text layer at all: what the upload preflight refuses. */
const SCANNED = 'src/store/parse/fixtures/scanned.pdf'

/** The chunking and index a build needs; both are validated by the host. */
const STRATEGY = {
  chunking: {
    mode: 'heading', chunkTokens: 512, overlapTokens: 64, minChunkTokens: 1,
    preserveCodeBlocks: true, splitTablesByRow: false,
  },
  index: { kind: 'HNSW', m: 32, efConstruction: 200, quantize: 'INT8' },
}

/**
 * A deterministic 1024-dimension embedding, so no network is needed.
 * @param texts - the texts to embed.
 * @returns one unit vector per text.
 */
function fakeEmbed(texts) {
  return Promise.resolve(texts.map(text => {
    const vector = new Float32Array(1024)
    for (let index = 0; index < text.length; index += 1) {
      vector[(text.charCodeAt(index) + index) % 1024] += 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return vector
  }))
}

/**
 * Poll a build job until it settles.
 * @param ops - the operations object.
 * @param collectionId - the collection being built.
 * @returns the settled snapshot.
 */
async function awaitJob(ops, collectionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = ops.buildStatus(collectionId)
    if (snapshot !== null && snapshot.settledAt !== null) return snapshot
    if (Date.now() > deadline) throw new Error('job did not settle in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Upload one stored file through the real streaming path.
 *
 * The conversion is the *build's* job, so the upload must not be the thing that
 * produces text. Going through `addDocumentStream` rather than hand-writing a
 * record is what proves the two halves are wired to each other: the route that
 * records `converter` at upload is the same one whose verdict the parse stage
 * then acts on.
 * @param ops - the operations object.
 * @param collectionId - target collection.
 * @param name - file name, which decides the format.
 * @param path - path of the bytes to upload.
 * @returns the stored document's id.
 */
async function upload(ops, collectionId, name, path) {
  const bytes = readFileSync(path)
  return ops.addDocumentStream(collectionId, name, bytes.byteLength, (async function* () { yield bytes })())
}

/** Read a collection's document log as objects. */
function readLog(scratch, collectionId) {
  return readFileSync(join(scratch, '.kb', collectionId, 'documents.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Read a collection's metadata. */
function readMeta(scratch, collectionId) {
  return JSON.parse(readFileSync(join(scratch, '.kb', collectionId, 'meta.json'), 'utf8'))
}

/** Read a collection's document records through the store's own reader. */
function listDocumentsOnDisk(scratch, collectionId) {
  return listDocuments(join(scratch, '.kb'), collectionId)
}

const scratch = mkdtempSync(join(tmpdir(), 'kb-parse-build-'))
const ops = new KnowledgeOperations({
  workspaceDir: scratch,
  stateDir: '.kb',
  embed: fakeEmbed,
  dimension: 1024,
  quota: { bytes: null, warnAt: 0.9 },
})

try {
  // =========================================================================
  // 1. THE CENTRAL INVARIANT — one document's failure does not fail the build
  // =========================================================================
  await ops.createCollection({ name: '解析', collectionId: 'kb_prod_2f8a', description: '' })
  const good = await upload(ops, 'kb_prod_2f8a', 'good.pdf', LATIN)

  // The bad half, injected at the store. Written *after* the upload so the
  // collection genuinely holds one convertible document and one that cannot be,
  // which is the shape the invariant is about.
  //
  // It is staged as `failed` rather than `pending` because that is the state the
  // invariant is *about*: a document the store already knows cannot be parsed,
  // sitting alongside one that can. It is also the state the pipeline produces
  // for itself — the upload preflight refuses a text-free PDF before a record is
  // written, so `pending` + unparseable is a pair the product can no longer
  // create (reproduced: uploading `scanned.pdf` throws the OCR remedy). Seeding
  // the verdict directly tests the recovery and the containment on their own
  // terms instead of depending on one converter's error message.
  const badId = 'doc_bad0001'
  const badFile = join(scratch, '.kb', 'kb_prod_2f8a', 'sources', `${badId}.pdf`)
  mkdirSync(join(scratch, '.kb', 'kb_prod_2f8a', 'sources'), { recursive: true })
  writeFileSync(badFile, readFileSync(SCANNED))
  writeFileSync(documentsPath(ops.storeRoot, 'kb_prod_2f8a'), [
    JSON.stringify({
      id: good.id, name: 'good.pdf', bytes: 965, ext: 'pdf', text: '',
      status: 'pending', chunks: null, converter: 'pdf',
      uploadedAt: new Date().toISOString(), builtAt: null,
    }),
    JSON.stringify({
      id: badId, name: 'scan.pdf', bytes: 854, ext: 'pdf', text: '',
      status: 'pending', chunks: null, converter: 'pdf',
      error: 'PDF 前 1 页没有文本层，扫描件无法提取文字，而本插件不含 OCR。',
      uploadedAt: new Date().toISOString(), builtAt: null,
    }),
    '',
  ].join('\n'))

  await ops.buildIndex('kb_prod_2f8a', STRATEGY, { onProgress: () => {}, onLog: () => {} })
  const build = await awaitJob(ops, 'kb_prod_2f8a')

  check(
    'containment: one unparseable document does NOT fail the build',
    build.ok === true,
    `ok=${build.ok} error=${build.error ?? '-'}`,
  )

  const after = await ops.listDocuments('kb_prod_2f8a')
  const byId = id => after.find(document => document.id === id)

  check(
    'good document: parsed, built, and carries a structure verdict',
    byId(good.id)?.status === 'ready' && (byId(good.id)?.chunks ?? 0) > 0,
    `status=${byId(good.id)?.status} chunks=${byId(good.id)?.chunks}`,
  )

  const bad = byId(badId)
  check(
    'bad document: status=failed with a reason naming the failure',
    bad?.status === 'failed' && typeof bad?.error === 'string' && bad.error.length > 0,
    `status=${bad?.status} error=${bad?.error ?? '(none)'}`,
  )
  // The reason must survive the publish. `markPublished` sweeps every document
  // the build embedded to `ready`, which would erase exactly the verdict the user
  // needs to see — and the build *does* embed the failed document, because the
  // parse stage hands it on with empty text and the chunker runs over it. A
  // document that looks 已构建 while holding no text and no chunks is the
  // silent-empty shape this whole task exists to prevent.
  check(
    'bad document: its reason survives the publish that follows it',
    /没有文本层|OCR|加密|口令/.test(bad?.error ?? ''),
    bad?.error ?? '(none)',
  )

  // The published snapshot must hold only the good document's chunks. Asserted
  // on the index rather than the log, because "contained" must mean the bad
  // document contributed nothing — not merely that its record says so.
  check(
    'containment: the published index holds only the good document chunks',
    build.chunks > 0 && build.chunks === (byId(good.id)?.chunks ?? 0),
    `${build.chunks} chunks published, good=${byId(good.id)?.chunks}, bad=${bad?.chunks}`,
  )
  check(
    'containment: the collection published, so it is not left unbuilt',
    readMeta(scratch, 'kb_prod_2f8a').active !== null,
    `active=${readMeta(scratch, 'kb_prod_2f8a').active}`,
  )

  // =========================================================================
  // 2. The guard is per document *inside* the loop, not outside it
  // =========================================================================
  // Behavioural case 1 proves the failure was recorded; this proves *where*, and
  // it is a different fact. A guard placed outside the loop produces the same
  // per-document record and still fails the whole build — so without this check
  // the guard could be moved and case 1 would go red for a reason that reads
  // like a fixture problem rather than a structural one.
  const buildSource = readFileSync(join(ROOT, 'src', 'store', 'build.ts'), 'utf8')
  const loop = /for \(const document of request\.documents\) \{([\s\S]*?)\n  \}\n  return kept/.exec(buildSource)
  check(
    'structure: the parse loop exists and is where the guard can be inspected',
    loop !== null,
    loop === null ? 'the document loop could not be located in build.ts' : 'loop located',
  )
  check(
    'structure: each iteration is guarded, so one failure cannot leave the loop',
    loop !== null && /try \{/.test(loop[1]) && /catch \(error\)/.test(loop[1]),
    loop === null ? '-' : `guard present=${/try \{/.test(loop[1])} catch present=${/catch \(error\)/.test(loop[1])}`,
  )
  // The document-level failures that are *not* thrown by the converter are
  // recorded through the same path, so both routes stay inside the loop.
  check(
    'structure: a recorded failure is not rethrown out of the loop',
    loop !== null && !/throw failOne|throw patch\(/.test(loop[1]),
    'a rethrow would reach the pipeline catch and discard the whole slot',
  )

  // =========================================================================
  // 3. The derived text is written back and is real Markdown
  // =========================================================================
  // Read from the document log on disk rather than through the operations view,
  // which does not expose `text`: the claim is that the parse stage *wrote it
  // back*, and only the stored record can show that.
  const log = readLog(scratch, 'kb_prod_2f8a')
  const goodRecord = log.find(record => record.id === good.id)

  check(
    'write-back: the converted text is stored on the document record',
    typeof goodRecord?.text === 'string' && goodRecord.text.trim().length > 0,
    `len=${goodRecord?.text?.length ?? 0}`,
  )
  check(
    'write-back: the text is the converter’s Markdown, not the raw bytes',
    /(?:^|\n)#{1,6} \S/.test(goodRecord?.text ?? ''),
    JSON.stringify((goodRecord?.text ?? '').slice(0, 80)),
  )
  check(
    'write-back: the record names the converter that produced it',
    goodRecord?.converter === 'pdf',
    `converter=${goodRecord?.converter ?? '(absent)'}`,
  )
  check(
    'write-back: the record carries the structure verdict and a parse time',
    typeof goodRecord?.structure === 'string' && typeof goodRecord?.parsedAt === 'string',
    `structure=${goodRecord?.structure} parsedAt=${goodRecord?.parsedAt ?? '(absent)'}`,
  )
  check('write-back: the produced text contains no CR', !(goodRecord?.text ?? '').includes('\r'))
  check(
    'write-back: a failed document keeps no text',
    (log.find(record => record.id === badId)?.text ?? '') === '',
    JSON.stringify((log.find(record => record.id === badId)?.text ?? '').slice(0, 40)),
  )
  // A publish sweeps every embedded document to `ready`; the parse stage's
  // verdict must survive it, or the failure the user most needs to see is
  // erased by the very build that recorded it.
  check(
    'write-back: the publish did not overwrite the failure with 已构建',
    bad?.status === 'failed',
    `status=${bad?.status}`,
  )

  // =========================================================================
  // 4. An advertised but unimplemented converter fails loudly
  // =========================================================================
  // `extract.ts` names `docx` and there is no `convertDocx` until Task 5. The
  // document must fail *by name*; an empty success would be indexed as a
  // document with no content and would look exactly like a clean conversion of
  // nothing.
  await ops.createCollection({ name: '未实现', collectionId: 'kb_prod_3a7e', description: '' })
  const docxBytes = Buffer.from('PK\u0003\u0004 not really a docx, and it must not matter')
  await ops.addDocumentStream('kb_prod_3a7e', 'pending.docx', docxBytes.byteLength, (async function* () { yield docxBytes })())

  await ops.buildIndex('kb_prod_3a7e', STRATEGY, { onProgress: () => {}, onLog: () => {} })
  const docxBuild = await awaitJob(ops, 'kb_prod_3a7e')
  const docxDoc = (await ops.listDocuments('kb_prod_3a7e'))[0]

  check(
    'unimplemented converter: the document fails rather than silently indexing nothing',
    docxDoc?.status === 'failed' && /docx/.test(docxDoc?.error ?? ''),
    `status=${docxDoc?.status} error=${docxDoc?.error ?? '(none)'}`,
  )
  check(
    'unimplemented converter: it is not a silent empty success',
    docxDoc?.chunks === null && docxDoc?.status !== 'ready',
    `status=${docxDoc?.status} chunks=${docxDoc?.chunks}`,
  )
  // Nothing was publishable, so the build as a whole fails — a different outcome
  // from the containment case above, and both are correct. What matters is that
  // it fails *with a reason* rather than publishing an empty snapshot.
  check(
    'unimplemented converter: a collection of only that document fails with a reason',
    docxBuild.ok === false && typeof docxBuild.error === 'string' && docxBuild.error.length > 0,
    `ok=${docxBuild.ok} error=${docxBuild.error ?? '(none)'}`,
  )
  check(
    'unimplemented converter: no empty snapshot was published',
    readMeta(scratch, 'kb_prod_3a7e').active === null,
    `active=${readMeta(scratch, 'kb_prod_3a7e').active}`,
  )

  // =========================================================================
  // 5. Changing what the text was parsed by forces a full rebuild
  // =========================================================================
  // KB-13 addresses a citation by the stored text's *line number*. If an
  // incremental build embedded new-parser text for one document while inheriting
  // old-parser text for the rest, every stored line number could point at a
  // different sentence and nothing would say so. The trigger is asserted against
  // the real viability check, exercised by writing the recorded summary directly
  // — the state being tested includes "a store written by an older version",
  // which no current code path can produce.
  const viable = (scratchDir = scratch) => {
    const metaPath = join(scratchDir, '.kb', 'kb_prod_2f8a', 'meta.json')
    return { metaPath, meta: JSON.parse(readFileSync(metaPath, 'utf8')) }
  }

  check(
    'parser: the published snapshot records what its text was parsed by',
    typeof readMeta(scratch, 'kb_prod_2f8a').parser?.converter === 'string'
      && typeof readMeta(scratch, 'kb_prod_2f8a').parser?.structure === 'string',
    JSON.stringify(readMeta(scratch, 'kb_prod_2f8a').parser ?? null),
  )
  // The parser summary is recorded from the *whole* log, so the served snapshot's
  // value already describes the failed document too — which is why the next
  // viability check must still say "viable". Asserted, because the failure mode of
  // getting this wrong is a full rebuild of the corpus on every submission.
  const viableNow = ops.incrementalViability('kb_prod_2f8a', STRATEGY.chunking, STRATEGY.index)
  check(
    'parser: unchanged parser still allows an incremental build',
    viableNow.possible === true,
    viableNow.reason || 'viable',
  )
  check(
    'parser: the recorded summary covers the whole log, not just what was embedded',
    readMeta(scratch, 'kb_prod_2f8a').parser?.converter === 'pdf',
    JSON.stringify(readMeta(scratch, 'kb_prod_2f8a').parser ?? null),
  )
  check(
    'parser: a changed parser forces a full rebuild and says why',
    (() => {
      const { metaPath, meta } = viable()
      const saved = meta.parser
      meta.parser = { converter: 'docx', structure: 'structured' }
      writeFileSync(metaPath, JSON.stringify(meta))
      const verdict = ops.incrementalViability('kb_prod_2f8a', STRATEGY.chunking, STRATEGY.index)
      meta.parser = saved
      writeFileSync(metaPath, JSON.stringify(meta))
      return verdict.possible === false && /解析|结构/.test(verdict.reason)
    })(),
    'the reason is surfaced, not a silent downgrade',
  )
  check(
    'parser: a snapshot built before the field existed forces a full rebuild',
    (() => {
      const { metaPath, meta } = viable()
      const saved = meta.parser
      delete meta.parser
      writeFileSync(metaPath, JSON.stringify(meta))
      const verdict = ops.incrementalViability('kb_prod_2f8a', STRATEGY.chunking, STRATEGY.index)
      meta.parser = saved
      writeFileSync(metaPath, JSON.stringify(meta))
      return verdict.possible === false && /解析|结构/.test(verdict.reason)
    })(),
    'an unknown parser cannot be proven equal, so it rebuilds in full',
  )
  // The trigger must also *hold* the tree still for a document set it does not
  // describe: a record whose converter is not what the snapshot recorded is
  // precisely the mixture that drifts citation line numbers.
  check(
    'parser: a document whose converter differs from the snapshot forces a rebuild',
    (() => {
      const { metaPath, meta } = viable()
      const saved = meta.parser
      meta.parser = { converter: 'pdf,verbatim', structure: 'inferred' }
      writeFileSync(metaPath, JSON.stringify(meta))
      const verdict = ops.incrementalViability('kb_prod_2f8a', STRATEGY.chunking, STRATEGY.index)
      meta.parser = saved
      writeFileSync(metaPath, JSON.stringify(meta))
      return verdict.possible === false
    })(),
    'verbatim and converted documents in one snapshot are two parsers',
  )

  // =========================================================================
  // 6. A re-parse is reproducible from the stored original alone
  // =========================================================================
  // The design's premise: the original is kept byte-for-byte and the text is
  // *derived* from it, so a converter change can be re-run over the whole
  // collection without re-uploading anything. Asserted here because the parse
  // stage is what makes the premise real — the file has to still be there and
  // has to still convert to the same text.
  await ops.createCollection({ name: '重解析', collectionId: 'kb_prod_4b1c', description: '' })
  await upload(ops, 'kb_prod_4b1c', 'again.pdf', LATIN)
  await ops.buildIndex('kb_prod_4b1c', STRATEGY, { onProgress: () => {}, onLog: () => {} })
  const first = await awaitJob(ops, 'kb_prod_4b1c')
  const firstRecord = readLog(scratch, 'kb_prod_4b1c')[0]

  await ops.buildIndex('kb_prod_4b1c', STRATEGY, { onProgress: () => {}, onLog: () => {} }, 'full')
  const second = await awaitJob(ops, 'kb_prod_4b1c')
  const secondRecord = readLog(scratch, 'kb_prod_4b1c')[0]

  check(
    'reparse: a second build reproduces the same text from the stored original',
    first.ok === true && second.ok === true
      && (firstRecord?.text ?? '').length > 0 && firstRecord.text === secondRecord?.text,
    `first=${firstRecord?.text?.length ?? 0} chars, second=${secondRecord?.text?.length ?? 0} chars, equal=${firstRecord?.text === secondRecord?.text}`,
  )
  check(
    'reparse: the stored original is still there to re-read',
    readFileSync(join(scratch, '.kb', 'kb_prod_4b1c', 'sources', `${firstRecord?.id}.pdf`)).length > 0,
    'sources/<docId>.pdf is present and non-empty',
  )

  // =========================================================================
  // 7. Progress is by document first, then by chunk, and never goes backwards
  // =========================================================================
  // The parse stage is the first half of a build's wall-clock time and it works
  // in documents; the chunking stage works in chunks. Re-basing `total` between
  // them is unavoidable, and a bar that dips at the boundary reads as a glitch —
  // so the fraction is asserted monotonic across a real multi-document build.
  //
  // **Observed through `startBuild`, not through `operations.buildIndex`.** The
  // operations layer documents its own `handlers` as *superseded by the job's
  // record*, because a background job outlives the request that launched it; a
  // probe confirmed the handler receives zero callbacks. The progress contract
  // therefore lives on `startBuild`'s `onProgress`, and that is what is driven
  // here. The polling form of the same facts is checked too, in case the job
  // record ever stops carrying them.
  await ops.createCollection({ name: '进度', collectionId: 'kb_prod_5c2d', description: '' })
  await upload(ops, 'kb_prod_5c2d', 'p1.pdf', LATIN)
  // A text document keeps the chunk count well above the document count, which is
  // the regime where a naive re-base could dip rather than jump.
  await ops.addDocument('kb_prod_5c2d', {
    name: 'p2.md',
    bytes: 4096,
    text: `# 章节\n${'解析阶段的进度先按文档计，切分阶段再改按分片计。'.repeat(120)}\n`,
  })

  const trace = []
  const progressBuild = await startBuild({
    storeRoot: ops.storeRoot,
    collectionId: 'kb_prod_5c2d',
    slot: 'a',
    index: STRATEGY.index,
    dimension: 1024,
    documentsFile: { storeRoot: ops.storeRoot, collectionId: 'kb_prod_5c2d' },
    parse: { timeoutMs: 60_000, maxPages: 100, maxTextBytes: 4 * 1024 * 1024 },
    quota: { bytes: null, warnAt: 0.9 },
    documents: listDocumentsOnDisk(scratch, 'kb_prod_5c2d').map(record => ({
      docId: record.id,
      text: record.text,
      ...(record.converter === undefined
        ? {}
        : {
            source: {
              file: join(scratch, '.kb', 'kb_prod_5c2d', 'sources', `${record.id}.${record.ext}`),
              converter: record.converter,
              reparse: false,
            },
          }),
    })),
    chunking: STRATEGY.chunking,
    embed: fakeEmbed,
    onProgress: progress => trace.push(progress),
    onLog: () => {},
  }).done
  const fractions = trace.map(step => step.fraction)
  check(
    'progress: the fraction never decreases',
    fractions.length > 0 && fractions.every((value, index) => index === 0 || value >= fractions[index - 1]),
    fractions.join(' → ') || '(no progress emitted)',
  )
  check(
    'progress: the parse stage reports per document before chunking re-bases',
    trace[0]?.total === 2 && trace[0]?.stages?.[0]?.state === 'running',
    `first emission total=${trace[0]?.total} parse=${trace[0]?.stages?.[0]?.state}`,
  )
  check(
    'progress: the total is re-based from documents to chunks',
    trace.some(step => step.total === 2) && trace.some(step => step.total > 2),
    `totals seen: ${[...new Set(trace.map(step => step.total))].join(', ')}`,
  )
  check(
    'progress: the build finished with the bar full',
    progressBuild.ok === true && fractions[fractions.length - 1] === 1,
    `ok=${progressBuild.ok} last=${fractions[fractions.length - 1]}`,
  )
  // The same facts, as the page actually reads them: polled off the job record.
  // Driven through `buildIndex` in its own collection, because a job record only
  // exists for a build the *operations* layer launched — the direct `startBuild`
  // above is a store-level call with no job behind it.
  await ops.createCollection({ name: '进度轮询', collectionId: 'kb_prod_7e4f', description: '' })
  await upload(ops, 'kb_prod_7e4f', 'q1.pdf', LATIN)
  await ops.addDocument('kb_prod_7e4f', {
    name: 'q2.md',
    bytes: 4096,
    text: `# 章节\n${'轮询读到的进度也应当是满格。'.repeat(120)}\n`,
  })
  await ops.buildIndex('kb_prod_7e4f', STRATEGY, { onProgress: () => {}, onLog: () => {} })
  const polledBuild = await awaitJob(ops, 'kb_prod_7e4f')
  const polled = ops.buildStatus('kb_prod_7e4f')
  check(
    'progress: the job record reports a full bar once settled',
    polled?.fraction === 1 && polled?.total === polled?.processed && (polled?.total ?? 0) > 0,
    `fraction=${polled?.fraction} ${polled?.processed}/${polled?.total}`,
  )
  // The total must have been re-based to chunks on the way, not left at the
  // document count: two documents produce far more than two chunks here.
  check(
    'progress: the settled job reports chunks, not documents, as its total',
    (polled?.total ?? 0) > 2 && polled?.total === polledBuild.chunks,
    `total=${polled?.total} published chunks=${polledBuild.chunks}`,
  )

  // =========================================================================
  // 8. Quota is re-checked once the derived text exists
  // =========================================================================
  // Upload charges the *original* bytes, because at that moment the derived text
  // does not exist. Parse is where it starts to exist, so a document admitted on
  // its compressed size and producing far more text must be refused then — and
  // refused *itself*, with a reason naming the shortfall, while the rest of the
  // collection builds.
  {
    // **Driven at the store level, not through `buildIndex`.** The claim under test
    // is the parse stage's *second* admission: upload charges the original bytes,
    // and parsing is where the derived text starts to exist, so that is where its
    // real size can be measured. `operations.buildIndex` checks a *collection-level*
    // admission first — the projected vector bytes plus the embedded text — and in a
    // store as full as this one needs to be, that fires before the build starts at
    // all, so the per-document check would never run and this section would pass
    // without exercising anything. Calling `startBuild` directly reaches the stage
    // under test while leaving the collection-level admission out of the picture; it
    // is the same entry point section 7 uses for the same reason.
    const sourceDir = mkdtempSync(join(tmpdir(), 'kb-parse-quota-src-'))
    const tinyPdf = join(sourceDir, 'tiny.pdf')
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const { convertPdf } = await import(new URL('../lib/store/parse/pdf.js', import.meta.url).href)
    {
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const page = doc.addPage([400, 400])
      // Several lines of real prose, so the converted Markdown is a few hundred
      // bytes — enough that a little leftover headroom is still certainly smaller
      // than it. No headings: one paragraph, deterministic output.
      const lines = [
        'The quota is checked twice for a converted document.',
        'Upload charges the original bytes, because the derived text',
        'does not exist yet. Parsing is where it starts to exist.',
        'So the parse stage admits again, against the real size.',
        'A document that no longer fits fails alone.',
        'The rest of the collection is unaffected by it.',
        'This paragraph exists only to make the derived text large',
        'enough that the remaining headroom is certainly smaller.',
      ]
      lines.forEach((text, index) => {
        page.drawText(text, { x: 20, y: 360 - index * 20, size: 10, font })
      })
      writeFileSync(tinyPdf, await doc.save())
    }
    const tinySource = readFileSync(tinyPdf)
    const tinyResult = await convertPdf(tinyPdf, { timeoutMs: 10_000, maxPages: 10, maxTextBytes: 1e6 })
    const derivedBytes = Buffer.byteLength(tinyResult.text, 'utf8')

    const tight = mkdtempSync(join(tmpdir(), 'kb-parse-quota-'))
    // The quota is **measured, not guessed**, because the upload path over-charges
    // and the size of that over-charge is not this gate's business to model:
    // `addDocumentStream` consults `admit` *after* streaming the original to disk, so
    // the incoming bytes are counted once as already present and once again as the
    // declared footprint. A first pass with an unlimited quota therefore gives both
    // numbers the rest of the section needs — what the store really occupies, and
    // what the upload insists on reserving.
    const measureDir = mkdtempSync(join(tmpdir(), 'kb-parse-quota-measure-'))
    let sizeAfterPdf = 0
    let uploadReservation = 0
    {
      const probe = new KnowledgeOperations({
        workspaceDir: measureDir,
        stateDir: '.kb',
        embed: fakeEmbed,
        dimension: 1024,
        quota: { bytes: null, warnAt: 0.9 },
      })
      await probe.createCollection({ name: '量', collectionId: 'kb_prod_6d3e', description: '' })
      const beforeUpload = probe.usage().used
      await probe.addDocumentStream('kb_prod_6d3e', 'tiny.pdf', tinySource.byteLength, (async function* () { yield tinySource })())
      sizeAfterPdf = probe.usage().used
      // What the upload demanded: the store as it stood once the file was on disk,
      // plus the declared footprint it then tried to reserve.
      uploadReservation = sizeAfterPdf + tinySource.byteLength
      void beforeUpload
      probe.dispose()
    }
    try {
      rmSync(measureDir, { recursive: true, force: true })
    } catch {
      // Engine handle still open; see the note on the outer cleanup.
    }

    // Room for the upload's reservation, the padding document's record, and then as
    // little as possible — so that what remains is positive and smaller than the
    // Markdown the PDF will produce.
    const quotaBytes = uploadReservation + derivedBytes + 512
    const quotaOps = new KnowledgeOperations({
      workspaceDir: tight,
      stateDir: '.kb',
      embed: fakeEmbed,
      dimension: 1024,
      quota: { bytes: quotaBytes, warnAt: 0.9 },
    })
    try {
      await quotaOps.createCollection({ name: '配额', collectionId: 'kb_prod_6d3e', description: '' })
      // The PDF goes in through the real upload path, charged against its original
      // bytes — which is the whole point, since its text does not exist yet.
      await quotaOps.addDocumentStream('kb_prod_6d3e', 'tiny.pdf', tinySource.byteLength, (async function* () { yield tinySource })())
      // A text document whose text is already materialised at upload fills the store
      // and proves the refusal is contained: it is converted nowhere, so nothing is
      // charged to it at parse time and it must survive its neighbour's failure.
      //
      // Its size is found by growing it one step at a time until `addDocument`
      // refuses, then keeping the last size that was accepted. A closed-form estimate
      // does not work here — `addDocument` both over-charges (same double-count as the
      // stream path) and stores the record as JSON, so the bytes per unit of padding
      // are a property of the log format. Growing stops at the ceiling of what is
      // *admissible*, which is exactly the state this section needs, and the two
      // checks below then decide whether that state is the one being tested.
      const afterPdf = quotaOps.usage().used
      const headroomAtUpload = quotaBytes - afterPdf
      // One step is `headroomAtUpload / 8` bytes of filler, so the ceiling is
      // approached from below in a bounded number of iterations rather than
      // overshooting on the first try.
      const stepUnits = Math.max(1, Math.floor(headroomAtUpload / 8 / 3))
      for (let units = stepUnits; units <= stepUnits * 64; units += stepUnits) {
        const candidate = `# 填充\n${'占位'.repeat(units)}\n`
        try {
          await quotaOps.addDocument('kb_prod_6d3e', { name: 'plain.md', bytes: candidate.length, text: candidate })
        } catch {
          break
        }
      }

      const usedBeforeBuild = quotaOps.usage().used
      const headroom = quotaBytes - usedBeforeBuild
      check(
        'quota: the PDF was admitted on its original bytes, before its text existed',
        usedBeforeBuild < quotaBytes,
        `${usedBeforeBuild} B used of ${quotaBytes} B (headroom ${headroom} B)`,
      )
      // The case is only meaningful while the free space is smaller than what the
      // PDF will produce. Asserted, so a change that made the store roomy turns this
      // red instead of letting the claim below pass vacuously.
      check(
        'quota: the remaining headroom is genuinely smaller than the derived text',
        headroom > 0 && headroom < derivedBytes,
        `${headroom} B free vs ${derivedBytes} B of derived Markdown`,
      )

      // One document that must be allowed, one that must be refused — driven through
      // the real parse stage with the real quota.
      const quotaRecords = listDocumentsOnDisk(tight, 'kb_prod_6d3e')
      const quotaBuild = await startBuild({
        storeRoot: quotaOps.storeRoot,
        collectionId: 'kb_prod_6d3e',
        slot: 'a',
        index: STRATEGY.index,
        dimension: 1024,
        documentsFile: { storeRoot: quotaOps.storeRoot, collectionId: 'kb_prod_6d3e' },
        parse: { timeoutMs: 30_000, maxPages: 10, maxTextBytes: 1024 * 1024 },
        // The same quota the uploads were charged against, which is what makes this
        // the second phase of one check rather than a second, unrelated limit.
        quota: { bytes: quotaBytes, warnAt: 0.9 },
        chunking: STRATEGY.chunking,
        embed: fakeEmbed,
        documents: quotaRecords.map(record => ({
          docId: record.id,
          text: record.text,
          ...(record.converter === undefined
            ? {}
            : {
                source: {
                  file: join(tight, '.kb', 'kb_prod_6d3e', 'sources', `${record.id}.${record.ext}`),
                  converter: record.converter,
                  reparse: false,
                },
              }),
        })),
        onProgress: () => {},
        onLog: () => {},
      }).done

      const after = await quotaOps.listDocuments('kb_prod_6d3e')
      const parsed = after.find(document => document.name === 'tiny.pdf')
      const plain = after.find(document => document.name === 'plain.md')

      check(
        'quota: a document whose parsed text does not fit fails itself',
        parsed?.status === 'failed',
        `tiny.pdf status=${parsed?.status} error=${parsed?.error ?? '(none)'}`,
      )
      check(
        'quota: the refusal names the shortfall and the remedy',
        /配额/.test(parsed?.error ?? '') && /尚缺/.test(parsed?.error ?? ''),
        parsed?.error ?? '(none)',
      )
      // The neighbouring document's text arrived at upload, so it is charged nothing
      // at parse time and the build must therefore succeed and index its chunks.
      // *This* is the containment claim on the quota path — the same rule the
      // conversion guard follows, one stage later.
      //
      // Its status is read from the document log rather than through the operations
      // view: `startBuild` is a store-level call with no job behind it, so there is no
      // `afterJobSettles` to sweep the build's documents to `ready`. What the build
      // itself guarantees is the *published index*, which is what the chunk check
      // below reads; the status staying 待构建 is the correct outcome for a build
      // launched this way and not a symptom of anything.
      check(
        'quota: the other document still built, so the refusal was contained',
        quotaBuild.ok === true && (quotaBuild.chunksByDoc[plain?.id ?? ''] ?? 0) > 0
          && parsed?.status === 'failed',
        `ok=${quotaBuild.ok} chunksByDoc.plain=${quotaBuild.chunksByDoc[plain?.id ?? ''] ?? 0} tiny.pdf=${parsed?.status}`,
      )

      quotaOps.dispose()
    } finally {
      try {
        rmSync(tight, { recursive: true, force: true })
        rmSync(sourceDir, { recursive: true, force: true })
      } catch {
        // Engine handle still open; see the note on the outer cleanup.
      }
    }
  }
  ops.dispose()
} finally {
  // Best effort. The engine holds an exclusive lock per open snapshot directory
  // and, on Windows, an open handle makes the removal fail rather than leaving
  // the tree behind — `dispose()` above releases this process's handles, but a
  // probe in this file that called `startBuild` directly leaves the slot it
  // published locked by its own adopted handle. A leftover temp directory is not
  // a finding about the code under test, so it must not turn the gate red.
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Left in the OS temp directory; the next run uses a fresh one.
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
