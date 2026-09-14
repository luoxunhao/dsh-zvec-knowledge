/**
 * Store layout and identifier rules.
 *
 * Two invariants live here, both from the design spec, and both are the kind
 * that only fail visibly in production if they are left to convention:
 *
 * - **Isolation.** Every collection lives under a root resolved from the
 *   session workspace, so two workspaces never read each other's index. The
 *   plugin never falls back to `process.cwd()` — an implicit cwd would scatter
 *   a user's indexes across whatever directory the host happened to be
 *   launched from.
 * - **Identity.** A collection id is the string the UI prints, the model
 *   passes, and the log correlates on (`kb_prod_2f8a`, spec §9.1), so it has
 *   to be a filesystem-safe name. Validating it at the boundary is what keeps
 *   a malformed id from becoming a path traversal.
 *
 * @module dsh-zvec-knowledge/store/paths
 */

import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/**
 * A collection identifier: `kb_` + a lower-case business-domain abbreviation +
 * `_` + a four-character hex discriminator, e.g. `kb_prod_2f8a`.
 */
const COLLECTION_ID = /^kb_[a-z][a-z0-9]{0,15}_[0-9a-f]{4}$/

/**
 * Relative path of a collection's metadata and snapshot pointer.
 *
 * The name is owned by `snapshot.ts` (as `SNAPSHOT_META_FILE`); it is repeated
 * here only so path-only callers can locate it without importing the store.
 */
export const COLLECTION_FILE = 'meta.json'

/**
 * Validate a collection identifier.
 * @param id - candidate identifier, however malformed.
 * @returns the identifier, narrowed to a validated string.
 * @throws {Error} when the identifier does not match the documented format.
 */
export function assertCollectionId(id: string): string {
  if (!COLLECTION_ID.test(id)) {
    throw new Error(
      `invalid collection id ${JSON.stringify(id)}: expected kb_<domain>_<4 hex>, e.g. kb_prod_2f8a`,
    )
  }
  return id
}

/**
 * Resolve the store root for one workspace.
 *
 * A relative `stateDir` is resolved against the workspace, which is the
 * isolation dimension; an absolute one is taken as given, which is the
 * documented opt-out. The result is normalized so two configurations that
 * name the same directory compare equal.
 * @param workspaceDir - absolute path of the session workspace.
 * @param stateDir - configured storage root, relative or absolute.
 * @returns the absolute store root.
 * @throws {Error} when the workspace is not an absolute path.
 */
export function resolveStoreRoot(workspaceDir: string, stateDir: string): string {
  if (!isAbsolute(workspaceDir)) {
    throw new Error(`workspaceDir must be an absolute path, received ${JSON.stringify(workspaceDir)}`)
  }
  const root = isAbsolute(stateDir) ? normalize(stateDir) : resolve(workspaceDir, stateDir)
  if (!isAbsolute(root)) {
    throw new Error(`resolved store root is not absolute: ${JSON.stringify(root)}`)
  }
  return root
}

/**
 * Resolve one collection's directory and prove it stays inside the store root.
 *
 * The containment check is the point of going through this function rather
 * than calling `join` at each call site: a caller that passed an unvalidated id
 * would otherwise be able to address any directory on the machine.
 * @param storeRoot - absolute store root, as returned by {@link resolveStoreRoot}.
 * @param collectionId - collection identifier.
 * @returns the absolute collection directory.
 * @throws {Error} when the id is malformed or the result escapes the store root.
 */
export function collectionDir(storeRoot: string, collectionId: string): string {
  const dir = join(storeRoot, assertCollectionId(collectionId))
  const prefix = storeRoot.endsWith(sep) ? storeRoot : `${storeRoot}${sep}`
  if (!normalize(dir).startsWith(prefix)) {
    throw new Error(`collection ${collectionId} resolves outside the store root`)
  }
  return dir
}

/**
 * Split a collection identifier into its documented parts.
 * @param collectionId - collection identifier.
 * @returns the business-domain abbreviation and the hex discriminator.
 */
export function parseCollectionId(collectionId: string): { domain: string, hash: string } {
  const id = assertCollectionId(collectionId)
  const [, domain, hash] = id.split('_')
  // assertCollectionId already guarantees both segments exist.
  return { domain: domain as string, hash: hash as string }
}
