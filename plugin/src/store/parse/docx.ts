/**
 * DOCX → Markdown, via mammoth's HTML and the shared HTML→Markdown trunk.
 *
 * The one thing that is not obvious: **the risk is the style ID, not the display
 * language.** A Chinese Word writes `w:styleId="Heading1"` with `w:name="标题 1"`,
 * and mammoth's default map matches `p.Heading1` first, so it converts correctly —
 * measured on the committed `docx-zh.docx`. What silently loses every heading is a
 * non-Word generator that writes `w:styleId="1"` with a non-English name — also
 * measured, and the only visible signal is a warning in `result.messages`.
 *
 * So the map is derived rather than hardcoded: read `word/styles.xml`, take the
 * level from `w:outlineLvl` when present (mammoth ignores it entirely) and from
 * the name pattern otherwise, then emit the entry. Two syntax traps decide the
 * selector form, and both fail silently: `p.<styleId>` needs a legal CSS
 * identifier (`p.1 => h1` is rejected and the entry **dropped**), while
 * `p[style-name=…]` accepts single quotes only.
 *
 * Default map entries are turned off rather than layered on: measured precedence
 * between custom and default entries is inconsistent, and a derived map was
 * verified to cover the same headings on a real Word-produced file.
 *
 * Images are dropped by shape rather than filtered downstream: mammoth's own
 * default inlines base64, which would put megabytes of opaque text into the
 * indexed document. `mammoth.images.imgElement(() => ({src: '', alt}))` yields
 * `<img src="" alt="…">` — the placeholder survives, the payload does not.
 *
 * **`result.messages` are verdict-relevant, not noise.** A style warning is the
 * only signal that a heading was lost, so any of the two known texts caps the
 * result below `structured`: text that claims a structure a warning disproves is
 * exactly the provenance lie the `structure` field exists to prevent.
 *
 * @module dsh-zvec-knowledge/store/parse/docx
 */

import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { convertHtmlText } from './html.ts'
import type { ParseOptions, ParseResult } from './pdf.ts'

/**
 * Style names treated as headings, with their level. The list is a product
 * decision, not a parser decision, so it lives here where a deployment can see
 * it; it covers Simplified/Traditional Chinese, English, and Japanese.
 */
const NAME_PATTERNS = [/(?:标题|標題|heading|見出し|见出し)\s*([1-6])/i]

/** A styleId that can legally appear in mammoth's `p.<styleId>` selector form. */
const CSS_IDENTIFIER = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\-\u0080-\uFFFF]*$/

/**
 * Decode the XML entities `w:name` values commonly carry, so a name comparison
 * or an attribute selector matches the style the document actually declares.
 * `&amp;` is decoded last so double escapes do not re-interpret.
 */
function decodeEntities(name: string): string {
  return name
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x?[0-9a-fA-F]+;/g, ' ').replace(/&amp;/g, '&')
}

/** Escape a value for use inside mammoth's single-quoted attribute selector. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;')
}

/**
 * Derive mammoth style-map entries from the document's own styles.
 *
 * Level comes from `w:outlineLvl` when the style carries one — mammoth never
 * reads that attribute, so this is the only route by which an outline-marked
 * custom style keeps its heading. Otherwise the level is recovered from the
 * style's name via {@link NAME_PATTERNS}.
 * @param stylesXml - the raw text of `word/styles.xml`.
 * @returns one `selector => target` entry per heading-ish style.
 */
