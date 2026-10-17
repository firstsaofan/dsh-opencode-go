/**
 * Endpoint health: classification precedence, probe scheduling, and the
 * migration suggestion.
 *
 * The cases here are mostly about one inversion — a refusal proves a route is
 * alive, a `404` proves it is not — because getting that backwards turns a
 * healthy endpoint into an alarming one and a retired one into a silent one.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOLS, resolveConfig } from '../../lib/config.js'
import { SIGNAL, STATE, classifyResponse, classifyTransport, worstState } from '../../lib/health/classify.js'
import { KNOWN_LAYOUTS, PROTOCOL_PATHS, createHealthProbe, healthPath, probeBody } from '../../lib/health/probe.js'
import { equal, includes, is, ok } from '../helpers.mjs'

/** A config with health on and everything else defaulted. */
function config(overrides = {}) {
  return resolveConfig({ healthCheck: 'both', healthTimeoutSeconds: 1, ...overrides })
}

/**
 * A fetch stand-in that answers per URL.
 *
 * `answers` maps a URL — either in full, or as a path suffix — to
 * `{ status, body }`, with full URLs matched first so a specific answer can
 * override a general one. An unmapped URL 404s, which is the honest default for a
 * probe: an endpoint nobody stubbed is an endpoint that has gone.
 */
function stubFetch(answers, log = []) {
  const entries = Object.entries(answers)
  return async (url, init) => {
    const target = String(url)
    log.push({ url: target, method: init?.method, headers: init?.headers, body: init?.body })
    const hit = entries.find(([key]) => target === key)
      ?? entries.find(([key]) => target.endsWith(key))
    if (hit === undefined) return response(404, { error: { message: 'Not Found' } })
    return response(hit[1].status, hit[1].body)
  }
}

function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => text,
  }
}

/** A probe over a temporary health file, so nothing touches a real cache dir. */
async function withProbe(options, deps) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
  const base = config({ healthPath: join(dir, 'health.json'), ...options })
  const calls = []
  const probe = createHealthProbe({
    config: base,
    sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
    resolveApiKey: async () => 'sk-test',
    fetch: stubFetch(deps.answers ?? {}, calls),
    now: deps.now ?? (() => 1_700_000_000_000),
    logger: deps.logger,
    modelIds: async () => [{ id: 'glm-5.3' }],
  })
  return { probe, calls, path: healthPath(base), base }
}

const ALIVE_ALL = {
  '/chat/completions': { status: 400, body: { error: { message: 'messages must not be empty' } } },
  '/responses': { status: 400, body: { error: { message: 'input must not be empty' } } },
  '/messages': { status: 400, body: { error: { message: 'messages must not be empty' } } },
}

