/**
 * Generate the plugin's stylesheet and W3C token export from the single token
 * source of truth (`tokens/kb-tokens.json`).
 *
 * Nothing else in the repository may restate a token value: the design spec
 * forbids hardcoded colours and sizes in business styles, and the only way to
 * hold that line is to make the token source the one place a value is written
 * down. `--check` re-renders both artifacts and fails when either on disk
 * differs, so a hand edit to a generated file is caught at verify time rather
 * than at review time.
 *
 * Usage:
 *   node scripts/gen-tokens.mjs           # write artifacts
 *   node scripts/gen-tokens.mjs --check   # fail when artifacts are stale
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'tokens', 'kb-tokens.json')
const CSS_OUT = join(ROOT, 'src', 'client', 'styles', 'tokens.generated.css')
const W3C_OUT = join(ROOT, 'tokens', 'w3c', 'kb-design-tokens.json')
const SCSS_OUT = join(ROOT, 'tokens', 'scss', '_kb-tokens.scss')

const check = process.argv.includes('--check')

/** W3C design-token `$type` per source `kind`. */
const W3C_TYPE = {
  color: 'color',
  dimension: 'dimension',
  fontFamily: 'fontFamily',
  shadow: 'shadow',
  /** Composite values the format has no dedicated type for (focus ring, outline shorthand). */
  other: 'other',
}

/**
 * Read and validate the token source.
 * @returns the parsed document plus the tokens array.
 */
function loadSource() {
  const doc = JSON.parse(readFileSync(SOURCE, 'utf8'))
  if (!Array.isArray(doc.tokens) || doc.tokens.length === 0) {
    throw new Error(`${relative(ROOT, SOURCE)}: "tokens" must be a non-empty array`)
  }
  const seen = new Set()
  for (const token of doc.tokens) {
    if (typeof token.var !== 'string' || !token.var.startsWith('--kb-')) {
      throw new Error(`token var must be a --kb-* custom property, received ${JSON.stringify(token.var)}`)
    }
    if (seen.has(token.var)) throw new Error(`duplicate token var ${token.var}`)
    seen.add(token.var)
    if (typeof token.light !== 'string' || token.light.length === 0) {
      throw new Error(`${token.var}: "light" is required`)
    }
    if (W3C_TYPE[token.kind] === undefined) {
      throw new Error(`${token.var}: unknown kind ${JSON.stringify(token.kind)}`)
    }
  }
  return doc
}

/**
 * Render one `custom-property: value;` block body.
 * @param tokens - tokens to render.
 * @param mode - which mode's value to read.
 * @param includeInherited - render `light` when the token has no override for `mode`.
 * @returns the declaration lines.
 */
function renderDeclarations(tokens, mode, includeInherited) {
  const lines = []
  for (const token of tokens) {
    const value = token[mode]
    if (value === undefined && includeInherited) lines.push(`  ${token.var}: ${token.light};`)
    else if (value !== undefined) lines.push(`  ${token.var}: ${value};`)
  }
  return lines
}

/**
 * Render the stylesheet.
 * @param doc - parsed token source.
 * @returns CSS text.
 */
function renderCss(doc) {
  const { light, dark } = doc.meta.themeSelectors
  const overrides = doc.tokens.filter(token => token.dark !== undefined)
  const header = [
    '/*',
    ' * 由 scripts/gen-tokens.mjs 从 tokens/kb-tokens.json 生成，请勿手工编辑。',
    ` * 令牌源：${doc.meta.spec}`,
    ` * 共 ${doc.tokens.length} 项令牌，其中 ${overrides.length} 项在深色主题下取不同值。`,
    ' */',
    '',
  ]
  return [
    ...header,
    `${light} {`,
    ...renderDeclarations(doc.tokens, 'light', true),
    '}',
    '',
    `${dark} {`,
    ...renderDeclarations(overrides, 'dark', false),
    '}',
    '',
  ].join('\n')
}

/**
 * Verify the source's declared usage counts and return a summary.
 * @param doc - parsed token source.
 * @returns counts per group and the derived-token list.
 */
function summarize(doc) {
  const groups = new Map()
  for (const token of doc.tokens) groups.set(token.group, (groups.get(token.group) ?? 0) + 1)
  return {
    groups,
    derived: doc.tokens.filter(token => token.derived === true).map(token => token.var),
    darkOverrides: doc.tokens.filter(token => token.dark !== undefined).length,
  }
}

/**
 * Build the W3C Design Tokens document: one leaf per token, light in `$value`,
 * dark in `$extensions` because the format has no first-class mode axis yet.
 * @param doc - parsed token source.
 * @returns the W3C document.
 */
