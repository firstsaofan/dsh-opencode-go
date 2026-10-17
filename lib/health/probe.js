/**
 * Endpoint health: proving an endpoint is still there, cheaply and early.
 *
 * The problem this exists for: OpenCode Go's API root is **not documented
 * anywhere a client would check**. The published table lists a per-protocol
 * layout (`.../inference/go/openai/v1`, `.../inference/go/anthropic/v1`), while
 * the flat root this adapter has always used (`.../zen/go/v1`) keeps answering.
 * Neither path has a changelog, so a deployment learns about a retirement by
 * discovering that every conversation now fails — which is the worst possible
 * moment to learn it.
 *
 * So the probe watches the endpoint instead of the conversation, and it learns
 * everything it needs from refusals:
 *
 *   - A route that exists answers `400` (the request is deliberately invalid).
 *   - A route that is gone answers `404`.
 *   - No answer at all means DNS, TLS, or a timeout.
 *
 * That distinction costs nothing: the probe sends a body no completion can be
 * generated from, so it never spends a token, and it sends the exact headers
 * generation sends, so a change in the relay's *contract* (a newly required
 * `x-opencode-session`, a per-protocol split) shows up as a finding rather than
 * as a mystery.
 *
 * Three things are deliberately not done here. It never issues a request that
 * could generate. It never writes the credential anywhere — the file it keeps
 * holds only hostnames, statuses, and signals. And it never takes responsibility
 * for a call: a probe finding is diagnosis attached to a failure, not a retry
 * that might succeed where the real request did not.
 *
 * @module dsh-llm-opencode-go/health/probe
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { HEALTH_RETRY_LADDER, PROTOCOLS, PROTOCOL_LIST } from '../config.js'
import { classifyResponse, classifyTransport, SIGNAL, STATE, worstState } from './classify.js'
import * as anthropic from '../protocol/anthropic-messages.js'
import * as chat from '../protocol/chat-completions.js'
import * as responses from '../protocol/responses.js'
import { protocolAuthHeaders } from '../protocol/auth.js'
import { identityHeaders } from '../session/headers.js'

/** File format version; a mismatch discards the file instead of guessing. */
const HEALTH_VERSION = 1

/** How many past rounds the file keeps, so a trend survives a restart. */
const HISTORY_LIMIT = 20

/** The statuses that make the circuit breaker stop scheduled rounds. */
const TRIPPED_STATES = Object.freeze([STATE.MOVED, STATE.UNREACHABLE])

/** Consecutive bad rounds before scheduled rounds stop entirely. */
const TRIP_AFTER = 3

/**
 * Where each protocol posts, relative to an API root.
 *
 * Read from the three protocol modules rather than repeated, so a path the
 * adapter stops using cannot still be watched: the probe and generation quote
 * the same constant.
 */
export const PROTOCOL_PATHS = Object.freeze([
  Object.freeze({ protocol: PROTOCOLS.CHAT, path: chat.PATH }),
  Object.freeze({ protocol: PROTOCOLS.RESPONSES, path: responses.PATH }),
  Object.freeze({ protocol: PROTOCOLS.ANTHROPIC, path: anthropic.PATH }),
])

/**
 * Endpoint layouts this probe knows how to check, beyond the configured root.
 *
 * These exist so the probe can answer "and what do I set instead?" at the moment
 * it discovers the current root is gone. Each entry lists the protocols that
 * layout is documented to serve, which is what makes the split per protocol
 * visible before anyone has to read the vendor's table.
 *
 * **The order is a preference, and it matters.** Candidates are tried in this
 * order and the first complete match wins the suggestion, so the layouts the
 * vendor actually publishes come before the legacy flat root. Recommending the
 * documented address for a documented layout is the whole point: pointing a
 * reader back at an alias that is already gone from their documentation would
 * hand them the same problem a second time.
 *
 * A candidate is only probed after the configured root has already failed, so
 * these cost nothing while things work.
 */
