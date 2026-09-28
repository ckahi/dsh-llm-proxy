/**
 * dsh-llm-proxy v5 — host-side settings wiring + bridge tests.
 *
 * Covers: the settings document served from the exported Config (live re-apply
 * on `loader/volatile-update`), the fallback when no settings service exists,
 * the loopback-only bridge (describe/mutate/models envelopes, ns gating,
 * revision conflicts, method/peer guards) and the model-list aggregation off
 * the llm-pi-ai / llm-deepseek namespaces. No real network is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { apply, Config, name, resolveProxyHosts } from '../lib/index.js'
import {
  LLM_PROXY_NAMESPACE,
  SETTINGS_BRIDGE_PREFIX,
  listModels,
  makeBridgeHandlers,
  makeBridgeRoutes,
} from '../lib/settings.js'
import { __resetCatalogForTest, __setCatalogForTest } from '../lib/catalog.js'
import { __setOfficialProxyForTest } from '../lib/official-proxy.js'

// This file covers the BUNDLED engine (dsh <= 0.1.2). Force "the official
// package is not installed" so the assertions hold on any machine — including
// one that happens to have @deepseek-ai/dsh-http-proxy on the module path.
__setOfficialProxyForTest(null)

/** Plain value of a resolved Config field (a volatile field resolves to a live accessor). */
function plain(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Plain JSON view of a resolved Config object. */
function plainConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) out[key] = plain(value)
  return out
}

/** Deep-merge helper for the fake seam's composition resolution. */
function merge(base, user) {
  const out = { ...base }
  for (const [key, value] of Object.entries(user ?? {})) {
    if (value === undefined) delete out[key]
    else if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null) {
      out[key] = { ...out[key], ...value }
    } else out[key] = value
  }
  return out
}

/** A fake host settings seam with register/get/watch/describe/mutate. */
function makeFakeSeam({ base = {}, conflict = false, writable = true, extraNamespaces = [] } = {}) {
  const user = {}
  let revision = 0
  const watchers = new Set()
  const registered = new Set()
  const resolved = () => plainConfig(merge(base, user))
  const descriptors = [
    { ns: 'llm-proxy', schema: {}, value: resolved(), base, user: { ...user }, revision },
    ...extraNamespaces,
  ]
  const seam = {
    writable,
    documentPath: 'fake-settings.yaml',
    register(ns, schema, options) {
      registered.add(String(ns))
      return {
        get: () => resolved(),
        watch(callback) {
          watchers.add(callback)
          return () => watchers.delete(callback)
        },
        update() { throw new Error('not used') },
        replace() { throw new Error('not used') },
      }
    },
    describe({ redactSecrets } = {}) {
      assert.ok(redactSecrets === true || redactSecrets === undefined, 'describe options must be redact or absent')
      return descriptors
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(String(ns), 'llm-proxy')
      if (conflict) throw new SettingsConflictError('stale revision')
      for (const op of ops) {
        const [field] = op.path
        if (op.op === 'set') user[field] = op.value
        else delete user[field]
      }
      revision += 1
      descriptors[0] = { ns: 'llm-proxy', schema: {}, value: resolved(), base, user: { ...user }, revision }
      const next = resolved()
      for (const callback of watchers) void callback(next)
    },
  }
  return { seam, state: { user, revision, registered, watchers } }
}

/** Fake cordis ctx that resolves an inject([...]) callback synchronously. */
function makeCtx({ seam, webServer = true }) {
  const calls = []
  const bus = new Map()
  const ctx = {
    logger: {
      info: (m) => calls.push(['info', m]),
      warn: (m) => calls.push(['warn', m]),
      error: (m) => calls.push(['error', m]),
    },
    on: (ev, fn) => {
      calls.push(['on', ev, typeof fn])
      bus.set(ev, [...(bus.get(ev) ?? []), fn])
      return () => {}
    },
    inject: typeof seam === 'function'
      ? (services, callback) => {
          assert.ok(Array.isArray(services) && services.includes('settings'), 'inject waits for settings')
          const sctx = { effect: (cb) => calls.push(['effect', typeof cb]) }
          for (const service of services) {
            if (service === 'settings') sctx.settings = seam()
            if (service === 'webServer' && webServer) {
              sctx.webServer = { register: (route) => calls.push(['route', route.path]) }
            }
          }
          callback(sctx)
        }
      : undefined,
  }
  /** Fire a cordis event on this fake bus (the plugin's own listeners). */
  const emit = (ev, ...args) => {
    for (const fn of bus.get(ev) ?? []) fn(...args)
  }
  return { ctx, calls, emit }
}

