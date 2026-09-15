/**
 * Render the two-column pages at real viewport widths for visual verification.
 *
 * The unit-level checks cannot answer "does this page use the width it is given?" —
 * that is a layout property, and the only honest way to judge it is to render the
 * real markup with the real stylesheet and measure. This builds a static page from
 * the *compiled* CSS module output plus a markup fixture, screenshots it at three
 * widths, and prints the measured column geometry.
 *
 * It deliberately does NOT reimplement the page: the fixture mirrors the JSX
 * structure (header → columns → submit) and the CSS is the built artifact, so a
 * drift between them shows up as a wrong measurement.
 *
 * Usage: node scripts/render-layout-check.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tmp', 'layout-check')
mkdirSync(OUT, { recursive: true })

/**
 * Read a compiled CSS module and map its hashed class names back to stable ones.
 *
 * The bundle emits `const css$N = "..."; export default { page: "AbC_page", ... }`.
 * Rewriting the hashes to their source keys makes the fixture readable and keeps it
 * tied to the same stylesheet the app ships.
 * @param moduleSource - the built component's JS, as text.
 * @param globalCss - the generated token stylesheet, prepended so `var(--kb-*)` resolves.
 * @returns a stylesheet with readable class names.
 */
function extractCss(moduleSource, globalCss) {
  const cssLiteral = /const css\$\d+ = "((?:[^"\\]|\\.)*)"/.exec(moduleSource)?.[1] ?? ''
  if (cssLiteral === '') {
    throw new Error('no CSS literal found — the bundle layout changed and this reader is stale')
  }
  let css = cssLiteral.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  // `var X_default = { "page": "hash_page", ... }` — invert so `hash_page` reads `page`.
  // Keys may be quoted (tsdown quotes any key that is not a bare identifier), so the
  // pattern accepts both. Matched inside the module slice only, so hashes from other
  // modules are not mixed in.
  const map = {}
  for (const [, key, hashed] of moduleSource.matchAll(/"(\w+)":\s*"([A-Za-z0-9_-]+_\w+)"/g)) {
    map[hashed] = key
  }
  if (Object.keys(map).length === 0) {
    throw new Error('no class-name map found — the bundle layout changed and this reader is stale')
  }
  for (const [hashed, key] of Object.entries(map)) {
    css = css.split(hashed).join(key)
  }
  return globalCss + '\n' + css
}

/**
 * Slice one CSS module's emitted source out of the bundle.
 *
 * The bundle emits `//#region <abs path>\BuildPage.module.css.mjs` before each
 * module, so the marker must be matched as a path to avoid landing on the import
 * statement at the top of the file (which is where a naive search points).
 * @param bundle - the built client bundle.
 * @param file - the module's file name.
 * @returns the module's source slice.
 */
function moduleOf(bundle, file) {
  const marker = `\\${file}.mjs`
  const at = bundle.indexOf(marker)
  if (at < 0) throw new Error(`${file} not found in the bundle — run the build first`)
  const end = bundle.indexOf('//#endregion', at)
  if (end < 0) throw new Error(`${file}: unterminated region`)
  return bundle.slice(at, end)
}

const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
// The token stylesheet is inlined by the client build; read the source-of-truth
// generated file so the fixture sees the same custom properties.
const globalCss = readFileSync(join(ROOT, 'src', 'client', 'styles', 'tokens.generated.css'), 'utf8')
const baseCss = readFileSync(join(ROOT, 'src', 'client', 'styles', 'base.css'), 'utf8')

const buildCss = extractCss(moduleOf(bundle, 'BuildPage.module.css'), globalCss + '\n' + baseCss)
const retrCss = extractCss(moduleOf(bundle, 'RetrievalPage.module.css'), '')
const panelCss = extractCss(moduleOf(bundle, 'KnowledgePanel.module.css'), '')

// Keep the token `:root` block: slicing from the first `.page` would drop it, and
// every `max-width: var(--kb-split-max-width)` would then resolve to nothing —
// which is exactly the failure this fixture exists to catch, so it must not
// manufacture it.
const onlyBuild = buildCss
const onlyRetr = globalCss + '\n' + baseCss + '\n' + retrCss

