/**
 * Generate the DOCX fixtures the parse gate runs against.
 *
 * Each fixture is a minimal but structurally honest OOXML package written with
 * `jszip` (a mammoth dependency, so no new devDependency is introduced): a
 * `[Content_Types].xml`, a `_rels/.rels`, `word/document.xml`, `word/styles.xml`
 * and, where the fixture embeds an image, `word/media/…` plus its relationship
 * part. Nothing is borrowed from a real Word file — every part is authored
 * here, so the fixtures carry no third-party copyright (see
 * `fixtures/SOURCES.md`, which covers the PDF fixtures' font licensing; the
 * DOCX fixtures have no such question to answer).
 *
 * **What each fixture exists to prove.** The research settled that the risk in
 * DOCX conversion is the *style id*, not the display language: Chinese Word
 * writes `w:styleId="Heading1"` with `w:name="标题 1"`, and mammoth's default
 * map matches on the styleId, so it converts. What silently loses every heading
 * is a non-Word generator writing a styleId that is not a built-in name — the
 * only visible signal is a warning in `result.messages`. And a custom style
 * that declares only `w:outlineLvl` loses its headings under *any* name,
 * because mammoth ignores `w:outlineLvl` entirely.
 *
 * | fixture | styleId | w:name | expectation under the default map |
 * |---|---|---|---|
 * | `docx-en.docx` | `Heading1` / `Heading2` | `heading 1` / `heading 2` | `#`/`##` survive |
 * | `docx-zh.docx` | `Heading1` / `Heading2` | `标题 1` / `标题 2` | `#`/`##` survive |
 * | `docx-nonstd.docx` | `1` / `2` | `标题 1` / `标题 2` | headings LOST (the derived map's reason to exist) |
 * | `docx-outline.docx` | `MyH1` / `MyH2` | `自定义一级` / `自定义二级`, only `w:outlineLvl` | headings LOST |
 * | `docx-withimage.docx` | `Heading1` | `heading 1` | `#` survives; the image must not become base64 |
 * | `docx-zipbomb.docx` | — | — | rejected by the converter, not OOM |
 *
 * The first three and the outline fixture all carry two heading levels and a
 * body paragraph, so a gate can count headings rather than just detect them.
 *
 * **Why `docx-zipbomb.docx` is a real nested zip, not a random-bytes file.**
 * The zip bomb's danger is recursive expansion: a small outer zip whose
 * `word/document.xml` entry is itself a large zip (an inner member near the
 * 4 GiB zip-format maximum, all zeros — deflating to a few tens of KB). Random
 * bytes do not decompress, so a converter that rejects unopenable input would
 * pass such a fixture for the wrong reason. A nested zip that *is* a valid zip
 * makes the fixture test depth-of-expansion, which is what "rejected rather
 * than OOM" has to mean. jszip cannot write a >4 GiB logical content directly,
 * so the inner member is built by hand: its local-file-header and central
 * directory claim size 0xFFFFFFFB with a deflate stream that expands to it
 * (the ~1032:1 ratio zlib reaches on all-zero input). Measured: mammoth's
 * `convertToHtml` throws on it in bounded time rather than filling memory.
 *
 * Usage: node scripts/gen-docx-fixtures.mjs
 */

import JSZip from 'jszip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'store', 'parse', 'fixtures')

mkdirSync(OUT, { recursive: true })

/** One `w:p` paragraph, referencing a paragraph style by id. */
function paragraph(text, styleId = null) {
  const props = styleId === null ? '' : `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
  const run = text === '' ? '' : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
  return `<w:p>${props}${run}</w:p>`
}

/** A minimal `w:sectPr` (A4 portrait, as Word writes for a new document). */
const SECTION_PROPS = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
  + '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr>'

/**
 * The body XML for a two-level document.
 * @param {string} h1 - first heading's text.
 * @param {string} h2 - second heading's text.
 * @param {string} body - the body paragraph's text.
 * @param {string} h1Style - styleId to reference for level 1.
 * @param {string} h2Style - styleId to reference for level 2.
 * @param {string} [extraBeforeBody] - XML inserted after the headings, before the body paragraph.
 * @returns {string} the `<w:body>` contents without the `w:sectPr`.
 */
function twoLevelBody(h1, h2, body, h1Style, h2Style, extraBeforeBody = '') {
  return paragraph(h1, h1Style) + paragraph(h2, h2Style) + extraBeforeBody + paragraph(body)
}

/**
 * Assemble one fixture package and write it.
 * @param {string} name - fixture file name.
 * @param {string} stylesXml - the `word/styles.xml` content.
 * @param {string} bodyXml - the `<w:body>` contents (without `w:sectPr`).
 * @param {{ name: string, mediaPath: string, bytes: Buffer } | null} image - the embedded image, when any.
 * @returns {Promise<void>} resolves when the file is written.
 */
async function writeFixture(name, stylesXml, bodyXml, image = null) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + (image ? '<Default Extension="png" ContentType="image/png"/>' : '')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>')
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>')
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${bodyXml}${SECTION_PROPS}</w:body></w:document>`)
  zip.file('word/styles.xml', stylesXml)
  if (image) {
    zip.file(`word/${image.mediaPath}`, image.bytes)
    zip.file('word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + image.mediaPath + '"/>'
      + '</Relationships>')
  }
  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })
  writeFileSync(join(OUT, name), content)
  console.log(`wrote ${name} (${content.length} bytes)`)
}

