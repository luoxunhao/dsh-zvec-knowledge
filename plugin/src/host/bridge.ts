/**
 * The host's HTTP bridge to the browser half.
 *
 * The panel, the documents page and the build configurator all need host data —
 * collections, documents, chunk previews, a running build. The host owns that data
 * (filesystem plus the zvec binding); the browser owns rendering. This module is
 * the seam between them, and it was **missing entirely** until now: the client
 * passed no `port`, so every action in the UI failed with 宿主数据通道未接通 while
 * the acceptance suite stayed green, because those tests assert the port's *call
 * sites* rather than the presence of a runtime bridge.
 *
 * **Why HTTP.** A plugin cannot extend the harness's generated `/remote`
 * artifacts — those belong to the application assembly and are emitted during the
 * harness's own build (`dsh-api-remotes` owns the selection and states that it
 * "owns no physical transport"). `ctx.webServer.register()` is the documented
 * public seam a third-party plugin *can* use, it returns a disposer (so the route
 * belongs to this fiber), and the profile already loads the web server.
 *
 * **Shape.** One exact POST route with a method discriminator. The browser half
 * gets a single fetch call site and the host a single dispatch table, so adding an
 * operation cannot introduce a second path with its own auth or caching behaviour.
 *
 * **Failure is a value.** A rejected operation returns `{ ok: false, error }` with
 * HTTP 200, because the interface must render §8.1's error state with a real
 * reason — a 500 carrying a framework error page would leave it nothing to show.
 * Only transport faults (route missing, host gone) surface as rejected fetches.
 *
 * **Authorization.** The route is reachable by any process that can reach the
 * loopback port, exactly like every other route on this server; see
 * {@link KB_API_PATH} and the security note in the README. It is deliberately not
 * a second authentication system — inventing one that the rest of the harness does
 * not use would create a false sense of a boundary while the neighbouring routes
 * remain open.
 *
 * @module dsh-zvec-knowledge/host/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
// The declaration shim must be loaded for its `declare module` side effect before
// `ctx.on('webserver/index-inject', ...)` is type-checked.
import './services.ts'
import {
  KB_API_PATH, KB_TOKEN_GLOBAL, KB_TOKEN_HEADER, type KbApiResponse,
} from '../shared/contract.ts'
import type { KnowledgeOperations, CollectionView } from './operations.ts'
import type { BuildLogLine, BuildProgress } from '../store/build.ts'

/** The subset of the harness web server this plugin uses. */
export interface WebServerLike {
  /** Register an exact route; returns the disposer that removes it. */
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** One row of the web server's index-injection table. */
export interface IndexInjectionRow {
  /** Row kind; only `global` is used here. */
  kind: string
  /** Global property name, when `kind` is `global`. */
  name?: string
  /** Value assigned to that global, when `kind` is `global`. */
  value?: unknown
}

/** One collection as the wire carries it. Mirrors `HostCollection` on the client. */
export interface WireCollection {
  /** Collection identifier. */
  id: string
  /** Display name. */
  name: string
  /** Description. */
  description: string
  /** Index family. */
  indexKind: string
  /** Lifecycle state. */
  status: CollectionView['status']
  /** Documents stored. */
  documents: number
  /** Chunks in the active snapshot. */
  chunks: number
  /** Seven-day retrieval hits. */
  hits7d: number
  /** Last build time, ISO-8601, or `null`. */
  builtAt: string | null
  /** Creation time, ISO-8601. */
  createdAt: string
}

/** One build-record row as the wire carries it. */
export interface WireBuild {
  /** ISO-8601 timestamp. */
  at: string
  /** Collection the build belongs to. */
  collectionId: string
  /** Chunks produced. */
  chunks: number
  /** Outcome state. */
  status: 'ready' | 'building' | 'failed' | 'pending'
  /** Visible wording for the outcome. */
  statusLabel: string
}

/** Request body of one bridge call. */
interface BridgeRequest {
  /** Which operation to run. */
  method?: unknown
  /** Operation arguments, interpreted per method. */
  args?: unknown
}

/**
 * Largest request body accepted, in bytes.
 *
 * A build's arguments are a few hundred bytes and a document's text arrives through
 * a separate path, so this only has to be comfortably above a legitimate request
 * while bounding what one caller can make the host buffer.
 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Read and parse a JSON request body.
 *
 * The limit is enforced while reading rather than after, so an oversized request is
 * abandoned instead of buffered in full first.
 * @param req - the incoming request.
 * @returns the parsed body.
 * @throws {Error} when the body is oversized or not valid JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<BridgeRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text) as BridgeRequest
}

/**
 * Write one bridge response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param payload - the envelope.
 */
function send(res: ServerResponse, status: number, payload: KbApiResponse): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Never cached: every one of these answers is live store state, and a cached
    // collection list would show a deleted collection back to the user.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Narrow an unknown value to a non-empty string. */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${name} 必须是非空字符串`)
  }
  return value
}

