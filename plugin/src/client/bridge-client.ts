/**
 * The browser half's transport to the host.
 *
 * Implements {@link KnowledgeBasePort} over the host's single bridge route, so the
 * pages stay transport-free and testable with a stub. This module is the *only*
 * place in the client bundle that performs a network call.
 *
 * **Why a bridge at all.** The host owns the store — filesystem plus the zvec
 * binding — and the browser owns rendering. Nothing in the client can read a
 * collection list on its own, so without this the panel renders and every action
 * fails. That was the shipped state: `KnowledgeBasePanel` was mounted with no
 * `port`, so 创建知识库 reported 宿主数据通道未接通.
 *
 * **Cancellation.** Every call takes an `AbortSignal` and forwards it, because the
 * build is long-running and a user who navigates away must stop host-side work.
 *
 * @module dsh-zvec-knowledge/client/bridge-client
 */

import {
  KB_API_PATH, KB_TOKEN_GLOBAL, KB_TOKEN_HEADER,
  KB_UPLOAD_PATH, KB_UPLOAD_COLLECTION_HEADER, KB_UPLOAD_NAME_HEADER, KB_UPLOAD_SIZE_HEADER,
  type KbApiResponse,
} from '../shared/contract.ts'
import type {
  KnowledgeBasePort, HostCollection, HostDocument,
} from './app.tsx'
import type { BuildRecord } from './pages/OverviewPage.tsx'
import type { StorageUsage } from './components/StorageUsageCard.tsx'
import type {
  HostPreview, HostCost, ChunkingDraft, IndexDraft,
} from './pages/BuildPage.tsx'
import type { StageView, LogLine } from './components/BuildPipeline.tsx'
import type { QuotaStateView } from './components/QuotaNotice.tsx'

/** The quota shape the panel expects, as the host reports it. */
type HostQuota = Awaited<ReturnType<NonNullable<KnowledgeBasePort['getQuota']>>>

/**
 * Read the bridge token the host injected into this page.
 *
 * The host writes it as a `globalThis` property through the web server's index
 * injection, so it is present before any plugin bundle runs. It is absent when the
 * page was served without the injection — a static deployment, or a build older
 * than the host — and that case must fail loudly rather than send an empty token.
 * @returns the token.
 * @throws {Error} when the page carries no token.
 */
function readBridgeToken(): string {
  const value = (globalThis as Record<string, unknown>)[KB_TOKEN_GLOBAL]
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      '宿主数据通道未接通：本页没有收到访问令牌。请确认宿主插件已加载，然后刷新页面。',
    )
  }
  return value
}

/**
 * One bridge call.
 *
 * A failure the host *reported* arrives as `ok: false` and is rethrown with the
 * host's own message, because §8.1's error state has to show a real reason. A
 * failure of the transport itself (route absent, host down) is rethrown with the
 * status, since those are different problems and the user's next step differs.
 * @param method - bridge method name.
 * @param args - method arguments.
 * @param signal - caller cancellation.
 * @returns the decoded result.
 * @throws {Error} carrying the host's message, or a transport description.
 */
async function call<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
  // Read per call rather than once at module load: the token belongs to the page,
  // and a cached copy would survive a host restart that minted a new one.
  const token = readBridgeToken()

  let response: Response
  try {
    response = await fetch(KB_API_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [KB_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ method, args }),
      ...(signal === undefined ? {} : { signal }),
      // The endpoint is same-origin and carries live store state; a cached
      // collection list would show a collection the user just deleted.
      cache: 'no-store',
      credentials: 'same-origin',
    })
  } catch (cause) {
    // A cancelled call is not a failure to report: the caller aborted on purpose.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new Error(`宿主数据通道未接通：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  let payload: KbApiResponse<T>
  try {
    payload = await response.json() as KbApiResponse<T>
  } catch {
    throw new Error(`宿主数据通道响应无法解析（HTTP ${response.status}）`)
  }

  if (!payload.ok) throw new Error(payload.error ?? `宿主数据通道调用失败（HTTP ${response.status}）`)
  return payload.result as T
}

/**
 * Build the port backed by the host bridge.
 * @returns a port the panel can use unchanged.
 */
