/**
 * dsh-zvec-knowledge — browser half.
 *
 * The plugin integrates into the harness web shell as **two contributions that
 * address each other**:
 *
 * 1. `sidebar.panellist` — a global panel icon row in the left sidebar, labelled
 *    知识库. The sidebar owns the button; this plugin supplies the label metadata.
 * 2. `main` — a keyed main-panel entry under the key `knowledge`, which is the
 *    destination that row opens.
 *
 * They are one feature split across two slots because that is the shell's own
 * shape: the sidebar holds the address, the main column holds the body, and the
 * list entry's `id` *is* the panel key it selects. Registering both under the
 * same string is what makes them one destination.
 *
 * `ctx.slots.inject(key, register)` is used rather than a bare `register`
 * because the two owner entries are mounted by the sidebar and layout packages:
 * activation order between plugins is not guaranteed, and registering into a slot
 * that is not yet declared throws. `inject` waits for the declaration.
 *
 * @module dsh-zvec-knowledge/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './styles/tokens.generated.css'
import './styles/base.css'
import { KnowledgeBasePanel } from './panel.tsx'
import { createHostPort } from './bridge-client.ts'
import { SearchToolView, type SearchToolViewProps } from './SearchToolView.tsx'
import {
  KNOWLEDGE_LABEL, KNOWLEDGE_ORDER, KNOWLEDGE_PANEL_KEY, KNOWLEDGE_SIDEBAR_ID,
} from './panel-id.ts'
import { KnowledgeIcon } from './panel-icon.tsx'
import { KB_SEARCH_TOOL } from '../shared/contract.ts'

/** The loader keys this half by the package name plus this suffix. */
export const name = 'zvec-knowledge/client'

// The declaration shims must be loaded for their `declare module` side effects
// before any register call is type-checked.
import './slots.ts'
import './services.ts'

export * from './components/index.ts'
export { AppShell, NAV_ITEMS, type NavId, type AppShellProps } from './shell/AppShell.tsx'
export { OverviewPage, type OverviewPageProps, type OverviewCollection, type BuildRecord } from './pages/OverviewPage.tsx'
export {
  KnowledgeBaseApp,
  type KnowledgeBaseAppProps,
  type KnowledgeBasePort,
  type HostCollection,
  type HostDocument,
} from './app.tsx'
export {
  DocumentsPage, ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL,
  validateUpload,
  type DocumentsPageProps, type PageDocument, type UploadTransport,
} from './pages/DocumentsPage.tsx'
export {
  DocumentRow, formatChunks, formatSize,
  type DocumentRowData, type DocumentRowProps, type TransferState,
} from './components/DocumentRow.tsx'
export { UploadDropzone, type UploadDropzoneProps } from './components/UploadDropzone.tsx'
export { NumberField, type NumberFieldProps } from './components/NumberField.tsx'
export { ChunkPreview, type ChunkPreviewProps, type PreviewRowData } from './components/ChunkPreview.tsx'
export { CostEstimate, type CostEstimateProps } from './components/CostEstimate.tsx'
export {
  BuildPipeline, formatLogTime,
  type BuildPipelineProps, type LogLine, type StageId, type StageState, type StageView,
} from './components/BuildPipeline.tsx'
export {
  BuildPage, validateChunkingDraft,
  type BuildPageProps, type ChunkingDraft, type IndexDraft,
  type HostPreview, type HostCost, type HostModelOption, type HostQuantizerOption,
} from './pages/BuildPage.tsx'
export {
  CreateCollectionDialog, type CreateCollectionDialogProps,
} from './dialogs/CreateCollectionDialog.tsx'
export {
  COLLECTION_ID_PATTERN, buildCollectionId, domainFromName, isValidCollectionId,
  shortHash, validateCollectionId, validateCollectionName,
} from './collection-id.ts'
export { formatBytes } from './components/StorageUsageCard.tsx'
export { formatCount } from './components/CollectionCard.tsx'
export { KnowledgeBasePanel } from './panel.tsx'
export { RetrievalPage, type RetrievalPageProps } from './pages/RetrievalPage.tsx'
export {
  KNOWLEDGE_LABEL, KNOWLEDGE_ORDER, KNOWLEDGE_PANEL_KEY, KNOWLEDGE_SIDEBAR_ID,
  type MainPanelId,
} from './panel-id.ts'