export default {
  name: 'health',
  cases: [
    // --- classification: the inversion this module exists for ----------------
    {
      name: 'a validation refusal proves the route is alive',
      run() {
        const found = classifyResponse({ status: 400, text: '{"error":{"message":"messages must not be empty"}}', url: 'u', protocol: 'chat-completions' })
        is(found.state, STATE.ALIVE)
        is(found.signal, SIGNAL.ROUTE_ALIVE)
        equal(found.status, 400)
        equal(found.protocol, 'chat-completions')
      },
    },
    {
      name: '404 is the only 4xx that means the endpoint moved',
      run() {
        for (const status of [404, 405, 410]) {
          const found = classifyResponse({ status, text: 'Not Found' })
          is(found.state, STATE.MOVED, `status ${status}`)
          is(found.signal, SIGNAL.ROUTE_MOVED)
        }
        // The neighbouring statuses must stay on the alive side of the line.
        for (const status of [400, 422, 401, 429, 499]) {
          const found = classifyResponse({ status, text: '{}' })
          is(found.state, STATE.DEGRADED === found.state ? STATE.DEGRADED : STATE.ALIVE, `status ${status}`)
          is(found.signal !== SIGNAL.ROUTE_MOVED, true, `status ${status} must not read as moved`)
        }
      },
    },
    {
      name: 'a body naming the session header outranks the status it arrived with',
      run() {
        // This is the real-world shape: a 400 that a naive reader files as "the
        // request was bad", when the relay is actually demanding a header.
        const found = classifyResponse({ status: 400, text: '{"error":{"message":"MissingSessionID"}}' })
        is(found.state, STATE.DEGRADED)
        is(found.signal, SIGNAL.SESSION_HEADER_REQUIRED)
      },
    },
    {
      name: 'a moved route is never softened into a protocol refusal',
      run() {
        // Precedence check: the body mentions a protocol, but the status says the
        // path is gone, and reporting "protocol unsupported" would send a reader
        // to look at the wrong thing.
        const found = classifyResponse({ status: 404, text: '{"error":{"type":"ModelProtocolUnsupported"}}' })
        is(found.state, STATE.MOVED)
        is(found.signal, SIGNAL.ROUTE_MOVED)
      },
    },
    {
      name: 'a protocol refusal proves the route answered, and is not a fault',
      run() {
        // The relay could only answer this after resolving the route *and* the
        // model, so it is the strongest evidence a route exists — not a
        // degradation. Found the hard way: a live round naming one chat-only
        // model across three paths warned twice per round, forever.
        const found = classifyResponse({ status: 400, text: '{"error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}' })
        is(found.state, STATE.ALIVE)
        is(found.signal, SIGNAL.PROTOCOL_REJECTED)
        // And it must not make the whole round degraded.
        is(worstState([found, found]), STATE.ALIVE)
      },
    },
    {
      name: 'credentials, quota and server trouble are each named',
      run() {
        is(classifyResponse({ status: 401, text: '{}' }).signal, SIGNAL.AUTH_REFUSED)
        is(classifyResponse({ status: 403, text: '{}' }).signal, SIGNAL.AUTH_REFUSED)
        is(classifyResponse({ status: 401, text: '{"error":{"type":"AuthError","message":"invalid_api_key"}}' }).signal, SIGNAL.AUTH_REFUSED)
        is(classifyResponse({ status: 429, text: '{}' }).signal, SIGNAL.QUOTA_EXHAUSTED)
        is(classifyResponse({ status: 402, text: '{"error":{"message":"Insufficient balance"}}' }).signal, SIGNAL.QUOTA_EXHAUSTED)
        is(classifyResponse({ status: 500, text: '{}' }).signal, SIGNAL.SERVER_ERROR)
        is(classifyResponse({ status: 503, text: '{}' }).state, STATE.DEGRADED)
      },
    },
    {
      name: 'markers are found in any envelope, not only the usual two fields',
      run() {
        // The relay has shipped more than one error shape; the search must not
        // depend on which one this week uses.
        const nested = classifyResponse({ status: 400, text: '{"error":{"type":"t","code":{"inner":"MissingSessionID"}}}' })
        is(nested.signal, SIGNAL.SESSION_HEADER_REQUIRED)
        const list = classifyResponse({ status: 400, text: '{"errors":[{"detail":"x-opencode-session required"}]}' })
        is(list.signal, SIGNAL.SESSION_HEADER_REQUIRED)
        const plain = classifyResponse({ status: 401, text: 'invalid api key' })
        is(plain.signal, SIGNAL.AUTH_REFUSED)
      },
    },
    {
      name: 'no response is separated from a timeout, because they mean opposite things',
      run() {
        const timeout = classifyTransport(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
        is(timeout.state, STATE.UNREACHABLE)
        is(timeout.signal, SIGNAL.TIMEOUT)
        const refused = classifyTransport(Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }))
        is(refused.signal, SIGNAL.TRANSPORT)
        includes(refused.detail, 'ECONNREFUSED')
      },
    },
    {
      name: 'the worst state wins, with a relocation above an outage',
      run() {
        is(worstState([{ state: STATE.ALIVE }, { state: STATE.DEGRADED }]), STATE.DEGRADED)
        is(worstState([{ state: STATE.UNREACHABLE }, { state: STATE.MOVED }]), STATE.MOVED)
        is(worstState([{ state: STATE.ALIVE }]), STATE.ALIVE)
        is(worstState([]), STATE.ALIVE)
        is(worstState(undefined), STATE.ALIVE)
      },
    },

    // --- probe: what it sends -----------------------------------------------
    {
      name: 'every probe body is one no completion can be generated from',
      run() {
        for (const { protocol } of PROTOCOL_PATHS) {
          const body = probeBody(protocol, 'glm-5.3')
          // An empty conversation is what makes the healthy answer a 400.
          const conversation = body.messages ?? body.input
          ok(Array.isArray(conversation), `${protocol} needs an empty conversation`)
          is(conversation.length, 0, `${protocol} conversation must be empty`)
          ok((body.max_tokens ?? body.max_output_tokens) === 1, `${protocol} needs a one-token cap`)
        }
      },
    },
    {
      name: 'the probe names a model each probed route actually serves',
      async run() {
        // The default catalog has models reachable over all three protocols, and
        // one body naming that model keeps every path's healthy answer a plain
        // validation refusal instead of a protocol rejection.
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const calls = []
        const probe = createHealthProbe({
          config: config({ healthPath: join(dir, 'health.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL, calls),
          now: () => 1_700_000_000_000,
          logger: { warn: () => {}, info: () => {} },
          modelIds: async () => [
            { id: 'deepseek-v4.1-flash', protocols: ['responses', 'chat-completions', 'anthropic'] },
            { id: 'qwen3.8-max', protocols: ['anthropic'] },
          ],
        })
        await probe.run({ reason: 'manual' })
        const named = new Set(calls.map((call) => JSON.parse(call.body).model))
        is(named.size, 1, 'one model served all three paths')
        is([...named][0], 'deepseek-v4.1-flash')

        // With no all-protocol model, each path gets one it is actually served
        // over — so the refusal stays a validation refusal.
        const perPath = []
        const split = createHealthProbe({
          config: config({ healthPath: join(dir, 'health2.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL, perPath),
          now: () => 1_700_000_000_000,
          logger: { warn: () => {}, info: () => {} },
          modelIds: async () => [
            { id: 'grok-4.7', protocols: ['responses'] },
            { id: 'qwen3.8-max', protocols: ['anthropic'] },
            { id: 'glm-5.3', protocols: ['chat-completions'] },
          ],
        })
        await split.run({ reason: 'manual' })
        const byPath = Object.fromEntries(perPath.map((call) => [
          call.url.replace(config({}).baseURL, ''),
          JSON.parse(call.body).model,
        ]))
        is(byPath['/chat/completions'], 'glm-5.3')
        is(byPath['/responses'], 'grok-4.7')
        is(byPath['/messages'], 'qwen3.8-max')
      },
    },
    {
      name: 'a hidden model is never the one named',
      async run() {
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const calls = []
        const probe = createHealthProbe({
          config: config({ healthPath: join(dir, 'health.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL, calls),
          now: () => 1_700_000_000_000,
          logger: { warn: () => {}, info: () => {} },
          modelIds: async () => [
            { id: 'all-three', protocols: ['responses', 'chat-completions', 'anthropic'], hidden: true },
            { id: 'listed', protocols: ['chat-completions'] },
          ],
        })
        await probe.run({ reason: 'manual' })
        ok(calls.every((call) => JSON.parse(call.body).model !== 'all-three'), 'a hidden model stays out of the wire')
      },
    },
    {
      name: 'the probe quotes the same paths generation uses',
      run() {
        // If these drift apart the probe would watch routes nobody calls.
        equal(PROTOCOL_PATHS.find((e) => e.protocol === PROTOCOLS.CHAT).path, '/chat/completions')
        equal(PROTOCOL_PATHS.find((e) => e.protocol === PROTOCOLS.RESPONSES).path, '/responses')
        equal(PROTOCOL_PATHS.find((e) => e.protocol === PROTOCOLS.ANTHROPIC).path, '/messages')
        is(PROTOCOL_PATHS.length, 3)
      },
    },
    {
      name: 'a probe request carries the identity headers a real call carries',
      async run() {
        const { probe, calls } = await withProbe({}, { answers: ALIVE_ALL })
        await probe.run({ reason: 'manual' })
        is(calls.length, 3, 'one request per protocol path')
        const chat = calls.find((c) => c.url.endsWith('/chat/completions'))
        is(chat.method, 'POST')
        // The session header is the point: without it the probe could never see a
        // relay that starts demanding one.
        is(chat.headers['x-opencode-session'], 'probe-session')
        is(chat.headers['x-opencode-client'], 'dsh-opencode-go')
        is(chat.headers.authorization, 'Bearer sk-test')
        is(chat.headers['content-type'], 'application/json')
        // A probe asks for JSON so any answer terminates instead of streaming.
        is(chat.headers.accept, 'application/json')
        // And it names a real model, so a 404 means the endpoint, not the model.
        is(JSON.parse(chat.body).model, 'glm-5.3')
        const anthropic = calls.find((c) => c.url.endsWith('/messages'))
        is(anthropic.headers['x-api-key'], 'sk-test')
        ok(anthropic.headers['anthropic-version'] !== undefined)
      },
    },
    {
      name: 'a healthy round reports alive and writes nothing alarming to the log',
      async run() {
        const lines = []
        const { probe } = await withProbe({}, { answers: ALIVE_ALL, logger: { warn: (...a) => lines.push(a.join(' ')), info: () => {} } })
        const report = await probe.run({ reason: 'manual' })
        is(report.state, STATE.ALIVE)
        equal(report.signals, [SIGNAL.ROUTE_ALIVE])
        is(report.suggestion, undefined, 'nothing to suggest while the endpoint serves every protocol')
        is(report.apiKeyResolved, true)
        is(report.nextDueAt, report.checkedAt + 21_600_000, 'a healthy route waits the full interval')
        is(lines.length, 0, `a healthy round must be silent, got: ${lines.join(' | ')}`)
      },
    },
    {
      name: 'a missing credential degrades the probe instead of ending it',
      async run() {
        const lines = []
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const probe = createHealthProbe({
          config: config({ healthPath: join(dir, 'health.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => { throw new Error('no API key for provider route "opencode-go"') },
          fetch: stubFetch(ALIVE_ALL),
          now: () => 1_700_000_000_000,
          logger: { warn: (...a) => lines.push(a.join(' ')), info: () => {} },
        })
        const report = await probe.run({ reason: 'manual' })
        is(report.apiKeyResolved, false)
        is(report.state, STATE.ALIVE, 'a 400 is still a 400 without a key')
        is(lines.length, 0, 'and no warning, because a refusal we caused is not news')
      },
    },
    {
      name: 'a refused credential warns once a key exists, and stops when it does not',
      async run() {
        // This is what made defaulting the probe on safe: a deployment that has not
        // stored a key yet gets 401 on every route, every round. Warning about it
        // forever is how a warning stops being read.
        const refused = {
          '/chat/completions': { status: 401, body: { error: { type: 'AuthError' } } },
          '/responses': { status: 401, body: { error: { type: 'AuthError' } } },
          '/messages': { status: 401, body: { error: { type: 'AuthError' } } },
        }
        const withKey = []
        const keyed = await withProbe({}, { answers: refused, logger: { warn: (...a) => withKey.push(a.join(' ')), info: () => {} } })
        const keyedReport = await keyed.probe.run({ reason: 'scheduled' })
        is(keyedReport.apiKeyResolved, true)
        ok(withKey.length > 0, 'a genuine credential failure is still reported')
        ok(withKey.every((line) => line.includes('AUTH_REFUSED')))

        const withoutKey = []
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const keyless = createHealthProbe({
          config: config({ healthPath: join(dir, 'health.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => { throw new Error('no API key') },
          fetch: stubFetch(refused),
          now: () => 1_700_000_000_000,
          logger: { warn: (...a) => withoutKey.push(a.join(' ')), info: () => {} },
        })
        const keylessReport = await keyless.run({ reason: 'scheduled' })
        is(keylessReport.apiKeyResolved, false)
        is(keylessReport.state, STATE.DEGRADED, 'the routes did answer, which is still liveness')
        is(withoutKey.length, 0, 'and the same 401 without a key is silent')
      },
    },

    // --- probe: the failure path and its suggestion --------------------------
    {
      name: 'a relocated endpoint is found, and the suggestion names the new roots',
      async run() {
        // The scenario this plugin exists for: the flat root keeps answering for
        // two protocols and loses the third, and the documented per-protocol roots
        // cover everything.
        const { probe, path } = await withProbe({}, {
          answers: {
            'https://opencode.ai/inference/go/anthropic/v1/messages': { status: 400, body: { error: { message: 'messages must not be empty' } } },
            '/chat/completions': ALIVE_ALL['/chat/completions'],
            '/responses': ALIVE_ALL['/responses'],
            // Only the flat root lost this one, so a suffix key would hit the
            // anthropic root too; the full URL above is what keeps them apart.
            '/messages': { status: 404, body: { error: { message: 'Not Found' } } },
          },
        })
        const report = await probe.run({ reason: 'manual' })
        is(report.state, STATE.MOVED)
        ok(report.signals.includes(SIGNAL.ROUTE_MOVED))
        is(report.suggestion.code, 'BASE_URL_MOVED')
        includes(report.suggestion.detail, '/messages')
        ok(report.suggestion.routes.some((r) => r.protocol === PROTOCOLS.ANTHROPIC && r.baseURL.includes('anthropic')))
        // And it prefers the layout the vendor documents over the legacy alias,
        // which would hand the reader the same problem a second time.
        const anthropicRoute = report.suggestion.routes.find((r) => r.protocol === PROTOCOLS.ANTHROPIC)
        equal(anthropicRoute.baseURL, 'https://opencode.ai/inference/go/anthropic/v1')
        // The structural note is the part no probe can fix for the reader.
        includes(report.suggestion.note, 'one baseURL')

        // And it is on disk, so a restart shows the same picture.
        const saved = JSON.parse(await readFile(path, 'utf8'))
        is(saved.version, 1)
        is(saved.state, STATE.MOVED)
        is(saved.signals.length, report.signals.length)
        ok(Array.isArray(saved.history) && saved.history.length === 1)
      },
    },
    {
      name: 'a partially-answering candidate is never suggested',
      async run() {
        // A layout that answers two of three paths would produce a config that
        // looks plausible and fails on the model nobody tested.
        const { probe } = await withProbe({}, {
          answers: {
            '/chat/completions': ALIVE_ALL['/chat/completions'],
            '/responses': ALIVE_ALL['/responses'],
            '/messages': { status: 404, body: {} },
          },
        })
        const report = await probe.run({ reason: 'manual' })
        // No candidate can serve all three, so nothing is offered.
        is(report.suggestion, undefined)
      },
    },
    {
      name: 'candidates cost nothing while the endpoint is healthy',
      async run() {
        const { probe, calls } = await withProbe({}, { answers: ALIVE_ALL })
        const report = await probe.run({ reason: 'manual' })
        is(calls.length, 3, 'exactly the configured root, three paths')
        is(report.routes.length, 1)
      },
    },
    {
      name: 'healthCandidates: off keeps a failure on the configured root alone',
      async run() {
        const { probe, calls } = await withProbe({ healthCandidates: 'off' }, {
          answers: { '/chat/completions': { status: 404, body: {} } },
        })
        const report = await probe.run({ reason: 'manual' })
        is(report.state, STATE.MOVED)
        is(calls.length, 3, 'no candidate probing at all')
        is(report.suggestion, undefined)
      },
    },
    {
      name: 'the ladder backs off, and then the breaker stops the schedule',
      async run() {
        let clock = 1_700_000_000_000
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        // Swapped between rounds so the probe can be walked from broken to fixed
        // without being rebuilt: the breaker state has to survive the transition.
        let answers = { '/chat/completions': { status: 404, body: {} } }
        const probe = createHealthProbe({
          config: config({ healthPath: join(dir, 'health.json'), healthRetrySeconds: [30, 120] }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 'probe-session' },
          resolveApiKey: async () => 'sk-test',
          fetch: (...args) => stubFetch(answers)(...args),
          now: () => clock,
          logger: { warn: () => {}, info: () => {} },
        })
        const first = await probe.run({ reason: 'scheduled' })
        is(first.nextDueAt, clock + 30_000, 'the first bad round waits the ladder floor')
        clock += 30_000
        const second = await probe.run({ reason: 'scheduled' })
        is(second.nextDueAt, clock + 120_000, 'the second waits the next rung')
        clock += 120_000
        const third = await probe.run({ reason: 'scheduled' })
        is(third.tripped, true, 'three bad rounds trip the breaker')
        is(third.nextDueAt, undefined, 'a tripped probe has no next round')
        ok(probe.tripped())

        // And a healthy round clears it, so a fixed endpoint is noticed without a
        // restart.
        answers = ALIVE_ALL
        const recovered = await probe.run({ reason: 'traffic' })
        is(recovered.state, STATE.ALIVE)
        is(probe.tripped(), false)
        is(recovered.nextDueAt, recovered.checkedAt + 21_600_000)
      },
    },
    {
      name: 'a degraded-but-answering route stays on the normal schedule',
      async run() {
        // A key that was fixed, or a header the adapter starts sending, must be
        // able to clear the finding without a restart — so AUTH_REFUSED must not
        // walk the ladder or trip the breaker.
        const { probe } = await withProbe({}, {
          answers: {
            ...ALIVE_ALL,
            '/chat/completions': { status: 401, body: { error: { type: 'AuthError' } } },
          },
        })
        const report = await probe.run({ reason: 'scheduled' })
        is(report.state, STATE.DEGRADED)
        is(report.tripped, false)
        is(report.nextDueAt, report.checkedAt + 21_600_000)
      },
    },
    {
      name: 'concurrent rounds collapse onto one',
      async run() {
        const { probe, calls } = await withProbe({}, { answers: ALIVE_ALL })
        await Promise.all([probe.run({ reason: 'manual' }), probe.run({ reason: 'traffic' }), probe.run({ reason: 'manual' })])
        is(calls.length, 3, 'three callers, one round, three requests')
      },
    },

    // --- probe: reacting to live traffic -------------------------------------
    {
      name: 'a 404 from real traffic triggers a round; an ordinary refusal does not',
      async run() {
        const { probe, calls } = await withProbe({}, { answers: ALIVE_ALL })
        // A request-level refusal must not spend a probe: the caller has already
        // been told what it was, and re-reporting it is noise.
        await probe.noteTrafficFailure({ status: 400, text: '{"error":{"message":"context length exceeded"}}' })
        is(calls.length, 0, 'a request refusal is not an endpoint problem')
        await probe.noteTrafficFailure({ status: 429, text: 'rate limit' })
        is(calls.length, 0)
        // A missing path is exactly the signal worth acting on.
        await probe.noteTrafficFailure({ status: 404, text: 'Not Found' })
        is(calls.length, 3)
      },
    },
    {
      name: 'traffic-triggered rounds are off when health checks are off',
      async run() {
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const calls = []
        const probe = createHealthProbe({
          config: resolveConfig({ healthCheck: 'off', healthPath: join(dir, 'health.json') }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 's' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL, calls),
          logger: { warn: () => {}, info: () => {} },
        })
        is(await probe.noteTrafficFailure({ status: 404, text: 'Not Found' }), undefined)
        is(calls.length, 0)
        // And scheduling one is a no-op that still returns a disposer.
        probe.start()()
      },
    },

    // --- storage -------------------------------------------------------------
    {
      name: 'a previous round is readable after a restart',
      async run() {
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const shared = { healthPath: join(dir, 'health.json') }
        const first = createHealthProbe({
          config: config(shared),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 's' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL),
          now: () => 1_700_000_000_000,
          logger: { warn: () => {}, info: () => {} },
        })
        await first.run({ reason: 'manual' })

        const second = createHealthProbe({
          config: config(shared),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 's' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL),
          now: () => 1_800_000_000_000,
          logger: { warn: () => {}, info: () => {} },
        })
        await second.load()
        const report = second.report()
        ok(report !== undefined, 'a restart shows the last round, not a blank panel')
        is(report.state, STATE.ALIVE)
        is(report.checkedAt, 1_700_000_000_000, 'and it is the earlier one')
        ok(Array.isArray(report.history))
      },
    },
    {
      name: 'an unwritable health file is a warning, never a request failure',
      async run() {
        const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
        const probe = createHealthProbe({
          // A directory where a file belongs: `writeFile` cannot succeed, and the
          // round must still report rather than fail on its own bookkeeping.
          config: config({ healthPath: dir }),
          sessionState: { uuidBySession: new Map(), fallbackUuid: () => 's' },
          resolveApiKey: async () => 'sk-test',
          fetch: stubFetch(ALIVE_ALL),
          now: () => 1_700_000_000_000,
          logger: { warn: () => {}, info: () => {} },
        })
        const report = await probe.run({ reason: 'manual' })
        is(report.state, STATE.ALIVE, 'the round still reported')
        is(report.history.length, 1, 'and still kept its history in memory')
      },
    },
  ],
}