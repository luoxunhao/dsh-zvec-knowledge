# dsh-zvec-knowledge 架构梳理

对仓库源代码的通读结果。基准：`master` @ `a4a29e2` + 未提交的 KB-13（引用可点击）改动。
行文按"契约 → host → store → client → 验证 → 部署"分层，引用形式为 `文件:行`。

## 1. 仓库定位与目录职责

一个 DeepSeek Harness（dsh / cordis）的**双面插件**：把本地文档变成会话可检索的知识，
不引入独立服务——文档、索引、检索都在宿主进程内，向量引擎是 `@zvec/zvec`（进程内原生绑定）。

| 目录 | 职责 |
|------|------|
| `plugin/` | 唯一可交付主体：`src/` 源码、`scripts/` 50 个门禁与探针、`tokens/` 设计令牌真源、`cordis.patch.yml` bundle 挂载层 |
| `output/<run-id>/stage1/final_draft.md` | 设计规范 v1.1.2 的 **markdown 真源**（被 `verify:spec` 读取，故纳入版本控制）；stage2/stage3 是生成的 html/docx，已被忽略 |
| `issues/` | KB-01…KB-13 交付拆分清单 + KB-FIX-01…11 修复拆分清单 |
| `zvec-rag-loop/`、`zvec-rag/`、`dsh-plugin-development/` | 三份 SKILL.md：第一份管检索工作流（选库/分解/迭代/核实/成因），第二份管结果呈现（引用、band 与分数、空结果措辞），第三份是插件开发的取证顺序与安装/验证矩阵。前两份随包分发到 `plugin/skills/`，由 `verify:skill` 逐字节比对 |
| `.dsh-kb-zvec/`、`.workbuddy/`、`.agent-teams/`、`.dsh-vision-router/`、`plugin/lib/` | 运行时产物、草稿、团队状态、截图、构建输出——全部 gitignore |

规模：`src/` 18,101 行 TS/TSX（76 文件）+ 5,003 行 CSS（38 文件）。分层分布
client 9,068 / store 4,822 / host 3,496 / src 根 535（`index.ts`+`config.ts`）/ shared 146。
数字取自本轮改动后的工作树。

## 2. 双面契约与构建管线

三份产物、两个编译 program、一条纯度门禁。

- **挂载契约**：`package.json` 的 `dsh.bundle.patch = ./cordis.patch.yml`，`dsh.client.platform = web` +
  `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`。patch 层以 `insert` 写入
  `id: zvec-knowledge`、`name: 'dsh-zvec-knowledge'`（必须与包名同步）和全部部署期配置。
  设计取向明确写在该文件头部：**可变部署选择一律放 patch，不做源码常量**。
- **导出面**：`.` → `lib/index.js`（host），`./client` → `lib/client.js`（浏览器 bundle），
  外加 `./cordis.patch.yml` 与三个令牌产物（`./scss`、`./tokens.json`、`./tokens.w3c.json`）。
- **双 program**（`tsconfig.json` / `tsconfig.client.json`）：host 侧 `NodeNext` + `types: ["node"]`、
  `exclude: ["src/client"]`；client 侧加 `DOM`、`jsx: react-jsx`、`types: []`，
  且只 include `src/client`+`src/shared`。共享的只有 `src/shared/contract.ts`（146 行）——
  这就是浏览器半与宿主半之间全部的编译期耦合。
- **客户端打包**（`tsdown.config.ts`）：输出是 CJS 闭包工厂，
  `window.__ModuleLoader__.load({ id, factory })`（`output.banner/footer/intro`），
  所有 external 经宿主模块表解析。三条硬规则在构建期而非评审期执行：
  1. **纯度门禁** `dsh-client-bundle-purity`（`resolveId` 直接抛错）：平台模块表 +
     本包 `dsh.client.external` + `INLINE_SAFE` 名单 + `*/remote` 生成物之外，任何
     `@deepseek-ai/*` 取值 import 都构建失败——禁止跨插件取值 import。
  2. CSS Modules 走 lightningcss，导出哈希类名表；类名映射**排序后**输出，
     否则 `lib/client.js` 每次构建字节抖动。
  3. 普通/`?inline` 样式表在工厂执行时注入 `<style data-plugin-css>`，bundle 自带样式，不依赖宿主资源路由。
  `PLATFORM_MODULES` 是**从宿主 `packages/client/web/src/platform.ts` 手抄**的（注释标了
  0.1.5-rc.2 / HEAD c291e7961a 和 "Re-check it when the harness moves"）。

