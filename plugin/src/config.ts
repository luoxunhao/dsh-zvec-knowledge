/**
 * Deployment configuration for the knowledge-base plugin.
 *
 * Every value here is a deployment choice and lives in `cordis.patch.yml`
 * rather than in plugin source, because the harness treats a `DEFAULT_*`
 * constant as a missing configuration field. The schema carries the defaults,
 * so the patch layer only has to state what it changes.
 *
 * @module dsh-zvec-knowledge/config
 */

import z from '@deepseek-ai/schemastery'

/** Chunking strategy identifier, mirroring the design spec's three-way selector. */
export type ChunkingMode = 'heading' | 'paragraph' | 'fixed'

/** Chunking strategy (design spec §5.5, §10.1). */
export interface ChunkingConfig {
  /** How a document is split. `heading` follows the source's heading hierarchy. */
  mode: ChunkingMode
  /** Target chunk size in tokens. */
  chunkTokens: number
  /** Overlap between adjacent chunks in tokens; must stay below `chunkTokens`. */
  overlapTokens: number
  /** Chunks below this size are dropped rather than indexed. */
  minChunkTokens: number
}

/** Retrieval knobs (design spec §5.6, §9.2, §10.1). */
export interface RetrievalConfig {
  /** Default number of hits returned when a caller does not pass `topk`. */
  topk: number
  /** Normalized-score floor; below it a hit never reaches RAG generation. */
  minScore: number
}

/**
 * Storage quota.
 *
 * The design spec calls for a restricted state (§8.2) that explains "限制来源与解除
 * 路径" when storage runs out, and the issue list leaves the quota figure to the
 * business side. Making it **configurable rather than invented** is what keeps
 * that state honest: a deployment that has a quota states it, and the interface
 * can then name the real limit instead of showing a plausible-looking constant.
 *
 * `bytes: null` means no quota is configured — a different statement from a quota
 * of zero, and the interface distinguishes them.
 */
export interface QuotaConfig {
  /**
   * Maximum bytes a workspace's store may occupy, or `null` for unlimited.
   *
   * Enforced at both points that grow the store — accepting an upload and running
   * a build — because a quota checked only on upload would let a rebuild double
   * the footprint that an upload was refused for.
   */
  bytes: number | null
  /**
   * Fraction at which the interface reports the store as near its limit.
   *
   * A warning threshold is separate from the limit because a user refused at 100%
   * has no chance to act; one warned at 90% does.
   */
  warnAt: number
}

/** Knowledge-base plugin configuration. */
export interface Config {
  /**
   * Storage root. A relative path is resolved against the session workspace,
   * which is what keeps two workspaces from sharing one index; an absolute
   * path opts out of that isolation deliberately.
   */
  stateDir: string
  /** Default chunking strategy applied to newly created collections. */
  chunking: ChunkingConfig
  /** Default retrieval knobs. */
  retrieval: RetrievalConfig
  /** Storage quota; unlimited unless a deployment states one. */
  quota: QuotaConfig
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().default('.dsh-kb-zvec'),
  chunking: z.object({
    mode: z.union([z.const('heading'), z.const('paragraph'), z.const('fixed')]).default('heading'),
    chunkTokens: z.number().default(1024),
    overlapTokens: z.number().default(128),
    minChunkTokens: z.number().default(64),
  }),
  retrieval: z.object({
    topk: z.number().default(8),
    minScore: z.number().default(0.55),
  }),
  quota: z.object({
    // `null` is a deliberate "no quota", so the schema accepts it explicitly
    // rather than relying on the field being absent.
    bytes: z.union([z.number(), z.const(null)]).default(null),
    warnAt: z.number().default(0.9),
  }),
})

/**
 * Reject configurations the schema cannot express.
 *
 * The overlap rule is relational (overlap < chunk) and the score floor is
 * bounded, so neither is a per-field constraint. Both describe a plugin that
 * cannot work, so they fail at load rather than producing a silently degraded
 * index that only shows up as bad retrieval quality later.
 * @param config - the resolved configuration.
 * @throws {Error} when the configuration cannot produce a usable index.
 */
export function assertValidConfig(config: Config): void {
  const { chunkTokens, overlapTokens, minChunkTokens } = config.chunking
  if (!Number.isInteger(chunkTokens) || chunkTokens <= 0) {
    throw new Error(`chunking.chunkTokens must be a positive integer, received ${String(chunkTokens)}`)
  }
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0) {
    throw new Error(`chunking.overlapTokens must be a non-negative integer, received ${String(overlapTokens)}`)
  }
  if (overlapTokens >= chunkTokens) {
    throw new Error(
      `chunking.overlapTokens (${overlapTokens}) must be smaller than chunking.chunkTokens (${chunkTokens}); `
      + 'an overlap at or above the chunk size makes splitting non-terminating',
    )
  }
  if (!Number.isInteger(minChunkTokens) || minChunkTokens < 0) {
    throw new Error(`chunking.minChunkTokens must be a non-negative integer, received ${String(minChunkTokens)}`)
  }
  if (minChunkTokens > chunkTokens) {
    throw new Error(
      `chunking.minChunkTokens (${minChunkTokens}) must not exceed chunking.chunkTokens (${chunkTokens}); `
      + 'every chunk would be discarded',
    )
  }
  const { topk, minScore } = config.retrieval
  if (!Number.isInteger(topk) || topk <= 0) {
    throw new Error(`retrieval.topk must be a positive integer, received ${String(topk)}`)
  }
  if (!(minScore >= 0 && minScore <= 1)) {
    throw new Error(`retrieval.minScore must be within [0, 1], received ${String(minScore)}`)
  }
  if (config.stateDir.trim() === '') {
    throw new Error('stateDir must not be blank')
  }
  const { bytes, warnAt } = config.quota
  if (bytes !== null && (!Number.isInteger(bytes) || bytes <= 0)) {
    throw new Error(`quota.bytes must be a positive integer or null, received ${String(bytes)}`)
  }
  if (!(warnAt > 0 && warnAt <= 1)) {
    // A warnAt above 1 would never fire; at or below 0 it would fire immediately.
    throw new Error(`quota.warnAt must be within (0, 1], received ${String(warnAt)}`)
  }
}
