/**
 * Storage quota: measurement and enforcement.
 *
 * The design spec asks for a restricted state that names *why* the user is
 * blocked and *how* to unblock (§8.2), and a quota is the only thing that makes
 * that state reachable. So this module both measures the store and answers the
 * two questions a caller has: "am I near the limit?" and "may I add this?".
 *
 * The measurement walks the directory rather than trusting a counter. A counter
 * maintained by the writer drifts after any external cleanup — a user deleting a
 * directory by hand, a failed build leaving a staging slot — and a quota enforced
 * against a drifted figure is worse than none, because it refuses work that would
 * fit (or permits work that will not).
 *
 * @module dsh-zvec-knowledge/store/quota
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Configured quota, mirroring the plugin config's shape. */
export interface Quota {
  /** Maximum bytes, or `null` for unlimited. */
  bytes: number | null
  /** Fraction at which the store counts as near its limit. */
  warnAt: number
}

/** How full the store is. */
export interface QuotaState {
  /** Bytes currently occupied. */
  used: number
  /** Configured limit, or `null` when unlimited. */
  limit: number | null
  /** Used fraction in [0, 1], or `null` when unlimited. */
  fraction: number | null
  /** Whether the store has crossed the warning threshold. */
  nearLimit: boolean
  /** Whether the store is at or over the limit. */
  exceeded: boolean
  /** Whether the measurement itself failed. */
  unreadable: boolean
}

/**
 * Measure the bytes under a directory.
 *
 * Unreadable entries are skipped rather than throwing: a single permission-denied
 * file must not make the whole store look unlimited, and the result reports that
 * the figure is incomplete so a caller can say so.
 * @param dir - directory to walk.
 * @returns total bytes, and whether every entry could be read.
 */
export function measureDirectory(dir: string): { bytes: number, complete: boolean } {
  if (!existsSync(dir)) return { bytes: 0, complete: true }
  let bytes = 0
  let complete = true
  const walk = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      complete = false
      return
    }
    for (const entry of entries) {
      const child = join(current, entry)
      try {
        const stat = statSync(child)
        if (stat.isDirectory()) walk(child)
        else bytes += stat.size
      } catch {
        complete = false
      }
    }
  }
  walk(dir)
  return { bytes, complete }
}

/**
 * Compute the store's quota state.
 * @param storeRoot - absolute store root.
 * @param quota - configured quota.
 * @returns the state.
 */
export function quotaState(storeRoot: string, quota: Quota): QuotaState {
  const { bytes: used, complete } = measureDirectory(storeRoot)
  if (quota.bytes === null) {
    return { used, limit: null, fraction: null, nearLimit: false, exceeded: false, unreadable: !complete }
  }
  const fraction = used / quota.bytes
  return {
    used,
    limit: quota.bytes,
    fraction,
    nearLimit: fraction >= quota.warnAt,
    exceeded: used >= quota.bytes,
    unreadable: !complete,
  }
}

/** Outcome of an admission check. */
export interface Admission {
  /** Whether the operation may proceed. */
  allowed: boolean
  /**
   * Why it was refused, phrased with the limit and the shortfall.
   *
   * Non-null exactly when `allowed` is false, because §8.2 forbids a bare refusal:
   * a user who is blocked needs the number that blocked them and what to do.
   */
  reason: string | null
  /** State at decision time, so the caller can render the meter without re-measuring. */
  state: QuotaState
}

/**
 * Decide whether `incomingBytes` more may be written.
 *
 * Called before accepting an upload and before starting a build, because those are
 * the two operations that grow the store. A build is checked against its *planned*
 * footprint rather than zero, or a rebuild could double a store that an upload was
 * already refused for.
 * @param storeRoot - absolute store root.
 * @param quota - configured quota.
 * @param incomingBytes - bytes the operation is expected to add.
 * @param what - what is being attempted, for the message.
 * @returns the admission decision.
 */
export function admit(storeRoot: string, quota: Quota, incomingBytes: number, what: string): Admission {
  const state = quotaState(storeRoot, quota)
  if (quota.bytes === null) return { allowed: true, reason: null, state }

  if (state.unreadable) {
    // Refusing on an unreadable measurement would block a user whose only problem
    // is a permission bit on an unrelated file; allowing silently would defeat the
    // quota. Neither is right, so it is allowed and the caller is told the figure
    // is incomplete via `state.unreadable`.
    return { allowed: true, reason: null, state }
  }

  const projected = state.used + incomingBytes
  if (projected <= quota.bytes) return { allowed: true, reason: null, state }

  const shortfall = projected - quota.bytes
  return {
    allowed: false,
    reason: `${what}需要约 ${formatBytes(incomingBytes)}，将占用 ${formatBytes(projected)}，`
      + `超出配额 ${formatBytes(quota.bytes)}（当前已用 ${formatBytes(state.used)}，尚缺 ${formatBytes(shortfall)}）。`
      + '可删除不再需要的文档或知识库以释放空间，或由部署方调高 quota.bytes。',
    state,
  }
}

/**
 * Format a byte count for a message.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
