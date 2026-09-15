/**
 * Measure whether a control overflows its container.
 *
 * Reproduces the reported symptom — an input's box extending past its container —
 * against the built stylesheet, so the diagnosis is measured rather than inferred
 * from reading CSS.
 *
 * Usage: node scripts/measure-overflow.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tmp', 'overflow-check')
mkdirSync(OUT, { recursive: true })

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const chrome = CANDIDATES.find(path => existsSync(path))

/** Pull one CSS module's emitted stylesheet out of the built bundle. */
function cssOf(bundle, file) {
  const at = bundle.indexOf(`\\${file}.mjs`)
  if (at < 0) throw new Error(`${file} not in the bundle; run the build first`)
  const end = bundle.indexOf('//#endregion', at)
  const slice = bundle.slice(at, end)
  const literal = /const css\$\d+ = "((?:[^"\\]|\\.)*)"/.exec(slice)?.[1]
  if (literal === undefined) throw new Error(`${file}: no CSS literal`)
  let css = literal.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  for (const [, key, hashed] of slice.matchAll(/"(\w+)":\s*"([A-Za-z0-9_-]+_\w+)"/g)) {
    css = css.split(hashed).join(key)
  }
  return css
}

const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const tokens = readFileSync(join(ROOT, 'src', 'client', 'styles', 'tokens.generated.css'), 'utf8')

/**
 * The plugin's global stylesheet, as the bundle actually ships it.
 *
 * Read from the bundle rather than from `src/client/styles/base.css`, because the
 * build inlines that file into a `dsh-global-css` module and the two can differ
 * while the source is being edited. Measuring a copy the app does not load is how
 * a fixture reports a fix that is not there — or misses one that is.
 * @returns the global CSS text.
 */
function globalCssFromBundle() {
  // Matched on the region header, which carries the file path. A bare
  // `dsh-global-css:` also appears in the earlier import plumbing, and landing
  // there returns the token block instead of the plugin's own stylesheet.
  const marker = 'dsh-global-css:'
  let at = -1
  for (let search = bundle.indexOf(marker); search >= 0; search = bundle.indexOf(marker, search + 1)) {
    if (bundle.slice(search, search + 400).includes('base.css')) { at = search; break }
  }
  if (at < 0) return readFileSync(join(ROOT, 'src', 'client', 'styles', 'base.css'), 'utf8')
  const end = bundle.indexOf('//#endregion', at)
  const slice = bundle.slice(at, end < 0 ? at + 6000 : end)
  const literal = /const css\$\d+ = "((?:[^"\\]|\\.)*)"/.exec(slice)?.[1]
  return literal === undefined
    ? readFileSync(join(ROOT, 'src', 'client', 'styles', 'base.css'), 'utf8')
    : literal.replace(/\\n/g, '\n').replace(/\\"/g, '"')
}

const base = globalCssFromBundle()

/** Rebuild the real page shape: page > columns(grid) > column > controls > field. */
function pageHtml(extraCss) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>pending</title>
<style>${tokens}${base}
${cssOf(bundle, 'TextField.module.css')}
${cssOf(bundle, 'RetrievalPage.module.css')}
${extraCss}
</style></head><body>
<!-- The panel body's own padding, which is the width the page actually receives. -->
<div style="padding:24px;background:#F4F5F8">
  <!-- The scope root, which is what the global stylesheet keys off. Without it the
       fixture would measure an unscoped tree and report content-box for everything,
       making a real fix look absent. -->
  <div class="kb-root">
  <div class="page">
    <div class="columns">
      <div class="column">
        <section class="controls">
          <div class="field">
            <label class="label">查询内容</label>
            <div class="wrapper"><input class="control" value="向量检索是怎么召回相关片段的"></div>
            <span class="hint">用文档中真实存在的说法更容易判断召回是否正常</span>
          </div>
        </section>
      </div>
      <div class="column"><section class="health"><dl class="healthGrid"></dl></section></div>
    </div>
  </div>
  </div>
</div>
<script>
  function measure() {
    var rows = [];
    document.querySelectorAll('.control, .hint, .label, .field, .controls').forEach(function (el) {
      var container = el.closest('.columns') || document.querySelector('.page');
      var cb = container.getBoundingClientRect();
      var eb = el.getBoundingClientRect();
      rows.push(el.className.split(' ')[0] + ' w=' + Math.round(eb.width)
        + ' box=' + getComputedStyle(el).boxSizing
        + ' overflow=' + Math.round(eb.right - cb.right));
    });
    var col = document.querySelector('.column');
    var cols = document.querySelector('.columns');
    rows.push('columnW=' + Math.round(col.getBoundingClientRect().width)
      + ' tracks=' + getComputedStyle(cols).gridTemplateColumns);
    document.title = 'M ' + rows.join(' | ');
  }
  measure();
</script></body></html>`
}

const file = join(OUT, 'textfield.html')
// The fixture is written WITHOUT the forced box-sizing, because the question is what
// the shipped CSS actually computes. The previous revision injected `content-box`
// explicitly, which is what the stylesheet already implies — but it also gave
// `.controls` padding of its own, which absorbed the overflow and hid the symptom.
writeFileSync(file, pageHtml(''), 'utf8')

if (chrome === undefined) {
  console.log('Chrome not found; fixture written to ' + file)
  process.exit(0)
}

const dom = execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=2000',
  // The reported screenshot is 804px wide, so the page was narrow — which is the
  // condition that matters. A wide viewport would hide a narrow-column overflow.
  '--window-size=804,700',
  '--dump-dom', `file:///${file.replace(/\\/g, '/')}`,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

const title = /<title>M ([^<]*)<\/title>/.exec(dom)?.[1] ?? '(no measurement)'
console.log('\n--- control overflow, in the real page shape ---\n')
for (const row of title.split(' | ')) console.log('  ' + row)

const worst = Math.max(...[...title.matchAll(/overflow=(-?\d+)/g)].map(m => Number(m[1])), 0)

// A control must also *fit* its container, which is the property the reported
// symptom violated: under content-box a width:100% control is wider than the box
// that holds it, so its right edge is clipped by the card border.
const boxSizings = [...title.matchAll(/box=([a-z-]+)/g)].map(m => m[1])
const allBorderBox = boxSizings.length > 0 && boxSizings.every(value => value === 'border-box')

console.log('')
let failed = false
if (!allBorderBox) {
  console.log('  FAIL  a control is not border-box, so width:100% overflows its box')
  console.log(`        saw: ${[...new Set(boxSizings)].join(', ')}`)
  failed = true
} else {
  console.log('  PASS  every element is border-box')
}
if (worst > 0) {
  console.log(`  FAIL  an element extends ${worst}px past its container`)
  failed = true
} else {
  console.log('  PASS  nothing extends past its container')
}
if (failed) process.exit(1)

