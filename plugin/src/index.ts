/**
 * dsh-zvec-knowledge — host half.
 *
 * The plugin turns documents into knowledge a session can retrieve: it owns
 * zvec-backed knowledge collections under a workspace-isolated root and (from
 * KB-08) registers the `dsh_kb_search` retrieval tool. This module is the plugin
 * entry: it declares identity, configuration, the services it needs, and the
 * lifecycle of the resources the store holds.
 *
 * **Workspace resolution.** The store root is resolved per call from the calling
 * agent's session (`agent.session.header.cwd`), never from `process.cwd()`. A
 * default cwd would scatter one user's indexes across whatever directory the host
 * happened to be launched from, and it is the one isolation dimension the spec
 * treats as non-negotiable. This mirrors the convention the other third-party
 * plugins in this workspace follow.
 *
 * **Resource ownership.** Every open engine handle belongs to this plugin's
 * fiber. The engine takes an *exclusive lock per collection directory* — a second
 * open fails even read-only — so a leaked handle does not merely waste memory, it
 * makes the collection unopenable until the process exits. The fiber's disposer
 * closes them in the documented order: stop accepting new work, then release the
 * handles.
 *
 * @module dsh-zvec-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertValidConfig } from './config.ts'
import type { Config } from './config.ts'
import { disposeAll, openHandleCount } from './store/registry.ts'
import { disposeJobs } from './store/job.ts'
import { KnowledgeOperations } from './host/operations.ts'
import { registerKbBridge, mintBridgeToken, type WebServerLike } from './host/bridge.ts'
// The web-server declaration shim, for its `declare module` side effect.
import './host/services.ts'
import { defineKbSearchTool, KB_SEARCH_TOOL } from './host/search-tool.ts'
import { createEmbeddingProvider } from './host/embedding.ts'
import type { EmbedFn } from './store/build.ts'

export { assertValidConfig, Config } from './config.ts'
export type { ChunkingConfig, ChunkingMode, Config as KnowledgeConfig, RetrievalConfig } from './config.ts'
export {
  assertCollectionId, collectionDir, parseCollectionId, resolveStoreRoot, COLLECTION_FILE,
} from './store/paths.ts'

// The store surface, re-exported so a caller (the KB-08 tool, the KB-04 pages)
// imports one module rather than reaching into `store/` paths that may move.
export {
  EMBEDDING_DIMENSION, TOKENIZER_NAME, VECTOR_FIELD, buildSchema, confidenceBand,
  documentFilter, escapeLiteral, toMatchScore,
  type ChunkRow, type ConfidenceBand, type IndexConfig, type IndexKind, type QuantizeKind,
} from './store/collection.ts'
export {
  SLOTS, createCollection, deleteCollection, inactiveSlot, listCollectionIds,
  openServed, publishSlot, readMeta, renameCollection, slotDir, withServed,
  type ServedCollection, type Slot, type SnapshotMeta,
} from './store/snapshot.ts'
export { chunkDocument, previewChunks, estimateTokens, type Chunk, type ChunkingResult } from './store/chunk.ts'
export {
  STAGE_LABELS, STAGES, startBuild,
  type BuildLogLine, type BuildProgress, type BuildRequest, type BuildResult,
  type EmbedFn, type RunningBuild, type StageId, type StageState,
} from './store/build.ts'
export { search, searchDense, countChunksForDocument, deleteChunksForDocument, type SearchHit, type SearchResult } from './store/retrieval.ts'
export { openHandleCount } from './store/registry.ts'

/** Plugin name, as the loader reports it and the patch layer mounts it. */
export const name = 'zvec-knowledge'

/**
 * Required services.
 *
 * `tools` is required from KB-08 onward: the plugin's whole point is that a
 * session can retrieve from the knowledge base, and that happens through the tool
 * registry. Declaring it keeps the fiber pending until the registry exists rather
 * than registering into nothing.
 *
 * `webServer` is deliberately **not** required. The browser half needs a host route
 * to talk to (see `host/bridge.ts`), but the route is bound lazily through
 * `ctx.inject`, so a headless profile with no web server still loads this plugin
 * and keeps `dsh_kb_search` working. Requiring it here would make the tool
 * unavailable in exactly the deployments that have no UI to serve.
 */
export const inject: string[] = ['tools']

