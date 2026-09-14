/**
 * QuotaNotice — the restricted state (design spec §8.2).
 *
 * The spec's requirement for this state is specific and easy to get wrong: it must
 * name **the source of the limit** and **the path to lifting it**. "存储空间不足"
 * states neither — the user cannot tell whether they are out of disk, out of
 * quota, or misconfigured, and has no next step.
 *
 * So the notice always carries three things: what was blocked, the numbers that
 * blocked it, and what can be done. The numbers come from the host's own
 * measurement rather than being recomputed here, so the meter and the refusal
 * cannot disagree — which would read as a quota that fires arbitrarily.
 *
 * @module dsh-zvec-knowledge/client/components/QuotaNotice
 */

import { ProgressBar } from './ProgressBar.tsx'
import { Icon } from './Icon.tsx'
import styles from './QuotaNotice.module.css'

/** Store quota state, as the host reports it. */
export interface QuotaStateView {
  /** Bytes used. */
  used: number
  /** Configured limit, or `null` when unlimited. */
  limit: number | null
  /** Used fraction, or `null` when unlimited. */
  fraction: number | null
  /** Whether the warning threshold has been crossed. */
  nearLimit: boolean
  /** Whether the limit has been reached. */
  exceeded: boolean
}

/** Options accepted by {@link QuotaNotice}. */
export interface QuotaNoticeProps {
  /** Current quota state. */
  state: QuotaStateView
  /** What was blocked, when something was. Omit for the advisory form. */
  blocked?: string | null
  /** Extra recovery advice from the host, e.g. the shortfall in bytes. */
  detail?: string | null
}

/**
 * Format a byte count.
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

/**
 * Render the quota state.
 *
 * Returns `null` when there is no quota configured and nothing was blocked: an
 * unlimited store has nothing to say, and a permanent "no limit" banner would be
 * noise on every page.
 * @param props - quota state and optional block context.
 * @returns the notice, or nothing.
 */
export function QuotaNotice({ state, blocked = null, detail = null }: QuotaNoticeProps): React.JSX.Element | null {
  if (state.limit === null && blocked === null) return null
  // `blocked` is what makes this an alert even when the store is still *under*
  // its limit: a refused write is refused because it would have crossed the line,
  // so the store sits just below it while the user is genuinely blocked. Keying
  // the severity on `exceeded` alone would show a calm advisory at exactly the
  // moment an action was stopped.
  const exceeded = state.exceeded || blocked !== null

  return (
    <div
      className={`${styles.notice} ${exceeded ? styles.exceeded : ''}`.trim()}
      role={exceeded ? 'alert' : 'status'}
    >
      <p className={styles.head}>
        <Icon name={exceeded ? 'alert' : 'info'} size={14} />
        {/* The wording names the limit's source, not just its existence. */}
        {exceeded ? '存储配额不足，操作已停止' : '存储用量接近配额上限'}
      </p>

      {blocked !== null && <p className={styles.blocked}>{blocked}</p>}
      {detail !== null && <p className={styles.detail}>{detail}</p>}

      {state.limit !== null && (
        <>
          <div className={styles.meter}>
            <ProgressBar
              value={state.fraction ?? 0}
              label={`存储配额占用 ${Math.round((state.fraction ?? 0) * 100)}%`}
              tone={exceeded ? 'danger' : 'warning'}
            />
          </div>
          <p className={`kb-mono ${styles.figures}`}>
            {formatBytes(state.used)} / {formatBytes(state.limit)}
            {state.fraction !== null && ` · ${Math.round(state.fraction * 100)}%`}
          </p>
        </>
      )}

      {/* The解除路径: what the user can actually do, stated rather than implied. */}
      <p className={styles.remedy}>
        解除方式：删除不再需要的文档或知识库以释放空间；若配额数值不合理，由部署方调整
        <code className={styles.code}>quota.bytes</code>。
      </p>
    </div>
  )
}
