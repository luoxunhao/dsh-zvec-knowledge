/**
 * The knowledge-base main panel.
 *
 * This is what the sidebar's 知识库 row opens. The harness layout owns the frame —
 * the left sidebar, the main column, panel selection — so this component is the
 * *body* of a panel and must not draw a second application frame. It keeps a
 * page-level header (title, description, the page's own primary action) and the
 * in-panel navigation between the five chains, because those are the plugin's own
 * structure rather than shell chrome.
 *
 * That split is the whole reason the original self-contained `AppShell` was
 * retired for this slice: two nested frames would give the user two sidebars and
 * two topbars, and the page would no longer be "the only visual centre" (§6.1).
 *
 * Sub-navigation is an in-panel tab strip rather than a second sidebar, for the
 * same reason: the shell already owns one sidebar, and a page may not compete
 * with it.
 *
 * @module dsh-zvec-knowledge/client/panel
 */

import { useCallback, useEffect, useState } from 'react'
import { OverviewPage, type BuildRecord, type OverviewCollection } from './pages/OverviewPage.tsx'
import { CreateCollectionDialog } from './dialogs/CreateCollectionDialog.tsx'
import { EmptyState } from './components/EmptyState.tsx'
import { Button } from './components/Button.tsx'
import { Tabs } from './components/Tabs.tsx'
import type { StorageUsage } from './components/StorageUsageCard.tsx'
import type { StatusKind } from './components/StatusPill.tsx'
import type { KnowledgeBasePort, HostCollection, HostDocument } from './app.tsx'
import type { PanelState, KnowledgeView } from './index.tsx'
import { DocumentsPage, type PageDocument } from './pages/DocumentsPage.tsx'
import { RetrievalPage } from './pages/RetrievalPage.tsx'
import {
  BuildPage,
  type BuildPageProps, type ChunkingDraft, type IndexDraft,
  type HostPreview, type HostCost, type HostModelOption, type HostQuantizerOption,
} from './pages/BuildPage.tsx'
import type { StageView, LogLine } from './components/BuildPipeline.tsx'
import { QuotaNotice, type QuotaStateView } from './components/QuotaNotice.tsx'
import styles from './KnowledgePanel.module.css'

/** Options accepted by {@link KnowledgeBasePanel}. */
export interface KnowledgeBasePanelProps {
  /** Shared view selection, so the sidebar row and this panel stay in step. */
  state: PanelState
  /**
   * Host data access.
   *
   * Optional so the panel can render its empty and error states in a host that
   * has not wired the bridge yet, instead of crashing on a missing port.
   */
  port?: KnowledgeBasePort
}

/**
 * Sub-navigation destinations inside the panel.
 *
 * 问答 is deliberately absent: KB-09's revised scope puts RAG in the dsh
 * conversation, where the model calls `dsh_kb_search` and answers with citations,
 * so a second Q&A panel here would be a duplicate UI with its own citation
 * rendering and state.
 *
 * 检索 is present and is *not* that removed Q&A surface. It is a diagnostic
 * console that judges the plugin's own artifacts — whether chunking produced
 * sensible units and whether vector recall works — which the conversation's tool
 * block cannot show, because it renders only what one query happened to match and
 * applies the score floor silently. KB-09's closing note anticipated exactly this
 * gap.
 */
const VIEWS: { value: KnowledgeView, label: string }[] = [
  { value: 'overview', label: '总览' },
  { value: 'documents', label: '文档' },
  { value: 'build', label: '索引' },
  { value: 'retrieval', label: '检索验证' },
  { value: 'settings', label: '设置' },
]

/** Human labels for lifecycle states. */
const STATUS_LABELS: Record<StatusKind, string> = {
  ready: '就绪',
  building: '构建中',
  failed: '失败',
  pending: '待构建',
  info: '信息',
}

/**
 * Chunking defaults, mirroring the host's §10.1 values.
 *
 * Duplicated here rather than fetched so the configurator renders immediately and
 * stays usable while the host bridge is being wired; the host's stored strategy
 * replaces them once it arrives.
 */
const CHUNKING_FALLBACK: ChunkingDraft = {
  mode: 'heading',
  chunkTokens: 1024,
  overlapTokens: 128,
  minChunkTokens: 64,
  preserveCodeBlocks: true,
  splitTablesByRow: false,
}

