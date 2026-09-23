/**
 * Step 8 bake-off, our side: run `convertPdf` over the four real Chinese PDFs
 * and record the numbers the acceptance criteria are computed from.
 *
 * **The four inputs are not committed.** Their redistribution license is
 * unverified, so they stay on the machine that has them; their paths are read
 * from an input list (see `README.md`). Everything this script *produces* is
 * written to the bake-off output directory for review.
 *
 * Usage: node scripts/parse-bakeoff/ours.mjs [inputList] [outputDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', '..')

const INPUTS = process.argv[2] ?? join(PLUGIN, '..', '.workbuddy', 'tmp', 'bakeoff-inputs.txt')
const OUT = process.argv[3] ?? join(PLUGIN, '..', '.workbuddy', 'tmp')

// Imported by absolute URL: this script lives outside the compiled output, so a
// bare relative specifier would resolve against the script's own directory.
const { convertPdf } = await import(pathToFileURL(join(PLUGIN, 'lib', 'store', 'parse', 'pdf.js')).href)

/**
 * Count Han characters.
 *
 * The coverage criterion is about body text surviving, so the count is of
 * Chinese characters specifically: Latin runs, digits and punctuation would
 * otherwise mask a document whose Chinese was dropped.
 * @param text - the converted Markdown.
 * @returns the number of Han characters.
 */
const hanzi = text => (text.match(/\p{Script=Han}/gu) ?? []).length

/**
 * Count ATX heading lines.
 *
 * Inline emphasis is stripped first so the count is comparable with a converter
 * that wraps headings in `**bold**`: `# **Title**` and `# Title` are the same
 * heading, and counting them differently would flatter whichever converter
 * happened to omit the emphasis. The other side of the comparison applies the
 * same rule.
 * @param text - the converted Markdown.
 * @returns the heading count.
 */
const headings = text => {
  const stripped = text.replace(/\*\*/g, '')
  return (stripped.match(/(?:^|\n)#{1,6} \S/g) ?? []).length
}

/**
 * Page range for the comparison, applied to both sides.
 *
 * The 11 MB book costs ~5 s per 20 pages in the Python baseline, so running it
 * whole on both sides would make the comparison about patience rather than about
 * text. 20 pages is what the baseline numbers were measured on, so the same
 * bound is used here to keep the two sides comparable.
 */
const PAGE_RANGE = Number(process.env.BAKEOFF_PAGES ?? 20)

const opts = { timeoutMs: 600_000, maxTextBytes: 64 * 1024 * 1024, maxPages: PAGE_RANGE }
const rows = []

mkdirSync(OUT, { recursive: true })

for (const line of readFileSync(INPUTS, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  // The input list may carry CRLF; a trailing \r would become part of the path.
  const [name, rawFile] = line.replace(/\r$/, '').split('\t')
  const file = (rawFile ?? '').replace(/\r$/, '')
  const started = Date.now()
  const r = await convertPdf(file, opts)
  const row = {
    name,
    pages: PAGE_RANGE,
    ms: Date.now() - started,
    chars: r.text.length,
    hanzi: hanzi(r.text),
    headings: headings(r.text),
    structure: r.structure,
    tagged: r.tagged === true,
    truncated: r.truncated,
    failed: r.failed === true,
    error: r.error ?? null,
  }
  rows.push(row)
  writeFileSync(join(OUT, `bakeoff-ours-${basename(name, '.pdf')}.md`), r.text)
  console.log(JSON.stringify(row))
}

writeFileSync(join(OUT, 'bakeoff-ours.json'), JSON.stringify(rows, null, 2))
console.log(`\nwrote ${join(OUT, 'bakeoff-ours.json')}`)
