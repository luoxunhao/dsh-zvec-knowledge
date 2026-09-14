/**
 * OverviewPage — 链路① 的知识库总览（design spec §6.2）.
 *
 * The page answers one question — "what collections exist and what state is each
 * in" — and the layout is built so the answer is available before any
 * interaction: four summary tiles, a filter bar whose state is always visible,
 * and a card grid.
 *
 * Two constraints from the spec are load-bearing here:
 *
 * - **Exactly one primary button.** "创建知识库" is the page's single primary
 *   action; every other control is secondary or ghost. The spec's rule is that a
 *   page has one main action, and a second primary would make the choice
 *   ambiguous. (Note the client bundle therefore has no interest in the
 *   `Button` one-primary guard's global counter — the page states its intent
 *   explicitly by using `primary` once.)
 * - **Filter state is always visible.** The active status filter is rendered as a
 *   removable chip row *in addition to* the segmented control, so a filtered view
 *   can never be mistaken for an empty store. Clearing restores the full list.
 *
 * @module dsh-zvec-knowledge/client/pages/OverviewPage
 */

import { useMemo, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { CollectionCard, formatCount, type CollectionCardStats } from '../components/CollectionCard.tsx'
import { Icon } from '../components/Icon.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { StatCard } from '../components/StatCard.tsx'
import { StatusPill, type StatusKind } from '../components/StatusPill.tsx'
import { Tag } from '../components/Tag.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import styles from './OverviewPage.module.css'

/** One row of the build-record table. */
export interface BuildRecord {
  /** ISO-8601 timestamp of the build. */
  at: string
  /** Collection the build belongs to. */
  collectionId: string
  /** Chunks produced. */
  chunks: number
  /** Outcome state. */
  status: StatusKind
  /** Visible wording for the outcome. */
  statusLabel: string
}

/** A collection as the overview renders it. */
export interface OverviewCollection {
  /** Collection identifier, e.g. `kb_prod_2f8a`. */
  id: string
  /** Human-facing name. */
  name: string
  /** Index family. */
  indexKind: string
  /** Lifecycle state. */
  status: StatusKind
  /** Visible wording for the state. */
  statusLabel: string
  /** Scale figures. */
  stats: CollectionCardStats
  /** Preformatted modification time. */
  updatedAt: string
}

/** Options accepted by {@link OverviewPage}. */
export interface OverviewPageProps {
  /** Collections to show. */
  collections: OverviewCollection[]
  /** Recent build records. */
  builds: BuildRecord[]
  /** Total seven-day retrieval hits across every collection. */
  hits7d: number
  /** Whether data is still loading. */
  loading?: boolean
  /** Load failure, if any. */
  error?: string | null
  /** Called when 创建知识库 is chosen. */
  onCreate: () => void
  /** Called when a collection is opened. */
  onOpen: (id: string) => void
  /** Called when a collection's delete action is chosen. */
  onDelete: (id: string) => void
  /** Called to retry after a failure. */
  onRetry?: () => void
}

/** Status filter options; `all` is the unfiltered view. */
const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'ready', label: '就绪' },
  { value: 'building', label: '构建中' },
  { value: 'pending', label: '待构建' },
  { value: 'failed', label: '失败' },
] as const

/** Grid/list view switch. */
const VIEW_OPTIONS = [
  { value: 'grid', label: '卡片' },
  { value: 'list', label: '列表' },
] as const

/**
 * Render the overview page.
 * @param props - collections, build records, usage figures and callbacks.
 * @returns the page.
 */
