# 文档解析实现计划（PDF 优先）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pdf` / `docx` / `html` / `xlsx` / `csv` / `json` 从「上传即拒」变为可索引，
产物必须带 ATX 标题、管道表、围栏代码块，PDF 优先落地。

**Architecture:** 解析从上传时移到构建流水线既有的 `parse` 阶段（`build.ts:258`）。
上传期只保留**廉价预检**（有没有文本层、能不能打开），不合格的上传即拒并给可执行 remedy。
解析产出的 Markdown 存入 `documents.jsonl` 的 `text`，并新增正交的 `structure` 维度
（`structured` / `inferred` / `flat-text`）如实上报结构保真度。单篇解析失败记在该文档上，
**绝不使整场构建失败**。

**Tech Stack:** Node 22+/24+ ESM（host 侧）；`unpdf`（PDF，2.4 MB）或 `pdfjs-dist`
（34.8 MB，阶段 1 定）；`mammoth`（DOCX）；`hast-util-*` / `mdast-util-*`（HTML→MD 主干）；
`read-excel-file`（XLSX）；`papaparse`（CSV）；JSON 用本地函数。

**Spec:** `docs/superpowers/specs/2026-09-23-knowledge-plugin-generation-and-rag-design.md` §8
（选型论证全文在 `issues/文档解析-技术方案调研.md`）

## Global Constraints

- **依赖不得新增安装摩擦**：任何带 `install`/`postinstall`、需 node-gyp、装期下载二进制的依赖一律排除。
  用户已有的 allowlist 手续只针对 `@zvec/zvec`，**不得再增加一项**。
- **门禁不得需要外网或 API key**：`npm run verify` 全链必须离线可跑。
- **许可证须与 MIT 组合**：本包 `license: "MIT"` 且以源码经 `dsh plugin add` 分发。
- **产物格式判据（五条，直接门禁化）**：
  1. `/(?:^|\n)#{1,6} \S/` 命中数 ≥ 样例标题数
  2. 存在 `/^\|.*\|\s*$/` 行且其后一行匹配 `/^\|[\s:|-]+\|\s*$/`
  3. 存在成对的 ``` 或 `~~~` 围栏
  4. 产物中不出现 `\r`
  5. 无结构时必须返回 `flat-text` 标记，不得假装结构化
- **`sources/` 原件字节级保留，永不覆写**；派生文本必须可从原件重算。
- **单篇解析失败不得使整场构建 `ok: false`**。
- **三个扩展名清单必须同源**：`store/documents.ts` 的 `ACCEPTED_EXTENSIONS`、
  `client/pages/DocumentsPage.tsx`、`store/extract.ts` 的 `SUPPORT` 键集。
- **不要在一个进程里同时 import 两份 pdfjs**（实测 worker 版本冲突：`The API version "6.3.289"
  does not match the Worker version "6.1.200"`）。引擎对照实验必须分进程跑。
- 命令均在 `plugin/` 目录下执行；`npm` 而非 `pnpm`（本机 pnpm 11.22.0 hoist 阶段失败）。

---

## Task 0: 判据与数据结构（不改产品行为）

先做判据与类型，因为它们被后面每个转换器消费，且判据自身必须可被负向自证。

**Files:**
- Create: `plugin/src/store/parse/grade.ts`
- Create: `plugin/scripts/verify-parse-grade.mjs`
- Modify: `plugin/src/store/documents.ts`（`DocumentRecord` 加字段）
- Modify: `plugin/package.json`（挂 `verify:parse-grade`）

**Interfaces:**
- Produces: `type StructureLevel = 'structured' | 'inferred' | 'flat-text'`；
  `gradeMarkdown(text: string): StructureLevel`；
  `DocumentRecord.structure?: StructureLevel`、`parsedAt?: string`、`converter?: string`。

- [ ] **Step 1: 写失败的门禁**

`plugin/scripts/verify-parse-grade.mjs`：

```js
import { gradeMarkdown } from '../lib/store/parse/grade.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 合格样本：ATX 标题 + 管道表（表头行 + 分隔行）+ 三反引号围栏
const good = [
  '# 标题',
  '',
  '正文段落。',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '```',
].join('\n')

check('合格样本判 structured', gradeMarkdown(good) === 'structured')

// 负向样本：setext 标题（turndown 默认产物）
const setext = '标题\n====\n\n正文'
check('setext 标题不合格（不得 structured）', gradeMarkdown(setext) !== 'structured')

// 负向样本：缩进代码块（turndown 默认产物）
const indented = '# 标题\n\n    缩进代码\n'
check('缩进代码不算围栏', gradeMarkdown(indented) !== 'structured')

// 负向样本：缺分隔行的表
const noSep = '# 标题\n\n| 列A | 列B |\n| 1 | 2 |\n'
check('缺分隔行的表不合格', gradeMarkdown(noSep) !== 'structured')

// CRLF 输入
check('CRLF 判 flat-text', gradeMarkdown('# 标题\r\n\r\n正文\r\n') === 'flat-text')

// 纯段落
check('纯段落判 flat-text', gradeMarkdown('就是一段话，没有结构。') === 'flat-text')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑门禁确认它失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-grade.mjs`
Expected: FAIL — `Cannot find module '../lib/store/parse/grade.js'`

- [ ] **Step 3: 实现判据**

`plugin/src/store/parse/grade.ts`：

```ts
/**
 * Whether a converted document kept the structure the chunker reads.
 *
 * The chunker scans for ATX headings, locates tables by their separator row and
 * flips a protected region on fenced code. A converter that flattens a document
 * into prose produces text that indexes fine and retrieves badly: every chunk
 * loses its section path. That is the failure this module makes measurable.
 *
 * Deliberately a pure function over text: the answer is a fact about the
 * produced bytes, not about which converter produced them, so it can be asserted
 * in a gate without a parser.
 *
 * @module dsh-zvec-knowledge/store/parse/grade
 */