/**
 * Mint this process's bridge token.
 *
 * Per boot rather than stored: the token only has to outlive the process, and a
 * persisted one would be a secret at rest that a file read could lift. 32 bytes of
 * CSPRNG output because this is the only thing standing between a local process and
 * the user's documents.
 * @returns the token.
 */
export function mintBridgeToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Whether a request carries the expected token.
 *
 * Compared in constant time. A byte-by-byte `===` on a secret leaks its prefix
 * length through timing, which is the classic way a token like this is recovered;
 * `timingSafeEqual` requires equal lengths, so a length mismatch is rejected first
 * and that mismatch itself carries no information about the secret's content.
 * @param provided - the header value, when present.
 * @param expected - this process's token.
 * @returns whether the request is authorized.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false
  const left = Buffer.from(provided, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Narrow an unknown value to a positive integer. */
function requireTopk(value: unknown): number {
  if (value === undefined) return 8
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('参数 topk 必须是正整数')
  }
  return Math.min(value, 50)
}

/**
 * Build the five-table build-record list from the collections' own metadata.
 *
 * There is no separate build log on disk: `meta.json` carries the last build time,
 * chunk count and active slot, which is exactly the four columns §5.1 asks for. A
 * collection that has never been built contributes no row rather than a row of
 * zeroes, because "never built" and "built, producing nothing" are different
 * statements.
 * @param collections - the collections as the host reports them.
 * @returns build records, newest first.
 */
function toBuildRecords(collections: CollectionView[]): WireBuild[] {
  return collections
    .filter(item => item.builtAt !== null)
    .map(item => ({
      at: item.builtAt as string,
      collectionId: item.id,
      chunks: item.chunks,
      status: item.status,
      statusLabel: item.status === 'failed' ? '失败' : item.status === 'building' ? '构建中' : '就绪',
    }))
    .sort((left, right) => (right.at > left.at ? 1 : -1))
}

/**
 * Project the host's collection view onto the wire shape.
 *
 * An explicit projection rather than a pass-through: the host view is free to grow
 * fields the interface does not consume, and a spread would silently widen the
 * browser's contract with each such change.
 * @param view - the host collection view.
 * @returns the wire collection.
 */
function toWireCollection(view: CollectionView): WireCollection {
  return {
    id: view.id,
    name: view.name,
    description: view.description,
    indexKind: view.indexKind,
    status: view.status,
    documents: view.documents,
    chunks: view.chunks,
    hits7d: view.hits7d,
    builtAt: view.builtAt,
    createdAt: view.createdAt,
  }
}

/**
 * Run one bridge method against the store.
 *
 * Exported so the descriptor can be exercised without an HTTP server, which is how
 * the acceptance gate covers the dispatch table itself.
 * @param operations - the store operations for the calling workspace.
 * @param method - the operation name.
 * @param args - the operation arguments.
 * @param handlers - build progress and log sinks, when the caller wants them.
 * @returns the wire result.
 * @throws {Error} when the method is unknown or its arguments are invalid.
 */
export async function dispatch(
  operations: KnowledgeOperations,
  method: string,
  args: Record<string, unknown>,
  handlers: {
    onProgress?: (progress: BuildProgress) => void
    onLog?: (line: BuildLogLine) => void
    signal?: AbortSignal
  } = {},
): Promise<unknown> {
  switch (method) {
    case 'listCollections': {
      const views = await operations.listCollections()
      return views.map(toWireCollection)
    }
    case 'listBuilds':
      return toBuildRecords(await operations.listCollections())

    case 'getUsage':
      return operations.storageUsage()

    case 'getQuota':
      return operations.usage()

    case 'createCollection':
      return toWireCollection(await operations.createCollection({
        name: requireString(args.name, 'name'),
        collectionId: requireString(args.collectionId, 'collectionId'),
        description: typeof args.description === 'string' ? args.description : '',
      }))

    case 'deleteCollection':
      await operations.deleteCollection(requireString(args.id, 'id'))
      return null

    case 'listDocuments':
      return operations.listDocuments(requireString(args.collectionId, 'collectionId'))

    case 'removeDocument':
      await operations.removeDocument(
        requireString(args.collectionId, 'collectionId'),
        requireString(args.id, 'id'),
      )
      return null

    case 'previewChunks':
      return operations.previewChunks(
        requireString(args.collectionId, 'collectionId'),
        args.chunking as never,
      )

    case 'estimateCost':
      return operations.estimateCost(
        requireString(args.collectionId, 'collectionId'),
        args.chunking as never,
        args.index as never,
      )

    case 'storedStrategy': {
      const index = await operations.storedStrategy(requireString(args.collectionId, 'collectionId'))
      // The client's configurator holds a chunking draft and an index draft
      // together. Only the index half is stored, so the chunking half comes from
      // the plugin config's defaults rather than being invented here.
      return { index, chunking: null }
    }

    case 'buildIndex': {
      const controller = new AbortController()
      // The build is long-running: the request that starts it returns only when the
      // build settles. A client that navigates away aborts the fetch, and the route
      // handler's `req.on('close')` forwards that into this signal, so the host does
      // not keep embedding vectors for a page nobody is watching.
      const onAbort = (): void => controller.abort()
      handlers.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await operations.buildIndex(
          requireString(args.collectionId, 'collectionId'),
          args.strategy as never,
          {
            onProgress: handlers.onProgress ?? (() => {}),
            onLog: handlers.onLog ?? (() => {}),
          },
          controller.signal,
        )
      } finally {
        handlers.signal?.removeEventListener('abort', onAbort)
      }
    }

    case 'embedQuery': {
      const vector = await operations.embedQuery(requireString(args.text, 'text'))
      return Array.from(vector)
    }

    default:
      throw new Error(`未知的桥接方法：${method}`)
  }
}