## 3. host 半：注册、解析、通道

入口 `src/index.ts`。`inject = ['tools']`（必需， fiber 挂起等注册表），
`webServer` **故意不声明**——改由 `ctx.inject(['webServer'], …)` 懒绑，
这样无 web 的 headless profile 仍能保留 `dsh_kb_search`（`index.ts:113-131`）。

`apply()` 注册两个 effect，卸载顺序固定：先 `disposeJobs()`（在跑的构建持有句柄且正写），
再 `disposeAll()` 释放句柄池（`index.ts:133-150`）。原因是引擎**按集合目录独占加锁、只读也一样**，
句柄泄漏的后果不是内存而是"该集合直到进程退出都打不开"。

**工作区解析**是这层最关键的设计：store root 从不调用 `process.cwd()` 作为首选，
而是 `ctx.get('sessions').list()` 里第一个 `session.header.cwd`（`index.ts:305-319`）。
注释里记了一个真实事故：早前"防御性"读 `ctx.workspaceDir`，而 cordis context 是代理，
读未声明属性**抛错**，抛在 `apply()` 里 → 整个 profile 起不来。因此这里只能用 `ctx.get(...)`。
`KnowledgeOperations` 的 `workspaceDir` 允许是 `string | () => string`，每次操作 `bound()` 解析一次
并按 workspace 记忆化子实例（`operations.ts:349-370`），所以一次调用不会跨两个 store。

`host/operations.ts`（1,733 行）是唯一的用例集合，方法按关注点分五组：
集合 CRUD / 文档与上传 / 构建控制 / 检索与策略证据 / 配额与设置（明细见 §5、§6）。
`host/embedding.ts` 是 OpenAI 兼容 `/v1/embeddings` 客户端：按 `batchSize` 分批，
只对 `rate_limited|server|network` 重试 3 次（指数退避 + 抖动），`auth|bad_request|malformed` 直失败；
返回体按 `index` 归位，只有全部条目 index 唯一且在范围内时才重排，否则顺序落位并 `onWarn`。
**它不校验维度**——宽度由 `config.embedding.dimension` 决定并传进 schema，模型换宽会在引擎侧暴露。

`host/search-tool.ts`（538 行）定义 `dsh_kb_search`：参数 `query`(必填) / `collection`(选) / `topk`(≤50)；
`collection` 缺省时走 `discoverCollections()`，只有一个"已构建"集合则自动带入，
否则返回 `reason: 'discovery_needed'` + 候选列表（`:307-326`）。阈值取"集合设置 → 部署配置"次序，
超时 15s 与"被撤回"用两个哨兵区分（`:217,:226,:362`），空结果把 `below_floor` 与 `fts_only_hits`
分开上报（`:406-422`）。模型侧看到 `renderHits` 的编号文本（`文件:行 (字符 a-b)` + 分档 + 分数 + 300 字预览）。

**桥接层** `host/bridge.ts`（662 行）：在 `webServer` 上注册两个 `kind:'exact'` 路由
—— `/api/_kb_zvec`（JSON-RPC 式单路由派发，23 个 case）与 `/api/_kb_zvec/upload`。
鉴权是每次启动 `randomBytes(32)` 铸的进程级 token，经宿主 `webserver/index-inject` 瀑布以
`{kind:'global'}` 写进 HTML 的 `__DSH_KB_BRIDGE_TOKEN__`，请求头 `x-kb-bridge-token` 带回，
`timingSafeEqual` 比对，不符直接 403。JSON 体上限 256 KiB **边读边限**。上传不是 multipart：
原始 body 流 + 元数据放请求头（`x-kb-collection` / `x-kb-file-name`(URI 编码) / `x-kb-file-size`），
宿主据此在读字节前拒绝；`req.on('close')` 中断写盘。构建进度是**轮询**而非流式：`buildIndex`
只点火返回，客户端每 1200ms 拉 `buildStatus`。桥接层的自我定位写得很清楚：
loopback 上任何进程都可达，它刻意不是第二套鉴权系统（`bridge.ts:28-33`）。

