/**
 * OpenAI-compatible embedding provider.
 *
 * The deployment's embedding model is an HTTP service speaking the OpenAI
 * `/v1/embeddings` shape, so this module is the adapter between that protocol and
 * the plugin's {@link EmbedFn} contract. It is the only place that knows the wire
 * format.
 *
 * Three protocol realities shape it, and each is a silent failure if ignored:
 *
 * 1. **The response array is not ordered by contract.** Each entry carries an
 *    `index` identifying which input it belongs to, and a provider that omits or
 *    duplicates `index` is common. Taking the array positionally against a
 *    provider that reorders would pair vectors with the wrong text: retrieval
 *    would not error, scores would look plausible, and every result would be
 *    wrong. So results are seated by `index` when it is usable, and the fallback
 *    to positional order is logged rather than assumed.
 * 2. **Batch limits vary.** The official endpoint accepts large batches; mirrors
 *    commonly cap much lower, and the rejection is a terse 400. The batch size is
 *    therefore configurable and defaults conservatively, and a 400 is annotated
 *    with that possibility instead of surfacing the raw body.
 * 3. **Rate limits and transient failures are normal.** A 429 or 5xx is retried
 *    with exponential backoff and jitter, because a build that dies on the first
 *    throttle is a build users cannot run.
 *
 * The API key is read from the environment and never from configuration: the
 * harness's `--dump-config` prints plugin config, so a key placed there would be
 * written to logs and diagnostics.
 *
 * @module dsh-zvec-knowledge/host/embedding
 */

import type { EmbedFn } from '../store/build.ts'

/** Configuration for the embedding endpoint. */
export interface EmbeddingConfig {
  /** Base URL, e.g. `https://api.example.com/v1` or `.../v1/embeddings`. */
  baseUrl: string
  /** Model identifier sent in the request. */
  model: string
  /**
   * Name of the environment variable holding the API key.
   *
   * A name rather than the key itself, so the secret never enters configuration
   * or a log line.
   */
  apiKeyEnv: string
  /** Inputs per request. Defaults conservatively because mirror limits vary. */
  batchSize?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Retry attempts for retryable failures. */
  maxRetries?: number
}

/** Default batch size: conservative, because compatible endpoints commonly cap low. */
export const DEFAULT_BATCH_SIZE = 64

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default retry attempts. */
export const DEFAULT_MAX_RETRIES = 3

/** Raised when the endpoint is misconfigured or unreachable in a way retrying cannot fix. */
export class EmbeddingError extends Error {
  /** What went wrong, in a form a caller can branch on. */
  readonly kind: 'auth' | 'bad_request' | 'rate_limited' | 'server' | 'network' | 'malformed'

  /**
   * @param kind - failure category.
   * @param message - human-readable reason, safe to show (no key material).
   */
  constructor(kind: EmbeddingError['kind'], message: string) {
    super(message)
    this.name = 'EmbeddingError'
    this.kind = kind
  }
}

/**
 * Normalize a base URL to the embeddings endpoint.
 *
 * Accepts either a base (`.../v1`) or the full endpoint, because deployments
 * document both and guessing wrong produces a 404 that reads like an outage.
 * @param baseUrl - configured URL.
 * @returns the absolute embeddings endpoint.
 */
export function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/embeddings$/.test(trimmed)) return trimmed
  return `${trimmed}/embeddings`
}

/**
 * Seat response vectors against their inputs.
 *
 * Exported because it is the piece that fails silently: a caller that seats
 * positionally against an unordered response gets plausible-looking garbage.
 * @param data - the response's `data` array.
 * @param count - number of inputs sent.
 * @returns vectors in input order.
 * @throws {EmbeddingError} when the response cannot be seated at all.
 */
export function seatVectors(
  data: { index?: unknown, embedding?: unknown }[],
  count: number,
): { vectors: (number[] | Float32Array)[], byIndex: boolean } {
  if (data.length !== count) {
    throw new EmbeddingError(
      'malformed',
      `嵌入服务返回 ${data.length} 条结果，但请求了 ${count} 条文本`,
    )
  }

  // `index` is usable only when every entry carries a distinct integer in range.
  // A partly-filled or duplicated index is worse than none, because seating by it
  // would drop some inputs and double-assign others.
  const indexed = data.every(entry => Number.isInteger(entry.index))
  const indices = indexed ? data.map(entry => entry.index as number) : []
  const usable = indexed && new Set(indices).size === count && indices.every(value => value >= 0 && value < count)

  if (usable) {
    const seated: (number[] | Float32Array)[] = new Array(count)
    for (const [position, entry] of data.entries()) {
      seated[indices[position] as number] = entry.embedding as number[] | Float32Array
    }
    return { vectors: seated, byIndex: true }
  }

  // Positional fallback: correct for the providers that do return input order,
  // and the caller logs that the guarantee was absent.
  return { vectors: data.map(entry => entry.embedding as number[] | Float32Array), byIndex: false }
}

