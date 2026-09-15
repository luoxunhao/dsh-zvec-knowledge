/**
 * Build jobs: a build outlives the request that started it.
 *
 * ## The problem this module exists to solve
 *
 * The first implementation ran the build *inside* the HTTP request that started
 * it, and treated the browser's connection as the build's lifetime: the route
 * handler wired `req.on('close')` to an `AbortController`, so navigating away,
 * switching panels or refreshing aborted the build. That is three defects at once:
 *
 * 1. **The progress was a lie.** One request returns one response, so the client
 *    could not receive the stages, counts or log lines the host was producing. It
 *    rendered every stage as `running` and `0 / 0 · 0%` until the request settled.
 * 2. **Waiting was mandatory and pointless.** The user had to sit on the build
 *    page, because leaving cancelled the work they were waiting for.
 * 3. **An interrupted build left damage.** A cancelled build discards its staging
 *    slot, and the mid-flight abort could leave the pooled engine handle closed —
 *    which surfaced as the engine's bare `Collection is closed`.
 *
 * A build is a host-side task. This module is its owner: jobs are stored per
 * collection in process memory, progress is *observed* by polling rather than
 * pushed down a request, and the page becomes a viewer that can come and go.
 *
 * ## What survives what
 *
 * | event | build | job record |
 * |-------|-------|-----------|
 * | page refresh / panel switch | keeps running | kept |
 * | browser closed | keeps running | kept |
 * | explicit 取消构建 | cancelled | kept, marked cancelled |
 * | process restart | gone | gone |
 *
 * The process restart row is the honest limit: the engine's handles and the
 * embedding work live in the process, so a restart cannot resume a build. What a
 * restart *does* preserve is the collection's own state — `meta.json` still
 * records whether the last build published — so the interface reports 待构建 and
 * the user reruns it. Claiming otherwise would be worse than the limitation.
 *
 * @module dsh-zvec-knowledge/store/job
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectionDir } from './paths.ts'
import {
  STAGE_LABELS, STAGES,
  type BuildLogLine, type BuildProgress, type BuildResult, type StageId,
} from './build.ts'

/** File name of a collection's persisted build log. */
export const BUILD_LOG_FILE = 'build-log.jsonl'

/**
 * How many log lines are kept per job.
 *
 * Bounded because a job record is retained for the life of the process and a
 * large collection emits a line per stage boundary plus every progress tick. The
 * tail is what a user reads; an unbounded array would grow with every build.
 */
const MAX_LOG_LINES = 500

/** One stage as the job reports it. */
export interface JobStage {
  /** Stage identifier. */
  id: StageId
  /** Display label; always present so the UI never renders a bare bar. */
  label: string
  /** Node state. */
  state: 'pending' | 'running' | 'done'
}

/** A job's observable state. */
export interface JobSnapshot {
  /** Collection the job belongs to. */
  collectionId: string
  /** Whether the build is still running. */
  running: boolean
  /** Whether the build finished successfully. `false` while running. */
  ok: boolean
  /** Stages in pipeline order. */
  stages: JobStage[]
  /** Items processed. */
  processed: number
  /** Total items; `0` until the parse stage has measured. */
  total: number
  /** Fraction in [0, 1]. */
  fraction: number
  /** Log lines, oldest first. */
  log: BuildLogLine[]
  /** ISO-8601 start time. */
  startedAt: string
  /** ISO-8601 settle time, or `null` while running. */
  settledAt: string | null
  /** Failure reason, when the job failed. */
  error: string | null
  /** Chunks published, once settled successfully. */
  chunks: number
}

/** A running or settled build job. */
interface Job {
  /** Collection the job belongs to. */
  collectionId: string
  /** Live progress. */
  progress: BuildProgress
  /** Accumulated log lines, capped at {@link MAX_LOG_LINES}. */
  log: BuildLogLine[]
  /** Whether the build is still running. */
  running: boolean
  /** Whether the build completed successfully. */
  ok: boolean
  /** Failure reason, when the build failed. */
  error: string | null
  /** Chunks published. */
  chunks: number
  /** ISO-8601 start time. */
  startedAt: string
  /** ISO-8601 settle time. */
  settledAt: string | null
  /** Cancels the underlying build. */
  cancel: () => void
  /** Absolute path of the collection's persisted log, when known. */
  logPath: string | null
}

