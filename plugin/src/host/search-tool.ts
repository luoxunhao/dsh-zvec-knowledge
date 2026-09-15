/**
 * The `dsh_kb_search` retrieval tool.
 *
 * This is the plugin's model-facing surface: the one thing a session calls to turn
 * a question into knowledge-base evidence. Its contract is fixed by the design
 * spec (§9.2) and the issue list:
 *
 * - **Parameter names are exactly `query` / `collection` / `topk`.** No aliases and
 *   no camelCase drift, because the same three names appear in the interface, in
 *   the logs and in the tool schema, and a rename in one place would break the
 *   correlation the technical identifier exists to provide.
 * - **The output carries `match_score`, normalized to 0..1.** The engine's raw
 *   distance is an implementation detail the spec forbids exposing; the store layer
 *   already inverts it, and nothing here re-derives or re-exposes it.
 * - **Every failure returns judgeable text rather than throwing.** An empty result,
 *   a missing collection and a timeout are all *answers* — the model needs to tell
 *   them apart to decide what to do next, and an unhandled exception ends the turn
 *   instead.
 *
 * The description states when to call it, the precondition, the failure semantics
 * and the absence of side effects, because a tool description is the only place
 * the model learns those.
 *
 * @module dsh-zvec-knowledge/host/search-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KnowledgeOperations } from './operations.ts'
import { KB_SEARCH_TOOL } from '../shared/contract.ts'

/**
 * The slice of the operations contract the tool reads.
 *
 * Narrowed rather than taking the whole class so a test double can supply only
 * what the tool touches, and so the optional `retrievalSettings` channel is
 * visible here as optional — a host object without it falls back to the captured
 * deployment floor instead of failing every call.
 */
export type SearchOperations = Pick<KnowledgeOperations, 'embedQuery' | 'search'> & {
  /** Resolves the floor in force for one collection, when the host supports it. */
  retrievalSettings?: (collectionId: string) => { minScore: number, topk: number, source: 'collection' | 'deployment' }
  /**
   * Lists the collections a caller may choose from, for the discovery path.
   *
   * Optional so an existing test double keeps working: a tool double that never
   * omits `collection` never reaches it.
   */
  discoverCollections?: () => Promise<{ id: string, name: string, builtAt: string | null }[]>
}

// The wire name is declared once in `shared/contract.ts` and re-exported here, so
// the host registration and the client's tool-view cell cannot drift apart.
export { KB_SEARCH_TOOL }

/** Default hit count when the caller omits `topk`. */
export const DEFAULT_TOPK = 8

/** Hard ceiling on `topk`, so one call cannot pull an unbounded result set. */
export const MAX_TOPK = 50

/**
 * Confidence bands, from the design spec §3.4.
 *
 * Re-exported from the store rather than redefined. It previously existed twice —
 * an identical four-branch cascade here and in `store/collection.ts` — while this
 * file's comment claimed the thresholds "are stated once here". They were not, so
 * changing the spec's boundaries in one place would have left the tool describing
 * a hit with one band while the page rendered another for the same score.
 */
export { confidenceBand, type ConfidenceBand } from '../store/collection.ts'
import type { ConfidenceBand } from '../store/collection.ts'

/**
 * Render the stable, compact text a model reads for a hit list.
 *
 * Written to be judgeable without a second call: each line carries the score, the
 * band, the source and the location, so a model can decide whether the evidence is
 * good enough to answer from — which is the whole point of returning a normalized
 * score rather than raw text.
 * @param hits - the hits.
 * @param query - the query, echoed so a transcript is self-describing.
 * @param collection - the collection searched.
 * @param mode - which retrieval passes ran.
 * @param belowFloor - hits dropped by the score floor.
 * @returns the rendered text.
 */
