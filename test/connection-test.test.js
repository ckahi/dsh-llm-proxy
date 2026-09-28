/**
 * dsh-llm-proxy — connection-test unit tests.
 *
 * Covers: target resolution (llm-pi-ai explicit + catalog, llm-deepseek,
 * apiKey inline vs apiKeyEnv), the probe mapping (2xx / 401 / 404 / 429 /
 * 5xx / network / timeout), the viaProxy flag from the llm-proxy
 * config, and the bridge /test route envelope. No real network is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { listModels, makeBridgeHandlers, makeBridgeRoutes, SETTINGS_BRIDGE_PREFIX } from '../lib/settings.js'
import {
  chatCompletionsURL, DEFAULT_TEST_TIMEOUT_MS, findTestTarget, runConnectionTest,
} from '../lib/connection-test.js'

/** Build a fake settings seam with an llm-proxy view + optional provider views. */
function makeSeam({ proxiedModels = [], providers, deepseek = {}, documentPath } = {}) {
  const descriptors = [
    {
      ns: 'llm-proxy',
      schema: {},
      base: {},
      user: {},
      value: { ...Config({}), proxiedModels },
      revision: 0,
    },
  ]
  if (providers !== undefined) {
    descriptors.push({
      ns: 'llm-pi-ai',
      schema: {},
      base: {},
      user: {},
      value: { providers },
      revision: 0,
    })
  }
  descriptors.push({
    ns: 'llm-deepseek',
    schema: {},
    base: {},
    user: {},
    value: deepseek,
    revision: 0,
  })
  return { describe: () => descriptors, documentPath: documentPath ?? 'fake-settings.yaml' }
}

/** A b.ai-style provider with an inline key + explicit vision model. */
const BAI_PROVIDERS = {
  'b-ai': {
    displayName: 'B.AI',
    baseURL: 'https://api.b.ai/v1',
    apiKey: 'sk-test',
    models: [{ id: 'deepseek-v4-flash-vision-exp' }],
  },
}

const BAI_KEY = 'b-ai/deepseek-v4-flash-vision-exp'

test('chatCompletionsURL normalizes base URLs', () => {
  assert.equal(chatCompletionsURL('https://api.b.ai/v1'), 'https://api.b.ai/v1/chat/completions')
  assert.equal(chatCompletionsURL('https://api.b.ai/v1/'), 'https://api.b.ai/v1/chat/completions')
  assert.equal(chatCompletionsURL('https://api.b.ai/chat/completions'), 'https://api.b.ai/chat/completions')
})

test('findTestTarget resolves an explicit llm-pi-ai model with an inline key', () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const target = findTestTarget(seam, BAI_KEY, {})
  assert.equal(target.error, undefined)
  assert.equal(target.providerId, 'b-ai')
  assert.equal(target.modelId, 'deepseek-v4-flash-vision-exp')
  assert.equal(target.baseURL, 'https://api.b.ai/v1')
  assert.equal(target.apiKey, 'sk-test')
})

test('findTestTarget resolves apiKeyEnv from the DSH credentials file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-proxy-cred-'))
  try {
    writeFileSync(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  TEST_API_KEY: sk-filekey\n')
    const seam = makeSeam({
      documentPath: join(dir, 'settings.yaml'),
      providers: {
        'b-ai': {
          apiKeyEnv: 'TEST_API_KEY',
          baseURL: 'https://api.b.ai/v1',
          models: [{ id: 'deepseek-v4-flash-vision-exp' }],
        },
      },
    })
    const target = findTestTarget(seam, BAI_KEY, {})
    assert.equal(target.error, undefined)
    assert.equal(target.apiKey, 'sk-filekey')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findTestTarget resolves apiKeyEnv from the environment', () => {
  const seam = makeSeam({
    providers: {
      xiaomi: {
        apiKeyEnv: 'XIAOMI_API_KEY',
        baseURL: 'https://api.xiaomimimo.com/v1',
        models: [{ id: 'mimo-v2.5' }],
      },
    },
  })
  const target = findTestTarget(seam, 'xiaomi/mimo-v2.5', { XIAOMI_API_KEY: 'env-key' })
  assert.equal(target.apiKey, 'env-key')
})

