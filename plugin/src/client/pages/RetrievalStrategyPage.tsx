/**
 * RetrievalStrategyPage — 知识库检索策略（决定 dsh 智能体能召回什么）.
 *
 * ## Why this is its own page, and why it is not the 索引 page
 *
 * The 索引 page owns the **build** strategy: chunking, embedding, index family,
 * quantizer. Every one of those is fixed into the collection's schema when a build
 * publishes, so changing one requires rebuilding — the page is a configurator for a
 * job.
 *
 * This page owns the **retrieval** strategy: the knobs applied at query time when
 * `dsh_kb_search` recovers evidence from an index that already exists. None of them
 * requires a rebuild, and all of them are live on the conversation's very next tool
 * call. That difference is the reason for a separate surface rather than a reason to
 * duplicate the index page: a user who has just rebuilt and still gets poor answers
 * is not looking for a rebuild knob, they are looking for this one.
 *
 * ## The four knobs, and what each costs recall
 *
 * The page is ordered by how directly each one bounds recall, because "召回率不够"
 * has a different fix depending on which limit is actually binding:
 *
 * 1. **分数下限 (minScore)** — a filter. Hits below it are counted but never
 *    returned, so a floor above the corpus's real score distribution silently
 *    empties every answer while the index is perfectly healthy. This is the most
 *    common cause of "检索不到" and the first thing to lower.
 * 2. **候选池 (candidates)** — a hard ceiling on recall. The engine's fusion only
 *    sees this many rows per pass, so a chunk outside the pool cannot be returned no
 *    matter how low the floor goes. It is a ceiling the user cannot see from any
 *    result list, which is exactly why it is on the page rather than a formula
 *    buried in the query path.
 * 3. **检索模式 (mode)** — `hybrid` runs the dense and full-text passes and fuses
 *    them with the engine's RRF; `dense` runs vectors alone. Hybrid is what lets an
 *    exact token match survive a query the embedding model scores poorly, so turning
 *    it off costs recall on proper nouns and rare identifiers specifically.
 * 4. **返回条数 (topk)** — a cap, not a filter. It bounds the answer's size, so too
 *    small a value truncates evidence a multi-part question needs.
 *
 * ## What this page deliberately does not claim
 *
 * Saving here cannot fix a *build* problem. If chunking split an argument across
 * fragments, or the index was never built, raising the pool and lowering the floor
 * will not recover evidence that was never produced — the page says so rather than
 * letting a green "已生效" imply otherwise.
 *
 * @module dsh-zvec-knowledge/client/pages/RetrievalStrategyPage
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Icon } from '../components/Icon.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import type { RetrievalStrategyDraft, RetrievalStrategyView } from '../app.tsx'
import styles from './RetrievalStrategyPage.module.css'

/** Bounds, mirroring the store's own validation so the form refuses before the write. */
export const STRATEGY_BOUNDS = {
  candidates: { min: 20, max: 1000 },
  topk: { min: 1, max: 50 },
} as const

/** The two retrieval modes, with the wording that says what each costs. */
const MODE_OPTIONS: { value: 'hybrid' | 'dense', label: string }[] = [
  { value: 'hybrid', label: '混合（稠密 + 全文）' },
  { value: 'dense', label: '仅稠密向量' },
]

/** Options accepted by {@link RetrievalStrategyPage}. */
export interface RetrievalStrategyPageProps {
  /** Collection being configured, or `null` when none is selected. */
  collectionId: string | null
  /** Human name of the collection, for the page header. */
  collectionName: string | null
  /** Whether the collection has a published snapshot to retrieve from. */
  hasSnapshot: boolean
  /**
   * Read and write the strategy the conversation's `dsh_kb_search` applies.
   *
   * Omitted when the port has no settings channel, in which case the page shows a
   * read-only explanation rather than an editor that cannot save.
   */
  settings?: {
    /** Read the strategy in force, with its source. */
    read: () => Promise<RetrievalStrategyView>
    /** Store a strategy, making it the tool's from its next call. */
    save: (retrieval: RetrievalStrategyDraft) => Promise<RetrievalStrategyView & { source: 'collection' }>
  }
}

/**
 * Render the retrieval-strategy editor.
 * @param props - collection, snapshot state and the settings channel.
 * @returns the page.
 */
