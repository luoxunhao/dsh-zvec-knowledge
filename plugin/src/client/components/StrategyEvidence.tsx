/**
 * StrategyEvidence — proof that the configured chunking strategy is the one running.
 *
 * ## What this replaced, and why
 *
 * The configurator used to show a "分片预览". It chunked the **entire corpus** to
 * render eight rows truncated to 80 characters plus four totals (总片数 / 平均
 * token / 丢弃碎片 / 总 token), and recomputed on every parameter change with no
 * debounce. Two independent problems:
 *
 * **It was the wrong cost for the wrong question.** Linear in corpus size —
 * measured at 55 ms for 20 documents, 1.4 s at 500, 5.5 s at 2000 — paid
 * repeatedly while editing, in order to display a number ("how many chunks does my
 * library produce") that a user does not decide anything with.
 *
 * **It could not verify a policy.** A row was `text.slice(0, 80)` with newlines
 * collapsed, which cannot show whether a heading boundary was honoured, whether a
 * fenced block stayed whole, whether a table was split by row, or what text the
 * overlap actually shares. Those are the things the strategy *claims*, and the
 * only way to check a claim is to show the evidence for it.
 *
 * ## What this shows instead
 *
 * One document — the longest, because that is where boundaries, fences and tables
 * actually break — and then, per configured setting, what was observed. The cost
 * is constant: 20 documents and 20 000 cost the same.
 *
 * The distinction the panel is built around: a check that is **not applicable** to
 * the sampled document (no code block, no table) must say so rather than pass, and
 * a check whose content **existed but did not survive** the minimum-size floor must
 * say that rather than pass. Both are false reassurance otherwise, which is
 * precisely what a verification surface must not produce.
 *
 * @module dsh-zvec-knowledge/client/components/StrategyEvidence
 */

import { Icon } from './Icon.tsx'
import type { StrategyEvidenceView } from '../app.tsx'
import styles from './StrategyEvidence.module.css'

/** Options accepted by {@link StrategyEvidence}. */
export interface StrategyEvidenceProps {
  /**
   * The evidence report, or `null` while it is being computed.
   *
   * Optional as well as nullable: a harness that renders this panel without
   * supplying data is a legitimate caller (the component's own suite does), and
   * treating "no data yet" as absent rather than crashing makes the loading state
   * the default rather than an edge case.
   */
  evidence?: StrategyEvidenceView | null
  /** Reason the evidence is unavailable, e.g. an invalid configuration. */
  error?: string | null
}

/**
 * A check's verdict, as a word plus a tone.
 *
 * Never colour alone: the three states are distinguished by their label, and the
 * class only carries the tone. A green dot with no word would be unreadable to
 * anyone who cannot see it, and ambiguous to anyone who can.
 * @param check - the check.
 * @returns the label and the style key.
 */
function verdictOf(check: StrategyEvidenceView['checks'][number]): { label: string, tone: string } {
  if (!check.applicable) return { label: '本文档未涉及', tone: 'na' }
  if (check.satisfied) return { label: '已生效', tone: 'ok' }
  return { label: '未生效', tone: 'bad' }
}

/**
 * Render the strategy evidence.
 * @param props - the report and its error state.
 * @returns the panel.
 */
export function StrategyEvidence({ evidence = null, error = null }: StrategyEvidenceProps): React.JSX.Element {
  return (
    <section className={styles.panel} aria-label="切块策略验证">
      <header className={styles.head}>
        <h4 className={styles.title}>切块策略验证</h4>
        {/* The cost claim is stated because it is the reason this replaced the
            preview: the reader should know the check does not scale with the
            library. */}
        <span className={styles.note}>
          只切最长的一篇，代价与文档总数无关
        </span>
      </header>

      {error !== null ? (
        <p className={styles.error} role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      ) : evidence === null ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="正在验证切块策略" />
      ) : !evidence.available ? (
        <p className={styles.empty}>该知识库还没有文档，无法验证切块策略。</p>
      ) : (
        <>
          <p className={styles.sample}>
            <Icon name="file" size={14} />
            样本：<span className={styles.sampleName}>{evidence.document.name}</span>
            <span className={`kb-mono ${styles.sampleMeta}`}>
              {evidence.document.chars.toLocaleString()} 字符 → {evidence.document.chunks} 片
            </span>
            <span className={styles.sampleNote}>{evidence.sampledBecause}</span>
          </p>

          {/* The checks come first: they are the answer to "did my strategy take
              effect", and the boundary detail below is the supporting evidence. */}
          <ul className={styles.checks}>
            {evidence.checks.map(check => {
              const verdict = verdictOf(check)
              return (
                <li key={check.setting} className={styles.check} data-tone={verdict.tone}>
                  <span className={styles.checkSetting}>{check.setting}</span>
                  <span className={`kb-mono ${styles.checkValue}`}>{check.value}</span>
                  <span className={styles.checkVerdict}>{verdict.label}</span>
                  <span className={styles.checkObserved}>{check.observed}</span>
                </li>
              )
            })}
          </ul>

          {evidence.discarded.length > 0 && (
            <details className={styles.section}>
              <summary className={styles.summary}>
                被最小分片丢弃的内容（{evidence.discarded.length} 段）
              </summary>
              {/* The dropped text itself: "丢弃 3 段" is unactionable, whereas
                  seeing whether it is a stray heading or a real paragraph is the
                  whole judgement. */}
              <ul className={styles.discarded}>
                {evidence.discarded.map((item, index) => (
                  <li key={index} className={styles.discardedItem}>
                    <span className={`kb-mono ${styles.discardedTokens}`}>{item.tokens} tok</span>
                    <pre className={styles.pre}>{item.text}</pre>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details className={styles.section} open>
            <summary className={styles.summary}>
              分片边界（前 {evidence.chunks.length} 片）
            </summary>
            <ul className={styles.chunks}>
              {evidence.chunks.map(chunk => (
                <li key={chunk.ordinal} className={styles.chunk}>
                  <div className={styles.chunkHead}>
                    <span className={`kb-mono ${styles.chunkOrdinal}`}>#{chunk.ordinal}</span>
                    <span className={`kb-mono ${styles.chunkTokens}`}>{chunk.tokens} tok</span>
                    <span className={`kb-mono ${styles.chunkRange}`}>{chunk.charStart}–{chunk.charEnd}</span>
                    {chunk.heading !== null && (
                      <span className={styles.chunkHeading}>{chunk.heading}</span>
                    )}
                    {/* Flags state what the boundary actually did, which is the
                        evidence a heading/code/table setting needs. */}
                    <span className={styles.flags}>
                      {chunk.startsAtHeading && <span className={styles.flag}>标题边界</span>}
                      {chunk.startsInsideCodeFence && <span className={styles.flagBad}>代码块中途</span>}
                      {chunk.hasCodeFence && !chunk.startsInsideCodeFence && <span className={styles.flag}>含代码块</span>}
                      {chunk.hasTableRow && <span className={styles.flag}>含表格行</span>}
                    </span>
                  </div>
                  <pre className={styles.pre}>{chunk.head}{chunk.head.length >= 120 ? '…' : ''}</pre>
                  {chunk.overlapText !== null && (
                    <div className={styles.overlap}>
                      <span className={styles.overlapLabel}>与上一片重叠 {chunk.overlapTokens} tok</span>
                      <pre className={`${styles.pre} ${styles.overlapText}`}>{chunk.overlapText}</pre>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </details>

          <p className={styles.cost}>
            验证耗时 {evidence.elapsedMs.toFixed(1)} ms（只切了 1 篇）
          </p>
        </>
      )}
    </section>
  )
}
