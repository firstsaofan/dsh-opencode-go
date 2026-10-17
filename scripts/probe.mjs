/**
 * A live probe against the real endpoint, with no credential.
 *
 * The classification rests on an assumption about a live service — that a route
 * which exists answers `400` and a route which does not answers `404` — and no
 * amount of stubbing can check that. This runs the probe exactly as the plugin
 * would, with a deliberately invalid body and no key, and prints what it learned.
 *
 * It costs nothing: no probe body can produce a completion, and without a
 * credential the relay answers before any generation is considered.
 *
 * Usage: node scripts/probe.mjs [--base <root>]
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createHealthProbe } from '../lib/health/probe.js'
import { SIGNAL, STATE } from '../lib/health/classify.js'

const args = process.argv.slice(2)
const baseArg = args.indexOf('--base')
const baseURL = baseArg === -1 ? undefined : args[baseArg + 1]

const dir = await mkdtemp(join(tmpdir(), 'dsh-probe-'))
const config = resolveConfig({
  healthCheck: 'both',
  healthTimeoutSeconds: 15,
  // A throwaway file: this run must not touch a real cache directory.
  healthPath: join(dir, 'health.json'),
  ...(baseURL === undefined ? {} : { baseURL }),
})

const probe = createHealthProbe({
  config,
  sessionState: { uuidBySession: new Map(), fallbackUuid: () => `probe-${Date.now()}` },
  // No key on purpose. A route that answers `401` is still a route that is there,
  // which is the whole point of separating liveness from authorization.
  resolveApiKey: async () => { throw new Error('no credential: this probe is unauthenticated') },
  modelIds: async () => [{ id: 'deepseek-v4.1-flash' }],
  logger: { info: () => {}, warn: (...args) => console.log('  warn:', args.join(' ')) },
})

const report = await probe.run({ reason: 'manual' })

console.log(`\nbase URL  ${report.baseURL}`)
console.log(`state      ${report.state}`)
console.log(`signals    ${report.signals.join(', ') || '(none)'}`)
console.log(`credential ${report.apiKeyResolved ? 'resolved' : 'none — liveness only'}\n`)
for (const layout of report.routes) {
  console.log(`  ${layout.baseURL}`)
  for (const [protocol, finding] of Object.entries(layout.findings)) {
    const verdict = finding.state === STATE.ALIVE ? 'ALIVE' : finding.state.toUpperCase()
    console.log(`    ${protocol.padEnd(18)} ${String(finding.status ?? '-').padEnd(5)} ${verdict.padEnd(12)} ${finding.signal}`)
    if (finding.detail !== '') console.log(`      ${finding.detail.slice(0, 160)}`)
  }
}
if (report.suggestion !== undefined) {
  console.log(`\n  suggestion ${report.suggestion.code}`)
  console.log(`    ${report.suggestion.detail}`)
  for (const route of report.suggestion.routes) console.log(`    ${route.path} → ${route.baseURL}`)
}

console.log(`\nverdict    ${report.state === STATE.ALIVE ? 'every route is answering' : report.signals.join(', ')}`)
console.log(`           (an ALIVE here means the route answered; with no key that refusal is expected)\n`)
if (report.state === STATE.MOVED) console.log(`  a 404 is what a retired path looks like — this is the signal that fires the alarm.\n`)
if (report.signals.includes(SIGNAL.ROUTE_ALIVE)) console.log(`  ROUTE_ALIVE is the probe's success case: a route that exists answers with a refusal.\n`)