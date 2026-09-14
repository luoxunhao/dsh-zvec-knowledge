/**
 * dsh-zvec-knowledge — browser half.
 *
 * The client half owns everything the plugin renders inside the web shell: the
 * design-token stylesheets, the component library, and the composed app surface
 * that the KB-04 shell and KB-05 overview reach through.
 *
 * The stylesheets are imported for side effects. tsdown compiles them and the
 * emitted bundle injects one tagged `<style data-plugin-css>` per sheet at
 * factory execution, so the plugin carries its own styles without a host-side
 * asset route.
 *
 * Slot contributions into the harness conversation UI arrive with KB-08 (the
 * retrieval tool's collapsed call block); the KB-04/KB-05 pages are a
 * self-contained surface, so this half currently injects no service. Declaring a
 * required service it does not yet use would only keep the fiber pending.
 *
 * @module dsh-zvec-knowledge/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './styles/tokens.generated.css'
import './styles/base.css'

/** The loader keys this half by the package name plus this suffix. */
export const name = 'zvec-knowledge/client'

export * from './components/index.ts'
export { AppShell, NAV_ITEMS, type NavId, type AppShellProps } from './shell/AppShell.tsx'
export { OverviewPage, type OverviewPageProps, type OverviewCollection, type BuildRecord } from './pages/OverviewPage.tsx'
export {
  KnowledgeBaseApp,
  type KnowledgeBaseAppProps,
  type KnowledgeBasePort,
  type HostCollection,
} from './app.tsx'
export {
  CreateCollectionDialog, type CreateCollectionDialogProps,
} from './dialogs/CreateCollectionDialog.tsx'
export {
  COLLECTION_ID_PATTERN, buildCollectionId, domainFromName, isValidCollectionId,
  shortHash, validateCollectionId, validateCollectionName,
} from './collection-id.ts'
export { formatBytes } from './components/StorageUsageCard.tsx'
export { formatCount } from './components/CollectionCard.tsx'

/** Required client services. See the module note on why this is empty. */
export const inject: string[] = []

/**
 * Attribute marking that the plugin's stylesheet is loaded.
 *
 * Later slices scope shared styles through this marker instead of relying on
 * class-name prefixes alone, and it gives the browser half one observable,
 * disposable effect — which is what makes its lifecycle testable before it
 * renders anything.
 */
const ACTIVE_ATTRIBUTE = 'data-kb-zvec-knowledge'

/**
 * Activate the browser half.
 * @param ctx - client context; the effect is owned by the plugin's fiber and
 * runs its disposer when the fiber is disposed or hot-reloaded.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const root = document.documentElement
    root.setAttribute(ACTIVE_ATTRIBUTE, 'active')
    return () => {
      root.removeAttribute(ACTIVE_ATTRIBUTE)
    }
  }, 'zvec-knowledge: active marker')
}
