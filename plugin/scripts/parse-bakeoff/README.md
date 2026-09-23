# PDF bake-off — real-corpus acceptance measurement

These three scripts are the Step 8 acceptance measurement for the PDF converter.
They are **not** part of `npm run verify` and are not a gate: they need input
documents that cannot be committed, and a Python interpreter that is not a plugin
dependency. They exist so the numbers in the task report can be reproduced.

## Why the inputs are not in this repository

The four source PDFs are third-party Chinese documents whose redistribution
license has not been verified. Committing them would be a licensing decision
nobody here is entitled to make, so they stay on the machine that has them and
are referenced by path. This is the same reasoning that made the committed
fixtures use a fully-licensed embedded font rather than a borrowed PDF.

Supply an input list as `<name><TAB><absolute path>` per line:

```
bits_cn.pdf	E:\project\ebooks-master\bits_cn.pdf
bpftrace_cn.pdf	E:\project\ebooks-master\bpftrace_cn.pdf
hermes_cli_cheat_sheet_cn.pdf	E:\project\ebooks-master\hermes_cli_cheat_sheet_cn.pdf
AI-Agents-in-Depth-zh-CN.pdf	E:\project\ai-agent-book\AI-Agents-in-Depth-zh-CN.pdf
```

The default location is `.workbuddy/tmp/bakeoff-inputs.txt` (gitignored). Output
goes to `.workbuddy/tmp/` by default — also gitignored, because it is derived
from documents that are not committed.

## Running it

Build the plugin first; `ours.mjs` imports the compiled output.

```bash
cd plugin && npm run build
```

**Our side** — no venv, no network:

```bash
cd plugin
BAKEOFF_PAGES=20 node scripts/parse-bakeoff/ours.mjs
```

**Baseline side** — `pymupdf4llm` in a throwaway venv. Nothing here enters the
plugin's dependency set, and the venv is deleted afterwards:

```bash
uv venv "$TEMP/kb-bakeoff-venv"
uv pip install --python "$TEMP/kb-bakeoff-venv/Scripts/python.exe" pymupdf4llm
"$TEMP/kb-bakeoff-venv/Scripts/python.exe" scripts/parse-bakeoff/baseline.py
rm -rf "$TEMP/kb-bakeoff-venv"          # or: Remove-Item -Recurse -Force "$env:TEMP\kb-bakeoff-venv"
```

**Verdict** — computes the three criteria from the two sides:

```bash
node scripts/parse-bakeoff/verdict.mjs
```

All three accept `[inputList] [outputDir]` (the Python one adds `[pages]` as a
third positional); run with `--help`-less positional arguments or read the source.
`BAKEOFF_PAGES` / the third argument set the page range, which **must match on
both sides** to keep the comparison fair.

## Expected output shape

Each side prints one JSON object per document and writes a JSON array plus the
full Markdown to the output directory:

```
{"name":"bits_cn.pdf","pages":3,"ms":42,"chars":2763,"hanzi":164,"headings":6,"structure":"inferred","tagged":false,"truncated":false,"failed":false,"error":null}
```

`verdict.mjs` prints a Markdown table and three verdict lines:

```
| 文档 | 汉字(我方/基线) | 覆盖率 ours/base | 覆盖率 shared | 标题(我方/基线) | 恢复率 | structure | tagged | 判定 |
...
criterion 1 (coverage >= 95%, ours/base):  PASS
criterion 2 (headings >= 80%):           FAIL
criterion 3 (zero false structured):     PASS
OVERALL: FAIL
```

Files produced, all under the output directory: `bakeoff-ours-<stem>.md`,
`bakeoff-ours.json`, `bakeoff-base-<stem>.md`, `bakeoff-base.json`,
`bakeoff-verdict.json`.

## Reading the result

**Both sides count headings identically**: inline `**` emphasis is stripped
first, because `pymupdf4llm` wraps heading text in bold and counting that
differently would score formatting rather than structure.

**Two coverage ratios are printed, and only one is the criterion.** The briefed
criterion is `ours / baseline`; that is the column the verdict uses. The `shared`
column divides by the larger of the two counts, so it cannot exceed 100% and
therefore exposes a text loss the briefed ratio would hide. They differ on
`bits_cn.pdf`, where the baseline decodes the file badly enough to find only 35
Han characters against our 164 — a case worth seeing rather than averaging away.

**Page range.** The book costs roughly 5 s per 20 pages in the baseline, so both
sides are bounded to 20 pages. The three short documents are clamped to their own
length, because `pymupdf4llm` rejects a page list that runs past the end.

## Result as measured (2026-09-23, Task 1)

20 pages on both sides; `pymupdf` 1.28.2.

| document | hanzi ours/base | coverage | headings ours/base | recovery | structure | verdict |
|---|---|---|---|---|---|---|
| AI-Agents-in-Depth-zh-CN.pdf | 14669 / 14669 | 100.0% | 19 / 18 | 105.6% | inferred | PASS |
| bits_cn.pdf | 164 / 35 | 100.0% | 6 / 5 | 120.0% | inferred | PASS |
| bpftrace_cn.pdf | 545 / 545 | 100.0% | 15 / 12 | 125.0% | inferred | PASS |
| hermes_cli_cheat_sheet_cn.pdf | 1863 / 1767 | 100.0% | 12 / 32 | **37.5%** | inferred | FAIL |

Criterion 1 and criterion 3 pass; criterion 2 fails on the dense multi-block
cheat sheet, which needs a real block-segmentation stage rather than a threshold.
See `task-1-report.md` for the diagnosis and the named adapter follow-up.