/**
 * Required client services.
 *
 * `slots` is required, and that is load-bearing: without the registry there is
 * nothing to register into, and the plugin's entire visible surface would be
 * absent. Declaring it keeps the fiber pending until the registry exists rather
 * than silently doing nothing.
 */
export const inject: string[] = ['slots']

/**
 * The panel store, shared between the sidebar row and the main panel.
 *
 * Module-level because the two slots are separate React trees that must agree on
 * which sub-view the panel is showing, and `slots.register` has no channel for
 * passing state between two entries of different slots. A module singleton is the
 * honest shape for "one instance per loaded plugin"; a store per registration
 * would give the sidebar row and the panel different copies of the same state.
 */
const panelState = createPanelState()

/**
 * Which view inside the knowledge panel is showing.
 *
 * `rag` is absent rather than merely hidden: KB-09's revised scope places RAG
 * answering in the dsh conversation, so the panel has no Q&A surface to select.
 * `retrieval` is present and is a different thing — a diagnostic console for
 * judging chunking and recall, which generates no answer.
 */
export type KnowledgeView = 'overview' | 'documents' | 'build' | 'retrieval' | 'settings'

/** Observable selection shared by the panel's own shell and its sidebar row. */
export interface PanelState {
  /** Current view. */
  get: () => KnowledgeView
  /** Switch view and notify subscribers. */
  set: (view: KnowledgeView) => void
  /** Subscribe to changes. */
  subscribe: (listener: () => void) => () => void
}

/**
 * Create the shared selection holder.
 *
 * Deliberately not a React context or a framework store: both slots are mounted
 * by different owners, so there is no common React ancestor to hang a provider
 * from. A tiny observable is the smallest thing that works across that boundary.
 * @returns the state holder.
 */
function createPanelState(): PanelState {
  let view: KnowledgeView = 'overview'
  const listeners = new Set<() => void>()
  return {
    get: () => view,
    set: (next) => {
      if (next === view) return
      view = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Activate the browser half.
 *
 * Both registrations are returned to the fiber as one disposer, so unbinding the
 * plugin removes its sidebar row and its panel together — the row must never
 * outlive the panel it addresses, or clicking it would ask the layout service to
 * select a panel that no longer exists.
 * @param ctx - client context; registrations are owned by the plugin's fiber.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // The host's data channel, built once and shared by every registration: it is
    // stateless apart from `fetch`, and a second instance would only mean a second
    // copy of the same route string.
    //
    // Without this the panel mounts with no `port`, renders its shell, and fails
    // every action with 宿主数据通道未接通 — which is precisely the bug this fixes.
    const port = createHostPort()

    const disposePanel = ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: KNOWLEDGE_PANEL_KEY },
      () => <KnowledgeBasePanel state={panelState} port={port} />,
    ))

    const disposeRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: KNOWLEDGE_SIDEBAR_ID,
        order: KNOWLEDGE_ORDER,
        label: KNOWLEDGE_LABEL,
      },
      ({ size, active }: { size: number, active: boolean }) => (
        <KnowledgeIcon size={size} active={active} />
      ),
    ))

    // The retrieval call's own view inside a turn. Keyed by the wire tool name,
    // which nothing else occupies, so this is additive rather than a takeover.
    const disposeToolView = ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key: KB_SEARCH_TOOL },
      (props: { callId: string, toolName: string, block: SearchToolViewProps['block'], cwd?: string }) => (
        <SearchToolView {...props} />
      ),
    ))

    return () => {
      // The panel is disposed first: with the row gone, nothing can select a
      // panel that is no longer registered. The tool view goes last because it is
      // the surface a live turn is most likely to be rendering.
      disposePanel()
      disposeRow()
      disposeToolView()
    }
  }, 'zvec-knowledge: sidebar entry, main panel and retrieval tool view')

  // Stylesheet presence marker. It gives the browser half one observable,
  // disposable effect, which is what makes its lifecycle testable, and later
  // slices scope shared styles through it instead of relying on class prefixes.
  ctx.effect(() => {
    const root = document.documentElement
    root.setAttribute('data-kb-zvec-knowledge', 'active')
    return () => {
      root.removeAttribute('data-kb-zvec-knowledge')
    }
  }, 'zvec-knowledge: active marker')
}

/** Shared panel selection, exported for tests and for the panel component. */
export { panelState }
