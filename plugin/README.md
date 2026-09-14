# dsh-zvec-knowledge

DeepSeek Harness 的本地知识库插件，基于 [zvec](https://zvec.org) 进程内向量数据库。
把「文档」变成「可被 AI 检索的知识」，且不引入独立服务：文档留在本地，索引留在本地，
检索与生成通过插件暴露的工具完成。

设计与视觉真源是《DSH 知识库插件（基于 zvec）设计规范》v1.1.0（云端节点 `C4YbSKGQ5zE93u9UxlXon5`）。

## 当前实现范围

第一个切片落在**契约层**：包结构、构建双面、配置面、令牌系统、存储布局规则。
这些是用户 profile 一旦依赖就最贵的部分，所以先固化；集合生命周期与检索在其上叠加。

| 模块 | 状态 |
|------|------|
| 插件双面契约（bundle patch / host / client bundle） | 已落地 |
| 设计令牌与浅深双主题（105 项，单一真源 + 生成 + 校验） | 已落地 |
| 存储布局与集合标识规则（工作区隔离、路径包含性） | 已落地 |
| 配置校验（分片/重叠/最小分片/阈值，配置错误在加载期失败） | 已落地 |
| zvec 集成（建集合 / HNSW+COSINE / 写入 / 检索 / 持久化） | 已验证可用 |
| 集合生命周期、文档上传、索引构建流水线 | 待做（KB-05 … KB-07） |
| `dsh_kb_search` 工具与 RAG 问答 | 待做（KB-08、KB-09） |
| 页面与组件 | 待做（KB-03 … KB-09） |

## 安装

```sh
dsh plugin --profile <name> add <本包路径或仓库地址>
```

安装后重启目标 profile。`dsh plugin` 会把本包 pnpm 安装进 profile，并按 `dsh.bundle`
把 `cordis.patch.yml` 对账进 profile 的 `dsh.profile.bundles` 层列表。

## 开发

```sh
npm install
npm run build        # 生成令牌 → 双 program tsc → tsdown 客户端打包
npm run typecheck    # host / client 两个 program，均需干净
npm run verify       # 令牌产物同步检查 + manifest 契约门禁
npm run smoke:zvec   # 探测本机 zvec 绑定能力与分数语义
```

> **本机使用 npm 而非 pnpm。** pnpm 11.22.0 在这台 Windows 上会在 hoist 阶段以
> `UNKNOWN: unknown error, symlink` 中止，只落下 `node_modules/.pnpm` 而不建顶层链接；
> 其计算出的相对链接目标并不指向虚拟仓条目。该阶段之前的包都已就位，属 hoist 环节缺陷。
> npm 不使用符号链接，可直接绕开。`node-linker` / `hoist` 写进项目 `.npmrc` 亦未生效
> （`pnpm config list` 里查不到这两个键），故未保留 `.npmrc`。

## 设计令牌

`tokens/kb-tokens.json` 是**唯一真源**。`scripts/gen-tokens.mjs` 从它生成两个产物：

- `src/client/styles/tokens.generated.css` — 浅色落在 `:root`，深色覆盖落在
  `body[data-ds-dark-theme]`（与宿主 `ui-theme` 同一约定）
- `tokens/w3c/kb-design-tokens.json` — W3C Design Tokens 导出

生成物不得手工编辑：`npm run verify:tokens` 会重新渲染并比对，不一致即失败。
所有令牌以 `--kb-` 前缀命名，避免与宿主 `--dsw-*` 令牌在同一作用域内碰撞；
`specName` 字段保留设计规范中的原始令牌名，映射关系一一对应。

### 已记录的设计规范内部冲突

`tokens/kb-tokens.json` 的 `meta.conflicts` 逐条记录了取值层面的冲突与本次取值理由：

1. **`controlMd`**：规范 3.7 记 32，但 4.1 按钮、4.2 文本框、4.3 下拉与分段控件均为 34。
   此处取 34（三处一致的组件定义优于单处数值），标记 `derived: true`。
2. **顶栏分割线**：规范 3.2 规定分割线只用 `neutral-200`，但 6.1 顶栏用 `#E9ECF2`（不在令牌表内）、
   5.1 卡片内分隔线用 `neutral-100`。新增两个具名令牌承载实测值，不再算裸色值。
3. **浅色状态描边缺失**：3.3 只有实色/底纹/文字三列，而 2.3 与 4.5 要求状态胶囊「文字+实色+描边」
   三件套。浅色描边为派生值，标记 `derived: true`，待设计侧确认。

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

## 已知的规范与实现缺口

- 设计画板中的深色空态 / 加载 / 错误态尚未交付，KB-11 的对比度验收缺一轮深色样本。
- 浅色五态描边为派生值，见上。
- 组件级尺寸（标签高 26、胶囊 26/22、徽标 20、图标按钮 34×34、开关 38×22 等）未纳入
  规范的 Scale 令牌集，实现时必然出现裸尺寸；要么扩充令牌、要么放宽「无裸尺寸」验收项。
