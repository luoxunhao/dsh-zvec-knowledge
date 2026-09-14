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

import { useEffect, useState } from 'react'
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

/** Sub-navigation destinations inside the panel. */
const VIEWS: { value: KnowledgeView, label: string }[] = [
  { value: 'overview', label: '总览' },
  { value: 'documents', label: '文档' },
  { value: 'build', label: '索引' },
  { value: 'retrieval', label: '检索' },
  { value: 'rag', label: '问答' },
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

/** Views whose page is not part of this slice. */
const PENDING_VIEWS: KnowledgeView[] = ['build', 'retrieval', 'rag', 'settings']

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
                    void loadDocuments(selectedCollection)
                    return toPageDocument(host)
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
          />
        ) : (
          <EmptyState
            icon={view === 'retrieval' ? 'search' : 'info'}
            title={`${VIEWS.find(item => item.value === view)?.label ?? view} 尚未实现`}
            description={PENDING_VIEWS.includes(view)
              ? '该页面属于后续 issue 的范围（KB-07 起），当前版本交付总览与文档接入。'
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