/** A typical llm-pi-ai namespace view (b.ai-style provider + domestic provider). */
const PI_AI_NAMESPACE = {
  ns: 'llm-pi-ai',
  schema: {},
  value: {
    providers: {
      'deepseek-v4-flash': {
        displayName: 'deepseek-v4-flash（B.AI）',
        baseURL: 'https://api.b.ai/v1',
        models: [{ id: 'deepseek-v4-flash' }],
      },
      xiaomi: {
        displayName: 'xiaomi',
        baseURL: 'https://api.xiaomimimo.com/v1',
        models: [{ id: 'mimo-v2.5' }],
      },
    },
  },
  base: {},
  user: {},
  revision: 0,
}

const DEEPSEEK_NAMESPACE = {
  ns: 'llm-deepseek',
  schema: {},
  value: {
    baseURL: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
  },
  base: {},
  user: {},
  revision: 0,
}

test('plugin exports name and Config schema', () => {
  assert.equal(name, 'dsh-llm-proxy')
  assert.equal(typeof Config, 'function')
})

test('Config resolves every field to a live accessor with the documented defaults', () => {
  const cfg = Config({})
  // dsh 0.1.7 hands a `volatile()` field to apply() as a live accessor — the
  // handle a committed settings write lands on — so read through `.get()`.
  assert.equal(typeof cfg.proxyHost.get, 'function', 'volatile field is a live accessor')
  assert.equal(plain(cfg.proxyHost), '127.0.0.1')
  assert.equal(plain(cfg.proxyPort), 7897)
  assert.deepEqual(plain(cfg.proxiedModels), [])
  assert.equal(plain(cfg.retries), 3)
  assert.equal(plain(cfg.retryIntervalMs), 1000)
})

test('apply serves the settings document from Config and installs the dispatcher (live)', async () => {
  const base = Config({ proxiedModels: ['deepseek-v4-flash/deepseek-v4-flash'] })
  const { seam } = makeFakeSeam({ base, extraNamespaces: [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] })
  const { ctx, calls } = makeCtx({ seam: () => seam })
  await apply(ctx, base)
  // dsh 0.1.7 derives the document from the exported Config schema; there is no
  // namespace registration left to perform.
  assert.ok(calls.some(([kind, msg]) => kind === 'info' && msg.includes('settings document "llm-proxy" served from Config')), 'document service logged')
  const installLogs = calls.filter(([kind, msg]) => kind === 'info' && msg.includes('RoutingDispatcher'))
  assert.equal(installLogs.length, 1, 'initial install from resolved value')
  assert.ok(installLogs[0][1].includes('api.b.ai'), 'install log shows the proxied host')
  assert.ok(calls.some(([kind, path]) => kind === 'route' && path === `${SETTINGS_BRIDGE_PREFIX}/describe`), 'describe route mounted')
  assert.ok(calls.some(([kind, path]) => kind === 'route' && path === `${SETTINGS_BRIDGE_PREFIX}/mutate`), 'mutate route mounted')
  assert.ok(calls.some(([kind, path]) => kind === 'route' && path === `${SETTINGS_BRIDGE_PREFIX}/models`), 'models route mounted')
  assert.ok(calls.some(([kind, path]) => kind === 'route' && path === `${SETTINGS_BRIDGE_PREFIX}/test`), 'test route mounted')
})

test('a volatile config update re-applies the dispatcher', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base, extraNamespaces: [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] })
  const { ctx, calls, emit } = makeCtx({ seam: () => seam })
  await apply(ctx, base)
  const before = calls.filter(([kind, msg]) => kind === 'info' && msg.includes('RoutingDispatcher')).length
  // The loader commits a settings write into the live accessors in place and
  // emits `loader/volatile-update` on this fiber only (cordis-plugin-loader
  // `_commitVolatile`) — no registered scope, no watch.
  base.proxiedModels = ['deepseek-v4-flash/deepseek-v4-flash']
  emit('loader/volatile-update', [['proxiedModels']])
  const installs = calls.filter(([kind, msg]) => kind === 'info' && msg.includes('RoutingDispatcher'))
  assert.equal(installs.length, before + 1, 'one re-install per committed change')
  assert.ok(installs[installs.length - 1][1].includes('api.b.ai'), 're-install took the new selection')
})

