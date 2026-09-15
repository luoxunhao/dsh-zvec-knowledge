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
  // Media-query breakpoints cannot read a custom property: `@media (max-width:
  // var(--x))` is invalid CSS. The responsive ladder is therefore the one place a
  // length must be a literal, and the values live here so they are reviewable in
  // one place. They are mirrored as `--kb-breakpoint-*` tokens for documentation
  // and for any future JS-side matchMedia use.
  ['1100px', 'stats/grid collapse breakpoint (--kb-breakpoint-stats); @media cannot use var()'],
  ['720px', 'compact breakpoint (--kb-breakpoint-compact); @media cannot use var()'],
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
 *
 * `container` is the tier for the composition layer — cards, pages, the shell and
 * the dialog frame. These are not controls: clicking a shell frame does nothing,
 * so demanding a `:hover` rule from it would push an author to invent an
 * affordance nothing can reach. The tier is not an exemption from the other two
 * checks: containers are still scanned for colour literals and bare sizes, and
 * any real control inside one carries its own states in its own stylesheet, which
 * is where the gate looks for them.
 */
const TIERS = new Map([
  ['Button.module.css', { tier: 'interactive', why: 'primary action control' }],
  ['IconButton.module.css', { tier: 'interactive', why: 'action control' }],
  ['TextField.module.css', { tier: 'interactive', why: 'text, search and textarea input' }],
  ['NumberField.module.css', { tier: 'interactive', why: 'numeric parameter input; has its own focus/disabled/loading treatment' }],
  ['SearchField.module.css', { tier: 'interactive', why: 'search input with a clear affordance' }],
  ['Select.module.css', { tier: 'interactive', why: 'single-value chooser' }],
  ['Switch.module.css', { tier: 'interactive', why: 'boolean control' }],
  ['Checkbox.module.css', { tier: 'interactive', why: 'checkbox and radio group control' }],
  ['SegmentedControl.module.css', { tier: 'interactive', why: 'in-view switcher' }],
  ['Tabs.module.css', { tier: 'interactive', why: 'region switcher' }],
  ['UploadDropzone.module.css', { tier: 'interactive', why: 'drop zone; it is a button, which is what makes it keyboard reachable' }],
  ['StatusPill.module.css', { tier: 'marker', why: 'lifecycle state marker; it reports, it does not act' }],
  ['Tag.module.css', { tier: 'marker', why: 'classification marker; removal goes through an IconButton' }],
  ['CountBadge.module.css', { tier: 'marker', why: 'numeric marker with no interaction of its own' }],
  ['ProgressBar.module.css', { tier: 'marker', why: 'progress indicator; it reports a value, it does not act' }],
  ['Spinner.module.css', { tier: 'indicator', why: 'it is the loading state; it has no states of its own' }],
  ['StatCard.module.css', { tier: 'container', why: 'summary tile; the tile itself is not clickable' }],
  ['StorageUsageCard.module.css', { tier: 'container', why: 'sidebar readout; contains a progress marker, no control' }],
  ['CollectionCard.module.css', { tier: 'container', why: 'card frame; its two controls (name button, delete) live inside and carry their own states' }],
  ['EmptyState.module.css', { tier: 'container', why: 'empty-state panel; the action passed in is a Button' }],
  ['AppShell.module.css', { tier: 'container', why: 'application frame; nav items are buttons inside and declare no shared state rule' }],
  ['OverviewPage.module.css', { tier: 'container', why: 'page layout; it styles tables and grids, not controls' }],
  ['KnowledgePanel.module.css', { tier: 'container', why: 'panel body inside the host main column; the tab strip inside carries its own states' }],
  ['DocumentsPage.module.css', { tier: 'container', why: 'page layout: toolbar, list frame and states; the controls inside carry their own states' }],
  ['DocumentRow.module.css', { tier: 'container', why: 'list row frame; its cancel/retry/remove controls live inside and declare their own states' }],
  ['BuildPipeline.module.css', { tier: 'container', why: 'pipeline frame: stage nodes, progress and log; the cancel/retry/log controls inside carry their own states' }],
  ['ChunkPreview.module.css', { tier: 'container', why: 'preview panel; it reports rows and totals, no control of its own' }],
  ['CostEstimate.module.css', { tier: 'container', why: 'estimate readout; purely descriptive' }],
  ['BuildPage.module.css', { tier: 'container', why: 'page layout for the strategy configurator; the fields inside carry their own states' }],
  ['RetrievalPage.module.css', { tier: 'container', why: 'diagnostic console layout: query form, health summary and hit cards; the field, switch and button inside carry their own states' }],
  ['SearchToolView.module.css', { tier: 'container', why: 'in-turn tool call card; its expand toggle is a button inside and the citation rows are markers' }],
  ['QuotaNotice.module.css', { tier: 'container', why: 'restricted-state banner; it reports the quota and names the remedy, and its meter is a marker' }],
  ['CreateCollectionDialog.module.css', { tier: 'container', why: 'dialog frame; its close control and fields carry their own states' }],
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
    failures.push(`${rel}: unclassified — add it to TIERS as interactive, marker, container or indicator`)
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
  } else if (declared.tier === 'container' || declared.tier === 'indicator') {
    // Composition and pure-indicator layers: no state rule is demanded, and a
    // hover affordance on a container is not an error either (a card may
    // highlight its border). The colour-literal and bare-size checks below still
    // apply, which is what keeps this tier from becoming a loophole.
    notes.push(`${rel}: ${declared.tier} — ${declared.why}`)
  } else {
    // An unrecognised tier is a typo in TIERS, and treating it as "no rule"
    // would silently exempt the stylesheet from everything.
    failures.push(`${rel}: unknown tier ${JSON.stringify(declared.tier)} — expected interactive, marker, container or indicator`)
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
