/**
 * The citation tab's registration: stage one (what the type IS).
 *
 * Split from the body because the two have different lifetimes. The definition is
 * static — which addresses this type claims, what the chip says — and is
 * registered once for the plugin's fiber. A body is rendered per tab, per session,
 * by the seat. Keeping them apart is what lets the registry answer "who opens
 * this address?" without instantiating any React.
 *
 * The type registers at the `extension` band, which is the band for a type from
 * outside the product and outranks every shipped viewer. That is correct here and
 * not a land grab: the band only applies to addresses this type's globs match, and
 * `dsh-kb-citation://` is a scheme no builtin viewer recognizes — an address in it
 * would otherwise be claimed by nobody, which the registry treats as a wiring
 * error and throws on.
 *
 * @module dsh-zvec-knowledge/client/citation-definition
 */

import { CITATION_KIND, CITATION_SCHEME, citationTitle } from './citation-tab.ts'

/** The subset of the registry's definition shape this module supplies. */
export interface CitationTabDefinition {
  /** This implementation's identity; the key its body registers under. */
  id: string
  /** Type discriminator. */
  kind: string
  /** Address globs this type recognizes. */
  patterns: readonly string[]
  /** Band: `extension` outranks every viewer shipped with the product. */
  priority: 'extension' | 'builtin' | 'fallback'
  /** Veto an address the globs matched. */
  canOpen: (address: string) => boolean
  /** Chip text, captured into the layout record at open time. */
  title: (address: string) => string
}

/**
 * Build the citation tab's registry definition.
 *
 * A glob of `${scheme}**` rather than the scheme alone: the registry's matcher
 * treats a pattern containing `:` as matching the whole address, and a bare scheme
 * with no wildcard would match nothing. `canOpen` then does the real validation,
 * which is where a malformed address is rejected cheaply.
 * @param id - this implementation's identity.
 * @returns the definition to register.
 */
export function citationDefinition(id: string): CitationTabDefinition {
  return {
    id,
    kind: CITATION_KIND,
    patterns: [`${CITATION_SCHEME}**`],
    priority: 'extension',
    // Parsed rather than trusted: this runs on every routing decision, so a
    // malformed address must be a quiet "not mine" and never a throw.
    canOpen: address => address.startsWith(CITATION_SCHEME),
    title: citationTitle,
  }
}
