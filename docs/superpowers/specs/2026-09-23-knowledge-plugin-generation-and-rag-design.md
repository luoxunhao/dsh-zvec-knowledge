# 知识库插件 · 文档生成、rag 问答与文档解析

> 定位：`dsh-zvec-knowledge` 服务**三个面**——
> **①rag 问答**（会话里问答，已有 `dsh_kb_search`，本设计不改）、
> **②领域文档生成**（按模板产出成稿，由 agent team / workflow 的 DAG 编排）、
> **③文档解析**（PDF/DOCX/HTML/XLSX/CSV/JSON 入索引，②的语料前提）。
> 插件是**原子能力提供方**，不是编排者。
>
> 状态：设计已确认，待实现计划。基准：`master` @ `689b216`。

## 1 背景与问题

插件当前已完整交付「把文档变成可被 AI 检索的知识」：zvec 进程内集成、双槽位快照、
混合检索、切分策略、5 个管理页面、`dsh_kb_search` 工具、引用可点击回原文、
两份随包 Skill。验证体系 896 项断言全绿。

**面①（rag 问答）已经够用**，本设计不改它。

**面②（文档生成）不存在**，这是本设计的主题。用户的真实诉求是
「基于我的资料，给我一份 XX 领域的报告」，而现在的路径是：用户自己判断该检索什么、
自己反复调 `dsh_kb_search`、自己组织成稿。`dsh_kb_search` 的契约是
「一个问题 → 一批证据」，它不表达「一份文档 → 一组章节 → 每章节各自的证据」。

**面③（文档解析）是从面②反推出来的前提**。现有 `extract.ts` 只收 Markdown/TXT，
对 PDF / DOCX / HTML / XLSX / CSV / JSON 一律以 `needs-conversion` 拒绝——
而真实领域文档绝大多数是 PDF 与 DOCX。**没有面③，面②建在空语料上**：
模板再合理、落盘校验再严，检索不到东西就写不出成稿。
`issues/文档解析-技术方案调研.md`（658 行）已给出逐格式选型与阶段 0–4 方案，
本设计**不重新研究，只做集成**（§8）。

### 1.1 编排权归 DAG，不归插件

初版设计让插件内置按章节批量检索的 `dsh_kb_compose`。**这个决定被推翻**：
生成任务交给 agent team / workflow 的 DAG 工作流，每个章节节点自己检索。

理由——插件内置编排会被 DAG 取代且更差：

- DAG 天然表达依赖与并行；插件内的章节循环是串行的，且要自己实现并发、重试、部分失败。
- DAG 的章节覆盖由**拓扑结构**保证；插件要写校验（初版设计的"校验一"）才能保证同一件事。
- 节点各自检索能用不同模型、不同 persona、不同 query 策略；插件内置只有一套。
- 插件不感知 DAG，就不必跟随 DAG 引擎演进——解耦。

### 1.2 关键机制已核实

DAG 节点能否调用插件工具，是整个方案的前提。已从已安装的类型定义独立核实：

| 结论 | 证据 |
|---|---|
| 插件工具**默认对 subagent 可见** | `dsh-tools/lib/types/index.d.ts:485-490`：`ToolRestriction` 是 *per-scope filter over global tools*，须显式 `allow`/`deny` 才生效 |
| subagent 的 `toolFilter` 是**部署期配置**，不是模型逐次传参 | `dsh-tool-subagent/lib/types/index.d.ts:51-61`：属 delegation-tool 的 `Config`（`cordis.patch.yml`） |
| workflow 的 `agent()` **继承父 agent 工具**，无工具域字段 | `dsh-workflow/lib/types/runtime-types.d.ts:15-30`：`parent: Agent`「parent of every child」，`WorkflowStartRequest` 无 tool 字段 |
| agent team 的 DAG 由**模型用工具写出**，非 schema 声明 | `dsh-experimental-tool-agent-team/lib/types/index.d.ts` 仅 `freshProvider`/`forkProvider` 两项配置；`.agent-teams/kb-code-audit/team.json` 的 `tasks[].dependencies` 即其产物 |

**因此插件不需要为 DAG 做任何适配。** 这是本设计的核心简化。

## 2 目标与非目标

### 目标

1. 模板成为工作区级一等数据：可上传、可编辑、可跨集合复用。
2. 成稿落盘为 Markdown 文件，路径可控且不可逃逸出工作区。
3. 成稿的引用可回溯：编造的引用在落盘时被拒绝。
4. 复用会话模型写作——插件**不接 LLM**，不新增端点与密钥。
5. rag 问答入口（`dsh_kb_search`）行为不变。
6. **语料入口打开**：PDF / DOCX / HTML / XLSX / CSV / JSON 从「上传即拒」变为可索引（§11）。