test('findTestTarget rejects unknown keys and providers without models', () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  assert.equal(findTestTarget(seam, 'nope/nope', {}).error.code, 'unknown-model')
  // Provider-level placeholder (no model id) is not a testable target.
  assert.equal(findTestTarget(seam, 'b-ai', {}).error.code, 'unknown-model')
})

test('listModels falls back to the llm-deepseek built-in catalog for an empty document', () => {
  const seam = makeSeam({ deepseek: {} })
  const rows = listModels(seam)
  const keys = rows.map((row) => row.key)
  assert.ok(keys.includes('deepseek-official/deepseek-v4-flash'))
  assert.ok(keys.includes('deepseek-official/deepseek-v4-pro'))
  assert.ok(keys.includes('deepseek-official/deepseek-v4-flash-vision-exp'))
  const flash = rows.find((row) => row.key === 'deepseek-official/deepseek-v4-flash')
  assert.equal(flash.providerId, 'deepseek-official')
  assert.equal(flash.name, 'DeepSeek-V4-Flash')
  assert.equal(flash.host, 'api.deepseek.com')
})

test('findTestTarget resolves llm-deepseek built-in models with default baseURL + DEEPSEEK_API_KEY', () => {
  const seam = makeSeam({ deepseek: {} })
  const target = findTestTarget(seam, 'deepseek-official/deepseek-v4-flash', { DEEPSEEK_API_KEY: 'ds-key' })
  assert.equal(target.error, undefined)
  assert.equal(target.providerId, 'deepseek-official')
  assert.equal(target.modelId, 'deepseek-v4-flash')
  assert.equal(target.baseURL, 'https://api.deepseek.com')
  assert.equal(target.apiKey, 'ds-key')

  const vision = findTestTarget(seam, 'deepseek-official/deepseek-v4-flash-vision-exp', { DEEPSEEK_API_KEY: 'ds-key' })
  assert.equal(vision.error, undefined)
  assert.equal(vision.baseURL, 'https://api.deepseek.com')
})

test('findTestTarget resolves llm-deepseek apiKeyEnv from the DSH credentials file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-proxy-ds-cred-'))
  try {
    // Use a ref absent from the real ~/.dsh/.credentials.yaml so the temp
    // document's directory is the one that supplies the key (the canonical
    // DSH_HOME candidate is checked first by design).
    writeFileSync(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_LLM_PROXY_TEST_KEY: sk-dsfile\n')
    const seam = makeSeam({
      documentPath: join(dir, 'settings.yaml'),
      deepseek: { apiKeyEnv: 'DSH_LLM_PROXY_TEST_KEY' },
    })
    const target = findTestTarget(seam, 'deepseek-official/deepseek-v4-flash', {})
    assert.equal(target.error, undefined)
    assert.equal(target.apiKey, 'sk-dsfile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findTestTarget honors an explicit llm-deepseek baseURL override', () => {
  const seam = makeSeam({
    deepseek: { baseURL: 'https://gateway.example.com/v1', models: [{ id: 'deepseek-v4-flash' }] },
  })
  const target = findTestTarget(seam, 'deepseek-official/deepseek-v4-flash', { DEEPSEEK_API_KEY: 'ds-key' })
  assert.equal(target.error, undefined)
  assert.equal(target.baseURL, 'https://gateway.example.com/v1')
})

test('runConnectionTest surfaces a sanitized provider error body on HTTP 400', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const outcome = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async () => ({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ error: { message: 'invalid api key sk-test sk-abcdefgh123456' } }),
    }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'http')
  assert.equal(outcome.status, 400)
  assert.match(outcome.message, /invalid api key/)
  // The plaintext key and sk- tokens are masked, the reason survives.
  assert.equal(outcome.body.includes('sk-test'), false)
  assert.equal(outcome.body.includes('sk-abcdefgh123456'), false)
  assert.match(outcome.body, /invalid api key/)
})

