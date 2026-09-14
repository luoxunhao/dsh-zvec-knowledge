/**
 * BuildPipeline — the four-stage index build (§5.3).
 *
 * The spec's constraint is stated as a prohibition — "禁止只显示无文字的进度条",
 * a progress bar with no text is a violation — which is why every stage carries
 * **both** a node state and its name, and why the overall progress states "已处理
 * 数量 / 总量" alongside a percentage. A bar alone cannot tell a user whether the
 * build is embedding or publishing, and those two have very different wait times.
 *
 * The log is collapsed by default and uses monospaced, timestamp-ordered lines
 * whose colour carries the same meaning as the stage nodes.
 *
 * The rebuild notice is the other half of §5.3's requirement: retrieval keeps
 * answering from the previous snapshot while a build runs, and the interface must
 * say so, or a user comparing results mid-rebuild would conclude the data is
 * inconsistent.
 *
 * @module dsh-zvec-knowledge/client/components/BuildPipeline
 */

import { ProgressBar } from './ProgressBar.tsx'
import { Icon } from './Icon.tsx'
import { Button } from './Button.tsx'
import styles from './BuildPipeline.module.css'

/** Pipeline stage identifiers, in spec order. */
export type StageId = 'parse' | 'chunk' | 'index' | 'publish'

/** Node state of one stage. */
export type StageState = 'pending' | 'running' | 'done'

/** One stage as the interface renders it. */
export interface StageView {
  /** Stage identifier. */
  id: StageId
  /** Display name. Required: the spec forbids a nameless stage. */
  label: string
  /** Current node state. */
  state: StageState
}

/** One log line. */
export interface LogLine {
  /** ISO-8601 timestamp. */
  at: string
  /** Severity, mapped to the spec's colour semantics. */
  level: 'success' | 'running' | 'info' | 'error'
  /** Message text. */
  message: string
}

/** Options accepted by {@link BuildPipeline}. */
export interface BuildPipelineProps {
  /** Stages in pipeline order. */
  stages: StageView[]
  /** Items finished. */
  processed: number
  /** Total items. */
  total: number
  /** Fraction in [0, 1]. */
  fraction: number
  /** Log lines, oldest first. */
  log: LogLine[]
  /** Whether the log is expanded. */
  logOpen: boolean
  /** Toggle the log. */
  onLogToggle: (open: boolean) => void
  /** Whether a build is running. */
  running: boolean
  /** Called to cancel a running build. */
  onCancel: () => void
  /** Called to retry after a failure. */
  onRetry?: () => void
  /** Failure reason, when the build failed. */
  error?: string | null
  /** Whether retrieval is currently serving a previous snapshot. */
  servingPreviousSnapshot: boolean
}

/** Glyph for a stage's node state. */
const STAGE_GLYPH: Record<StageState, string> = { pending: '○', running: '◐', done: '●' }

/**
 * Format a log timestamp for display.
 * @param iso - ISO-8601 timestamp.
 * @returns `HH:MM:SS`, or the raw value when unparseable.
 */
export function formatLogTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().slice(11, 19)
}

/**
 * Render the build pipeline.
 * @param props - stages, progress, log and controls.
 * @returns the pipeline panel.
 */
export function BuildPipeline({
  stages, processed, total, fraction, log, logOpen, onLogToggle,
  running, onCancel, onRetry, error = null, servingPreviousSnapshot,
}: BuildPipelineProps): React.JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
  return (
    <section className={styles.panel} aria-label="索引构建流水线">
      {servingPreviousSnapshot && running && (
        // §5.3: the behaviour must be stated, not merely implemented, or a user
        // who sees old results mid-rebuild reads it as data corruption.
        <p className={styles.notice} role="status">
          <Icon name="info" size={14} />
          重建进行中：检索工具与问答仍返回上一次索引快照，构建完成后自动切换到新索引。
        </p>
      )}

      <ol className={styles.stages}>
        {stages.map(stage => (
          <li
            key={stage.id}
            className={`${styles.stage} ${styles[`stage_${stage.state}`] ?? ''}`.trim()}
            data-state={stage.state}
          >
            {/* Node state and the stage name are both mandatory (§5.3). */}
            <span className={styles.stageGlyph} aria-hidden="true">{STAGE_GLYPH[stage.state]}</span>
            <span className={styles.stageLabel}>{stage.label}</span>
            <span className={styles.stageState}>
              {stage.state === 'done' ? '已完成' : stage.state === 'running' ? '进行中' : '未开始'}
            </span>
          </li>
        ))}
      </ol>

      <div className={styles.progress}>
        <div className={styles.progressHead}>
          <span className={styles.progressLabel}>整体进度</span>
          {/* Both the counts and the percentage, per §5.3. */}
          <span className={`kb-mono ${styles.progressCounts}`}>
            {processed} / {total} · {percent}%
          </span>
        </div>
        <ProgressBar
          value={fraction}
          label="索引构建整体进度"
          tone={error !== null ? 'danger' : 'brand'}
        />
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          <Icon name="alert" size={14} /> 构建失败：{error}
        </p>
      )}

      <div className={styles.actions}>
        {running ? (
          <Button variant="secondary" size="sm" icon="stop" onClick={onCancel}>取消构建</Button>
        ) : error !== null && onRetry !== undefined ? (
          <Button variant="secondary" size="sm" icon="retry" onClick={onRetry}>重试构建</Button>
        ) : null}
        <button
          type="button"
          className={styles.logToggle}
          aria-expanded={logOpen}
          onClick={() => onLogToggle(!logOpen)}
        >
          <Icon name="chevron-down" size={14} />
          {logOpen ? '收起构建日志' : `展开构建日志（${log.length}）`}
        </button>
      </div>

      {logOpen && (
        <ul className={styles.log} aria-label="构建日志">
          {log.length === 0 ? (
            <li className={styles.logEmpty}>暂无日志</li>
          ) : (
            log.map((line, index) => (
              <li key={`${line.at}-${index}`} className={`${styles.logLine} ${styles[`log_${line.level}`] ?? ''}`.trim()}>
                <span className={`kb-mono ${styles.logTime}`}>{formatLogTime(line.at)}</span>
                <span className={styles.logMessage}>{line.message}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  )
}
