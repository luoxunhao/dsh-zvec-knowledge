/**
 * Narrow declaration for the one Node global the browser half reads.
 *
 * The client tsconfig deliberately installs no Node types (`"types": []`), so a
 * value that only exists at build time still has to be declared for tsc.
 * tsdown's `define` replaces `process.env.NODE_ENV` with a literal before
 * bundling, so this global never exists at runtime — which is exactly why the
 * declaration is narrow: reading anything else off `process` is a mistake the
 * type system should reject, not accommodate.
 */

declare const process: {
  readonly env: {
    /** Replaced by tsdown with the literal build mode; `undefined` in a dev build is read as development. */
    readonly NODE_ENV?: string
  }
}
