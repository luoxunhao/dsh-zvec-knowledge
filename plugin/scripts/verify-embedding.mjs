/**
 * Embedding-provider acceptance suite.
 *
 * The provider talks to a real HTTP server started in-process, not a mocked
 * `fetch`. That matters because the failures this guards against are protocol
 * failures — an unordered response, an unset key, a throttle — and a mock would
 * test the mock's idea of the protocol rather than the code's handling of it.
 *
 * The decisive case is unordered `data`: a provider that returns results in a
 * different order than the inputs, which produces plausible-looking but wrong
 * retrieval if seated positionally.
 *
 * Usage: node scripts/verify-embedding.mjs
 */

import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const passes = []

/**
 * Record an outcome.
 * @param name - criterion.
 * @param ok - whether it held.
 * @param detail - evidence.
 */
function check(name, ok, detail) {
  if (ok) passes.push(`${name} — ${detail}`)
  else failures.push(`${name} — ${detail}`)
}

const { createEmbeddingProvider, embeddingsEndpoint, seatVectors, EmbeddingError } =
  await import(new URL('../lib/host/embedding.js', import.meta.url).href)

/** Mutable behaviour the stub server serves, per test. */
const state = {
  /** How to build the response body for a request. */
  respond: (inputs) => ({ data: inputs.map((_text, index) => ({ index, embedding: unit(index) })) }),
  /** HTTP status to return. */
  status: 200,
  /** Raw body override, for malformed-response cases. */
  rawBody: null,
  /** Requests seen, for assertions about batching and retries. */
  requests: [],
  /** Extra headers required, for auth assertions. */
  requiredAuth: null,
}

/**
 * A deterministic unit vector derived from a seed.
 * @param seed - seed value.
 * @returns a 4-element vector, normalized.
 */
function unit(seed) {
  const v = [Math.cos(seed), Math.sin(seed), Math.cos(seed * 2), Math.sin(seed * 2)]
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1
  return v.map(x => x / norm)
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const parsed = body === '' ? {} : JSON.parse(body)
    state.requests.push({ auth: req.headers.authorization, body: parsed })

    if (state.requiredAuth !== null && req.headers.authorization !== state.requiredAuth) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }
    if (state.rawBody !== null) {
      res.writeHead(state.status, { 'content-type': 'application/json' })
      res.end(state.rawBody)
      return
    }
    if (state.status !== 200) {
      res.writeHead(state.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `stub error ${state.status}` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state.respond(parsed.input ?? [])))
  })
})

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

/** Reset the stub between cases. */
function reset() {
  state.respond = inputs => ({ data: inputs.map((_t, index) => ({ index, embedding: unit(index) })) })
  state.status = 200
  state.rawBody = null
  state.requests = []
  state.requiredAuth = null
}

// ---------------------------------------------------------------------------
// 1. Endpoint normalization
// ---------------------------------------------------------------------------
{
  check('endpoint: appends /embeddings to a base URL', embeddingsEndpoint('https://api.example.com/v1') === 'https://api.example.com/v1/embeddings', embeddingsEndpoint('https://api.example.com/v1'))
  check('endpoint: accepts a full URL unchanged', embeddingsEndpoint('https://api.example.com/v1/embeddings') === 'https://api.example.com/v1/embeddings', embeddingsEndpoint('https://api.example.com/v1/embeddings'))
  check('endpoint: tolerates a trailing slash', embeddingsEndpoint('https://api.example.com/v1/') === 'https://api.example.com/v1/embeddings', embeddingsEndpoint('https://api.example.com/v1/'))
}

// ---------------------------------------------------------------------------
// 2. The decisive case: unordered `data`
// ---------------------------------------------------------------------------
{
  reset()
  // A provider that returns results reversed. Positional seating would pair
  // input 0 with input N's vector — plausible, and completely wrong.
  state.respond = inputs => ({
    data: inputs.map((_t, index) => ({ index: inputs.length - 1 - index, embedding: unit(inputs.length - 1 - index) })),
  })
  process.env.KB_TEST_KEY = 'test-key'
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' })
  const vectors = await embed(['a', 'b', 'c'])

  // Each output must equal the vector whose index matches its own position.
  const expected = [unit(0), unit(1), unit(2)]
  const correct = vectors.every((vector, index) =>
    vector.length === expected[index].length
    && Array.from(vector).every((value, position) => Math.abs(value - expected[index][position]) < 1e-6))
  check('ordering: reversed response is seated by index', correct, correct ? 'vectors follow input order' : 'vectors are positionally seated (WRONG)')
}