/** How much document structure survived conversion. */
export type StructureLevel =
  /** Headings, tables and fences all survived. */
  | 'structured'
  /** Some structure was reconstructed by inference, not read from the source. */
  | 'inferred'
  /** No usable structure; heading-based chunking will degrade to one section. */
  | 'flat-text'

/** Matches an ATX heading line, the chunker's own section marker. */
const ATX = /(?:^|\n)#{1,6} \S/g
/** A table row with at least one cell boundary. */
const TABLE_ROW = /^\|.*\|\s*$/m
/** The separator row that follows a table header, as `chunk.ts` requires. */
const TABLE_SEP = /^\|[\s:|-]+\|\s*$/m
/** A fenced code block delimiter, three backticks or three tildes. */
const FENCE = /^(?:```|~~~)/m

/**
 * Grade one converted document.
 *
 * A CRLF line ending is reported as `flat-text` rather than thrown: it is a
 * real, already-recorded silent failure (`^(#{1,6})\s+(.*)$` never matches when
 * `$` sits before `\r`), and the honest answer is "structure not recovered".
 * @param text - the converted Markdown.
 * @returns the highest structure level the text actually supports.
 */
export function gradeMarkdown(text: string): StructureLevel {
  if (text.includes('\r')) return 'flat-text'

  const headings = text.match(ATX)?.length ?? 0
  if (headings === 0) return 'flat-text'

  const hasTable = TABLE_ROW.test(text) && hasSeparatorAfterHeader(text)
  const hasFence = FENCE.test(text)
  // A heading alone is not enough: an outline with no body structure still
  // retrieves as one heading plus flat prose.
  return hasTable || hasFence ? 'structured' : 'inferred'
}

/**
 * Whether some table row is immediately followed by its separator row.
 *
 * Checked pairwise rather than with a single multiline regex so a separator
 * anywhere in the document cannot vouch for a header it does not follow.
 * @param text - the converted Markdown.
 * @returns true when at least one header/separator pair exists.
 */
function hasSeparatorAfterHeader(text: string): boolean {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW.test(lines[i]) && TABLE_SEP.test(lines[i + 1])) return true
  }
  return false
}
```

- [ ] **Step 4: 加 `DocumentRecord` 字段**

在 `plugin/src/store/documents.ts` 的 `DocumentRecord`（`:34`）内，`chunks` 附近加：

```ts
  /** How much structure the converted text kept; absent until parsed. */
  structure?: StructureLevel
  /** When the derived text was last produced from the original. */
  parsedAt?: string
  /** Which converter produced `text`; a change forces a full rebuild. */
  converter?: string
```

并在文件顶部加 `import type { StructureLevel } from './parse/grade.ts'`。

- [ ] **Step 5: 挂门禁并跑通**

在 `plugin/package.json` 的 `scripts` 加：

```json
"verify:parse-grade": "node scripts/verify-parse-grade.mjs",
```

Run: `cd plugin && npm run build && npm run verify:parse-grade`
Expected: `7 passed, 0 failed`，exit 0

- [ ] **Step 6: 负向自证（判据不得是永真）**

临时把 `ATX` 改成 `/^#{1,6}\s*$/gm`（永不匹配真实标题）并跑门禁，
Expected: 至少「合格样本判 structured」变红。**改回。**

- [ ] **Step 7: Commit**

```bash
cd plugin && git add src/store/parse/grade.ts src/store/documents.ts scripts/verify-parse-grade.mjs package.json
git commit -m "feat(parse): 判据与 structure 维度，先让结构保真可测"
```

---

## Task 1: PDF —— 行重建与结构推断（优先做，它决定语料能否进来）

PDF 是本设计里唯一需要自研结构推断的格式：`getTextContent()` 只给带位置矩阵的
`TextItem` 列表，**官方未承诺顺序，也未承诺任何标题语义**。

**Files:**
- Create: `plugin/src/store/parse/pdf.ts`
- Create: `plugin/src/store/parse/fixtures/`（PDF fixtures）
- Create: `plugin/scripts/gen-parse-fixtures.mjs`
- Create: `plugin/scripts/verify-parse-pdf.mjs`
- Modify: `plugin/package.json`（依赖 + 门禁）

**Interfaces:**
- Consumes: `gradeMarkdown`, `StructureLevel`（Task 0）
- Produces: `convertPdf(file: string, opts: ParseOptions): Promise<ParseResult>`；
  `interface ParseResult { text: string, structure: StructureLevel, truncated: boolean, failed?: boolean, error?: string, tagged?: boolean }`；
  `interface ParseOptions { timeoutMs: number, maxPages: number, maxTextBytes: number, signal?: AbortSignal }`

- [ ] **Step 1: 决定引擎（二选一，先做对照实验）**

调研实测：四份真机中文 PDF 全部「内嵌子集字体 + Identity/UCS 编码」，
`unpdf` 与 `pdfjs-dist` 抽取**字符数完全相等**，`unpdf` 仅 2.4 MB 而 `pdfjs-dist` 解压 34.8 MB。

写一次性对照脚本（`.workbuddy/tmp/`，不入库），对同一份中文 PDF **分两个进程**分别跑：

```js
// 进程 A
const { extractText } = await import('unpdf')
// 进程 B
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
```

**判定**：若 `unpdf` 在两份 fixture 上字符数与 pdfjs 相等 → 选 `unpdf`（省 32 MB）。
若不等或报错 → 选 `pdfjs-dist`，并在 README 记录原因。
**把结论与实测数字写进本任务的 commit message。**

- [ ] **Step 2: 生成 PDF fixtures**

`plugin/scripts/gen-parse-fixtures.mjs`：用 `pdf-lib`（devDependency，只用于造 fixture，不进运行时依赖）
产出三份最小中文 PDF：

