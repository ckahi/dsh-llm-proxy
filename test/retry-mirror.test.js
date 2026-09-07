/**
 * dsh-llm-proxy v1.0.3 — retry-policy mirroring tests.
 *
 * The card's `retries`/`retryIntervalMs` must be mirrored into the official
 * per-provider `retryPolicy` (which drives the visible "(retry/maximum)" UI)
 * for exactly the providers whose models are selected in `proxiedModels`.
 * Unselected providers must keep the official defaults untouched, and
 * deselecting a model must restore the defaults we previously wrote.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'
import { __resetCatalogForTest, __setCatalogForTest } from '../lib/catalog.js'

/** Flush pending microtasks/macrotasks so fire-and-forget async settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** llm-pi-ai namespace view: one selected model provider + one bystander. */
const PI_AI_VALUE = {
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
}

/**
 * Fake seam that accepts cross-namespace mutate on `llm-pi-ai` (as the real
 * dsh-settings seam does) and reflects provider-layer edits into describe().
 */
function makeMirrorSeam({ base }) {
  const proxyUser = {}
  const piUser = {}
  const watchers = new Set()
  const registered = new Set()
  const resolvePi = () => {
    const value = structuredClone(PI_AI_VALUE)
    for (const [pid, patch] of Object.entries(piUser)) {
      value.providers[pid] = { ...(value.providers[pid] ?? {}), ...patch }
    }
    return value
  }
  const seam = {
    writable: true,
    documentPath: 'fake-settings.yaml',
    register(ns) {
      registered.add(String(ns))
      return {
        get: () => ({ ...base, ...proxyUser }),
        watch(callback) {
          watchers.add(callback)
          return () => watchers.delete(callback)
        },
        update() { throw new Error('not used') },
        replace() { throw new Error('not used') },
      }
    },
    describe() {
      return [
        { ns: 'llm-proxy', schema: {}, value: { ...base, ...proxyUser } },
        { ns: 'llm-pi-ai', schema: {}, value: resolvePi() },
      ]
    },
    async mutate(ns, ops) {
      if (String(ns) === 'llm-proxy') {
        for (const op of ops) {
          const [field] = op.path
          if (op.op === 'set') proxyUser[field] = op.value
          else delete proxyUser[field]
        }
        const next = { ...base, ...proxyUser }
        for (const callback of watchers) void callback(next)
      } else {
        assert.equal(String(ns), 'llm-pi-ai')
        for (const op of ops) {
          const [, providerId, key] = op.path
          assert.equal(key, 'retryPolicy')
          if (op.op === 'set') {
            piUser[providerId] = { ...(piUser[providerId] ?? {}), retryPolicy: op.value }
          } else {
            if (piUser[providerId]) delete piUser[providerId].retryPolicy
          }
        }
      }
    },
  }
  return { seam, getPi: resolvePi, state: { registered } }
}

/** Minimal cordis ctx: inject resolves settings (+ webServer for bridge routes). */
function makeCtx({ seam }) {
  const calls = []
  const ctx = {
    logger: {
      info: (m) => calls.push(['info', m]),
      warn: (m) => calls.push(['warn', m]),
      error: (m) => calls.push(['error', m]),
    },
    on: () => () => {},
    inject(services, callback) {
      const sctx = { effect: () => {} }
      for (const service of services) {
        if (service === 'settings') sctx.settings = seam
        if (service === 'webServer') sctx.webServer = { register: (route) => calls.push(['route', route.path]) }
      }
      callback(sctx)
    },
  }
  return { ctx, calls }
}

test('mirror writes retryPolicy for selected models only', async () => {
  const base = Config({
    proxiedModels: ['deepseek-v4-flash/deepseek-v4-flash'],
    retries: 5,
    retryIntervalMs: 1000,
  })
  const { seam, getPi } = makeMirrorSeam({ base })
  const { ctx } = makeCtx({ seam })
  await apply(ctx, base)
  await tick()
  await tick()

  const pi = getPi()
  const selected = pi.providers['deepseek-v4-flash'].retryPolicy
  assert.equal(selected.maxRetries, 5, 'selected model mirrors card retries')
  assert.equal(selected.backoff.initialDelayMs, 1000, 'selected model mirrors card interval')
  assert.equal(selected.backoff.maxDelayMs, 1000, 'fixed-interval: maxDelayMs == initialDelayMs')
  assert.equal(selected.backoff.jitterRatio, 0, 'fixed-interval: jitter disabled')
  assert.deepEqual(selected.retryableCodes, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'INVALID_REQUEST'], 'mirrored retryableCodes cover QUOTA + INVALID_REQUEST')
  assert.equal(selected.mode, 'normal')
  assert.equal(pi.providers.xiaomi.retryPolicy, undefined, 'unselected provider untouched')
})

