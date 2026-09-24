/**
 * Generate the PDF fixtures the parse gate runs against.
 *
 * **Why these exist.** The gate has to distinguish "the converter is broken"
 * from "the input was never loadable". A fixture the engine cannot read at all
 * makes those two look identical — the research notes record exactly that trap:
 * a hand-written Type0 fixture produced no text even for its own Latin control
 * group, so nothing could be concluded from it. Hence one Latin control fixture
 * whose only job is to prove the extraction chain is alive, and whose failure
 * means the parser or its worker configuration is wrong, not the fixture.
 *
 * **Why the Chinese text needs an embedded font.** `pdf-lib`'s `StandardFonts`
 * carry no CJK glyphs. The briefed route — fontkit + a Noto Sans SC *subset* —
 * does not work: measured, fontkit's TTF subsetter (2.0.4 and 1.8.1 alike) emits
 * a subset with `head, hhea, loca, maxp, glyf, hmtx` and **no `cmap`**, and
 * `pdf-lib` refuses it with `Error: Unknown font format` from `fontkit.create`
 * inside `CustomFontSubsetEmbedder`. So the full font is embedded instead. The
 * consequence is size: each CJK fixture carries its own ~11 MB copy of the font.
 * That is the price of a fixture that regenerates deterministically from a clean
 * checkout, which is worth more here than the bytes.
 *
 * The font is **not** committed to this repository; see `fixtures/SOURCES.md`
 * for where it comes from and why. Its license (OFL-1.1) is what permits even
 * the generated PDFs to be committed, since OFL states that the requirement for
 * fonts to remain under the license "does not apply to any document created
 * using the Font Software".
 *
 * Usage: node scripts/gen-parse-fixtures.mjs
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkit from 'fontkit'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'store', 'parse', 'fixtures')

/**
 * Where the CJK font is looked up, in order.
 *
 * The repository does not carry a 17.7 MB font for a test fixture, so the
 * generator reads one from the machine. Recorded in `SOURCES.md` so the
 * requirement is discoverable rather than implied by a failing script.
 */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/NotoSansSC-VF.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
]

/** Resolve the CJK font, or explain exactly what to install. */
function loadFont() {
  for (const path of FONT_CANDIDATES) {
    if (!existsSync(path)) continue
    // fontkit 1.8.1 rejects a plain Uint8Array view but accepts a Buffer of the
    // same bytes, and pdf-lib needs an object fontkit can already open.
    const buffer = readFileSync(path)
    const font = fontkit.create(buffer)
    return { path, buffer, font }
  }
  throw new Error(
    `未找到可用的中文字体，已尝试：\n  ${FONT_CANDIDATES.join('\n  ')}\n` +
      '请安装 Noto Sans SC（OFL-1.1），或修改本脚本的 FONT_CANDIDATES。',
  )
}

const { path: fontPath, buffer: fontBytes } = loadFont()
console.log(`font: ${fontPath}`)

mkdirSync(OUT, { recursive: true })

/**
 * Build one document with the shared boilerplate.
 *
 * The CJK font is only embedded when a fixture actually draws Chinese. pdf-lib
 * writes the entire 11 MB font into every document that references it, so
 * embedding it in `latin.pdf` or `opaque.pdf` would add 22 MB to the repository
 * for fixtures that use no CJK glyph at all.
 * @param build - receives the document and a font resolver.
 * @param needsCjk - whether this fixture draws Chinese text.
 */
async function make(build, needsCjk) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const latin = await doc.embedFont(StandardFonts.Helvetica)
  const cjk = needsCjk ? await doc.embedFont(fontBytes, { subset: false }) : latin
  await build(doc, cjk, latin)
  return doc
}

/** Heading/body sizes. The converter must recover the split by inference alone. */
const H1 = 24
const H2 = 17
const BODY = 11