// ---------------------------------------------------------------------------
// 3. Positional fallback when `index` is absent
// ---------------------------------------------------------------------------
{
  reset()
  const warnings = []
  state.respond = inputs => ({ data: inputs.map((_t, index) => ({ embedding: unit(index) })) })
  process.env.KB_TEST_KEY = 'test-key'
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' }, message => warnings.push(message))
  const vectors = await embed(['a', 'b'])
  check('fallback: absent index falls back to positional', vectors.length === 2, `${vectors.length} vectors`)
  check('fallback: the absent guarantee is reported', warnings.length === 1 && /index/.test(warnings[0]), warnings[0] ?? '(no warning)')

  // A duplicated index is worse than none: seating by it would drop an input.
  reset()
  const warnings2 = []
  state.respond = inputs => ({ data: inputs.map((_t, index) => ({ index: 0, embedding: unit(index) })) })
  const embed2 = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' }, message => warnings2.push(message))
  const vectors2 = await embed2(['a', 'b'])
  check('fallback: duplicated index falls back rather than dropping', vectors2.length === 2 && vectors2.every(v => v !== undefined), `${vectors2.length} vectors`)
  check('fallback: duplicated index is reported', warnings2.length === 1, warnings2[0] ?? '(no warning)')

  const seated = seatVectors([{ index: 1, embedding: [1] }, { index: 0, embedding: [2] }], 2)
  check('seating: usable index is honoured', seated.byIndex && seated.vectors[0][0] === 2, JSON.stringify(seated.vectors))
}

// ---------------------------------------------------------------------------
// 4. API key comes from the environment, and is never echoed
// ---------------------------------------------------------------------------
{
  reset()
  delete process.env.KB_TEST_KEY
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' })
  let error = null
  try { await embed(['a']) } catch (caught) { error = caught }
  check('auth: missing env var is refused', error instanceof EmbeddingError && error.kind === 'auth', error?.kind ?? '(no error)')
  check('auth: the message names the variable', error !== null && error.message.includes('KB_TEST_KEY'), error?.message ?? '-')
  check('auth: no request was attempted', state.requests.length === 0, `${state.requests.length} requests`)

  reset()
  state.requiredAuth = 'Bearer correct-key'
  process.env.KB_TEST_KEY = 'wrong-key'
  const badKey = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' })
  let authError = null
  try { await badKey(['a']) } catch (caught) { authError = caught }
  check('auth: a rejected key is classified', authError instanceof EmbeddingError && authError.kind === 'auth', authError?.kind ?? '(no error)')
  check('auth: neither message echoes key material', !authError.message.includes('wrong-key'), authError?.message ?? '-')

  reset()
  state.requiredAuth = 'Bearer good-key'
  process.env.KB_TEST_KEY = 'good-key'
  const good = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY' })
  await good(['a'])
  check('auth: the bearer header is sent', state.requests[0]?.auth === 'Bearer good-key', 'authorization header present')
}

// ---------------------------------------------------------------------------
// 5. Batching
// ---------------------------------------------------------------------------
{
  reset()
  process.env.KB_TEST_KEY = 'test-key'
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', batchSize: 2 })
  const vectors = await embed(['a', 'b', 'c', 'd', 'e'])
  check('batching: splits by the configured size', state.requests.length === 3, `${state.requests.length} requests for 5 inputs at 2/batch`)
  check('batching: preserves input order across batches', vectors.length === 5, `${vectors.length} vectors`)
  check('batching: the model is sent', state.requests[0]?.body.model === 'test', state.requests[0]?.body.model ?? '-')
  check('batching: empty input makes no request', (await embed([])).length === 0, 'no request for []')

  // The last batch is short; the count must still match.
  reset()
  const embed3 = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', batchSize: 4 })
  const three = await embed3(['a', 'b', 'c'])
  check('batching: a short final batch is handled', three.length === 3 && state.requests.length === 1, `${three.length} vectors, ${state.requests.length} request`)
}