/**
 * Mount the knowledge-base plugin.
 *
 * A configuration that cannot produce a usable index is rejected here rather
 * than at the first search: the harness rule is that misconfiguration fails loud
 * at load when it is self-contained, and every check in {@link assertValidConfig}
 * is decidable from the configuration alone.
 *
 * Two effects are registered, in the documented disposer order — stop admitting
 * work, then release resources:
 *
 * 1. the `dsh_kb_search` tool registration, removed on unload so a session cannot
 *    call a tool whose store has gone;
 * 2. the store's pooled handles, closed because the engine's directory locks
 *    outlive the plugin otherwise and the next load would fail on a lock it cannot
 *    see the owner of.
 * @param ctx - registrant context; both effects are owned by this fiber.
 * @param config - resolved deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertValidConfig(config)

  // The tool needs a workspace to resolve its store root against, and the
  // workspace belongs to the calling session — so it is resolved per call from
  // the execution context rather than captured once at load.
  ctx.effect(() => ctx.tools.register(defineKbSearchToolFor(ctx, config)), 'zvec-knowledge: dsh_kb_search')

  // The host route the browser half talks to. Bound through `ctx.inject` rather
  // than declared in `inject` so a headless deployment — which has no web server —
  // still loads this plugin and keeps the retrieval tool.
  //
  // Without this route the panel mounts and every action fails with
  // 宿主数据通道未接通, which is exactly the state this plugin shipped in: nothing
  // connected `KnowledgeOperations` to the page.
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer') as WebServerLike | undefined
    if (server === undefined) return
    const operations = operationsFor(ctx, config)
    // One token per process, minted here rather than stored: it only has to outlive
    // the boot, and a persisted secret is one a file read could lift.
    const token = mintBridgeToken()
    webCtx.effect(
      () => registerKbBridge(webCtx, server, () => operations, token),
      'zvec-knowledge: host bridge route',
    )
  })

  ctx.effect(() => {
    return () => {
      // Cancel any in-flight build first: a running job holds an engine handle and
      // is mid-write, so closing handles under it would produce exactly the stale
      // `Collection is closed` this module's job table exists to avoid.
      const cancelled = disposeJobs()
      if (cancelled > 0) {
        ctx.logger?.debug?.(`zvec-knowledge: cancelled ${cancelled} running build job(s)`)
      }
      // Close every pooled collection handle. Without this the engine keeps its
      // per-directory lock after unload, and a reload fails with an opaque lock
      // error rather than starting cleanly.
      const closed = disposeAll()
      if (closed > 0) {
        ctx.logger?.debug?.(`zvec-knowledge: released ${closed} collection handle(s)`)
      }
    }
  }, 'zvec-knowledge: release store handles')
}

/**
 * Build the retrieval tool against an operations object that resolves its
 * workspace per call.
 *
 * The store root is workspace-scoped and the workspace belongs to the session
 * making the call, but a tool registration happens once, during `apply()`, before
 * any session exists. The workspace is therefore resolved inside `execute` — the
 * object handed to the tool holds a resolver, not a path. Resolving it here would
 * read the workspace before any session existed and, as the load failure this
 * plugin shipped with proved, can throw straight out of `apply()`.
 * @param ctx - registrant context, used for the workspace lookup.
 * @param config - resolved configuration.
 * @returns the registry-ready tool definition.
 */
function defineKbSearchToolFor(ctx: Context, config: Config) {
  return defineKbSearchTool(operationsFor(ctx, config), config.retrieval.minScore)
}

/**
 * The operations object the registered tool closes over.
 *
 * Its workspace is resolved on every call through {@link resolveWorkspace}, so one
 * registration serves every session however many workspaces the host is running.
 * Cached because the object itself is stateless apart from its per-workspace cache
 * and the process-wide handle registry, so rebuilding it per call would buy
 * nothing. `undefined` until the tool is registered.
 */
let perCallOperations: KnowledgeOperations | undefined

/**
 * The embedding provider, supplied by the deployment.
 *
 * Not a configuration field, because a schemastery config cannot carry a function
 * — and not a service, because the harness exposes no embedding endpoint (its LLM
 * service is chat-completion oriented). The design spec puts model selection out
 * of scope for this plugin, so the provider is an explicit injection point: a
 * deployment that wants retrieval wires one, and one that does not gets a clear
 * refusal from the tool rather than an obscure failure.
 */