export const KNOWN_LAYOUTS = Object.freeze([
  Object.freeze({
    baseURL: 'https://opencode.ai/inference/go/openai/v1',
    protocols: Object.freeze([PROTOCOLS.CHAT, PROTOCOLS.RESPONSES]),
  }),
  Object.freeze({
    baseURL: 'https://opencode.ai/inference/go/anthropic/v1',
    protocols: Object.freeze([PROTOCOLS.ANTHROPIC]),
  }),
  Object.freeze({
    baseURL: 'https://opencode.ai/zen/go/v1',
    protocols: Object.freeze([PROTOCOLS.CHAT, PROTOCOLS.RESPONSES, PROTOCOLS.ANTHROPIC]),
  }),
])

/**
 * The default retry ladder, in seconds.
 *
 * Re-exported from the configuration module rather than declared here, so that a
 * deployment's ladder and the probe's own fallback can never be two different
 * defaults. The reasoning for its shape lives beside the constant itself.
 */
export { HEALTH_RETRY_LADDER as DEFAULT_RETRY_LADDER }

/** A short probe timeout; the probe asks a question, it does not wait for a model. */
const DEFAULT_TIMEOUT_SECONDS = 15

/**
 * Resolve the on-disk health file: `~/.dsh/cache/opencode-go-health.json`.
 *
 * It sits beside the model cache and the usage file so everything this plugin
 * writes lands in one directory a person can inspect or delete.
 *
 * @param {object} config - the resolved plugin configuration.
 * @returns {string} an absolute path.
 */
export function healthPath(config) {
  return config.healthPath ?? join(homedir(), '.dsh', 'cache', 'opencode-go-health.json')
}

/**
 * A request body no completion can be generated from.
 *
 * Every shape carries an empty conversation, which each of the three APIs
 * rejects during validation — before any model runs. That is what makes the
 * healthy answer a `400` and the probe free. The output cap is set anyway, so
 * that even a lenient relay which accepted an empty conversation would produce
 * nothing of substance.
 *
 * The model id is a real one where the catalog knows one, because a synthetic id
 * would earn a `404` for a reason that has nothing to do with the endpoint, and
 * a false relocation is worse than no answer. Which model it is makes no
 * difference to liveness: `ModelProtocolUnsupported` still proves the route is
 * there, and the probe reads it as such.
 *
 * @param {string} protocol - a protocol id from `config.js`.
 * @param {string} model - the model id to name.
 * @returns {object} the request body.
 */
export function probeBody(protocol, model) {
  if (protocol === PROTOCOLS.RESPONSES) return { model, input: [], max_output_tokens: 1 }
  if (protocol === PROTOCOLS.ANTHROPIC) return { model, max_tokens: 1, messages: [] }
  return { model, messages: [], max_tokens: 1 }
}

/** Distinct, order-preserving signal names. */
function uniqueSignals(findings) {
  const seen = []
  for (const item of findings) {
    if (item?.signal !== undefined && !seen.includes(item.signal)) seen.push(item.signal)
  }
  return seen
}

/**
 * Whether a finding is one a person should be told about.
 *
 * `ROUTE_ALIVE` is the success case and would otherwise be the noisiest signal of
 * all, since it is what every healthy round reports three times.
 *
 * @param {Readonly<object>} finding - one classification result.
 * @returns {boolean} whether the finding warrants a log line.
 */
function noteworthy(finding) {
  return finding?.state !== STATE.ALIVE && finding?.signal !== SIGNAL.ROUTE_ALIVE
}

/**
 * Describe what to set instead, when the configured root no longer serves.
 *
 * The suggestion is only offered when a known layout answered on every protocol
 * this deployment would have lost, because a partial answer produces a config
 * that looks plausible and fails on the models nobody tested. It always carries
 * the structural note, because that is the part no probe can fix for the reader:
 * this adapter has one `baseURL`, and a layout that serves protocols from
 * different hosts needs one route per host.
 *
 * @param {object} input - the round's findings.
 * @param {readonly Readonly<object>[]} input.candidates - what the candidates answered.
 * @param {string} input.baseURL - the configured root that failed.
 * @returns {Readonly<object> | undefined} the suggestion, or undefined when there is nothing to suggest.
 */