test('mirror follows card edits (watch path)', async () => {
  const base = Config({
    proxiedModels: ['deepseek-v4-flash/deepseek-v4-flash'],
    retries: 3,
    retryIntervalMs: 1000,
  })
  const { seam, getPi } = makeMirrorSeam({ base })
  const { ctx } = makeCtx({ seam })
  await apply(ctx, base)
  await tick()
  await tick()

  // User edits the card: retries 3 → 8. The bridge writes the llm-proxy
  // namespace, which triggers the scope watch → re-mirror.
  await seam.mutate('llm-proxy', [{ op: 'set', path: ['retries'], value: 8 }])
  await tick()
  await tick()

  const pi = getPi()
  assert.equal(pi.providers['deepseek-v4-flash'].retryPolicy.maxRetries, 8, 'card edit re-mirrored to official retryPolicy')
})

test('deselecting a model restores official defaults', async () => {
  const base = Config({
    proxiedModels: ['deepseek-v4-flash/deepseek-v4-flash'],
    retries: 5,
    retryIntervalMs: 1000,
  })
  const { seam, getPi } = makeMirrorSeam({ base })
  const { ctx } = makeCtx({ seam })
  await apply(ctx, base)
  await tick()
  await tick()
  assert.equal(getPi().providers['deepseek-v4-flash'].retryPolicy.maxRetries, 5, 'mirrored first')

  // Deselect every model from the card.
  await seam.mutate('llm-proxy', [{ op: 'set', path: ['proxiedModels'], value: [] }])
  await tick()
  await tick()

  const pi = getPi()
  assert.equal(pi.providers['deepseek-v4-flash'].retryPolicy, undefined, 'deselect restored official defaults')
  assert.equal(pi.providers.xiaomi.retryPolicy, undefined, 'bystander still untouched')
})

// --- catalog-backed providers (no explicit models in the profile) ----------

/** A bare xiaomi provider (apiKeyEnv only) with a pi-ai-style catalog. */
function makeCatalogSeam({ base }) {
  const proxyUser = {}
  const piUser = {}
  const watchers = new Set()
  const registered = new Set()
  const resolvePi = () => {
    const value = {
      providers: {
        xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' }, // no models, no baseURL
        'deepseek-v4-flash': {
          displayName: 'deepseek-v4-flash（B.AI）',
          baseURL: 'https://api.b.ai/v1',
          models: [{ id: 'deepseek-v4-flash' }],
        },
      },
    }
    for (const [pid, patch] of Object.entries(piUser)) {
      value.providers[pid] = { ...(value.providers[pid] ?? {}), ...patch }
    }
    return value
  }
  const seam = {
    writable: true,
    documentPath: 'fake-settings.yaml',
    register(ns) {
      registered.add(String(ns))
      return {
        get: () => ({ ...base, ...proxyUser }),
        watch(callback) {
          watchers.add(callback)
          return () => watchers.delete(callback)
        },
        update() { throw new Error('not used') },
        replace() { throw new Error('not used') },
      }
    },
    describe() {
      return [
        { ns: 'llm-proxy', schema: {}, value: { ...base, ...proxyUser } },
        { ns: 'llm-pi-ai', schema: {}, value: resolvePi() },
      ]
    },
    async mutate(ns, ops) {
      if (String(ns) === 'llm-proxy') {
        for (const op of ops) {
          const [field] = op.path
          if (op.op === 'set') proxyUser[field] = op.value
          else delete proxyUser[field]
        }
        const next = { ...base, ...proxyUser }
        for (const callback of watchers) void callback(next)
      } else {
        assert.equal(String(ns), 'llm-pi-ai')
        for (const op of ops) {
          const [, providerId, key] = op.path
          assert.equal(key, 'retryPolicy')
          if (op.op === 'set') {
            piUser[providerId] = { ...(piUser[providerId] ?? {}), retryPolicy: op.value }
          } else {
            if (piUser[providerId]) delete piUser[providerId].retryPolicy
          }
        }
      }
    },
  }
  return { seam, getPi: resolvePi, state: { registered } }
}

test('mirror matches catalog-backed providers (no explicit models)', async () => {
  __setCatalogForTest((providerId) => (providerId === 'xiaomi' ? [
    { id: 'mimo-v2.5', name: 'MiMo-V2.5', baseUrl: 'https://api.xiaomimimo.com/v1' },
  ] : []))
  try {
    const base = Config({
      proxiedModels: ['xiaomi/mimo-v2.5'],
      retries: 7,
      retryIntervalMs: 2000,
    })
    const { seam, getPi } = makeCatalogSeam({ base })
    const { ctx } = makeCtx({ seam })
    await apply(ctx, base)
    await tick()
    await tick()

    const pi = getPi()
    const mirrored = pi.providers.xiaomi.retryPolicy
    assert.equal(mirrored.maxRetries, 7, 'catalog-backed model mirrors card retries')
    assert.equal(mirrored.backoff.initialDelayMs, 2000, 'catalog-backed model mirrors card interval')
    assert.equal(mirrored.backoff.maxDelayMs, 2000, 'catalog-backed fixed-interval: maxDelayMs == initialDelayMs')
    assert.equal(mirrored.backoff.jitterRatio, 0, 'catalog-backed fixed-interval: jitter disabled')
    assert.equal(pi.providers['deepseek-v4-flash'].retryPolicy, undefined, 'unselected provider untouched')
  } finally {
    __resetCatalogForTest()
  }
})
