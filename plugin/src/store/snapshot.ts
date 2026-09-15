/**
 * Snapshot switching: a rebuild never disturbs the index being served.
 *
 * The spec requires that retrieval keeps answering from the *previous* snapshot
 * while a rebuild runs, and that the UI says so. Making that true needs the
 * engine's write target and its read target to be different things, which is why
 * a collection owns two directories:
 *
 * ```
 * <storeRoot>/<collectionId>/          meta.json + snapshots.json (the pointer)
 * <storeRoot>/<collectionId>/a/        one built snapshot
 * <storeRoot>/<collectionId>/b/        the other
 * ```
 *
 * A build writes into the inactive slot and then flips the pointer, which is a
 * single atomic metadata write. Readers take the pointer once at the start of a
 * request, so they hold one snapshot for the request's duration; an in-flight
 * search therefore cannot observe a half-built index, and a cancelled build only
 * ever leaves a stale inactive slot to overwrite next time.
 *
 * Two slots are enough: a third would only matter if a second rebuild had to
 * start before the first published, and the build lock prevents that.
 *
 * @module dsh-zvec-knowledge/store/snapshot
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ZVecCreateAndOpen, ZVecCollectionSchema,
  type ZVecCollection,
} from '@zvec/zvec'
import { assertCollectionId, collectionDir } from './paths.ts'
import { readJsonOrNull, writeJsonAtomic, withFileLock } from './atomic.ts'
import { buildSchema, type IndexConfig } from './collection.ts'
import type { ChunkingConfig } from './chunk.ts'
import { acquire, markActive, takeForWrite, type HandleLease } from './registry.ts'

/** The two snapshot slots. */
export const SLOTS = ['a', 'b'] as const

/** A snapshot slot identifier. */
export type Slot = typeof SLOTS[number]

/** Metadata describing a collection and which slot it currently serves. */
export interface SnapshotMeta {
  /** Collection identifier. */
  id: string
  /** Human-facing name. */
  name: string
  /** Free-text description. */
  description: string
  /** Creation time, ISO-8601. */
  createdAt: string
  /** Last successful build time, ISO-8601, or `null` before the first build. */
  builtAt: string | null
  /** Vector index configuration; needed because a reopen cannot accept one. */
  index: IndexConfig
  /**
   * Chunking configuration the active snapshot was built with.
   *
   * Recorded so an incremental build can tell whether the parameters still match
   * what the stored chunks were cut with. Changing them re-cuts every document, so
   * reusing the old vectors would produce an index whose chunks disagree with its
   * own strategy — silently, since a wrong chunk is still a valid vector.
   *
   * `null` for a collection written before this field existed; a build treats an
   * unknown value as a mismatch and rebuilds fully, which is the safe direction.
   */
  chunking: ChunkingConfig | null
  /** Slot currently being served. `null` before the first successful build. */
  active: Slot | null
  /** Chunks in the active snapshot, for the overview card. */
  chunks: number
  /** Documents in the active snapshot. */
  docs: number
}

/** Pointer and collection metadata file. */
export const SNAPSHOT_META_FILE = 'meta.json'

/**
 * Directory of one slot.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot identifier.
 * @returns absolute slot directory.
 */
export function slotDir(storeRoot: string, id: string, slot: Slot): string {
  return join(collectionDir(storeRoot, assertCollectionId(id)), slot)
}

/**
 * Read collection metadata.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @returns metadata, or `null` when the collection does not exist.
 */
export function readMeta(storeRoot: string, id: string): SnapshotMeta | null {
  return readJsonOrNull<SnapshotMeta>(join(collectionDir(storeRoot, assertCollectionId(id)), SNAPSHOT_META_FILE))
}

/**
 * Write collection metadata atomically.
 * @param storeRoot - absolute store root.
 * @param meta - metadata to persist.
 */
export function writeMeta(storeRoot: string, meta: SnapshotMeta): void {
  writeJsonAtomic(join(collectionDir(storeRoot, assertCollectionId(meta.id)), SNAPSHOT_META_FILE), meta)
}

/** A collection's metadata plus a lease on its currently served engine handle. */
export interface ServedCollection {
  /** Collection identifier. */
  id: string
  /** Metadata as read at open time. */
  meta: SnapshotMeta
  /** Lease on the active slot's handle, or `null` before the first build. */
  lease: HandleLease | null
  /** The slot the handle reads from. */
  slot: Slot | null
}

/**
 * Create a collection directory with no snapshot yet.
 *
 * Creation is deliberately metadata-only: the first build decides the schema and
 * fills a slot. That means a freshly created collection answers "not built yet"
 * rather than serving an empty index, which is what the spec's 待构建 state means.
 * @param storeRoot - absolute store root.
 * @param meta - collection metadata; `active` is forced to `null`.
 * @throws {Error} when the collection already exists.
 */
