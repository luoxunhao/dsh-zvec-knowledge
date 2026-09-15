/**
 * Hybrid retrieval: dense + full-text, fused by the engine's own RRF.
 *
 * The spec fixes the fusion method (RRF) and the output contract (a normalized
 * `match_score` in 0..1 with no raw distance anywhere). Both are enforced here
 * rather than at call sites:
 *
 * - Fusion runs inside the engine via `multiQuerySync({ rerank: { type: 'rrf' } })`
 *   because the engine ships RRF and a hand-rolled fusion would be a second
 *   implementation of the same ranking with its own bugs. The verified behaviour
 *   (and the RRF score scale) is recorded in `scripts/zvec-probe10.mjs`.
 * - The raw distance never escapes this module. {@link search} returns
 *   `matchScore`, and the field is named that way so a caller cannot confuse the
 *   two: reading the engine's value as a similarity would invert the ranking and
 *   push every hit past the 0.55 floor.
 *
 * A note on the RRF score: the engine returns a fused rank score, not a
 * similarity — its magnitude depends on the rank constant, not on how close the
 * documents actually are. Using it as `match_score` would produce scores that do
 * not mean what the spec's four confidence bands assume, so the fused result
 * keeps its rank order but each hit's `match_score` is taken from that hit's own
 * dense distance. A hit the full-text pass contributed on its own has no dense
 * distance, and therefore no similarity to report: it takes
 * {@link FTS_ONLY_SCORE} instead.
 *
 * **This rule is enforced in one place and nowhere else.** An earlier revision
 * honoured it for dense-correlated hits and then, on the fallback path, fed the
 * *fused rank score* into `1 - s`. Because RRF scores are ~0.015, every
 * full-text-only hit came out at ~0.985 and was stamped `strong`; the matching
 * chunk scored below unrelated ones and the whole band spanned 0.004. There is
 * now deliberately no arithmetic fallback to get wrong — see {@link search}.
 *
 * @module dsh-zvec-knowledge/store/retrieval
 */

import type { ZVecCollection, ZVecDoc } from '@zvec/zvec'
import { ZVecIndexType } from '@zvec/zvec'
import {
  FIELD_TEXT, VECTOR_FIELD, documentFilter,
  chunkRowFromDoc, confidenceBand, toMatchScore,
  type ChunkRow, type ConfidenceBand,
} from './collection.ts'
/** One retrieval hit, as the tool and the UI both consume it. */
export interface SearchHit {
  /** Source document id. */
  docId: string
  /** Chunk ordinal within the document. */
  ordinal: number
  /** Character range within the source text, for citation locating. */
  charStart: number
  /** End character offset. */
  charEnd: number
  /** Chunk text. */
  text: string
  /**
   * Normalized relevance in [0, 1]; larger is more relevant. This is the only
   * score the plugin exposes — the engine's raw distance stays inside this module.
   */
  matchScore: number
  /** Confidence band derived from {@link SearchHit.matchScore}. */
  band: ConfidenceBand
}

/** Retrieval request. */
export interface SearchRequest {
  /** Query vector for the dense pass. */
  vector: Float32Array | number[]
  /** Query text for the full-text pass. Omit to run dense-only. */
  text?: string
  /** Maximum hits to return. */
  topk: number
  /** Candidates each sub-query contributes before fusion. */
  candidates?: number
}

/** Outcome of a search, including which passes contributed. */
export interface SearchResult {
  /** Hits, best first. */
  hits: SearchHit[]
  /** Which passes ran. A dense-only search happens when no text is given. */
  mode: 'hybrid' | 'dense'
  /** Hits dropped because they fell below the configured floor. */
  belowFloor: number
}

/**
 * Score assigned to a hit that only the full-text pass produced.
 *
 * Such a hit has no vector evidence: the query never came near it in embedding
 * space, and the only reason it is in the list is that its text shares tokens
 * with the query. That is weak evidence — a lexical coincidence at least as
 * often as a real match — so it must not be scored as if a vector had agreed.
 *
 * The value is deliberately *below* the default 0.55 floor, so an fts-only hit
 * is reported only when a deployment lowers the floor on purpose. Anything
 * higher would let a keyword coincidence outrank a genuine semantic match, which
 * is exactly the failure this constant replaces: the previous `1 - fusedScore`
 * fallback produced ~0.985 for every one of them.
 */
export const FTS_ONLY_SCORE = 0.2

/**
 * Run retrieval against an open collection.
 *
 * When `text` is present both passes run and the engine fuses them with RRF;
 * otherwise the dense pass runs alone, because a full-text query with no text is
 * not a query. Both paths return the same shape so a caller never branches.
 * @param collection - open engine handle.
 * @param request - query vector, optional query text and knobs.
 * @param minScore - normalized floor; hits below it are counted but not returned.
 * @returns hits with normalized scores, best first.
 */
