/**
 * RetrievalPage — the diagnostic console (design spec §6.4, restored deliberately).
 *
 * ## Why this exists, and why it is not the Q&A page
 *
 * KB-09 moved RAG answering into the dsh conversation and the plugin's Q&A panel
 * was removed with it. This page is a different thing: it validates the plugin's
 * **own artifacts** — whether chunking produced sensible units, and whether vector
 * recall actually works — and it deliberately generates no answer.
 *
 * The conversation's tool-call block cannot cover this. It renders what one query
 * happened to match, so it cannot show whether a chunk boundary is wrong, whether
 * the same topic was scattered across fragments, or whether a miss was the index's
 * fault or the score floor's. KB-09's own closing note anticipated exactly this:
 * if "cannot verify retrieval quality after a rebuild" turns out to matter in real
 * use, the gap has to be closed. This is that closure.
 *
 * ## The three things it makes visible that nothing else does
 *
 * 1. **`below_floor`.** The tool applies its threshold silently, so a filtered hit
 *    is indistinguishable from an absent one there. Here the floor is a control,
 *    and lowering it to 0 shows what the index actually ranked.
 * 2. **Full chunk text.** The build preview shows an 80-character snippet, which is
 *    enough to judge parameters but not enough to judge a *chunk*. The full text is
 *    what reveals a boundary cut mid-argument.
 * 3. **Which snapshot answered.** Slot, chunk count and build time are reported, so
 *    a result can be attributed to one build instead of "whatever was live".
 *
 * @module dsh-zvec-knowledge/client/pages/RetrievalPage
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Icon } from '../components/Icon.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { Switch } from '../components/Switch.tsx'
import { TextField } from '../components/TextField.tsx'
import type { RetrievalView } from '../app.tsx'
import styles from './RetrievalPage.module.css'

/** Score bands, with the wording the spec assigns them. */
const BAND_LABELS: Record<RetrievalView['hits'][number]['band'], string> = {
  strong: '强相关',
  relevant: '相关',
  fair: '一般',
  low: '弱',
}

/**
 * Band to a status token, so the marker carries colour *and* wording.
 *
 * The spec's rule is that a state may never be conveyed by colour alone, which is
 * why every hit renders its band as text and uses the pill for the tone rather
 * than instead of the label.
 * @param band - the confidence band.
 * @returns the status kind to render.
 */
function bandStatus(band: RetrievalView['hits'][number]['band']): 'ready' | 'building' | 'pending' | 'failed' {
  switch (band) {
    case 'strong': return 'ready'
    case 'relevant': return 'building'
    case 'fair': return 'pending'
    case 'low': return 'failed'
  }
}

/** Options accepted by {@link RetrievalPage}. */
export interface RetrievalPageProps {
  /** Collection to search, or `null` when none is selected. */
  collectionId: string | null
  /** Whether the collection has a published snapshot to search. */
  hasSnapshot: boolean
  /** Retrieval transport; omit to render the page read-only. */
  transport?: {
    /**
     * Run one diagnostic retrieval.
     * @param query - query text.
     * @param options - topk, floor and dense-only.
     * @returns the result.
     */
    run: (query: string, options: { topk: number, minScore: number, denseOnly: boolean }) => Promise<RetrievalView>
  }
  /**
   * Read and write the settings the conversation's `dsh_kb_search` tool applies.
   *
   * Omitted when the port has no settings channel, in which case the card shows
   * nothing rather than an editor that cannot save.
   */
  settings?: {
    /** Read the settings in force, with their source. */
    read: () => Promise<{ minScore: number, topk: number, source: 'collection' | 'deployment' }>
    /** Store new settings, making them the tool's from its next call. */
    save: (retrieval: { minScore: number, topk: number }) => Promise<{ minScore: number, topk: number, source: 'collection' }>
  }
}

/**
 * Render the retrieval console.
 * @param props - collection, snapshot state and transport.
 * @returns the page.
 */