function suggestionFor({ candidates, baseURL, lostProtocols }) {
  if (lostProtocols.length === 0) return undefined
  // A suggestion is only offered when every lost protocol has somewhere to go.
  // A partial answer produces a configuration that looks plausible and then fails
  // on the models nobody tested, which is worse than saying nothing: the reader
  // would apply it and lose the evidence that it did not work.
  const usable = candidates.filter((candidate) => candidate.complete)
  const servedBy = (protocol) => usable.find((candidate) => candidate.served.includes(protocol))
  const uncovered = lostProtocols.filter((protocol) => servedBy(protocol) === undefined)
  if (uncovered.length > 0) return undefined
  return Object.freeze({
    code: 'BASE_URL_MOVED',
    // The paths, not the protocol ids: this string is what a reader greps for in
    // the log, and `anthropic` would not match anything they have seen on the wire.
    detail: `${baseURL} no longer serves ${lostProtocols.map((p) => pathOf(p)).join(', ')}`,
    note: 'This adapter resolves one baseURL per route, so a layout that serves '
      + 'different protocols from different roots needs one route per root.',
    routes: Object.freeze(lostProtocols.map((protocol) => ({
      protocol,
      path: pathOf(protocol),
      baseURL: servedBy(protocol).baseURL,
    }))),
  })
}

/** The wire path a protocol posts to, for messages a reader will recognize. */
function pathOf(protocol) {
  return PROTOCOL_PATHS.find((entry) => entry.protocol === protocol)?.path ?? protocol
}

/**
 * Create the endpoint-health probe.
 *
 * One probe per plugin instance, sharing the adapter's lifetime. It keeps no
 * timer until {@link start} is called, so a deployment that never asked for
 * scheduled checks never runs any.
 *
 * @param {object} deps - injected collaborators.
 * @param {object} deps.config - the resolved plugin configuration.
 * @param {object} deps.sessionState - process-lifetime state from `session/headers.js`.
 * @param {() => Promise<string>} deps.resolveApiKey - the credential resolver.
 * @param {() => Promise<readonly {id: string, protocols?: readonly string[], hidden?: boolean}[]>} [deps.modelIds] - catalog rows, so each probe can name a model its route serves.
 * @param {typeof fetch} [deps.fetch] - the fetch implementation, for tests.
 * @param {object} [deps.logger] - a Cordis-style logger.
 * @param {() => number} [deps.now] - the clock, for tests.
 * @returns {Readonly<object>} the probe.
 */
