/**
 * What one probe response says about the endpoint it reached.
 *
 * The probe asks a deliberately-invalid question, so almost every answer is a
 * refusal. The point of this module is that **a refusal and a missing route
 * look nothing alike, and only one of them means the endpoint moved**:
 *
 *   POST {base}/chat/completions on a live route   -> 400 with a validation error
 *   POST {base}/chat/completions on a retired path -> 404
 *   POST {base}/chat/completions with no such key -> 401
 *
 * So route liveness is decided by a narrow rule — a `404`/`405`, or no response
 * at all — and every other status that came back from a server is proof the route
 * is there. That inversion is the whole reason a probe can watch an endpoint
 * without spending a token: the healthy answer is a rejection.
 *
 * Classification is kept pure and separate from the probe so it can be tested
 * exhaustively without a network, and so the precedence rules below live in one
 * readable place instead of being spread across request handlers.
 *
 * @module dsh-llm-opencode-go/health/classify
 */

/** How much a probe learned about the endpoint. */
export const STATE = Object.freeze({
  /** The route answered. */
  ALIVE: 'alive',
  /** The route answered, and something about it needs a person. */
  DEGRADED: 'degraded',
  /** Nothing answers at this path: the endpoint moved or was retired. */
  MOVED: 'moved',
  /** No answer at all: DNS, TLS, a refused connection, or a timeout. */
  UNREACHABLE: 'unreachable',
})

/** The specific finding behind a state. */
export const SIGNAL = Object.freeze({
  OK: 'OK',
  /** The route answered with the validation refusal the probe expects. */
  ROUTE_ALIVE: 'ROUTE_ALIVE',
  /** `404`/`405` on a path this configuration depends on. */
  ROUTE_MOVED: 'ROUTE_MOVED',
  /** The credential is refused, or no credential could be resolved. */
  AUTH_REFUSED: 'AUTH_REFUSED',
  /** The plan is spent, or the relay is throttling. */
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  /** The relay now demands `x-opencode-session` and did not see it. */
  SESSION_HEADER_REQUIRED: 'SESSION_HEADER_REQUIRED',
  /** The route exists; this model is not served over this protocol. */
  PROTOCOL_REJECTED: 'PROTOCOL_REJECTED',
  /** The route exists; the server is unhealthy. */
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
})

/** Statuses that mean the path itself is gone rather than refusing. */
const MOVED_STATUSES = Object.freeze([404, 405, 410])

/** Statuses that name the credential as the problem. */
const AUTH_STATUSES = Object.freeze([401, 403])

/** Statuses that name the plan as the problem. */
const QUOTA_STATUSES = Object.freeze([402, 429])

/**
 * Body text the relay uses for a session-affinity refusal.
 *
 * OpenCode began requiring `x-opencode-session` on every Go request without
 * publishing the change anywhere a client would look for it, which is exactly
 * the class of failure this probe exists to catch. See the plugin's
 * `docs/health.zh-CN.md`.
 */
const SESSION_MARKERS = ['missingsessionid', 'missing session', 'x-opencode-session']

/** Body text the relay uses when a model is not served over this protocol. */
const PROTOCOL_MARKERS = ['modelprotocolunsupported', 'protocol unsupported', 'not supported on this endpoint']

/** Body text the relay uses for a credential refusal. */
const AUTH_MARKERS = ['autherror', 'missing api key', 'invalid_api_key', 'unauthorized', 'invalid api key']

/** Body text the relay uses for a spent plan or a throttled request. */
const QUOTA_MARKERS = ['insufficient balance', 'rate limit', 'rate_limit', 'too many requests', 'quota', 'exceeded your current quota']

/** Parse a JSON error body, tolerating a plain-text or empty one. */
function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Flatten a response into one lowercase haystack.
 *
 * Both the structured envelopes (`{error:{type,code,message}}` and its Anthropic
 * spelling) and a bare string appear in the wild, and a marker can sit in any of
 * them, so every string in the body joins the search rather than the two fields
 * the common shape happens to use.
 *
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {string} lowercase text to search for markers in.
 */
function haystack(raw, text) {
  const parts = []
  const walk = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      parts.push(key)
      walk(item, depth + 1)
    }
  }
  walk(raw, 0)
  if (typeof text === 'string' && text.trim() !== '') parts.push(text)
  return parts.join(' ').toLowerCase()
}

/** The one-line detail a finding carries, for a log line or a page row. */
function detailOf(raw, text) {
  const message = raw?.error?.message
  if (typeof message === 'string' && message !== '') return message
  if (typeof raw?.message === 'string' && raw.message !== '') return raw.message
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return trimmed === '' ? '' : trimmed.slice(0, 200)
}

/** Build one finding. */
function finding(state, signal, detail, extra) {
  return Object.freeze({ state, signal, detail: detail ?? '', ...extra })
}