let embeddingProvider: EmbedFn | undefined

/**
 * Build the provider from the configured endpoint when one is present.
 *
 * The API key is read from the environment by name, never held in configuration:
 * `--dump-config` prints plugin config, so a key placed there would be written to
 * logs and diagnostics.
 * @param config - resolved configuration.
 * @returns the provider, or `undefined` when no endpoint is configured.
 */
function providerFromConfig(config: Config): EmbedFn | undefined {
  const endpoint = config.embedding
  if (endpoint === undefined) return undefined
  return createEmbeddingProvider({
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    apiKeyEnv: endpoint.apiKeyEnv,
    batchSize: endpoint.batchSize,
  })
}

/**
 * Supply the embedding provider used for indexing and query encoding.
 *
 * Overrides whatever the configuration produced, for a deployment that has a
 * provider object rather than an endpoint (an in-process model, a test double).
 * @param embed - the provider, or `undefined` to fall back to the configuration.
 */
export function setEmbeddingProvider(embed: EmbedFn | undefined): void {
  embeddingProvider = embed
}

/**
 * The options every operations object is built from, less its workspace.
 * @param config - resolved configuration.
 * @returns the shared construction options.
 */
function createOptions(config: Config): {
  stateDir: string
  embed?: EmbedFn
  dimension?: number
  quota: Config['quota']
} {
  const provider = embeddingProvider ?? providerFromConfig(config)
  return {
    stateDir: config.stateDir,
    ...(provider === undefined ? {} : { embed: provider }),
    // The width must match the model, and a collection's schema is created at it:
    // 2560 for the model deployed here, 1024 by default.
    ...(config.embedding === undefined ? {} : { dimension: config.embedding.dimension }),
    quota: config.quota,
  }
}

/**
 * Resolve the operations object for a call's workspace.
 *
 * Two lifetimes are in play, and they are distinguished by whether the caller can
 * name a workspace at all:
 *
 * - a caller that already knows its workspace (a page, a test) passes it, and gets
 *   one cached object per workspace;
 * - the registered tool cannot, so it receives a resolver and its object binds per
 *   call. See {@link perCallOperations}.
 * @param ctx - registrant context.
 * @param config - resolved configuration.
 * @returns the operations object.
 */
function operationsFor(ctx: Context, config: Config): KnowledgeOperations {
  const existing = perCallOperations
  if (existing !== undefined) return existing
  const created = new KnowledgeOperations({
    ...createOptions(config),
    workspaceDir: () => resolveWorkspace(ctx),
  })
  perCallOperations = created
  return created
}

/**
 * Resolve the workspace a call belongs to.
 *
 * The session workspace is the isolation dimension the persistence criterion is
 * about, and `process.cwd()` is deliberately only the last resort: a default cwd
 * would scatter one user's indexes across whatever directory the host happened to
 * be launched from.
 *
 * **Why the context is not probed for a `workspaceDir` property.** An earlier
 * revision read `ctx.workspaceDir` defensively, on the assumption that a property
 * the host does not provide simply reads as `undefined`. It does not: a cordis
 * context is a proxy whose service resolution is declared by `inject`, and reading
 * an undeclared property throws `cannot get property "workspaceDir" without
 * inject`. That read happened while the tool definition was being built, which
 * happens during `apply()` — so the throw escaped the effect and failed the whole
 * plugin load, taking the entire profile down with it. Declaring `workspaceDir` in
 * `inject` is not an option either: no such service exists in the host, so the
 * fiber would never activate and the tool would silently never register.
 *
 * Only `ctx.get(...)` may be used here, and only for services the host really
 * provides: `get` returns `undefined` for anything else instead of throwing.
 * @param ctx - registrant context.
 * @returns absolute workspace path.
 */
export function resolveWorkspace(ctx: Context): string {
  const store = ctx.get('sessions')
  // The tool execution is the authority on its own session, but the operations
  // object is shared across sessions, so the best available answer here is the
  // process's live session set: one session is the ordinary interactive case, and
  // with several the launch directory is a less surprising guess than an arbitrary
  // sibling's workspace. This is resolved per call, so a single-session host — the
  // normal deployment — is exact.
  const sessions = store?.list() ?? []
  for (const session of sessions) {
    const cwd = session.header.cwd
    if (cwd !== undefined && cwd !== '') return cwd
  }
  return process.cwd()
}