/** A section block matching the real BuildPage structure. */
const section = (title, body) => `
  <section class="section">
    <h4 class="sectionTitle">${title}</h4>
    ${body}
  </section>`

const field = label => `<div class="field"><span class="fl">${label}</span><span class="fc">1024</span></div>`

const buildFixture = `
<div class="page" id="page">
  <header class="header">
    <div class="headerText">
      <h3 class="title">索引策略</h3>
      <p class="description">参数变更需重建才生效。重建期间，会话中的 dsh_kb_search 仍使用上一次构建的索引。</p>
    </div>
    <button class="ghost">重置为推荐值</button>
  </header>
  <div class="columns">
    <div class="column">
      ${section('切分策略', `<div class="grid">${field('分片长度（token）')}${field('重叠长度（token）')}${field('最小分片（token）')}</div>`)}
      ${section('分片预览', '<div class="chunkbox">#0 · 1024 tok · 重叠 128 · 0–4096 &nbsp; 向量检索把文本映射为稠密向量……</div>')}
    </div>
    <div class="column">
      ${section('嵌入与索引策略', `
        <div class="grid">${field('嵌入模型')}</div>
        <div class="readonly">
          <div class="readonlyItem"><span class="readonlyLabel">向量维度</span><span class="readonlyValue">2560</span></div>
          <div class="readonlyItem"><span class="readonlyLabel">数据类型</span><span class="readonlyValue">VECTOR_FP32</span></div>
          <div class="readonlyItem"><span class="readonlyLabel">距离度量</span><span class="readonlyValue">cosine</span></div>
        </div>
        <div class="grid">${field('量化器')}</div>
        <div class="weights"><span class="fieldLabel">混合检索权重</span><div class="grid">${field('稠密向量')}${field('全文检索')}</div></div>`)}
      ${section('成本预估', '<div class="chunkbox">351 片 · 量化后 3.4 MB · 预计 9 秒</div>')}
    </div>
  </div>
  <div class="submit"><button class="primary">保存并重建索引</button></div>
</div>`

const hit = n => `
  <li class="hit">
    <div class="hitHead">
      <span class="hitRank">${n}</span><span class="hitName">chapter3.md</span>
      <span class="hitOrdinal">#${20 + n}</span><span class="hitRange">52815–56812</span>
      <span class="hitScore">0.4${n}5</span><span class="pill">一般</span>
    </div>
    <pre class="hitText">However, static word vectors have a fundamental limitation: they cannot handle polysemy. The word "bank" has completely different meanings depending on context, yet a static vector assigns it one representation.</pre>
  </li>`

const retrFixture = `
<div class="page" id="page">
  <header class="header">
    <div class="headerText">
      <h3 class="title">检索验证</h3>
      <p class="description">用真实查询验证分片质量与向量召回能力。此页只做诊断，不生成回答——问答请在 dsh 会话中直接提问。</p>
    </div>
  </header>
  <div class="columns">
    <div class="column">
      <section class="controls">
        <div class="field"><span class="fl">查询内容</span><span class="fc">向量检索是怎么召回相关片段的</span></div>
        <div class="grid">${field('返回条数（topk）')}${field('分数下限（minScore）')}</div>
        <div class="chunkbox">仅稠密向量检索</div>
        <div class="actions"><button class="primary">运行检索</button><span class="timing">耗时 377 ms</span></div>
      </section>
    </div>
    <div class="column">
      <section class="health">
        <dl class="healthGrid">
          <div class="healthItem"><span class="healthLabel">命中</span><span class="healthValue">8</span></div>
          <div class="healthItem"><span class="healthLabel">低于阈值被过滤</span><span class="healthValue">32</span></div>
          <div class="healthItem"><span class="healthLabel">检索模式</span><span class="healthValue">混合</span></div>
          <div class="healthItem"><span class="healthLabel">快照</span><span class="healthValue">a · 351 片</span></div>
        </dl>
      </section>
      <ul class="hits">${hit(1)}${hit(2)}</ul>
    </div>
  </div>
</div>`