### 非目标（本次明确不做）

| 不做 | 理由 |
|---|---|
| **插件内置生成编排**（原 `dsh_kb_compose`） | 由 DAG 承担，见 §1.1 |
| 插件内置 DAG 工作流脚本 | 编排描述随用户/团队走，不随插件分发。插件内置会把"怎么生成"的知识焊死在包里，而它是领域相关的 |
| 面板内写作区 / 富文本编辑 | 产物是落盘文件，写作发生在会话里；在浏览器里跑生成需要插件自接 LLM 或反向驱动会话模型，两者都与现有架构冲突 |
| 插件内 LLM 调用 | 复用会话模型，零新增密钥与成本面 |
| **扫描件 OCR** | 无可用纯 JS 路线：`tesseract.js` 带 `postinstall`（新增 allowlist 项）且语言模型需联网取，直接违反「装完即用」与「门禁无外网」。**诚实拒绝**，见 §8.4 |
| **`docling` / 内置 `pandoc`** | 需外部运行时或模型下载，违反进程内约束；只保留为 opt-in 外部适配器（§8.8 阶段 4） |
| 重排现有面板信息架构 | 检索页/策略页/配额服务的是"把语料搞对"，是生成质量的前提。先用真实成稿证明哪些管理面没人打开，再裁决 |
| 改 rag 问答链路 | 入口①已够用 |
| 修 §9 列出的过度设计 | "先取证再砍"，不在本设计范围 |

## 3 数据模型

### 3.1 模板存储：工作区级单层共享库

```
<storeRoot>/templates/<template-id>.md
```

- `storeRoot` 由 `stateDir`（默认 `.dsh-kb-zvec`）相对工作区解析，
  **本就是工作区隔离维度**，因此"工作区级共享"不需要新增隔离层。
- **与集合目录平级，不在集合目录内**：模板跨集合复用。
- **单层，无内置模板、无覆盖规则**：模板是普通可写数据，不是只读资产。
  插件只提供 CRUD 与校验，内容完全是用户的领域知识。

`template-id` 命名规则沿用集合 id 的纪律（`paths.ts`）：小写字母开头、
`[a-z0-9-]`、长度受限、**且对根前缀做包含性校验**——畸形 id 无法变成路径穿越。

### 3.2 模板格式：Markdown + frontmatter

frontmatter 是给代码与编排读的（章节列表须结构化，否则 DAG 无法据此建节点）；
正文是给模型读的（写作风格是指引，不是配置）。

```markdown
---
id: weekly-report
name: 周报
description: 基于本周资料汇总进展、风险与下周计划
output: docs/{{date}}-{{collection}}-周报.md
sections:
  - id: progress
    title: 本周进展
    query: 本周 进展 完成 交付
    topk: 12
  - id: risks
    title: 风险与阻塞
    query: 风险 阻塞 问题 延期
    topk: 8
  - id: plan
    title: 下周计划
    query: 计划 待办 排期
    topk: 8
---

每个章节必须引用具体命中，不得编造。数据不足的章节明确写"资料未覆盖"。
```

**字段契约**

| 字段 | 必填 | 约束 |
|---|---|---|
| `id` | 是 | 必须等于文件名（去 `.md`）；不匹配即拒绝 |
| `name` | 是 | 界面显示名，非空 |
| `description` | 否 | 界面副标题 |
| `output` | 是 | 相对路径模板，见 §3.3 |
| `sections` | 是 | 非空数组 |
| `sections[].id` | 是 | 模板内唯一；重复即拒绝 |
| `sections[].title` | 是 | 成稿中的标题文本 |
| `sections[].query` | 是 | 该章节的建议检索 query，非空 |
| `sections[].topk` | 否 | 正整数，≤50；缺省用集合检索策略的 `topk` |
| 正文 | 否 | 写作指引，供 DAG 节点与模型读取 |

**校验时机**：上传/保存时校验并拒绝（连同具名原因），不合法模板不落盘。
理由与 `extract.ts` 的拒绝哲学一致——**上传成功但生成出不来**是最坏的失败模式。

**`sections[]` 的定位要说清**：它是**给 DAG 的建议骨架**，不是插件强制执行的契约。
插件保证的是"模板可被解析、结构可被读取"；章节是否真的被覆盖，由 DAG 的拓扑与
落盘校验（§4.2）共同保证。

### 3.3 输出路径模板

可用变量（**渲染后校验，不做信任**）：

| 变量 | 值 |
|---|---|
| `{{date}}` | `YYYY-MM-DD` |
| `{{collection}}` | 集合 id |
| `{{template}}` | 模板 id |