// ---------------------------------------------------------------------------
// 1. latin.pdf — the control. If the engine returns nothing for this, the
//    chain is broken and no conclusion may be drawn about the CJK fixtures.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, _cjk, latin) => {
    const page = doc.addPage([420, 300])
    page.drawText('Latin Control', { x: 40, y: 250, size: H1, font: latin })
    page.drawText('Section One', { x: 40, y: 210, size: H2, font: latin })
    page.drawText('A body paragraph in plain ASCII.', { x: 40, y: 180, size: BODY, font: latin })
  }, false)
  writeFileSync(join(OUT, 'latin.pdf'), await doc.save())
  console.log('wrote latin.pdf')
}

// ---------------------------------------------------------------------------
// 2. simple.pdf — page 1 of the brief's CJK set: single column, two heading
//    levels by size, body paragraphs.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, cjk) => {
    const page = doc.addPage([420, 320])
    page.drawText('文档标题', { x: 40, y: 265, size: H1, font: cjk })
    page.drawText('第一节 概述', { x: 40, y: 220, size: H2, font: cjk })
    page.drawText('这是一段正文，用于验证段落能否被正确重建。', { x: 40, y: 190, size: BODY, font: cjk })
    page.drawText('第二行正文继续说明同一段落的内容。', { x: 40, y: 172, size: BODY, font: cjk })
    page.drawText('第二节 细节', { x: 40, y: 130, size: H2, font: cjk })
    page.drawText('细节部分同样是一段普通正文。', { x: 40, y: 100, size: BODY, font: cjk })
  }, true)
  writeFileSync(join(OUT, 'simple.pdf'), await doc.save())
  console.log('wrote simple.pdf')
}

// ---------------------------------------------------------------------------
// 3. table.pdf — a genuinely aligned table: three columns whose cells share x
//    positions across rows. The converter must rebuild it as a pipe table with
//    a separator row, because that is the only table shape `chunk.ts` reads.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, cjk) => {
    const page = doc.addPage([460, 320])
    page.drawText('参数表', { x: 40, y: 265, size: H1, font: cjk })
    const cols = [40, 180, 320]
    const rows = [
      ['名称', '类型', '说明'],
      ['超时', '整数', '单篇解析上限'],
      ['页数', '整数', '文档页数上限'],
      ['字节', '整数', '产出文本上限'],
    ]
    rows.forEach((row, r) => {
      const y = 215 - r * 26
      row.forEach((cell, c) => {
        page.drawText(cell, { x: cols[c], y, size: BODY, font: cjk })
      })
    })
  }, true)
  writeFileSync(join(OUT, 'table.pdf'), await doc.save())
  console.log('wrote table.pdf')
}

// ---------------------------------------------------------------------------
// 4. twocol.pdf — two columns on the same y band, left column drawn first.
//    Marker order therefore already reads left-then-right, so a converter that
//    merely trusted the engine's item order produces output that looks correct.
//    The gate asserts the column bands directly, because text order cannot
//    distinguish "read left then right" from "interleaved".
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, cjk) => {
    const page = doc.addPage([520, 340])
    page.drawText('双栏文档', { x: 40, y: 290, size: H1, font: cjk })
    const left = ['左栏第一段开始，', '左栏第一段继续。', '左栏第二段内容。']
    const right = ['右栏第一段开始，', '右栏第一段继续。', '右栏第二段内容。']
    left.forEach((line, i) => {
      page.drawText(line, { x: 40, y: 240 - i * 40, size: BODY, font: cjk })
    })
    right.forEach((line, i) => {
      page.drawText(line, { x: 300, y: 240 - i * 40, size: BODY, font: cjk })
    })
  }, true)
  writeFileSync(join(OUT, 'twocol.pdf'), await doc.save())
  console.log('wrote twocol.pdf')
}