/** Index defaults, mirroring the host's §10.1 values and the engine's real set. */
const INDEX_FALLBACK: IndexDraft = {
  // Replaced with the host's real model id as soon as `embeddingInfo` arrives.
  // Empty rather than a plausible constant, so a grid that has not loaded yet
  // cannot be mistaken for a value the deployment chose.
  model: '',
  kind: 'HNSW',
  m: 32,
  efConstruction: 200,
  quantize: 'INT8',
}

/** The four stages before any build has run. Labels are mandatory (§5.3). */
const INITIAL_STAGES: StageView[] = [
  { id: 'parse', label: '解析文档', state: 'pending' },
  { id: 'chunk', label: '切分与嵌入', state: 'pending' },
  { id: 'index', label: '写入索引', state: 'pending' },
  { id: 'publish', label: '校验与发布', state: 'pending' },
]

/** Views whose page is not part of this slice. */
const PENDING_VIEWS: KnowledgeView[] = ['settings']

/**
 * Poll interval while a build runs, in milliseconds.
 *
 * The host owns the build, so the page's only job is to observe it. A build takes
 * minutes and each poll is a small JSON read, so this trades a little latency for
 * far less request traffic than a tight loop would add to a host that is busy
 * embedding.
 */
const BUILD_POLL_MS = 1200

/**
 * Embedding model options, derived from what the host reports.
 *
 * One entry, because a collection's schema is created at the deployment's width
 * and a different model needs a new collection rather than a new setting. The
 * width comes from the host: the client cannot see the deployment's configuration,
 * and a hardcoded 1024 here is what made a 2560 deployment display the wrong
 * dimension — in a read-only field the user has no way to correct.
 *
 * With no provider configured the list is empty and the grid reports 未知, which
 * is a real state rather than a plausible-looking default.
 * @param info - the host's embedding shape, or `null` before it arrives.
 * @returns options for the model selector.
 */
function modelOptions(info: { dimension: number, model: string | null } | null): HostModelOption[] {
  if (info === null) return []
  const label = info.model === null
    ? `本地嵌入模型（${info.dimension} 维）`
    : `${info.model}（${info.dimension} 维）`
  return [{
    id: `embedding-${info.dimension}`,
    label,
    dimension: info.dimension,
    metric: 'cosine',
    note: '与集合 schema 一致，无需重建集合',
  }]
}

/** Quantizer options, each stating the compression/recall trade-off (§5.6). */
const QUANTIZER_OPTIONS: HostQuantizerOption[] = [
  { value: 'INT8', label: 'INT8', tradeoff: '相对 FP32 压缩 4×，召回损失小，推荐默认' },
  { value: 'INT4', label: 'INT4', tradeoff: '相对 FP32 压缩 8×，召回损失明显增大' },
  { value: 'FP16', label: 'FP16', tradeoff: '相对 FP32 压缩 2×，召回损失极小' },
  { value: 'none', label: '不量化', tradeoff: '不压缩，存储占用最高，召回最好' },
]

/**
 * Project a host document into the page's shape.
 *
 * The two are structurally the same today, and this exists so they need not be:
 * the port is the host's contract and the page's type is the view's, and keeping
 * the translation in one place is what lets either change without the other.
 * @param document - the host's record.
 * @returns the page's shape.
 */
function toPageDocument(document: HostDocument): PageDocument {
  return {
    id: document.id,
    name: document.name,
    bytes: document.bytes,
    ext: document.ext,
    status: document.status,
    chunks: document.chunks,
    error: document.error,
  }
}

/**
 * Format an ISO timestamp for display.
 *
 * Falls back to the raw string when the value will not parse, rather than
 * rendering `Invalid Date` — a timestamp that cannot be read is still evidence.
 * @param iso - ISO-8601 timestamp or `null`.
 * @returns a display string.
 */