export function createHealthProbe(deps) {
  const { config, sessionState, resolveApiKey } = deps
  const logger = deps.logger
  const now = deps.now ?? (() => Date.now())
  const doFetch = deps.fetch ?? globalThis.fetch

  /** @type {Readonly<object> | undefined} the last completed round. */
  let report
  /** @type {Promise<Readonly<object>> | undefined} the round in flight. */
  let inflight
  let consecutiveBadRounds = 0
  let tripped = false
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  /** @type {readonly Readonly<object>[]} */
  let history = []

  const timeoutMs = () => Math.min(
    config.timeoutMs,
    (config.healthTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  )

  /**
   * The credential, or undefined when none can be resolved.
   *
   * A probe that cannot authenticate still has something to report: a route that
   * answers `401` is a route that is alive. So a missing key degrades the probe
   * instead of ending it, and says so rather than guessing.
   */
  async function apiKeyOrUndefined() {
    try {
      return await resolveApiKey()
    } catch (error) {
      logger?.info?.(
        'dsh-llm-opencode-go: health probe has no credential (%s): %s',
        config.apiKeyEnv,
        error?.message ?? String(error),
      )
      return undefined
    }
  }

  /** Headers identical to a real call's, except that the answer may be JSON. */
  function headersFor(protocol, apiKey) {
    const identity = identityHeaders(config, sessionState, config.userAgent, undefined)
    return {
      'content-type': 'application/json',
      ...(apiKey === undefined ? {} : protocolAuthHeaders(protocol, apiKey, { accept: 'application/json' })),
      ...identity,
    }
  }

  /**
   * One request against one path.
   *
   * Reads a bounded prefix of the body: the whole point is the status and a short
   * marker, and a relay that streams a refusal anyway should not be able to hold
   * the probe open.
   */
  async function probePath(baseURL, protocol, apiKey, model) {
    const url = `${baseURL}${PROTOCOL_PATHS.find((entry) => entry.protocol === protocol)?.path ?? ''}`
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: headersFor(protocol, apiKey),
        body: JSON.stringify(probeBody(protocol, model)),
        // A redirect off the configured root is itself a relocation, and
        // following it would hide the very fact being watched.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs()),
      })
      const text = await response.text().catch(() => '')
      return classifyResponse({
        status: response.status,
        text: text.slice(0, 2000),
        url,
        protocol,
      })
    } catch (error) {
      return classifyTransport(error, { url, protocol })
    }
  }

  /** Probe every protocol path of one layout, concurrently. */
  async function probeLayout(baseURL, protocols, apiKey, models) {
    const entries = await Promise.all(
      protocols.map(async (protocol) => ({
        protocol,
        finding: await probePath(baseURL, protocol, apiKey, modelFor(models, protocol)),
      })),
    )
    const served = entries.filter((entry) => entry.finding.state !== STATE.MOVED).map((entry) => entry.protocol)
    return {
      baseURL,
      protocols: [...protocols],
      findings: Object.fromEntries(entries.map((entry) => [entry.protocol, entry.finding])),
      served,
      complete: served.length === protocols.length,
    }
  }

  /**
   * Which model id to name for each protocol.
   *
   * A body has to name *a* model, and the obvious choice — one model for all three
   * paths — earns `ModelProtocolUnsupported` on every path that model does not
   * speak. That is harmless to correctness and noisy to a reader, so the probe
   * prefers a model reachable over all three protocols when the catalog knows one,
   * and otherwise names a model each protocol actually serves.
   */
  async function probeModels() {
    let rows = []
    try {
      rows = (await deps.modelIds?.()) ?? []
    } catch {
      // A catalog read that fails leaves the name unimportant, not the probe.
      rows = []
    }
    const usable = rows.filter((row) => typeof row?.id === 'string' && row.id !== '' && row?.hidden !== true)
    const universal = usable.find((row) => Array.isArray(row.protocols) && row.protocols.length >= PROTOCOL_LIST.length)?.id
    const byProtocol = {}
    for (const protocol of PROTOCOL_LIST) {
      byProtocol[protocol] = usable.find((row) => Array.isArray(row.protocols) && row.protocols.includes(protocol))?.id
        ?? usable[0]?.id
    }
    return { universal, byProtocol }
  }

  /** The model id for one protocol's probe body. */
  function modelFor(models, protocol) {
    return models.universal ?? models.byProtocol[protocol] ?? 'dsh-health-probe'
  }

  /** Candidates to try, excluding the configured root this round just lost. */
  function candidatesFor() {
    if (config.healthCandidates === 'off') return []
    const configured = config.healthCandidates === 'custom'
      ? (Array.isArray(config.healthCandidateURLs) ? config.healthCandidateURLs : [])
      : KNOWN_LAYOUTS.map((layout) => layout.baseURL)
    const seen = new Set([config.baseURL])
    return configured.filter((baseURL) => {
      if (typeof baseURL !== 'string' || baseURL === '' || seen.has(baseURL)) return false
      seen.add(baseURL)
      return true
    })
  }

  /**
   * Run one round.
   *
   * Collapses concurrent callers onto one round: a scheduled tick landing on top
   * of a traffic-triggered one must not become two rounds' worth of requests,
   * because the second would learn nothing the first did not just learn.
   *
   * @param {object} [options] - why this round ran.
   * @param {string} [options.reason] - `startup`, `scheduled`, `traffic`, or `manual`.
   * @returns {Promise<Readonly<object>>} the round's report.
   */
  function run(options = {}) {
    if (inflight !== undefined) return inflight
    const reason = options.reason ?? 'manual'
    inflight = round(reason)
      .catch((error) => ({
        version: HEALTH_VERSION,
        checkedAt: now(),
        reason,
        baseURL: config.baseURL,
        state: STATE.UNREACHABLE,
        signals: [SIGNAL.TRANSPORT],
        detail: error?.message ?? String(error),
        routes: [],
        nextDueAt: undefined,
        tripped,
      }))
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  async function round(reason) {
    const apiKey = await apiKeyOrUndefined()
    const models = await probeModels()
    const primary = await probeLayout(config.baseURL, PROTOCOL_LIST, apiKey, models)
    const primaryFindings = Object.values(primary.findings)
    const lostProtocols = Object.entries(primary.findings)
      .filter(([, finding]) => finding.state === STATE.MOVED)
      .map(([protocol]) => protocol)

    // Candidates are probed only once something is already wrong: while the
    // configured root serves every protocol, a candidate's answer would be a
    // second copy of the same good news.
    const candidates = []
    if (lostProtocols.length > 0 || primaryFindings.some((finding) => finding.state === STATE.UNREACHABLE)) {
      for (const baseURL of candidatesFor()) {
        const protocols = KNOWN_LAYOUTS.find((layout) => layout.baseURL === baseURL)?.protocols ?? PROTOCOL_LIST
        const layout = await probeLayout(baseURL, protocols, apiKey, models)
        candidates.push({ ...layout, protocols: [...protocols] })
      }
    }

    const allFindings = [...primaryFindings, ...candidates.flatMap((layout) => Object.values(layout.findings))]
    const state = worstState(allFindings)
    const signals = uniqueSignals(allFindings)

    if (state === STATE.ALIVE) {
      consecutiveBadRounds = 0
      tripped = false
    } else if (state === STATE.DEGRADED) {
      // A degraded route is still answering, so keep watching it on the normal
      // schedule: a key that was fixed, or a header this adapter starts sending,
      // must be able to clear the finding without a restart.
      consecutiveBadRounds = 0
    } else if (state === STATE.MOVED || state === STATE.UNREACHABLE) {
      consecutiveBadRounds += 1
      if (consecutiveBadRounds >= TRIP_AFTER) tripped = true
    }

    const report = {
      version: HEALTH_VERSION,
      checkedAt: now(),
      reason,
      baseURL: config.baseURL,
      state,
      signals,
      apiKeyResolved: apiKey !== undefined,
      routes: [primary, ...candidates],
      suggestion: suggestionFor({ candidates, baseURL: config.baseURL, lostProtocols }),
      nextDueAt: tripped ? undefined : now() + delayMs(state),
      tripped,
    }

    history = [...history, { checkedAt: report.checkedAt, reason, state, signals }].slice(-HISTORY_LIMIT)
    report.history = history
    await save(report)
    announce(report)
    return report
  }

  /**
  * How long until the next scheduled round.
  *
  * A route that answered at all waits the full interval, degraded included: a
  * refused credential or a newly-required header is a fact about this
  * deployment, not about the endpoint's location, and it is fixed by a person
  * rather than by waiting — so re-checking it every thirty seconds would only
  * spend requests until they act. The ladder belongs to the case where the
  * endpoint itself is in question.
  */
  function delayMs(state) {
    if (state === STATE.ALIVE || state === STATE.DEGRADED) return config.healthIntervalSeconds * 1000
    const ladder = config.healthRetrySeconds ?? DEFAULT_RETRY_LADDER
    const step = Math.min(consecutiveBadRounds, ladder.length) - 1
    return (ladder[Math.max(step, 0)] ?? ladder[ladder.length - 1]) * 1000
  }

  /** One log line per round, only when something is wrong. */
  function announce(result) {
    for (const layout of result.routes) {
      for (const [protocol, finding] of Object.entries(layout.findings)) {
        if (!noteworthy(finding)) continue
        // Without a credential, every route refuses with 401 — which is the
        // probe's liveness answer, not a fault. Warning about it would put three
        // lines in the log every round on any deployment that has not stored a
        // key yet, and a warning that repeats forever stops being read. The
        // finding is still recorded, because liveness was still learned.
        if (finding.signal === SIGNAL.AUTH_REFUSED && result.apiKeyResolved !== true) continue
        logger?.warn?.(
          'dsh-llm-opencode-go: health %s %s %s — %s',
          layout.baseURL,
          protocol,
          finding.signal,
          finding.detail,
        )
      }
    }
    if (result.suggestion !== undefined) {
      logger?.warn?.(
        'dsh-llm-opencode-go: health %s — %s. %s Suggested roots: %s',
        result.suggestion.code,
        result.suggestion.detail,
        result.suggestion.note,
        result.suggestion.routes.map((route) => `${route.protocol} → ${route.baseURL}`).join(', '),
      )
    }
  }

  /** Persist the round; a failure is a warning, never a request failure. */
  async function save(result) {
    const path = healthPath(config)
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({
        version: HEALTH_VERSION,
        baseURL: config.baseURL,
        checkedAt: result.checkedAt,
        state: result.state,
        signals: result.signals,
        routes: result.routes,
        suggestion: result.suggestion,
        history: result.history,
      }), 'utf8')
    } catch (error) {
      logger?.warn?.(
        'dsh-llm-opencode-go: could not write the health file at %s: %s',
        path,
        error?.message ?? String(error),
      )
    }
  }

  /** Read the last round off disk, once, so a restart shows a history. */
  async function load() {
    try {
      const parsed = JSON.parse(await readFile(healthPath(config), 'utf8'))
      if (parsed?.version !== HEALTH_VERSION) return
      history = Array.isArray(parsed.history) ? parsed.history : []
      if (typeof parsed.checkedAt === 'number' && typeof parsed.state === 'string') {
        report = { ...parsed, fromFile: true }
      }
    } catch {
      // Missing, unreadable, or corrupt: there is simply no earlier round.
    }
  }

  /**
   * Watch real traffic, and probe the moment it fails in a way that looks like
   * the endpoint rather than the request.
   *
   * This is the trigger that matters: it fires at the exact moment a session
   * breaks, so a relocation is reported while the reader is already looking at
   * the failure rather than hours later. A refusal that names the request — a
   * context overflow, a spent plan — is left alone, because probing it would
   * only re-report what the caller was already told.
   *
   * @param {object} input - what the adapter saw.
   * @param {number} [input.status] - the refusal's HTTP status.
   * @param {string} [input.text] - the refusal's body text.
   * @returns {Promise<Readonly<object> | undefined>} the round, when one ran.
   */
  async function noteTrafficFailure(input) {
    if (config.healthCheck === 'off') return undefined
    const looksLikeEndpoint = Number(input?.status) === 404 || Number(input?.status) === 405
    if (!looksLikeEndpoint && typeof input?.text === 'string' && !/not found|no such endpoint|unknown route|invalid url|endpoint/i.test(input.text)) {
      return undefined
    }
    logger?.warn?.(
      'dsh-llm-opencode-go: a request was refused in a way that can mean the endpoint moved;'
      + ' probing the configured routes now (status %s)',
      String(input?.status ?? 'none'),
    )
    return run({ reason: 'traffic' })
  }

  /** Start the scheduled rounds, and return the disposer that stops them. */
  function start() {
    if (timer !== undefined || config.healthCheck !== 'scheduled') return () => {}
    timer = setInterval(() => {
      if (tripped) return
      void run({ reason: 'scheduled' }).catch(() => {})
    }, config.healthIntervalSeconds * 1000)
    // The probe is a background observer; it must never be the reason a process
    // refuses to exit.
    timer.unref?.()
    return () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
  }

  return Object.freeze({
    run,
    start,
    load,
    noteTrafficFailure,
    /** The last round, answered from memory. */
    report: () => report,
    /** Whether scheduled rounds are currently suspended. */
    tripped: () => tripped,
  })
}

/**
 * The credential-and-catalog check lives in `index.js`, next to the adapter it
 * reads.
 *
 * It answers a different question from this module's probe — "is *my catalog*
 * usable" against "is the *endpoint* still there" — and it needs the adapter,
 * so it stays where the adapter is built rather than being imported from here.
 */