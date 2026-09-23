# PDF fixtures — sources, licenses and deliberate costs

This directory holds the PDFs `scripts/verify-parse-pdf.mjs` runs against, the
script that regenerates them, and the license for the font they embed.

Regenerate with `node scripts/gen-parse-fixtures.mjs` from `plugin/`.

| file | case | size | embeds CJK font |
|---|---|---|---|
| `latin.pdf` | Latin control — proves the extraction chain is alive | 965 B | no |
| `opaque.pdf` | no text layer at all (what a scan looks like) | 807 B | no |
| `simple.pdf` | single column, two heading levels by size, body paragraphs | 11.4 MB | yes |
| `table.pdf` | a genuinely aligned three-column table | 11.4 MB | yes |
| `twocol.pdf` | two columns sharing a y band | 11.4 MB | yes |

## Why the font is the full Noto Sans SC, not a subset

The task brief called for `fontkit` + a **subset** of Noto Sans SC. That route
does not work, and the measurements are recorded here so nobody re-tries it:

1. **fontkit's TTF subsetter emits no `cmap`.** Both fontkit 2.0.4 and 1.8.1
   produce a subset whose table directory is `head, hhea, loca, maxp, glyf, hmtx`
   — 13 glyphs, 3,117 bytes, and no character-to-glyph mapping at all. Without a
   `cmap` nothing can map `标` back to a glyph.
2. **pdf-lib rejects that subset.** `embedFont(bytes, { subset: true })` fails
   with `Error: Unknown font format`, thrown by `fontkit.create` inside pdf-lib's
   `CustomFontSubsetEmbedder`. So a subsetted CJK font cannot be embedded by
   pdf-lib at all.
3. A related trap worth knowing: `fontkit.create()` **rejects a plain
   `Uint8Array`** ("Unknown font format") but **accepts a Node `Buffer`**
   containing the identical bytes, on both fontkit versions. The generator reads
   the font with `readFileSync` for that reason.

The fallback is therefore to embed the **full font** (`subset: false`). It works:
a pdf-lib PDF embedding the full font reads back through the extraction engine as
`标题一` / `正文段落一` with correct font sizes (24 pt / 12 pt) and an unaffected
Latin control line.

## Why the fixtures weigh ~34 MB, and why that was accepted

pdf-lib writes the entire font into **every document that references it**, and
splitting pages does not share it: measured, a 3-page CJK source is 11,431,942 B
while each single page extracted with `copyPages` is 11,431,590 B. So the font is
paid for once per file that draws Chinese.

That leaves three CJK fixtures at ~11.4 MB each. The alternative — one fixture
with three pages — would hold the total to ~11.4 MB, but `convertPdf(file, opts)`
takes a file and `ParseOptions` is a frozen interface with no page-range
parameter, so two of the three checks could only have been run against a
page-extraction routine reimplemented *inside the gate*. A gate that reimplements
what it tests proves nothing about the shipped converter, so the ~34 MB was
accepted as the price of keeping every check on the real entry point. This was an
explicit decision, reviewed and upheld; it is not an oversight.

The weight cannot be compressed away: the font is 17,773,244 B and deflates to
only 11,305,628 B (gzip 11,305,640) because it is a CJK glyph set, which is
already near-incompressible. That is why each fixture lands at ~11.4 MB.

## The font

| property | value |
|---|---|
| family | Noto Sans SC |
| PostScript name | `NotoSansSC-Thin` |
| version | `Version 2.04;241114210130;non-release` |
| unique subfamily | `2.004;ADBO;NotoSansSC-Thin;ADOBE` |
| glyphs | 31,036 |
| units per em | 1000 |
| variable axes | `wght` 100–900 (default 100) |
| copyright | © 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. |
| license | SIL Open Font License 1.1 — see `fonts/OFL.txt` |
| license URL (from the font's own name table) | http://scripts.sil.org/OFL |
| system path used | `C:/Windows/Fonts/NotoSansSC-VF.ttf` |

The license was read out of the font's own `name` table (nameID 13 declares
"licensed under the SIL Open Font License, Version 1.1" and nameID 14 gives
`http://scripts.sil.org/OFL`), and `fonts/OFL.txt` is the license text from the
upstream `notofonts/noto-cjk` repository's `Sans/LICENSE`. The two agree.

**The font file itself is NOT committed.** The generator reads it from a system
path (see `FONT_CANDIDATES` in `scripts/gen-parse-fixtures.mjs`) and fails with an
explicit list of the paths it tried and what to install. The generated PDFs *are*
committed, which OFL-1.1 permits: condition 5 states that the requirement for
fonts to remain under the license "does not apply to any document created using
the Font Software". `fonts/OFL.txt` is committed alongside because OFL-1.1
condition 2 requires the license to travel with the font software.

## Smaller CJK faces were considered and rejected

No redistributable alternative exists on this machine. The other system CJK
faces — `simhei.ttf` (9.75 MB), `STSONG.TTF` (11.70 MB), `simkai.ttf` (11.79 MB),
`STXIHEI.TTF` (9.77 MB), `SIMLI.TTF`, `simfang.ttf` — are proprietary Microsoft
and Founder/Changzhou SinoType fonts with no redistribution grant, so they cannot
be used for a committed fixture any more than the borrowed-PDF route could. They
are named here so the search is not repeated. Noto Sans SC is under OFL-1.1 and
is the only redistributable option available.

## Known limitation: a two-column page and a two-column table are the same shape

Geometry alone cannot separate them — same runs per line, same cell positions,
same alignment across rows. The converter's rule, chosen to match the measured
behaviour of the `pymupdf4llm` baseline, is:

- **2 cells spanning a line ⇒ columns**, emitted left column in full, then right.
- **≥3 cells ⇒ table.**

The consequence is that a **genuine two-column table is read as two columns** and
loses its tabular form. The baseline makes the same loss on the same input, so the
converter is not worse than the reference implementation here — but it is a real
limitation, not a design intent, and it is recorded rather than hidden.

Measured against the four real Chinese PDFs with this threshold, the table
detector fires on 0–14 lines per document; its false positives are
**table-of-contents pages** (dot leaders read as a column boundary) and **aligned
code listings**, the latter of which caused a false `structured` grade on
`bits_cn.pdf`. See the task report for the full bake-off numbers.

### A table of contents is rendered as a table, and that is intentional

A dot-leader TOC line is genuinely two cells — the entry text and the page
number — separated by a wide gap, so the detector renders it as `| entry | 3 |`
with a separator row. This looks odd in the output but is **not malformed**:
checked across the book's 20-page sample, zero rows have a cell count that
disagrees with their own separator.

It was worth checking rather than assuming: an early look at this same output
appeared to show one-cell rows like `| 全书结构. . . . |` with no second cell,
and therefore a header/separator width mismatch. That was a **truncated
display** — the rows are 113–119 characters long and the closing `| 3 |` was
past the cut. The rows are correct. Recorded here because the apparent defect
invites the same wrong conclusion twice.

A heading-shaped TOC entry still becomes a heading rather than a table row
whenever it clears the size test, which is why the sampled book output keeps
`# 目录` as a heading and puts only the dot-leader lines into the table.

