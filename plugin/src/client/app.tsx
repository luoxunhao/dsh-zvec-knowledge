/**
 * KnowledgeBaseApp — the composed plugin surface.
 *
 * This is the seam between the browser half and the host half. The host owns the
 * store (it has the filesystem and the zvec binding); the browser owns rendering.
 * They meet here through a small data-access port, so the pages stay testable and
 * the transport can change without touching a component.
 *
 * The port is deliberately narrow — list, create, delete, usage — rather than a
 * generic RPC passthrough. A generic bridge would put host method names in the
 * browser bundle and make the transport contract impossible to review.
 *
 * @module dsh-zvec-knowledge/client/app
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell, type NavId } from './shell/AppShell.tsx'
import { OverviewPage, type BuildRecord, type OverviewCollection } from './pages/OverviewPage.tsx'
import { CreateCollectionDialog } from './dialogs/CreateCollectionDialog.tsx'
import { EmptyState } from './components/EmptyState.tsx'
import { Button } from './components/Button.tsx'
import type { StorageUsage } from './components/StorageUsageCard.tsx'
import type { StatusKind } from './components/StatusPill.tsx'
import type { HostPreview, HostCost, ChunkingDraft, IndexDraft } from './pages/BuildPage.tsx'
import type { StageView, LogLine } from './components/BuildPipeline.tsx'

/** One collection as the host reports it. */
export interface HostCollection {
  /** Collection identifier. */
  id: string
  /** Display name. */
  name: string
  /** Description. */
  description: string
  /** Index family. */
  indexKind: string
  /** Lifecycle state. */
  status: StatusKind
  /** Documents indexed. */
  documents: number
  /** Chunks indexed. */
  chunks: number
  /** Seven-day retrieval hits. */
  hits7d: number
  /** Last build time, ISO-8601, or `null`. */
  builtAt: string | null
  /** Creation time, ISO-8601. */
  createdAt: string
}

/** One document as the host reports it. */
export interface HostDocument {
  /** Stable document id. */
  id: string
  /** Original file name. */
  name: string
  /** Size in bytes. */
  bytes: number
  /** Lower-case extension. */
  ext: string
  /** Index lifecycle status. */
  status: StatusKind
  /**
   * Chunks indexed, or `null` while the value is genuinely unknown.
   *
   * `null` is the spec's 待构建 value: a freshly uploaded document has not been
   * built, so its chunk count is not zero — it is unmeasured. The distinction is
   * the difference between "待构建" and "this document produced nothing".
   */
  chunks: number | null
  /** Failure reason, when the last attempt failed. */
  error?: string
}