/**
 * Build an {@link EmbedFn} backed by an OpenAI-compatible endpoint.
 *
 * @param config - endpoint configuration.
 * @param onWarn - sink for non-fatal protocol notes (a provider without `index`).
 * @returns the embedding provider.
 * @throws {EmbeddingError} when the API key environment variable is unset.
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
  onWarn: (message: string) => void = () => {},
): EmbedFn {
  const endpoint = embeddingsEndpoint(config.baseUrl)
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  return async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    // A blank `apiKeyEnv` means the endpoint needs no authentication — a local
    // server, typically. Treating it as "the variable is missing" would refuse
    // every call to an endpoint that never wanted a key, which is exactly the
    // configuration this project runs.
    const wantsKey = config.apiKeyEnv.trim() !== ''
    // `?? ''` narrows the `string | undefined` that an index read produces; the
    // emptiness is then checked once, below, rather than at every use.
    const apiKey = (wantsKey ? process.env[config.apiKeyEnv] : '') ?? ''
    if (wantsKey && (apiKey === undefined || apiKey === '')) {
      // Named precisely: an unset key is a deployment mistake, not a retrieval
      // failure, and saying which variable is missing is the whole fix.
      throw new EmbeddingError('auth', `环境变量 ${config.apiKeyEnv} 未设置，无法调用嵌入服务`)
    }
    if (texts.length === 0) return []

    const out: Float32Array[] = []
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize)
      out.push(...await embedBatch(batch, { endpoint, model: config.model, apiKey, timeoutMs, maxRetries, signal, onWarn }))
    }
    return out
  }
}

/** One batch's request context. */
interface BatchContext {
  /** Absolute endpoint. */
  endpoint: string
  /** Model identifier. */
  model: string
  /** Bearer token. */
  apiKey: string
  /** Per-request timeout. */
  timeoutMs: number
  /** Retry attempts. */
  maxRetries: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Non-fatal protocol note sink. */
  onWarn: (message: string) => void
}

/**
 * Embed one batch, retrying transient failures.
 * @param batch - input texts.
 * @param context - request context.
 * @returns one vector per input, in input order.
 * @throws {EmbeddingError} on a non-retryable failure or exhausted retries.
 */
async function embedBatch(batch: string[], context: BatchContext): Promise<Float32Array[]> {
  let attempt = 0
  for (;;) {
    try {
      return await embedOnce(batch, context)
    } catch (error) {
      const retryable = error instanceof EmbeddingError
        && (error.kind === 'rate_limited' || error.kind === 'server' || error.kind === 'network')
      // Cancellation is never retried: the caller asked to stop.
      if (!retryable || attempt >= context.maxRetries || context.signal?.aborted === true) throw error
      attempt += 1
      // Exponential backoff with jitter: without jitter, several concurrent
      // batches retry in lockstep and re-trigger the same rate limit.
      const backoff = Math.min(2 ** attempt * 250, 8_000) + Math.random() * 250
      await sleep(backoff, context.signal)
    }
  }
}

/**
 * Perform one request.
 * @param batch - input texts.
 * @param context - request context.
 * @returns the vectors.
 * @throws {EmbeddingError} classified by status.
 */
async function embedOnce(batch: string[], context: BatchContext): Promise<Float32Array[]> {
  // The caller's signal is combined with a per-request timeout so either can end
  // the request; `AbortSignal.any` is not assumed, so the two are wired manually.
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  context.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), context.timeoutMs)

  let response: Response
  try {
    response = await fetch(context.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The header is omitted entirely when there is no key, rather than sent
        // empty: some endpoints reject a malformed `Bearer ` outright, and a
        // needless header is one more thing to explain in a log.
        ...(context.apiKey === '' ? {} : { authorization: `Bearer ${context.apiKey}` }),
      },
      body: JSON.stringify({ model: context.model, input: batch, encoding_format: 'float' }),
      signal: controller.signal,
    })
  } catch (error) {
    // A cancelled request is the caller's decision, not a transport failure.
    if (context.signal?.aborted === true) throw new EmbeddingError('network', '嵌入请求已取消')
    throw new EmbeddingError('network', `无法连接嵌入服务 ${context.endpoint}：${String(error instanceof Error ? error.message : error)}`)
  } finally {
    clearTimeout(timer)
    context.signal?.removeEventListener('abort', onAbort)
  }

  if (!response.ok) {
    // The body is read for the message but never echoed wholesale: a failed
    // request's body can contain request metadata, and the key never appears in it
    // because it is a header, but truncating keeps logs predictable.
    const body = await response.text().catch(() => '')
    const detail = body.slice(0, 300)
    if (response.status === 401 || response.status === 403) {
      throw new EmbeddingError('auth', `嵌入服务拒绝鉴权（HTTP ${response.status}）。请检查 ${'API key'} 是否有效。`)
    }
    if (response.status === 429) {
      throw new EmbeddingError('rate_limited', `嵌入服务限流（HTTP 429）`)
    }
    if (response.status >= 500) {
      throw new EmbeddingError('server', `嵌入服务错误（HTTP ${response.status}）：${detail}`)
    }
    if (response.status === 400) {
      throw new EmbeddingError(
        'bad_request',
        `嵌入服务拒绝请求（HTTP 400）：${detail}。`
        + `若为批量过大，可调小 batchSize（当前 ${batch.length} 条/批）。`,
      )
    }
    throw new EmbeddingError('bad_request', `嵌入服务返回 HTTP ${response.status}：${detail}`)
  }

  const payload = await response.json().catch(() => null) as { data?: { index?: unknown, embedding?: unknown }[] } | null
  if (payload?.data === undefined || !Array.isArray(payload.data)) {
    throw new EmbeddingError('malformed', '嵌入服务响应缺少 data 数组')
  }

  const { vectors, byIndex } = seatVectors(payload.data, batch.length)
  if (!byIndex) {
    // Stated once per batch rather than silently: the plugin cannot verify the
    // provider preserves order, so the operator should know the guarantee is
    // positional rather than indexed.
    context.onWarn('嵌入服务响应未提供可用的 index 字段，已按数组顺序对应输入；若结果异常请检查服务实现的顺序保证')
  }

  return vectors.map(vector => (vector instanceof Float32Array ? vector : Float32Array.from(vector)))
}

/**
 * Sleep, honouring cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - caller cancellation.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new EmbeddingError('network', '嵌入请求已取消'))
    }, { once: true })
  })
}
