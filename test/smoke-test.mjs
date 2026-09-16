/**
 * dsh-llm-proxy — end-to-end smoke test against REAL undici + local servers.
 * Covers the BUNDLED engine (harnesses without the official outbound-proxy
 * package): routing semantics under test are
 *   127.0.0.1 → NOT in proxiedHosts → direct server
 *   127.0.0.2 → in proxiedHosts     → proxy server
 *   localhost → always direct (loopback guard)
 * plus \`planFor()\`, the non-dispatching verdict the settings card reports.
 *
 * Retry is not part of this layer since v1.4.0 — the official dsh-llm-retry
 * plugin replays failures from each provider's own retryPolicy.
 *
 * Run: node test/smoke-test.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { setGlobalDispatcher, fetch } from 'undici'
import { RoutingDispatcher } from '../lib/routing-dispatcher.js'

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))
}
function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

const proxyHits = []
const proxyServer = createServer((req, res) => {
  proxyHits.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('via-proxy')
})
const directHits = []
const directServer = createServer((req, res) => {
  directHits.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('direct')
})

const proxyPort = await listen(proxyServer, '127.0.0.1')
const directPort = await listen(directServer, '127.0.0.1')
const undici = await import('undici')
const quietLogger = { info() {}, warn() {}, error() {} }

// --- Scenario A: default direct + proxied host routing --------------------------
const dispatcher = new RoutingDispatcher({
  undici,
  proxyHost: '127.0.0.1',
  proxyPort,
  proxyHosts: ['127.0.0.2'],
  logger: quietLogger,
})
setGlobalDispatcher(dispatcher)

// 127.0.0.2 is proxied → the request is forwarded to the proxy server.
const viaProxy = await (await fetch(`http://127.0.0.2:${directPort}/hello`)).text()
assert.equal(viaProxy, 'via-proxy', 'expected proxied host 127.0.0.2 to go through the proxy')
assert.ok(proxyHits.length >= 1, 'proxy server should have been hit')

// 127.0.0.1 is not proxied → direct connection to the direct server.
const direct = await (await fetch(`http://127.0.0.1:${directPort}/bye`)).text()
assert.equal(direct, 'direct', 'expected unselected host 127.0.0.1 to stay direct')
assert.ok(directHits.length >= 1, 'direct server should have been hit')

// --- Scenario B: planFor agrees with what dispatch just did --------------------
assert.deepEqual(dispatcher.planFor(`http://127.0.0.2:${directPort}/hello`), { proxied: true, host: '127.0.0.2' })
assert.deepEqual(dispatcher.planFor(`http://127.0.0.1:${directPort}/bye`), { proxied: false, host: '127.0.0.1' })
assert.deepEqual(dispatcher.planFor('https://api.deepseek.com/v1'), { proxied: false, host: 'api.deepseek.com' })
assert.equal(proxyHits.length, 1, 'planFor must not issue requests')
assert.equal(directHits.length, 1, 'planFor must not issue requests')

await dispatcher.close()
await close(proxyServer)
await close(directServer)
console.log('SMOKE TEST PASSED: default-direct routing, proxied host, loopback guard, planFor verdicts verified')
// Let undici's agent pool drain before exiting to avoid a Windows UV assertion.
await new Promise((resolve) => setTimeout(resolve, 50))
process.exit(0)
