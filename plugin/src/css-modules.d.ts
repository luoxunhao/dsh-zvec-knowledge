/**
 * Stylesheet module declarations for the client program.
 *
 * The browser bundle never sees these imports as modules: tsdown rewrites
 * `*.module.css` into its hashed class map and `*.css` into a tagged style
 * injector (see tsdown.config.ts). tsc still has to type them, and the client
 * tsconfig deliberately carries no bundler types, so the shapes are declared
 * here.
 */

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