function deriveEntries(stylesXml: string): string[] {
  const entries: string[] = []
  const styleRe = /<w:style\b[^>]*w:type="paragraph"[^>]*>([\s\S]*?)<\/w:style>/g
  for (const match of stylesXml.matchAll(styleRe)) {
    const body = match[1] ?? ''
    const styleId = body.match(/w:styleId="([^"]*)"/)?.[1] ?? ''
    const name = decodeEntities(body.match(/<w:name w:val="([^"]*)"/)?.[1] ?? '')
    if (styleId === '' && name === '') continue

    let level: string | undefined
    const outline = body.match(/<w:outlineLvl w:val="([0-5])"\s*\/>/)
    if (outline !== null) {
      // `w:outlineLvl` is zero-based: level 0 is the document's top heading.
      level = String(Number(outline[1]) + 1)
    } else {
      level = name.match(NAME_PATTERNS[0] as RegExp)?.[1]
    }
    if (level === undefined) continue

    if (CSS_IDENTIFIER.test(styleId)) {
      entries.push(`p.${styleId} => h${level}:fresh`)
    } else if (name !== '') {
      entries.push(`p[style-name='${escapeAttr(name)}'] => h${level}:fresh`)
    }
    // A style with neither a CSS-legal id nor a name cannot be addressed at all;
    // its headings are unrecoverable and surface as a mammoth warning below.
  }
  return entries
}

/**
 * Convert one DOCX to HTML with the derived style map.
 * @param file - path of the stored original.
 * @returns the HTML mammoth produced, plus its warnings.
 */
async function mammothToHtml(
  file: string,
): Promise<{ html: string, warnings: string[] }> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const styleMap = deriveEntries(stylesXml)

  const result = await mammoth.convertToHtml(
    { buffer: readFileSync(file) },
    {
      styleMap,
      // Both off: the default map's precedence over custom entries measured
      // inconsistent, and the derived map was verified to cover everything the
      // default one does on a real Word-produced file.
      includeDefaultStyleMap: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async (image) => ({
        // mammoth's `Image` carries no alt text (only content type and readers),
        // so the placeholder is fixed rather than derived. An empty src with a
        // present alt keeps the image's position visible in the product without
        // inlining the payload.
        src: '',
        alt: '图片',
      })),
    },
  )
  return {
    html: result.value,
    warnings: result.messages.map((message) => message.message),
  }
}

/** A style warning that means a heading was silently lost. */
const LOST_STYLE = /Unrecognised paragraph style|Did not understand this style mapping/

/** {@link convertDocx} */
export async function convertDocx(
  file: string,
  opts: ParseOptions,
): Promise<ParseResult> {
  const started = Date.now()
  // The absolute-deadline form, matching `convertHtml`/`convertPdf`: the
  // elapsed-time form compares `0 > 0` under a zero ceiling and reports a
  // successful conversion of a document that was never given any time.
  const deadline = started + opts.timeoutMs
  try {
    if (opts.signal?.aborted) return empty('已取消')

    const { html, warnings } = await mammothToHtml(file)

    if (opts.signal?.aborted) return empty('已取消')

    // The trunk owns every verdict except this one: it cannot know that a
    // warning meant a heading was lost, and a `structured` verdict on text
    // whose headings the converter dropped is the provenance lie the
    // `structure` field exists to prevent.
    const result = await convertHtmlText(html, opts, 'DOCX', started, deadline)
    const lostStyle = warnings.some((warning) => LOST_STYLE.test(warning))
    if (result.failed && result.text === '') return result
    if (lostStyle && result.structure === 'structured') {
      return { ...result, structure: 'inferred' }
    }
    return result
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return empty('已取消')
    }
    const message = error instanceof Error ? error.message : String(error)
    // A corrupt package (the zip-bomb fixture, or a truncated upload) lands
    // here: mammoth throws rather than warning, and the honest answer is a
    // failed verdict naming the format, not an exception that would fail the
    // whole build.
    return {
      text: '',
      structure: 'flat-text',
      truncated: false,
      failed: true,
      error: `DOCX 解析失败：${message}`,
    }
  }
}

/**
 * An empty, failed product. Kept in step with the other converters.
 * @param reason - why the conversion produced nothing.
 * @returns the failed result.
 */
function empty(reason: string): ParseResult {
  return {
    text: '',
    structure: 'flat-text',
    truncated: false,
    failed: true,
    error: reason,
  }
}
