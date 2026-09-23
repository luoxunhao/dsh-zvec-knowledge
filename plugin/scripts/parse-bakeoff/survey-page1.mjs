/**
 * Real-corpus survey: how often does a document carry no text on page one?
 *
 * This is the measurement behind the preflight's page budget. The probe refuses a
 * PDF when it finds no text runs, and the cheapest possible version reads only
 * page one — sound only if "page one has no text" means "this document has no
 * text". It does not: measured over eighteen real PDFs, two (11%) open with a
 * text-free cover and carry their text from page two, so a page-one-only probe
 * refuses both and tells the user to run OCR on a document with a perfectly good
 * text layer. `PREFLIGHT_PAGES` in `store/extract.ts` is set from this
 * measurement, and the gate pins the behaviour with the committed `coverpage.pdf`
 * fixture.
 *
 * Not a gate: it needs a real corpus that cannot be committed. See `README.md`
 * for the directories it was run against.
 *
 * Usage: node scripts/parse-bakeoff/survey-page1.mjs <path>... (PDFs or directories)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Collect the PDFs named by the arguments, expanding directories. */
function collect(paths) {
  const out = []
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry.toLowerCase().endsWith('.pdf')) out.push(join(path, entry))
      }
    } else {
      out.push(path)
    }
  }
  return out
}

const unpdf = await import('unpdf')

for (const file of collect(process.argv.slice(2))) {
  const name = file.split(/[\\/]/).pop()
  let doc
  try {
    doc = await unpdf.getDocumentProxy(new Uint8Array(readFileSync(file)))
  } catch (error) {
    // A locked or corrupt file is reported and skipped rather than aborting the
    // survey: this script aggregates over a directory, and one bad file in it
    // must not cost the whole run. `encrypted.pdf` lives in the fixtures
    // directory and is exactly such a file.
    console.log(`${name.padEnd(38)} SKIPPED — ${error.name}: ${error.message}`)
    continue
  }
  let page1Runs = 0
  let anyRuns = 0
  const scanned = []
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const runs = content.items.filter(i => typeof i.str === 'string' && i.str.trim() !== '').length
      if (n === 1) page1Runs = runs
      if (runs > 0) anyRuns += 1
      if (runs === 0) scanned.push(n)
      page.cleanup()
      // Only the first 30 pages are surveyed: the question is about the *start*.
      if (n >= 30) break
    }
  } finally {
    await doc.loadingTask.destroy()
  }
  const verdict = page1Runs > 0 ? 'accept' : anyRuns > 0 ? 'REFUSED-BUT-HAS-TEXT' : 'refuse (no text anywhere)'
  console.log(
    `${name.padEnd(38)} pages=${String(doc.numPages).padStart(4)} ` +
      `page1Runs=${String(page1Runs).padStart(4)} textPagesInFirst30=${String(anyRuns).padStart(3)} ` +
      `emptyPages=${scanned.slice(0, 6).join(',') || '-'} -> ${verdict}`,
  )
}
