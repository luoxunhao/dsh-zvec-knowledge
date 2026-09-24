/**
 * Dispatch-2 probe 5: text-node and span placeholder shapes.
 * Usage: node scripts/probe-docx-image-text.mjs <variant>   5|6
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'

const variant = process.argv[2]
const buffer = () => readFileSync('src/store/parse/fixtures/docx-withimage.docx')
const tag = (tagName, attributes = {}, fresh = true) => ({ tagName, attributes, fresh, separator: undefined })

const variants = {
  // 5: bare text node spliced into the paragraph.
  '5': () => [{ type: 'text', value: '[图片]' }],
  // 6: span wrapping the placeholder text.
  '6': () => [{ type: 'element', tag: tag('span'), children: [{ type: 'text', value: '[图片]' }] }],
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