export function renderHits(
  hits: { docName: string, ordinal: number, charStart: number, charEnd: number, text: string, matchScore: number, band: ConfidenceBand }[],
  query: string,
  collection: string,
  mode: 'hybrid' | 'dense',
  belowFloor: number,
): string {
  if (hits.length === 0) {
    const floorNote = belowFloor > 0
      ? `${belowFloor} 条命中低于相关性阈值，已按设计不返回。`
      : '没有任何内容达到相关性阈值。'
    return [
      `知识库 ${collection} 中没有找到与「${query}」相关的依据。`,
      floorNote,
      '建议：换用更具体的措辞，确认相关文档已上传并构建索引，或适当降低 minScore。',
    ].join('\n')
  }

  const lines = hits.map((hit, index) => {
    const preview = hit.text.replace(/\s+/g, ' ').trim().slice(0, 300)
    return `${index + 1}. [${hit.band} ${hit.matchScore.toFixed(2)}] ${hit.docName} #${hit.ordinal} (字符 ${hit.charStart}-${hit.charEnd})\n   ${preview}`
  })

  return [
    `查询「${query}」在 ${collection} 命中 ${hits.length} 条（${mode === 'hybrid' ? '稠密 + 全文混合' : '仅稠密向量'}）。`,
    ...lines,
    belowFloor > 0 ? `另有 ${belowFloor} 条低于阈值未返回。` : '',
  ].filter(line => line !== '').join('\n')
}

/** One hit as the tool's output schema declares it. */
export interface ToolHit {
  /** Source file name. */
  file: string
  /** Source document id. */
  doc_id: string
  /** Chunk ordinal within the document. */
  ordinal: number
  /** Character range within the source. */
  char_start: number
  /** End character offset. */
  char_end: number
  /** Chunk text. */
  text: string
  /** Normalized relevance in 0..1. Larger is more relevant. */
  match_score: number
  /** Confidence band derived from `match_score`. */
  band: ConfidenceBand
}

/** The tool's canonical output value. */
export interface ToolOutput {
  /** Whether the search itself succeeded. A false value still carries a usable message. */
  ok: boolean
  /** Machine-readable failure kind, absent on success. */
  reason?: 'empty_result' | 'collection_not_found' | 'invalid_argument' | 'timeout' | 'cancelled' | 'internal_error' | 'discovery_needed'
  /** One-line summary a model can act on. */
  summary: string
  /** The collection searched, when one was. */
  collection?: string
  /** The query, echoed. */
  query?: string
  /** Which passes ran. */
  mode: 'hybrid' | 'dense'
  /** Hits, best first. */
  hits: ToolHit[]
  /** Hits dropped by the score floor. */
  below_floor: number
  /**
   * Hits the full-text pass produced that have no vector evidence.
   *
   * These are scored at the fixed {@link FTS_ONLY_SCORE}, which any meaningful
   * floor filters — so a query that is a proper name can lose its *exact* match
   * to the threshold while the dense pass scores the same chunk poorly. Reporting
   * the count lets the model recognise "a lower floor may surface exact matches"
   * instead of reading the miss as absence.
   */
  fts_only_hits: number
  /**
   * The collections available, present on `discovery_needed` instead of hits.
   *
   * `collection` is optional on the input precisely because the model cannot guess
   * a `kb_<domain>_<hex>` id; this is what it chooses from, carrying the built
   * state so it avoids one that would answer nothing.
   */
  collections?: { id: string, name: string, built: boolean }[]
}

/** Bounds on the tool's cooperative timeout. */
const SEARCH_TIMEOUT_MS = 15_000

/**
 * Rejection sentinel for the search budget expiring.
 *
 * A sentinel string rather than a typed error because it crosses the
 * {@link Promise.race} boundary as a plain rejection; the catch block compares it
 * exactly, so it can never be confused with a store message that happens to
 * contain the word "timeout".
 */
const SEARCH_TIMEOUT_SENTINEL = '__kb_search_timeout__'

/**
 * Rejection sentinel for the caller withdrawing the call.
 *
 * Distinct from the timeout sentinel because the two need different reports — one
 * says the search was too slow, the other that nobody is waiting for it any more.
 * Sharing a sentinel reported a 0 ms cancellation as a 15-second timeout.
 */
const SEARCH_CANCELLED_SENTINEL = '__kb_search_cancelled__'

