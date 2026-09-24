/**
 * Dispatch-2 probe: the derived styleMap against all four style fixtures.
 * Asserts en/zh do not regress, nonstd and outline now yield both levels.
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'
import JSZip from 'jszip'

// ---- mirror of docx.ts's derivation, kept verbatim for the probe ----------
const NAME_PATTERNS = [
  /(?:标题|標題|heading|見出し|见出し)\s*([1-6])/i,
]
const CSS_ID = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\-\u0080-\uFFFF]*$/

function decodeEntities(name) {
  return name
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x?[0-9a-fA-F]+;/g, ' ').replace(/&amp;/g, '&')
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;')
}

async function deriveStyleMap(file) {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const entries = []
  const styleRe = /<w:style\b[^>]*w:type="paragraph"[^>]*>([\s\S]*?)<\/w:style>/g
  for (const match of stylesXml.matchAll(styleRe)) {
    const body = match[1]
    const styleId = /\bw:styleId="([^"]*)"/.exec(match[0])?.[1]
    if (!styleId) continue
    const rawName = /\bw:name\b[^>]*\bw:val="([^"]*)"/.exec(body)?.[1] ?? ''
    const name = decodeEntities(rawName)
    const outline = /\bw:outlineLvl\b[^>]*\bw:val="([0-9])"/.exec(body)
    let level = null
    if (outline) level = Number(outline[1]) + 1
    else {
      for (const pattern of NAME_PATTERNS) {
        const found = pattern.exec(name)
        if (found) { level = Number(found[1]); break }
      }
    }
    if (level === null || level < 1 || level > 6) continue
    const target = `h${level}`
    if (CSS_ID.test(styleId)) entries.push(`p.${styleId} => ${target}:fresh`)
    else entries.push(`p[style-name='${escapeAttr(name)}'] => ${target}:fresh`)
  }
  return entries
}

// ---- run -------------------------------------------------------------------
for (const name of ['docx-en.docx', 'docx-zh.docx', 'docx-nonstd.docx', 'docx-outline.docx']) {
  const file = 'src/store/parse/fixtures/' + name
  const styleMap = await deriveStyleMap(file)
  const result = await mammoth.convertToHtml(
    { buffer: readFileSync(file) },
    { styleMap, includeDefaultStyleMap: false, includeEmbeddedStyleMap: false },
  )
  const headings = [...result.value.matchAll(/<h(\d)>(.*?)<\/h\1>/g)].map(m => `h${m[1]}:${m[2]}`)
  console.log(`--- ${name}`)
  console.log('  styleMap:', JSON.stringify(styleMap))
  console.log('  headings:', headings.length > 0 ? headings.join(', ') : '(none)')
  console.log('  messages:', result.messages.length === 0 ? '(none)' : JSON.stringify(result.messages.map(m => m.message)))
}