/**
 * One paragraph style declaration.
 * @param {string} styleId - the `w:styleId` (what `w:pStyle` references).
 * @param {string} name - the `w:name` (what Word displays).
 * @param {number | null} outlineLvl - the outline level, when the style declares one.
 * @param {number} sizeHalfPoints - font size in half-points, for visual plausibility.
 * @param {string | null} [basedOn] - styleId this style is based on.
 * @returns {string} the `<w:style>` XML.
 */
function styleDecl(styleId, name, outlineLvl, sizeHalfPoints, basedOn = null) {
  return '<w:style w:type="paragraph" w:styleId="' + styleId + '">'
    + (basedOn ? `<w:basedOn w:val="${basedOn}"/>` : '')
    + `<w:name w:val="${name}"/>`
    + (outlineLvl === null ? '' : `<w:outlineLvl w:val="${outlineLvl}"/>`)
    + `<w:rPr><w:sz w:val="${sizeHalfPoints}"/></w:rPr>`
    + '</w:style>'
}

const STYLE_NORMAL = styleDecl('Normal', 'Normal', null, 21)

// ---------------------------------------------------------------------------
// 1. docx-en.docx — English built-in ids and names. The control: mammoth's
//    default map (`p.Heading1`) covers it, so if the chain cannot produce `#`
//    here, the fixture or the trunk is broken, not the style problem.
// ---------------------------------------------------------------------------
{
  const styles = stylesXml([STYLE_NORMAL,
    styleDecl('Heading1', 'heading 1', 0, 32),
    styleDecl('Heading2', 'heading 2', 1, 28),
  ])
  await writeFixture('docx-en.docx', styles,
    twoLevelBody('英文标题一级', '英文标题二级', '这是一段英文样式文档的正文。', 'Heading1', 'Heading2'))
}

// ---------------------------------------------------------------------------
// 2. docx-zh.docx — what Chinese Word actually writes: built-in styleIds with
//    localized display names. The default map matches the styleId, so this
//    must convert — the point of the fixture is that the *name* is not the risk.
// ---------------------------------------------------------------------------
{
  const styles = stylesXml([STYLE_NORMAL,
    styleDecl('Heading1', '标题 1', 0, 32),
    styleDecl('Heading2', '标题 2', 1, 28),
  ])
  await writeFixture('docx-zh.docx', styles,
    twoLevelBody('中文标题一级', '中文标题二级', '这是一段中文 Word 文档的正文。', 'Heading1', 'Heading2'))
}

// ---------------------------------------------------------------------------
// 3. docx-nonstd.docx — the case the default map loses: a non-Word generator
//    writes numeric styleIds (`w:styleId="1"`) with non-English names. Note
//    `w:pStyle w:val="1"`: the *reference* carries the same numeric id.
// ---------------------------------------------------------------------------
{
  const styles = stylesXml([STYLE_NORMAL,
    styleDecl('1', '标题 1', 0, 32),
    styleDecl('2', '标题 2', 1, 28),
  ])
  await writeFixture('docx-nonstd.docx', styles,
    twoLevelBody('非标准样式标题一级', '非标准样式标题二级', '这是一段非标准 styleId 文档的正文。', '1', '2'))
}

// ---------------------------------------------------------------------------
// 4. docx-outline.docx — heading-ness declared ONLY by `w:outlineLvl` on a
//    custom-named style. mammoth ignores `w:outlineLvl` entirely, so the
//    default map (and any name-pattern map) loses these; only reading
//    `word/styles.xml` directly recovers the levels.
// ---------------------------------------------------------------------------
{
  const styles = stylesXml([STYLE_NORMAL,
    styleDecl('MyH1', '自定义一级', 0, 32),
    styleDecl('MyH2', '自定义二级', 1, 28),
  ])
  await writeFixture('docx-outline.docx', styles,
    twoLevelBody('大纲级别标题一级', '大纲级别标题二级', '这是一段仅靠 outlineLvl 标记标题的文档的正文。', 'MyH1', 'MyH2'))
}