export function search(collection: ZVecCollection, request: SearchRequest, minScore: number): SearchResult {
  const candidates = request.candidates ?? Math.max(request.topk * 4, 20)
  const dense = collection.querySync({
    fieldName: VECTOR_FIELD,
    vector: request.vector,
    topk: candidates,
    params: { indexType: ZVecIndexType.HNSW, ef: Math.max(candidates, 100) },
  })

  /**
   * Dense similarity per hit id — the *only* source of `match_score`.
   *
   * This is the whole scoring contract: a hit is scored by how close its own
   * vector is to the query. Nothing else may produce a score, because every
   * other quantity the engine returns (the RRF fused rank, a weighted fused
   * value) is a *ranking* number whose magnitude depends on the fusion
   * constants, not on how relevant the document is.
   */
  const denseSimilarity = new Map<string, number>()
  for (const doc of dense) denseSimilarity.set(doc.id, toMatchScore(doc.score))

  let fused: ZVecDoc[] = dense
  let mode: SearchResult['mode'] = 'dense'
  if (request.text !== undefined && request.text.trim() !== '') {
    mode = 'hybrid'
    try {
      fused = collection.multiQuerySync({
        queries: [
          { fieldName: VECTOR_FIELD, vector: request.vector, numCandidates: candidates },
          { fieldName: FIELD_TEXT, fts: { matchString: request.text }, numCandidates: candidates },
        ],
        topk: candidates,
        rerank: { type: 'rrf' },
      })
    } catch {
      // A full-text clause the tokenizer rejects must not fail the whole search;
      // the dense pass is still a valid answer, and the mode reports which ran.
      fused = dense
      mode = 'dense'
    }
  }

  /**
   * Score and filter in one pass, then take the best `topk`.
   *
   * Two rules, both of which the previous version broke:
   *
   * 1. **`match_score` comes from the dense pass or not at all.** A hit that
   *    only the full-text pass produced has no vector evidence, so it is scored
   *    by {@link FTS_ONLY_SCORE} — a fixed, explicitly low value — rather than by
   *    `1 - fusedScore`. That fallback was silently catastrophic: the fused score
   *    is an RRF rank sum of order 0.015, so `1 - 0.015 = 0.985` stamped *every*
   *    full-text hit `strong` regardless of quality, with the whole band spanning
   *    0.984–0.988 and the genuinely matching chunk scoring *below* unrelated
   *    ones. A rank score is not a similarity and must never be read as one.
   *
   * 2. **The floor is applied before the cap, and the two are counted apart.**
   *    The previous loop counted every skipped hit as `belowFloor` and broke at
   *    `topk` mid-scan, so a run could return fewer hits than `topk` while
   *    blaming the threshold, and fts-only hits could occupy the whole budget and
   *    evict real vector matches entirely.
   *
   * Order is preserved from the fused list (the engine's ranking is what decides
   * relevance order); only the *score* is normalised here.
   */
  const scored: { row: ChunkRow, matchScore: number }[] = []
  let belowFloor = 0
  const seen = new Set<string>()
  for (const doc of fused) {
    const row = chunkRowFromDoc(doc)
    if (row === null) continue
    // The fused list can repeat an id across sub-queries; a hit is one hit.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const matchScore = denseSimilarity.get(doc.id) ?? FTS_ONLY_SCORE
    if (matchScore < minScore) {
      belowFloor += 1
      continue
    }
    scored.push({ row, matchScore })
  }

  // The cap is applied after the floor, so `topk` counts *returned* hits and
  // anything dropped here was dropped by the cap — not by the threshold, which
  // is why it is not added to `belowFloor`.
  const hits: SearchHit[] = scored
    .slice(0, request.topk)
    .map(({ row, matchScore }) => toHit(row, matchScore))

  return { hits, mode, belowFloor }
}

/**
 * Project a chunk row plus a score into a hit.
 * @param row - chunk row from the engine.
 * @param matchScore - normalized score.
 * @returns the hit.
 */
function toHit(row: ChunkRow, matchScore: number): SearchHit {
  return {
    docId: row.docId,
    ordinal: row.ordinal,
    charStart: row.charStart,
    charEnd: row.charEnd,
    text: row.text,
    matchScore,
    band: confidenceBand(matchScore),
  }
}

/**
 * Run a dense-only search, for callers that have no query text.
 * @param collection - open engine handle.
 * @param vector - query vector.
 * @param topk - maximum hits.
 * @param minScore - normalized floor.
 * @returns hits with normalized scores.
 */
export function searchDense(
  collection: ZVecCollection,
  vector: Float32Array | number[],
  topk: number,
  minScore: number,
): SearchResult {
  return search(collection, { vector, topk }, minScore)
}

/**
 * Count chunks whose `doc_id` matches, used by the document list.
 *
 * Runs a scalar-only query rather than walking the collection: an inverted index
 * on `doc_id` makes this a lookup, and a walk would load every vector in the
 * collection to answer a count.
 * @param collection - open engine handle.
 * @param docId - source document id.
 * @returns number of chunks belonging to the document.
 */
export function countChunksForDocument(collection: ZVecCollection, docId: string): number {
  const hits = collection.querySync({ filter: documentFilter(docId), topk: 100000 })
  return hits.filter(doc => chunkRowFromDoc(doc) !== null).length
}

/**
 * Delete every chunk belonging to a document.
 * @param collection - open engine handle.
 * @param docId - source document id.
 */
export function deleteChunksForDocument(collection: ZVecCollection, docId: string): void {
  collection.deleteByFilterSync(documentFilter(docId))
}