`host/skill-bundle.ts` 把本包 `skills/<name>/SKILL.md` 注册进宿主的 skill 服务：
`registerKbSkills` 遍历一层目录（对齐 DSH 文件 provider 的发现形状，不递归），解析 frontmatter 的
`name`/`description`/`whenToUse`，把去掉了 frontmatter 的正文作为 `content`、把该目录作为 `resourceBase`
交给 `ctx.skills.register()`，返回一个汇总 disposer。`index.ts` 用 `ctx.inject(['skills'], …)` 懒绑它——
和 `webServer` 同一个理由：skill 服务来自 opt-in 插件，缺它的 profile 必须照常加载并保留工具。
目录缺失或 `name` 非 kebab-case 直接抛：这些文件只由本包产生，`verify:skill` 每次全链都会真跑一遍注册，
所以这里是"构建坏了"而不是"用户会遇到"。runtime 注册的 rank 是 250，
排在 `<gitRoot>/.dsh/skills`(100) 与 `<gitRoot>/.agents/skills`(200) 之后，项目自己放的副本会赢。

## 4. store 半：磁盘布局、生命周期、引擎事实

`store/paths.ts` 定死布局：`resolveStoreRoot(workspaceDir, stateDir)`，集合目录名必须匹配
`/^kb_[a-z][a-z0-9]{0,15}_[0-9a-f]{4}$/` **且**对根前缀做包含性校验——畸形 id 无法变成路径穿越。
每个集合目录：`meta.json`（既是元数据也是槽位指针）、`documents.jsonl`、`build-log.jsonl`、
`sources/doc_<hash>.md`（逐字节原件，永不覆写）、`a/`、`b/` 两个引擎目录。

`store/atomic.ts` 是写入纪律：`writeFileAtomic` = 同目录 `.pid.ts.rand.tmp` + `writeSync` +
`fsyncSync` + `renameSync`（+ POSIX 下 `syncDirectory`）；`appendJsonl` 明确**非原子**，
因此 `readJsonl` 只丢弃**末尾**一条撕裂行，中间损坏直接抛（`:174-193`）；
`writeFileStreamed` 走 `.part` 并在中止时 unlink；`withFileLock` 是**按 key 的进程内 promise 链**，不是全局互斥。

生命周期：`createCollection` 只写元数据、`active: null` → 界面显示"待构建"。
上传 = `admit`(配额) → `sourcePath` → `writeFileStreamed` → `extractVerbatim`（去 BOM）→
`appendDocument`，其中 `DocumentRecord.chunks` 用 `null` 表"未测量"、`0` 表"确实没产出分片"。
构建 `startBuild()`（`build.ts:218`）跑四个具名阶段：parse → chunk → index → publish，
返回 `RunningBuild { done, cancel }`。取消经 `AbortController` + `raceAbort` 抛 `BuildCancelled`，
两条退出路径都 `releaseSlot` + `discardSlot` 并记日志"检索仍返回上一次快照"。
`job.ts` 保证一个集合同时至多一个构建（第二个直接拒，不排队），进度靠 `jobSnapshot` 轮询，
`persistLog`/`readPersistedLog` 让上一次构建的尾部跨页面刷新还在。**崩溃恢复是纯元数据式的**：
`meta.json` 决定"已构建"还是"待构建"，重启不续跑。

zvec 的事实（`npm run smoke:zvec` 实测，写进 README 与代码注释，多条与设计规范假设相悖）：
- `buildSchema`（`collection.ts:148`）：向量字段 `embedding`/`VECTOR_FP32`，**每个索引族都显式写
  `metricType: COSINE`**（引擎默认是内积 IP）；量化器只有 `INT8/INT4/FP16/UNDEFINED`——
  规范里的"PQ-INT8"实际对应 `INT8`，RaBitQ 族刻意不暴露。HNSW `{m, efConstruction}`、
  IVF `{nList:10, nIters:10}`、DISKANN `{maxDegree:100, listSize:50}`。
- 标量字段：`doc_id` STRING+INVERT、`ordinal/char_start/char_end` INT64（不建索引）、
  `text` STRING + FTS，**tokenizer 固定 `jieba`**（实测 `standard` 对"翁家翌"返回 66 条命中但只有
  1 条真命中；`ngram` 对 `qwertyuiop` 给 69 条）。tokenizer 是建集合时确定的属性，
  所以 `SnapshotMeta.tokenizer` 必须持久化，变更即强制全量重建。
