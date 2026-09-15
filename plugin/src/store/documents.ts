/**
 * Document records: the upload-time half of a collection's persistence.
 *
 * A document exists in two places with different lifecycles, and keeping them
 * straight is what this module is for:
 *
 * - **Here** — a JSONL record per document, written at upload time. It carries the
 *   text, the chunking-relevant metadata, and the lifecycle status.
 * - **In the engine** — the chunks, written later by the build pipeline (KB-07).
 *
 * So a freshly uploaded document legitimately has *no chunks in the engine*. That
 * is why {@link DocumentRecord.chunks} is `number | null` rather than `0`: the
 * spec's 待构建 state means "not measured yet", and `0` would read as "this
 * document produced no chunks" — a different and alarming claim. The UI prints
 * the pending marker for `null`.
 *
 * The append-only log is the right shape here: uploads are append-only in
 * practice, a torn tail is the expected outcome of a crash (and is dropped), and
 * a document's status change is an update to one record rather than a rewrite of
 * the whole set.
 *
 * @module dsh-zvec-knowledge/store/documents
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { collectionDir } from './paths.ts'
import { appendJsonl, readJsonl, writeFileAtomic } from './atomic.ts'

/** Lifecycle status of a document, mirroring the spec's state vocabulary. */
export type DocumentStatus = 'pending' | 'building' | 'ready' | 'failed'

/** One uploaded document. */
export interface DocumentRecord {
  /** Stable document id, referenced by every chunk's `doc_id`. */
  id: string
  /** Original file name, shown in the list. */
  name: string
  /** Size in bytes as uploaded. */
  bytes: number
  /** Lower-case extension without the dot, e.g. `md`; drives the type icon. */
  ext: string
  /**
   * The document's extracted plain text.
   *
   * Stored rather than re-read from the original file, because the original may
   * have moved or changed between upload and rebuild — and a rebuild that read a
   * different revision would silently produce an index that does not match what
   * the user uploaded. It is also why `bytes` is recorded separately: the byte
   * count describes the source file, while this describes what is indexed.
   */
  text: string
  /** Lifecycle status. */
  status: DocumentStatus
  /**
   * Chunks indexed, or `null` when the document has not been built yet.
   *
   * `null` is the 待构建 value (§3.3): the count is not merely zero, it is not yet
   * known. See the module note.
   */
  chunks: number | null
  /** Upload time, ISO-8601. */
  uploadedAt: string
  /** Last build time, ISO-8601, or `null`. */
  builtAt: string | null
  /** Failure reason, when `status` is `failed`. */
  error?: string
}

/** File name of a collection's document log. */
export const DOCUMENTS_FILE = 'documents.jsonl'

/** Accepted upload formats, with the extension each maps to. */
export const ACCEPTED_EXTENSIONS = ['md', 'markdown', 'txt', 'pdf', 'docx', 'html', 'htm', 'json', 'csv'] as const

/** Maximum accepted upload size, in bytes. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/** Human-readable form of {@link MAX_UPLOAD_BYTES}, for messages. */
export const MAX_UPLOAD_LABEL = '32 MB'

/**
 * Path of a collection's document log.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @returns absolute path.
 */
export function documentsPath(storeRoot: string, collectionId: string): string {
  return join(collectionDir(storeRoot, collectionId), DOCUMENTS_FILE)
}

/**
 * Read every document record for a collection.
 *
 * A torn tail is dropped rather than reported: the last append is the one that
 * was in flight when the process died, so the document simply was not uploaded.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @returns records in write order.
 */
export function listDocuments(storeRoot: string, collectionId: string): DocumentRecord[] {
  const file = documentsPath(storeRoot, collectionId)
  if (!existsSync(file)) return []
  return readJsonl<DocumentRecord>(file).records.map(record => record.value)
}

/**
 * Append one document record.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param record - the document.
 */
export function appendDocument(storeRoot: string, collectionId: string, record: DocumentRecord): void {
  appendJsonl(documentsPath(storeRoot, collectionId), record)
}

/**
 * Derive a document id from its name and a discriminator.
 *
 * Namespaced per collection by the caller's storage location, so a collision
 * would need the same name and the same millisecond. The id is also the prefix of
 * every chunk id, which is what lets one document's chunks be found by filter.
 * @param name - original file name.
 * @param seed - discriminator seed; defaults to the current time.
 * @returns the document id.
 */