function formatTimestamp(iso: string | null): string {
  if (iso === null) return '尚未构建'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * Render the knowledge panel body.
 * @param props - shared view state and the host data port.
 * @returns the panel.
 */
export function KnowledgeBasePanel({ state, port }: KnowledgeBasePanelProps): React.JSX.Element {
  const [view, setView] = useState<KnowledgeView>(state.get())
  const [collections, setCollections] = useState<HostCollection[]>([])
  const [documents, setDocuments] = useState<HostDocument[]>([])
  const [builds, setBuilds] = useState<BuildRecord[]>([])
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(port !== undefined)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Which collection the documents view is working against. Kept here rather
  // than in the documents page so switching views does not forget the choice.
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null)
  // The quota state drives the restricted banner and disables the two actions
  // that would grow the store. Held here so the banner and the page agree.
  const [quota, setQuota] = useState<QuotaStateView | null>(null)
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null)

  // ---- Build (KB-07) state ----
  const [chunking, setChunking] = useState<ChunkingDraft>(CHUNKING_FALLBACK)
  const [index, setIndex] = useState<IndexDraft>(INDEX_FALLBACK)
  const [preview, setPreview] = useState<HostPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [cost, setCost] = useState<HostCost | null>(null)
  const [stages, setStages] = useState<StageView[]>(INITIAL_STAGES)
  const [processed, setProcessed] = useState(0)
  const [total, setTotal] = useState(0)
  const [fraction, setFraction] = useState(0)
  const [log, setLog] = useState<LogLine[]>([])
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  // A statement about the build, not a failure: "nothing to rebuild" and "the host
  // downgraded this to a full rebuild" both belong here.
  const [buildNotice, setBuildNotice] = useState<string | null>(null)
  // Whether the host can build incrementally with the current parameters, and why
  // not when it cannot. Queried so the page can label the option truthfully rather
  // than offering a choice the host will override.
  const [incrementalPlan, setIncrementalPlan] = useState<{ possible: boolean, reason: string } | null>(null)
  // Whether retrieval is currently served from a previous snapshot: true from
  // the moment a build starts until it publishes.
  const [servingPrevious, setServingPrevious] = useState(false)

  // Mirror the shared selection in both directions: the sidebar row can change
  // it, and the in-panel tabs change it here.
  useEffect(() => state.subscribe(() => setView(state.get())), [state])

  /** Load every host-provided dataset. */
  const load = async (): Promise<void> => {
    if (port === undefined) return
    setLoading(true)
    setError(null)
    try {
      const [list, records, measured] = await Promise.all([
        port.listCollections(),
        port.listBuilds(),
        port.getUsage(),
      ])
      setCollections(list)
      setBuilds(records)
      setUsage(measured)
      // Quota is optional on the port so a host can wire collections before
      // quotas; without it the restricted state simply never appears.
      if (port.getQuota !== undefined) setQuota(await port.getQuota())
    } catch (cause) {
      // The failure reason is surfaced verbatim: §8.1's error-state rule forbids
      // showing only a code.
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [port])

  // The first collection becomes the default target so the documents view is
  // usable without an extra click, but an explicit choice is never overridden.
  useEffect(() => {
    if (selectedCollection === null && collections.length > 0) {
      setSelectedCollection(collections[0]?.id ?? null)
    }
  }, [collections, selectedCollection])

  /** Load the selected collection's documents. */
  const loadDocuments = async (collectionId: string | null): Promise<void> => {
    // `listDocuments` is optional on the port so a host can wire collections
    // before documents; without it the list is simply empty rather than an error.
    if (port?.listDocuments === undefined || collectionId === null) {
      setDocuments([])
      return
    }
    try {
      setDocuments(await port.listDocuments(collectionId))
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
    }
  }

  useEffect(() => { void loadDocuments(selectedCollection) }, [port, selectedCollection])

  // ---- Build strategy: prefill, preview, estimate ----

  // The deployment's embedding shape. Fetched rather than assumed: the vector
  // width is a property of the schema the host creates, and a client-side constant
  // here is exactly how the configurator displayed 1024 against a 2560 schema.
  const [embedding, setEmbedding] = useState<{ dimension: number, model: string | null, metric: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (port?.embeddingInfo === undefined) return
      try {
        const info = await port.embeddingInfo()
        if (cancelled) return
        setEmbedding(info)
        // Seed the draft's model id with the host's real one, so the selector is
        // not left holding the empty fallback. `storedStrategy` overwrites this
        // for a collection that has been built; both agree because the id is
        // derived from the same deployment width.
        setIndex(current => current.model === '' ? { ...current, model: `embedding-${info.dimension}` } : current)
      } catch {
        // Leave it null: the grid then says "—" rather than a plausible number.
        // Inventing one is the defect this replaced.
      }
    }
    void load()
    return () => { cancelled = true }
  }, [port])

  // Load the stored strategy so a rebuild shows what it is changing rather than
  // silently presenting defaults that differ from the live index.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (port?.storedStrategy === undefined || selectedCollection === null) return
      try {
        const stored = await port.storedStrategy(selectedCollection)
        if (cancelled || stored === null) return
        setChunking(stored.chunking)
        setIndex(stored.index)
      } catch {
        // A missing stored strategy is not an error: the defaults are valid, and
        // surfacing a failure here would block a first build.
      }
    }
    void load()
    return () => { cancelled = true }
  }, [port, selectedCollection])

  // Recompute the preview and estimate whenever a parameter changes. Both derive
  // from the same host call path, so the numbers the user sees are the numbers the
  // build will produce.
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      if (selectedCollection === null) {
        setPreview(null)
        setCost(null)
        return
      }
      try {
        setPreviewError(null)
        setPreview(null)
        setCost(null)
        const nextPreview = port?.previewChunks !== undefined
          ? await port.previewChunks(selectedCollection, chunking)
          : { rows: [], totalChunks: 0, averageTokens: 0, discarded: 0, totalTokens: 0 }
        if (cancelled) return
        setPreview(nextPreview)
        const nextCost = port?.estimateCost !== undefined
          ? await port.estimateCost(selectedCollection, chunking, index)
          : null
        if (cancelled) return
        setCost(nextCost)
      } catch (cause) {
        if (cancelled) return
        // The preview failure is reported in the preview panel rather than the
        // page error, so an invalid parameter does not look like a load failure.
        setPreviewError(String(cause instanceof Error ? cause.message : cause))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [port, selectedCollection, chunking, index])

  // Ask the host whether an incremental build is possible with the current
  // parameters. Re-queried whenever the strategy changes, so flipping a chunking
  // field immediately shows that the next build must be a full one — which is the
  // moment the user needs to know, not after they have committed.
  useEffect(() => {
    const plan = port?.buildPlan
    if (plan === undefined || selectedCollection === null) {
      setIncrementalPlan(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await plan(selectedCollection, { chunking, index })
        if (!cancelled) setIncrementalPlan(result)
      } catch {
        // A plan that cannot be read must not block the page: the build itself
        // still decides, and `buildPlan` is a label rather than a gate.
        if (!cancelled) setIncrementalPlan(null)
      }
    })()
    return () => { cancelled = true }
  }, [port, selectedCollection, chunking, index])

  /**
   * Run the index build.
   *
   * Submission and observation are separate: this launches the host-side job and
   * returns, and the polling effect below reports progress. That split is what lets
   * the user leave the page — the build is the host's, not this component's.
   */
  const submitBuild = async (buildMode: 'incremental' | 'full' = 'incremental'): Promise<void> => {
    if (port?.buildIndex === undefined || selectedCollection === null) return
    setBuildError(null)
    // The previous run's log is cleared only once the host has accepted the new
    // one, so a rejected submit does not blank the failure the user is reading.
    try {
      const launched = await port.buildIndex(selectedCollection, { chunking, index }, buildMode)
      if (!launched.started) {
        // `started: false` with no error is the host reporting there is nothing to
        // do — every document is already indexed under these parameters. That is a
        // success, not a failure, so it must not be shown as one.
        if (launched.error === undefined) {
          setBuildError(null)
          setBuildNotice('所有文档均已构建且参数未变更，无需重建。')
          setBuilding(false)
          setServingPrevious(false)
          return
        }
        setBuildError(launched.error)
        return
      }
      setBuildNotice(null)
      setBuilding(true)
      setLog([])
      setProcessed(0)
      setTotal(0)
      setFraction(0)
      setStages(INITIAL_STAGES)
      setServingPrevious(true)
      // Poll immediately rather than waiting for the first interval: the job's
      // opening log lines are already available, and a one-second blank panel
      // reads as a failed submit.
      await pollOnce()
    } catch (cause) {
      setBuildError(String(cause instanceof Error ? cause.message : cause))
    }
  }

  /** Read the job's current state once and mirror it into the page. */
  const pollOnce = useCallback(async (): Promise<void> => {
    const readStatus = port?.buildStatus
    if (readStatus === undefined || selectedCollection === null) return
    const snapshot = await readStatus(selectedCollection)
    if (snapshot === null) return
    setStages(snapshot.stages)
    setProcessed(snapshot.processed)
    setTotal(snapshot.total)
    setFraction(snapshot.fraction)
    setLog(snapshot.log)
    setBuilding(snapshot.running)
    setBuildError(snapshot.settledAt !== null && !snapshot.ok ? snapshot.error : null)
    // Retrieval reads the previous snapshot until the job publishes; the notice
    // clears exactly when the build settles.
    setServingPrevious(snapshot.running)
    if (!snapshot.running) {
      // A settled job changed either the collection's chunk count or the documents'
      // statuses, so the page's data is refreshed once here rather than per poll.
      await load()
      await loadDocuments(selectedCollection)
    }
  }, [port, selectedCollection])

  // Poll while a build is running. The interval is deliberately modest: a build
  // takes minutes, the poll is cheap, and a tighter loop would only add request
  // traffic to a host that is busy embedding.
  useEffect(() => {
    if (!building) return
    const timer = setInterval(() => { void pollOnce() }, BUILD_POLL_MS)
    return () => { clearInterval(timer) }
  }, [building, pollOnce])

  // Pick up a build that is already running (typically one started before this page
  // was opened, or before a refresh), so the panel shows it instead of an idle
  // configurator the user might submit over the top of.
  useEffect(() => {
    const readStatus = port?.buildStatus
    if (readStatus === undefined || selectedCollection === null) return
    let cancelled = false
    const attach = async (): Promise<void> => {
      try {
        const snapshot = await readStatus(selectedCollection)
        if (cancelled || snapshot === null) return
        if (snapshot.running) setBuilding(true)
        setStages(snapshot.stages)
        setProcessed(snapshot.processed)
        setTotal(snapshot.total)
        setFraction(snapshot.fraction)
        setLog(snapshot.log)
        if (snapshot.settledAt !== null && !snapshot.ok) setBuildError(snapshot.error)
      } catch {
        // Attaching is opportunistic: a host that cannot answer leaves the page
        // usable for a new build rather than showing an unrelated error.
      }
    }
    void attach()
    return () => { cancelled = true }
  }, [port, selectedCollection])

  /** Cancel the running build. */
  const cancelBuild = (): void => {
    const cancel = port?.cancelBuild
    if (cancel === undefined || selectedCollection === null) return
    // The host is the authority on cancellation: the next poll reflects the
    // settled state, so nothing is assumed here.
    void cancel(selectedCollection).catch(() => { /* the poll reports it */ })
  }

  /** Switch view through the shared holder so the sidebar row follows. */
  const changeView = (next: string): void => {
    state.set(next as KnowledgeView)
  }

  const overview: OverviewCollection[] = collections.map(item => ({
    id: item.id,
    name: item.name,
    indexKind: item.indexKind,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    stats: { documents: item.documents, chunks: item.chunks, hits7d: item.hits7d },
    updatedAt: formatTimestamp(item.builtAt ?? item.createdAt),
  }))
  const hits7d = collections.reduce((sum, item) => sum + item.hits7d, 0)

  /** Create, then refresh so the new card appears immediately. */
  const create = async (values: { name: string, collectionId: string, description: string }): Promise<void> => {
    if (port === undefined) throw new Error('宿主数据通道未接通')
    await port.createCollection(values)
    setDialogOpen(false)
    await load()
  }

  /** Delete, then refresh. */
  const remove = async (id: string): Promise<void> => {
    if (port === undefined) return
    await port.deleteCollection(id)
    await load()
  }

  return (
    <div className={`kb-root ${styles.panel}`}>
      <nav className={styles.tabs} aria-label="知识库内导航">
        <Tabs
          label="知识库内导航"
          items={VIEWS.map(item => ({ value: item.value, label: item.label }))}
          value={view}
          onChange={changeView}
        />
      </nav>

      <div className={styles.body}>
        {/* The restricted state sits above every view: a quota that blocks uploads
            is a property of the store, not of one page, and a user who only sees
            it after clicking upload has already wasted the attempt. */}
        {quota !== null && (quota.exceeded || quota.nearLimit || quotaBlocked !== null) && (
          <QuotaNotice state={quota} blocked={quotaBlocked} />
        )}

        {view === 'overview' ? (
          <OverviewPage
            collections={overview}
            builds={builds}
            hits7d={hits7d}
            loading={loading}
            error={error}
            showChrome={false}
            onCreate={() => setDialogOpen(true)}
            // Opening a card selects it and switches to the document chain, which
            // is the next thing a user does after creating a collection.
            onOpen={id => { setSelectedCollection(id); changeView('documents') }}
            onDelete={id => { void remove(id) }}
            onRetry={() => { void load() }}
          />
        ) : view === 'documents' ? (
          <DocumentsPage
            documents={documents.map(toPageDocument)}
            transport={port?.uploadDocument === undefined || selectedCollection === null ? undefined : {
              upload: (file, onProgress, signal) =>
                port.uploadDocument!(selectedCollection, file, onProgress, signal)
                  .then(host => {
                    // Refresh from the host rather than appending locally: the
                    // host owns the record, and a local guess would drift from
                    // the stored status the moment a build changes it.
                    //
                    // A successful upload also means any quota refusal shown
                    // earlier is stale, so it is cleared and the meter reloaded.
                    setQuotaBlocked(null)
                    void load()
                    void loadDocuments(selectedCollection)
                    return toPageDocument(host)
                  })
                  .catch((cause: unknown) => {
                    // A quota refusal is a *state*, not a per-file error: showing it
                    // in the banner (and disabling further intake) is more useful
                    // than one row's error text, because the next file will be
                    // refused identically.
                    const message = String(cause instanceof Error ? cause.message : cause)
                    if (/配额/.test(message)) setQuotaBlocked(message)
                    throw cause
                  }),
            }}
            onRemove={id => {
              if (port?.removeDocument === undefined || selectedCollection === null) return
              const remove = port.removeDocument
              void remove(selectedCollection, id).then(() => loadDocuments(selectedCollection))
            }}
            loading={loading}
            error={error}
            onRetry={() => { void load() }}
            collectionId={selectedCollection}
            quotaBlocked={quota?.exceeded === true || quotaBlocked !== null}
          />
        ) : view === 'build' ? (
          <BuildPage
            collectionId={selectedCollection}
            chunking={chunking}
            onChunkingChange={setChunking}
            index={index}
            onIndexChange={setIndex}
            preview={preview}
            previewError={previewError}
            cost={cost}
            models={modelOptions(embedding)}
            quantizers={QUANTIZER_OPTIONS}
            stages={stages}
            processed={processed}
            total={total}
            fraction={fraction}
            log={log}
            running={building}
            buildError={buildError}
            servingPreviousSnapshot={servingPrevious}
            hasDocuments={documents.length > 0}
            // How many documents would be embedded / reused, so the button can say
            // what it is about to do rather than leaving the user to guess.
            pendingDocuments={documents.filter(document => document.status !== 'ready').length}
            totalDocuments={documents.length}
            incrementalPlan={incrementalPlan}
            buildNotice={buildNotice}
            onSubmit={mode => { void submitBuild(mode) }}
            onCancel={cancelBuild}
            onRetry={() => { void submitBuild('full') }}
            onReset={() => {
              setChunking(CHUNKING_FALLBACK)
              setIndex(INDEX_FALLBACK)
            }}
          />
        ) : view === 'retrieval' ? (
          <RetrievalPage
            collectionId={selectedCollection}
            // A collection with no published snapshot has nothing to search, and the
            // page says so rather than rendering an empty result that looks like a
            // recall failure.
            hasSnapshot={collections.find(item => item.id === selectedCollection)?.builtAt != null}
            {...(port?.retrieve === undefined || selectedCollection === null ? {} : {
              transport: {
                run: (query, options) => port.retrieve!(selectedCollection, query, options),
              },
            })}
          />
        ) : (
          <EmptyState
            icon="info"
            title={`${VIEWS.find(item => item.value === view)?.label ?? view} 尚未实现`}
            description={PENDING_VIEWS.includes(view)
              ? '设置页属于后续 issue 的范围。问答不在此处提供：请在 dsh 会话中直接提问，模型会调用 dsh_kb_search 并给出带引用的回答。'
              : '该页面尚未实现。'}
            action={<Button variant="secondary" onClick={() => changeView('overview')}>返回总览</Button>}
          />
        )}
      </div>

      <CreateCollectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={create}
        existingIds={collections.map(item => item.id)}
      />
    </div>
  )
}