- 过滤语言用**单等号 `=`**（`==` 直接语法错），字符串走 `escapeLiteral`，统一由 `documentFilter()` 生成。
- 分数：`search()`（`retrieval.ts:135`）稠密走 `querySync`，混合走 `multiQuerySync` +
  `rerank:{type:'rrf'}`；**`match_score` 唯一来源是该命中自身的稠密距离** `clamp(1-d)`，
  RRF 融合分只决定排序、从不参与算术（FTS-only 命中记 `FTS_ONLY_SCORE=0.2`，低于 0.55 阈值）。
  先按下限过滤再截 topk，`belowFloor` 与 `ftsOnlyHits` 分开计数，按 id 去重。
- 双槽位原子发布：写非活动槽，`publishSlot` 在 `withFileLock` 下翻 `meta.json` 的 `active` 并记
  `chunks/docs/chunking/tokenizer`；重建期间读侧仍读旧槽。发布后 `reclaimStaleSlot`（`operations.ts:1658`）
  删除被顶掉的槽——20 篇文档的库实测滞留 24.24 MB / 62.01 MB（39%），
  而配额把这份谁都读不到的目录算进去（`operations.ts:1630`、`verify-fix-regressions.mjs:277`）。
- `registry.ts` 句柄池：key 为 `storeRoot\0id\0slot`，`acquire` 返回引用计数的 `HandleLease`，
  `release` 只减计数**绝不隐式关闭**；`Entry.closed` 提前打标，让"句柄已关"在本模块可识别，
  而不是引擎那句裸的 `Collection is closed`。

切分与策略证据：`chunk.ts`（670 行）三种模式 + token 估算 + 代码块保护 + 表格按行。
两个修过的实质缺陷留下了守卫：**CRLF** 未归一化时 `^(#{1,6})\s+(.*)$` 的 `$` 永不匹配，
167 KB 章节被切成 122 片且全部 `heading: null`（`normalizeNewlines`，`:133`）；
**overlap 必须真回退**（`sizeWindows` 里 `start = max(cut - overlapChars, start + 1)`，
`applyOverlap` 只负责量出实际重叠），并有 `cut >= text.length` break 防 21 片切出 1551 片。
`strategy-evidence.ts` 取代了"对整个语料预览"的旧设计：只抽一篇（最长）文档，
`verifyPolicies` 每个旋钮出一条 `PolicyCheck{setting,value,observed,satisfied,applicable}`，
样本无法佐证时 `applicable:false`（界面显示"本文档未涉及"）；代码块/表格的适用性从**源文本**
统计（`fenceCount`/`retainedTableRows`），避免被 `minChunkTokens` 删掉的内容冒充"通过"。
配额 `quota.ts` 靠**遍历目录**实测（`measureDirectory`，读不动就 `complete:false`）而非信计数器，
`admit()` 在实测不可得时放行、否则给出写明上限与缺口的拒绝理由；上传与重建两处都收口。

## 5. client 半：插槽注入、状态、令牌

`src/client/index.tsx`（357 行）是全部装配点：`inject = ['slots','inputTriggers']`，
一个 `ctx.effect` 内建 **一个** `port = createHostPort()` 供所有面共用。7 个接缝：

| 面 | 宿主 API | 落点 |
|----|----------|------|
| 主面板 | `slots.inject('main', …register({key:'knowledge'}))` | `KnowledgeBasePanel` |
| 侧栏行 | `slots.inject('sidebar.panellist', {id, order:100, label:'知识库'})` | `KnowledgeIcon` |
| 工具卡 | `slots.inject('tool.call.toolview', {key:'dsh_kb_search'})` | `SearchToolView` |
| 输入框按钮 | `slots.inject('conversation.input.right', {id:'kb-zvec-knowledge'})` | `KbButton` |
| 引用页签体 | `slots.inject('sidebar.right.pane.tab', {key: CITATION_ID})` | `CitationTabView` |
| 引用页签类型 | `ctx.sidebarRight.registerTabType(...)` | `citation-definition.ts` |
| `@` 补全 | `ctx.inputTriggers.registerSource(createKbTriggerSource(port))` | `kb-trigger.tsx` |

代码里写明并踩过三次约束：必须用 `inject` 而非裸 `register`（owner 包各自挂载、
**插件间激活顺序无保证**，注入未声明的槽位会抛）；侧栏 `id` 必须等于主面板 key，
否则那一行指向不存在的东西；`conversation.input.right` 的 owner share 是空的
（`renderSlot(..., {})`），所以拿 `inputActions.setDraft` 而不是 `inputTriggers.sessionOf(...)`——
后者曾让按钮每次都掉进 `catch`。销毁顺序逐项列出（`index.tsx:326-341`）。

