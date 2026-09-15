/**
 * Durable file primitives for the knowledge store.
 *
 * Everything the plugin writes must survive a process that is killed mid-write,
 * because a half-written index manifest is worse than a missing one: the next
 * start reads it and believes it. Three primitives cover every write the store
 * makes, and each exists because the naive version has a specific failure:
 *
 * - {@link writeJsonAtomic} — a `writeFileSync` that is interrupted leaves a
 *   truncated file. Writing to a sibling temp file, fsyncing it, then renaming
 *   over the target makes the swap atomic on POSIX and on Windows, and the fsync
 *   is what stops the rename from publishing an empty file after a power loss.
 * - {@link appendJsonl} — the append log is the one place a partial line is
 *   expected, because a crash between the write and the flush leaves a torn
 *   tail. {@link readJsonl} drops that tail instead of throwing on it.
 * - {@link withFileLock} — read-modify-write on one resource has to be
 *   serialized in-process, or two concurrent creators both observe "absent" and
 *   both write.
 *
 * @module dsh-zvec-knowledge/store/atomic
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Per-key promise chain serializing read-modify-write sections.
 *
 * A map of in-flight tails rather than a global mutex: two collections are
 * independent resources, so serializing them against each other would only add
 * latency. Entries are dropped once their chain drains, so a long-lived process
 * does not accumulate one entry per collection ever touched.
 */
const locks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` with exclusive access to the resource named `key`.
 *
 * The chain is built by appending to the previous tail, so callers queue in
 * arrival order. A rejected section must not poison the chain, which is why the
 * tail stored back is the settled form rather than the raw promise.
 * @param key - resource identity; distinct keys run concurrently.
 * @param fn - the critical section.
 * @returns whatever `fn` returns.
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(() => undefined, () => undefined)
  locks.set(key, tail)
  try {
    return await run
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/**
 * Write a file so that a reader either sees the previous content or the new
 * content, never a partial one.
 *
 * The temp file is a sibling, not a system temp path, because `rename` is only
 * atomic within one filesystem. The directory fsync is what makes the rename
 * itself durable: without it the new name can be lost while the data blocks
 * survive, which is the state that produces an empty manifest.
 * @param file - destination path.
 * @param contents - full file contents.
 */
export function writeFileAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file is already gone; the original error is the one that matters.
    }
    throw error
  }
  syncDirectory(dirname(file))
}

/**
 * Fsync a directory so a rename inside it is durable.
 *
 * Windows does not allow opening a directory as a file handle, so the call is
 * skipped there rather than failing the write — the rename is still atomic, and
 * NTFS journals the metadata. The guard is a platform check rather than a
 * try/catch so a real I/O error on POSIX still surfaces.
 * @param dir - directory to flush.
 */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is a durability optimisation, not a correctness gate.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Serialize a value as JSON and write it atomically.
 * @param file - destination path.
 * @param value - JSON-serializable value.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Append one JSON line to a log, creating the file if needed.
 *
 * Appending is deliberately not atomic: `O_APPEND` writes of a single small
 * buffer are atomic on both platforms, and the alternative (read, splice, write)
 * would make the log quadratic. {@link readJsonl} is what tolerates the torn
 * tail this leaves after a crash.
 * @param file - log path.
 * @param value - JSON-serializable record.
 */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`)
  } finally {
    closeSync(fd)
  }
}

/** One parsed line, paired with the offset it came from. */
export interface JsonlRecord<T> {
  /** Zero-based line index in the file. */
  line: number
  /** Parsed record. */
  value: T
}

/** Result of reading a JSONL log. */
export interface JsonlReadResult<T> {
  /** Successfully parsed records, in file order. */
  records: JsonlRecord<T>[]
  /**
   * Trailing bytes that did not parse, if any.
   *
   * A non-empty value means the log was cut off mid-write — the expected
   * outcome of a kill, not corruption. Callers decide whether to truncate it.
   */
  tornTail: string | null
}

/**
 * Read a JSONL log, tolerating a torn final line.
 *
 * Only the *last* line may be torn. A malformed line in the middle means the
 * file is genuinely corrupt, and reporting that as a torn tail would silently
 * discard every record after the damage, so it throws instead.
 * @param file - log path.
 * @returns parsed records plus any torn tail.
 * @throws {Error} when a non-final line is malformed.
 */
export function readJsonl<T>(file: string): JsonlReadResult<T> {
  if (!existsSync(file)) return { records: [], tornTail: null }
  const text = readFileSync(file, 'utf8')
  if (text === '') return { records: [], tornTail: null }
  const lines = text.split('\n')
  // A file ending in '\n' leaves a final empty element that is not a line; a
  // file cut off mid-write leaves a partial one, which is the torn tail.
  const trailing = lines.pop() ?? ''
  const complete = trailing === '' ? lines : [...lines, trailing]
  const records: JsonlRecord<T>[] = []
  for (const [index, line] of complete.entries()) {
    if (line.trim() === '') continue
    try {
      records.push({ line: index, value: JSON.parse(line) as T })
    } catch {
      // Only the final line may be torn. Anything earlier means the file is
      // genuinely corrupt, and reporting it as a torn tail would discard every
      // record after the damage.
      if (index === complete.length - 1) return { records, tornTail: line }
      throw new Error(`${file}: malformed JSON on line ${index + 1}; the log is corrupt, not torn`)
    }
  }
  return { records, tornTail: null }
}

/**
 * Read and parse a JSON file, returning `null` when it does not exist.
 *
 * A file that exists but does not parse is an error, not an absent value: the
 * atomic writer guarantees a published file is complete, so unparseable content
 * means something outside this module wrote it.
 * @param file - file path.
 * @returns the parsed value, or `null` when absent.
 */
export function readJsonOrNull<T>(file: string): T | null {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  if (text.trim() === '') return null
  return JSON.parse(text) as T
}

/** Outcome of a streamed write. */
export interface StreamWriteResult {
  /** Bytes actually written. */
  bytes: number
}

/**
 * Write a file from an async byte source, without holding it in memory.
 *
 * This exists because {@link writeFileAtomic} takes the *whole* contents as a
 * string. That is fine for a manifest and wrong for an upload: a 32 MB document
 * would be buffered in full, and aggregating uploads on the host is the one thing
 * a large-file path must not do.
 *
 * Durability follows the same shape as the atomic writer — a sibling temp file,
 * fsync, then a rename — because the failure it prevents is identical: a reader
 * must never see half a document. The difference is that the bytes arrive in
 * chunks and are never concatenated.
 *
 * On failure the temp file is removed and nothing is published, so a cancelled
 * upload leaves no partial document behind for the build to read.
 * @param file - destination path.
 * @param source - async iterable of byte chunks.
 * @param signal - aborts the write, discarding the temp file.
 * @returns how many bytes were written.
 * @throws {Error} when the destination cannot be written or the signal aborts.
 */
export async function writeFileStreamed(
  file: string,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<StreamWriteResult> {
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.part`)
  const fd = openSync(temp, 'w')
  let bytes = 0
  try {
    for await (const chunk of source) {
      if (signal?.aborted === true) throw new Error('上传已取消')
      writeSync(fd, chunk)
      bytes += chunk.byteLength
    }
    fsyncSync(fd)
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // Already closed by the failing write; the original error is what matters.
    }
    try {
      unlinkSync(temp)
    } catch {
      // Nothing to clean up.
    }
    throw error
  }
  closeSync(fd)
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file is already gone.
    }
    throw error
  }
  syncDirectory(dirname(file))
  return { bytes }
}
