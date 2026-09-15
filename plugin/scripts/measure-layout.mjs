/**
 * Measure the rendered layout of the two-column pages at several viewport widths.
 *
 * This is the check that answers the reported complaint — "the pages only occupy
 * half the screen" — with a number instead of an opinion. It renders the fixtures
 * built by `render-layout-check.mjs` in headless Chrome and reads the geometry the
 * browser actually computed.
 *
 * Usage: node scripts/measure-layout.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'tmp', 'layout-check')

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean)
const chrome = CANDIDATES.find(path => existsSync(path))

if (chrome === undefined) {
  console.log('Chrome not found; skipping the rendered-layout measurement.')
  console.log('Set CHROME_PATH to run it.')
  process.exit(0)
}

/** Widths representing a laptop, the design's 1440 artboard, and a wide display. */
const WIDTHS = [1280, 1440, 1920]

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - criterion.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

/**
 * Measure one fixture at one width.
 * @param file - fixture file name.
 * @param width - viewport width in CSS pixels.
 * @returns the page width, track widths and declared max-width.
 */
function measure(file, width) {
  const path = join(DIR, file)
  const uri = `file:///${path.replace(/\\/g, '/')}`
  const dom = execFileSync(chrome, [
    // The new headless mode: `--headless` alone resolves to the legacy path, which
    // rejects the dump-dom target combination used here.
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=3000',
    // A single argument: passing `--window-size` and its value separately makes
    // Chrome treat the value as a second target and refuse to run.
    `--window-size=${width},1000`,
    '--dump-dom', uri,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

  const title = /<title>MEASURE ([^<]*)<\/title>/.exec(dom)?.[1]
  if (title === undefined) throw new Error(`${file} @ ${width}: measurement did not run`)

  const num = label => {
    const m = new RegExp(`${label}\\s*=\\s*([\\d.]+)`).exec(title)
    return m === null ? null : Number(m[1])
  }
  const tracks = /track widths=\s*([^|]+)/.exec(title)?.[1]?.trim() ?? ''
  const trackCount = Number(/columns\s*=\s*(\d+)/.exec(title)?.[1] ?? '0')

  return {
    pageWidth: num('page width'),
    maxWidth: /max-width=\s*([^|]+)/.exec(title)?.[1]?.trim() ?? '',
    tracks,
    trackCount,
  }
}

console.log('\n--- rendered layout ---\n')

for (const page of ['build', 'retrieval']) {
  for (const width of WIDTHS) {
    const result = measure(`${page}.html`, width)
    // The host's main column is narrower than the viewport: the sidebar (240px) and
    // the panel padding (24px each side) are the frame this page is given.
    const available = width - 240 - 48
    const fill = result.pageWidth / available

    console.log(
      `${page.padEnd(10)} @${String(width).padStart(4)}  `
      + `page=${String(result.pageWidth).padStart(4)}px  `
      + `of ${String(available).padStart(4)}px available (${(fill * 100).toFixed(0)}%)  `
      + `tracks=${result.trackCount} [${result.tracks}]`,
    )

    // The reported bug: the page occupied roughly half its space. Once the page
    // reaches its declared max-width, filling less than the available column is
    // correct behaviour (the cap is doing its job on a very wide display) — so the
    // assertion is "no longer capped at the old 880px", which is the actual defect.
    const maxWidthPx = Number.parseFloat(result.maxWidth) || Number.POSITIVE_INFINITY
    check(
      `${page} @${width}: not capped at the old 880px content width`,
      maxWidthPx > 880,
      `max-width=${result.maxWidth}`,
    )
    check(
      `${page} @${width}: the page uses the width it is given`,
      fill >= 0.8 || result.pageWidth >= maxWidthPx,
      `${(fill * 100).toFixed(0)}% of the available main column`,
    )

    if (width >= 1440) {
      check(
        `${page} @${width}: exactly two columns are side by side`,
        result.trackCount === 2,
        `${result.trackCount} track(s): ${result.tracks}`,
      )
      // Each column must be materially wide, not a collapsed remnant: a phantom
      // track is how `auto-fit` silently narrows the two real columns.
      const widths = result.tracks.split('/').map(part => Number.parseFloat(part) || 0)
      check(
        `${page} @${width}: both columns have real width`,
        widths.length >= 2 && widths.every(w => w > 200),
        `track widths: ${result.tracks}`,
      )
    }
  }
}

console.log('')
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
console.log(`\nRendered layout check: ${passes.length} passed, ${failures.length} failed\n`)

if (failures.length > 0) process.exit(1)