/** Data the app needs from the host. */
export interface KnowledgeBasePort {
  /** List collections with their statistics. */
  listCollections: () => Promise<HostCollection[]>
  /** Recent build records. */
  listBuilds: () => Promise<BuildRecord[]>
  /** Measured storage usage. */
  getUsage: () => Promise<StorageUsage>
  /** Create a collection. */
  createCollection: (values: { name: string, collectionId: string, description: string }) => Promise<void>
  /** Delete a collection. */
  deleteCollection: (id: string) => Promise<void>
  /** List one collection's documents. */
  listDocuments?: (collectionId: string) => Promise<HostDocument[]>
  /**
   * Transfer and store one file.
   *
   * `onProgress` reports a fraction in [0, 1]; `signal` is aborted when the user
   * cancels, and a transport that ignores it would leave the transfer running
   * while the UI claimed otherwise.
   */
  uploadDocument?: (
    collectionId: string,
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<HostDocument>
  /** Remove one document. */
  removeDocument?: (collectionId: string, id: string) => Promise<void>
  /**
   * Compute the chunk preview for a candidate chunking strategy.
   *
   * Host-side on purpose: the preview must come from the same chunker the build
   * uses, or the two would eventually disagree — and the preview's whole purpose
   * is to predict what the build will do.
   */
  previewChunks?: (collectionId: string, chunking: ChunkingDraft) => Promise<HostPreview>
  /** Estimate the cost of a plan. */
  estimateCost?: (collectionId: string, chunking: ChunkingDraft, index: IndexDraft) => Promise<HostCost>
  /** The strategy a collection was last built with, for a pre-filled configurator. */
  storedStrategy?: (collectionId: string) => Promise<{ chunking: ChunkingDraft, index: IndexDraft } | null>
  /**
   * Run the index build.
   *
   * Progress, log lines and cancellation all flow through the callbacks, because
   * the build is a long task that must remain observable and interruptible.
   */
  buildIndex?: (
    collectionId: string,
    strategy: { chunking: ChunkingDraft, index: IndexDraft },
    handlers: {
      onProgress: (progress: { stages: StageView[], processed: number, total: number, fraction: number }) => void
      onLog: (line: LogLine) => void
    },
    signal: AbortSignal,
  ) => Promise<{ ok: boolean, chunks: number, error?: string }>
}

/** Options accepted by {@link KnowledgeBaseApp}. */
export interface KnowledgeBaseAppProps {
  /** Host data access. */
  port: KnowledgeBasePort
}

/** Page titles by navigation destination. */
const PAGE_TITLES: Record<NavId, string> = {
  overview: '知识库',
  documents: '文档接入',
  build: '索引构建',
  retrieval: '检索测试',
  rag: 'RAG 问答',
  settings: '设置',
}

/** Destinations whose page is not part of this slice. */
const PENDING_PAGES: NavId[] = ['documents', 'build', 'retrieval', 'rag', 'settings']

/** Human labels for lifecycle states. */
const STATUS_LABELS: Record<StatusKind, string> = {
  ready: '就绪',
  building: '构建中',
  failed: '失败',
  pending: '待构建',
  info: '信息',
}

/**
 * Format an ISO timestamp for a card footer.
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
 * Render the whole plugin surface.
 * @param props - the host data port.
 * @returns the app.
 */
export function KnowledgeBaseApp({ port }: KnowledgeBaseAppProps): React.JSX.Element {
  const [nav, setNav] = useState<NavId>('overview')
  const [query, setQuery] = useState('')
  const [collections, setCollections] = useState<HostCollection[]>([])
  const [builds, setBuilds] = useState<BuildRecord[]>([])
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  /** Load every host-provided dataset. */
  const load = useCallback(async (): Promise<void> => {
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
    } catch (cause) {
      // The failure reason is surfaced verbatim: the spec's error-state rule
      // forbids showing only a code.
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setLoading(false)
    }
  }, [port])

  useEffect(() => { void load() }, [load])

  const overview: OverviewCollection[] = useMemo(() => collections.map(item => ({
    id: item.id,
    name: item.name,
    indexKind: item.indexKind,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    stats: { documents: item.documents, chunks: item.chunks, hits7d: item.hits7d },
    updatedAt: formatTimestamp(item.builtAt ?? item.createdAt),
  })), [collections])

  const hits7d = useMemo(() => collections.reduce((sum, item) => sum + item.hits7d, 0), [collections])

  /** Create, then refresh so the new card appears immediately (KB-05 criterion). */
  const create = useCallback(async (values: { name: string, collectionId: string, description: string }): Promise<void> => {
    await port.createCollection(values)
    setDialogOpen(false)
    await load()
  }, [port, load])

  /** Delete, then refresh. */
  const remove = useCallback(async (id: string): Promise<void> => {
    await port.deleteCollection(id)
    await load()
  }, [port, load])

  return (
    <>
      <AppShell
        usage={usage}
        title={PAGE_TITLES[nav]}
        active={nav}
        onNavigate={setNav}
        query={query}
        onQueryChange={setQuery}
      >
        {nav === 'overview' ? (
          <OverviewPage
            collections={overview}
            builds={builds}
            hits7d={hits7d}
            loading={loading}
            error={error}
            onCreate={() => setDialogOpen(true)}
            onOpen={() => { /* KB-05 detail page arrives with KB-06 */ }}
            onDelete={id => { void remove(id) }}
            onRetry={() => { void load() }}
          />
        ) : (
          <EmptyState
            icon={nav === 'documents' ? 'file' : nav === 'retrieval' ? 'search' : 'info'}
            title={`${PAGE_TITLES[nav]} 尚未实现`}
            description={PENDING_PAGES.includes(nav)
              ? '该页面属于后续 issue 的范围（KB-06 起），当前版本只交付总览页。'
              : '该页面尚未实现。'}
            action={<Button variant="secondary" onClick={() => setNav('overview')}>返回知识库总览</Button>}
          />
        )}
      </AppShell>

      <CreateCollectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={create}
        existingIds={collections.map(item => item.id)}
      />
    </>
  )
}