状态：`KnowledgeBasePanel`（`panel.tsx`，778 行）是活的宿主，`app.tsx` 的 `KnowledgeBaseApp`
只被 `scripts/render-visual.mjs` 用来渲染视觉稿（真实路径下未挂载），
`app.tsx` 的实际作用是把 `KnowledgeBasePort` 契约和视图类型定下来。
视图选择在**模块级可观察单例** `panelState` 上，因为侧栏行和面板是两棵没有共同祖先的 React 树。
数据加载是显式编排：`Promise.all([listCollections, listBuilds, getUsage])`；
`storedStrategy` **合并**而非替换（保住只有客户端知道的 `model` id）；
`strategyEvidence`/`estimateCost` 350ms 防抖；构建"提交 + 1200ms 轮询"，
仅当作业 settle 才刷新集合与文档；挂载时会重新挂接已在跑的构建。
错误原样透出（规范 §8.1 禁"只给代码"），配额拒绝靠对错误文案正则 `/配额/` 提升为常驻横幅。

`bridge-client.ts`（299 行）实现 `KnowledgeBasePort`：token 每次调用重读全局
（宿主重启会换 token），读不到就抛而不是发空串；无重试，只有 abort。
上传用 `XMLHttpRequest`（fetch 给不出上传进度），`File` 直接当 body。

引用（KB-13，本次未提交的主体）：地址即身份
`dsh-kb-citation://<集合>/<docId>#L<行>`（`citation-tab.ts:91-93`），同一文档两次引用是
一个页签的再导航；`parseCitationAddress` 返回 `null` 而不抛，因为 `canOpen` 参与每次路由判定。
点开的正文读的是**入库快照文本**（不是原始上传件），host 侧 `readCitation` 按引用行上下各 40 行、
桥接层再夹到 200 行返回，并把"引用行"与"命中分片区间"**分别标记**——这样才能呈现
"引用行落在自己分片之外"这一真实状态；文档已删除 → `missing` 态。

设计令牌：`tokens/kb-tokens.json` 唯一真源 → `gen-tokens.mjs` 三产物（`tokens.generated.css`、
`tokens/w3c/*.json`、`tokens/scss/_kb-tokens.scss`），`--check` 逐字节比对，`clean-build.mjs`
刻意不删生成物（让手改持续是失败态）。全部 `--kb-` 前缀避让宿主 `--dsw-*`；深色挂在
`body[data-ds-dark-theme]`；SCSS 变量是构建期常量、**不随主题**，故深色值另以 `-dark` 命名，
主题相关样式必须用 `var(--kb-*)`。`meta.conflicts` 逐条记了规范内部取值冲突与本次取值理由。
组件层 26 个文件 / 27 个导出组件（`components/index.ts`）+ 五态门禁（`verify:components`：四个非默认态、禁裸色值、
每个 `px` 要么是发丝线要么在 `ALLOWED_PX` 名单里）。

## 6. 验证体系

`npm run verify` 是**一条 `&&` 顺序链**（32 条命令，先 `npm run build`，因为多数 gate import `lib/**`），
串行、首个失败即中止。问题域决定手法，六类：

| 类 | 手法 | 代表 |
|----|------|------|
| A 生成物/规格对账 | 纯文件比对，无宿主无 DOM | `gen-tokens --check`、`verify-manifest`、`verify-spec-tokens`（解析规范 3.1 令牌表）、`verify-contrast`（从令牌值算 WCAG 比值，深浅各自采样）、`verify-components` |
| B 真引擎 + 真临时目录 | import `lib/host/operations.js`，`mkdtempSync`，甚至真杀进程 | `verify-kb10`（53 项：耐久性/隔离/no-clobber/快照完整性，`spawn` 子进程后 `taskkill`）、`verify-build-job`、`verify-incremental-build`（以"嵌入器被要求嵌了多少条文本"为代价度量）、`verify-kb11-quota`、`verify-strategy-evidence`、`verify-chunking`、`verify-fix-regressions`、`verify-upload`、`verify-embedding`（自己起 `node:http` 服务而非 mock `fetch`） |
| C 插件契约（手搭 context） | mock ctx、真调 `apply()` | `verify-load-safety`（构造对未声明属性读取即抛的代理，复现"profile 起不来"）、`verify-kb08`、`verify-bridge`（含**顺序**断言：`tokenMatches(` 必须出现在派发之前；含声明清单 ↔ 派发表的双向集合比对）、`verify-skill`（逐字节比对仓库根与包内 skill 副本，对 stub 注册表真跑注册并证明 dispose 有效）、`verify-citation`、`verify-harness-slots`（对齐宿主机器可读槽位目录，缺宿主则非失败跳过）、`verify-client-wiring`（真执行 `lib/client.js` 的 `apply()` 并点按钮） |
| D 无 DOM 的渲染门禁 | 垫片 `window.__ModuleLoader__` + `globalThis.document` + `renderToStaticMarkup` | `verify-kb04-kb05`、`verify-kb06`/`-cancel`、`verify-kb07`、`verify-kb11-walkthrough` |
| E 无头 Chrome 度量 | `execFileSync` Chrome `--dump-dom` 读几何，缺 Chrome 则跳过 | `render-layout-check` + `measure-layout` + `measure-overflow` |
| F 探针/度量（不进链） | 需要外部状态 | `probe-live`（真宿主 HTTP，无 token 退 2）、`measure-*`、`debug-score`、`zvec-*` |