export function RetrievalStrategyPage({
  collectionId, collectionName, hasSnapshot, settings,
}: RetrievalStrategyPageProps): React.JSX.Element {
  // The strategy in force, as the host reports it. `null` until loaded, so the form
  // never renders defaults that are not the deployment's real ones.
  const [effective, setEffective] = useState<RetrievalStrategyView | null>(null)
  const [draft, setDraft] = useState<RetrievalStrategyDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  // Load the strategy when the collection changes, and seed the draft from it.
  // Re-read after a save so `source` reflects the stored state rather than the state
  // the form happened to be in when it asked.
  useEffect(() => {
    const read = settings?.read
    if (read === undefined || collectionId === null) {
      setEffective(null)
      setDraft(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setSavedNotice(null)
    void (async () => {
      try {
        const next = await read()
        if (cancelled) return
        setEffective(next)
        setDraft({
          minScore: next.minScore,
          topk: next.topk,
          candidates: next.candidates,
          mode: next.mode,
        })
      } catch (cause) {
        // Surfaced verbatim: §8.1's error-state rule forbids showing only a code.
        if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [settings, collectionId])

  /** Patch one field of the draft. */
  const patch = useCallback((next: Partial<RetrievalStrategyDraft>): void => {
    setDraft(current => (current === null ? current : { ...current, ...next }))
    // Typing is a statement of intent to save, so a stale "已生效" from a previous
    // save must stop being visible the moment the form no longer matches it.
    setSavedNotice(null)
  }, [])

  /** Store the draft as the collection's strategy. */
  const save = async (): Promise<void> => {
    const write = settings?.save
    if (write === undefined || collectionId === null || draft === null) return
    setSaving(true)
    setError(null)
    setSavedNotice(null)
    try {
      const stored = await write(draft)
      setEffective(stored)
      setDraft({
        minScore: stored.minScore,
        topk: stored.topk,
        candidates: stored.candidates,
        mode: stored.mode,
      })
      // Stated rather than implied: the point of the control is that it changes what
      // the conversation does, and naming all four makes the claim falsifiable.
      setSavedNotice(
        `已生效：会话中的 dsh_kb_search 现在按「下限 ${stored.minScore.toFixed(2)}、`
        + `候选池 ${stored.candidates}、${stored.mode === 'hybrid' ? '混合' : '仅稠密'}、`
        + `最多 ${stored.topk} 条」召回。`,
      )
    } catch (cause) {
      // The store's validation message names the accepted range, so it is shown
      // as-is rather than replaced with a generic failure.
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setSaving(false)
    }
  }

  if (collectionId === null) {
    return (
      <EmptyState
        icon="database"
        title="尚未选择知识库"
        description="请先在「总览」中选择一个知识库，再配置它的检索策略。"
      />
    )
  }

  // A collection without a snapshot has nothing to retrieve from, so the knobs
  // would describe a search that cannot run. Guided to the index page instead.
  if (!hasSnapshot) {
    return (
      <EmptyState
        icon="layers"
        title="还没有可检索的索引"
        description="检索策略决定「怎么召回」，但检索的前提是先有一个已构建的索引。请先在「索引」中构建，再回来调优召回。"
      />
    )
  }

  const clean = settings !== undefined

  // Unsaved changes are computed rather than tracked, so the button's state cannot
  // drift from the form after a patch or a reload.
  const dirty = draft !== null && effective !== null
    && (draft.minScore !== effective.minScore || draft.topk !== effective.topk
      || draft.candidates !== effective.candidates || draft.mode !== effective.mode)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.title}>检索策略</h3>
          <p className={styles.description}>
            {collectionName === null ? '' : `「${collectionName}」的检索策略`}
            ——决定会话中的 <code className={styles.code}>dsh_kb_search</code> 如何从这个索引里召回依据。
            全部为查询时生效，<strong>保存后无需重建</strong>，下一次工具调用即采用。
          </p>
        </div>
        {effective !== null && (
          <StatusPill
            status={effective.source === 'collection' ? 'ready' : 'info'}
            label={effective.source === 'collection' ? '本库自有策略' : '部署默认值'}
          />
        )}
      </header>

      {!clean && (
        <p className={styles.notice} role="status">
          <Icon name="info" size={14} />
          宿主未提供检索策略通道，本页只做说明，无法在此保存。
        </p>
      )}

      {error !== null && (
        <p className={styles.error} role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}

      {draft !== null && (
        <>
          <section className={styles.card} aria-label="召回范围">
            <div className={styles.cardHead}>
              <h4 className={styles.cardTitle}>召回范围</h4>
              <p className={styles.cardHint}>
                下面两项决定「能找到多少」——是召回率不足时首先要看的地方。
              </p>
            </div>

            <div className={styles.grid}>
              {/* 1. The floor. Ordered first because it is the most common cause of
                  an empty answer on a healthy index. */}
              <NumberField
                label="分数下限（minScore）"
                value={draft.minScore}
                onChange={value => { patch({ minScore: value }) }}
                min={0}
                max={1}
                step={0.05}
                hint="低于此分数的命中不会返回给会话。设为 0 可关闭过滤"
                disabled={!clean}
              />

              {/* 2. The candidate pool — the invisible recall ceiling. */}
              <NumberField
                label="候选池（candidates）"
                value={draft.candidates}
                onChange={value => { patch({ candidates: value }) }}
                min={STRATEGY_BOUNDS.candidates.min}
                max={STRATEGY_BOUNDS.candidates.max}
                step={20}
                hint={`每路检索在融合前取多少个候选。小于 ${STRATEGY_BOUNDS.candidates.min} 会硬性限制召回，无论下限多低`}
                disabled={!clean}
              />
            </div>

            {/* The floor's own failure mode, stated where it is being set. A floor
                above the corpus's distribution returns nothing while the index is
                fine, and that is indistinguishable from a broken index unless the
                page says so. */}
            <p className={styles.tip}>
              <Icon name="info" size={14} />
              若检索结果常年为空，先把下限调到 <span className="kb-mono">0</span> 看真实分数分布，
              再定一个低于多数真实命中的值；默认的 0.55 只是初始值，需按语料回归。
            </p>
          </section>

          <section className={styles.card} aria-label="召回方式与条数">
            <div className={styles.cardHead}>
              <h4 className={styles.cardTitle}>召回方式与条数</h4>
              <p className={styles.cardHint}>
                决定「用哪几路召回」以及「一次给会话多少条」。
              </p>
            </div>

            <div className={styles.row}>
              <span className={styles.fieldLabel}>检索模式</span>
              <SegmentedControl
                label="检索模式"
                options={MODE_OPTIONS}
                value={draft.mode}
                onChange={value => { patch({ mode: value }) }}
                disabled={!clean}
              />
            </div>

            <p className={styles.tip}>
              <Icon name="info" size={14} />
              混合模式用引擎自带的 RRF 融合稠密与全文两路。专有名词、代号、生僻术语在仅稠密模式下
              容易漏召——全文那一路正是为它们准备的。
            </p>

            <div className={styles.grid}>
              <NumberField
                label="返回条数（topk）"
                value={draft.topk}
                onChange={value => { patch({ topk: value }) }}
                min={STRATEGY_BOUNDS.topk.min}
                max={STRATEGY_BOUNDS.topk.max}
                hint="工具未显式指定 topk 时返回的条数。属上限，不参与过滤"
                disabled={!clean}
              />
            </div>
          </section>

          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={() => { void save() }}
              loading={saving}
              loadingLabel="保存中…"
              disabled={!clean || !dirty}
              icon="check"
            >
              保存并生效
            </Button>
            {savedNotice !== null && (
              <span className={styles.saved} role="status">{savedNotice}</span>
            )}
            {dirty && savedNotice === null && (
              <span className={styles.dirtyHint}>有未保存的修改</span>
            )}
          </div>

          {/* The boundary this page cannot cross. Stated because a green "已生效"
              would otherwise imply the retrieval problem is solved, when a build
              problem is not fixable here at all. */}
          <p className={styles.scope}>
            <Icon name="info" size={14} />
            本页只调<b>查询时</b>的策略，不改变索引内容。若分片本身切断了语义、或文档尚未构建，
            需要到「索引」页调整切分策略并重建——调低下限和扩大候选池都无法召回从未被切分出来的内容。
          </p>
        </>
      )}

      {loading && draft === null && (
        <p className={styles.notice} aria-busy="true">
          <Icon name="info" size={14} /> 正在读取检索策略…
        </p>
      )}
    </div>
  )
}