1. `simple.pdf` —— 单栏，含两级标题（用不同字号）+ 一段正文
2. `table.pdf` —— 含一个对齐的表格
3. `twocol.pdf` —— 双栏（同一 y 上两组不同 x 区间）

```js
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFileSync, mkdirSync } from 'node:fs'

mkdirSync('src/store/parse/fixtures', { recursive: true })
// 注意：pdf-lib 的标准字体不含中文。中文 fixture 须用内嵌字体，
// 或改用从机器上已有的中文 PDF 复制（记录来源）。见 Step 3 的说明。
```

**中文 fixture 的现实约束**：`pdf-lib` 的 `StandardFonts` 不含 CJK 字形。
**已裁决的路线（用户决定）**：用 `fontkit` + **Noto Sans SC（OFL-1.1）子集嵌入**。

- 字体文件放 `plugin/src/store/parse/fixtures/fonts/`，**必须**同时提交
  `OFL.txt`（OFL-1.1 要求随字体分发许可全文）。
- 在 `fixtures/SOURCES.md` 记录：字体名、版本、下载 URL、许可（OFL-1.1）、
  以及它是**子集**（只嵌 fixture 用到的字形，不是整份字体）。
- `fontkit` 与 `pdf-lib` 均为 **devDependency**（只用于造 fixture，不进运行时依赖，
  因此不影响安装摩擦约束）。

**另一条路（记录备查，不采用）**：从机器上现成的中文 PDF 取一份。
不采用的理由是它无法保证「许可允许再分发」，而 fixture 要提交进仓库。

**必须同时提交一份拉丁对照 fixture**，因为「引擎返回空文本」时无法区分是解析器坏了
还是 fixture 不合法——调研 §11.4 正是踩了这个坑（手写 Type0 fixture 连拉丁对照组都取不到文本）。

- [ ] **Step 3: 写失败的门禁**

`plugin/scripts/verify-parse-pdf.mjs`：

```js
import { convertPdf } from '../lib/store/parse/pdf.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const opts = { timeoutMs: 60_000, maxPages: 2000, maxTextBytes: 8 * 1024 * 1024 }

// 拉丁对照：引擎若连这个都取不到，说明是 fixture 或 worker 配置坏了
const latin = await convertPdf('src/store/parse/fixtures/latin.pdf', opts)
check('拉丁对照非空（证明链路可用，非 fixture 坏）', latin.text.trim().length > 0, `len=${latin.text.length}`)

const simple = await convertPdf('src/store/parse/fixtures/simple.pdf', opts)
check('中文不乱码', /[\u4e00-\u9fff]/.test(simple.text))
check('产出 ATX 标题', /(?:^|\n)#{1,6} \S/.test(simple.text))
check('无 CRLF', !simple.text.includes('\r'))

const table = await convertPdf('src/store/parse/fixtures/table.pdf', opts)
check('表格产出管道表', /\|.*\|/.test(table.text))

const twocol = await convertPdf('src/store/parse/fixtures/twocol.pdf', opts)
// 双栏必须按栏成段：右栏内容不得插进左栏中间
check('双栏不交错', !/左栏末.*右栏首.*左栏中/s.test(twocol.text))

// 无标签 PDF 的 inferred 不得冒充 structured
check('无标签 PDF 永不判 structured',
  simple.structure !== 'structured' || simple.tagged === true)

// workerSrc 陷阱：给 Windows 路径会让 pdfjs 静默返回空文本而不抛错
check('空产物必须显式失败而非静默通过', true) // 由上面的「拉丁对照非空」承担

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 4: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-pdf.mjs`
Expected: FAIL — `Cannot find module '../lib/store/parse/pdf.js'`

- [ ] **Step 5: 实现 PDF 解析**

`plugin/src/store/parse/pdf.ts` 的三段结构：

```ts
/**
 * PDF → Markdown.
 *
 * The engine gives positioned text runs and nothing else: `getTextContent()`
 * documents neither the order of `items` nor any heading semantics. So structure
 * has to be rebuilt here, in three ordered steps, and the *provenance* of that
 * structure has to be reported honestly rather than assumed:
 *
 * 1. **Line rebuilding** — group runs by the y component of their transform and
 *    sort by x. Flow order alone would interleave the columns of a two-column
 *    page.
 * 2. **Tagged structure first** — with `includeMarkedContent`, a tagged PDF
 *    carries its own H1..H6 / P / Table tags. When present they are the
 *    document's own claim, so they win.
 * 3. **Font-size clustering as fallback** — lines markedly larger than the body
 *    mode become headings. This is a guess, and every line it produces is
 *    reported as `inferred`, never as `structured`, so a reader is never told a
 *    guessed heading was the document's own.
 *
 * Two Windows traps are handled here because both fail silently:
 * `workerSrc` needs a `file://` URL (a Windows path makes the engine fall back
 * to a fake worker, log, and return empty text without throwing), while
 * `cMapUrl` and `standardFontDataUrl` need forward-slash absolute paths with a
 * trailing slash. One helper for all three would be wrong for one of them.
 *
 * @module dsh-zvec-knowledge/store/parse/pdf
 */

import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { StructureLevel } from './grade.ts'

/** Bounded resource envelope; values arrive from config, never hardcoded here. */
export interface ParseOptions {
  /** Wall-clock ceiling for one document. */
  timeoutMs: number
  /** Page ceiling, so a huge scan cannot monopolise the loop. */
  maxPages: number
  /** Ceiling on produced text bytes. */
  maxTextBytes: number
  /** Cancellation from the build pipeline. */
  signal?: AbortSignal
}

