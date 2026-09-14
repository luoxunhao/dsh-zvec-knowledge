/**
 * Browser client bundle for dsh-zvec-knowledge.
 *
 * Mirrors the DeepSeek Harness client-bundle protocol
 * (`packages/client/tsdown.client.ts` in the official checkout, which third
 * party packages cannot import): the artifact is a CJS closure factory handed
 * to `window.__ModuleLoader__.load({ id, factory })`, and every external is
 * resolved through the loader's frozen module table rather than through
 * globals or an import map.
 *
 * Three rules are enforced here rather than left to review:
 *
 * - **Purity gate.** the baseline module table plus this package's own
 *   `dsh.client.external` requests stay external; inline-safe wire layers and
 *   generated `/remote` contributions inline; every other `@deepseek-ai/*`
 *   value import fails the build. A cross-plugin value import would either
 *   inline a duplicate runtime instance or ask the module table for a
 *   specifier it cannot answer.
 * - **CSS Modules** compile through lightningcss and export a hashed class
 *   map.
 * - **Plain and `?inline` stylesheets** inject a tagged `<style
 *   data-plugin-css>` at factory execution, so a bundle carries its own
 *   styles without a host-side asset route.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * Shared browser platform modules. Copied from the authority
 * `packages/client/web/src/platform.ts` of the official checkout
 * (0.1.5-rc.2, HEAD c291e7961a) because a third-party package cannot import
 * that module: it is not an export. Re-check it when the harness moves.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Client-bundle factories the parser preloads before the shell starts (empty in 0.1.5-rc.2). */
const PRELOADED_CLIENT_EXTERNALS: string[] = []

/** Contract layers and pure folds a client bundle may inline (no shared runtime identity). */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-agent-presets\/display$|@deepseek-ai\/dsh-spill-policy\/notice$)/

/** Vendored framework libraries: rescoped, but ordinary libraries a bundle inlines. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/** Path segment a package's sources hang under, used to rebase emitted assets. */
const SOURCE_MARKER = `${sep}src${sep}`

/** The manifest is the single source for the plugin id, so a rename cannot desync the browser half. */
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  dsh?: { client?: { external?: unknown } }
}
const PLUGIN_ID: string = manifest.name

/** Explicit module-table requests this package adds on top of the baseline. */
const REQUESTED_EXTERNALS: ReadonlySet<string> = new Set(
  Array.isArray(manifest.dsh?.client?.external) ? (manifest.dsh.client.external as string[]) : [],
)

/** Every specifier the loader module table answers for this package. */
const CLIENT_EXTERNALS: ReadonlySet<string> = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...REQUESTED_EXTERNALS,
])

/**
 * Emit one plugin-owned style injector plus an optional CSS Modules class map.
 * @param id - plugin id stamped onto the injected style tag.
 * @param fileId - physical stylesheet path, used for the tag identity.
 * @param css - compiled stylesheet text.
 * @param classMap - hashed local-to-emitted class names, omitted for global CSS.
 * @returns module source for the virtual stylesheet id.
 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}`
  const srcIndex = emitted.indexOf(marker)
  if (srcIndex !== -1) {
    const srcPath = `${emitted.slice(0, srcIndex)}${sep}src${sep}${emitted.slice(srcIndex + marker.length)}`
    if (existsSync(srcPath)) return srcPath
  }
  return source
}

const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/client/index.js' },
  // Single artifact dir: the browser bundle lands next to the node half, and
  // the pinned entryFileNames keeps it exactly lib/client.js. clean must stay
  // off, or a default clean would wipe the node-half output emitted before it.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (id: string) => CLIENT_EXTERNALS.has(id),
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.has(id),
  },
  inputOptions: {
    resolve: {
      conditionNames: [
        (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
  },
  // Browser bundles inline node-idiom dependencies that read process.env.NODE_ENV
  // or probe import.meta.env; a CJS output cannot carry import.meta, so both
  // substitutions must be baked in or the factory throws at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.has(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the platform module table or ${PLUGIN_ID}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
        + '(type-only imports are erased and never reach this gate)',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = readFileSync(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // Sorted so the emitted map is byte-stable: lightningcss promises no
      // export order, and an unstable one rewrites lib/client.js on every build.
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(PLUGIN_ID, fileId, code.toString(), classMap)
    },
  }, {
    name: 'dsh-css-text-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
      const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
      const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
      return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = readFileSync(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return `export default ${JSON.stringify(code.toString())};`
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = readFileSync(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return styleInjectionModule(PLUGIN_ID, fileId, code.toString())
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
