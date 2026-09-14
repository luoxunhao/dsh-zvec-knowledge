/**
 * DocumentsPage — 链路② 文档接入（design spec §5.2, §6.3）.
 *
 * The page owns the upload lifecycle, and the interesting part is that a
 * *transfer* and an *index status* are two different axes. A file can be fully
 * uploaded (transfer done) and still be 待构建; it can also fail to upload, in
 * which case there is no document at all. Modelling them as one enum would force
 * a fake value on one axis, so they are separate fields and this module keeps them
 * so.
 *
 * Cancellation is real cancellation, not a hidden transfer: the reader's `cancel`
 * is called, the partial read is discarded, and the row returns to a state that
 * offers retry. The spec's requirement is that cancel "真正中止在途上传，并回到可重试
 * 状态" — a cancel that leaves a background transfer running would pass a naive
 * test and fail the intent.
 *
 * @module dsh-zvec-knowledge/client/pages/DocumentsPage
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { DocumentRow, type DocumentRowData, type TransferState } from '../components/DocumentRow.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Icon } from '../components/Icon.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { UploadDropzone } from '../components/UploadDropzone.tsx'
import type { StatusKind } from '../components/StatusPill.tsx'
import styles from './DocumentsPage.module.css'

/** Accepted formats, mirroring the host store's list. */
export const ACCEPTED_EXTENSIONS = ['md', 'markdown', 'txt', 'pdf', 'docx', 'html', 'htm', 'json', 'csv'] as const

/** Size ceiling in bytes, mirroring the host store. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/** Human-readable ceiling for the drop zone's secondary line. */
export const MAX_UPLOAD_LABEL = '32 MB'

/** One document as the page holds it. */
export interface PageDocument {
  /** Stable id. */
  id: string
  /** File name. */
  name: string
  /** Size in bytes. */
  bytes: number
  /** Lower-case extension. */
  ext: string
  /** Index lifecycle status. */
  status: StatusKind
  /** Chunks indexed, or `null` while genuinely unknown. */
  chunks: number | null
  /** Failure reason from the last attempt, when there was one. */
  error?: string
}

/** Upload transport supplied by the caller. */
export interface UploadTransport {
  /**
   * Transfer one file, reporting progress, and resolve with the stored document.
   * @param file - the file.
   * @param onProgress - progress in [0, 1].
   * @param signal - aborted when the user cancels.
   */
  upload: (
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<PageDocument>
}

/** Options accepted by {@link DocumentsPage}. */
export interface DocumentsPageProps {
  /** Documents already stored. */
  documents: PageDocument[]
  /** Upload transport; omit to disable intake. */
  transport?: UploadTransport
  /** Called when a stored document should be removed. */
  onRemove: (id: string) => void
  /** Whether the surrounding data is still loading. */
  loading?: boolean
  /** Load failure, if any. */
  error?: string | null
  /** Retry loading. */
  onRetry?: () => void
  /** Whether a collection is selected; intake is disabled without one. */
  collectionId?: string | null
}

/** Status filter options. */
const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待构建' },
  { value: 'ready', label: '已构建' },
  { value: 'failed', label: '失败' },
] as const

/** Human labels for lifecycle states. */
const STATUS_LABELS: Record<StatusKind, string> = {
  ready: '已构建',
  building: '构建中',
  failed: '失败',
  pending: '待构建',
  info: '信息',
}

/** One in-flight or settled transfer. */
interface Transfer {
  /** File name, shown while the document does not exist yet. */
  name: string
  /** Size in bytes. */
  bytes: number
  /** Extension. */
  ext: string
  /** Transfer state. */
  state: TransferState
  /** Progress in [0, 1]. */
  progress: number
  /** Failure reason on the transfer axis. */
  error?: string
  /** The file, retained so a retry can re-send it without re-picking. */
  file: File
  /** Controller for the in-flight transfer. */
  controller?: AbortController
}

/**
 * Lower-case extension of a file name.
 * @param name - file name.
 * @returns the extension, or an empty string.
 */
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const at = base.lastIndexOf('.')
  if (at <= 0 || at === base.length - 1) return ''
  return base.slice(at + 1).toLowerCase()
}

