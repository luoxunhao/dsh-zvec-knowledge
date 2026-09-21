# dsh-zvec-knowledge

DeepSeek Harness 的本地知识库插件，基于 [zvec](https://zvec.org) 进程内向量数据库。
把「文档」变成「可被 AI 检索的知识」，且不引入独立服务：文档留在本地，索引留在本地，
检索与生成通过插件暴露的工具完成。

设计与视觉真源是《DSH 知识库插件（基于 zvec）设计规范》v1.1.2（对应设计稿 v1.1.0，
云端节点 `C4YbSKGQ5zE93u9UxlXon5`）。仓库内的 markdown 源在 `output/<run-id>/stage1/final_draft.md`，
`npm run verify:spec` 解析该文件 3.1 的逐组令牌表与总数，并与 `tokens/kb-tokens.json` 比对，
规范侧与实现侧不一致即失败。

## 配套 Skill

本插件带两份执行型 Skill，装好 profile 就有，不需要第二步安装：

- `zvec-rag-loop/` —— 检索工作流：选库、判断快照是否覆盖问题、问题分解与迭代、跨库对照、
  核实与召回不足时的成因定位；附 `scripts/kb-inspect.mjs`，只读磁盘快照回答「这篇文档进索引了吗」。
- `zvec-rag/` —— 结果呈现：引用格式、`band` 与 `match_score` 的解读、空结果的三种读法、回答写法。

**真源在仓库根**（`<name>/SKILL.md`），`plugin/skills/<name>/` 是随包分发的那一份，
由 `npm run verify:skill` 逐字节比对两侧、并对 stub 注册表真跑一次注册与 dispose。
运行时 `host/skill-bundle.ts` 读 `skills/<name>/SKILL.md`，经 `ctx.skills.register()` 交出去，
并把该目录作为 `resourceBase`，所以 skill 里点名的 `scripts/kb-inspect.mjs` 一定能解析到。

`skills` 与 `webServer` 一样走 `ctx.inject` 懒绑，不进 `inject` 必需列表：
DSH 的 skill 服务来自一个 opt-in 插件，没有它的 profile 必须照常加载并保留 `dsh_kb_search`。

> **为什么不是丢进某个目录让宿主自己发现。** DSH 的发现根只有
> `<gitRoot>/.dsh/skills`(rank 100)、`<gitRoot>/.agents/skills`(200)、运行时注册(250)、
> `customSkillDirs`(300)、`$DSH_HOME/skills`(400)、`$DSH_AGENTS_HOME/skills`(500)、bundled(600)，
> 不含任意包内目录；而 `customSkillDirs` 按 process cwd 解析，部署 YAML 表达不出「本包里那个目录」。
> 注册是唯一能带包内路径的通道。副作用是 rank：项目若想在某个仓库改写这两份指引，
> 把同名目录放进 `.dsh/skills` 或 `.agents/skills` 即可覆盖插件带来的那份。
> DSH 实际读取的 frontmatter 键只有 `name`、`description`、`whenToUse`、
> `disable-model-invocation`、`user-invocable`（`metadata` 原样透传），
> `version` / `allowed-tools` / `model` 都不读，条目形状是「直接子目录里的 `SKILL.md`」或扁平 `.md`，不递归。

## 当前实现范围

| 模块 | 状态 |
|------|------|
| 插件双面契约（bundle patch / host / client bundle） | 已落地（KB-01，profile 安装与 `--dump-config` 对账可复跑） |
| 设计令牌与浅深双主题（158 项 / 17 组，其中 48 项有深色覆盖；单一真源 + CSS/W3C/SCSS 三产物 + 校验） | 已落地（KB-02） |
| 基础组件库（26 个文件 / 27 个导出组件 + 五态门禁） | 已落地（KB-03） |
| 存储布局与集合标识规则（工作区隔离、路径包含性） | 已落地（KB-10） |
| 配置校验（分片/重叠/最小分片/阈值，配置错误在加载期失败） | 已落地（KB-10） |
| zvec 集成（双槽位快照 / HNSW+COSINE+INT8 / 写入 / 混合检索 / 崩溃恢复） | 已落地（KB-10，53 项验收全绿） |
| 切分器（三种模式 + token 估算 + 代码块保护 + 逐项策略验证） | 已落地（KB-10 交付，KB-07 复用；`verify:chunking` + `verify:evidence`） |
| 索引构建流水线（四阶段 / 进度轮询 / 取消 / 增量重建 / 资源清理） | 已落地（KB-10 交付，KB-07 复用；`verify:buildjob` + `verify:incremental`） |
| 面板宿主与面板内导航（外壳由宿主布局承担，插件只提供面板体） | 已落地（KB-04，`verify:kb04kb05`） |
| 集合生命周期界面、文档上传、策略配置页、检索测试页 | 已落地（KB-05 … KB-07，`verify:upload` + `verify:settings` + `verify:retrieval-page`） |
| `dsh_kb_search` 工具与 RAG 问答 | 已落地（KB-08、KB-09） |
| 引用可点击 → 右侧栏原文阅读（`sidebar.right.pane.tab`） | 已落地（KB-13，27 项验收 + 43 项客户端链路全绿） |
| 随包分发并向宿主注册两份 RAG Skill（懒绑 `skills`，附只读快照的诊断脚本） | 已落地（`verify:skill`） |

## 引用可点击：右侧栏原文阅读（KB-13）

会话里 `dsh_kb_search` 的引用行是**真实链接**：点开后右侧栏打开一个阅读标签页，
显示被引用的那段原文，并把引用的那一行与命中的分片范围分别标出。

- **链接只在能打开时才渲染。** 需要三个条件同时成立：结果里解析出了可回溯的
  `source_path`、路径文件名能还原出 `doc_id`、以及宿主加载了右侧栏服务。
  任一不成立，该行保持纯文本——引用无法打开时它仍是引用（路径与行号可手工追）。
- **标的是快照正文，不是原始上传件。** 读的是入库时存下的同一份文本，也就是切分
  所依据的那份；原始文件可能已移动或被改写，引用不同版次会让引用本身无法被证伪。
- **窗口化返回。** 默认引用行上下各 40 行，桥接层再夹一层上限（最多 200 行），
  响应同时给出总行数，因此「这是节选」是明说的，不会被读成整篇。
- **两种标记不是一回事。** 引用行是回答印出的定位符，分片范围是检索实际返回的
  区间；两者分别标记，才能看出「引用行落在自己分片之外」这种真实状态。
- **地址即身份。** 地址形如 `dsh-kb-citation://<集合>/<docId>#L<行>`，同一文档的
  两次引用是同一个标签页的再导航，不会每查一行就多开一个页签。

## 安装

```sh
dsh plugin --profile <name> add <本包路径或仓库地址>
```

安装后重启目标 profile。`dsh plugin` 会把本包 pnpm 安装进 profile，并按 `dsh.bundle`
把 `cordis.patch.yml` 对账进 profile 的 `dsh.profile.bundles` 层列表。

### 首次安装：必须放行 `@zvec/zvec` 的构建脚本

pnpm ≥10 默认拦截依赖的安装脚本，`@zvec/zvec` 带有 `postinstall`
（`node scripts/install.js`，用于解析预编译原生绑定 `zvec_node_binding.node`）。
被拦截时 `dsh plugin add` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败，**且 `dsh.profile.bundles`
不会对账**（依赖已写进 `dependencies`，但插件层缺失，表现为重启后界面什么都不出现）。

在 profile 的 `pnpm-workspace.yaml` 中把 `@zvec/zvec` 加进 `onlyBuiltDependencies` 与
`allowBuilds`，然后重跑 `add`：

```yaml
onlyBuiltDependencies:
  - "@zvec/zvec"
allowBuilds:
  "@zvec/zvec": true
```

该脚本是良性的：绑定已随包存在时它直接 `exit 0`，既不编译也不下载任意代码
（见 `node_modules/@zvec/zvec/scripts/install.js`）。

## 开发

```sh
npm install
npm run build        # 生成令牌 → 双 program tsc → tsdown 客户端打包
npm run typecheck    # host / client 两个 program，均需干净
npm run verify       # 全链：31 条命令串行 `&&`（令牌同步 / manifest / 组件 / 对比度 / KB-10 /
                     # KB-04…KB-08 / 嵌入 / 配额 / 槽位 / 引用 / 规格 / 加载安全 / 桥接 /
                     # 构建作业 / 增量 / 策略证据 / 检索设置 / 发现 / 检索页 / 切分 / 客户端接线 /
                     # 回归 / 布局度量 / 上传 / 走查）；需先 `npm run build`，全链不需外网与 API key
npm run verify:kb10  # 仅跑 KB-10 持久化 / 隔离 / no-clobber / 崩溃恢复 / 句柄释放（53 项）
npm run verify:citation  # 引用链路：渲染形态 → 解析 → 地址 → 开页签，逐环断言（27 项）
node scripts/probe-citation-live.mjs  # 用真实知识库数据跑一遍 readCitation 窗口与边界
npm run verify:kb01  # 全新 DSH_HOME 装 profile，断言 bundle 层与 --dump-config 插件层
npm run verify:deployed  # 校验已安装进 profile 的那一份产物，而不是源码树
npm run smoke:zvec   # 探测本机 zvec 绑定能力与分数语义
```

> `verify:kb01` 需要一个可用的 `dsh` 命令。它会建一个临时 `DSH_HOME`，安装本包，
> 并断言 `dsh.profile.bundles` 里出现 `dsh-zvec-knowledge`、`--dump-config` 中出现完整插件层
> （含 `minScore` 等末位键，防止截断的假证据）。成功后清理，失败则保留现场供排查。
> 它不在 `npm run verify` 链内，同理被排除的还有 `verify:e2e`（需活的嵌入端点）、
> `verify:deployed`（需已安装的 profile）与 `smoke:zvec`。

> **本机使用 npm 而非 pnpm。** pnpm 11.22.0 在这台 Windows 上会在 hoist 阶段以
> `UNKNOWN: unknown error, symlink` 中止，只落下 `node_modules/.pnpm` 而不建顶层链接；
> 其计算出的相对链接目标并不指向虚拟仓条目。该阶段之前的包都已就位，属 hoist 环节缺陷。
> npm 不使用符号链接，可直接绕开。`node-linker` / `hoist` 写进项目 `.npmrc` 亦未生效
> （`pnpm config list` 里查不到这两个键），故未保留 `.npmrc`。

## 设计令牌

`tokens/kb-tokens.json` 是**唯一真源**。`scripts/gen-tokens.mjs` 从它生成三个产物：

- `src/client/styles/tokens.generated.css` — 浅色落在 `:root`，深色覆盖落在
  `body[data-ds-dark-theme]`（与宿主 `ui-theme` 同一约定）
- `tokens/w3c/kb-design-tokens.json` — W3C Design Tokens 导出
- `tokens/scss/_kb-tokens.scss` — SCSS 变量导出面（`$kb-*`），供构建期数值计算

三个产物都不得手工编辑：`npm run verify` 会重新渲染并逐一比对，不一致即失败。
所有令牌以 `--kb-` 前缀命名，避免与宿主 `--dsw-*` 令牌在同一作用域内碰撞；
`specName` 字段保留设计规范中的原始令牌名，映射关系一一对应。

> **SCSS 变量不随主题切换。** Sass 变量在构建期被替换，所以 `$kb-*` 只导出浅色值，
> 深色值以 `-dark` 后缀单独命名。凡需要随浅/深主题变化的样式，必须使用 `var(--kb-*)`；
> 用 `$kb-*` 写主题相关样式会静默丢掉深色模式。该规则同时写在生成文件的头部。

### 已记录的设计规范内部冲突

`tokens/kb-tokens.json` 的 `meta.conflicts` 逐条记录了取值层面的冲突与本次取值理由：

1. **`controlMd`**：规范 3.7 记 32，但 4.1 按钮、4.2 文本框、4.3 下拉与分段控件均为 34。
   此处取 34（三处一致的组件定义优于单处数值），标记 `derived: true`。
2. **顶栏分割线**：规范 3.2 规定分割线只用 `neutral-200`，但 6.1 顶栏用 `#E9ECF2`（不在令牌表内）、
   5.1 卡片内分隔线用 `neutral-100`。新增两个具名令牌承载实测值，不再算裸色值。
3. **浅色状态描边缺失**：3.3 只有实色/底纹/文字三列，而 2.3 与 4.5 要求状态胶囊「文字+实色+描边」
   三件套。浅色描边为派生值，标记 `derived: true`，待设计侧确认。
4. **令牌集口径（已拍板）**：规范记 51 项（Color 22 + Scale 29），实现为 158 项（17 组）。
   差额来自组件级尺寸（标签高 26、胶囊 26/22、徽标 20、图标按钮 34×34、开关 38×22、
   进度条高 5 等）未纳入规范的 Scale 集，以及状态描边、置信度分档、聚焦环等实现必需项。
   **处置：确认扩充令牌集**（不收敛回 51 项），KB-02 的「无自造令牌」验收项按扩充后的集合重述，
   规范侧需回写 3.x 以对齐口径。

生成脚本每次都会把派生值清单打印出来，避免它们被当成定稿。

## zvec 集成的实测结论

`npm run smoke:zvec` 会在本机真跑一遍并把结论写进 `zvec-smoke-report.json`。三处与设计规范的
假设不同，已按实测实现：

1. **`score` 是距离，不是相似度。** 查询向量等于某文档时得 0，正交时得 1，返回列表按距离升序。
   规范 §3.4 的 `match_score` 是 0 到 1、越大越相关的相似度，因此实现必须反转：
   `matchScore = clamp(1 - distance)`。读成相似度会把最差命中排在最前，并让全部命中越过
   用来挡住弱证据的 0.55 阈值。
2. **没有 `PQ-INT8` 量化器。** 绑定提供的是 `FP16 / INT8 / INT4`，另加 RaBitQ 索引族
   （`HNSW_RABITQ` / `IVF_RABITQ`）。规范里「PQ-INT8（压缩 4×）」对应的是 `INT8`。
3. **默认度量是内积（IP），不是 cosine。** HNSW/IVF/DiskANN/FLAT 的 `metricType` 默认值均为 IP，
   必须按索引显式设置，否则分数尺度与阈值全部失准。

另外 `ZVecCreateAndOpen` 要求目标路径**不存在**，重开既有集合走 `ZVecOpen(path)`
（不接受 schema，建集合时的 schema 已随集合持久化）。

### 实施期追加的实测约束（KB-10，见 `scripts/zvec-probe*.mjs`）

1. **「路径已存在」报的是 `ZVEC_INVALID_ARGUMENT`**，不是 `ZVEC_ALREADY_EXISTS`，与参数非法同码。
   因此新建 / 重开不能靠错误码分派，必须按路径存在性判断。
2. **集合目录是独占锁定的**：同一路径第二次打开一定失败，**只读也一样**
   （`ZVEC_INTERNAL_ERROR: Can't lock .../LOCK`）。所以句柄必须按槽位池化并引用计数，
   不能按请求开闭；插件卸载时由 fiber disposer 释放，否则重载会撞锁。
3. **过滤语言用单等号 `=`**，`==` 直接语法报错；字符串单引号，支持 `LIKE` / `IN` / `BETWEEN`；
   `SELECT ... WHERE` 形式不被接受。过滤表达式统一由 `documentFilter()` 生成并转义。
4. **引擎自带 FTS 索引与 RRF 融合**（`multiQuerySync` + `rerank: { type: 'rrf' }`，tokenizer 支持
   `standard` / `ngram` / `jieba` / `whitespace`），中文实测命中，故不手写融合。
   但 **RRF 返回的是排名融合分，不是相似度**——量纲取决于 `rankConstant`，不能当 `match_score`。
   实现取「引擎融合的排序 + 该命中自身稠密距离归一化后的分数」。
5. **重建期间旧索引仍可读**，由双槽位（`a` / `b`）+ 原子指针翻转实现：写入非活动槽，
   发布时翻转 `meta.json` 的 `active`。取消或失败只丢弃非活动槽，检索全程读活动槽。

## 已知的规范与实现缺口

- 设计画板中的深色空态 / 加载 / 错误态尚未交付，KB-11 的对比度验收缺一轮深色样本。
- 浅色五态描边为派生值，见上。
- 集合配额：**默认无上限**（`quota.bytes: null`），因为规范未给数值、该数值属业务侧决定。
  一旦配置了数字即硬阻断——`admit()` 在上传与索引重建两个增长点收口（`host/operations.ts`），
  拒绝理由写明上限与缺口，占用靠遍历目录实测而非信计数器（`store/quota.ts`）。
  `quota.warnAt`（默认 0.9）让界面在被拒之前先出常驻横幅。缺口只剩业务数值未定，
  以及「配额横幅」依赖对错误文案的正则判定（`client/panel.tsx`），改文案需同步该处。
- 组件级尺寸已扩入令牌集（见「冲突」第 4 条），规范侧 3.x 需回写对齐。
