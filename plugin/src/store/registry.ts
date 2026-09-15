/**
 * Handle registry: one open handle per snapshot slot, for the process lifetime.
 *
 * The engine takes an **exclusive lock on a collection directory**, including for
 * read-only opens — a second `ZVecOpen` on the same path fails with
 * `ZVEC_INTERNAL_ERROR: Can't lock .../LOCK`. Verified in
 * `scripts/zvec-probe-lock.mjs`. That is a hard constraint the design has to
 * respect: opening per request, which is the obvious shape, works for the first
 * concurrent caller and fails for the second.
 *
 * So handles are cached per slot and reference-counted:
 *
 * - Many readers share one handle. A search takes a lease, uses it, and releases.
 * - A slot is only closed when its last lease is released *and* it is not the
 *   active snapshot, or when the plugin is disposed. Closing a slot that staged a
 *   build is what lets the next build recreate it, since `ZVecCreateAndOpen`
 *   demands an absent path.
 * - Disposal closes everything, which is what satisfies the acceptance criterion
 *   that uninstalling leaves no file handle behind.
 *
 * @module dsh-zvec-knowledge/store/registry
 */

import type { ZVecCollection } from '@zvec/zvec'
import { ZVecOpen } from '@zvec/zvec'
import { existsSync } from 'node:fs'
import { slotDir, type Slot } from './snapshot.ts'

/** Cache key for one collection's slot. */
function keyOf(storeRoot: string, id: string, slot: Slot): string {
  return `${storeRoot}\u0000${id}\u0000${slot}`
}

/** One cached handle. */
interface Entry {
  /** The open engine handle. */
  handle: ZVecCollection
  /** Outstanding leases. */
  leases: number
  /** Whether this entry is the collection's currently published snapshot. */
  active: boolean
  /**
   * Whether the underlying handle has been closed.
   *
   * A closed handle stays a live JS object — calling `upsertSync` or reading
   * `stats` on it throws the engine's bare `Collection is closed`. That message
   * names nothing a user or an operator can act on, so a stale entry has to be
   * recognisable *here* rather than surfacing from three layers down.
   */
  closed: boolean
}

/**
 * Process-wide handle cache.
 *
 * Module-level because the engine's lock is process-wide: a second instance of
 * this registry would try to open a directory the first one already holds.
 */
const entries = new Map<string, Entry>()

/** A borrowed handle that must be released. */
export interface HandleLease {
  /** The engine handle to read through. */
  handle: ZVecCollection
  /** Return the handle to the registry. Safe to call more than once. */
  release: () => void
}

/**
 * Close an entry's handle and mark it closed.
 *
 * Every close goes through here so that "the handle is closed" and "the entry
 * knows it" cannot drift apart. Marking before closing means a throw from
 * `closeSync` (the engine already closed it, which happens when a build's
 * `ZVecCreateAndOpen` failed after the directory was removed) still leaves the
 * entry unusable rather than silently reusable.
 * @param entry - the entry to close.
 */
function closeEntry(entry: Entry): void {
  entry.closed = true
  try {
    entry.handle.closeSync()
  } catch {
    // Already closed by the engine, or the directory is already gone. Either way
    // the handle is not usable again, which is what `closed` records.
  }
}

/**
 * Borrow a handle for reading, opening it if needed.
 *
 * The handle is guaranteed open for the duration of the lease and is not closed
 * under the borrower, which is what makes an in-flight search safe across a
 * rebuild that publishes concurrently.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - snapshot slot.
 * @returns a lease; `null` when the slot directory does not exist.
 * @throws {Error} when the directory exists but the engine refuses to open it.
 */
export function acquire(storeRoot: string, id: string, slot: Slot): HandleLease | null {
  const key = keyOf(storeRoot, id, slot)
  const existing = entries.get(key)
  if (existing !== undefined && !existing.closed) {
    existing.leases += 1
    return leaseOf(key, existing)
  }
  // A closed entry must be dropped rather than handed out: its handle would throw
  // `Collection is closed` on first use, which reads as a store corruption when it
  // is really a stale cache. Discarding it makes the reopen below the recovery.
  if (existing !== undefined) entries.delete(key)
  const dir = slotDir(storeRoot, id, slot)
  if (!existsSync(dir)) return null
  const handle = ZVecOpen(dir)
  const entry: Entry = { handle, leases: 1, active: false, closed: false }
  entries.set(key, entry)
  return leaseOf(key, entry)
}

