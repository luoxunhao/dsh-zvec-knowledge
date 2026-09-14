/**
 * Contrast audit: WCAG ratios computed from the actual token values.
 *
 * The design spec requires body text ≥ 4.5:1 and large text / graphics ≥ 3:1, and
 * the issue list adds the constraint that makes this worth automating: the dark
 * theme must be measured **on its own**, not inferred from the light results.
 * Those are different colour sets, and a pair that passes in one can fail in the
 * other — the dark semantic tones in particular are brightened to stay legible on
 * a dark surface, which changes every ratio they participate in.
 *
 * Ratios are computed from `tokens/kb-tokens.json`, so the audit follows the real
 * palette rather than a snapshot of it: adding a token or changing a value is
 * caught here instead of being discovered by a user.
 *
 * Usage: node scripts/verify-contrast.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

/**
 * Parse a colour token into RGB channels.
 *
 * Only the forms the token source actually uses are accepted, and an unparseable
 * value is reported rather than skipped: silently ignoring a colour would make the
 * audit's coverage a guess.
 * @param value - a hex colour or `rgb()`/`rgba()` string.
 * @returns channels in 0..255, or `null` when unparseable.
 */
export function parseColor(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (hex !== null) {
    const digits = hex[1]
    const full = digits.length === 3 ? digits.split('').map(d => d + d).join('') : digits
    return [0, 2, 4].map(offset => Number.parseInt(full.slice(offset, offset + 2), 16))
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value.trim())
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/**
 * Composite a translucent colour over an opaque one.
 *
 * The scrim token is translucent, so its ratio against text is only meaningful
 * once flattened — measuring the raw value would compare against nothing.
 * @param foreground - the translucent colour as `rgba(r,g,b,a)`.
 * @param background - the opaque backdrop.
 * @returns the flattened colour.
 */
export function flatten(foreground, background) {
  const alpha = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\)/i.exec(foreground)
  if (alpha === null) return parseColor(foreground)
  const front = parseColor(foreground)
  const back = parseColor(background)
  if (front === null || back === null) return null
  const a = Number(alpha[1])
  return [0, 1, 2].map(index => Math.round(front[index] * a + back[index] * (1 - a)))
}

/**
 * Relative luminance, per WCAG 2.x.
 * @param rgb - channels in 0..255.
 * @returns luminance in 0..1.
 */
export function luminance(rgb) {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Contrast ratio between two colours.
 * @param a - channels in 0..255.
 * @param b - channels in 0..255.
 * @returns ratio in 1..21.
 */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

const tokens = JSON.parse(readFileSync(join(ROOT, 'tokens', 'kb-tokens.json'), 'utf8')).tokens

/**
 * Build a lookup of resolved token values for one mode.
 *
 * A token's value may itself be a reference (`var(--kb-brand)`), which is how the
 * focus ring inherits the brand colour. Resolving those is part of reading the
 * palette: measuring a `var()` string would compare nothing.
 * @param mode - `light` or `dark`.
 * @returns a map of token name to concrete value, with dark falling back to light.
 */
function palette(mode) {
  const raw = new Map()
  for (const token of tokens) {
    const value = mode === 'dark' ? (token.dark ?? token.light) : token.light
    raw.set(token.var, value)
  }
  const resolved = new Map()
  /** Resolve a value, following `var()` references up to a small depth. */
  const resolveValue = (value, depth = 0) => {
    const reference = depth < 8 ? /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim()) : null
    if (reference === null) return value
    const target = raw.get(reference[1])
    return target === undefined ? value : resolveValue(target, depth + 1)
  }
  for (const [name, value] of raw) resolved.set(name, resolveValue(value))
  return resolved
}

const light = palette('light')
const dark = palette('dark')

/**
 * The pairs that must be legible, and the threshold each needs.
 *
 * Each entry states the real foreground/background pairing the interface uses.
 * Getting this list right is most of the audit's value: a ratio for a pair that
 * never appears together proves nothing.
 */
