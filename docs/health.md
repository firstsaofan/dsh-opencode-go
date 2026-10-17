# Endpoint health

> Chinese version: [health.zh-CN.md](health.zh-CN.md).

OpenCode Go's API root has one problem no other provider has: **it has no change
notice.** The published documentation lists a per-protocol layout
(`.../inference/go/openai/v1`, `.../inference/go/anthropic/v1`), while the flat
root this plugin has always used — `.../zen/go/v1` — keeps answering alongside it.
Neither path appears in a changelog or an email. A deployment therefore learns
about a retirement at the moment every conversation starts failing.

This page describes how the plugin finds out earlier.

## On by default here, and why that is a divergence

Upstream defaults `healthCheck` to `off`, and for a good reason: a release must
not change what an existing deployment does. This fork defaults it to `both`,
which is a deliberate departure.

The reason is the one at the top of this page. A probe that is off by default
protects nobody from a silent endpoint change — it protects only the people who
already knew to look for one, which is exactly the set of people who did not need
it. The cost of having it on is three requests every six hours, none of which can
generate anything.

Two things make that default safe rather than noisy:

- **No credential means no complaint.** A deployment that has not stored a key yet
  gets `401` from every route, which is the probe's liveness answer and not a
  fault. The finding is recorded; it is not warned about. A warning that repeats
  every six hours forever is how a warning stops being read.
- **Three requests is the whole bill.** No completion is ever generated, so a round
  costs nothing against the plan's token allowance.

Set `healthCheck: off` to get upstream's behaviour back. When you rebase onto
upstream, this is the line to carry — and the test that records the decision is
`endpoint health is on by default in this fork` in `tests/suites/config.test.mjs`.

## The idea: learn from refusals

The probe generates nothing. It sends one request that is certain to be refused,
and reads the status:

| Request | Answer | Means |
|---|---|---|
| `POST {root}/chat/completions` with an empty conversation | `400` | The route is still there. A healthy answer is a refusal |
| The same | `404` | That route is gone |
| The same | `401` | The route is there; the credential is not |
| Nothing at all | — | DNS, TLS, a refused connection, or a timeout |

That distinction is the entire signal, and it is why the probe costs nothing: the
body is an empty conversation, which all three APIs reject during validation, so no
model ever starts running. The output cap is set to 1 as well, so even a gateway
lenient enough to accept an empty conversation would produce nothing of substance.

The probe sends **byte-for-byte the headers a real call sends**, including
`x-opencode-session`. That is not a detail: with different headers the probe could
never see a relay that *starts demanding* one — which is exactly the class of change
worth catching early.

## States and signals

One answer becomes one `state` and one `signal`. Classification is pure
(`lib/health/classify.js`) and ordered from "the endpoint is gone" outwards, because
these states are not equally informative:

| `state` | When | What to do |
|---|---|---|
| `alive` | The route answered | Nothing |
| `degraded` | The route answered, with a condition | Read the `signal`: `AUTH_REFUSED` — check the key; `QUOTA_EXHAUSTED` — the plan is spent; `SESSION_HEADER_REQUIRED` — the relay changed its contract; `PROTOCOL_REJECTED` — this model is not on this protocol; `SERVER_ERROR` — the service is unwell |
| `moved` | `404`/`405`/`410` | The endpoint moved; see `suggestion` |
| `unreachable` | No answer at all | The network or the host |

All eight signals are named in `SIGNAL` in `lib/health/classify.js`. Two rules are
worth stating on their own:

- **A body marker outranks the status it arrived with.** A `400` naming
  `MissingSessionID` reads as "the request was bad" to anyone who stops at the
  status code, when the relay is actually demanding a header.
- **`ModelProtocolUnsupported` is not a relocation, and not a fault either.** To
  answer "this model does not speak this protocol" the relay had to resolve the
  route *and* the model, which is the strongest evidence available that the route
  is there. It is reported as its own signal, because knowing which models a route
  will not serve is worth knowing, but it never degrades a round and never warns.
  This one was found by a live round rather than by the tests: a probe naming a
  single chat-only model across all three paths earned this on two of them, every
  round, forever. So the probe names a model each route actually serves — a model
  reachable over all three protocols where the catalog knows one — and the healthy
  answer stays a plain validation refusal.

