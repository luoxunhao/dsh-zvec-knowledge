# Worktree 基线说明

| 项 | 内容 |
|----|------|
| 分支 | `feat/kb-ref-collection-resolution` |
| 基线提交 | `a4a29e2`（master） |
| 起点提交 | `9791d4b`（本分支，新增 KB-REF-01..04 issue 文件） |
| 路径 | `E:\project\dsh\dsh-zvec-knowledge-kbref` |

## 为什么用 worktree

主工作区当时有另一批未提交改动（citation / 侧边栏引用任务：13 改 + 8 新增，
含 `plugin/package.json` 的 `verify:citation` 脚本改动）。
本轮 issue 与之无关，故从 `a4a29e2` 开**干净** worktree，两者互不干扰。

## 基线状态：**1 项预存在失败，与本轮 issue 无关**

`npm run verify` 在**未做任何改动**的基线上即为红。失败项：

```
FAIL  markup: shell renders six nav buttons — nav labels present
      (scripts/verify-kb04-kb05.mjs:360)
```

**判定依据**：该断言要求渲染产物中出现字面量 `RAG问答`：

```js
/知识库总览/.test(markup) && /RAG问答/.test(markup) && /设置/.test(markup)
```

但 `plugin/src/client/shell/AppShell.tsx` 在该提交上只有**五个**导航项，
且源码注释明确写着 RAG 是被有意移除的：

```
* RAG 问答 is omitted per KB-09's revised scope: RAG lives in the dsh conversation,
```

导航项实为：知识库总览 / 文档接入 / 索引构建 / 检索验证 / 设置。

即：**断言文案（"six nav buttons"）已过期，实现是对的。** 这是 master 上的既有缺陷，
不属于 KB-REF 范围。本分支**不修**它，以免混入无关改动。

若本轮 issue 的验收需要 `verify` 全绿，应把这一项作为**已知基线红**排除，
或另开一条 issue 单独修（建议后者）。

## 另一项注意：首次运行需先生成渲染产物

`verify-kb04-kb05.mjs:332` 依赖 `tmp/visual/light.html`，
新 worktree 中不存在，需先执行：

```
node scripts/render-visual.mjs
```

这是产物前置条件，非缺陷。
