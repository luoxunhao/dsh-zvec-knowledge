/**
 * Local declaration of the harness host service this plugin consumes.
 *
 * `ctx.webServer` and the `webserver/index-inject` event are provided by
 * `@deepseek-ai/dsh-host-webserver`, whose types declare them onto the Cordis
 * `Context` via module augmentation. That package is not a dependency of this
 * plugin — a third-party plugin targets the *installed harness*, not a pinned
 * version of every internal package — so the two facts are declared here instead.
 *
 * The augmentation is written against `@deepseek-ai/cordis`, which *is* a declared
 * peer, so it merges with the real `Context` rather than inventing a parallel one.
 * This mirrors `client/services.ts`, which declares `ctx.slots` for the same reason.
 *
 * Only the members this plugin actually uses are declared. A fuller mirror would be
 * a second copy of someone else's API to keep in sync, and would silently diverge.
 *
 * @module dsh-zvec-knowledge/host/services
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The harness web server.
     *
     * Optional because a headless profile has no web server at all: the plugin
     * binds its bridge route through `ctx.inject(['webServer'], ...)`, so this
     * being absent must be a supported state rather than a type error.
     */
    webServer?: {
      /** Register an exact route; returns the disposer that removes it. */
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
  }

  interface Events {
    /**
     * Collect the structured index-injection table.
     *
     * Emitted on every index render; listeners append their current rows, so a
     * row's data is read fresh at emit time. This is where the bridge token reaches
     * the page — `__DSH_BOOT__` carries the plugin manifest and has no per-plugin
     * data slot.
     * @param table - mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: {
      kind: string
      name?: string
      value?: unknown
      placement?: string
      text?: string
      src?: string
      html?: string
    }[]): void
  }
}

export {}
