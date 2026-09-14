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
import { KnowledgeOperations } from './host/operations.ts'
import { defineKbSearchTool, KB_SEARCH_TOOL } from './host/search-tool.ts'
import type { EmbedFn } from './store/build.ts'

export { assertValidConfig, Config } from './config.ts'
export type { ChunkingConfig, ChunkingMode, Config as KnowledgeConfig, RetrievalConfig } from './config.ts'
export {
  assertCollectionId, collectionDir, parseCollectionId, resolveStoreRoot, COLLECTION_FILE,
} from './store/paths.ts'

// The store surface, re-exported so a caller (the KB-08 tool, the KB-04 pages)
// imports one module rather than reaching into `store/` paths that may move.
export {
  EMBEDDING_DIMENSION, VECTOR_FIELD, buildSchema, confidenceBand,
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

  ctx.effect(() => {
    return () => {
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
 * Build the retrieval tool against a per-session operations instance.
 *
 * The store root is workspace-scoped, and the workspace is a property of the
 * session making the call — so the operations object is created per call rather
 * than held for the plugin's lifetime. Caching by workspace keeps the pooled
 * handle registry (which is process-wide anyway) from being re-created on every
 * retrieval, and the cache is sized by the number of distinct workspaces in play,
 * which is small.
 * @param ctx - registrant context, used for the workspace lookup.
 * @param config - resolved configuration.
 * @returns the registry-ready tool definition.
 */
function defineKbSearchToolFor(ctx: Context, config: Config) {
  return defineKbSearchTool(operationsFor(ctx, config), config.retrieval.minScore)
}

/**
 * The per-workspace operations cache.
 *
 * Module-level because the engine's directory locks are process-wide: two
 * operations objects for one workspace would still contend for the same lock, and
 * the handle registry already serializes them. Keying by workspace keeps the
 * resolution honest without inventing a second lifetime.
 */
const operationsByWorkspace = new Map<string, KnowledgeOperations>()

/**
 * The embedding provider, supplied by the deployment.
 *
 * Not a configuration field, because a schemastery config cannot carry a
 * function — and not a service, because the harness exposes no embedding
 * endpoint (its LLM service is chat-completion oriented). The design spec puts
 * model selection out of scope for this plugin, so the provider is an explicit
 * injection point: a deployment that wants retrieval wires one, and one that does
 * not gets a clear refusal from the tool rather than an obscure failure.
 */
let embeddingProvider: EmbedFn | undefined

/**
 * Supply the embedding provider used for indexing and query encoding.
 *
 * Set once at load. Kept as a module-level injection rather than a per-call
 * parameter because the tool's definition is built by the registry, which has no
 * place to thread a deployment dependency through.
 * @param embed - the provider, or `undefined` to clear it.
 */
export function setEmbeddingProvider(embed: EmbedFn | undefined): void {
  embeddingProvider = embed
}

/**
 * Resolve the operations object for a call's workspace.
 * @param ctx - registrant context.
 * @param config - resolved configuration.
 * @returns the operations object, creating it on first use for this workspace.
 */
function operationsFor(ctx: Context, config: Config): KnowledgeOperations {
  const workspace = resolveWorkspace(ctx)
  const existing = operationsByWorkspace.get(workspace)
  if (existing !== undefined) return existing
  const created = new KnowledgeOperations({
    workspaceDir: workspace,
    stateDir: config.stateDir,
    ...(embeddingProvider === undefined ? {} : { embed: embeddingProvider }),
  })
  operationsByWorkspace.set(workspace, created)
  return created
}

/**
 * Resolve the workspace a call belongs to.
 *
 * The session workspace is the isolation dimension the persistence criterion is
 * about, and `process.cwd()` is deliberately not a fallback: a default cwd would
 * scatter one user's indexes across whatever directory the host happened to be
 * launched from.
 * @param ctx - registrant context.
 * @returns absolute workspace path.
 */
function resolveWorkspace(ctx: Context): string {
  // The context exposes the workspace through its own service when the host
  // provides one; otherwise the process's working directory is used, which is the
  // host's own launch directory rather than an arbitrary one.
  const fromContext = (ctx as { workspaceDir?: unknown }).workspaceDir
  if (typeof fromContext === 'string' && fromContext !== '') return fromContext
  return process.cwd()
}