/** One converter's output. */
export interface ParseResult {
  /** The converted Markdown. */
  text: string
  /** How much structure survived; see `grade.ts`. */
  structure: StructureLevel
  /** Whether a ceiling truncated the output. */
  truncated: boolean
  /**
   * Whether conversion failed for this document.
   *
   * A field rather than a throw: the build's parse stage treats one document's
   * failure as data about that document, and an exception there would be caught
   * by the pipeline's outer guard and fail the whole build.
   */
  failed?: boolean
  /** Why conversion failed, in the user's language. Present iff `failed`. */
  error?: string
  /**
   * Whether the structure came from the document's own tag tree.
   *
   * Only PDF sets this. It exists so a gate can assert that an inferred
   * structure is never reported as the document's own claim: a guess that
   * presents itself as `structured` is worse than an honest `inferred`.
   */
  tagged?: boolean
}

/** Where the engine's auxiliary data lives, resolved from the installed package. */
function assetDirs(): { worker: string, cmaps: string, standardFonts: string } {
  const require = createRequire(import.meta.url)
  const root = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, '')
  // workerSrc must be a file:// URL; the other two must NOT be.
  return {
    worker: pathToFileURL(`${root}build/pdf.worker.mjs`).href,
    cmaps: `${root}cmaps/`.replace(/\\/g, '/'),
    standardFonts: `${root}standard_fonts/`.replace(/\\/g, '/'),
  }
}

/** {@link convertPdf} */
export async function convertPdf(file: string, opts: ParseOptions): Promise<ParseResult> {
  // ... 实现见后续 step
}
```

**实现要点**（逐步填实，每步跑一次门禁）：

1. 载入文档：`getDocument({ data, cMapUrl, cMapPacked: true, standardFontDataUrl, useWorkerFetch: false })`
2. 逐页 `await page.getTextContent({ includeMarkedContent: true })`，**每页检查 `opts.signal`**
3. 行重建：按 `transform[5]`（y）分组（容差取正文行高的一半），组内按 `transform[4]`（x）排序
4. 结构：先读标记内容；无标记则按 `height` 众数聚类判标题
5. 表格：同一 y 上多个 x 簇 + 相邻行 x 簇对齐 → 管道表 + 分隔行
6. 产出前统一 `\n`，按 `maxTextBytes` 截断并置 `truncated`

- [ ] **Step 6: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-pdf`
Expected: `8 passed, 0 failed`，exit 0

- [ ] **Step 7: 负向验证 workerSrc 陷阱**

把 `assetDirs().worker` 临时改成 Windows 路径（`root + 'build/pdf.worker.mjs'`）并跑门禁。
Expected: **「拉丁对照非空」必须变红**。若它是绿的，说明门禁只断言了"不抛错"——
那正是调研 §11.4 记录的最阴险假绿。**改回。**

- [ ] **Step 8: Commit**

```bash
cd plugin && git add src/store/parse/pdf.ts scripts/gen-parse-fixtures.mjs scripts/verify-parse-pdf.mjs package.json src/store/parse/fixtures
git commit -m "feat(parse): PDF 行重建与结构推断，含 workerSrc 路径陷阱门禁"
```

---

## Task 2: 上传期预检与拒绝文案

**Files:**
- Modify: `plugin/src/store/extract.ts`
- Modify: `plugin/package.json`（门禁）
- Create: `plugin/scripts/verify-parse-preflight.mjs`

**Interfaces:**
- Consumes: `ParseResult`（Task 1）
- Produces: `ExtractionKind` 加 `'converted'`；
  `ExtractionSupport` 加 `converter?` 与 `preflight?(file): {ok:true} | {ok:false, remedy:string}`。

- [ ] **Step 1: 写失败的门禁**

```js
import { extractionSupport } from '../lib/store/extract.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

check('md 仍为 verbatim', extractionSupport('a.md').kind === 'verbatim')
check('txt 仍为 verbatim', extractionSupport('a.txt').kind === 'verbatim')
check('pdf 为 converted', extractionSupport('a.pdf').kind === 'converted')
check('docx 为 converted', extractionSupport('a.docx').kind === 'converted')
check('html 为 converted', extractionSupport('a.html').kind === 'converted')
check('csv 为 converted', extractionSupport('a.csv').kind === 'converted')
check('json 为 converted', extractionSupport('a.json').kind === 'converted')
check('无扩展名仍 unsupported', extractionSupport('noext').kind === 'unsupported')

// 预检：扫描件必须在上传期被拒，且 remedy 明说本插件不含 OCR
const scan = await extractionSupport('a.pdf').preflight?.('src/store/parse/fixtures/scanned.pdf')
check('扫描件上传期被拒', scan?.ok === false)
check('扫描件 remedy 提到 OCR', /OCR/.test(scan?.remedy ?? ''))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-preflight.mjs`
Expected: FAIL — `pdf 为 converted`（当前是 `needs-conversion`）

- [ ] **Step 3: 改 `extract.ts`**

```ts
/** How a format is turned into indexable text. */
export type ExtractionKind =
  /** The bytes already are the text; decode and store verbatim. */
  | 'verbatim'
  /** Recognised, and a built-in converter runs at build time. */
  | 'converted'
  /** Recognised, but no converter is wired: refuse with a remedy. */
  | 'needs-conversion'
  /** Not a text format at all. */
  | 'unsupported'

/** Which built-in converter handles a format. */
export type ConverterId = 'pdf' | 'docx' | 'html' | 'xlsx' | 'csv' | 'json'

/** What this module can do with one extension. */
export interface ExtractionSupport {
  /** Which handling applies. */
  kind: ExtractionKind
  /** Which converter runs when `kind` is 'converted'. */
  converter?: ConverterId
  /**
   * A cheap upload-time probe that can refuse before a record is written.
   *
   * Deliberately not a parse: this must stay affordable on the request path, so
   * it only answers "is there any text to extract / can this be opened at all".
   * The expensive conversion belongs to the build pipeline.
   * @param file - absolute path of the just-written original.
   */
  preflight?: (file: string) => Promise<{ ok: true } | { ok: false, remedy: string }>
  /** The converter or remedy to name when `kind` is neither verbatim nor converted. */
  remedy?: string
}
```

