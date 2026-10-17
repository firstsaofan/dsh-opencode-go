/**
 * Per-protocol credential headers.
 *
 * Two of the three wire protocols name the credential differently — Messages
 * refuses a bearer token outright — so every request that reaches the relay has
 * to branch on the protocol. That branch used to live inside the adapter's
 * private header builder, which left the health probe with no way to build a
 * faithful request: a probe that sent the wrong auth headers would be told
 * `AuthError` about the relay's own auth contract and never learn anything about
 * the endpoint.
 *
 * Keeping the branch here means the probe and generation build their auth the
 * same way, by construction rather than by discipline.
 *
 * @module dsh-llm-opencode-go/protocol/auth
 */

import { PROTOCOLS } from '../config.js'
import * as anthropic from './anthropic-messages.js'

/**
 * The credential headers one protocol expects.
 *
 * @param {string} protocol - a protocol id from `config.js`.
 * @param {string} apiKey - the resolved credential.
 * @param {object} [options] - request-shaping overrides.
 * @param {string} [options.accept] - replaces the protocol's own `accept`.
 *   The default asks for a stream because generation streams; a probe asks for
 *   JSON instead, so that any answer it receives is a body that ends rather than
 *   a stream that might not.
 * @returns {Record<string, string>} the headers to merge into the request.
 */
export function protocolAuthHeaders(protocol, apiKey, options = {}) {
  const headers = protocol === PROTOCOLS.ANTHROPIC
    ? anthropic.authHeaders(apiKey)
    : { authorization: `Bearer ${apiKey}` }
  if (typeof options.accept === 'string' && options.accept !== '') {
    headers.accept = options.accept
  }
  return headers
}