## When it checks

Three triggers, from cheap to sensitive:

| Trigger | Requests | What it is |
|---|---|---|
| **Live traffic fails** | 3 | The valuable one. A refusal that looks like the endpoint rather than the request — a `404`/`405`, or a body mentioning a missing route — runs a full round immediately, so a relocation is reported while the reader is already looking at the failure |
| **Scheduled** | 3 | Every six hours by default, aligned with `modelsCacheSeconds` |
| **Manual** | 3 | The page's *Check now*, or `POST /opencode-go/health-check` |

**A request-level refusal does not trigger a round.** A context overflow, a spent
plan, a mistyped model id — the caller has already been told everything, and probing
it would only re-report that.

## Frequency: a ladder, backoff, and a breaker

Endpoint changes are measured in days, not minutes. A faster loop would learn
nothing and would keep bothering a service that is already unhappy.

| Mechanism | Behaviour |
|---|---|
| Normal interval | Six hours (`healthIntervalSeconds`) |
| Retry ladder | 30s → 2m → 10m → 1h → give up. A migration is never a clean instant; it is a window where some routes answer and some do not. The ladder catches a short blip without turning a long outage into an hourly alarm |
| Breaker | After three consecutive `moved`/`unreachable` rounds the schedule stops. While the endpoint is gone, scheduled probes add nothing — only traffic triggers remain |
| **Recovery** | Any `alive` round clears both the counter and the breaker, so a fixed endpoint is noticed without a restart |

`degraded` deliberately does **not** walk the ladder and stays on the normal
interval: a refused credential or a newly-required header is a fact about *this
deployment*, fixed by a person rather than by waiting.

## It tells you what to set instead

Once the configured root has failed, the probe tries the candidates named by
`healthCandidates` and reports something pasteable:

```json
{
  "code": "BASE_URL_MOVED",
  "detail": "https://opencode.ai/zen/go/v1 no longer serves /messages",
  "note": "This adapter resolves one baseURL per route, so a layout that serves different protocols from different roots needs one route per root.",
  "routes": [
    { "protocol": "anthropic", "path": "/messages", "baseURL": "https://opencode.ai/inference/go/anthropic/v1" }
  ]
}
```

Two rules are what make that worth trusting:

- **A suggestion appears only when every lost protocol has somewhere to go.** A
  partial answer produces a configuration that looks plausible and then fails on the
  models nobody tested — worse than silence, because the reader would apply it and
  lose the evidence that it did not work.
- **The `note` is always attached**, because it is the part no probe can fix for the
  reader: this route resolves one `baseURL`, and a layout that dispatches protocols
  from different roots needs one route per root.

Candidates are probed only *after* something is already wrong. While the configured
root serves every protocol, a candidate's answer is a second copy of the same good
news.

## What it deliberately does not do

- **It never issues a request that could generate.** The probe never spends money.
- **It never writes the credential.** The file it keeps holds hostnames, statuses
  and signal names, nothing else.
- **It never takes responsibility for a call.** A finding is diagnosis attached to a
  failure, not a substitute retry that might succeed where the real request did not.
- **It never changes behaviour.** A round that reports `alive` leaves everything
  exactly as it was.

## On disk

Every round writes one file, beside the model cache and the usage file:

```
~/.dsh/cache/opencode-go-health.json
```

It holds the full last round plus a short history of the most recent twenty
(`checkedAt` / `state` / `signals`), so a restart shows a trend rather than a blank
panel. Failing to write it is a warning and never fails the round.

## On the page

The settings page carries an *Endpoint health* section directly under *Connection*,
next to the thing it reports on:

- With checks off, it says how to turn them on (`healthCheck: scheduled` or `both`)
- With nothing probed yet, it says so — it does not render as healthy
- Otherwise: the state, when it was checked, and the signals found
- When the endpoint moved, the suggestion is shown
- *Check now* is the only request on that page a button triggers

`GET /opencode-go/health` is answered from memory, so opening the page costs
nothing; `POST /opencode-go/health-check` is what runs a round.