test('apply falls back to patch config without a settings seam', async () => {
  const { ctx, calls } = makeCtx({ seam: undefined })
  const config = Config({ proxiedModels: [] })
  await apply(ctx, config)
  const installLogs = calls.filter(([kind, msg]) => kind === 'info' && msg.includes('RoutingDispatcher'))
  assert.equal(installLogs.length, 1, 'install happens')
  assert.ok(calls.some(([kind, ev]) => kind === 'on' && ev === 'dispose'), 'dispose hook registered')
})

test('resolveProxyHosts maps selected model keys to baseURL hosts', () => {
  const settings = { describe: () => [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] }
  const hosts = resolveProxyHosts(settings, ['deepseek-v4-flash/deepseek-v4-flash'], undefined)
  assert.deepEqual(hosts, ['api.b.ai'])
})

test('resolveProxyHosts ignores unknown keys and empty selections', () => {
  const settings = { describe: () => [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] }
  assert.deepEqual(resolveProxyHosts(settings, [], undefined), [])
  assert.deepEqual(resolveProxyHosts(settings, ['nope/nope'], undefined), [])
  assert.deepEqual(resolveProxyHosts(undefined, ['deepseek-v4-flash/deepseek-v4-flash'], undefined), [])
})

test('resolveProxyHosts handles the deepseek-official route', () => {
  const settings = { describe: () => [DEEPSEEK_NAMESPACE] }
  const hosts = resolveProxyHosts(settings, ['deepseek-official/deepseek-v4-flash'], undefined)
  assert.deepEqual(hosts, ['api.deepseek.com'])
})

test('listModels aggregates llm-pi-ai and llm-deepseek models', () => {
  const settings = { describe: () => [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] }
  const rows = listModels(settings)
  const keys = rows.map((r) => r.key).sort()
  assert.deepEqual(keys, [
    'deepseek-official/deepseek-v4-flash',
    'deepseek-official/deepseek-v4-pro',
    'deepseek-v4-flash/deepseek-v4-flash',
    'xiaomi/mimo-v2.5',
  ])
  const bai = rows.find((r) => r.key === 'deepseek-v4-flash/deepseek-v4-flash')
  assert.equal(bai.host, 'api.b.ai')
  assert.equal(bai.name, 'deepseek-v4-flash')
  assert.equal(bai.providerLabel.includes('B.AI'), true)
})

test('bridge describe serves the llm-proxy namespace view', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base })
  const handlers = makeBridgeHandlers(seam)
  const result = await handlers.describe()
  assert.equal(result.ok, true)
  assert.equal(result.value.writable, true)
  assert.equal(result.value.namespaces.length, 1)
  assert.equal(result.value.namespaces[0].ns, 'llm-proxy')
  assert.equal(result.value.namespaces[0].value.proxyPort, 7897)
})

test('bridge mutate persists ops and returns the updated view', async () => {
  const base = Config({})
  const { seam, state } = makeFakeSeam({ base })
  const handlers = makeBridgeHandlers(seam)
  const result = await handlers.mutate({
    ns: 'llm-proxy',
    ops: [{ op: 'set', path: ['proxyPort'], value: 7898 }],
  })
  assert.equal(result.ok, true)
  assert.equal(state.user.proxyPort, 7898)
  assert.equal(result.value.value.proxyPort, 7898)
  assert.equal(typeof result.value.revision, 'number')
})

test('bridge mutate refuses unknown namespaces', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base })
  const handlers = makeBridgeHandlers(seam)
  const result = await handlers.mutate({ ns: 'other-plugin', ops: [] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'settings-rejected')
})