`SUPPORT` 表按此更新：`pdf` → `{kind:'converted', converter:'pdf', preflight: pdfPreflight}`，
`docx`/`html`/`htm`/`csv`/`json`/`xlsx` → `{kind:'converted', converter: ...}`。

**`needs-conversion` 只剩真正无解的入口**（未知扩展名由 `unsupported` 承担）。

- [ ] **Step 4: 实现 PDF 预检**

```ts
/**
 * Refuse a PDF that cannot yield text, before a record is written.
 *
 * Only affordable checks: open the document, read page one, count non-blank
 * characters. A scan has no text layer, so the honest answer at upload time is
 * "this plugin has no OCR" rather than a successful upload that builds to
 * nothing — the worst available failure, since the user cannot tell a scan from
 * a broken plugin.
 * @param file - absolute path of the stored original.
 * @returns ok, or a refusal naming the remedy.
 */
async function pdfPreflight(file: string): Promise<{ ok: true } | { ok: false, remedy: string }> {
  // 打不开或要口令 → 明确拒绝并说要导出去权限副本
  // 第 1 页文本运行数 ≈ 0 且 numPages > 0 → 扫描件，remedy 说明需先离线 OCR
  // 否则 ok
}
```

**注意**：预检不得解析全文（32 MiB 全文抽取是 CPU 密集，会压在宿主循环上）。

- [ ] **Step 5: 生成扫描件 fixture 并跑门禁**

`gen-parse-fixtures.mjs` 追加一份无文本层的 `scanned.pdf`（一张图，无文字对象）。

Run: `cd plugin && npm run build && npm run verify:parse-preflight`
Expected: `11 passed, 0 failed`

- [ ] **Step 6: 三处扩展名清单同源**

在 `verify-parse-preflight.mjs` 追加断言：`ACCEPTED_EXTENSIONS` 与 `SUPPORT` 键集一致。
`ACCEPTED_EXTENSIONS`（`documents.ts:74`）现为
`['md','markdown','txt','pdf','docx','html','htm','json','csv']`，**须补 `xlsx`**；
`DocumentsPage.tsx:32` 同步。

Run: `cd plugin && npm run build && npm run verify:parse-preflight`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
cd plugin && git add src/store/extract.ts src/store/documents.ts src/client/pages/DocumentsPage.tsx scripts/verify-parse-preflight.mjs scripts/gen-parse-fixtures.mjs package.json
git commit -m "feat(parse): 上传期廉价预检，扫描件与加密 PDF 上传即拒"
```

---

## Task 3: 构建流水线的 parse 阶段

这是把解析接进产品行为的一步，也是最容易做错的一步：**单篇失败绝不能拖垮整场构建**。

**Files:**
- Modify: `plugin/src/store/build.ts:99-130`（`DocumentBuildRequest`）
- Modify: `plugin/src/store/build.ts:258-263`（`enter('parse')` 与 `enter('chunk')` 之间）
- Create: `plugin/scripts/verify-parse-build.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Consumes: `convertPdf`（Task 1）、`extractionSupport`（Task 2）
- Produces: `DocumentBuildRequest.source?: { file: string, converter: ConverterId, reparse: boolean }`；
  `enter('parse')` 逐文档转换并回填。

- [ ] **Step 1: 写失败的门禁**

```js
import { startBuild } from '../lib/store/build.js'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 一篇好 docx + 一篇损坏 docx：好的必须建成，坏的记 failed，
// 整场构建仍须 ok（这是关键不变量）
const dir = mkdtempSync(join(tmpdir(), 'kbparse-'))
// ... 构造两篇文档并 startBuild

check('好文档产出 text', true)
check('坏文档 status=failed 且有 error', true)
check('单篇失败不使整场失败', buildResult.ok === true)
check('产物无 CRLF', !goodText.includes('\r'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-build.mjs`
Expected: FAIL — `DocumentBuildRequest` 无 `source` 字段，解析未接入

- [ ] **Step 3: 扩 `DocumentBuildRequest`**

```ts
/** One document entering a build. */
export interface DocumentBuildRequest {
  // ... 既有字段
  /**
   * Where to re-read the text from, when the text is not already materialised.
   *
   * Optional so callers that already hold text — including the existing
   * build-job gates — keep working unchanged.
   */
  source?: {
    /** Absolute path of the stored original. */
    file: string
    /** Which converter to run. */
    converter: ConverterId
    /** Force re-conversion even when `text` is already present. */
    reparse: boolean
  }
}
```

- [ ] **Step 4: 在 parse 阶段插入逐文档解析**

`build.ts` 的 `enter('parse')`（`:258`）之后、`enter('chunk')`（`:263`）之前：

```ts
enter('parse')
// Report by document first: the chunk count is not known until chunking runs,
// and a progress bar that only moves after chunking looks stalled.
progress('parse', 0, requests.length)
const kept: DocumentBuildRequest[] = []
for (const doc of requests) {
  if (aborted()) return cancelled(...)
  // Each document is converted inside its own guard. One unreadable PDF must
  // not cost the whole build: the pipeline's outer try/catch discards the slot
  // and fails everything, which would make a single bad upload destroy a
  // collection's index. Only systemic faults (storage, quota) fail the build.
  try {
    const text = doc.source
      ? (await convert(doc.source, parseOptions(doc))).text
      : doc.text
    const structure = doc.source ? gradeMarkdown(text) : undefined
    patchDocument(doc.id, { text, structure, parsedAt: new Date().toISOString(), converter: doc.source?.converter })
    if (text.trim() !== '') kept.push({ ...doc, text })
    else failDocument(doc.id, '解析后无文本内容（可能是纯图片页或空表）')
  } catch (error) {
    failDocument(doc.id, describeParseFailure(error, doc.source?.converter))
  }
  progressByDocument()
  await yieldToEventLoop()
}
requests = kept
enter('chunk')
```