**`{{collection}}` 是必需的**：模板跨集合共享，输出路径若不区分集合，
两个集合用同一模板会互相覆盖。

**安全规则**（复用 `paths.ts` 的包含性校验模式，不新造）：

1. 渲染后必须是相对路径，拒绝绝对路径、盘符、UNC。
2. 归一化后拼接输出根，**必须仍在输出根内**——`../` 逃逸即拒绝。
3. 输出根 = `<workspace>/docs/`。
   - 工作区解析**必须**走 `index.ts:305-319` 那条已验证路径
     （`ctx.get('sessions').list()` 首个 `session.header.cwd`）。
   - **禁止**读 `ctx.workspaceDir`：cordis context 是代理，读未声明属性**抛错**，
     抛在 `apply()` 里会让整个 profile 起不来（已在 `verify-load-safety` 中守）。
   - 工作区解析失败时 **落盘明确拒绝**，不猜路径、不回退到 `process.cwd()`。
4. 已存在文件**不静默覆盖**：返回冲突，要求调用方显式确认（`overwrite: true`）。

## 4 主机侧设计

### 4.1 唯一新增工具：`dsh_kb_commit`

插件**只加一个工具**，职责是「校验成稿并落盘」。检索编排由 DAG 做，
所以没有 `dsh_kb_compose`（§1.1）。

```
dsh_kb_commit({ collection, template, params?, content, overwrite? })
  → 两段校验 → 落盘
  → 返回落盘路径 + 章节核对结果 + 引用核对结果
```

**为什么落盘要单独一个工具、而不是让模型直接用写文件工具**：
落盘校验是**编排价值的收口**。DAG 的各章节节点并行写作、质量不一，
末端必须有一道校验能拒绝"缺章"与"编造引用"的成稿。若让模型直接写文件，
这两种失败都会静默通过——而这正是并行生成最容易出的问题。

**为什么拆成工具而非并入检索工具**：`dsh_kb_commit` 是**写盘、有副作用**，
需要覆盖确认；检索工具是只读、可反复调。混在一起会让"只读重试"带上写风险。

### 4.2 两段校验

**校验一：章节全覆盖**

从 `content` 抽出标题结构，模板每个 `sections[].id` / `title` 都要有对应章节。
缺失即拒绝，**并列出缺失的章节名**（让 DAG 定向补该章节，而不是重跑整篇）。

匹配用 `title` 的规范化形式（去空白、忽略标点），接受 `id` 回退匹配——
模型可能改写标题措辞，用严格字面匹配会产生大量误报。

**校验二：引用有效性**

从 `content` 抽出引用定位符，逐一校验 `doc_id` + 行号在**当前活动快照**中真实存在。
复用 KB-13 `readCitation` 的读取路径与行号标记逻辑。

- 编造的引用被检出 → 拒绝并逐条列出。
- 引用的文档已被删除 → 检出并列出。
- **引用格式**沿用 `dsh-kb-citation://<集合>/<docId>#L<行>`（地址即身份）。

**路径安全**按 §3.3 渲染与校验，同属落盘前置。

**失败返回方式**：沿用 `search-tool.ts` 的既定纪律——**返回可判断的结构化文本，不抛异常**。
校验失败返回差异清单（缺哪些章节、哪些引用无效），让 DAG 能定向修；
未捕获异常会直接结束该轮，反而让编排失去修正机会。

**成功返回**：落盘绝对路径、写入字节数、章节核对表（每章节实际引用了几条命中）。

### 4.3 模板读取：给 DAG 的入口

DAG 的第一个节点需要拿到模板骨架。两条路，**都不需要新工具**：

- **模型用 `read` 直接读** `<storeRoot>/templates/<id>.md`（若已知 store root）。
- **面板可见、可复制**：模板页显示模板的绝对路径，用户/Lead 可直接引用。

**决策**：本设计**不新增模板读取工具**。理由是 store root 对模型不透明
（它由工作区解析而来），让模型猜路径很脆；但也**不为此加工具**——加一个
"只读文件"的工具是对 `read` 的重复。**折中**：在 `dsh_kb_commit` 的参数描述与
随包 Skill 中写明模板路径的解析规则，并在模板页提供"复制路径"。
若实测发现模型无法定位模板，再补一个轻量 `dsh_kb_templates`（列出模板及绝对路径）。
这项**标记为待实测决定**，见 §7。

### 4.4 新增与改动的模块