export async function createCollection(storeRoot: string, meta: Omit<SnapshotMeta, 'active' | 'builtAt' | 'chunks' | 'docs' | 'chunking'>): Promise<SnapshotMeta> {
  const id = assertCollectionId(meta.id)
  const dir = collectionDir(storeRoot, id)
  return withFileLock(dir, () => {
    if (existsSync(dir)) {
      throw new Error(`collection ${id} already exists at ${dir}; creation is no-clobber`)
    }
    // `chunking` starts null: nothing has been built, so no parameters have been
    // used yet, and the first build always indexes everything regardless.
    const created: SnapshotMeta = { ...meta, chunking: null, builtAt: null, active: null, chunks: 0, docs: 0 }
    writeMeta(storeRoot, created)
    return created
  })
}

/**
 * Open the active snapshot for reading.
 *
 * The pointer is read once here and the handle returned is bound to that slot,
 * so a caller's search is unaffected by a rebuild that publishes mid-request.
 *
 * The handle comes from the process-wide registry rather than a fresh
 * `ZVecOpen`, because the engine holds an exclusive lock per directory: opening
 * the same slot twice fails, even read-only. The returned lease must be released.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @returns the served collection; `handle` is `null` when nothing is built yet.
 * @throws {Error} when the collection does not exist or points at a missing slot.
 */
export function openServed(storeRoot: string, id: string): ServedCollection {
  const meta = readMeta(storeRoot, id)
  if (meta === null) throw new Error(`collection ${id} does not exist under ${storeRoot}`)
  if (meta.active === null) return { id, meta, lease: null, slot: null }
  const lease = acquire(storeRoot, id, meta.active)
  if (lease === null) {
    // The pointer references a slot that is gone; report it rather than
    // silently serving nothing, because that would look like an empty index.
    throw new Error(`collection ${id} points at snapshot "${meta.active}" but its directory is missing`)
  }
  markActive(storeRoot, id, meta.active)
  return { id, meta, lease, slot: meta.active }
}

/**
 * Run a function against a collection's active snapshot, releasing the handle.
 *
 * The preferred entry point for callers: the lease's lifetime is bounded by the
 * call, so a forgotten release cannot leak the directory lock.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param fn - receives the handle, or `null` when nothing is built yet.
 * @returns whatever `fn` returns.
 */
export function withServed<T>(storeRoot: string, id: string, fn: (handle: ZVecCollection | null, meta: SnapshotMeta) => T): T {
  const served = openServed(storeRoot, id)
  try {
    return fn(served.lease?.handle ?? null, served.meta)
  } finally {
    served.lease?.release()
  }
}

/**
 * The slot a build should write into: whichever is not being served.
 * @param meta - current metadata.
 * @returns the inactive slot.
 */
export function inactiveSlot(meta: SnapshotMeta): Slot {
  if (meta.active === null) return SLOTS[0]
  return meta.active === SLOTS[0] ? SLOTS[1] : SLOTS[0]
}

/**
 * Prepare a slot for writing, discarding any previous contents.
 *
 * `ZVecCreateAndOpen` requires an absent path, so the stale slot is removed
 * first. This is the only place a snapshot directory is deleted, and it is
 * always the inactive one, so a served index is never touched. Any cached reader
 * on the slot is closed first — the engine's exclusive directory lock means a
 * surviving handle would make this fail.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot to clear.
 * @param index - index configuration for the new schema.
 * @param dimension - vector width the embedding model returns; defaults to the
 * spec's illustrative figure when a deployment does not state one.
 * @returns an open handle writing into that slot.
 */
export function resetSlot(storeRoot: string, id: string, slot: Slot, index: IndexConfig, dimension?: number): ZVecCollection {
  takeForWrite(storeRoot, id, slot)
  const dir = slotDir(storeRoot, id, slot)
  rmSync(dir, { recursive: true, force: true })
  const schema: ZVecCollectionSchema = buildSchema(id, index, dimension)
  return ZVecCreateAndOpen(dir, schema)
}

/**
 * Clone the served snapshot into the inactive slot, for an incremental build.
 *
 * An incremental build must keep the chunks that are already indexed, and the
 * engine offers no "copy these documents into a new collection" call — so the
 * snapshot *directory* is copied and reopened. That works because every zvec
 * artifact is self-contained: the vector index, the FTS store and the scalar
 * columns all live under the slot directory, so a byte copy is a complete,
 * consistent snapshot. The usual reason to avoid copying an open database (a
 * write-ahead log mid-flight) does not apply: the active slot is never being
 * written to — a build always targets the inactive one.
 *
 * The clone is only valid when the schema would be identical, so it is the
 * caller's job to have established that the index and chunking configurations
 * still match; a schema difference would be rejected by `ZVecOpen`.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param from - the slot to copy, normally the active one.
 * @param to - the slot to write, normally the inactive one.
 * @returns the number of bytes copied, for the build log.
 * @throws {Error} when the source slot is absent or `to` already holds data.
 */