export function RetrievalPage({
  collectionId, hasSnapshot, transport, settings,
}: RetrievalPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Defaults chosen for validation rather than for answering: a floor of 0 shows
  // everything the index ranked, which is what makes "did it recall this?" and
  // "did the threshold hide it?" separable. The conversation keeps the real floor.
  const [topk, setTopk] = useState(8)
  const [minScore, setMinScore] = useState(0)
  const [denseOnly, setDenseOnly] = useState(false)
  const [result, setResult] = useState<RetrievalView | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The settings the tool actually applies. Loaded from the host, editable here,
  // and saved back so tuning the console tunes the conversation too.
  const [effective, setEffective] = useState<{ minScore: number, topk: number, source: 'collection' | 'deployment' } | null>(null)
  const [draftFloor, setDraftFloor] = useState<number | null>(null)
  const [draftTopk, setDraftTopk] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  // Load the effective settings when the collection changes, and seed the draft
  // from them. Re-read after a save so `source` reflects the stored state.
  useEffect(() => {
    const read = settings?.read
    if (read === undefined || collectionId === null) {
      setEffective(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const next = await read()
        if (cancelled) return
        setEffective(next)
        setDraftFloor(next.minScore)
        setDraftTopk(next.topk)
      } catch (cause) {
        if (!cancelled) setSettingsError(String(cause instanceof Error ? cause.message : cause))
      }
    })()
    return () => { cancelled = true }
  }, [settings, collectionId])

  /** Store the draft as the collection's settings. */
  const saveSettings = async (): Promise<void> => {
    const save = settings?.save
    if (save === undefined || collectionId === null || draftFloor === null || draftTopk === null) return
    setSaving(true)
    setSettingsError(null)
    setSavedNotice(null)
    try {
      const stored = await save({ minScore: draftFloor, topk: draftTopk })
      setEffective(stored)
      // Stated rather than implied: the point of the control is that this changes
      // what the conversation's tool does, and saying so closes the loop.
      setSavedNotice(`已生效：会话中的 dsh_kb_search 现在使用下限 ${stored.minScore.toFixed(2)}。`)
    } catch (cause) {
      // The store's validation message names the range, so it is shown as-is.
      setSettingsError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setSaving(false)
    }
  }

  /** Run the query. */
  const run = useCallback(async (): Promise<void> => {
    if (transport === undefined) return
    if (query.trim() === '') {
      setError('请输入查询内容')
      return
    }
    setRunning(true)
    setError(null)
    try {
      setResult(await transport.run(query, { topk, minScore, denseOnly }))
    } catch (cause) {
      // The reason is surfaced verbatim (§8.1 forbids showing only a code); a
      // failed embedding call and a failed search need different fixes.
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setRunning(false)
    }
  }, [transport, query, topk, minScore, denseOnly])

  if (collectionId === null) {
    return (
      <EmptyState
        icon="database"
        title="尚未选择知识库"
        description="请先在「总览」中选择一个知识库，再验证它的检索效果。"
      />
    )
  }

  // A collection with no published snapshot has nothing to query, and saying so is
  // more useful than an empty result list that looks like a recall failure.
  if (!hasSnapshot) {
    return (
      <EmptyState
        icon="layers"
        title="还没有可检索的索引"
        description="该知识库尚未成功构建。请先在「索引」中构建，再用这里验证分片与召回效果。"
      />
    )
  }

  const totalMs = result === null ? 0 : result.embeddedMs + result.searchedMs

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.title}>检索验证</h3>
          <p className={styles.description}>
            用真实查询验证分片质量与向量召回能力。此页只做诊断，不生成回答——问答请在 dsh 会话中直接提问。
          </p>
        </div>
      </header>

      <div className={styles.columns}>
        {/* Left column (§6.4): the query card — parameters, input and the run
            action. Kept narrow so the hit list gets the room it needs. */}
        <div className={styles.column}>
          {settings !== undefined && effective !== null && (
            <section className={styles.controls} aria-label="会话检索设置">
              <h4 className={styles.sectionTitle}>会话检索设置</h4>
              <p className={styles.settingsHint}>
                {effective.source === 'collection'
                  ? '以下是本知识库的检索设置，会话中的 dsh_kb_search 按此过滤命中。'
                  : '本知识库尚未单独设置，以下为部署默认值。修改后会保存为本知识库自己的设置。'}
              </p>
              <div className={styles.grid}>
                <NumberField
                  label="会话分数下限（minScore）"
                  value={draftFloor ?? effective.minScore}
                  onChange={setDraftFloor}
                  min={0}
                  max={1}
                  step={0.05}
                  hint="低于此分数的命中不会返回给会话"
                />
                <NumberField
                  label="会话返回条数（topk）"
                  value={draftTopk ?? effective.topk}
                  onChange={setDraftTopk}
                  min={1}
                  max={50}
                  hint="工具每次默认返回的命中数上限"
                />
              </div>
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  onClick={() => { void saveSettings() }}
                  loading={saving}
                  loadingLabel="保存中…"
                  disabled={draftFloor === effective.minScore && draftTopk === effective.topk}
                >
                  保存并生效
                </Button>
                {savedNotice !== null && <span className={styles.timing}>{savedNotice}</span>}
              </div>
              {settingsError !== null && (
                <p className={styles.error} role="alert">
                  <Icon name="alert" size={14} /> {settingsError}
                </p>
              )}
            </section>
          )}

          <section className={styles.controls} aria-label="查询参数">
            <TextField
              label="查询内容"
              value={query}
              onChange={setQuery}
              placeholder="输入一个你确信文档里有的问题"
              hint="用文档中真实存在的说法更容易判断召回是否正常"
            />
            <div className={styles.grid}>
              <NumberField
                label="返回条数（topk）"
                value={topk}
                onChange={setTopk}
                min={1}
                max={50}
                hint="超过上限按 50 处理"
              />
              <NumberField
                label="分数下限（minScore）"
                value={minScore}
                onChange={setMinScore}
                min={0}
                max={1}
                step={0.05}
                hint="设为 0 可看到全部命中，用于判断是索引没召回还是阈值吃掉了"
              />
            </div>
            <Switch
              label="仅稠密向量检索"
              description="开启后跳过全文检索，用于区分两路召回的贡献"
              checked={denseOnly}
              onChange={setDenseOnly}
            />
            <div className={styles.actions}>
              <Button variant="primary" icon="search" onClick={() => { void run() }} loading={running} loadingLabel="检索中…">
                运行检索
              </Button>
              {result !== null && !running && (
                <span className={`kb-mono ${styles.timing}`}>
                  耗时 {totalMs.toFixed(0)} ms（嵌入 {result.embeddedMs.toFixed(0)} + 检索 {result.searchedMs.toFixed(0)}）
                </span>
              )}
            </div>
          </section>
        </div>

        {/* Right column: the health summary and the hits. The summary precedes the
            list because "命中 / 被过滤" is what makes a short list interpretable. */}
        <div className={styles.column}>
          {error !== null && (
            <p className={styles.error} role="alert">
              <Icon name="alert" size={14} /> {error}
            </p>
          )}

          {result !== null && (
            <>
              {/* The health summary is the part that answers "is recall working?" at
                  a glance: a hit count alone cannot, because a filtered hit and a
                  missing one look identical without `below_floor`. */}
              <section className={styles.health} aria-label="召回健康度">
                <dl className={styles.healthGrid}>
                  <div className={styles.healthItem}>
                    <dt className={styles.healthLabel}>命中</dt>
                    <dd className={`kb-mono ${styles.healthValue}`}>{result.hits.length}</dd>
                  </div>
                  <div className={styles.healthItem}>
                    <dt className={styles.healthLabel}>低于阈值被过滤</dt>
                    <dd className={`kb-mono ${styles.healthValue}`}>{result.belowFloor}</dd>
                  </div>
                  <div className={styles.healthItem}>
                    <dt className={styles.healthLabel}>检索模式</dt>
                    <dd className={`kb-mono ${styles.healthValue}`}>{result.mode === 'hybrid' ? '混合' : '仅稠密'}</dd>
                  </div>
                  <div className={styles.healthItem}>
                    <dt className={styles.healthLabel}>快照</dt>
                    <dd className={`kb-mono ${styles.healthValue}`}>{result.activeSlot ?? '—'} · {result.chunks} 片</dd>
                  </div>
                </dl>
                {result.hits.length === 0 && (
                  <p className={styles.hint}>
                    <Icon name="info" size={14} />
                    {result.belowFloor > 0
                      ? `有 ${result.belowFloor} 条命中被分数下限过滤。把下限调为 0 可以看到它们的实际分数。`
                      : '索引没有召回任何内容。请确认文档已构建，或换用文档中真实存在的说法。'}
                  </p>
                )}
              </section>

              {result.hits.length > 0 && (
                <ul className={styles.hits}>
                  {result.hits.map((hit, index) => (
                    <li key={`${hit.docId}-${hit.ordinal}-${index}`} className={styles.hit}>
                      <div className={styles.hitHead}>
                        <span className={`kb-mono ${styles.hitRank}`}>{index + 1}</span>
                        <span className={styles.hitName} title={hit.docName}>{hit.docName}</span>
                        <span className={`kb-mono ${styles.hitOrdinal}`}>#{hit.ordinal}</span>
                        <span className={`kb-mono ${styles.hitRange}`}>{hit.charStart}–{hit.charEnd}</span>
                        <span className={`kb-mono ${styles.hitScore}`}>{hit.matchScore.toFixed(3)}</span>
                        <StatusPill status={bandStatus(hit.band)} label={BAND_LABELS[hit.band]} dense />
                      </div>
                      {/* The full chunk text, not a snippet: judging whether a chunk
                          is a coherent unit is the whole point, and a truncated one
                          cannot show a boundary that cut an argument in half. */}
                      <pre className={styles.hitText}>{hit.text}</pre>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