/**
 * Register the bridge route on the host web server.
 *
 * The route is owned by the caller's fiber: the returned disposer is the web
 * server's own, so unloading the plugin withdraws the endpoint rather than leaving
 * a handler holding a store that is closing.
 *
 * **Authorization is not optional here.** A route registered this way does *not*
 * inherit the GUI's `?token=` gate — measured, not assumed: with the page returning
 * 401 to an unauthenticated request, this route answered 200, and an unauthenticated
 * `createCollection` wrote to disk. So the handler checks a per-boot token before it
 * does anything else, and the token reaches the legitimate page through the same
 * HTML injection the web server renders.
 * @param ctx - registrant context; used for logging and the inject waterfall.
 * @param webServer - the host web server service.
 * @param resolveOperations - resolves the operations for the calling workspace.
 * @param token - this process's bridge token.
 * @returns the disposer removing both the route and the injection.
 */
export function registerKbBridge(
  ctx: Context,
  webServer: WebServerLike,
  resolveOperations: () => KnowledgeOperations,
  token: string,
): () => void {
  const disposeInject = ctx.on('webserver/index-inject', (table: IndexInjectionRow[]) => {
    // `collectIndexInjections` emits a fresh table per render and every subscriber
    // pushes its current rows, so the token is read live at emit time and an
    // unloaded plugin contributes nothing.
    table.push({ kind: 'global', name: KB_TOKEN_GLOBAL, value: token })
  })

  const disposeRoute = webServer.register({
    kind: 'exact',
    path: KB_API_PATH,
    async handler(req, res): Promise<void> {
      const provided = req.headers[KB_TOKEN_HEADER]
      if (!tokenMatches(Array.isArray(provided) ? provided[0] : provided, token)) {
        // 403 rather than 404: the route is not a secret, and a deployment
        // debugging a missing token is better served by "you are not authorized"
        // than by "this does not exist".
        send(res, 403, {
          ok: false,
          reason: 'unauthorized',
          error: '宿主数据通道未授权：请求缺少或携带了错误的令牌。请刷新页面后重试。',
        })
        return
      }

      if (req.method !== 'POST') {
        // The route is a single POST endpoint by design; an accidental GET from a
        // browser address bar should say so rather than 404 and look unmounted.
        send(res, 405, { ok: false, error: '该接口只接受 POST', reason: 'invalid_argument' })
        return
      }

      let body: BridgeRequest
      try {
        body = await readJsonBody(req)
      } catch (error) {
        send(res, 200, {
          ok: false,
          reason: 'invalid_argument',
          error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }

      const method = typeof body.method === 'string' ? body.method : ''
      if (method === '') {
        send(res, 200, { ok: false, reason: 'invalid_argument', error: '缺少 method 字段' })
        return
      }
      const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as Record<string, unknown>

      // A client that navigates away mid-build aborts the fetch; cancelling the
      // host-side work with it is the whole reason the build takes a signal.
      const abort = new AbortController()
      const onClose = (): void => abort.abort()
      req.on('close', onClose)

      try {
        const operations = resolveOperations()
        const result = await dispatch(operations, method, args, { signal: abort.signal })
        send(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`zvec-knowledge: 桥接方法 ${method} 失败：${message}`)
        // A missing collection is the one failure worth naming precisely: it is the
        // difference between "you picked a deleted collection" and "something broke".
        const missing = /不存在|does not exist|not exist/i.test(message)
        send(res, 200, {
          ok: false,
          ...(missing ? { reason: 'not_found' as const } : {}),
          error: message,
        })
      } finally {
        req.off('close', onClose)
      }
    },
  })

  ctx.logger?.debug?.(`zvec-knowledge: 已注册宿主数据通道 ${KB_API_PATH}`)
  return () => {
    // Route first, then injection: with the endpoint gone, a page that still
    // carried the token could only 404, whereas removing the injection first would
    // leave a live route and a page that cannot reach it.
    disposeRoute()
    disposeInject()
  }
}