// ---------------------------------------------------------------------------
// 5. opaque.pdf — a page with no text objects at all. This is what a scan looks
//    like to the converter, and it is the input that must produce an honest
//    empty result rather than a silent pass.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, _cjk) => {
    const page = doc.addPage([300, 200])
    // A drawn rectangle is content but carries no text layer.
    page.drawRectangle({ x: 40, y: 40, width: 220, height: 120, color: rgb(0.8, 0.8, 0.8) })
  }, false)
  writeFileSync(join(OUT, 'opaque.pdf'), await doc.save())
  console.log('wrote opaque.pdf')
}

// ---------------------------------------------------------------------------
// 6. scanned.pdf — the upload-time refusal's input.
//
// It is a *separate* file from `opaque.pdf`, and not a re-use of it, for two
// reasons that are about what each fixture is evidence for rather than about
// their bytes:
//
// - **Different contract.** `opaque.pdf` belongs to the converter gate, where
//   the claim is "a document with no text produces an honest empty result". It
//   is asserted through `convertPdf`, whose envelope, ceilings and failure
//   reporting are part of that claim. The preflight gate asserts the *upload*
//   refusal, which never calls the converter — so a later change to `opaque.pdf`
//   made for the converter's sake would silently change what the upload gate
//   proves.
// - **Different shape.** `opaque.pdf` is one page with a rectangle. A scan is an
//   *image* on a page, and the image is the whole point: a producer that emits
//   images emits image XObjects, which is what makes the file realistic as a
//   scanned input rather than merely text-free.
//
// The image is drawn, not embedded: pdf-lib has no raster support without a
// separate PNG/JPEG codec, and every byte of a placeholder bitmap would be
// committed weight for a fixture whose only required property is the absence of
// a text layer. The page is A4-ish because that is what a scanner produces.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, _cjk) => {
    const page = doc.addPage([595, 842])
    // "Scanned" image area, standing in for the raster a scanner would place.
    page.drawRectangle({ x: 40, y: 60, width: 515, height: 720, color: rgb(0.94, 0.94, 0.94) })
    // A scan's marginal marks: real scans carry these, and they are ink, not text.
    page.drawRectangle({ x: 52, y: 80, width: 90, height: 6, color: rgb(0.3, 0.3, 0.3) })
    page.drawRectangle({ x: 52, y: 96, width: 480, height: 6, color: rgb(0.3, 0.3, 0.3) })
    page.drawRectangle({ x: 52, y: 112, width: 300, height: 6, color: rgb(0.3, 0.3, 0.3) })
  }, false)
  writeFileSync(join(OUT, 'scanned.pdf'), await doc.save())
  console.log('wrote scanned.pdf')
}

// ---------------------------------------------------------------------------
// 7. coverpage.pdf — two pages: a text-free cover, then a page of text.
//
// This is the case that decides how many pages the preflight may sample before
// calling a document a scan, and it is not hypothetical: of eighteen real PDFs
// on this machine, two carry their first text on page 2 (`go-test.pdf` 76 pages,
// `gotips.pdf` 253 pages and 50,038 characters of converted text). A probe that
// trusts page one alone refuses both and tells the user to run OCR on a document
// with a perfect text layer.
//
// Latin only, on purpose: it is a control for *page sampling*, not for the CJK
// path, and embedding the font would cost another 11.4 MB for a fixture whose
// subject is which page gets read.
// ---------------------------------------------------------------------------
{
  const doc = await make((doc, _cjk, latin) => {
    const cover = doc.addPage([420, 300])
    cover.drawRectangle({ x: 40, y: 40, width: 340, height: 220, color: rgb(0.9, 0.9, 0.9) })
    const body = doc.addPage([420, 300])
    body.drawText('Page Two Heading', { x: 40, y: 250, size: H1, font: latin })
    body.drawText('The text of this document begins on its second page.', { x: 40, y: 210, size: BODY, font: latin })
  }, false)
  writeFileSync(join(OUT, 'coverpage.pdf'), await doc.save())
  console.log('wrote coverpage.pdf')
}

console.log(`\nfixtures written to ${OUT}`)