| 模块 | 动作 | 职责 | 规模估计 |
|---|---|---|---|
| `store/templates.ts` | 新增 | 模板 CRUD、frontmatter 解析与校验、id 与路径安全 | ~300 行 |
| `store/output-path.ts` | 新增 | `output` 模板渲染 + 包含性校验（纯函数，可独立测） | ~120 行 |
| `host/commit-tool.ts` | 新增 | `dsh_kb_commit` 定义、两段校验、落盘 | ~350 行 |
| `host/operations.ts` | 改动 | **仅**新增模板 CRUD 用例方法（+150 行） | — |
| `shared/contract.ts` | 改动 | 新增 bridge 方法名与工具名常量 | +25 行 |
| `host/bridge.ts` | 改动 | 派发模板 CRUD | +5 case |
| `client/pages/TemplatesPage.tsx` | 新增 | 模板管理页（列表 / 上传 / 编辑 / 删除 / 复制路径） | ~400 行 |
| `client/index.tsx` | 改动 | 注册模板页入口 | 小 |
| `zvec-compose/SKILL.md` | 新增 | 生成工作流指引 | — |

**`operations.ts` 已经 76KB**，因此校验逻辑放 `host/commit-tool.ts`，
operations 只接真正属于"用例集合"的模板 CRUD。这是刻意抑制分层继续退化。

**`dsh_kb_search` 不改动**——入口①的契约稳定，本设计要求它的既有 896 项断言全部保持。

文档解析的新增模块见 §8.7（`store/parse/` 目录，与本表分开以便独立评审）。

## 5 客户端设计

**模板管理页**，挂进现有面板。

- **必须明确标注"工作区级"**：模板不属于任何集合。若不标，用户会以为切换集合就切换模板。
- 功能：列表（name / description / 章节数）、上传 `.md`、编辑正文与 frontmatter、
  删除、**显示并复制模板绝对路径**（供 DAG / 会话引用，见 §4.3）。
- **上传路径与现有文档上传一致**（原始 body 流 + 元数据放请求头，
  见 `bridge.ts` 的 `/api/_kb_zvec/upload`），复用 token 鉴权与边读边限。
- 校验失败**逐条显示具名原因**（哪个字段、为什么），不显示"格式错误"。
- 沿用现有组件（`Button` / `TextField` / `EmptyState` / `StatusPill` 等）。
  新增视觉一律走既有令牌，**禁裸色值**（`verify:components` 会守）。

## 6 Skill 设计

新增 `zvec-compose/SKILL.md`，随包分发（与现有两份同机制，`skill-bundle.ts` 运行时注册）。

覆盖：
- **两个入口的分工**：问一个问题 → `dsh_kb_search`；要一份成稿 → 走生成流程。
- **模板定位**：如何找到模板文件与 store root。
- **生成流程**：读模板 → 按 `sections[]` 组织 DAG（章节并行、末端合稿）→
  每章节用 `sections[].query` 检索 → 写作 → `dsh_kb_commit` 落盘。
- **补召回**：某章节证据不足时，用更精确的 query 重取，或直接用 `dsh_kb_search` 定向补。
- **诚实写作**：证据不足的章节明说"资料未覆盖"，**不得用通用知识填充**。
  与 `zvec-rag` 的空结果措辞纪律一致。
- **落盘被拒时**：按差异清单定向修该章节，而不是重写全文。

**DAG 形状是 Skill 的建议，不是插件的契约**：Skill 描述"章节并行、末端 commit"
这一形态；具体拓扑由执行者按任务规模定。插件不校验 DAG。

**分发纪律**：真源在仓库根 `<name>/SKILL.md`，`plugin/skills/<name>/` 是随包那份，
`verify:skill` 逐字节比对两侧。三份 Skill 全部随包。

## 7 验证设计

沿用现有六类手法，新增门禁加入 `npm run verify` 链。

| 门禁 | 类 | 断言 |
|---|---|---|
| `verify:template` | A + B | frontmatter 解析（含畸形输入逐一拒绝）；id 不等于文件名 → 拒绝；重复 section id → 拒绝；`topk` 越界 → 拒绝；真临时目录跑 CRUD 往返 |
| `verify:output-path` | A（纯函数） | `{{date}}`/`{{collection}}`/`{{template}}` 渲染；`../` 逃逸 → 拒绝；绝对路径/盘符/UNC → 拒绝；缺 `{{collection}}` → 拒绝 |
| `verify:commit` | B | 章节缺失 → 拒绝且列出缺失项；标题措辞改写仍能匹配；编造引用 → 检出；引用已删文档 → 检出；已存在文件不覆盖；合法成稿真落盘并逐字节读回 |
| `verify:commit-tool` | C | mock ctx + 真调 `apply()`：工具注册；`inject` 只声明 `tools`；无 `webServer` 的 headless profile 仍保留 `dsh_kb_search` 与 `dsh_kb_commit` |
| `verify:template-page` | D | 无 DOM 渲染门禁：上传失败时具名原因可见；空态可见；模板路径可复制 |