/**
 * Build a lease for an entry.
 * @param key - cache key.
 * @param entry - cache entry.
 * @returns the lease.
 */
function leaseOf(key: string, entry: Entry): HandleLease {
  let released = false
  return {
    handle: entry.handle,
    release: () => {
      if (released) return
      released = true
      entry.leases -= 1
      // Nothing closes a slot implicitly: a slot with no leases is still the one
      // a later request will want, and reopening costs an index load. Explicit
      // release is what keeps the lock held deliberately rather than by accident.
      if (entries.get(key) !== entry) return
    },
  }
}

/**
 * Take ownership of a slot for writing, closing any cached reader first.
 *
 * A build needs the directory to itself, and the engine will not grant a second
 * handle, so the cached entry (if any) is closed before the caller recreates the
 * directory. Any outstanding lease on that slot is invalidated; callers hold
 * leases only across a single request, and a build only ever targets the inactive
 * slot, so no reader is holding one.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot to take over.
 */
export function takeForWrite(storeRoot: string, id: string, slot: Slot): void {
  const key = keyOf(storeRoot, id, slot)
  const entry = entries.get(key)
  if (entry === undefined) return
  entries.delete(key)
  closeEntry(entry)
}

/**
 * Register a freshly created handle as the cached entry for a slot.
 *
 * `ZVecCreateAndOpen` returns a handle the registry did not open, so it has to be
 * adopted; otherwise the next acquire would try to open the same directory and
 * hit the lock.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot just created.
 * @param handle - the created handle; ownership transfers to the registry.
 */
export function adopt(storeRoot: string, id: string, slot: Slot, handle: ZVecCollection): void {
  const key = keyOf(storeRoot, id, slot)
  const previous = entries.get(key)
  if (previous !== undefined) {
    // Superseded entry; nothing to preserve. Closing it rather than dropping the
    // reference is what releases the directory lock the old handle still holds.
    closeEntry(previous)
  }
  entries.set(key, { handle, leases: 0, active: false, closed: false })
}

/**
 * Mark which slot of a collection is the published snapshot.
 *
 * Purely informational: it records intent so {@link releaseSlot} knows whether a
 * candidate is safe to close. It does not affect leases.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - the active slot.
 */
export function markActive(storeRoot: string, id: string, slot: Slot): void {
  for (const slotName of ['a', 'b'] as const) {
    const entry = entries.get(keyOf(storeRoot, id, slotName))
    if (entry !== undefined) entry.active = slotName === slot
  }
}

/**
 * Close and forget a slot's handle if nothing is using it.
 *
 * Called after a build publishes, to release the staging slot: the engine holds
 * an exclusive lock until close, and the next build needs to recreate that
 * directory. A slot still holding leases is left alone — closing it would pull
 * the handle out from under an in-flight read.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot to release.
 * @returns whether the handle was closed.
 */
export function releaseSlot(storeRoot: string, id: string, slot: Slot): boolean {
  const key = keyOf(storeRoot, id, slot)
  const entry = entries.get(key)
  if (entry === undefined || entry.leases > 0) return false
  entries.delete(key)
  closeEntry(entry)
  return true
}

/**
 * Close every cached handle.
 *
 * Registered as the plugin fiber's disposer, so uninstalling or hot-reloading
 * releases the engine's directory locks instead of leaking them into the next
 * load — which would make the next load fail with a lock error rather than a
 * clear "already running" message.
 * @returns number of handles closed.
 */
export function disposeAll(): number {
  const count = entries.size
  for (const entry of entries.values()) closeEntry(entry)
  entries.clear()
  return count
}

/**
 * Number of handles currently cached, for the leak assertion in the test suite.
 * @returns cached handle count.
 */
export function openHandleCount(): number {
  return entries.size
}
