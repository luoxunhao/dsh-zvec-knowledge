/**
 * Dispatch-2 probe 3: convertImage variants in isolation (each in a subprocess-safe form).
 * Usage: node scripts/probe-docx-image-variant.mjs <variant>   where variant is 1|2|3
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'

const variant = process.argv[2]
const buffer = () => readFileSync('src/store/parse/fixtures/docx-withimage.docx')

const variants = {
  // A: the dispatch's literal words — empty src.
  '1': () => ({ src: '' }),
  // B: empty src + alt-ish text child (img with a text child).
  '2': () => ({ tagName: 'img', attributes: { src: '' }, children: [{ type: 'text', value: '[图片]' }] }),
  // C: a span placeholder carrying text instead of an img at all.
  '3': () => ({ tagName: 'span', children: [{ type: 'text', value: '[图片]' }] }),
}

const result = await mammoth.convertToHtml({ buffer: buffer() }, {
  styleMap: ['p.Heading1 => h1:fresh'],
  includeDefaultStyleMap: false,
  includeEmbeddedStyleMap: false,
  convertImage: variants[variant],
})
const headings = [...result.value.matchAll(/<h(\d)>(.*?)<\/h\1>/g)].map(m => `h${m[1]}:${m[2]}`)
console.log(`variant ${variant}:`)
console.log('  html:', JSON.stringify(result.value))
console.log('  headings:', headings.join(', ') || '(none)')
console.log('  messages:', result.messages.length ? JSON.stringify(result.messages.map(m => m.message)) : '(none)')
console.log('  base64:', result.value.includes('data:image/'))