test('bridge mutate rejects malformed bodies', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base })
  const handlers = makeBridgeHandlers(seam)
  for (const body of [null, {}, { ns: 'llm-proxy' }, { ns: 'llm-proxy', ops: 'nope' }, { ns: 42, ops: [] }]) {
    const result = await handlers.mutate(body)
    assert.equal(result.ok, false, JSON.stringify(body))
    assert.equal(result.code, 'settings-rejected')
  }
})

test('bridge maps seam conflicts to settings-conflict', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base, conflict: true })
  const handlers = makeBridgeHandlers(seam)
  const result = await handlers.mutate({ ns: 'llm-proxy', ops: [{ op: 'set', path: ['proxyHost'], value: '10.0.0.1' }], expectedRevision: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'settings-conflict')
})

test('bridge routes enforce loopback + POST', async () => {
  const base = Config({})
  const { seam } = makeFakeSeam({ base })
  const routes = makeBridgeRoutes(seam)
  assert.equal(routes.length, 4)
  assert.equal(routes[3].path, SETTINGS_BRIDGE_PREFIX + '/test')

  function makeRes() {
    return {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(payload) { this.body = payload },
    }
  }

  // Non-loopback peer → 403.
  const res1 = makeRes()
  await routes[0].handler(
    { method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '192.168.1.5' } },
    res1,
  )
  assert.equal(res1.status, 403)

  // GET on a loopback peer → 405.
  const res2 = makeRes()
  await routes[0].handler(
    { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    res2,
  )
  assert.equal(res2.status, 405)

  // Loopback + POST with an unreadable body → 400.
  const res3 = makeRes()
  await routes[1].handler(
    { method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) },
    res3,
  )
  assert.equal(res3.status, 400)

  // Loopback + POST with a valid body → 200 with a result envelope.
  const res4 = makeRes()
  await routes[1].handler(
    {
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: () => {
        let done = false
        return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: Buffer.from('{"ns":"llm-proxy","ops":[]}') })) }
      },
    },
    res4,
  )
  assert.equal(res4.status, 200)
  const envelope = JSON.parse(res4.body)
  assert.equal(envelope.ok, true)
  // The mutate handler returns the single namespace view, not a namespaces list.
  assert.equal(envelope.value.ns, 'llm-proxy')

  // models endpoint serves the aggregated list over loopback + POST.
  const res5 = makeRes()
  const seamWithModels = makeFakeSeam({ base, extraNamespaces: [PI_AI_NAMESPACE, DEEPSEEK_NAMESPACE] }).seam
  const routes2 = makeBridgeRoutes(seamWithModels)
  await routes2[2].handler(
    {
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    },
    res5,
  )
  assert.equal(res5.status, 200)
  const modelEnvelope = JSON.parse(res5.body)
  assert.equal(modelEnvelope.ok, true)
  assert.ok(Array.isArray(modelEnvelope.value.models))
  assert.ok(modelEnvelope.value.models.some((m) => m.key === 'deepseek-v4-flash/deepseek-v4-flash'))
})

// --- bridge reverse-proxy trust (trustedOrigins whitelist) ------------------

