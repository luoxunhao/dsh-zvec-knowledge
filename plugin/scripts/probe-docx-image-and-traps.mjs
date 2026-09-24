/**
 * Dispatch-2 probe 2: convertImage shapes + the two selector syntax traps.
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'

const img = () => readFileSync('src/store/parse/fixtures/docx-withimage.docx')
const nonstd = () => readFileSync('src/store/parse/fixtures/docx-nonstd.docx')

// 1. What does convertImage returning {src: ''} produce?
{
  const r = await mammoth.convertToHtml({ buffer: img() }, {
    styleMap: ['p.Heading1 => h1:fresh'],
    includeDefaultStyleMap: false,
    includeEmbeddedStyleMap: false,
    convertImage: () => ({ src: '' }),
  })
  console.log('--- convertImage {src:""}')
  console.log('  html:', JSON.stringify(r.value))
  console.log('  messages:', JSON.stringify(r.messages.map(m => m.message)))
}

// 2. Can convertImage emit a text element instead of an img?
{
  let seen
  const r = await mammoth.convertToHtml({ buffer: img() }, {
    styleMap: ['p.Heading1 => h1:fresh'],
    includeDefaultStyleMap: false,
    includeEmbeddedStyleMap: false,
    convertImage: (image) => {
      seen = Object.keys(image)
      return { tagName: 'span', children: [{ tagName: 'text', value: '[图片]' }] }
    },
  })
  console.log('--- convertImage span+text child; image keys:', JSON.stringify(seen))
  console.log('  html:', JSON.stringify(r.value))
  console.log('  messages:', JSON.stringify(r.messages.map(m => m.message)))
}

// 3. Trap A: p.1 => h1 — a numeric styleId after a dot. Claimed: silently dropped.
{
  const r = await mammoth.convertToHtml({ buffer: nonstd() }, {
    styleMap: ['p.1 => h1:fresh', "p[style-name='标题 1'] => h1:fresh"],
    includeDefaultStyleMap: false,
    includeEmbeddedStyleMap: false,
  })
  const headings = [...r.value.matchAll(/<h(\d)>/g)].length
  console.log('--- trap A: p.1 in the map (plus a working fallback)')
  console.log('  headings found:', headings, ' html:', JSON.stringify(r.value.slice(0, 120)))
  console.log('  messages:', JSON.stringify(r.messages.map(m => m.message)))
}

// 4. Trap B: p[style-name="标题 1"] with DOUBLE quotes. Claimed: rejected/dropped.
{
  const r = await mammoth.convertToHtml({ buffer: nonstd() }, {
    styleMap: ['p[style-name="标题 1"] => h1:fresh'],
    includeDefaultStyleMap: false,
    includeEmbeddedStyleMap: false,
  })
  const headings = [...r.value.matchAll(/<h(\d)>/g)].length
  console.log('--- trap B: double-quoted style-name selector')
  console.log('  headings found:', headings, ' html:', JSON.stringify(r.value.slice(0, 120)))
  console.log('  messages:', JSON.stringify(r.messages.map(m => m.message)))
}

// 5. Control: single-quoted attribute selector with a DOUBLE-quoted doc name —
//    i.e. a style whose w:name itself contains an apostrophe (escape direction).
{
  const r = await mammoth.convertToHtml({ buffer: nonstd() }, {
    styleMap: ["p[style-name='标题 1'] => h1:fresh"],
    includeDefaultStyleMap: false,
    includeEmbeddedStyleMap: false,
  })
  const headings = [...r.value.matchAll(/<h(\d)>/g)].length
  console.log('--- control: single-quoted selector works')
  console.log('  headings found:', headings)
  console.log('  messages:', JSON.stringify(r.messages.map(m => m.message)))
}