**负向验证必须真做**（不是断言"应该拒绝"）：至少对路径逃逸与编造引用各做一次
变异样本，证明门禁真的会红。这是本仓库既有纪律（见 `ARCHITECTURE.md` §10 对
`verify-bridge` 双向比对的变异验证）。

**回归**：`npm run verify` 全链必须仍 exit 0。入口①的既有断言一项不得变红。

**待实测决定项**：§4.3 的模板定位方式。需要一个真实 DAG 跑一次
（agent team 或 workflow，章节 ≥3）来判定"模型能否自行定位模板"。
若不能，则补 `dsh_kb_templates` 工具。**这项在实现计划里排为验证任务，不是设计缺口。**

## 8 文档解析

**为什么必须在本次设计内**：生成链路的质量上限由语料决定。现在 `extract.ts` 对
PDF / DOCX / HTML / CSV / JSON 一律以 `needs-conversion` 拒绝，只有 Markdown / TXT 能入库——
而真实领域文档绝大多数是 PDF 与 DOCX。**没有这一节，前面的模板与落盘都建在空语料上。**

技术选型不重新研究：`issues/文档解析-技术方案调研.md`（v1.0.0，658 行）已给出
逐格式候选矩阵、许可与安装面核查、以及阶段 0–4 的落地顺序与门禁清单。
**本节只做集成**：把那份调研的结论接进本设计的范围、顺序与验收。

### 8.1 硬约束（调研 §1.1，直接门禁化）