/**
 * Classify one HTTP answer from a probe request.
 *
 * Precedence is deliberate and ordered from "the endpoint is gone" outwards,
 * because the states are not equally informative: a moved route must never be
 * reported as merely degraded, or a reader would go looking at the key instead of
 * at the URL. Markers outrank the status they accompany, so a `400` that names
 * the session header is reported as the session header rather than as the
 * healthy validation refusal it otherwise would be.
 *
 * @param {object} input - the response, already read.
 * @param {number} input.status - the HTTP status.
 * @param {string} [input.text] - the raw body text.
 * @param {string} [input.url] - the probed URL, carried into the finding.
 * @param {string} [input.protocol] - the protocol whose path was probed.
 * @returns {Readonly<object>} the finding: `state`, `signal`, `detail`, and the echo of what was probed.
 */
export function classifyResponse(input) {
  const status = Number(input?.status)
  const text = typeof input?.text === 'string' ? input.text : ''
  const raw = parseBody(text)
  const body = haystack(raw, text)
  const echo = { status, url: input?.url, protocol: input?.protocol }
  const detail = detailOf(raw, text)

  // 1. The path itself. Checked first, and before any body marker, because a
  //    retired route can answer with a body that happens to name a protocol.
  if (MOVED_STATUSES.includes(status)) {
    return finding(STATE.MOVED, SIGNAL.ROUTE_MOVED, detail || `HTTP ${status}`, echo)
  }

  // 2. Body markers, in the order a reader should act on them. Each of these
  //    proves the route answered, so none of them is `MOVED`.
  if (SESSION_MARKERS.some((marker) => body.includes(marker))) {
    return finding(STATE.DEGRADED, SIGNAL.SESSION_HEADER_REQUIRED, detail || 'the relay requires x-opencode-session', echo)
  }
  if (PROTOCOL_MARKERS.some((marker) => body.includes(marker))) {
    // Alive, not degraded. To answer "this model does not speak this protocol"
    // the relay had to resolve the route *and* the model, which is the strongest
    // possible evidence that the route is there. It is reported as its own signal
    // because it is worth knowing which models a route will not serve, but it is
    // never a warning: a probe that names one model across all three paths earns
    // this on two of them every single round, and a warning that repeats forever
    // is a warning nobody reads.
    return finding(STATE.ALIVE, SIGNAL.PROTOCOL_REJECTED, detail || 'the route does not serve this model over this protocol', echo)
  }
  if (AUTH_STATUSES.includes(status) || AUTH_MARKERS.some((marker) => body.includes(marker))) {
    return finding(STATE.DEGRADED, SIGNAL.AUTH_REFUSED, detail || `HTTP ${status}`, echo)
  }
  if (QUOTA_STATUSES.includes(status) || QUOTA_MARKERS.some((marker) => body.includes(marker))) {
    return finding(STATE.DEGRADED, SIGNAL.QUOTA_EXHAUSTED, detail || `HTTP ${status}`, echo)
  }

  // 3. The server answered and named no condition. Any status at all proves the
  //    route is there: a `400` over a validation refusal is the success case
  //    this probe is built around, and a `5xx` means the route exists and the
  //    service behind it is unwell.
  if (status >= 500) {
    return finding(STATE.DEGRADED, SIGNAL.SERVER_ERROR, detail || `HTTP ${status}`, echo)
  }
  return finding(STATE.ALIVE, SIGNAL.ROUTE_ALIVE, detail === '' ? `HTTP ${status}` : detail, echo)
}

/**
 * Classify a request that never produced a response.
 *
 * A timeout is separated from every other transport failure because the two
 * mean opposite things to a reader: a timeout says nothing about the endpoint,
 * while a refused connection or an unresolvable host says the address is gone.
 *
 * @param {unknown} error - the thrown value from `fetch`.
 * @param {object} [echo] - what was being probed, carried into the finding.
 * @returns {Readonly<object>} the finding.
 */
export function classifyTransport(error, echo = {}) {
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? error ?? 'request failed')
  if (name === 'TimeoutError' || name === 'AbortError' || error?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return finding(STATE.UNREACHABLE, SIGNAL.TIMEOUT, message, { ...echo, status: undefined })
  }
  return finding(STATE.UNREACHABLE, SIGNAL.TRANSPORT, message, { ...echo, status: undefined })
}

/** States ranked worst-last, so a summary can take the strongest of its inputs. */
const STATE_SEVERITY = Object.freeze([STATE.ALIVE, STATE.DEGRADED, STATE.UNREACHABLE, STATE.MOVED])

/**
 * Reduce a set of findings to one verdict.
 *
 * The strongest state wins, because the question a reader has is "is anything
 * wrong", and the worst answer in the set answers it. `MOVED` outranks
 * `UNREACHABLE` so a genuinely relocated endpoint is never softened into "the
 * network was down".
 *
 * @param {readonly Readonly<object>[]} findings - the per-probe findings.
 * @returns {string} one {@link STATE}.
 */
export function worstState(findings) {
  let worst = STATE.ALIVE
  for (const item of findings ?? []) {
    const state = item?.state
    if (!STATE_SEVERITY.includes(state)) continue
    if (STATE_SEVERITY.indexOf(state) > STATE_SEVERITY.indexOf(worst)) worst = state
  }
  return worst
}