/**
 * dsh-llm-proxy v1.4.0 — official-engine tests.
 *
 * The plugin rides the official outbound-proxy package when it is installed:
 * it never touches \`setGlobalDispatcher\` in that mode, it feeds the official
 * \`installProxyFromEnvironment(envLookup, report)\` seam a computed policy, and
 * it hands the package back on teardown. These tests cover the detection
 * fallback, the policy the plugin computes (proxied host list vs bypass list),
 * the re-apply/dispose lifecycle, and the real-route verdict the card reports.
 *
 * No real network, no real proxy: the official package is injected through the
 * module's test hook.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, resolveProxySelection } from '../lib/index.js'
import {
  __resetOfficialProxyForTest,
  __setOfficialProxyForTest,
  loadOfficialProxy,
  policyEnvLookup,
  splitProxyList,
} from '../lib/official-proxy.js'
import { runConnectionTest } from '../lib/connection-test.js'

const PI_AI = {
  ns: 'llm-pi-ai',
  value: {
    providers: {
      'b-ai': { displayName: 'B.AI', baseURL: 'https://api.b.ai/v1', apiKey: 'test-key', models: [{ id: 'deepseek-v4-flash' }] },
      xiaomi: { displayName: '小米', baseURL: 'https://api.xiaomimimo.com/v1', apiKey: 'test-key', models: [{ id: 'mimo-v2.5' }] },
    },
  },
}

/** A fake official package: records the policy it is handed, disposable. */
function makeOfficialStub({ proxied = true } = {}) {
  const calls = { installs: [], reports: [], disposed: 0, routes: [] }
  const mod = {
    async installProxyFromEnvironment(lookup, report) {
      calls.installs.push(lookup)
      calls.reports.push(report)
      return async () => { calls.disposed += 1 }
    },
    proxyRouteFor(url) {
      calls.routes.push(new URL(url).hostname)
      return proxied ? { proxied: true, proxy: 'http://127.0.0.1:7897' } : { proxied: false }
    },
  }
  return { mod, calls }
}

/** Fake settings seam: one llm-proxy document plus the provider namespaces. */
function makeSeam(base) {
  let user = {}
  const watchers = new Set()
  const resolved = () => ({ ...base, ...user })
  return {
    seam: {
      writable: true,
      documentPath: 'fake-settings.yaml',
      register() {
        return {
          get: () => resolved(),
          watch(callback) {
            watchers.add(callback)
            return () => watchers.delete(callback)
          },
          update() {},
          replace() {},
        }
      },
      describe({ redactSecrets } = {}) {
        assert.ok(redactSecrets === true || redactSecrets === undefined)
        return [{ ns: 'llm-proxy', value: resolved(), base, user: { ...user }, revision: 0 }, PI_AI]
      },
      async mutate() {},
    },
    /** Commit a change and fire the live-apply watcher. */
    commit(next) {
      user = { ...user, ...next }
      for (const callback of watchers) void callback(resolved())
    },
    watcherCount: () => watchers.size,
  }
}

/** Fake cordis ctx: synchronous inject, captured logs, dispose hooks. */
function makeCtx(seam) {
  const logs = []
  const disposers = []
  const routes = []
  return {
    logs,
    disposers,
    routes,
    ctx: {
      logger: {
        info: (m) => logs.push(String(m)),
        warn: (m) => logs.push(String(m)),
        error: (m) => logs.push(String(m)),
      },
      on(event, fn) {
        if (event === 'dispose') disposers.push(fn)
        return () => {}
      },
      inject(services, callback) {
        assert.ok(services.includes('settings'), 'inject waits for settings')
        const sctx = { settings: seam, effect: () => {} }
        if (services.includes('webServer')) {
          sctx.webServer = { register: (route) => { routes.push(route); return () => {} } }
        }
        callback(sctx)
      },
    },
  }
}

const BASE_CONFIG = {
  proxyHost: '127.0.0.1',
  proxyPort: 7897,
  proxiedModels: [],
  multimodalModels: [],
  retries: 3,
  retryIntervalMs: 1000,
  trustedOrigins: [],
}

