/**
 * Constants both halves must agree on.
 *
 * These live outside `client/` because the host program excludes that directory,
 * and outside the host modules because the client bundle may not import host code
 * (the purity gate allows only the module table's entries, and a host module pulls
 * Node built-ins into the browser bundle).
 *
 * Sharing one declaration is what keeps a name from being written twice and
 * drifting — and here the drift would be silent: the keyed tool-view slot
 * dispatches by wire tool name, so a mismatched string means the view simply never
 * renders, with no error anywhere.
 *
 * @module dsh-zvec-knowledge/shared/contract
 */

/** Wire name of the knowledge-base retrieval tool. */
export const KB_SEARCH_TOOL = 'dsh_kb_search'

/** The three parameter names the tool accepts and the interface displays. */
export const KB_TOOL_PARAMS = ['query', 'collection', 'topk'] as const

/** One parameter name. */
export type KbToolParam = typeof KB_TOOL_PARAMS[number]
