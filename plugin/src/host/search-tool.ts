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
  reason?: 'empty_result' | 'collection_not_found' | 'invalid_argument' | 'timeout' | 'internal_error'
  /** One-line summary a model can act on. */
  summary: string
  /** The collection searched. */
  collection: string
  /** The query, echoed. */
  query: string
  /** Which passes ran. */
  mode: 'hybrid' | 'dense'
  /** Hits, best first. */
  hits: ToolHit[]
  /** Hits dropped by the score floor. */
  below_floor: number
}

/** Bounds on the tool's cooperative timeout. */
const SEARCH_TIMEOUT_MS = 15_000

/**
 * Build the `dsh_kb_search` tool definition.
 *
 * `operations` is injected rather than imported so the tool has no ambient
 * dependency on a workspace: the caller resolves the store root per session, which
 * is the isolation dimension the persistence acceptance criterion is about.
 * @param operations - the knowledge-base operations to search through.
 * @param minScore - normalized floor; hits below it are counted, not returned.
 * @returns the registry-ready tool definition.
 */
export function defineKbSearchTool(operations: KnowledgeOperations, minScore: number) {
  return defineTool({
    name: KB_SEARCH_TOOL,
    description: [
      '在本地知识库中做混合检索（稠密向量 + 全文，RRF 融合），返回带归一化分数的命中片段。',
      '',
      '何时调用：当用户的问题可能由已上传到知识库的文档回答时；或需要在回答前核实事实、给出引用来源时。',
      '必要前置条件：目标知识库必须已上传文档并至少成功构建过一次索引；未构建的知识库没有可检索的快照。',
      '入参：query（自然语言查询）、collection（集合标识，形如 kb_prod_2f8a）、topk（可选，返回条数上限，默认 8）。',
      '出参：hits 数组，每项含 file / doc_id / ordinal / char_start / char_end / text / match_score / band；'
        + 'match_score 为 0 到 1 的归一化分数，越大越相关；band 为 strong / relevant / fair / low 四档。',
      '失败语义：不抛异常。空结果、知识库不存在、参数非法、超时都会返回 ok=false 与可读的 summary，'
        + '其中空结果同时给出 below_floor（低于阈值被过滤的条数），便于判断是"确实没有"还是"阈值过高"。',
      '副作用：无。只读取知识库，不写入、不修改任何数据。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '自然语言查询语句' },
      collection: { type: 'string', required: true, description: '知识库集合标识，形如 kb_prod_2f8a' },
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
    async execute(args, exec): Promise<ToolOutput> {
      const query = args.query
      const collection = args.collection
      const topk = Math.min(Math.max(args.topk ?? DEFAULT_TOPK, 1), MAX_TOPK)

      /** Build a failure value with a usable message. */
      const fail = (
        reason: ToolOutput['reason'],
        summary: string,
      ): ToolOutput => ({
        ok: false,
        ...(reason === undefined ? {} : { reason }),
        summary,
        collection,
        query,
        mode: 'dense',
        hits: [],
        below_floor: 0,
      })

      if (query.trim() === '') {
        return fail('invalid_argument', 'query 不能为空，请给出要检索的自然语言问题。')
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
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS)
      const onAbort = (): void => timeout.abort()
      exec.signal.addEventListener('abort', onAbort, { once: true })

      /** Reject as soon as the budget expires or the caller aborts. */
      const budget = new Promise<never>((_resolve, reject) => {
        timeout.signal.addEventListener('abort', () => {
          reject(new Error('__kb_search_timeout__'))
        }, { once: true })
      })
      /** Race one step against the budget. */
      const within = <T>(work: Promise<T>): Promise<T> => Promise.race([work, budget])

      try {
        const vector = await within(operations.embedQuery(query))
        const result = await within(operations.search(collection, query, vector, topk, minScore))
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
        }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        // The budget's own sentinel, distinguished from a store error so the two
        // do not both read as "检索失败".
        if (message === '__kb_search_timeout__') {
          return fail('timeout', `检索超时（超过 ${SEARCH_TIMEOUT_MS / 1000} 秒）。可缩小 topk 或稍后重试。`)
        }
        // A missing collection is the one failure worth naming precisely: it is
        // the difference between "you typed the id wrong" and "something broke".
        if (/不存在|does not exist|not exist/i.test(message)) {
          return fail('collection_not_found', `知识库 ${collection} 不存在。请用正确的集合标识，或先在知识库页面创建它。`)
        }
        return fail('internal_error', `检索失败：${message}`)
      } finally {
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}
