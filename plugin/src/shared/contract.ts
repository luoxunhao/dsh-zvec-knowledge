/**
 * Constants both halves must agree on.
 *
 * These live outside `client/` because the host program excludes that directory,
 * and outside the host modules because the client bundle may not import host code
 * (the purity gate allows only the module table's entries, and a host module pulls
 * Node built-ins into the browser bundle).
 *
 * Sharing one declaration is what keeps a name from being written twice and
 * drifting — and here the drift would be silent: the keyed tool-view slot
 * dispatches by wire tool name, so a mismatched string means the view simply never
 * renders, with no error anywhere.
 *
 * @module dsh-zvec-knowledge/shared/contract
 */

/** Wire name of the knowledge-base retrieval tool. */
export const KB_SEARCH_TOOL = 'dsh_kb_search'

/** The three parameter names the tool accepts and the interface displays. */
export const KB_TOOL_PARAMS = ['query', 'collection', 'topk'] as const

/** One parameter name. */
export type KbToolParam = typeof KB_TOOL_PARAMS[number]

/**
 * The host route the browser half talks to.
 *
 * The host owns the store — it has the filesystem and the zvec binding — and the
 * browser owns rendering, so the two meet over HTTP. This path is registered as an
 * *exact* route on the harness web server, which is the only public seam a
 * third-party plugin has for reaching host code from the page: the harness's own
 * generated `/remote` artifacts belong to the application assembly and cannot be
 * extended by a plugin.
 *
 * The `_kb` prefix keeps the path out of the harness's own namespaces. A collision
 * is not a silent bug — `register` throws on a duplicate (kind, path) — but a
 * distinct prefix is what makes the collision impossible to begin with.
 */
export const KB_API_PATH = '/api/_kb_zvec'

/**
 * Method names carried in the request body.
 *
 * A single POST route with a method discriminator rather than one path per
 * operation: the browser half then has exactly one fetch call site, and the host
 * one dispatch table. Adding an operation cannot introduce a second path that some
 * deployment's reverse proxy might treat differently.
 */
export const KB_API_METHODS = [
  'listCollections',
  'listBuilds',
  'getUsage',
  'getQuota',
  'createCollection',
  'deleteCollection',
  'listDocuments',
  'removeDocument',
  'previewChunks',
  'estimateCost',
  'storedStrategy',
  'buildIndex',
  'embedQuery',
] as const

/** One bridge method name. */
export type KbApiMethod = typeof KB_API_METHODS[number]

/**
 * Global the host writes the bridge token into, for this page to read.
 *
 * Delivered through the harness's `webserver/index-inject` waterfall, which renders
 * a `{ kind: 'global' }` row into the served HTML. That is the only channel a
 * plugin has for handing a page a secret: `__DSH_BOOT__` carries the plugin
 * *manifest* (ids, urls, revs) and has no per-plugin data slot, so there is nowhere
 * else to put it.
 *
 * **Why a token is needed at all.** Measured, not assumed: a route registered with
 * `ctx.webServer.register` is **not** covered by the GUI's `?token=` gate. The page
 * itself answers 401 without a token, while a plugin route answered 200 — and a
 * `createCollection` call with no token succeeded and wrote to disk. Any local
 * process could read, write and delete the knowledge base. This token closes that.
 *
 * The name is deliberately unguessable-looking rather than generic, so it cannot
 * collide with a harness global.
 */
export const KB_TOKEN_GLOBAL = '__DSH_KB_BRIDGE_TOKEN__'

/**
 * Header the browser half sends the token in.
 *
 * A header rather than a query parameter or body field: the token then stays out of
 * request bodies (which the host logs on failure) and out of the URL (which lands in
 * history and referrers).
 */
export const KB_TOKEN_HEADER = 'x-kb-bridge-token'

/**
 * The envelope every bridge response uses.
 *
 * A failed call is a *value*, not an HTTP status: the browser half needs the
 * message to render §8.1's error state, and a 500 whose body is a framework error
 * page would give it nothing to show. Transport-level problems (a route that is not
 * mounted, the host going away) still surface as rejected fetches.
 */
export interface KbApiResponse<T = unknown> {
  /** Whether the call itself succeeded. */
  ok: boolean
  /** The result, present when `ok`. */
  result?: T
  /** Human-readable failure reason, present when not `ok`. */
  error?: string
  /** Machine-readable failure kind, for the cases the UI branches on. */
  reason?: 'not_found' | 'invalid_argument' | 'unauthorized' | 'internal_error'
}