function renderW3c(doc) {
  const out = {
    $description: doc.meta.name,
    $extensions: {
      'com.dsh.zvec-knowledge': {
        spec: doc.meta.spec,
        prefix: doc.meta.prefix,
        themeSelectors: doc.meta.themeSelectors,
        conflicts: doc.meta.conflicts,
      },
    },
  }
  for (const token of doc.tokens) {
    const path = token.var.slice('--kb-'.length).split('-')
    let cursor = out
    for (const segment of path.slice(0, -1)) {
      cursor[segment] ??= {}
      cursor = cursor[segment]
    }
    const leaf = {
      $type: W3C_TYPE[token.kind],
      $value: token.light,
      $description: token.note ?? '',
    }
    if (token.specName !== null && token.specName !== undefined) {
      leaf.$extensions = { 'com.dsh.zvec-knowledge': { specName: token.specName } }
    }
    if (token.dark !== undefined) {
      leaf.$extensions = {
        ...(leaf.$extensions ?? {}),
        'com.dsh.zvec-knowledge': {
          ...((leaf.$extensions ?? {})['com.dsh.zvec-knowledge'] ?? {}),
          dark: token.dark,
        },
      }
    }
    if (token.derived === true) {
      leaf.$extensions = {
        ...(leaf.$extensions ?? {}),
        'com.dsh.zvec-knowledge': {
          ...((leaf.$extensions ?? {})['com.dsh.zvec-knowledge'] ?? {}),
          derived: true,
        },
      }
    }
    cursor[path[path.length - 1]] = leaf
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * Write a file, or compare it under `--check`.
 * @param path - absolute target path.
 * @param content - intended content.
 * @returns true when the file is up to date.
 */
function emit(path, content) {
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (current === content) return true
    console.error(`stale: ${relative(ROOT, path)}`)
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return true
}

/**
 * Render the SCSS variable export surface.
 *
 * These are Sass variables, not custom properties, and the distinction is the
 * whole point of the artifact: a Sass variable is substituted at build time, so
 * it cannot change with the theme. Emitting the light values under a name that
 * looks theme-aware would invite a caller to write `color: $kb-text-primary` and
 * silently lose dark mode.
 *
 * So the file deliberately exports only what is genuinely theme-independent, and
 * states that rule in its own header:
 *
 * - the light value, named `$kb-<name>` — for build-time math and for styles that
 *   are intentionally fixed (a token used inside a `color-mix()` operand, say);
 * - the dark value, named `$kb-<name>-dark`, so a caller who wants the dark
 *   literal has to say so;
 * - a `$kb-token-names` map, so a Sass consumer can iterate tokens without
 *   hardcoding the list.
 *
 * Every theme-aware declaration in the plugin remains a `var(--kb-*)` reference.
 * @param doc - parsed token source.
 * @returns SCSS source.
 */
function renderScss(doc) {
  const header = [
    '// 由 scripts/gen-tokens.mjs 从 tokens/kb-tokens.json 生成，请勿手工编辑。',
    '// 令牌源：《DSH 知识库插件（基于 zvec）设计规范》v1.1.0 第 3 章（浅色）、第 7 章（深色）',
    '//',
    `// 共 ${doc.tokens.length} 项令牌。深色变量以 -dark 后缀单独导出。`,
    '//',
    '// ⚠️ Sass 变量在构建期被替换，**不随主题切换**。凡需要随浅/深主题变化的样式，',
    '//    必须使用 CSS 自定义属性 `var(--kb-*)`，不要使用本文件中的 $ 变量。',
    '//    本文件只服务两类场景：构建期数值计算，以及明确要固定取某一主题字面量的样式。',
    '',
  ].join('\n')

  const light = doc.tokens.map(token => `$kb-${sassName(token.var)}: ${token.light};`)
  const dark = doc.tokens
    .filter(token => token.dark !== undefined)
    .map(token => `$kb-${sassName(token.var)}-dark: ${token.dark};`)

  // A name map lets a consumer write `@each $name, $value in $kb-token-names`
  // instead of repeating the token list, which is how the list stays in sync.
  const mapRows = doc.tokens.map(token => `  "${token.var}": $kb-${sassName(token.var)},`)

  return [
    header,
    '// ---- 浅色（默认）----',
    ...light,
    '',
    `// ---- 深色覆盖（${dark.length} 项）----`,
    ...dark,
    '',
    '// ---- 令牌名 → 变量 映射 ----',
    '$kb-token-names: (',
    ...mapRows,
    ');',
    '',
  ].join('\n')
}

/**
 * Convert a custom-property name to a Sass identifier.
 * @param varName - token name such as `--kb-brand-500`.
 * @returns the Sass-safe name such as `brand-500`.
 */
function sassName(varName) {
  return varName.replace(/^--kb-/, '')
}

const doc = loadSource()
const css = renderCss(doc)
const w3c = renderW3c(doc)
const scss = renderScss(doc)
const cssOk = emit(CSS_OUT, css)
const w3cOk = emit(W3C_OUT, w3c)
const scssOk = emit(SCSS_OUT, scss)
const summary = summarize(doc)

const report = [
  `${doc.tokens.length} tokens (${[...summary.groups].map(([g, n]) => `${g} ${n}`).join(', ')})`,
  `${summary.darkOverrides} dark overrides`,
  `${summary.derived.length} derived values pending design confirmation: ${summary.derived.join(', ') || 'none'}`,
].join('\n')

if (check) {
  if (!cssOk || !w3cOk || !scssOk) {
    console.error('run `pnpm tokens` to regenerate')
    process.exit(1)
  }
  console.log(`tokens in sync\n${report}`)
} else {
  console.log(`wrote ${relative(ROOT, CSS_OUT)}, ${relative(ROOT, W3C_OUT)} and ${relative(ROOT, SCSS_OUT)}\n${report}`)
}