export function documentId(name: string, seed: string = String(Date.now())): string {
  let hash = 2166136261
  const input = `${name}\u0000${seed}`
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `doc_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Lower-case extension of a file name, without the dot.
 * @param name - file name, possibly with directories.
 * @returns the extension, or an empty string.
 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const at = base.lastIndexOf('.')
  if (at <= 0 || at === base.length - 1) return ''
  return base.slice(at + 1).toLowerCase()
}

/**
 * Validate an upload before accepting it.
 *
 * Returns a reason *and* the accepted range, because the spec forbids a bare
 * rejection: "格式不支持" without saying which formats are supported leaves the
 * user with nothing to act on.
 * @param name - file name.
 * @param bytes - file size.
 * @returns `null` when acceptable, otherwise the reason including the limits.
 */
export function validateUpload(name: string, bytes: number): string | null {
  const ext = extensionOf(name)
  if (ext === '') {
    return `无法识别文件类型：「${name}」没有扩展名。支持 ${ACCEPTED_EXTENSIONS.join(' / ')}`
  }
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `不支持的格式 .${ext}。支持 ${ACCEPTED_EXTENSIONS.join(' / ')}`
  }
  if (bytes <= 0) {
    // States the floor as well as the ceiling: a rejection that only says "empty"
    // leaves the user with no idea what to bring instead.
    return `文件为空，没有可索引的内容（可接受 1 B 至 ${MAX_UPLOAD_LABEL}）`
  }
  if (bytes > MAX_UPLOAD_BYTES) {
    return `文件 ${formatBytesForMessage(bytes)} 超出上限 ${MAX_UPLOAD_LABEL}`
  }
  return null
}

/**
 * Format a byte count for a validation message.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
function formatBytesForMessage(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Directory inside a collection holding uploaded originals. */
export const SOURCES_DIR = 'sources'

/**
 * Path of one document's stored original.
 *
 * The original is kept byte-for-byte and never overwritten, which is what makes
 * the index a *derived* artifact: when the chunking rules or the text extraction
 * change, the corpus can be reprocessed from what the user actually uploaded
 * rather than from a transform whose inputs are gone.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param id - document id.
 * @param ext - lower-case extension, kept so the file is openable by hand.
 * @returns absolute path.
 */
export function sourcePath(storeRoot: string, collectionId: string, id: string, ext: string): string {
  return join(collectionDir(storeRoot, collectionId), SOURCES_DIR, `${id}.${ext}`)
}

/**
 * Replace a collection's document set.
 *
 * Used by status updates (a rebuild moves every document to 已构建), which are
 * inherently a whole-set operation. Written atomically so a crash mid-update
 * cannot leave the log half-rewritten — a partial rewrite is the one failure a
 * plain append cannot express.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param records - the complete new set.
 */
export function replaceDocuments(storeRoot: string, collectionId: string, records: DocumentRecord[]): void {
  const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
  writeFileAtomic(documentsPath(storeRoot, collectionId), body)
}

/**
 * Update one document's status fields.
 *
 * Read-modify-write over the whole log: the log is small (one line per document)
 * and a targeted in-place edit of a JSONL file is not expressible without
 * rewriting it anyway. Callers that need serialization use the collection lock.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param id - document id.
 * @param patch - fields to change.
 * @returns the updated records.
 * @throws {Error} when the document is absent.
 */
export function patchDocument(
  storeRoot: string,
  collectionId: string,
  id: string,
  patch: Partial<Omit<DocumentRecord, 'id'>>,
): DocumentRecord[] {
  const records = listDocuments(storeRoot, collectionId)
  const index = records.findIndex(record => record.id === id)
  if (index === -1) throw new Error(`document ${id} does not exist in ${collectionId}`)
  const existing = records[index] as DocumentRecord
  records[index] = { ...existing, ...patch }
  replaceDocuments(storeRoot, collectionId, records)
  return records
}

/**
 * Remove one document and report the remaining set.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @param id - document id.
 * @returns the remaining records.
 * @throws {Error} when the document is absent.
 */
export function removeDocument(storeRoot: string, collectionId: string, id: string): DocumentRecord[] {
  const records = listDocuments(storeRoot, collectionId)
  const remaining = records.filter(record => record.id !== id)
  if (remaining.length === records.length) {
    throw new Error(`document ${id} does not exist in ${collectionId}`)
  }
  replaceDocuments(storeRoot, collectionId, remaining)
  return remaining
}

/**
 * Delete a collection's document log.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 */
export function clearDocuments(storeRoot: string, collectionId: string): void {
  rmSync(documentsPath(storeRoot, collectionId), { force: true })
}

/**
 * Summarize a document set for the overview card.
 * @param records - document records.
 * @returns counts by status and the total chunk count (excluding pending).
 */
export function summarizeDocuments(records: DocumentRecord[]): {
  total: number
  pending: number
  building: number
  ready: number
  failed: number
  chunks: number
} {
  return {
    total: records.length,
    pending: records.filter(record => record.status === 'pending').length,
    building: records.filter(record => record.status === 'building').length,
    ready: records.filter(record => record.status === 'ready').length,
    failed: records.filter(record => record.status === 'failed').length,
    // Pending documents contribute nothing: their chunk count is unknown, not zero.
    chunks: records.reduce((sum, record) => sum + (record.chunks ?? 0), 0),
  }
}