/**
 * Process-wide job table, keyed by collection id.
 *
 * One job per collection, because the engine grants one writer per directory: a
 * second concurrent build of the same collection would contend for the same
 * exclusive lock, so the table's cardinality matches what the store can actually
 * do rather than inventing a queue.
 */
const jobs = new Map<string, Job>()

/** The initial stage list, all pending. */
function initialStages(): JobStage[] {
  return STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'pending' as const }))
}

/**
 * The last persisted log line, when a collection has one.
 *
 * Read so a rebuilt page can show what the *previous* build did rather than an
 * empty log. Failures are swallowed: a missing or unreadable log is not an error
 * the user can act on, and the fresh build's lines follow immediately.
 * @param logPath - absolute path, or `null` when the store root is unknown.
 * @returns the parsed lines, oldest first.
 */
function readPersistedLog(logPath: string | null): BuildLogLine[] {
  if (logPath === null) return []
  try {
    const text = readFileSync(logPath, 'utf8')
    const lines: BuildLogLine[] = []
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      try {
        lines.push(JSON.parse(raw) as BuildLogLine)
      } catch {
        // A partially written trailing line is expected after a crash; skipping it
        // is the whole reason the log is appended line-by-line.
      }
    }
    return lines.slice(-MAX_LOG_LINES)
  } catch {
    return []
  }
}

/**
 * Append one line to a collection's persisted log.
 *
 * Best effort: a build must not fail because a diagnostic file could not be
 * written, and the in-memory log is the copy the interface actually reads.
 * @param logPath - absolute path, or `null` to skip persistence.
 * @param line - the line to append.
 */
function persistLog(logPath: string | null, line: BuildLogLine): void {
  if (logPath === null) return
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8')
  } catch {
    // Diagnostics only; see above.
  }
}

/**
 * Resolve a collection's persisted-log path.
 * @param storeRoot - absolute store root.
 * @param collectionId - collection identifier.
 * @returns the absolute path, or `null` when the id is malformed.
 */
export function logPathFor(storeRoot: string, collectionId: string): string | null {
  try {
    return join(collectionDir(storeRoot, collectionId), BUILD_LOG_FILE)
  } catch {
    return null
  }
}

/**
 * Start a build job for a collection.
 *
 * The job is registered before the build's first await, so a status poll issued
 * immediately after submission always finds it. If a job is already running for
 * this collection the call is refused rather than queued: the engine allows one
 * writer per directory, so accepting a second would only produce a lock error.
 * @param collectionId - collection identifier.
 * @param logPath - absolute path of the persisted log, or `null`.
 * @param starter - receives the callbacks to wire into the build, and returns the
 *   handle that runs it.
 * @returns `{ started: true }`, or `{ started: false, reason }` when refused.
 */
