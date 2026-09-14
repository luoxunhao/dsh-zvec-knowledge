/**
 * dsh-zvec-knowledge — browser half.
 *
 * The client half owns everything the plugin renders inside the web shell. In
 * this first slice that is exactly one thing: the design-token stylesheet.
 * Tokens have to be present before any component exists, because the design
 * spec forbids hardcoded colours and sizes in component styles — a component
 * written before the tokens land would have to be rewritten.
 *
 * The stylesheets are imported for side effects. tsdown compiles them and the
 * emitted bundle injects one tagged `<style data-plugin-css>` per sheet at
 * factory execution, so the plugin carries its own styles without a host-side
 * asset route.
 *
 * Slot contributions (overview page, collection detail, retrieval test) arrive
 * with KB-04 onwards and will add `'slots'` to {@link inject} at that point;
 * declaring a required service this half does not yet use would only keep the
 * fiber pending for no benefit.
 *
 * @module dsh-zvec-knowledge/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './styles/tokens.generated.css'
import './styles/base.css'

/** The loader keys this half by the package name plus this suffix. */
export const name = 'zvec-knowledge/client'

export * from './components/index.ts'

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
