/**
 * Generate the tabular fixtures (XLSX/CSV/JSON) the parse gate runs against.
 *
 * `read-excel-file` is read-only, so the XLSX fixture is a hand-authored OOXML
 * package written with `jszip` — the same approach as the DOCX fixtures. The
 * format's minimum is `[Content_Types].xml`, one relationship part per sheet
 * plus the workbook, `xl/workbook.xml` naming the sheets, and one
 * `xl/worksheets/sheetN.xml` per sheet holding the cells as inline strings
 * (`t="inlineStr"`), which avoids building a shared-strings table.
 *
 * Everything here is authored by this repository, so the fixtures are committed
 * without a license question.
 *
 * Usage: node scripts/gen-tabular-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import JSZip from 'jszip'

const OUT = 'src/store/parse/fixtures'
mkdirSync(OUT, { recursive: true })

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`

/** Column letters for the first few columns; fixtures never exceed three. */
const COLS = ['A', 'B', 'C']

/**
 * One worksheet's XML from rows of plain strings.
 * @param {string[][]} rows - the cells, header row first.
 * @returns the sheet XML.
 */
function sheetXml(rows) {
  const body = rows
    .map((row, r) =>
      '<row r="' + (r + 1) + '">' +
      row.map((cell, c) =>
        '<c r="' + COLS[c] + (r + 1) + '" t="inlineStr"><is><t>' +
        String(cell).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</t></is></c>').join('') +
      '</row>')
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

/** Two-sheet workbook: the multi-sheet case the converter must anchor per sheet. */
async function buildXlsx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CT)
  zip.folder('_rels')?.file('.rels', RELS)
  zip.folder('xl')?.file('workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="设备清单" sheetId="1" r:id="rId1"/><sheet name="维保记录" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  zip.folder('xl')?.folder('_rels')?.file('workbook.xml.rels', WB_RELS)
  const ws = zip.folder('xl')?.folder('worksheets')
  ws?.file('sheet1.xml', sheetXml([
    ['设备名称', '型号', '数量'],
    ['传感器', 'X100', '12'],
    ['网关', 'G200', '3'],
  ]))
  ws?.file('sheet2.xml', sheetXml([
    ['日期', '内容'],
    ['2026-01-05', '更换滤芯'],
  ]))
  writeFileSync(`${OUT}/sample.xlsx`, await zip.generateAsync({ type: 'nodebuffer' }))
}

/** CSVs: the quoting traps plus the empty file the converter must refuse. */
function buildCsv() {
  writeFileSync(`${OUT}/sample.csv`,
    '名称,说明\n"带|竖线","多行\n说明"\n"普通","值"\n')
  writeFileSync(`${OUT}/crlf.csv`, 'a,b\r\n1,2\r\n')
  writeFileSync(`${OUT}/empty.csv`, '')
}

/** JSONs: fence case, walk case, invalid case. */
function buildJson() {
  writeFileSync(`${OUT}/small.json`, JSON.stringify({ 名称: '测试', 数量: 3 }))
  const big = JSON.stringify(Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`章节${i}`, { 描述: `第${i}章的内容`, 序号: i }])),
  )
  writeFileSync(`${OUT}/big.json`, big)
  writeFileSync(`${OUT}/bad.json`, '{not json')
  writeFileSync(`${OUT}/null.json`, 'null')
}

await buildXlsx()
buildCsv()
buildJson()
console.log('tabular fixtures written to', OUT)