**同时**：把「`structure` 或 `converter` 变化」并入增量构建的强制全量理由——
否则新旧解析产物混排会让 `documents.jsonl` 的行号引用漂移，而 KB-13 的引用溯源依赖它。

- [ ] **Step 5: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-build`
Expected: 4 passed, 0 failed

- [ ] **Step 6: 回归 —— 既有构建门禁必须仍全绿**

Run: `cd plugin && npm run verify:buildjob && npm run verify:incremental`
Expected: 两者 exit 0（不带 `source` 的调用路径行为不变）

- [ ] **Step 7: Commit**

```bash
cd plugin && git add src/store/build.ts scripts/verify-parse-build.mjs package.json
git commit -m "feat(parse): 解析接进构建 parse 阶段，单篇失败不拖垮整场"
```

---

## Task 4: HTML → Markdown 共享主干

**先于 DOCX 做**：DOCX 经 mammoth 产出 HTML，再走这条主干，所以主干必须先在。
一份实现、一份测试，同时服务 `html` 直传与 `docx`。

**Files:**
- Create: `plugin/src/store/parse/html.ts`
- Create: `plugin/scripts/verify-parse-html.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Produces: `htmlToMarkdown(html: string): string`（**Task 5 消费它**）

- [ ] **Step 1: 写失败的门禁**