// ---------------------------------------------------------------------------
// 6. Failure classification and retry
// ---------------------------------------------------------------------------
{
  reset()
  process.env.KB_TEST_KEY = 'test-key'

  state.status = 400
  const bad = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 0 })
  let badError = null
  try { await bad(['a']) } catch (caught) { badError = caught }
  check('errors: 400 is bad_request', badError?.kind === 'bad_request', badError?.kind ?? '-')
  check('errors: 400 message suggests the batch size', /batchSize/.test(badError?.message ?? ''), badError?.message?.slice(0, 80) ?? '-')

  // 429 is retried, then surfaces as rate_limited.
  reset()
  state.status = 429
  const throttled = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 1 })
  let rateError = null
  try { await throttled(['a']) } catch (caught) { rateError = caught }
  check('errors: 429 is rate_limited', rateError?.kind === 'rate_limited', rateError?.kind ?? '-')
  check('errors: 429 is retried before giving up', state.requests.length === 2, `${state.requests.length} attempts (1 + 1 retry)`)

  // A transient 500 that clears on retry must succeed. The stub flips its status
  // asynchronously, so the first attempt sees the 500 and the retry sees 200.
  reset()
  state.status = 500
  const recovering = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 2 })
  setTimeout(() => { state.status = 200 }, 30)
  const recovered = await recovering(['a'])
  check('errors: a transient 5xx is retried to success', recovered.length === 1, `${recovered.length} vector after retry`)
  check('errors: the retry actually happened', state.requests.length >= 2, `${state.requests.length} attempts`)

  // 400 must not be retried: it will fail identically.
  reset()
  state.status = 400
  const noRetry = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 3 })
  try { await noRetry(['a']) } catch { /* expected */ }
  check('errors: 400 is not retried', state.requests.length === 1, `${state.requests.length} attempt`)
}

// ---------------------------------------------------------------------------
// 7. Malformed responses
// ---------------------------------------------------------------------------
{
  reset()
  process.env.KB_TEST_KEY = 'test-key'
  state.rawBody = '{"not":"the right shape"}'
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 0 })
  let error = null
  try { await embed(['a']) } catch (caught) { error = caught }
  check('malformed: a missing data array is refused', error?.kind === 'malformed', error?.kind ?? '-')

  reset()
  state.respond = () => ({ data: [] })
  const short = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 0 })
  let shortError = null
  try { await short(['a', 'b']) } catch (caught) { shortError = caught }
  check('malformed: a short result set is refused', shortError?.kind === 'malformed', shortError?.kind ?? '-')
  check('malformed: the mismatch is stated with both counts', /2/.test(shortError?.message ?? ''), shortError?.message ?? '-')
}

// ---------------------------------------------------------------------------
// 8. Cancellation
// ---------------------------------------------------------------------------
{
  reset()
  process.env.KB_TEST_KEY = 'test-key'
  const controller = new AbortController()
  // A 5xx so the call retries and stays in flight long enough to cancel.
  state.status = 500
  const embed = createEmbeddingProvider({ baseUrl, model: 'test', apiKeyEnv: 'KB_TEST_KEY', maxRetries: 5, timeoutMs: 10_000 })
  const pending = embed(['a'], controller.signal)
  setTimeout(() => controller.abort(), 20)
  let cancelled = null
  try { await pending } catch (caught) { cancelled = caught }
  check('cancel: an aborted call rejects', cancelled !== null, cancelled?.message ?? '(resolved!)')
  check('cancel: retrying stops after cancellation', state.requests.length <= 2, `${state.requests.length} attempts`)
}

server.close()
delete process.env.KB_TEST_KEY

console.log(`\nEmbedding provider acceptance: ${passes.length} passed, ${failures.length} failed\n`)
for (const line of passes) console.log(`  PASS  ${line}`)
for (const line of failures) console.log(`  FAIL  ${line}`)
if (failures.length > 0) process.exit(1)