test('runConnectionTest truncates long provider error bodies', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const outcome = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async () => ({ status: 400, ok: false, text: async () => 'x'.repeat(10000) }),
  })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.body.length <= 2000)
})


test('runConnectionTest reports success with the viaProxy flag', async () => {
  const seam = makeSeam({
    proxiedModels: [BAI_KEY],
    providers: BAI_PROVIDERS,
  })
  const calls = []
  const outcome = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { status: 200, ok: true }
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, 200)
  assert.equal(outcome.viaProxy, true)
  assert.equal(typeof outcome.latencyMs, 'number')
  assert.equal(calls.length, 1)
  const request = calls[0]
  assert.equal(request.url, 'https://api.b.ai/v1/chat/completions')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers.authorization, 'Bearer sk-test')
  assert.equal(JSON.parse(request.init.body).model, 'deepseek-v4-flash-vision-exp')
  assert.equal(JSON.parse(request.init.body).max_tokens, 8)
})

test('runConnectionTest reports direct path when not proxied', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const outcome = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async () => ({ status: 200, ok: true }),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.viaProxy, false)
})

test('runConnectionTest maps auth / rate-limit / server errors', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [404, 'not-found'], [429, 'rate-limit'], [500, 'server'], [503, 'server']]) {
    const outcome = await runConnectionTest(seam, BAI_KEY, {
      env: {},
      fetchImpl: async () => ({ status, ok: status < 300 }),
    })
    assert.equal(outcome.ok, false, 'status ' + status)
    assert.equal(outcome.code, code, 'status ' + status)
  }
})

test('runConnectionTest maps network errors and timeouts', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const network = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' }) },
  })
  assert.equal(network.ok, false)
  assert.equal(network.code, 'network')
  assert.match(network.message, /ECONNREFUSED/)

  const timeout = await runConnectionTest(seam, BAI_KEY, {
    env: {},
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
  })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.code, 'timeout')
  assert.match(timeout.message, /超时/)
})

test('runConnectionTest reports a missing credential', async () => {
  const seam = makeSeam({
    providers: {
      'b-ai': { baseURL: 'https://api.b.ai/v1', models: [{ id: 'deepseek-v4-flash-vision-exp' }] },
    },
  })
  const outcome = await runConnectionTest(seam, BAI_KEY, { env: {} })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'missing-credential')
})

test('bridge handlers serve the test outcome without leaking secrets', async () => {
  const seam = makeSeam({
    proxiedModels: [BAI_KEY],
    providers: BAI_PROVIDERS,
  })
  const handlers = makeBridgeHandlers(seam, {
    env: {},
    fetchImpl: async () => ({ status: 200, ok: true }),
  })
  const result = await handlers.test({ key: BAI_KEY })
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.status, 200)
  assert.equal(result.value.viaProxy, true)
  // The plaintext key must never appear in the envelope.
  assert.equal(JSON.stringify(result).includes('sk-test'), false)
})

test('bridge routes expose the /test endpoint after /models', async () => {
  const seam = makeSeam({ providers: BAI_PROVIDERS })
  const routes = makeBridgeRoutes(seam, {
    env: {},
    fetchImpl: async () => ({ status: 200, ok: true }),
  })
  assert.equal(routes.length, 4)
  assert.equal(routes[3].path, SETTINGS_BRIDGE_PREFIX + '/test')

  function makeRes() {
    return {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(payload) { this.body = payload },
    }
  }
  const res = makeRes()
  await routes[3].handler(
    {
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: () => {
        let done = false
        return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: Buffer.from(JSON.stringify({ key: BAI_KEY })) })) }
      },
    },
    res,
  )
  assert.equal(res.status, 200)
  const envelope = JSON.parse(res.body)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.key, BAI_KEY)
})

test('DEFAULT_TEST_TIMEOUT_MS is exported for documentation parity', () => {
  assert.equal(DEFAULT_TEST_TIMEOUT_MS, 20000)
})