```js
import { htmlToMarkdown } from '../lib/store/parse/html.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const out = htmlToMarkdown(`
<h1>标题一</h1><h2>标题二</h2>
<p>正文</p>
<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>
<pre><code class="language-ts">const x = 1</code></pre>
<script>alert(1)</script><style>p{}</style>
<a href="javascript:alert(1)">坏链</a>
`)

check('h1 → #', /(?:^|\n)# /.test(out))
check('h2 → ##', /(?:^|\n)## /.test(out))
check('表格 → 管道表', /\|.*\|/.test(out))
check('表头后有分隔行', /^\|[\s:|-]+\|\s*$/m.test(out))
check('pre/code → 三反引号围栏', /^```/m.test(out))
check('script 不进入产物', !out.includes('alert'))
check('style 不进入产物', !out.includes('p{}'))
check('javascript: 链接被丢弃', !out.includes('javascript:'))
check('无 CRLF', !out.includes('\r'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-html.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```ts
/**
 * HTML → Markdown, the trunk shared by direct HTML uploads and DOCX.
 *
 * The pipeline is `hast-util-from-html` → `hast-util-to-mdast` →
 * `mdast-util-to-markdown`, chosen over `turndown` for one decisive reason: this
 * combination's **defaults are already what the chunker reads** — ATX headings
 * and forced fences — so forgetting to configure something cannot silently
 * degrade the output. Turndown's three relevant defaults are all the opposite
 * (setext headings, indented code, tables unhandled), which produces a document
 * that indexes fine and loses every section path.
 *
 * Four things are set explicitly because their absence is silent:
 * 1. the GFM table extension is registered — without it table nodes are dropped;
 * 2. `setext` is pinned to false, so an upstream default change cannot reach us;
 * 3. `href`s with `javascript:` or `data:` targets are dropped (mammoth's own
 *    README warns that source documents can carry them);
 * 4. output line endings are normalised to `\n`, since a `\r` defeats the
 *    chunker's heading regex.
 *
 * @module dsh-zvec-knowledge/store/parse/html
 */
```

- [ ] **Step 4: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-html`
Expected: 9 passed, 0 failed

- [ ] **Step 5: 负向自证 gfm-table 注册**

注释掉 `mdast-util-gfm-table` 的注册并跑门禁。
Expected: 「表格 → 管道表」与「表头后有分隔行」变红。**恢复。**

- [ ] **Step 6: Commit**

```bash
cd plugin && git add src/store/parse/html.ts scripts/verify-parse-html.mjs package.json
git commit -m "feat(parse): HTML→Markdown 共享主干，默认值即切分器所需格式"
```

---

## Task 5: DOCX

调研已把风险定死：**触发条件是 styleId 而非显示语言**。中文 Word 的内置样式 ID
仍是 `Heading1`，默认映射已覆盖「英文 styleId + 任意语言名字」；会漏的是非 Word 生成器
把 styleId 写成 `1`/`a1`，同时 `w:name` 也不是英文规范名。

**Files:**
- Create: `plugin/src/store/parse/docx.ts`
- Modify: `plugin/scripts/gen-parse-fixtures.mjs`（OOXML fixtures）
- Create: `plugin/scripts/verify-parse-docx.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Consumes: `ParseResult`, `ParseOptions`（Task 1）
- Produces: `convertDocx(file: string, opts: ParseOptions): Promise<ParseResult>`

- [ ] **Step 1: 生成 OOXML fixtures**

用 `jszip`（mammoth 自带依赖）手写最小 OOXML，覆盖调研 §10.1 的六种变体，其中三种必须入库：

| fixture | styleId | w:name | 期望 |
|---|---|---|---|
| `docx-en.docx` | `Heading1` | `Heading 1` | `#` |
| `docx-zh.docx` | `Heading1` | `标题 1` | `#`（中文名不致命） |
| `docx-nonstd.docx` | `1` | `标题 1` | `#`（**默认映射会漏，靠推导式映射**） |
| `docx-outline.docx` | 自定义 | 自定义 + 仅 `w:outlineLvl` | 对应层级（**mammoth 完全忽略 outlineLvl**） |

另加 `docx-withimage.docx`（含内嵌图片，断言产物不含 `data:image/`）与 `docx-zipbomb.docx`。

- [ ] **Step 2: 写失败的门禁**

```js
import { convertDocx } from '../lib/store/parse/docx.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const opts = { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 8 * 1024 * 1024 }

const en = await convertDocx('src/store/parse/fixtures/docx-en.docx', opts)
check('英文样式名 → #', /(?:^|\n)# /.test(en.text))

const zh = await convertDocx('src/store/parse/fixtures/docx-zh.docx', opts)
check('中文名 + 英文 styleId → #', /(?:^|\n)# /.test(zh.text))

const nonstd = await convertDocx('src/store/parse/fixtures/docx-nonstd.docx', opts)
check('数字 styleId 仍 → #（推导式映射的存在理由）', /(?:^|\n)# /.test(nonstd.text))

const outline = await convertDocx('src/store/parse/fixtures/docx-outline.docx', opts)
check('仅 outlineLvl 的自定义样式 → 对应层级', /(?:^|\n)# /.test(outline.text))

const img = await convertDocx('src/store/parse/fixtures/docx-withimage.docx', opts)
check('图片不产生 base64', !img.text.includes('data:image/'))
check('产物体量可控', Buffer.byteLength(img.text) < 512 * 1024)

const bomb = await convertDocx('src/store/parse/fixtures/docx-zipbomb.docx', opts)
check('zip bomb 被拒而非 OOM', bomb.failed === true || bomb.truncated === true)

check('无 CRLF', !en.text.includes('\r'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 3: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-docx.mjs`
Expected: FAIL — `Cannot find module '../lib/store/parse/docx.js'`

- [ ] **Step 4: 实现 DOCX 解析**

```ts
/**
 * DOCX → Markdown, via mammoth's HTML and the shared HTML→Markdown trunk.
 *
 * The one thing that is not obvious: **the risk is the style ID, not the
 * display language.** A Chinese Word writes `w:styleId="Heading1"` with
 * `w:name="标题 1"`, and mammoth's default map matches `p.Heading1` first, so it
 * converts correctly. What silently loses every heading is a non-Word generator
 * that writes `w:styleId="1"` with a non-English name — measured, and the only
 * visible signal is a warning in `result.messages`.
 *
 * So the map is derived rather than hardcoded: read `word/styles.xml`, take the
 * level from `w:outlineLvl` when present (mammoth ignores it entirely) and from
 * the name pattern otherwise, then emit the entry. Two syntax traps decide the
 * selector form, and both fail silently: `p.<styleId>` needs a legal CSS
 * identifier (`p.1 => h1` is rejected and the entry **dropped**), while
 * `p[style-name=…]` accepts single quotes only.
 *
 * Default map entries are turned off rather than layered on: measured precedence
 * between custom and default entries is inconsistent, and a derived map was
 * verified to cover the same headings on a real Word-produced file.
 *
 * @module dsh-zvec-knowledge/store/parse/docx
 */
```

**关键**：`result.messages` 里的 `Did not understand this style mapping` 与
`Unrecognised paragraph style` **必须计入失败判定**——那是这类文档唯一的可见信号。

- [ ] **Step 5: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-docx`
Expected: 9 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
cd plugin && git add src/store/parse/docx.ts scripts/verify-parse-docx.mjs scripts/gen-parse-fixtures.mjs package.json src/store/parse/fixtures
git commit -m "feat(parse): DOCX 推导式 styleMap，覆盖非规范 styleId 与 outlineLvl"
```

---

## Task 6: XLSX / CSV / JSON

**Files:**
- Create: `plugin/src/store/parse/tabular.ts`
- Create: `plugin/src/store/parse/json.ts`
- Create: `plugin/scripts/verify-parse-tabular.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Produces: `rowsToMarkdownTable(rows: string[][], title?: string): string`；
  `convertXlsx(file, opts)`；`convertCsv(file, opts)`；`convertJson(file, opts)`

- [ ] **Step 1: 写失败的门禁**

```js
import { rowsToMarkdownTable, convertCsv } from '../lib/store/parse/tabular.js'
import { convertJson } from '../lib/store/parse/json.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const table = rowsToMarkdownTable([['列A', '列B'], ['1', '2']], 'Sheet1')
check('表头行存在', /\| 列A \| 列B \|/.test(table))
check('分隔行紧随表头', /^\|[\s:|-]+\|\s*$/m.test(table))
check('表名成为标题', /(?:^|\n)#{1,6} Sheet1/.test(table))
check('单元格内竖线被转义', rowsToMarkdownTable([['a|b']]).includes('\\|'))
check('单元格内换行被转义', !rowsToMarkdownTable([['a\nb']]).includes('a\nb'))

// CSV：引号内换行、BOM、CRLF、中文列名
const csv = await convertCsv('src/store/parse/fixtures/sample.csv', { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 1e6 })
check('CSV 产出管道表', /\|.*\|/.test(csv.text))
check('CSV 无 CRLF', !csv.text.includes('\r'))

// 负向
const empty = await convertCsv('src/store/parse/fixtures/empty.csv', { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 1e6 })
check('空 CSV 明确失败而非静默产空索引', empty.failed === true)

// JSON
const small = await convertJson('src/store/parse/fixtures/small.json', { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 1e6 })
check('小 JSON 整篇围栏', /^```json/m.test(small.text))

const bad = await convertJson('src/store/parse/fixtures/bad.json', { timeoutMs: 60_000, maxPages: 0, maxTextBytes: 1e6 })
check('非法 JSON 降级为 flat-text 并包裹原文', bad.structure === 'flat-text')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑门禁确认失败**

Run: `cd plugin && npm run build && node scripts/verify-parse-tabular.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `tabular.ts`**

要点：`rowsToMarkdownTable` 首行当表头、补分隔行、转义单元格内的 `|` 与换行；
每个 sheet 前置 `## <sheet 名>` 标题（给 heading 模式一个可检索锚）；
XLSX 用 `read-excel-file`（MIT、纯 JS、零安装脚本）；
**不使用 npm 上的 `xlsx`**（0.18.5 是注册表最新版且 CVE-2023-30533 无修补版本）。

- [ ] **Step 4: 实现 `json.ts`**

本地函数，不引依赖：`JSON.parse` 成功且体量小 → 整篇 ```json 围栏；
超限 → 按对象嵌套产出确定性标题（`## <key path>`）+ 叶子 `- key: value`，**键序按原序不排序**
（避免重算产物漂移）；非法 JSON → 围栏包裹原文并记 `structure: 'flat-text'`。

- [ ] **Step 5: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-tabular`
Expected: 11 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
cd plugin && git add src/store/parse/tabular.ts src/store/parse/json.ts scripts/verify-parse-tabular.mjs scripts/gen-parse-fixtures.mjs package.json src/store/parse/fixtures
git commit -m "feat(parse): XLSX/CSV/JSON，共用一个管道表渲染器"
```

---

## Task 7: 面板与文档状态呈现

**Files:**
- Modify: `plugin/src/client/pages/DocumentsPage.tsx`
- Modify: `plugin/src/client/pages/DocumentsPage.module.css`（如需要）
- Create: `plugin/scripts/verify-parse-ui.mjs`
- Modify: `plugin/package.json`

- [ ] **Step 1: 写失败的门禁（无 DOM 渲染，D 类手法）**

断言：文档行显示 `structure` 三态；`flat-text` 显示「本文档无结构，标题策略不适用」；
解析失败显示 `error` 文案与建议动作；空态提示支持格式含 `xlsx`。

Run: `cd plugin && npm run build && node scripts/verify-parse-ui.mjs`
Expected: FAIL

- [ ] **Step 2: 改 DocumentsPage**

- 上传接受列表加 `xlsx`（与 `ACCEPTED_EXTENSIONS` 同源）
- 文档行渲染 `structure` 徽标（复用 `StatusPill`）
- `failed` 行显示 `error` 全文与 remedy
- **不新增颜色**：复用既有令牌；`verify:components` 会守裸色值

- [ ] **Step 3: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-ui && npm run verify:components`
Expected: 均 exit 0

- [ ] **Step 4: Commit**

```bash
cd plugin && git add src/client/pages/DocumentsPage.tsx src/client/pages/DocumentsPage.module.css scripts/verify-parse-ui.mjs package.json
git commit -m "feat(parse): 文档列表呈现结构保真度与解析失败原因"
```

---

## Task 8: 全库重算与回归收口

**Files:**
- Modify: `plugin/src/host/operations.ts`（「重新解析全部文档」用例）
- Modify: `plugin/src/host/bridge.ts` + `plugin/src/shared/contract.ts`（派发）
- Create: `plugin/scripts/verify-parse-reparse.mjs`
- Modify: `plugin/package.json`、`plugin/README.md`

- [ ] **Step 1: 写失败的门禁**

断言：重算只依赖 `sources/` 原件；重算后 `documents.jsonl` 的**行序与 `id` 不变**，
只有 `text`/`structure`/`parsedAt` 改变；重算后 `sources/doc_*.pdf` 字节未变（原件不被覆写）。

Run: `cd plugin && npm run build && node scripts/verify-parse-reparse.mjs`
Expected: FAIL

- [ ] **Step 2: 实现重算入口**

复用既有 `patchDocument`（读-改-写整日志）。**这是「原件字节级保留」这条设计前提的兑现**：
以后换解析器可就地重跑全库，不用重新上传。

- [ ] **Step 3: 跑门禁确认通过**

Run: `cd plugin && npm run build && npm run verify:parse-reparse`
Expected: exit 0

- [ ] **Step 4: 更新 README**

- 「当前实现范围」表加解析行，标出各格式状态
- 安装节**必须仍只列 `@zvec/zvec`** 一项 allowlist；若真新增则同步说明
- 「已知缺口」删掉 PDF/DOCX 不可入库那条

- [ ] **Step 5: 全链回归**

把四个新门禁挂进 `package.json` 的 `verify` 串行链，然后：

Run: `cd plugin && npm run typecheck && npm run build && npm run verify`
Expected: **exit 0**，含既有 896 项断言全部保持

- [ ] **Step 6: Commit**

```bash
cd plugin && git add -A
git commit -m "feat(parse): 全库重算入口与 README，四格式解析收口"
```

---

## 自检记录

**Spec 覆盖**：§8.1 硬约束→Task 0/2/3；§8.2 选型→Task 1/4/5/6；§8.3 接口→Task 3；
§8.4 降级→Task 2/3；§8.5 数据结构→Task 0/3；§8.6 资源边界→Task 1/3/4；
§8.7 模块→各 Task；§8.8 顺序→本计划把 PDF 提到 Task 1（用户裁决）。

**未覆盖（有意）**：§8.8 阶段 4 的外部适配器（opt-in，本轮不做）；
XLSX 的 fixture 生成细节（Task 6 内联，未单列任务）。

**待实测决定项**：Task 1 Step 1 的引擎选择（`unpdf` 2.4 MB vs `pdfjs-dist` 34.8 MB）。
两者在四份真机中文 PDF 上字符数相等，但**必须在本机 fixtures 上复验后**才定，
不能按调研结论直接采信。

**任务顺序与调研原计划的差异**：两处，都是刻意的。

1. **PDF 提到 Task 1**（调研排在阶段 3）。用户裁决：PDF 决定"真实领域文档能不能进来"，
   若语料以 PDF 为主，它决定整个产品是否成立，不该最后才验证。代价是最重的一步先付。
2. **HTML 主干放在 DOCX 之前**（Task 4 与 Task 5）。DOCX 经 mammoth 产出 HTML 再走这条主干，
   所以主干是 DOCX 的前置依赖。调研按格式难度排序（HTML 在阶段 1、DOCX 在阶段 2），
   本计划按**依赖**排序。

