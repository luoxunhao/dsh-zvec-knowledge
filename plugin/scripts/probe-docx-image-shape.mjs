/**
 * Dispatch-2 probe 4: convertImage returning mammoth-AST node arrays.
 * Usage: node scripts/probe-docx-image-shape.mjs <variant>   1|2|3|4
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'

const variant = process.argv[2]
const buffer = () => readFileSync('src/store/parse/fixtures/docx-withimage.docx')

// Node shape per mammoth/lib/html/ast.js: {type:'element', tag:{tagName,
// attributes, fresh}, children} and {type:'text', value}.
const tag = (tagName, attributes = {}, fresh = true) => ({ tagName, attributes, fresh, separator: undefined })

const variants = {
  // 1: img with empty src (no children — img is void).
  '1': () => [{ type: 'element', tag: tag('img', { src: '' }), children: [] }],
  // 2: image dropped entirely.
  '2': () => [],
  // 3: a fresh paragraph placeholder carrying text.
  '3': () => [{ type: 'element', tag: tag('p'), children: [{ type: 'text', value: '[图片]' }] }],
  // 4: img with empty src AND an alt from the document.
  '4': (image) => [{ type: 'element', tag: tag('img', { src: '', alt: image.altText ?? '' }), children: [] }],
}

const result = await mammoth.convertToHtml({ buffer: buffer() }, {
  styleMap: ['p.Heading1 => h1:fresh'],
  includeDefaultStyleMap: false,
  includeEmbeddedStyleMap: false,
  convertImage: variants[variant],
})
console.log(`variant ${variant}:`)
console.log('  html:', JSON.stringify(result.value))
console.log('  messages:', result.messages.length ? JSON.stringify(result.messages.map(m => m.message)) : '(none)')
console.log('  base64:', result.value.includes('data:image/'))