链外四个是刻意的：`verify:kb01`（要真 `dsh` CLI：建临时 `DSH_HOME`、装包、断言
`dsh.profile.bundles` 与 `--dump-config` 里完整插件层含末位键 `minScore`，防截断假证据）、
`verify:e2e`（要真嵌入端点，缺则干净跳过）、`verify:deployed`、`smoke:zvec`。
链内**没有任何 gate 需要外网或 API key**。

`verify-deployed.mjs` 是这套体系里最有特色的一份：它校验的目标是
`$DSH_HOME/profiles/<name>/node_modules/dsh-zvec-knowledge`——**已安装的那一份**，
断言部署的 `lib/client.js` 含修好的 `inputActions`/`setDraft` 路径且**不含**坏掉的
`triggerControllerOf`，走完 `package.json` 解析、`lib/` 完整性遍历，再动态 import 部署产物跑真建集合。
动机是踩过的坑：源码树全绿而部署的那份是旧的。目录缺失时退 0。

断言量级：`issues/…清单.md:29` 记的是"链内 557 项 / 14 个套件"，那是当时那次运行的数字。
本轮在同一工作树实测 `npm run verify` 为 **exit 0、32 条命令、其中 27 条打印计数汇总、
合计 896 项断言、0 失败、无跳过**（本机有 Chrome 故布局度量真跑，宿主已装故 `verify-harness-slots` 真比对）。
链内最大几项：KB-08 78、KB-07 75、KB-04/05 71、走查 56、对比度 54、KB-10 53。

## 7. 数据通路（三条，互不共享传输）

1. **会话内检索**：模型 → `dsh_kb_search` → `KnowledgeOperations`(per-call workspace) →
   `embedQuery`/`search` → `registry` 租约 → zvec 活动槽。全程进程内，无 HTTP。
2. **面板管理**：浏览器 React → `fetch`/`XHR` → `/api/_kb_zvec(_/upload)` + token 头 →
   `dispatch` → **同一个** `KnowledgeOperations` 实例 → 同一 store。构建进度靠轮询。
3. **引用回看**：工具卡把命中行渲染成按钮 → `openTab(CITATION_KIND, {contentId: 地址})` →
   页签体 `readCitation` → 宿主读回入库快照文本的窗口。

通路 1 与 2 共用句柄池，这正是独占锁纪律存在的原因：面板发起的重建会让会话侧的读
切到另一槽，而不是失败。

## 8. 配置面

| 字段（`cordis.patch.yml` / `config.ts:117-147`） | 默认 | 本仓库部署值 | 作用 |
|---|---|---|---|
| `stateDir` | `.dsh-kb-zvec` | 同 | 相对工作区解析，构成隔离维度 |
| `chunking.{mode,chunkTokens,overlapTokens,minChunkTokens}` | heading/1024/128/64 | 同 | 新集合默认策略（集合可覆盖） |
| `retrieval.{topk,minScore}` | 8 / 0.55 | 同 | **兜底**：集合级设置优先（`operations.ts:1069-1077`） |
| `quota.{bytes,warnAt}` | null(无限) / 0.9 | 同 | 上传与重建两处 `admit` |
| `embedding.{baseUrl,model,apiKeyEnv,dimension,batchSize}` | 整块可选；1024 / 64 | ollama `qwen3-embedding:4b`，**dimension 2560** | 缺该块则插件仍加载、构建明确拒绝 |