export function startJob(
  collectionId: string,
  logPath: string | null,
  starter: (hooks: {
    onProgress: (progress: BuildProgress) => void
    onLog: (line: BuildLogLine) => void
  }) => { done: Promise<BuildResult>, cancel: () => void },
): { started: boolean, reason?: string } {
  const existing = jobs.get(collectionId)
  if (existing !== undefined && existing.running) {
    return { started: false, reason: '该知识库已有构建正在进行，请等待它结束或先取消' }
  }

  const job: Job = {
    collectionId,
    progress: { stages: initialStages(), processed: 0, total: 0, fraction: 0 },
    // The previous run's tail is carried forward so a rebuilt page is not blank;
    // the new build's lines append after it.
    log: readPersistedLog(logPath).slice(-MAX_LOG_LINES),
    running: true,
    ok: false,
    error: null,
    chunks: 0,
    startedAt: new Date().toISOString(),
    settledAt: null,
    cancel: () => {},
    logPath,
  }
  jobs.set(collectionId, job)

  /** Append a line to both the in-memory and persisted logs. */
  const pushLog = (line: BuildLogLine): void => {
    job.log.push(line)
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
    persistLog(job.logPath, line)
  }

  const running = starter({
    onProgress: (progress) => { job.progress = progress },
    onLog: pushLog,
  })
  job.cancel = running.cancel

  // Settle the record off the request's stack: nothing awaits this, which is what
  // makes the build independent of whoever started it.
  void running.done.then(
    (result) => {
      job.running = false
      job.ok = result.ok
      job.error = result.ok ? null : translateBuildError(result.error ?? '未知原因')
      job.chunks = result.chunks
      job.settledAt = new Date().toISOString()
      // A settled build's stages must not be left mid-`running`, or a page that
      // polls after completion shows a stage that is still "进行中" forever.
      job.progress = {
        stages: job.progress.stages.map(stage => ({
          ...stage,
          state: result.ok ? 'done' : stage.state === 'running' ? 'pending' : stage.state,
        })),
        processed: result.ok ? result.chunks : job.progress.processed,
        total: result.ok ? result.chunks : job.progress.total,
        fraction: result.ok ? 1 : job.progress.fraction,
      }
    },
    (cause: unknown) => {
      // A rejected `done` is a host bug rather than a build outcome, but leaving
      // the job `running` forever would be worse than reporting it as failed.
      const message = String(cause instanceof Error ? cause.message : cause)
      job.running = false
      job.ok = false
      job.error = translateBuildError(message)
      job.settledAt = new Date().toISOString()
      job.progress = {
        stages: job.progress.stages.map(stage => ({ ...stage, state: stage.state === 'running' ? 'pending' : stage.state })),
        processed: job.progress.processed,
        total: job.progress.total,
        fraction: job.progress.fraction,
      }
    },
  )

  return { started: true }
}

/**
 * Turn an engine-level failure into something a user can act on.
 *
 * `Collection is closed` is the engine's own wording for a pooled handle that a
 * previous aborted build closed. It names nothing the reader can change, so it is
 * replaced with the cause and the next step — the same rule the rest of this
 * plugin follows for negative validation.
 * @param message - the raw failure text.
 * @returns an actionable message.
 */
export function translateBuildError(message: string): string {
  if (/collection is closed/i.test(message)) {
    return '索引句柄已失效（上一次构建被中断所致）。请重新提交构建；若重复出现，请重启 DSH 后重试。'
  }
  if (/can't lock|ZVEC_INTERNAL_ERROR.*lock/i.test(message)) {
    return '索引目录被占用，可能有另一次构建仍在进行。请稍候重试，或重启 DSH 释放句柄。'
  }
  return message
}

/**
 * One collection's job state, for a polling client.
 * @param collectionId - collection identifier.
 * @returns the snapshot, or `null` when no job has run in this process.
 */
export function jobSnapshot(collectionId: string): JobSnapshot | null {
  const job = jobs.get(collectionId)
  if (job === undefined) return null
  return {
    collectionId: job.collectionId,
    running: job.running,
    ok: job.ok,
    stages: job.progress.stages.map(stage => ({ ...stage })),
    processed: job.progress.processed,
    total: job.progress.total,
    fraction: job.progress.fraction,
    log: job.log.map(line => ({ ...line })),
    startedAt: job.startedAt,
    settledAt: job.settledAt,
    error: job.error,
    chunks: job.chunks,
  }
}

/**
 * Cancel a collection's running job.
 * @param collectionId - collection identifier.
 * @returns whether a running job was asked to stop.
 */
export function cancelJob(collectionId: string): boolean {
  const job = jobs.get(collectionId)
  if (job === undefined || !job.running) return false
  job.cancel()
  return true
}

/**
 * Every job currently running, so the overview can show 构建中.
 * @returns collection ids with a running build.
 */
export function runningJobIds(): string[] {
  const ids: string[] = []
  for (const job of jobs.values()) if (job.running) ids.push(job.collectionId)
  return ids
}

/**
 * Drop every job record.
 *
 * Registered as the fiber disposer alongside the handle registry: a hot reload
 * must not leave a job table claiming a build is running when its fiber is gone.
 * @returns number of running jobs that were cancelled.
 */
export function disposeJobs(): number {
  let cancelled = 0
  for (const job of jobs.values()) {
    if (job.running) {
      cancelled += 1
      try {
        job.cancel()
      } catch {
        // A job whose cancel throws is already settled; nothing to stop.
      }
    }
  }
  jobs.clear()
  return cancelled
}