/** Support styles so the fixture's generic elements match the real components. */
const support = `
.field { display: flex; flex-direction: column; gap: 4px; }
.fl { font-size: 12px; color: #5B6472; }
.fc { display: block; padding: 8px 10px; border: 1px solid #E9ECF2; border-radius: 8px; background: #fff; color: #1B1F27; }
.chunkbox { padding: 10px; border: 1px solid #E9ECF2; border-radius: 8px; background: #F7F8FA; color: #5B6472; font-size: 13px; }
.section { border: 1px solid #E9ECF2; border-radius: 12px; background: #fff; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.sectionTitle { margin: 0; font-size: 15px; color: #1B1F27; }
.controls, .health { display: flex; flex-direction: column; gap: 12px; }
.primary { padding: 8px 16px; border: 0; border-radius: 8px; background: #4C5BD4; color: #fff; font-size: 14px; }
.ghost { padding: 6px 12px; border: 1px solid #E9ECF2; border-radius: 8px; background: #fff; color: #5B6472; }
.pill { padding: 2px 8px; border: 1px solid #E9ECF2; border-radius: 999px; font-size: 12px; color: #5B6472; }
.hitHead { display: flex; align-items: center; gap: 10px; }
.hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.hit { border: 1px solid #E9ECF2; border-radius: 12px; background: #fff; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.timing { font-size: 12px; color: #8A93A2; }
.actions { display: flex; align-items: center; gap: 10px; }
`

/**
 * Write one page and report its column geometry.
 * @param name - output base name.
 * @param css - the page's compiled stylesheet.
 * @param body - the markup fixture.
 */
function emit(name, css, body) {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>${globalCss}${baseCss}${support}${panelCss}${css}</style>
<style>
  /* Stand in for the host's main column: the panel body's own padding, and the app
   * background, so the measurement reflects the width the page really receives. */
  html, body { margin: 0; background: #F4F5F8; }
  .host { padding: 24px; }
  .measure { position: fixed; right: 8px; top: 8px; font: 11px monospace; background: #fff; border: 1px solid #ddd; padding: 6px 8px; white-space: pre; }
</style></head><body>
<div class="host">${body}</div>
<div class="measure" id="m">measuring…</div>
<script>
  // Runs at load, and the result is written into BOTH the visible box and the
  // document title: dump-dom serialises after load but does not reliably wait on a
  // later paint, so anything measured must be committed synchronously here.
  function measure() {
    var p = document.getElementById('page');
    var cols = document.querySelector('.columns');
    var cs = getComputedStyle(p);
    var out = [];
    out.push('viewport    = ' + window.innerWidth + 'px');
    out.push('page width  = ' + Math.round(p.getBoundingClientRect().width) + 'px');
    out.push('max-width   = ' + cs.maxWidth);
    if (cols) {
      var tracks = getComputedStyle(cols).gridTemplateColumns.split(' ').filter(Boolean);
      out.push('columns     = ' + tracks.length + ' track(s)');
      out.push('track widths= ' + tracks.map(function (t) { return Math.round(parseFloat(t)) + 'px'; }).join(' / '));
    }
    var text = out.join(' | ');
    document.getElementById('m').textContent = out.join('\\n');
    document.title = 'MEASURE ' + text;
  }
  measure();
</script>
</body></html>`
  writeFileSync(join(OUT, `${name}.html`), html, 'utf8')
}

emit('build', onlyBuild, buildFixture)
emit('retrieval', onlyRetr, retrFixture)

console.log(`wrote ${OUT}`)
for (const name of ['build', 'retrieval']) {
  const html = readFileSync(join(OUT, `${name}.html`), 'utf8')
  console.log(`  ${name}.html  (${html.length} bytes)`)
  for (const token of ['--kb-split-max-width', 'kb-split-column-min']) {
    console.log(`    ${token}: ${html.includes(token) ? 'present' : 'ABSENT — the fixture would measure wrong'}`)
  }
}
if (!existsSync(join(OUT, 'build.html'))) process.exit(1)
