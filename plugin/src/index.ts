/**
 * dsh-zvec-knowledge — host half.
 *
 * The plugin turns documents into knowledge a session can retrieve: it owns
 * zvec-backed collections under a workspace-isolated root and (from KB-08)
 * registers the `dsh_kb_search` retrieval tool. This module is the plugin
 * entry: it declares identity, configuration, and the services it needs, and
 * refuses a configuration that could not produce a usable index.
 *
 * Behaviour is deliberately thin here. What lands first is the contract — the
 * package layout, the build faces, the configuration surface and the store
 * layout rules — because those are the parts that are expensive to move once
 * a profile a user has installed depends on them. Collection lifecycle and
 * retrieval arrive on top of the modules this re-exports.
 *
 * @module dsh-zvec-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertValidConfig } from './config.ts'
import type { Config } from './config.ts'

export { assertValidConfig, Config } from './config.ts'
export type { ChunkingConfig, ChunkingMode, Config as KnowledgeConfig, RetrievalConfig } from './config.ts'
export {
  assertCollectionId, collectionDir, parseCollectionId, resolveStoreRoot,
  CHUNKS_FILE, COLLECTION_FILE,
} from './store/paths.ts'

/** Plugin name, as the loader reports it and the patch layer mounts it. */
export const name = 'zvec-knowledge'

/**
 * Required services.
 *
 * Empty on purpose: this half owns storage and resolves a workspace per call,
 * so it consumes no service that must exist before it can activate. The
 * retrieval tool's registration (KB-08) adds `'tools'` here, because a tool
 * registration really does require that registry to be present.
 */
export const inject: string[] = []

/**
 * Mount the knowledge-base plugin.
 *
 * A configuration that cannot produce a usable index is rejected here rather
 * than at the first search: the harness rule is that misconfiguration fails
 * loud at load when it is self-contained, and every check in
 * {@link assertValidConfig} is decidable from the configuration alone.
 * @param _ctx - registrant context; unused until the retrieval tool lands.
 * @param config - resolved deployment configuration.
 */
export function apply(_ctx: Context, config: Config): void {
  assertValidConfig(config)
}
