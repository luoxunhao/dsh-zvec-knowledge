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
 * Empty on purpose: this half owns storage and resolves a workspace per call, so
 * it consumes no service that must exist before it can activate. The retrieval
 * tool's registration (KB-08) adds `'tools'` here, because a tool registration
 * really does require that registry to be present.
 */
export const inject: string[] = []

/**
 * Mount the knowledge-base plugin.
 *
 * A configuration that cannot produce a usable index is rejected here rather
 * than at the first search: the harness rule is that misconfiguration fails loud
 * at load when it is self-contained, and every check in {@link assertValidConfig}
 * is decidable from the configuration alone.
 *
 * The disposed effect is what makes unloading clean. It runs in the documented
 * order — nothing new is admitted once the fiber is disposing, and the store's
 * handles are then closed — because the engine's directory locks outlive the
 * plugin otherwise, and the next load would fail on a lock it cannot see the
 * owner of.
 * @param ctx - registrant context; the store's handles are disposed with it.
 * @param config - resolved deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertValidConfig(config)
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
