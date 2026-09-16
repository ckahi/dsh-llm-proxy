/**
 * dsh-llm-proxy — unit tests for RoutingDispatcher, the bundled engine's pure
 * router (used on harnesses without the official outbound-proxy package).
 *
 * Routing semantics: loopback hosts always go DIRECT; hosts in the proxied
 * host set go through the single ProxyAgent; everything else stays DIRECT.
 * `planFor()` answers the same question without dispatching, which is what the
 * settings card's 测试连接 reports.
 *
 * Retry is NOT part of this layer since v1.4.0 — the official dsh-llm-retry
 * plugin replays failures from each provider's own retryPolicy.
 *
 * Uses a fake undici shim (Agent/ProxyAgent recording dispatch targets) so no
 * real network or proxy is touched. Run: node --test test/*.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoutingDispatcher } from '../lib/routing-dispatcher.js'

// --- Fake undici -------------------------------------------------------------
function makeUndici(record) {
  class FakeAgent {
    constructor() {
      this.name = 'direct'
    }
    dispatch(opts, handler) {
      record.push({ agent: 'direct', origin: opts.origin, host: opts.host })
      handler?.onResponseStart?.(200, {}, 'OK', opts.origin)
      handler?.onResponseEnd?.(null, {})
      return true
    }
    close() {
      return Promise.resolve()
    }
    destroy() {
      return Promise.resolve()
    }
  }
  class FakeProxyAgent extends FakeAgent {
    constructor(uriOrOpts) {
      // Mirror undici's ProxyAgent: accepts either a URI string or an options
      // object ({ uri, ... }); a malformed URL throws at construction.
      const uri = typeof uriOrOpts === 'string' ? uriOrOpts : uriOrOpts?.uri
      if (typeof uri !== 'string' || !/^https?:\/\/[^/\s]+(:\d+)?$/.test(uri)) {
        throw new Error('Invalid URL')
      }
      super()
      this.name = `proxy:${uri}`
      this.uri = uri
    }
    dispatch(opts, handler) {
      record.push({ agent: `proxy:${this.uri}`, origin: opts.origin, host: opts.host })
      handler?.onResponseStart?.(200, {}, 'OK', opts.origin)
      handler?.onResponseEnd?.(null, {})
      return true
    }
  }
  return { Agent: FakeAgent, ProxyAgent: FakeProxyAgent }
}

function req(origin, signal) {
  return { origin, path: '/v1/chat/completions', method: 'POST', headers: [], signal }
}

function makeDispatcher(record, overrides = {}) {
  return new RoutingDispatcher({
    undici: makeUndici(record),
    proxyHost: '127.0.0.1',
    proxyPort: 7897,
    ...overrides,
  })
}

// --- Routing ------------------------------------------------------------------
test('default is DIRECT: unselected hosts do not touch the proxy', () => {
  const record = []
  const d = makeDispatcher(record)
  d.dispatch(req('https://api.deepseek.com/v1'), {})
  assert.equal(record.length, 1)
  assert.equal(record[0].agent, 'direct')
})

test('selected proxied hosts go through the proxy', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['api.b.ai'] })
  d.dispatch(req('https://api.b.ai/v1'), {})
  assert.equal(record.length, 1)
  assert.equal(record[0].agent, 'proxy:http://127.0.0.1:7897')
})

test('loopback hosts are always direct, even when proxied', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['localhost', '127.0.0.1'] })
  d.dispatch(req('http://localhost:3080/'), {})
  d.dispatch(req('http://127.0.0.1:3080/'), {})
  assert.equal(record.length, 2)
  assert.ok(record.every((r) => r.agent === 'direct'))
})

test('subdomain of a proxied host also goes through the proxy', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['b.ai'] })
  d.dispatch(req('https://api.b.ai/v1'), {})
  assert.equal(record[0].agent, 'proxy:http://127.0.0.1:7897')
})

test('missing proxy agent falls back to direct', () => {
  const record = []
  const d = new RoutingDispatcher({
    undici: makeUndici(record),
    proxyHost: 'not a url',
    proxyPort: 99999,
    proxyHosts: ['api.b.ai'],
  })
  d.dispatch(req('https://api.b.ai/v1'), {})
  assert.equal(record[0].agent, 'direct')
})

test('proxyHost with an embedded http:// scheme is normalized', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHost: 'http://192.168.1.10:10809', proxyHosts: ['api.b.ai'] })
  assert.equal(d.proxy.uri, 'http://192.168.1.10:10809')
  d.dispatch(req('https://api.b.ai/v1'), {})
  assert.equal(record[0].agent, 'proxy:http://192.168.1.10:10809')
})

test('proxyHost with an https scheme is preserved and inline port wins', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHost: 'https://proxy.example.com:8443', proxyPort: 7897, proxyHosts: ['api.b.ai'] })
  assert.equal(d.proxy.uri, 'https://proxy.example.com:8443')
  d.dispatch(req('https://api.b.ai/v1'), {})
  assert.equal(record[0].agent, 'proxy:https://proxy.example.com:8443')
})

test('closed dispatcher rejects new requests', () => {
  const record = []
  const d = makeDispatcher(record)
  d.closed = true
  let failed = null
  d.dispatch(req('https://api.deepseek.com/v1'), { onResponseError: (_, err) => { failed = err } })
  assert.ok(failed instanceof Error)
})

// --- planFor: the route verdict without dispatching ---------------------------
// v1.4.0: the card's 测试连接 asks the engine where a URL would go, so the answer
// comes from the same matcher that routes real traffic instead of from the
// configured selection. Retry left this layer entirely — the official
// dsh-llm-retry plugin replays failures from each provider's retryPolicy, which
// test/retry-mirror.test.js covers.

test('planFor: a selected host reports proxied and issues no request', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['api.b.ai'] })
  const plan = d.planFor('https://api.b.ai/v1/chat/completions')
  assert.deepEqual(plan, { proxied: true, host: 'api.b.ai' })
  assert.deepEqual(record, [], 'planning must not touch the network')
})

test('planFor: unselected and loopback hosts report direct', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['api.b.ai'] })
  assert.equal(d.planFor('https://api.deepseek.com/v1').proxied, false)
  assert.equal(d.planFor('http://127.0.0.1:50840/api/dsh').proxied, false)
  assert.equal(d.planFor('https://localhost:3080/').proxied, false)
  assert.deepEqual(record, [])
})

test('planFor: a subdomain of a selected host reports proxied', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['b.ai'] })
  assert.equal(d.planFor('https://api.b.ai/v1').proxied, true)
})

test('planFor: a rejected proxy endpoint keeps every host direct', () => {
  const record = []
  const d = new RoutingDispatcher({
    undici: makeUndici(record),
    proxyHost: 'not a url',
    proxyPort: 99999,
    proxyHosts: ['api.b.ai'],
  })
  assert.equal(d.planFor('https://api.b.ai/v1').proxied, false)
})

test('planFor: unparseable input answers direct instead of throwing', () => {
  const record = []
  const d = makeDispatcher(record, { proxyHosts: ['api.b.ai'] })
  assert.deepEqual(d.planFor('not a url'), { proxied: false, host: 'not a url' })
  assert.deepEqual(d.planFor(undefined), { proxied: false, host: '' })
})