test('bridge guard: reverse-proxy Host stays 403 unless whitelisted', async () => {
  const seam = makeFakeSeam().seam
  function makeRes() {
    return {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(payload) { this.body = payload },
    }
  }
  async function probe({ host, origin, trustedOrigins = [] }) {
    const routes = makeBridgeRoutes(seam, { trustedOrigins })
    const res = makeRes()
    await routes[0].handler(
      {
        method: 'POST',
        headers: { host, ...(origin === undefined ? {} : { origin }) },
        socket: { remoteAddress: '127.0.0.1' },
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      },
      res,
    )
    return res.status
  }

  // 反代 + 白名单为空（默认）→ 403，保持现状。
  assert.equal(await probe({ host: 'dsh.example.com', origin: 'https://dsh.example.com' }), 403)
  // 反代 + 白名单命中 → 放行。
  assert.equal(
    await probe({ host: 'dsh.example.com', origin: 'https://dsh.example.com', trustedOrigins: ['https://dsh.example.com'] }),
    200,
  )
  // 白名单命中但 Origin 是攻击者站点 → 仍 403（CSRF 同源防线保留）。
  assert.equal(
    await probe({ host: 'dsh.example.com', origin: 'https://evil.example.net', trustedOrigins: ['https://dsh.example.com'] }),
    403,
  )
  // 白名单不匹配其它域名。
  assert.equal(
    await probe({ host: 'other.example.com', origin: 'https://other.example.com', trustedOrigins: ['https://dsh.example.com'] }),
    403,
  )
  // 本机直连不依赖白名单，默认仍可用。
  assert.equal(await probe({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), 200)
})

// --- pi-ai catalog fallback (providers without explicit models) ------------

/** A fake catalog matching the pi-ai built-in MiMo set (id/name/baseUrl). */
function fakeXiaomiCatalog() {
  return {
    xiaomi: [
      { id: 'mimo-v2-flash', name: 'MiMo-V2-Flash', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { id: 'mimo-v2.5', name: 'MiMo-V2.5', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { id: 'mimo-v2.5-pro-ultraspeed', name: 'MiMo-V2.5-Pro-UltraSpeed', baseUrl: 'https://api.xiaomimimo.com/v1' },
    ],
  }
}

/** llm-pi-ai view whose xiaomi provider declares only an apiKeyEnv. */
function xiaomiBareNamespace() {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' } } },
    base: {},
    user: {},
    revision: 0,
  }
}

test('listModels falls back to the pi-ai catalog for providers without explicit models', () => {
  __setCatalogForTest((providerId) => fakeXiaomiCatalog()[providerId] ?? [])
  try {
    const settings = { describe: () => [xiaomiBareNamespace()] }
    const rows = listModels(settings)
    const keys = rows.map((r) => r.key).sort()
    assert.deepEqual(keys, [
      'xiaomi/mimo-v2-flash',
      'xiaomi/mimo-v2-omni',
      'xiaomi/mimo-v2-pro',
      'xiaomi/mimo-v2.5',
      'xiaomi/mimo-v2.5-pro',
      'xiaomi/mimo-v2.5-pro-ultraspeed',
    ])
    const first = rows.find((r) => r.key === 'xiaomi/mimo-v2-flash')
    assert.equal(first.modelId, 'mimo-v2-flash')
    assert.equal(first.name, 'MiMo-V2-Flash')
    assert.equal(first.providerLabel, 'xiaomi')
    // The catalog entry carries the baseURL (the profile has none).
    assert.equal(first.host, 'api.xiaomimimo.com')
  } finally {
    __resetCatalogForTest()
  }
})

test('listModels keeps the single placeholder row when the catalog is unavailable', () => {
  __setCatalogForTest(null) // simulates pi-ai not installed / import failure
  try {
    const settings = { describe: () => [xiaomiBareNamespace()] }
    const rows = listModels(settings)
    assert.deepEqual(rows.map((r) => r.key), ['xiaomi'])
    assert.equal(rows[0].modelId, '')
  } finally {
    __resetCatalogForTest()
  }
})

test('listModels catalog fallback prefers explicit models when present', () => {
  __setCatalogForTest((providerId) => fakeXiaomiCatalog()[providerId] ?? [])
  try {
    const ns = xiaomiBareNamespace()
    ns.value.providers.xiaomi = {
      apiKeyEnv: 'XIAOMI_API_KEY',
      baseURL: 'https://api.xiaomimimo.com/v1',
      models: [{ id: 'mimo-v2.5' }],
    }
    const rows = listModels({ describe: () => [ns] })
    assert.deepEqual(rows.map((r) => r.key), ['xiaomi/mimo-v2.5'])
    assert.equal(rows[0].name, 'mimo-v2.5')
  } finally {
    __resetCatalogForTest()
  }
})

test('resolveProxyHosts matches catalog-backed models without explicit models', () => {
  __setCatalogForTest((providerId) => fakeXiaomiCatalog()[providerId] ?? [])
  try {
    const settings = { describe: () => [xiaomiBareNamespace()] }
    // Catalog-backed model key resolves the host from the catalog baseURL.
    const hosts = resolveProxyHosts(settings, ['xiaomi/mimo-v2.5'], undefined)
    assert.deepEqual(hosts, ['api.xiaomimimo.com'])
    // Unknown catalog model stays unmatched.
    assert.deepEqual(resolveProxyHosts(settings, ['xiaomi/not-a-model'], undefined), [])
  } finally {
    __resetCatalogForTest()
  }
})
