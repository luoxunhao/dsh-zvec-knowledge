# KB-REF 实施结果

| 项 | 内容 |
|----|------|
| 分支 | `feat/kb-ref-collection-resolution` |
| 基线 | `a4a29e2`（master） |
| 提交 | `9791d4b` issue → `057aa52` 基线说明 → `f4c7035` KB-REF-01 → `a2d7487` KB-REF-02/03/04 |
| 状态 | **四条 issue 全部完成** |

## 修复的缺陷

用户从 `@` 菜单选中知识库后，chip 序列化成的文本**已含正确标识**，
但模型仍以**显示名**传参，检索以「集合标识非法」失败，再靠
`discovery_needed` 多一次往返才拿到清单 —— **每次对话首调必然失败**。

根因：标识以**散文**形式出现，模型读作背景说明而非参数约束。
「文本提到了标识」到「参数真的用了这个标识」这一跳，没有任何代码保证。

## 各 issue 证据

### KB-REF-01 · 解析纯函数

新增 `src/host/resolve-collection.ts`：精确标识 → 精确名称 → 唯一前缀
→ 歧义 → 无匹配 / 空输入。不触碰 store、嵌入与文件系统。

**门禁** `verify-collection-resolution.mjs`：**17 项**，含与
`store.assertCollectionId` 的**行为一致性对照**（12 个样本 id），
使重述的正则无法与 store 悄悄背离。

**先红后绿已确认**：实现前运行得 `0 passed, 1 failed`
（`lib/host/resolve-collection.js` 不存在），实现后 17/17 绿。

### KB-REF-02 · 工具接线

解析插入位置在**发现分支之后、`embedQuery` 之前**：

- 失败不消耗嵌入与检索预算（原先是白跑一次往返才知道标识非法）
- `collection` 省略时的发现路径**完全未动**

返回的 `collection` 改为**解析后的标识** —— 否则调用方刚做的纠正对它自己不可见。
新增 `collection_ambiguous`，与「不存在」并列区分。

**门禁** `verify-collection-wireup.mjs`：**11 项**，跑在**真实 store
与真实构建索引**上（临时工作区、真实 HNSW 索引），因为缺陷恰在解析与检索
的接缝处，打桩的 store 测不出来：

| 断言 | 实测 |
|---|---|
| 显示名首次调用即成功 | `ok=true collection=kb_agentbook_5eed` |
| 不再需要发现往返 | `reason=-`（无 `discovery_needed`） |
| 整句模板可解析 | `ok=true` |
| 裸标识零回归 | `ok=true` |
| 未知名称可纠正 | `collection_not_found` + 候选清单 |
| 未知名称不消耗嵌入 | `hits=0 mode=dense` |
| 省略 collection 仍走发现 | `discovery_needed` |

### KB-REF-03 · 描述契约

描述与参数说明写明 `collection` 可传标识或名称、由宿主解析、重名报错并列候选；
`@` 引用场景要求直接用引用中的取值、不要改写。参数名 `query`/`collection`/`topk` 未动。

**门禁** `verify-ref-contract.mjs` 7 项，对照**注册后的实际描述文本**
（不是源文件），因为模型只看到前者。

### KB-REF-04 · chip 序列化

由整句散文改为参数片段开头；剪贴板形态保持 `@名称` 不变。

**门禁** 6 项（含中止信号仍拒绝、名称查询失败降级为标识、正文已无旧句式）。

**诚实声明**：本项是**启发式**，无法用测试证明模型一定遵循 ——
ticket 与源码 JSDoc 都写明了这一点，并指明真正的保证在 KB-REF-02。
门禁只断言**形状**与**降级分支**，不假装证明了模型行为。

## 全量门禁

```
npm run verify
```

**仅余 1 项失败，与基线完全一致**：

```
FAIL  markup: shell renders six nav buttons — nav labels present
```

这是 master 上的**预存在缺陷**（断言要求字面量 `RAG问答`，而该导航项
已按 KB-09 修订范围移除），与本轮改动无关，本分支**未修**。
详见 `00-worktree-baseline.md`。

新增 3 个门禁套件合计 **41 项断言**，全部通过。

## 未做的事

- 未改 `fileReferences`：已确认是死路（单例、载荷只有 `path`/`kind`）。
- 未重写 `@` 触发源注册链路：它工作正常，菜单确实弹出了。
- 未触碰 citation / 侧边栏引用任务：那批改动留在主工作区，与本分支隔离。