export function OverviewPage({
  collections, builds, hits7d, loading = false, error = null,
  onCreate, onOpen, onDelete, onRetry,
}: OverviewPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('all')
  const [view, setView] = useState<string>('grid')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return collections.filter(item => {
      if (status !== 'all' && item.status !== status) return false
      if (needle === '') return true
      // Both the human name and the technical id are searchable: an operator
      // pasting a collection id from a log must find the card.
      return item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle)
    })
  }, [collections, query, status])

  const isFiltered = status !== 'all' || query.trim() !== ''
  const totalDocuments = collections.reduce((sum, item) => sum + item.stats.documents, 0)
  const readyOrBuilding = collections.filter(item => item.status === 'ready' || item.status === 'building').length

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>知识库总览</h2>
          <p className={styles.description}>
            管理本地知识库，查看构建状态与检索命中情况。
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" icon="refresh" onClick={onRetry}>刷新</Button>
          {/* The page's single primary action. */}
          <Button variant="primary" icon="plus" onClick={onCreate}>创建知识库</Button>
        </div>
      </header>

      <section className={styles.stats} aria-label="汇总统计">
        <StatCard label="知识库总数" value={formatCount(collections.length)} icon="collection" />
        <StatCard label="就绪与构建中" value={formatCount(readyOrBuilding)} icon="check" />
        <StatCard label="文档总数" value={formatCount(totalDocuments)} icon="file" />
        <StatCard label="近七日工具调用命中" value={formatCount(hits7d)} icon="search" detail="来自检索工具的真实统计" />
      </section>

      <section className={styles.filters} aria-label="筛选与视图">
        <div className={styles.filterSearch}>
          <SearchField
            value={query}
            onValueChange={setQuery}
            label="筛选知识库"
            placeholder="按名称或集合标识筛选"
          />
        </div>
        <SegmentedControl
          options={STATUS_FILTERS.map(item => ({ value: item.value, label: item.label }))}
          value={status}
          onChange={setStatus}
          label="状态筛选"
        />
        <div className={styles.viewSwitch}>
          <SegmentedControl
            options={VIEW_OPTIONS.map(item => ({ value: item.value, label: item.label }))}
            value={view}
            onChange={setView}
            label="视图切换"
          />
        </div>
      </section>

      {/* The active filter is restated as removable chips so a narrowed view is
          never mistaken for an empty store. */}
      {isFiltered && (
        <div className={styles.activeFilters} role="status">
          <span className={styles.activeLabel}>当前筛选</span>
          {query.trim() !== '' && (
            <Tag tone="brand" onRemove={() => setQuery('')} removeLabel="清除搜索筛选">
              {`搜索：${query.trim()}`}
            </Tag>
          )}
          {status !== 'all' && (
            <Tag tone="brand" onRemove={() => setStatus('all')} removeLabel="清除状态筛选">
              {`状态：${STATUS_FILTERS.find(item => item.value === status)?.label ?? status}`}
            </Tag>
          )}
          <span className={`kb-mono ${styles.activeCount}`}>{filtered.length} / {collections.length}</span>
          <Button variant="ghost" size="sm" onClick={() => { setQuery(''); setStatus('all') }}>
            清空筛选
          </Button>
        </div>
      )}

      <section className={styles.collections} aria-label="知识库列表">
        {error !== null ? (
          <div className={styles.error} role="alert">
            <p className={styles.errorTitle}><Icon name="alert" size={16} /> 无法读取知识库</p>
            <p className={styles.errorBody}>{error}</p>
            {onRetry !== undefined && <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>}
          </div>
        ) : loading ? (
          <div className={styles.grid} aria-busy="true" aria-label="正在加载知识库">
            {[0, 1, 2].map(index => <div key={index} className={styles.skeleton} />)}
          </div>
        ) : collections.length === 0 ? (
          // The empty state must offer a next step (§8.1), and the step here is
          // the page header's own primary. Restating it as a second `primary`
          // would violate the one-primary-per-view rule, so the empty state
          // points at the header action instead of duplicating it: same
          // destination, one primary on the page.
          <EmptyState
            title="还没有知识库"
            description="使用右上角的「创建知识库」建立第一个知识库，之后即可上传文档并构建索引。"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的知识库"
            description="当前筛选条件下没有结果，清空筛选可恢复全量。"
            action={<Button variant="secondary" onClick={() => { setQuery(''); setStatus('all') }}>清空筛选</Button>}
          />
        ) : view === 'grid' ? (
          <div className={styles.grid}>
            {filtered.map(item => (
              <CollectionCard
                key={item.id}
                name={item.name}
                collectionId={item.id}
                indexKind={item.indexKind}
                status={item.status}
                statusLabel={item.statusLabel}
                stats={item.stats}
                updatedAt={item.updatedAt}
                onOpen={() => onOpen(item.id)}
                onDelete={() => onDelete(item.id)}
              />
            ))}
          </div>
        ) : (
          <table className={styles.table}>
            <caption className={styles.tableCaption}>知识库列表</caption>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">集合标识</th>
                <th scope="col">文档</th>
                <th scope="col">分片</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.id}>
                  <td>
                    <button type="button" className={styles.tableLink} onClick={() => onOpen(item.id)}>
                      {item.name}
                    </button>
                  </td>
                  <td className={`kb-mono ${styles.tableMono}`}>{item.id}</td>
                  <td className={`kb-mono ${styles.tableMono}`}>{formatCount(item.stats.documents)}</td>
                  <td className={`kb-mono ${styles.tableMono}`}>{formatCount(item.stats.chunks)}</td>
                  <td><StatusPill status={item.status} label={item.statusLabel} dense /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.builds} aria-label="构建记录">
        <h3 className={styles.sectionTitle}>构建记录</h3>
        {builds.length === 0 ? (
          <p className={styles.buildsEmpty}>暂无构建记录。构建索引后会在此显示。</p>
        ) : (
          <table className={styles.table}>
            <caption className={styles.tableCaption}>最近的索引构建记录</caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">知识库</th>
                <th scope="col">分片</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {builds.map(record => (
                <tr key={`${record.collectionId}-${record.at}`}>
                  <td className={`kb-mono ${styles.tableMono}`}>{record.at}</td>
                  <td className={`kb-mono ${styles.tableMono}`}>{record.collectionId}</td>
                  <td className={`kb-mono ${styles.tableMono}`}>{formatCount(record.chunks)}</td>
                  <td><StatusPill status={record.status} label={record.statusLabel} dense /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