| # | 约束 | 依据 |
|---|---|---|
| P1 | 产物必须是 Markdown 且带 **ATX 标题**（`#`–`######`）。无 `#` 的文档在 heading 模式下退化成整篇，章节级检索失效 | `chunk.ts:283` |
| P2 | 表格必须是**管道表 + 表头行 + 分隔行**（切分器靠分隔行定位） | `chunk.ts:405-425,548-556` |
| P3 | 代码块必须是**围栏**（``` / ~~~）；缩进式不被识别 | `chunk.ts:279-281` |
| P4 | 换行必须是 `\n`（CRLF 是已记录的静默故障） | `chunk.ts:115-121` |
| P5 | 许可证须与 MIT 组合（本包 MIT 且以源码分发） | `plugin/package.json:32` |
| P6 | **不得新增安装摩擦**：任何带 `install`/`postinstall`、node-gyp、装期下载二进制的依赖都会把 `@zvec/zvec` 那道 allowlist 手续复制一遍 | `README.md:82-100` |
| P7 | 门禁须在**无外网、无 API key** 下可跑 | `README.md:108-111` |
| P8 | 进程内、本地、无外部程序强制依赖 | 产品立场 |

**P6 是选型的实际支配约束**：它直接否决了 `xlsx@0.18.5`（CVE-2023-30533 无修补版）、
`tesseract.js`（`postinstall`）、`pdf-parse`（硬依赖原生 canvas）、`hummus`（node-gyp）。

### 8.2 选型（调研 §4.0，逐格式）

| 格式 | 选型 | 结构来源 | 与 P6 |
|---|---|---|---|
| `md`/`txt` | 现状不变（`verbatim`） | 原件即文本 | — |
| `html` | `hast-util-from-html` → `hast-util-to-mdast` → `mdast-util-to-markdown` + `mdast-util-gfm-table` | `<h1..h6>`→ATX；`<table>`→管道表；`<pre><code>`→围栏 | 纯 JS，无安装脚本 |
| `docx` | `mammoth.convertToHtml`（推导式 styleMap）→ 上面的 HTML→MD 主干 | 段落样式→`h1..h6` | 纯 JS，tarball 安装不执行 prepare |
| `xlsx` | `read-excel-file` → 本地 `rowsToMarkdownTable` | 工作表/行/列 | 纯 JS，零安装脚本 |
| `csv` | `papaparse`（或 40 行本地实现）→ **同一个** `rowsToMarkdownTable` | 表头行 + 分隔行 | 零运行时依赖 |
| `json` | **本地函数**，不引依赖 | 整篇围栏 或 键路径标题 | — |
| `pdf` | `pdfjs-dist@6.3.289` + 自研行重建 + tagged 优先 + 字号聚类兜底 | 结构树（若有）→ ATX | 纯 JS；`cmaps/`/`standard_fonts/`/`wasm/` **随包**，可离线（满足 P7） |

**选 unified 而非 turndown 的决定性理由**：unified 的默认值**就是**切分器要读的东西
（ATX + 强制围栏），因此"忘记配置"不会静默降级；turndown 的三个默认值全反
（setext 标题、缩进代码、不处理表格），正好命中 `extract.ts` 点名的最坏情形。

**PDF 是唯一需要自研结构推断的格式**：`getTextContent()` 只给带位置矩阵的 `TextItem`
列表，官方类型**未承诺**顺序，也未承诺任何标题语义。因此必须自己实现行重建、
tagged 结构标签优先、字号聚类兜底三段。推断产物一律记 `structure: 'inferred'`，
**不得当原文标题使用**。

### 8.3 与生成链路的接口（本节的集成要点）

调研已定：**上传时只做廉价预检，真正解析移到构建流水线的 `parse` 阶段**。
这与本设计的 `dsh_kb_commit` 引用校验有直接耦合，必须说清：

1. **`parse` 阶段本就是为空文本过滤留的位**，四阶段流水线（parse/chunk/index/publish）
   已有阶段名、进度与 `cancel()`。解析插进去不需要新阶段。
2. **引用可回溯性依赖派生文本的稳定性**。KB-13 的 `readCitation` 读的是**入库快照文本**
   （`documents.jsonl` 的 `text`），因此：
   - 解析器版本或 `structure` 变化必须**强制全量重建**（并入 `incrementalViability` 的理由），
     否则新旧解析产物混排会让行号引用漂移。
   - 这条直接保护 §4.2 校验二（引用有效性）——若文本可静默改变，引用校验就失去意义。
3. **原件字节级保留、派生文本可重算**（P9/C9）是既有设计前提：
   `sources/doc_<hash>.<ext>` 存原件，所以"以后加了转换器可全库重跑而不用重新上传"
   在本设计里**必须真的兑现**——阶段 4 的"重新解析全部文档"是验收项。
4. **单篇解析失败绝不使整场构建失败**（调研 §5.3 的关键不变量）：每篇包在自己的
   `try/catch` 内，失败记到该文档上；只有系统性错误（存储不可写、配额）才让构建整体失败。
   现有实现是抛错即丢弃槽并整体失败，**这是必须改的**。
5. **配额两段式**：上传期按原件字节记账，解析回填时按真实文本字节二次 `admit`；
   不足则该篇 `failed`。保持"不超额提交"这条既有性质。
6. **扩展名清单三处同源**：`documents.ts` 的 `ACCEPTED_EXTENSIONS`、
   `DocumentsPage.tsx`、`extract.ts` 的 `SUPPORT` 键集——现状已是复制品，门禁须断言三者一致。

### 8.4 诚实降级（不做 OCR）

| 情形 | 行为 |
|---|---|
| 扫描件 PDF（文本运行数 ≈ 0） | **上传即拒**，remedy 明说本插件不含 OCR，请先离线 OCR |
| 加密 / 需口令 PDF | 上传即拒，请导出去除口令的副本 |
| 有文本层但结构不可恢复 | 接受；构建后记 `structure: 'flat-text'`，**如实上报** |
| 解析器抛错 | 该篇 `failed` + 错误与建议，其余文档继续 |
| 解析后 `trim() === ''` | `failed`，文案与现有 `addDocument` 同名文案一致 |

**判据自动测量**：调研 §1.2 的五条判据（标题数、管道表头+分隔行、围栏成对、
无 `\r`、降级标记为 `flat-text`）是实现产物的**可执行验收**，不是文档描述。
`strategy-evidence` 面板的「本文档未涉及」语义正好承载 `flat-text`，**不需要新增 UI 概念**。

### 8.5 数据结构改动（最小集）

| 位置 | 改动 | 为什么必须 |
|---|---|---|
| `DocumentRecord` | 新增可选 `structure?: StructureLevel`、`parsedAt?: string`、`converter?: string` | 未解析 ≠ 空文档：`chunks: null` 已在区分"未测量"与 0，同一思路要求 `text: ''` 只表示"还没解析" |
| `ExtractionKind` | 新增 `'converted'`；**不新增第四个 kind** | 语义收窄为"字节到文本的处理方式"，"结构保真度"是**正交维度**（`StructureLevel = 'structured' \| 'inferred' \| 'flat-text'`） |
| `documents.jsonl` | 解析成功后回填 `text`/`structure`/`parsedAt` | 走现成的 `patchDocument` |
| 增量资格 | 把"`structure` 或 converter 版本变化"并入强制全量理由 | 见 §8.3 第 2 条 |

### 8.6 资源边界（不能假定第三方解析器有界）

调研点明 mammoth 自述"恶意文档可造成病态性能的高 CPU/内存，且对源文档不做任何净化"。
因此以下全部作为**可校验 Config 字段**而非源码常量，默认值待阶段 3 实测后定：

- 单文档解析墙钟超时 → 该篇 `failed`，让位下一篇
- PDF 页数上限、派生文本字节上限、HTML DOM 规模双限、**ZIP 解压上限（zip-bomb）**
- 取消检查点：每篇、PDF 每页（现有 `controller.signal` 已具备，缺的是 parse 内部检查点）

**异步形态用 `await` + 协作让位，不预先引入 `worker_threads`**：
后者带来新的生命周期与句柄所有权问题。若实测证明单个大 PDF 仍长时间独占循环，
再升级——这一步由"事件循环最大间隔"断言决定，不预先付复杂度。

### 8.7 新增模块

| 模块 | 职责 |
|---|---|
| `store/parse/index.ts` | `convert(source, converter)` 派发 + 超时与取消 |
| `store/parse/markdown-grade.ts` | §8.4 五条判据的可执行实现（阶段 0 先做，不改产品行为） |
| `store/parse/html.ts` | 共享主干 HTML→Markdown（服务 html 直传与 docx） |
| `store/parse/docx.ts` | mammoth + 推导式 styleMap |
| `store/parse/pdf.ts` | pdfjs 行重建 + tagged 优先 + 字号聚类 |
| `store/parse/tabular.ts` | `rowsToMarkdownTable` + xlsx/csv |
| `store/parse/json.ts` | 本地 JSON 渲染 |
| `store/extract.ts` | 改动：`SUPPORT` 扩充 + `preflight` |
| `store/build.ts` | 改动：`parse` 阶段逐文档解析 + 每篇 try/catch |
| `store/documents.ts` | 改动：`DocumentRecord` 字段 + 三处清单同源 |

**DOCX 的实测结论已把风险下调**（调研 §10）：风险的真正触发条件是 **styleId 而非显示语言**——
中文 Word 的内置样式 ID 仍是 `Heading1`，默认映射已覆盖"英文 styleId + 任意语言名字"。
会漏的是非 Word 生成器把 styleId 写成 `1`/`a1` 之类。因此采用**推导式映射**
（读 `word/styles.xml` 的 `w:outlineLvl`，名字模式兜底），并**关掉默认映射自带全量**
（`includeDefaultStyleMap: false`——注意不是 `useDefaultStyleMap`，后者被静默忽略）。
两类告警（`Did not understand this style mapping` / `Unrecognised paragraph style`）
**必须当失败断言**——那是这类文档唯一的可见信号。

### 8.8 落地顺序与门禁

顺序 `阶段 0 → 1 → 2 → 3 → 4`，**每阶段独立可验收**：

| 阶段 | 内容 | 新增门禁 |
|---|---|---|
| 0 | 判据 + fixtures（不改产品行为） | `verify:parse-grade`（判据自身，含负向自证） |
| 1 | CSV / JSON / HTML（零许可风险、零原生、零下载） | `verify:parse-tabular`、`verify:parse-markdown`、`verify:parse-json` |
| 2 | DOCX | `verify:parse-docx`（含中文名+英文 styleId、数字 styleId、仅 `outlineLvl`、zip-bomb、无 base64） |
| 3 | PDF（**唯一引入新体量依赖，33 MiB 解压，需单独评审**） | `verify:parse-pdf`（行序、双栏、中文 CMap 本地路径、tagged→`structured`、无标签**永不**为 `structured`、独占时长、不联网） |
| 4 | 可选外部适配器 + **全库重算** | `verify:parse-adapter`（argv 不经 shell、超时回收）、重算入口 |

**与生成链路的关系**：阶段 1–2 完成即可支撑"真实领域文档进得来"这一生成前提。
**阶段 3（PDF）是价值最高也最重的一步**——若真实语料以 PDF 为主，它决定整个产品是否成立。

**fixtures 必须先定**（否则后面每步都在补证据）：DOCX/XLSX 用一次性脚本手写最小
OOXML + zip 并**提交产物**；PDF 用 `pdf-lib` 写出；任何第三方 fixture 须在
`fixtures/SOURCES.md` 记录来源与许可证。调研已指出：**未发现**许可证明确且适合当中文
tagged-PDF 样例的公开语料，这是阶段 0 的未决项。

### 8.9 本节明确不做

| 不做 | 理由 |
|---|---|
| 扫描件 OCR | 无可用纯 JS 路线；`tesseract.js` 违反 P6 + P7。诚实拒绝（§8.4） |
| 内置 pandoc / markitdown / docling | 需外部运行时或模型下载，违反 P8。只作 opt-in 适配器（阶段 4） |
| `.doc`（二进制）/ `epub` / `rtf` / `pptx` | 无结构保证；留给阶段 4 的适配器 |
| 版面级还原（多栏精排、公式、图表语义） | 超出检索所需；PDF 只保证行序与标题可用 |

## 9 已识别但本次不动的过度设计

记录以供后续裁决，**本设计不改**：

| # | 项 | 判断 |
|---|---|---|
| 1 | `strategy-evidence.ts`（20KB） | 为"旋钮是否真生效"做逐项证据推断，还从源文本统计 fence/table 防冒充。是给内部算法做科研的工程量，用户价值低 |
| 2 | 三个配额组件，而 `quota.bytes` 默认 `null` | 从未生效 |
| 3 | 检索策略 5 个旋钮 + 专门一页 | 用户不该调 `candidates`/`mode`/权重 |
| 4 | 50 个验证脚本 / 896 项断言 | 门禁密度超过产品复杂度，且相当一部分在验证"文档与代码一致"而非"行为正确" |
| 5 | `operations.ts` 76KB / 23 个 bridge case 单文件 | 分层已在退化（本设计刻意不加剧） |
| 6 | 令牌三产物 + W3C 导出 + SCSS 导出 | 宿主已有主题系统，W3C 导出无已知消费者 |

**裁决方式**：生成链路跑通、有真实成稿之后，用"哪些管理面在生成流程里从未被打开过"
作为证据来裁决，而不是靠品味。

## 10 风险与未决

| # | 风险 | 处置 |
|---|---|---|
| 1 | 模型不按引用格式写，导致校验二大面积误报 | 落盘返回**逐条**无效引用，让 DAG 定向修；Skill 给正例。若误报率仍高，改为"警告而非拒绝"并记录 |
| 2 | 章节标题匹配靠文本，模型改写标题 | 用规范化匹配 + `id` 回退（§4.2）；门禁里含"措辞改写仍能匹配"一条 |
| 3 | 工作区解析失败时落盘全废 | 明确拒绝并说明原因（不猜路径）；后续演进可让调用方显式提供输出路径 |
| 4 | 模板库无访问控制，工作区内任意进程可写 | 与 KB-SEC-01 同一议题（桥接层鉴权边界本就未裁决），本设计不引入新的鉴权面 |
| 5 | DAG 并行写作导致文风割裂、章节间重复 | 由 Skill 指引（先汇总事实、再分章节、末端合稿），**插件不介入**——这是编排层的质量问题 |
| 6 | 模板页与集合无关，用户可能困惑 | UI 明确标注"工作区级"（§5） |
| 7 | 大模板（章节多）× 大 topk 导致上下文过长 | `sections` 数量与 `topk` 各设上限并在校验期拒绝；具体数值待实测后定 |
| 8 | **解析产物不稳定导致引用漂移** | converter 版本 / `structure` 变化并入强制全量重建（§8.3 第 2 条）；这是保护校验二的前提 |
| 9 | **PDF 解析在宿主循环上长时独占** | 先按 §8.6 用协作让位；由"事件循环最大间隔"门禁决定是否升级 `worker_threads`，不预先付复杂度 |
| 10 | **PDF 体量（解压 33 MiB）拖累安装** | 阶段 3 单独评审；这是唯一引入新体量依赖的一步 |
| 11 | 解析引入新依赖后 allowlist 说明过期 | 阶段门禁断言 README 安装节**仍只列 `@zvec/zvec`**；若真新增则必须同步 |
| 12 | 中文 tagged-PDF fixture 无合适公开语料 | 阶段 0 未决项（§8.8）；未取得时 tagged 路径只测"不误判为 `structured`"这一半 |

## 11 验收标准

1. 用户能在面板上传一份模板 `.md`，非法模板被拒绝且原因具名。
2. 面板显示模板的工作区级归属与绝对路径。
3. 一个真实 DAG（agent team 或 workflow，章节 ≥3）能按模板产出成稿。
4. 合法成稿经 `dsh_kb_commit` 落盘到 `<workspace>/docs/` 下。
5. 缺章节、编造引用、路径逃逸三种情况**各自被拒绝并列出具体项**。
6. 同一模板用于两个不同集合，输出文件不互相覆盖。
7. 无 `webServer` / 无 `skills` 的 profile 仍保留 `dsh_kb_search` 与 `dsh_kb_commit`。
8. 入口①的 rag 问答行为与既有断言不变。
9. **CSV / JSON / HTML / DOCX / XLSX 上传后可索引**，产物过 §8.4 五条判据；
   扫描件 PDF 与加密 PDF 在上传期被拒且 remedy 可执行。
10. **PDF 可索引**（阶段 3），中文不乱码，且无标签文档**永不**被判为 `structured`。
11. 单篇解析失败不使整场构建失败，其余文档照常产出。
12. 「重新解析全部文档」只依赖 `sources/` 原件即可跑通，行序与 `id` 不变。
13. `npm run verify` 全链 exit 0，含新增门禁。