`assertValidConfig`（`config.ts:159-200`）在 `apply()` 里抛：`overlapTokens >= chunkTokens`、
`minChunkTokens > chunkTokens`、`minScore ∉ [0,1]`、`topk` 非正整数、`stateDir` 空白、
`quota.bytes` 非 null 也非正整数、`warnAt ∉ (0,1]` 等——**全部可从配置单独判定，故按仓库约定在加载期失败**。
`apiKeyEnv` 存的是变量**名**，因为 `--dump-config` 会打印这份文件。
嵌入 provider 不是配置字段（schemastery 装不下函数）也不是服务（宿主没有 embedding 端点），
而是 `setEmbeddingProvider()` 这个显式注入点 + `providerFromConfig()` 的端点构造。

## 9. 已发现的漂移与风险

通读时逐条回到源码/构建产物确认过。第 1–5 条已在本工作树修掉（见"处置"列），
第 6–12 条**只记录、未改动**。

| # | 事实 | 证据 | 影响面 | 处置 |
|---|------|------|--------|------|
| 1 | 桥接方法清单两处不一致：`KB_API_METHODS` 21 项，`dispatch` 实际 23 个 case，缺 `getEmbeddingInfo`、`getQuantizerOptions` | `contract.ts:78-102` vs `bridge.ts:299,305` | 契约表不再是权威清单，按它做校验/文档会漏 | **已修**：补齐 23 项，并在 `verify-bridge.mjs` 新增第 6 节做**双向集合比对**（漏报/多报都失败，含"不得重名"）；已用两个变异样本验证双向都能抓到 |
| 2 | 令牌数两处口径不同：生成物头与规范 §3.1 都是 158，README 两处写 133 | `tokens.generated.css:1-5`、`final_draft.md:37,122` vs 旧 `README.md:14,123` | 文档陈旧 | **已修** README 两处为 158 / 17 组 / 48 项深色覆盖。`tokens/kb-tokens.json:36` 的 `meta.conflicts` 说明串**仍写 133**，改它要连带动生成物，本轮未触碰 |
| 3 | README 的开发命令有失效项：`npm run verify:profile` 不存在（脚本名是 `verify:kb01`）；`verify` 的描述只列了 4 类，实际 31 条命令 | `README.md` 开发节 vs `package.json:53-83` | 照 README 执行会直接失败 | **已修**：命令名改对，`verify` 描述改为 31 条串行命令 + "需先 build、全链不需外网与 key"，并补 `verify:deployed` 与链外四个的说明 |
| 4 | README "已知缺口"称配额"只统计不阻断、未实现强制上限"；实际 `admit()` 在上传和重建两处收口，`cordis.patch.yml` 有 `quota.bytes`，`verify-kb11-quota` 真把库跑满 | `operations.ts:531,639,986` | 反向风险：读者以为没有硬上限 | **已修**：改写为"默认无上限，配置即硬阻断"，并把文案正则依赖列为剩余缺口 |
| 5 | README 范围表把 KB-04…KB-07 标"待做"，而五个页面与对应 gate 都在 | `src/client/pages/`、`issues/…清单.md:20-23` | 范围表低估已交付面 | **已修**：按 issue 清单的口径改成"已落地"并标出对应 gate；切分器/流水线仍按清单归属 KB-10 交付、KB-07 复用 |
| 6 | 工具卡头部时长是**硬编码** `38`：`summaryLine(hitCount, settled ? 38 : null, …)` | `SearchToolView.tsx:323`，规范文案见 `:12` | 给用户显示了一个不存在的测量值；`retrieveForDiagnostics` 其实返回 `searchedMs`（`operations.ts:1349`） | 未改 |
| 7 | 工具卡靠**正则反解宿主渲染文本**（`字符 a-b`、`在 X 命中`、`另有 N 条低于阈值`），宿主改文案即静默退化为纯文本引用 | `SearchToolView.tsx:191-271` vs `host/search-tool.ts:115-130` | 有意的取舍（让用户看到模型看到的原文），但两侧文案没有共享常量 | 未改 |
| 8 | 客户端 `inject` 声明了 `inputTriggers`，而 `client/services.ts` 只对 `slots` 做增强；代码本身容忍 `inputTriggers` 缺失（`index.tsx:227-230`） | 二者矛盾 | 若某宿主无 trigger 插件，fiber 挂起 → **全部**界面消失，与注释意图相反 | 未改 |
| 9 | 宿主槽位契约是**重述**而非 import（`slots.ts:85-156`、`sidebar-right.ts:61-92`、`kb-trigger.tsx:96-128`），`useInput`/`inputActions`、`tab`/`tabInfo`、`ctx.sidebarRight` 名字无守卫；`sidebar.right.pane.tab` 必须按页签类型 **id** 而非 kind 键控 | 注释自陈 + `tsdown.config.ts:31-43` 手抄 `PLATFORM_MODULES`（peers `0.1.5-rc.1 \|\| rc.2`） | 对宿主版本的耦合集中在这些字符串上；靠 `verify-harness-slots` + `verify-deployed` 兜 | 未改（该模式是跨插件取值 import 被纯度门禁禁止的直接后果） |
| 10 | 桥接层的鉴权边界与契约版本存在缺口 | 四条事实与源码位置见 `issues/桥接层鉴权与契约版本-缺口记录.md`（KB-SEC-01） | 本机进程可达全部写操作；host/client 版本不匹配无从判定 | 未改，待 KB-SEC-01 裁决 |
| 11 | 配额拒绝的识别靠中文文案正则 `/配额/` | `panel.tsx:673` | 文案改一词即失效 | 未改；已写进 README 缺口条 |
| 12 | `citation-definition.ts:56` 的 `canOpen` 只查前缀，而它自己与 `citation-tab.ts:99-103` 的注释都称这里做真正的地址解析 | 对比两处 | 注释与实现不符（解析在 `parseCitationAddress`），易误判覆盖面 | 未改 |