export function createHostPort(): KnowledgeBasePort {
  return {
    listCollections: (): Promise<HostCollection[]> => call('listCollections', {}),

    listBuilds: (): Promise<BuildRecord[]> => call('listBuilds', {}),

    getUsage: (): Promise<StorageUsage> => call('getUsage', {}),

    getQuota: (): Promise<HostQuota> => call('getQuota', {}),

    createCollection: async (values): Promise<void> => {
      await call('createCollection', values)
    },

    deleteCollection: async (id): Promise<void> => {
      await call('deleteCollection', { id })
    },

    listDocuments: (collectionId: string): Promise<HostDocument[]> =>
      call('listDocuments', { collectionId }),

    removeDocument: async (collectionId, id): Promise<void> => {
      await call('removeDocument', { collectionId, id })
    },

    // Uploaded as a stream rather than through `call`, so a large file is never
    // aggregated into a JSON body on either side. Metadata rides in headers, which
    // lets the host refuse the upload before it reads any of the bytes.
    uploadDocument: async (
      collectionId: string,
      file: File,
      onProgress: (fraction: number) => void,
      signal: AbortSignal,
    ): Promise<HostDocument> => {
      const token = readBridgeToken()
      // XHR rather than fetch: fetch cannot report upload progress, and a 32 MB
      // transfer with no progress is a frozen-looking interface. The `File` is
      // handed over as the body, so the browser streams it from disk rather than
      // reading it into a string first.
      return await new Promise<HostDocument>((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('POST', KB_UPLOAD_PATH)
        request.setRequestHeader(KB_TOKEN_HEADER, token)
        request.setRequestHeader(KB_UPLOAD_COLLECTION_HEADER, collectionId)
        request.setRequestHeader(KB_UPLOAD_NAME_HEADER, encodeURIComponent(file.name))
        request.setRequestHeader(KB_UPLOAD_SIZE_HEADER, String(file.size))

        request.upload.addEventListener('progress', event => {
          if (event.lengthComputable && event.total > 0) {
            onProgress(Math.min(1, event.loaded / event.total))
          }
        })

        const onAbort = (): void => request.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        const release = (): void => signal.removeEventListener('abort', onAbort)

        request.addEventListener('load', () => {
          release()
          let payload: KbApiResponse<HostDocument>
          try {
            payload = JSON.parse(request.responseText) as KbApiResponse<HostDocument>
          } catch {
            reject(new Error(`上传响应无法解析（HTTP ${request.status}）`))
            return
          }
          if (!payload.ok || payload.result === undefined) {
            reject(new Error(payload.error ?? `上传失败（HTTP ${request.status}）`))
            return
          }
          onProgress(1)
          resolve(payload.result)
        })
        request.addEventListener('error', () => {
          release()
          reject(new Error('上传失败：宿主数据通道不可达'))
        })
        request.addEventListener('abort', () => {
          release()
          // An AbortError is how the caller distinguishes its own cancellation
          // from a failure worth showing the user.
          reject(new DOMException('上传已取消', 'AbortError'))
        })

        request.send(file)
      })
    },

    previewChunks: (collectionId: string, chunking: ChunkingDraft): Promise<HostPreview> =>
      call('previewChunks', { collectionId, chunking }),

    estimateCost: (collectionId: string, chunking: ChunkingDraft, index: IndexDraft): Promise<HostCost> =>
      call('estimateCost', { collectionId, chunking, index }),

    // The host stores only the index half of the build strategy, so the chunking
    // half comes back as `null` and the caller keeps its current draft rather than
    // having defaults invented for it.
    storedStrategy: async (
      collectionId: string,
    ): Promise<{ chunking: ChunkingDraft, index: IndexDraft } | null> => {
      const stored = await call<{ index: IndexDraft, chunking: ChunkingDraft | null }>(
        'storedStrategy', { collectionId },
      )
      return stored.chunking === null ? null : { chunking: stored.chunking, index: stored.index }
    },

    // The build's progress arrives on the same request that runs it, so this call
    // cannot stream: it resolves once with the outcome. The pipeline is therefore
    // shown as running rather than as a live fraction, and the log carries one line
    // at each boundary so the user can tell the request was accepted. Making it live
    // needs a streaming carrier (SSE on a second route), which is deliberately not
    // in this slice — the honest interface says "running", not a fake percentage.
    buildIndex: async (collectionId, strategy, handlers, signal) => {
      const stages: StageView[] = STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'running' }))
      handlers.onProgress({ stages, processed: 0, total: 0, fraction: 0 })
      handlers.onLog({ at: new Date().toISOString(), level: 'info', message: '已提交构建请求，宿主正在处理…' })

      const result = await call<{ ok: boolean, chunks: number, error?: string }>(
        'buildIndex', { collectionId, strategy }, signal,
      )

      const finished: StageView[] = STAGES.map(id => ({
        id,
        label: STAGE_LABELS[id],
        state: result.ok ? 'done' : 'pending',
      }))
      handlers.onProgress({
        stages: finished,
        processed: result.chunks,
        total: result.chunks,
        fraction: result.ok ? 1 : 0,
      })
      handlers.onLog({
        at: new Date().toISOString(),
        level: result.ok ? 'success' : 'error',
        message: result.ok
          ? `构建完成，已发布 ${result.chunks} 个分片`
          : `构建未完成：${result.error ?? '未知原因'}`,
      })
      return result
    },
  }
}

/**
 * The build pipeline's stages, in order.
 *
 * Duplicated from the host's `STAGES` rather than imported: the client bundle may
 * not import host code (a host module pulls Node built-ins into the browser), and
 * the pipeline is presentation — the host reports an outcome, the interface names
 * the steps it took. The two are asserted equal by `verify-load-safety`.
 */
const STAGES = ['parse', 'chunk', 'index', 'publish'] as const

/** Display names for those stages. */
const STAGE_LABELS: Record<typeof STAGES[number], string> = {
  parse: '解析文档',
  chunk: '切分',
  index: '向量化与索引',
  publish: '发布快照',
}

/** Re-exported so the panel's prop type needs no second import path. */
export type { QuotaStateView }
