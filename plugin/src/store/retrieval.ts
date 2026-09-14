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
 * dense distance.
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
   * Dense distance per hit id. The fused list arrives without comparable scores,
   * so each hit's own dense distance is what becomes its `match_score`.
   */
  const denseScore = new Map<string, number>()
  for (const doc of dense) denseScore.set(doc.id, toMatchScore(doc.score))

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

  const hits: SearchHit[] = []
  let belowFloor = 0
  for (const doc of fused) {
    const row = chunkRowFromDoc(doc)
    if (row === null) continue
    // A full-text-only hit has no dense distance, so fall back to its fused
    // rank-derived value; it still needs a bounded normalized score.
    const matchScore = denseScore.get(doc.id) ?? toMatchScore(doc.score)
    if (matchScore < minScore) {
      belowFloor += 1
      continue
    }
    hits.push({ ...toHit(row, matchScore) })
    if (hits.length >= request.topk) break
  }

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