另有两处属于设计上的自认代价，记录以免被当缺陷"修掉"：崩溃恢复只到"元数据判定待构建"、
不续跑构建；`SearchOperations` 用 `Pick<>` 而非完整 `KnowledgeOperations`，让工具测试可 stub。

## 10. 核对情况

**通读轮**：`npm run typecheck`（host + client 两个 program，均通过，含未提交的 KB-13 改动）。
**修复轮（第 1–5 条）**之后：`npm run build` 通过（tsdown 客户端 388.77 kB），
`npm run verify` **全链 exit 0 —— 31 条命令、26 份计数汇总、875 项断言、0 失败、无跳过**，
其中 `verify-bridge` 从 26 项增至 31 项（新增的 5 项即第 1 条的双向比对）。
另用两个变异样本单独验证过该比对：把 `case 'readCitation'` 改名 → 报"服务未声明"；
往清单里加一个 `phantomMethod` → 报"声明未服务"。`git diff --cached --check` 干净。

**随包 skill 那一轮**（`host/skill-bundle.ts` + `verify-skill.mjs` + `plugin/skills/`）之后重跑：
`npm run typecheck` 与 `npm run build` 通过，`npm run verify` 全链 exit 0，
**32 条命令 / 27 份计数汇总 / 896 项断言 / 0 失败 / 无跳过**。
新门禁自身的负向验证：给包内 `skills/zvec-rag/SKILL.md` 追加一行注释 → 该门禁报
"byte-identical — drifted: SKILL.md" 并退 1，还原后回到 21 项全过；
`parseSkillMarkdown` 对 `name: Bad_Name` 抛错、`registerKbSkills` 对不存在的 skills 目录抛错，
两条都有断言。注册与 dispose 是对 stub 注册表真跑的，不是字符串比对。

仍未执行的只有链外四个：`verify:kb01`（需真 `dsh` CLI）、`verify:e2e`（需活的嵌入端点）、
`verify:deployed`（需已安装 profile，且 profile 里那份是本次改动**之前**构建的）、`smoke:zvec`。
第 6–12 条仍是静态判读：其中第 6、7 条的运行时表现、第 8 条在无 trigger 插件宿主下的表现
未做动态复现。文中所有数字取自当前工作树，不是任何提交态。

第 10 条的四项事实已逐条回到 `d71bc4e` 的源码复核，细节移入
`issues/桥接层鉴权与契约版本-缺口记录.md`（KB-SEC-01），本表只留概述与影响面。
复核更正两处：原述"失败以 HTTP 200 + `reason` 返回"只对业务失败成立，令牌缺失与不匹配
走 403（`bridge.ts:519,583`）；且 `bridge.ts:28-33` 注释指向的"README 安全说明"并不存在
（`KB_API_PATH` 在 `plugin/README.md` 出现 0 次，含"令牌"的 20 处全指设计令牌），
该悬空引用记在 KB-SEC-01 第 3 节。