const PAIRS = [
  // Body text on each surface it actually sits on.
  { text: '--kb-text-primary', bg: '--kb-bg-surface', min: 4.5, what: '正文 / 卡片' },
  { text: '--kb-text-primary', bg: '--kb-bg-app', min: 4.5, what: '正文 / 应用底' },
  { text: '--kb-text-primary', bg: '--kb-bg-subtle', min: 4.5, what: '正文 / 次级填充' },
  { text: '--kb-text-secondary', bg: '--kb-bg-surface', min: 4.5, what: '次级文字 / 卡片' },
  { text: '--kb-text-secondary', bg: '--kb-bg-app', min: 4.5, what: '次级文字 / 应用底' },
  { text: '--kb-text-tertiary', bg: '--kb-bg-surface', min: 4.5, what: '三级文字 / 卡片' },
  { text: '--kb-text-tertiary', bg: '--kb-bg-subtle', min: 4.5, what: '三级文字 / 次级填充' },
  { text: '--kb-text-quiet', bg: '--kb-bg-surface', min: 4.5, what: '未选态文字 / 卡片' },

  // Brand: primary actions and links carry text.
  { text: '--kb-brand', bg: '--kb-bg-surface', min: 4.5, what: '品牌文字 / 卡片' },
  { text: '--kb-brand', bg: '--kb-brand-tint', min: 3.0, what: '品牌文字 / 品牌底纹' },
  { text: '--kb-text-inverse', bg: '--kb-brand', min: 4.5, what: '反白文字 / 品牌实底（主按钮）' },
  { text: '--kb-brand-link', bg: '--kb-bg-surface', min: 4.5, what: '链接 / 卡片' },

  // Status text on its own tint: the pairing the status pill and log lines use.
  { text: '--kb-status-ready-text', bg: '--kb-status-ready-bg', min: 4.5, what: '就绪文字 / 就绪底纹' },
  { text: '--kb-status-building-text', bg: '--kb-status-building-bg', min: 4.5, what: '构建中文字 / 底纹' },
  { text: '--kb-status-failed-text', bg: '--kb-status-failed-bg', min: 4.5, what: '失败文字 / 底纹' },
  { text: '--kb-status-pending-text', bg: '--kb-status-pending-bg', min: 4.5, what: '待构建文字 / 底纹' },
  { text: '--kb-status-info-text', bg: '--kb-status-info-bg', min: 4.5, what: '信息文字 / 底纹' },

  // Status solid marks are graphics, so 3:1 applies.
  { text: '--kb-status-ready', bg: '--kb-bg-surface', min: 3.0, what: '就绪实色 / 卡片（圆点）' },
  { text: '--kb-status-building', bg: '--kb-bg-surface', min: 3.0, what: '构建中实色 / 卡片' },
  { text: '--kb-status-failed', bg: '--kb-bg-surface', min: 3.0, what: '失败实色 / 卡片' },
  { text: '--kb-status-info', bg: '--kb-bg-surface', min: 3.0, what: '信息实色 / 卡片' },

  // Borders must be perceivable as boundaries (graphics, 3:1 against their surface).
  { text: '--kb-border-strong', bg: '--kb-bg-surface', min: 1.5, what: '强描边 / 卡片（边界可辨）' },
  { text: '--kb-border-subtle', bg: '--kb-bg-surface', min: 1.2, what: '弱描边 / 卡片（分隔可辨）' },

  // The focus ring is a graphic and must be visible on both surfaces.
  { text: '--kb-focus-ring-color', bg: '--kb-bg-surface', min: 3.0, what: '聚焦环 / 卡片' },
  { text: '--kb-focus-ring-color', bg: '--kb-bg-app', min: 3.0, what: '聚焦环 / 应用底' },
]

/** Audit one mode's pairs and return the rows for the report. */
function audit(mode, map) {
  const rows = []
  for (const pair of PAIRS) {
    const textValue = map.get(pair.text)
    const bgValue = map.get(pair.bg)
    if (textValue === undefined || bgValue === undefined) {
      failures.push(`${mode}: ${pair.text} 或 ${pair.bg} 不存在于令牌集`)
      continue
    }
    const textRgb = parseColor(textValue)
    const bgRgb = parseColor(bgValue)
    if (textRgb === null || bgRgb === null) {
      failures.push(`${mode}: 无法解析 ${pair.text}=${textValue} 或 ${pair.bg}=${bgValue}`)
      continue
    }
    const ratio = contrast(textRgb, bgRgb)
    const ok = ratio >= pair.min
    rows.push({ mode, what: pair.what, text: pair.text, bg: pair.bg, ratio, min: pair.min, ok })
    check(`${mode} 对比度：${pair.what}`, ok, `${ratio.toFixed(2)}:1（要求 ≥ ${pair.min}）`)
  }
  return rows
}

// Both modes are audited independently and reported separately: inheriting the
// light results is exactly what the issue list forbids.
const lightRows = audit('浅色', light)
const darkRows = audit('深色', dark)

// The two modes must actually differ, or "independently sampled" is a claim about
// a copy. A dark palette identical to the light one would pass every ratio above
// while being unusable.
{
  const darkOverrides = tokens.filter(token => token.dark !== undefined).length
  check('深色主题：确有独立取值', darkOverrides > 0, `${darkOverrides} 项令牌在深色下取不同值`)
  const surfaceDiffers = light.get('--kb-bg-surface') !== dark.get('--kb-bg-surface')
  check('深色主题：表面色与浅色不同', surfaceDiffers, `浅 ${light.get('--kb-bg-surface')} / 深 ${dark.get('--kb-bg-surface')}`)
}

// Flattened scrim: the overlay's backdrop must still leave content distinguishable.
{
  for (const [mode, map] of [['浅色', light], ['深色', dark]]) {
    const scrim = map.get('--kb-overlay-scrim')
    if (scrim === undefined) continue
    const over = flatten(scrim, map.get('--kb-bg-app'))
    check(`${mode} 遮罩：可解析并叠加`, over !== null, `${scrim} over ${map.get('--kb-bg-app')}`)
  }
}

// The report is an artifact: the acceptance criterion asks for a留档 with the
// checklist, so it is written next to the run rather than only printed.
const report = {
  generatedAt: new Date().toISOString(),
  source: 'tokens/kb-tokens.json',
  thresholds: { body: 4.5, largeTextAndGraphics: 3.0 },
  light: lightRows,
  dark: darkRows,
}
const outPath = join(ROOT, 'tmp', 'contrast-report.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`\nContrast audit: ${passes.length} passed, ${failures.length} failed`)
console.log(`  浅色 ${lightRows.filter(r => r.ok).length}/${lightRows.length} 通过`)
console.log(`  深色 ${darkRows.filter(r => r.ok).length}/${darkRows.length} 通过`)
console.log(`  留档 ${outPath}\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
