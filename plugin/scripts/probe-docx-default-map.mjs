/**
 * Dispatch-1 probe: measure what mammoth's DEFAULT map does to each fixture.
 * This is the baseline the derived styleMap (dispatch 2) must beat.
 */
import { readFileSync } from 'node:fs'
import mammoth from 'mammoth'

const fixtures = [
  'docx-en.docx',
  'docx-zh.docx',
  'docx-nonstd.docx',
  'docx-outline.docx',
  'docx-withimage.docx',
]

for (const name of fixtures) {
  const path = 'src/store/parse/fixtures/' + name
  try {
    const result = await mammoth.convertToHtml({ buffer: readFileSync(path) })
    const headings = [...result.value.matchAll(/<h(\d)>(.*?)<\/h\1>/g)].map(m => `h${m[1]}:${m[2]}`)
    const hasImage = result.value.includes('<img')
    const base64 = result.value.includes('data:image/')
    console.log(`--- ${name}`)
    console.log('  headings:', headings.length > 0 ? headings.join(', ') : '(none)')
    console.log('  img tag:', hasImage, ' base64 data URI:', base64)
    console.log('  messages:', result.messages.length === 0 ? '(none)' : JSON.stringify(result.messages.map(m => m.message)))
    console.log('  html:', JSON.stringify(result.value.slice(0, 400)))
  } catch (error) {
    console.log(`--- ${name}\n  THREW: ${error.message}`)
  }
}

// The zip bomb, separately, with a timer: the claim is "throws in bounded time".
{
  const path = 'src/store/parse/fixtures/docx-zipbomb.docx'
  const started = Date.now()
  try {
    const result = await mammoth.convertToHtml({ buffer: readFileSync(path) })
    console.log(`--- docx-zipbomb.docx\n  UNEXPECTEDLY SUCCEEDED: html length ${result.value.length}`)
  } catch (error) {
    console.log(`--- docx-zipbomb.docx\n  THREW after ${Date.now() - started}ms: ${error.message.slice(0, 200)}`)
  }
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
  console.log(`  peak RSS after bomb: ${rss} MB`)
}