/**
 * Validate a file before transferring it.
 *
 * Returns the reason *including the accepted range*, because the spec forbids a
 * bare rejection — "格式不支持" with no list leaves the user nothing to act on.
 * @param file - the candidate.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateUpload(file: { name: string, size: number }): string | null {
  const ext = extensionOf(file.name)
  if (ext === '') {
    return `无法识别文件类型：「${file.name}」没有扩展名。支持 ${ACCEPTED_EXTENSIONS.join(' / ')}`
  }
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `不支持的格式 .${ext}。支持 ${ACCEPTED_EXTENSIONS.join(' / ')}`
  }
  if (file.size <= 0) {
    // States the floor as well as the ceiling: a rejection that only says "empty"
    // leaves the user with no idea what to bring instead.
    return `文件为空，没有可索引的内容（可接受 1 B 至 ${MAX_UPLOAD_LABEL}）`
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const size = file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`
    return `文件 ${size} 超出上限 ${MAX_UPLOAD_LABEL}`
  }
  return null
}

/**
 * Render the documents page.
 * @param props - stored documents, transport and callbacks.
 * @returns the page.
 */
export function DocumentsPage({
  documents, transport, onRemove, loading = false, error = null, onRetry, collectionId = null,
}: DocumentsPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('all')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  // Transfers are keyed by name because the document does not exist until the
  // upload completes; the name is what the user recognises in the row.
  const transfersRef = useRef(new Map<string, Transfer>())

  /** Replace one transfer in state, by name. */
  const updateTransfer = useCallback((name: string, patch: Partial<Transfer>): void => {
    setTransfers(previous => previous.map(item => (item.name === name ? { ...item, ...patch } : item)))
  }, [])

  /** Start (or restart) one file's transfer. */
  const startTransfer = useCallback((file: File): void => {
    const controller = new AbortController()
    const entry: Transfer = {
      name: file.name,
      bytes: file.size,
      ext: extensionOf(file.name),
      state: 'uploading',
      progress: 0,
      file,
      controller,
    }
    transfersRef.current.set(file.name, entry)
    setTransfers(previous => {
      const index = previous.findIndex(item => item.name === file.name)
      if (index === -1) return [...previous, entry]
      const next = [...previous]
      next[index] = entry
      return next
    })

    if (transport === undefined) return
    void transport.upload(file, fraction => {
      // A late progress tick from an aborted transfer must not revive a row the
      // user has already cancelled.
      if (controller.signal.aborted) return
      updateTransfer(file.name, { progress: fraction })
    }, controller.signal).then(
      () => { updateTransfer(file.name, { state: 'done', progress: 1 }) },
      (cause: unknown) => {
        if (controller.signal.aborted) {
          updateTransfer(file.name, { state: 'cancelled', error: '已取消，可重试' })
          return
        }
        updateTransfer(file.name, {
          state: 'failed',
          error: String(cause instanceof Error ? cause.message : cause),
        })
      },
    )
  }, [transport, updateTransfer])

  /** Accept files: validate each, and reject with a reason rather than silently. */
  const accept = useCallback((files: File[]): void => {
    for (const file of files) {
      const reason = validateUpload(file)
      if (reason !== null) {
        setTransfers(previous => [
          ...previous,
          { name: file.name, bytes: file.size, ext: extensionOf(file.name), state: 'failed', progress: 0, error: reason, file },
        ])
        continue
      }
      startTransfer(file)
    }
  }, [startTransfer])

  /** Cancel an in-flight transfer. */
  const cancel = useCallback((name: string): void => {
    const entry = transfersRef.current.get(name)
    // Aborting is what actually stops the transfer; recording the state without
    // it would leave the request running while the UI claimed otherwise.
    entry?.controller?.abort()
    updateTransfer(name, { state: 'cancelled', error: '已取消，可重试' })
  }, [updateTransfer])

  /** Retry a cancelled or failed transfer. */
  const retry = useCallback((name: string): void => {
    const entry = transfersRef.current.get(name)
    if (entry === undefined) return
    // Re-validate: the reason may have been the file, and retrying a rejected
    // file would just fail again with the same message.
    const reason = validateUpload(entry.file)
    if (reason !== null) {
      updateTransfer(name, { state: 'failed', error: reason })
      return
    }
    startTransfer(entry.file)
  }, [startTransfer, updateTransfer])

  /** Dismiss a settled transfer row. */
  const dismiss = useCallback((name: string): void => {
    transfersRef.current.delete(name)
    setTransfers(previous => previous.filter(item => item.name !== name))
  }, [])

  const rows: DocumentRowData[] = useMemo(() => {
    const uploaded: DocumentRowData[] = documents.map(document => ({
      id: document.id,
      name: document.name,
      bytes: document.bytes,
      ext: document.ext,
      status: document.status,
      statusLabel: STATUS_LABELS[document.status],
      chunks: document.chunks,
      transfer: 'done',
      progress: 1,
      error: document.error,
    }))
    // Transfers that already produced a document are dropped: the stored row is
    // the truth, and showing both would double-count a file.
    const storedNames = new Set(documents.map(document => document.name))
    const pending: DocumentRowData[] = transfers
      .filter(transfer => transfer.state !== 'done' || !storedNames.has(transfer.name))
      .map(transfer => ({
        id: `transfer:${transfer.name}`,
        name: transfer.name,
        bytes: transfer.bytes,
        ext: transfer.ext,
        status: transfer.state === 'failed' ? 'failed' : 'pending',
        statusLabel: STATUS_LABELS[transfer.state === 'failed' ? 'failed' : 'pending'],
        chunks: null,
        transfer: transfer.state,
        progress: transfer.progress,
        error: transfer.error,
      }))
    return [...pending, ...uploaded]
  }, [documents, transfers])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter(row => {
      if (status !== 'all') {
        const matches = status === 'ready' ? row.status === 'ready' : row.status === status
        if (!matches) return false
      }
      return needle === '' || row.name.toLowerCase().includes(needle)
    })
  }, [rows, query, status])

  const uploading = rows.filter(row => row.transfer === 'uploading' || row.transfer === 'queued').length
  const noCollection = collectionId === null || collectionId === undefined

  return (
    <div className={styles.page}>
      <UploadDropzone
        onFiles={accept}
        accepted={ACCEPTED_EXTENSIONS}
        maxSizeLabel={MAX_UPLOAD_LABEL}
        disabled={noCollection}
        uploadingCount={rows.filter(row => row.transfer === 'uploading' || row.transfer === 'queued').length}
      />

      {noCollection && (
        <p className={styles.notice} role="status">
          <Icon name="info" size={14} /> 请先在「总览」中选择一个知识库，再上传文档。
        </p>
      )}

      <div className={styles.toolbar}>
        <div className={styles.toolbarSearch}>
          <SearchField
            value={query}
            onValueChange={setQuery}
            label="筛选文档"
            placeholder="按文件名筛选"
          />
        </div>
        <SegmentedControl
          label="文档状态筛选"
          options={STATUS_FILTERS.map(item => ({ value: item.value, label: item.label }))}
          value={status}
          onChange={setStatus}
        />
        {/* A live count of in-flight transfers: with per-row progress, the user
            needs one place that says "two are still going". */}
        {uploading > 0 && (
          <span className={`kb-mono ${styles.uploading}`} role="status">{uploading} 个上传中</span>
        )}
      </div>

      {error !== null ? (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}><Icon name="alert" size={16} /> 无法读取文档列表</p>
          <p className={styles.errorBody}>{error}</p>
          {onRetry !== undefined && <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>}
        </div>
      ) : loading ? (
        <ul className={styles.list} aria-busy="true" aria-label="正在加载文档">
          {[0, 1, 2].map(index => <li key={index} className={styles.skeleton} />)}
        </ul>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="file"
          title="还没有文档"
          description="把文档拖到上方区域或点击选择文件，上传后即可构建索引。"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="filter"
          title="没有匹配的文档"
          description="当前筛选条件下没有结果，清空筛选可恢复全部文档。"
          action={<Button variant="secondary" onClick={() => { setQuery(''); setStatus('all') }}>清空筛选</Button>}
        />
      ) : (
        <ul className={styles.list}>
          <li className={styles.head} aria-hidden="true">
            <span>类型</span>
            <span>文件名</span>
            <span>分片数</span>
            <span>状态</span>
            <span />
          </li>
          {filtered.map(row => (
            <DocumentRow
              key={row.id}
              row={row}
              onCancel={name => cancel(name.replace(/^transfer:/, ''))}
              onRetry={name => retry(name.replace(/^transfer:/, ''))}
              onRemove={id => (id.startsWith('transfer:') ? dismiss(id.replace(/^transfer:/, '')) : onRemove(id))}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
