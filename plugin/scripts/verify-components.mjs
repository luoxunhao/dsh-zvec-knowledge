/**
 * Component contract gate.
 *
 * The design spec's state requirement (§4.7: every interactive component
 * implements default, hover, focus, disabled and loading; §4.5: a status marker
 * carries text, solid fill and border together) is the kind of rule that holds
 * on the day it is written and quietly rots afterwards, because a missing
 * `:disabled` rule produces no error — just a control that looks clickable
 * while it is not.
 *
 * So the rules are checked mechanically against the stylesheets:
 *
 * 1. every interactive CSS module declares all four non-default states;
 * 2. no stylesheet outside the generated token file contains a colour literal
 *    (the spec forbids hardcoding colours in business styles);
 * 3. every `px` literal is either a hairline or listed in {@link ALLOWED_PX} —
 *    a new bare size fails the gate and forces a deliberate choice between
 *    adding a token and extending this list.
 *
 * Dimensions cannot be fully tokenised today and the gate does not pretend
 * otherwise: the design spec states a few values only inline (the spinner's
 * edge lengths) or with no token at all, so the allowlist below is the review
 * point instead of a rule that would be quietly ignored.
 *
 * Usage: node scripts/verify-components.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = join(ROOT, 'src', 'client')
/** Generated from the token source; exempt from the colour-literal ban because it *is* the literals. */
const GENERATED_CSS = 'tokens.generated.css'

/**
 * `px` values a stylesheet may state without a token, each with the reason it is
 * not one. Anything else must become a token or be justified here.
 */
const ALLOWED_PX = new Map([
  ['1px', 'hairline border and focus outline offset; structural, not a scale step'],
  ['-1px', 'visually-hidden offset in the sr-only utility'],
  ['1.5px', 'spinner ring stroke weight, only legible at this size'],
  ['2px', 'spinner ring stroke weight at the largest size'],
  ['12px', 'spinner small edge length'],
  ['14px', 'spinner medium edge length'],
  ['18px', 'spinner large edge length'],
])

/**
 * Strip block comments before scanning.
 * A comment that explains a value ("外发光 4px 15%") must not be read as one,
 * or every future explanation of the rule becomes a gate failure.
 * @param css - stylesheet source.
 * @returns the source with block comments removed.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Interactive states an *interactive* component stylesheet must declare.
 *
 * The design spec (§4.7) scopes the five-state requirement to interactive
 * components. A status pill or a count badge is a marker, not a control, and
 * demanding a `loading` rule from it would push authors toward inventing states
 * nothing can reach — so markers are held to a different, smaller rule instead
 * of being waved through.
 */
const INTERACTIVE_STATES = [
  { state: 'hover', test: css => /:hover/.test(css) },
  { state: 'focus', test: css => /:focus-visible/.test(css) },
  { state: 'disabled', test: css => /:disabled|\[disabled\]|\[aria-disabled/.test(css) },
  { state: 'loading', test: css => /\.loading|\[aria-busy/.test(css) },
]

/**
 * Every component stylesheet must be classified here, and classifying one is a
 * deliberate act: a new stylesheet that appears in none of these maps fails the
 * gate, so nobody adds a component without deciding whether it is a control.
 * Each entry states why.
 */
const TIERS = new Map([
  ['Button.module.css', { tier: 'interactive', why: 'primary action control' }],
  ['IconButton.module.css', { tier: 'interactive', why: 'action control' }],
  ['TextField.module.css', { tier: 'interactive', why: 'text, search and textarea input' }],
  ['Select.module.css', { tier: 'interactive', why: 'single-value chooser' }],
  ['Switch.module.css', { tier: 'interactive', why: 'boolean control' }],
  ['Checkbox.module.css', { tier: 'interactive', why: 'checkbox and radio group control' }],
  ['SegmentedControl.module.css', { tier: 'interactive', why: 'in-view switcher' }],
  ['Tabs.module.css', { tier: 'interactive', why: 'region switcher' }],
  ['StatusPill.module.css', { tier: 'marker', why: 'lifecycle state marker; it reports, it does not act' }],
  ['Tag.module.css', { tier: 'marker', why: 'classification marker; removal goes through an IconButton' }],
  ['CountBadge.module.css', { tier: 'marker', why: 'numeric marker with no interaction of its own' }],
  ['Spinner.module.css', { tier: 'indicator', why: 'it is the loading state; it has no states of its own' }],
])

/**
 * A marker must NOT declare interactive states. That is the useful direction to
 * check: a pill that grows a hover or focus rule is pretending to be a control,
 * and the right response is to classify it as interactive and implement the
 * remaining states — not to leave the affordance half-built.
 */
const FORBIDDEN_MARKER_STATES = [
  { state: 'hover', test: css => /:hover/.test(css) },
  { state: 'focus', test: css => /:focus-visible/.test(css) },
  { state: 'loading', test: css => /\.loading|\[aria-busy/.test(css) },
]

/**
 * Collect files under a directory.
 * @param dir - directory to walk.
 * @param filter - predicate on the file name.
 * @returns absolute file paths.
 */
function walk(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, filter))
    else if (filter(entry)) out.push(full)
  }
  return out
}

