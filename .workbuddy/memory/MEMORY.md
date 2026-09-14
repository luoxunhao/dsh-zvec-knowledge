# DSH 知识库插件（基于 zvec）· 项目长期约定

## 交付物与唯一目标位置

| 交付物 | 位置 |
|--------|------|
| 设计系统画布（浅色 9 画板） | `https://ardot.tencent.com/file/725638110709460` |
| 深色主题画布（4 画板） | `https://ardot.tencent.com/file/725651358440443` |
| 设计规范文档**云端正式版** | 资料库「我的文档」节点 `C4YbSKGQ5zE93u9UxlXon5`（kind=drive）<br>`https://www.workbuddy.cn/space/d/C4YbSKGQ5zE93u9UxlXon5` |
| 本地流水线产物根 | `output/a7f3c1e8-42b9-4d76-9f10-83c5be2d7a64/` |
| issue 拆分清单 | `issues/DSH知识库插件-issue拆分清单.md`（11 条 KB-01…KB-11 + 依赖图 + 待决项） |
| **插件代码** | `plugin/`（包名 `dsh-zvec-knowledge`，host+client 双面，构建产物 `lib/`） |

**插件包的对齐基线**：本机全局 `@deepseek-ai/dsh` = `0.1.5-rc.1`；harness 源码 checkout
`E:\project\dsh\deepseek-harness`（master `c291e7961a`，v0.1.5-rc.2，**只读**）用于取契约。
peer 版本写 `0.1.5-rc.1 || 0.1.5-rc.2`。第三方插件写法的实操模板看 `E:\project\dsh\dsh-agent-teams`。

**用户的明确约定：之后对设计规范文档的改动，一律在资料库云端版本上原地更新（`--node-id` 替换，禁止另传同名新文件），不要把本地文件当成交付终点。**

## 设计令牌真源

- 浅色基准：品牌 `#4F5BD5`；应用底 `#F5F6F9`；卡片 `#FFFFFF`；描边 `#E1E5EC` / `#CBD2DE`；文字 `#131619` / `#6B7484` / `#9AA3B2`
- 深色基准：品牌 `#6F7BE8`；画布 `#0B0D10`；应用底 `#121519`；卡片 `#171A20`；次级填充 `#1D2128`；描边 `#2C313C` / `#3A404D`；文字 `#EDF0F5` / `#A7B0BF` / `#8A93A3`
- 语义状态与检索置信度四档（浅/深）以文档第 3、7 章与画布为准
- 界面字体 Noto Sans SC；所有技术值（集合标识、分片数、分数、时间戳）用 JetBrains Mono 等宽数字

## 产品与工程约定

- 检索工具名固定 `dsh_kb_search`；入参 `query` / `collection` / `topk`；出参含归一化后的 `match_score`
- 集合标识格式 `kb_prod_2f8a`（业务域缩写 + 短哈希）
- 默认策略：切分按标题层级 1024 / 重叠 128 / 最小 64；索引 HNSW + PQ-INT8；相似度阈值 0.55
- 参数变更必须重建索引才生效，主按钮文案固定「保存并重建索引」
- **用户明确暂缓**：创建知识库分步向导（不要主动开工，等业务确认）

## 环境坑（动手前必读）

0. **插件包用 `npm install`，不要用 pnpm**：pnpm 11.22.0 在本机 Windows 上会在 hoist 阶段以
   `UNKNOWN: unknown error, symlink` 中止（exit -4094），只落 `node_modules/.pnpm` 不建顶层链接；
   项目级 `.npmrc`（`node-linker` / `hoist`）**不被读取**，无效。`dsh plugin --profile add` 走 pnpm，
   但 dsh 会给 profile 写 `nodeLinker: hoisted`；不过它仍需在 profile 的 `pnpm-workspace.yaml`
   把原生依赖的 `allowBuilds` 置为 `true`（dsh 已写好占位项），否则 pnpm 因
   `ERR_PNPM_IGNORED_BUILDS` 报错退出且**不会 reconcile bundle 层**。
   另：pnpm store 在 `E:\.pnpm-store`（盘根）时建符号链接会失败，可用 `npm_config_store_dir` 改到工作区内。
1. **路径含中文时，Edit 工具会静默失效**（返回成功但不改文件）。含中文路径的批量改写一律走 **Python 脚本**，输出落 ASCII 路径，再用 PowerShell `Copy-Item` / `Move-Item` 改回中文名。
2. PowerShell 的 stdout 在本环境不回显；python 的 stdout 重定向到 `Out-File` 会二次编码。可信做法：**让脚本直接写 UTF-8 文件**，再用 Read 读。
3. 命令字符串里的中文字面量会被有损传递；需要中文参数时写进 UTF-8 文件再读出，或用通配符取全路径。
4. `html-to-docx` 官方 setup 脚本在本机不可用（缺 `dirname`）；用托管 Python 自建 venv：
   `C:\Users\admin\.workbuddy\binaries\python\envs\html-to-docx`，再 `python -m html_to_docx convert`。
5. Ardot：复制 frame 后子节点 ID 会重排，必须 `batch_read` 读回新 ID；SVG 坐标必须落在 viewBox 内，否则节点创建失败。
6. **Bash 工具基本不可用**：PortableGit shim 缺 `dirname`/`cd`/`ls`/`head`/`find`。文件操作一律用
   Glob / Grep / Read / Write（Write 对中文路径正常）。
7. **不要 `Remove-Item -Recurse` 删 `node_modules`**：会触发安全护栏（>50 项需确认）并挂住进程。

## 插件侧技术约定（已实测）

- **zvec**：`@zvec/zvec` 0.7.1（阿里，Apache-2.0，进程内）。`querySync` 的 `score` 是**距离**（越小越相似，
  列表已按距离升序），`match_score` 必须 `clamp(1 - distance)`。量化器只有 FP16/INT8/INT4，
  **没有 PQ**（RaBitQ 是索引类型 `HNSW_RABITQ`/`IVF_RABITQ`）。`metricType` **默认 IP 不是 cosine**，
  必须显式设 COSINE。`ZVecCreateAndOpen` 要求路径不存在，重开走 `ZVecOpen(path)`。
- **客户端平台模块表**（rc.2）只有 9 项：react、react/jsx-runtime、react-dom、react-dom/client、
  `@deepseek-ai/cordis`、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives、dsh-client-ui-dockkit。
  其它 `@deepseek-ai/*` 值导入被纯度门拦（type-only 会被擦除，安全）。
- **主题选择器**：浅色 `:root`，深色 `body[data-ds-dark-theme]`。
- **别把临时数据写进 `lib/`**：`files` 含 `lib`，会被 `npm pack` 打进发布包。已加 `tmp/` + `.gitignore` +
  `prepack` 先构建。