export function cloneSlot(storeRoot: string, id: string, from: Slot, to: Slot): number {
  const source = slotDir(storeRoot, id, from)
  const target = slotDir(storeRoot, id, to)
  if (!existsSync(source)) {
    throw new Error(`snapshot ${from} is missing, so it cannot be cloned for an incremental build`)
  }
  // The destination is cleared first: a previous failed build may have left a
  // partial directory, and copying over it would merge two snapshots.
  takeForWrite(storeRoot, id, to)
  rmSync(target, { recursive: true, force: true })
  const bytes = copyTree(source, target)
  return bytes
}

/**
 * Copy a directory tree, returning the bytes written.
 *
 * A plain recursive copy. The slot contents are small enough that a streaming
 * implementation would add complexity without a benefit, and the build already
 * reports progress at a coarser granularity.
 * @param from - absolute source directory.
 * @param to - absolute destination directory.
 * @returns total bytes copied.
 */
function copyTree(from: string, to: string): number {
  mkdirSync(to, { recursive: true })
  let total = 0
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const sourcePath = join(from, entry.name)
    const targetPath = join(to, entry.name)
    if (entry.isDirectory()) {
      total += copyTree(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) continue
    copyFileSync(sourcePath, targetPath)
    total += statSync(sourcePath).size
  }
  return total
}

/**
 * Publish a built slot by flipping the active pointer.
 *
 * The metadata write is the commit point: everything before it is invisible to
 * readers, and it is a single atomic rename.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param slot - slot just built.
 * @param counts - chunk and document counts to record.
 * @returns the updated metadata.
 */
export async function publishSlot(
  storeRoot: string,
  id: string,
  slot: Slot,
  counts: { chunks: number, docs: number, chunking?: ChunkingConfig },
): Promise<SnapshotMeta> {
  const dir = collectionDir(storeRoot, assertCollectionId(id))
  return withFileLock(dir, () => {
    const meta = readMeta(storeRoot, id)
    if (meta === null) throw new Error(`collection ${id} disappeared during build`)
    const updated: SnapshotMeta = {
      ...meta,
      active: slot,
      builtAt: new Date().toISOString(),
      chunks: counts.chunks,
      docs: counts.docs,
      // Recorded at publish time, which is the moment these parameters became the
      // ones the served chunks were actually cut with.
      ...(counts.chunking === undefined ? {} : { chunking: counts.chunking }),
    }
    writeMeta(storeRoot, updated)
    markActive(storeRoot, id, slot)
    return updated
  })
}

/**
 * Delete a collection and every snapshot under it.
 *
 * Both slots are unlocked first: the engine holds an exclusive lock per
 * directory, and on Windows an open handle makes the removal fail rather than
 * leaving a partially deleted collection.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @throws {Error} when the collection does not exist.
 */
export function deleteCollection(storeRoot: string, id: string): void {
  const dir = collectionDir(storeRoot, assertCollectionId(id))
  if (!existsSync(dir)) throw new Error(`collection ${id} does not exist under ${storeRoot}`)
  for (const slot of SLOTS) takeForWrite(storeRoot, id, slot)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Rename a collection's display name.
 *
 * The id is immutable: it is the directory name and the engine's collection name,
 * so changing it would mean rebuilding. Only the label changes.
 * @param storeRoot - absolute store root.
 * @param id - collection identifier.
 * @param name - new display name.
 * @returns updated metadata.
 * @throws {Error} when the collection does not exist or the name is blank.
 */
export async function renameCollection(storeRoot: string, id: string, name: string): Promise<SnapshotMeta> {
  if (name.trim() === '') throw new Error('collection name must not be blank')
  const dir = collectionDir(storeRoot, assertCollectionId(id))
  return withFileLock(dir, () => {
    const meta = readMeta(storeRoot, id)
    if (meta === null) throw new Error(`collection ${id} does not exist under ${storeRoot}`)
    const updated: SnapshotMeta = { ...meta, name }
    writeMeta(storeRoot, updated)
    return updated
  })
}

/**
 * List every collection id under a store root.
 *
 * The store root is scanned rather than an index file trusted, so a collection
 * whose metadata write was interrupted is discovered by its directory and can be
 * reconciled. Ids that fail validation are skipped, which is what keeps a stray
 * temp directory from becoming a phantom collection.
 * @param storeRoot - absolute store root.
 * @param readDir - directory reader, injected so this module stays dependency-free.
 * @returns validated collection ids.
 */
export function listCollectionIds(storeRoot: string, readDir: (dir: string) => string[]): string[] {
  if (!existsSync(storeRoot)) return []
  const ids: string[] = []
  for (const entry of readDir(storeRoot)) {
    try {
      assertCollectionId(entry)
    } catch {
      continue
    }
    if (readMeta(storeRoot, entry) !== null) ids.push(entry)
  }
  return ids.sort()
}
