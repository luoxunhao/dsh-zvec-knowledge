/**
 * Local declarations of the harness client services this plugin consumes.
 *
 * `ctx.slots` is provided by `@deepseek-ai/dsh-client-ui-renderer`, whose types
 * declare it onto the Cordis `Context` via module augmentation. That package is
 * not a dependency of this plugin (see `slots.ts` for why), so the service is
 * declared here instead.
 *
 * The augmentation is written against `@deepseek-ai/cordis`, which *is* a declared
 * peer and is installed — so this merges with the real `Context` rather than
 * inventing a parallel one.
 *
 * @module dsh-zvec-knowledge/client/services
 */

import type { SlotRegistry } from './slots.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The slot registry.
     *
     * Present only in a browser host that loaded the UI renderer. The plugin
     * declares `slots` in its `inject` list, so the fiber stays pending until the
     * service exists rather than calling into `undefined`.
     */
    slots: SlotRegistry
  }
}