const failures = []
const notes = []

const moduleSheets = walk(CLIENT_DIR, name => name.endsWith('.module.css')).sort()
if (moduleSheets.length === 0) failures.push('no component stylesheets found under src/client')

for (const sheet of moduleSheets) {
  const name = sheet.split(sep).pop()
  const css = stripComments(readFileSync(sheet, 'utf8'))
  const rel = relative(ROOT, sheet)
  const declared = TIERS.get(name)
  if (declared === undefined) {
    failures.push(`${rel}: unclassified — add it to TIERS as interactive, marker or indicator`)
    continue
  }
  if (declared.tier === 'interactive') {
    const missing = INTERACTIVE_STATES.filter(({ test }) => !test(css)).map(({ state }) => state)
    if (missing.length > 0) failures.push(`${rel} (interactive): missing state rules for ${missing.join(', ')}`)
    else notes.push(`${rel}: interactive — ${declared.why}`)
  } else if (declared.tier === 'marker') {
    const present = FORBIDDEN_MARKER_STATES.filter(({ test }) => test(css)).map(({ state }) => state)
    if (present.length > 0) {
      failures.push(
        `${rel} (marker): declares ${present.join(', ')} — either classify it as interactive and implement every `
        + 'state, or remove the affordance',
      )
    } else notes.push(`${rel}: marker — ${declared.why}`)
  } else {
    notes.push(`${rel}: indicator — ${declared.why}`)
  }
}

/**
 * The three-piece rule for a status marker (§4.5).
 *
 * A marker must carry text, a *solid* colour and a border together; "缺一即违规".
 * The gate previously checked nothing here, and the violation that slipped
 * through was exactly the interesting one: the pill set `background` to the
 * light `-bg` tint and put the solid colour only in the dot — so the dense form,
 * which drops the dot, carried no solid colour at all.
 *
 * So the check is not "does it mention a colour" but "does the solid token
 * (`--kb-status-<state>`, the design's `successReady` family) actually appear".
 * The border requirement is checked as a real `border`/`border-color`
 * declaration rather than any mention of the word.
 */
const STATUS_SOLID = /--kb-status-(ready|building|failed|pending|info)\s*\)/
const STATUS_BORDER = /border(-color)?:\s*[^;]*--kb-status-[a-z]+-border/

/**
 * Verify the status-pill contract against its own stylesheet.
 * @param rel - path shown in messages.
 * @param css - comment-stripped stylesheet source.
 */
function checkStatusPill(rel, css) {
  if (!STATUS_SOLID.test(css)) {
    failures.push(`${rel}: no solid status colour — §4.5 requires 文字 + 实色 + 描边, and the solid token (--kb-status-*) must be used, not only the -bg tint`)
  }
  if (!STATUS_BORDER.test(css)) {
    failures.push(`${rel}: no status border — §4.5 requires a border on every marker`)
  }
  // The text colour must be the readable `-text` token, because the solid value
  // does not meet 4.5:1 against its own tint.
  if (!/--kb-status-[a-z]+-text/.test(css)) {
    failures.push(`${rel}: no status text token — the label must use --kb-status-*-text for contrast`)
  }
}

const allSheets = walk(CLIENT_DIR, name => name.endsWith('.css')).sort()
for (const sheet of allSheets) {
  const name = sheet.split(sep).pop()
  if (name === GENERATED_CSS) continue
  const css = stripComments(readFileSync(sheet, 'utf8'))
  const rel = relative(ROOT, sheet)

  const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(css)
  if (colour !== null) {
    failures.push(`${rel}: colour literal ${JSON.stringify(colour[0])} — use a --kb-* token`)
  }

  for (const match of css.matchAll(/(-?\d*\.?\d+)px/g)) {
    if (!ALLOWED_PX.has(match[1] + 'px')) {
      failures.push(`${rel}: bare size ${match[1]}px is neither a token nor in ALLOWED_PX`)
    }
  }

  if (name === 'StatusPill.module.css') checkStatusPill(rel, css)
}

if (failures.length > 0) {
  console.error(`component gate failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`component gate passed: ${moduleSheets.length} component stylesheets classified and checked`)
for (const note of notes) console.log(`  ${note}`)