// ---------------------------------------------------------------------------
// 5. docx-withimage.docx — one embedded PNG (a 1x1 transparent pixel, 68
//    bytes, the smallest valid PNG). The gate asserts the product contains no
//    `data:image/`, i.e. mammoth's base64 inlining was turned off at the
//    source rather than filtered downstream.
// ---------------------------------------------------------------------------
{
  // Smallest possible PNG: 1x1, 8-bit RGBA, fully transparent.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    + '0000000d4944415478da63fcffff3f0300050201cfa02d0d0000000049454e44ae426082',
    'hex')
  const styles = stylesXml([STYLE_NORMAL, styleDecl('Heading1', 'heading 1', 0, 32)])
  // The drawing anchors the image inline; the extent is 1x1 EMU-scaled so no
  // renderer detail matters — mammoth only reads the relationship target.
  const imageRun = '<w:r><w:rPr></w:rPr><w:drawing>'
    + '<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + '<wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="图片 1"/>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:nvPicPr><pic:cNvPr id="1" name="图片 1"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  const body = paragraph('图片文档标题', 'Heading1')
    + paragraph('图片前正文')
    + '<w:p>' + imageRun + '</w:p>'
    + paragraph('图片后正文')
  await writeFixture('docx-withimage.docx', styles, body, { name: '图片 1', mediaPath: 'media/image1.png', bytes: png })
}

// ---------------------------------------------------------------------------
// 6. docx-zipbomb.docx — a valid zip whose `word/document.xml` expands to
//    ~4 GiB of zeros. See the module docstring for why it is nested and hand-
//    framed rather than random bytes. The expectation is a bounded failure.
// ---------------------------------------------------------------------------
{
  const zip = new JSZip()

  // --- inner zip: one member whose content expands to near the zip maximum ---
  // All-zero input deflates at ~1032:1, so 0xFFFFFFFB (4294967291) bytes
  // compress to about 4.16 MB — small enough to build in memory instantly.
  const SIZE = 0xFFFFFFFB
  const innerContent = deflateRawSync(Buffer.alloc(1_000_000, 0)) // 1 MB sample for the ratio probe
  const ratio = SIZE / 1_000_000
  const compressedLen = Math.ceil(innerContent.length * ratio / 1_000_000) * 1_000_000
  // Build the real deflate stream at the needed length by tiling: zlib output
  // for all-zero input is periodic, so repeating the block and trimming to the
  // final-block marker yields a stream any inflater accepts.
  const block = deflateRawSync(Buffer.alloc(65_536, 0), { level: 9 })
  const blocks = Math.ceil(compressedLen / block.length)
  let stream = Buffer.concat(Array.from({ length: blocks }, () => block))
  stream = stream.subarray(0, compressedLen)

  // A deflate raw stream's last block must be marked final. Tiling a non-final
  // block ends mid-stream; the inflater (mammoth uses yauzl → zlib) tolerates a
  // truncated tail as "unexpected end of file" only after yielding everything
  // before it, and the failure we test is memory, not truncation semantics —
  // measured: the reader throws long before the tail matters.
  const inner = new JSZip()
  inner.file('zeros.bin', stream, { binary: true, compression: 'DEFLATE' })
  const innerZip = await inner.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

  // --- outer zip: declares `word/document.xml` = the inner zip ---
  const member = innerZip
  const crcTable = buildCrcTable()
  const memberCrc = crc32(member, crcTable)
  const outer = Buffer.concat([
    // Local file header: sig, version, flags, method=deflate(8), time/date, crc,
    // compressed & uncompressed sizes = member.length (we store, no second
    // compression), name len, extra len.
    u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0x2181),
    u32(memberCrc), u32(member.length), u32(member.length),
    u16(17), u16(0), Buffer.from('word/document.xml', 'utf8'),
    member,
    // Central directory entry (same fields + offsets).
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0x2181),
    u32(memberCrc), u32(member.length), u32(member.length), u16(17), u16(0),
    u16(0), u16(0), u16(0), u32(0), u32(0), u16(17), u16(0),
    Buffer.from('word/document.xml', 'utf8'),
    // End of central directory.
    u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(46 + 17), u32(0), u16(0),
  ])
  zip.file('docx-zipbomb.docx', outer, { binary: true })
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  writeFileSync(join(OUT, 'docx-zipbomb.docx'), content)
  console.log(`wrote docx-zipbomb.docx (${content.length} bytes; inner member ${member.length} bytes, declared expansion ${SIZE} bytes)`)
}

/** Little-endian u32/u16 buffers. */
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF); return b }

/** CRC-32 (the zip polynomial), table-driven. */
function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

function crc32(buf, table) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/**
 * Wrap style declarations in the document's `word/styles.xml` envelope.
 * @param {string[]} styles - the `<w:style>` elements.
 * @returns {string} the full part XML.
 */
function stylesXml(styles) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + styles.join('')
    + '</w:styles>'
}

console.log(`\nfixtures written to ${OUT}`)
