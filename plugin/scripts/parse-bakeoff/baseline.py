"""
Step 8 bake-off, baseline side: pymupdf4llm over the same four PDFs and the same
page range as our converter.

Run this with an interpreter from a throwaway venv (see README.md). Nothing here
is a plugin dependency, and the venv is deleted after the run. Emits one JSON
line per input so the two sides can be compared mechanically.

Usage: python scripts/parse-bakeoff/baseline.py [inputList] [outputDir] [pages]
"""

import json
import os
import re
import sys
import time

import pymupdf
import pymupdf4llm

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_INPUTS = os.path.join(PLUGIN, "..", ".workbuddy", "tmp", "bakeoff-inputs.txt")
DEFAULT_OUT = os.path.join(PLUGIN, "..", ".workbuddy", "tmp")

INPUTS = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUTS
OUT = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
PAGE_RANGE = int(sys.argv[3]) if len(sys.argv) > 3 else 20


def hanzi(text: str) -> int:
    """Count Han characters, matching the JS side's \\p{Script=Han}."""
    return len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text))


def headings(text: str) -> int:
    """
    Count ATX headings after stripping inline emphasis.

    pymupdf4llm wraps heading text in **bold**, so `# **Title**` must count the
    same as a plain `# Title` or the comparison would score formatting rather
    than structure. Our side applies the identical rule.
    """
    stripped = text.replace("**", "")
    return len(re.findall(r"(?:^|\n)#{1,6} \S", stripped))


rows = []
with open(INPUTS, encoding="utf-8") as handle:
    lines = [line.rstrip("\r\n") for line in handle if line.strip()]

for line in lines:
    name, path = line.split("\t")
    started = time.time()
    # Clamp the range to the document's own length: pymupdf4llm rejects a page
    # list that runs past the end, and a short cheat sheet must not fail merely
    # for being shorter than the range the long book needs.
    with pymupdf.open(path) as probe:
        available = probe.page_count
    count = min(PAGE_RANGE, available)
    try:
        text = pymupdf4llm.to_markdown(path, pages=list(range(count)))
        error = None
    except Exception as exc:  # noqa: BLE001 - reported as data, not raised
        text = ""
        error = f"{type(exc).__name__}: {exc}"
    row = {
        "name": name,
        "pages": count,
        "ms": int((time.time() - started) * 1000),
        "chars": len(text),
        "hanzi": hanzi(text),
        "headings": headings(text),
        "error": error,
    }
    rows.append(row)
    stem = name.rsplit(".", 1)[0]
    with open(os.path.join(OUT, f"bakeoff-base-{stem}.md"), "w", encoding="utf-8") as out:
        out.write(text)
    print(json.dumps(row, ensure_ascii=False), flush=True)

with open(os.path.join(OUT, "bakeoff-base.json"), "w", encoding="utf-8") as out:
    json.dump(rows, out, ensure_ascii=False, indent=2)
print("wrote " + os.path.join(OUT, "bakeoff-base.json"))