/** Let the engine's serialized install queue settle. */
async function flush(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Boot the plugin with an injected official package. */
async function boot({ stub, config = {} }) {
  __setOfficialProxyForTest(stub.mod)
  // The seam's registered document is what the live-apply path reads, so it
  // carries the same values `apply` was configured with.
  const merged = { ...BASE_CONFIG, ...config }
  const state = makeSeam(merged)
  const harness = makeCtx(state.seam)
  await apply(harness.ctx, merged)
  await flush()
  return { ...harness, state }
}

// --- detection ---------------------------------------------------------------

test('an absent package leaves the bundled engine in charge', async () => {
  // Forced, not probed: the answer must not depend on what happens to be
  // installed above this repository on the machine running the suite.
  __setOfficialProxyForTest(null)
  assert.equal(await loadOfficialProxy(), null)
})

test('__resetOfficialProxyForTest restores real resolution', async () => {
  __setOfficialProxyForTest(null)
  assert.equal(await loadOfficialProxy(), null)
  __resetOfficialProxyForTest()
  // Real resolution: null on a plain checkout, an object where the harness
  // install provides the package. Either way it must be well-formed.
  const found = await loadOfficialProxy()
  assert.ok(found === null || typeof found.module?.installProxyFromEnvironment === 'function')
})

test('injected package is detected with its source', async () => {
  const stub = makeOfficialStub()
  __setOfficialProxyForTest(stub.mod)
  const found = await loadOfficialProxy()
  assert.equal(found.from, 'injected', 'the injected face is reported as the source')
  assert.equal(found.module, stub.mod)
  __resetOfficialProxyForTest()
})

test('a module without the install seam is not accepted', async () => {
  __setOfficialProxyForTest({ proxyRouteFor: () => ({ proxied: false }) })
  assert.equal(await loadOfficialProxy(), null)
  __resetOfficialProxyForTest()
})

// --- the computed policy ------------------------------------------------------

test('policyEnvLookup writes both casings and answers nothing else', () => {
  const lookup = policyEnvLookup({ proxyUrl: 'http://127.0.0.1:7897', bypass: ['api.deepseek.com'] })
  assert.equal(lookup.get('https_proxy').value, 'http://127.0.0.1:7897')
  assert.equal(lookup.get('HTTPS_PROXY').value, 'http://127.0.0.1:7897')
  assert.equal(lookup.get('http_proxy').value, 'http://127.0.0.1:7897')
  assert.equal(lookup.get('no_proxy').value, 'api.deepseek.com')
  assert.equal(lookup.get('NO_PROXY').value, 'api.deepseek.com')
  assert.equal(lookup.get('ALL_PROXY'), undefined)
  assert.equal(lookup.get('PATH'), undefined)
})

test('policyEnvLookup dedupes entries across case and whitespace', () => {
  const lookup = policyEnvLookup({ proxyUrl: 'http://127.0.0.1:7897', bypass: ['Api.B.AI', ' api.b.ai ', 'api.xiaomimimo.com'] })
  assert.equal(lookup.get('no_proxy').value, 'Api.B.AI,api.xiaomimimo.com')
})

test('splitProxyList mirrors the official separator handling', () => {
  assert.deepEqual(splitProxyList('a.com, b.com  c.com'), ['a.com', 'b.com', 'c.com'])
  assert.deepEqual(splitProxyList(''), [])
  assert.deepEqual(splitProxyList(undefined), [])
})

// --- engine wiring ------------------------------------------------------------

test('official engine installs a policy from the card and bypasses the other hosts', async () => {
  const stub = makeOfficialStub()
  const { logs, state } = await boot({ stub, config: { proxiedModels: ['b-ai/deepseek-v4-flash'] } })

  assert.ok(logs.some((line) => line.includes('engine=official')), 'engine detection is logged')
  assert.equal(stub.calls.installs.length, 1, 'the official seam is used exactly once')

  const lookup = stub.calls.installs[0]
  assert.equal(lookup.get('https_proxy').value, 'http://127.0.0.1:7897')
  assert.equal(lookup.get('http_proxy').value, 'http://127.0.0.1:7897')
  const bypass = lookup.get('no_proxy').value.split(',')
  assert.ok(bypass.includes('api.xiaomimimo.com'), 'the unselected provider stays direct')
  assert.ok(!bypass.includes('api.b.ai'), 'the selected host is proxied, not bypassed')

  const summary = logs.find((line) => line.includes('official policy installed'))
  assert.ok(summary.includes('proxiedHosts=[api.b.ai]'))
  assert.equal(state.watcherCount(), 1, 'live apply is wired')
})

test('an empty selection leaves the official launcher policy untouched', async () => {
  const stub = makeOfficialStub()
  const { logs } = await boot({ stub, config: { proxiedModels: [] } })
  assert.equal(stub.calls.installs.length, 0)
  assert.ok(logs.some((line) => line.includes('官方策略保持不变')))
})

test('a non-http proxy endpoint is refused instead of installing a direct policy', async () => {
  const stub = makeOfficialStub()
  const { logs } = await boot({ stub, config: { proxyHost: 'socks5://127.0.0.1', proxyPort: 1080, proxiedModels: ['b-ai/deepseek-v4-flash'] } })
  assert.equal(stub.calls.installs.length, 0, 'the official resolver would fall back to DIRECT and drop the launcher policy')
  assert.ok(logs.some((line) => line.includes('http/https only')))
})

test('re-applying releases the previous overlay before installing the next', async () => {
  const stub = makeOfficialStub()
  const { state } = await boot({ stub, config: { proxiedModels: ['b-ai/deepseek-v4-flash'] } })
  assert.equal(stub.calls.disposed, 0)

  state.commit({ proxiedModels: ['xiaomi/mimo-v2.5'] })
  await flush()

  assert.equal(stub.calls.disposed, 1, 'the first overlay is given back')
  assert.equal(stub.calls.installs.length, 2)
  const bypass = stub.calls.installs[1].get('no_proxy').value.split(',')
  assert.ok(bypass.includes('api.b.ai'), 'the now-unselected host moves to the bypass list')
  assert.ok(!bypass.includes('api.xiaomimimo.com'))
})

test('teardown gives the launcher its policy back', async () => {
  const stub = makeOfficialStub()
  const { disposers } = await boot({ stub, config: { proxiedModels: ['b-ai/deepseek-v4-flash'] } })
  assert.equal(disposers.length, 1)
  for (const dispose of disposers) dispose()
  await flush()
  assert.equal(stub.calls.disposed, 1)
})

test('unselected hosts and provider restores are reported by resolveProxySelection', () => {
  const settings = { describe: () => [PI_AI] }
  const all = resolveProxySelection(settings, [], undefined)
  assert.deepEqual(all, { proxied: [], direct: [] }, 'nothing selected means nothing to install')

  const split = resolveProxySelection(settings, ['xiaomi/mimo-v2.5'], undefined)
  assert.deepEqual(split.proxied, ['api.xiaomimimo.com'])
  assert.deepEqual(split.direct, ['api.b.ai'])
})

// --- the verdict the card reports ---------------------------------------------

test('连接测试 reports the engine route, not the configured selection', async () => {
  const settings = { describe: () => [PI_AI] }
  const outcome = await runConnectionTest(settings, 'b-ai/deepseek-v4-flash', {
    fetchImpl: async () => ({ status: 200, ok: true }),
    env: {},
    routeFor: () => ({ proxied: true, proxy: 'http://127.0.0.1:7897' }),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.viaProxy, true, 'the engine proxied it even though the model is not selected')
})

test('连接测试 falls back to the selection when the engine cannot answer', async () => {
  const settings = { describe: () => [PI_AI] }
  const outcome = await runConnectionTest(settings, 'b-ai/deepseek-v4-flash', {
    fetchImpl: async () => ({ status: 200, ok: true }),
    env: {},
    routeFor: () => { throw new Error('engine gone') },
  })
  assert.equal(outcome.viaProxy, false, 'selection says direct, and the failing engine must not break the probe')
})