/**
 * Build the `dsh_kb_search` tool definition.
 *
 * `operations` is injected rather than imported so the tool has no ambient
 * dependency on a workspace: the caller resolves the store root per session, which
 * is the isolation dimension the persistence acceptance criterion is about.
 *
 * `minScore` is the *deployment default*, not the floor this tool applies: the
 * effective value is resolved per call from the searched collection, so a floor
 * tuned in the interface takes effect without a restart. The parameter stays
 * because the registration still needs a default for a collection that has none.
 * @param operations - the knowledge-base operations to search through.
 * @param minScore - deployment-default floor, used when the collection has none of its own.
 * @param timeoutMs - budget for one search. Injectable so a test can exercise the
 *   expiry path without waiting the real {@link SEARCH_TIMEOUT_MS}; production
 *   callers omit it and get the constant.
 * @returns the registry-ready tool definition.
 */
export function defineKbSearchTool(
  operations: SearchOperations,
  minScore: number,
  timeoutMs: number = SEARCH_TIMEOUT_MS,
) {
  /**
   * The tool's body, named so the discovery path can re-enter it with a resolved
   * collection id. A method could close over `this`, but the DSL owns how
   * `execute` is invoked and a named closure does not depend on that binding
   * surviving.
   * @param args - the call's arguments.
   * @param exec - the caller's execution context.
   * @returns the tool's output.
   */
  const runTool = async (
    args: { query?: string, collection?: string, topk?: number },
    exec: { signal: AbortSignal },
  ): Promise<ToolOutput> => {
    const query = args.query ?? ''
    const collection = args.collection ?? null
    const topk = Math.min(Math.max(args.topk ?? DEFAULT_TOPK, 1), MAX_TOPK)

    /** Build a failure value with a usable message. */
    const fail = (
      reason: ToolOutput['reason'],
      summary: string,
      mode: ToolOutput['mode'] = 'dense',
    ): ToolOutput => ({
      ok: false,
      ...(reason === undefined ? {} : { reason }),
      summary,
      ...(collection === null ? {} : { collection }),
      ...(query === '' ? {} : { query }),
      mode,
      hits: [],
      below_floor: 0,
      fts_only_hits: 0,
    })

    if (query.trim() === '') {
      return fail('invalid_argument', 'query 不能为空，请给出要检索的自然语言问题。')
    }

    // Discovery: with no collection named, the tool answers "which collections
    // exist" rather than failing. A model cannot guess a kb_<domain>_<hex> id, so
    // the failure mode this replaces (`collection_not_found`) gave it nothing to
    // correct with. One *built* collection is searched directly — the single-
    // collection deployment is the common case and needs no extra round trip —
    // while several present their list, with built state, for the model to choose
    // from.
    if (collection === null) {
      const listed = await operations.discoverCollections?.() ?? []
      // One built collection is the unambiguous target: re-enter with it named. One
      // *unbuilt* collection is not, because searching it would answer nothing —
      // the model is told that instead of receiving empty hits it cannot
      // distinguish from absence.
      if (listed.length === 1 && listed[0]?.builtAt !== null) {
        const only = listed[0] as { id: string }
        return runTool({ ...args, collection: only.id }, exec)
      }
      const summary = listed.length === 0
        ? '当前没有知识库。请先在知识库页面创建并上传文档。'
        : `当前有 ${listed.length} 个知识库，请指定要检索的集合：`
            + listed.map(item => `${item.id}（${item.name}${item.builtAt !== null ? '，已构建' : '，未构建'}）`).join(' / ')
            + '。'
      return {
        ok: false,
        reason: 'discovery_needed',
        summary,
        query,
        mode: 'dense',
        hits: [],
        below_floor: 0,
        fts_only_hits: 0,
        collections: listed.map(item => ({ id: item.id, name: item.name, built: item.builtAt !== null })),
      }
    }

    // The embedder is what turns the query into a vector; without one the tool
    // says so rather than failing obscurely deeper in the stack.
    if (operations.embedQuery === undefined) {
      return fail('internal_error', '宿主未提供嵌入模型，无法执行向量检索。')
    }

    // Cooperative cancellation plus a hard budget. Observing `exec.signal` is
    // only half the job: an embedding provider that ignores the signal (they
    // mostly take no signal at all) would leave the await pending forever and
    // the timeout would never fire. So each awaited step is also raced against
    // the budget, which is what makes the timeout a real bound rather than a
    // flag that is checked once the work has already finished.
    //
    // The two are tracked with **separate** sentinels. They previously shared one
    // controller, so a caller-initiated abort was reported as
    // `reason='timeout'` with the text "检索超时（超过 15 秒）" — at 0 ms, for a
    // call nobody had waited on. That is a misdiagnosis an operator acts on, so
    // the outcomes are distinct: the model gets `timeout` only when the budget
    // actually expired, and `cancelled` when the caller withdrew.
    const budget = new AbortController()
    const timer = setTimeout(() => budget.abort(), timeoutMs)

    /** Reject as soon as the budget expires, with the budget's own sentinel. */
    const expired = new Promise<never>((_resolve, reject) => {
      budget.signal.addEventListener('abort', () => reject(new Error(SEARCH_TIMEOUT_SENTINEL)), { once: true })
    })
    /**
     * Reject as soon as the caller aborts, with a distinct sentinel.
     *
     * A caller that has already withdrawn must be recognised immediately rather
     * than after the first await, which is why the already-aborted case is
     * checked here as well as listened for.
     */
    const withdrawn = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new Error(SEARCH_CANCELLED_SENTINEL))
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    })
    /** Race one step against both outcomes. */
    const within = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired, withdrawn])

    // `mode` is reported on failures too, so a caller that timed out mid-hybrid
    // is not told the search was dense-only. It is widened once the real mode is
    // known, and stays 'dense' only for a failure that happened before retrieval.
    let failureMode: ToolOutput['mode'] = 'dense'

    try {
      const vector = await within(operations.embedQuery(query))
      // The floor is resolved per call rather than captured at registration: the
      // deployment's config value is only a default, and the collection's own
      // setting — editable in the interface — is the one in force. A fixed value
      // here is how a threshold tuned in the UI stayed decorative.
      //
      // Optional on the operations contract so an older host object — a test
      // double, a tool built before this channel existed — still works with the
      // captured default rather than failing every call.
      const effective = operations.retrievalSettings?.(collection)
      const floor = effective?.minScore ?? minScore
      const result = await within(operations.search(collection, query, vector, topk, floor))
      failureMode = result.mode
      const hits: ToolHit[] = result.hits.map(hit => ({
        file: hit.docName,
        doc_id: hit.docId,
        ordinal: hit.ordinal,
        char_start: hit.charStart,
        char_end: hit.charEnd,
        text: hit.text,
        match_score: Number(hit.matchScore.toFixed(4)),
        band: hit.band,
      }))
      const summary = renderHits(result.hits, query, collection, result.mode, result.belowFloor)
      return {
        // An empty result is a successful call that found nothing: `ok` is false
        // so a caller can branch on it, while the summary stays actionable.
        ok: hits.length > 0,
        ...(hits.length > 0 ? {} : { reason: 'empty_result' as const }),
        summary,
        collection,
        query,
        mode: result.mode,
        hits,
        below_floor: result.belowFloor,
        // The full-text pass's solo findings, which any meaningful floor filters.
        // Reported because they are the case "the query named a term that exists"
        // — a bare empty_result reads as absence, and this is the number that says
        // a lower floor may surface the exact match.
        fts_only_hits: result.ftsOnlyHits,
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      // The budget's own sentinel, distinguished from a store error so the two
      // do not both read as "检索失败".
      if (message === SEARCH_TIMEOUT_SENTINEL) {
        return fail('timeout', `检索超时（超过 ${timeoutMs / 1000} 秒）。可缩小 topk 或稍后重试。`, failureMode)
      }
      // The caller withdrew. Reported as such rather than as a timeout: the two
      // need different responses, and telling an operator a call took 15 seconds
      // when it was cancelled at 0 ms sends them looking in the wrong place.
      if (message === SEARCH_CANCELLED_SENTINEL) {
        return fail('cancelled', '检索已取消。', failureMode)
      }
      // A missing collection is the one failure worth naming precisely: it is
      // the difference between "you typed the id wrong" and "something broke".
      if (/不存在|does not exist|not exist/i.test(message)) {
        return fail('collection_not_found', `知识库 ${collection} 不存在。请用正确的集合标识，或先在知识库页面创建它。`, failureMode)
      }
      return fail('internal_error', `检索失败：${message}`, failureMode)
    } finally {
      clearTimeout(timer)
    }
  }

  return defineTool({
    name: KB_SEARCH_TOOL,
    description: [
      '在本地知识库中做混合检索（稠密向量 + 全文，RRF 融合），返回带归一化分数的命中片段。',
      '',
      '何时调用：当用户的问题可能由已上传到知识库的文档回答时；或需要在回答前核实事实、给出引用来源时。',
      '必要前置条件：目标知识库必须已上传文档并至少成功构建过一次索引；未构建的知识库没有可检索的快照。',
      'collection 参数：可省略。省略时只有一个已构建的知识库会直接检索它；有多个会返回知识库清单（含 id、名称、构建状态），你从中选一个再次调用。',
      '入参：query（自然语言查询）、collection（可选，集合标识，形如 kb_prod_2f8a）、topk（可选，返回条数上限，默认 8）。',
      '出参：hits 数组，每项含 file / doc_id / ordinal / char_start / char_end / text / match_score / band；'
        + 'match_score 为 0 到 1 的归一化分数，越大越相关；band 为 strong / relevant / fair / low 四档。'
        + 'fts_only_hits 是仅有全文精确匹配、无向量证据的命中数——这类命中分数固定很低，若查询是专有名词且结果为空，可建议用户降低阈值。',
      '失败语义：不抛异常。空结果、知识库不存在、参数非法、超时、已取消都会返回 ok=false 与可读的 summary，'
        + '其中空结果同时给出 below_floor（低于阈值被过滤的条数），便于判断是"确实没有"还是"阈值过高"；'
        + 'reason 区分 timeout（预算耗尽）与 cancelled（调用方撤回）；discovery_needed 表示需要先指定 collection。',
      '副作用：无。只读取知识库，不写入、不修改任何数据。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '自然语言查询语句' },
      collection: { type: 'string', description: '知识库集合标识，形如 kb_prod_2f8a。省略时：只有一个已构建的知识库则直接检索它；有多个则返回清单供你选择' },
      topk: { type: 'integer', description: `返回条数上限，默认 ${DEFAULT_TOPK}，最大 ${MAX_TOPK}` },
    },
    output: {
      schema: {
        type: 'object',
        // `additionalProperties` is mandatory on every object node in this DSL:
        // it is how the schema states whether undeclared keys are tolerated. The
        // output is fully specified, so extra keys are refused rather than
        // silently ignored.
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          collection: { type: 'string' },
          query: { type: 'string' },
          mode: { type: 'string' },
          below_floor: { type: 'integer' },
          fts_only_hits: { type: 'integer' },
          collections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                built: { type: 'boolean' },
              },
            },
          },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                doc_id: { type: 'string' },
                ordinal: { type: 'integer' },
                char_start: { type: 'integer' },
                char_end: { type: 'integer' },
                text: { type: 'string' },
                match_score: { type: 'number' },
                band: { type: 'string' },
              },
            },
          },
        },
      },
      // The rendered text is what the model reads. It is rendered from the same
      // canonical value the schema declares, so the two cannot diverge.
      //
      // The DSL infers every property as optional (a JSON Schema object has no
      // required list at this level), so the renderer falls back rather than
      // asserting: a missing summary means the value did not come from this tool,
      // and saying so beats rendering "undefined".
      render: (_args, value) => [{ type: 'text', text: value.summary ?? '检索未返回可判定的结果。' }],
      presentationMeta: (_args, value) => ({
        hits: value.hits?.length ?? 0,
        mode: value.mode ?? 'dense',
        ok: value.ok ?? false,
      }),
    },
    execute: runTool,
  })
}
