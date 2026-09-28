/**
 * dsh-llm-proxy — per-model connection test.
 *
 * The 设置 card's「测试连接」button asks the host to probe one model key
 * (`<providerId>/<modelId>`) with a minimal chat-completions request. The
 * probe rides the process-global dispatcher (the official one when
 * `@deepseek-ai/dsh-http-proxy` is installed, the bundled one otherwise), so it
 * exercises the exact path a real LLM call takes: proxied models go through the
 * proxy, everything else stays direct — a timeout on an overseas model is
 * exactly the signal that it is not (yet) selected in 走代理的模型.
 *
 * Since v1.4.0 the 经代理／直连 field is the engine's own verdict for that URL
 * (`routeFor`, wired from lib/index.js), not the configured selection: the two
 * can legitimately differ once the official policy owns the process.
 *
 * Secrets never cross the wire: the host reads the API key from the settings
 * seam (inline `apiKey`), the process environment (`apiKeyEnv`) or the DSH
 * credentials file (`$DSH_HOME/.credentials.yaml`), builds the Authorization
 * header locally, and only returns status / latency / flag fields to the card.
 */
import { catalogBuiltinModels } from './catalog.js'
import { listModels } from './settings.js'
import { DEEPSEEK_OFFICIAL_PROVIDER_ID, deepSeekConnection } from './deepseek-official.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Strip trailing slashes from a URL. */
function trimSlash(url) {
  return url.replace(/\/+$/, '')
}

/** The chat-completions endpoint for a baseURL (already-suffixed URLs pass through). */
export function chatCompletionsURL(baseURL) {
  const base = trimSlash(baseURL)
  if (base.endsWith('/chat/completions')) return base
  return base + '/chat/completions'
}

/**
 * Read one credential ref from the DSH credentials file
 * (`$DSH_HOME/.credentials.yaml`, i.e. `<dir of settings.yaml>/.credentials.yaml`).
 * The file format is a flat `refs:` map, e.g.:
 *
 * ```yaml
 * version: 1
 * refs:
 *   DEEPSEEK_V4_FLASH_API_KEY: sk-...
 * ```
 */
function resolveCredentialFromFile(settings, refName) {
  try {
    const candidates = []
    // 1. $HOME/.dsh (the canonical DSH_HOME; homedir() avoids Windows path
    //    literal pitfalls with non-ASCII usernames)
    const home = homedir()
    if (typeof home === 'string' && home.length > 0) candidates.push(join(home, '.dsh'))
    // 2. The directory holding the settings document (custom DSH_HOME)
    if (settings && typeof settings.documentPath === 'string' && settings.documentPath.length > 0) {
      candidates.push(dirname(settings.documentPath))
    }
    const prefix = '  ' + refName + ':'
    for (const dshHome of candidates) {
      const credFile = join(dshHome, '.credentials.yaml')
      let raw
      try {
        raw = readFileSync(credFile, 'utf8')
      } catch {
        continue // try the next candidate
      }
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(prefix)) {
          let value = line.slice(prefix.length).trim()
          const first = value[0]
          const last = value[value.length - 1]
          if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
            value = value.slice(1, -1)
          }
          if (value.length > 0) return value
        }
      }
    }
  } catch {
    // File not found, unreadable, or malformed
  }
  return undefined
}

/** Resolve the API key for a provider profile (inline value → env → DSH credentials file). */
function resolveApiKey(profile, env, settingsSeam) {
  if (typeof profile.apiKey === 'string' && profile.apiKey.length > 0) return profile.apiKey
  if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) {
    // 1. Environment variable
    if (typeof env?.[profile.apiKeyEnv] === 'string' && env[profile.apiKeyEnv].length > 0) return env[profile.apiKeyEnv]
    // 2. DSH credentials file ($DSH_HOME/.credentials.yaml)
    const cred = resolveCredentialFromFile(settingsSeam, profile.apiKeyEnv)
    if (cred !== undefined) return cred
  }
  return undefined
}

/**
 * Resolve the connection facts (baseURL + apiKey) for one model row from the
 * UNREDACTED settings seam — the key is read here and never leaves this module.
 * Applies the same catalog fallbacks as `listModels` (pi-ai built-in catalog,
 * llm-deepseek official built-in defaults).
 *
 * @returns `{ baseURL, apiKey }`, or undefined when the seam has no usable entry.
 */
function resolveModelConnection(settings, providerId, modelId, env, settingsSeam) {
  try {
    const descriptors = settings.describe()
    for (const descriptor of descriptors) {
      const ns = String(descriptor.ns)
      const value = descriptor.value
      if (typeof value !== 'object' || value === null) continue
      if (ns === 'llm-pi-ai' && typeof value.providers === 'object' && value.providers !== null) {
        const profile = value.providers[providerId]
        if (typeof profile !== 'object' || profile === null) continue
        const models = Array.isArray(profile.models) ? profile.models : []
        const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
        // Catalog-backed provider: the model may not appear in the user
        // document, so fall back to the catalog row's baseURL when needed.
        let baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0
          ? profile.baseURL
          : ''
        if (baseURL.length === 0 && explicitIds.length === 0) {
          const catalog = catalogBuiltinModels(providerId)
          const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : []
          const modelRow = catalogRows.find((m) => m?.id === modelId)
          baseURL = modelRow?.baseUrl ?? catalogRows[0]?.baseUrl ?? ''
        }
        if (baseURL.length === 0) continue
        return { baseURL, apiKey: resolveApiKey(profile, env, settingsSeam) }
      }
      if (ns === 'llm-deepseek' && providerId === DEEPSEEK_OFFICIAL_PROVIDER_ID) {
        // `llm-deepseek: {}` still resolves built-in defaults for models and
        // apiKeyEnv, but NOT for baseURL (no schema default) — mirror the
        // adapter's own fallback so the official models are testable.
        const { models, baseURL, apiKeyEnv } = deepSeekConnection(value)
        if (!models.some((m) => m?.id === modelId)) continue
        return { baseURL, apiKey: resolveApiKey({ ...value, baseURL, apiKeyEnv }, env, settingsSeam) }
      }
    }
  } catch {
    /* malformed settings seam */
  }
  return undefined
}

/**
 * Resolve the target for a model key across the provider namespaces.
 * Matching runs against the SAME model list the settings card renders
 * (`listModels`: llm-pi-ai explicit + pi-ai catalog fallback, llm-deepseek
 * official built-in defaults), so every model the UI can select is testable.
 * Reads the UNREDACTED descriptor on purpose — this runs on the host only and
 * its result never leaves this module.
 *
 * @returns `{ providerId, modelId, baseURL, apiKey }` or `{ error }`.
 */
export function findTestTarget(settings, key, env = process.env, settingsSeam = settings) {
  if (typeof key !== 'string' || key.length === 0) {
    return { error: { code: 'unknown-model', message: 'model key is empty' } }
  }
  try {
    const rows = listModels(settings)
    const row = rows.find((candidate) => candidate.key === key)
    if (row === undefined || typeof row.modelId !== 'string' || row.modelId.length === 0) {
      return { error: { code: 'unknown-model', message: '未找到该模型，请先在 设置 → 模型 中配置' } }
    }
    const connection = resolveModelConnection(settingsSeam, row.providerId, row.modelId, env, settingsSeam)
    if (connection === undefined) {
      return { error: { code: 'unknown-model', message: '未找到该模型，请先在 设置 → 模型 中配置' } }
    }
    return { providerId: row.providerId, modelId: row.modelId, ...connection }
  } catch {
    return { error: { code: 'unknown-model', message: '未找到该模型，请先在 设置 → 模型 中配置' } }
  }
}

/** Cap for bytes read from a provider error body. */
const MAX_ERROR_BODY_BYTES = 4096

/** Cap for the body text kept on the outcome (truncated). */
const MAX_ERROR_BODY_CHARS = 2000

/** Read a provider response body text, capped; never rejects. */
async function readBodyText(response) {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text()
      return text.slice(0, MAX_ERROR_BODY_CHARS)
    }
    if (response.body !== null && typeof response.body?.[Symbol.asyncIterator] === 'function') {
      let out = ''
      for await (const chunk of response.body) {
        out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (out.length >= MAX_ERROR_BODY_BYTES) break
      }
      return out.slice(0, MAX_ERROR_BODY_CHARS)
    }
  } catch {
    /* body unreadable */
  }
  return ''
}

/** Strip control chars and mask the key + sk- tokens from a provider body. */
function sanitizeBody(body, apiKey) {
  if (typeof body !== 'string' || body.length === 0) return ''
  let text = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim()
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    text = text.split(apiKey).join('***')
  }
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
}

/** Current plugin config (proxiedModels / retries) off the settings service. */
function pluginConfig(settings) {
  try {
    const descriptor = settings.describe().find((candidate) => String(candidate.ns) === 'llm-proxy')
    return descriptor?.value ?? {}
  } catch {
    return {}
  }
}

/** Whether the key is selected in 走代理的模型 (whole provider also counts). */
function isProxied(settings, key) {
  const list = Array.isArray(pluginConfig(settings).proxiedModels) ? pluginConfig(settings).proxiedModels : []
  return list.includes(key) || list.includes(key.split('/')[0])
}

/**
 * The active engine's verdict for one URL, falling back to the configured
 * selection. lib/index.js wires `routeFor` from whichever engine runs — the
 * official package's `proxyRouteFor` or the bundled dispatcher's `planFor` —
 * so the card reports where the probe actually went. A caller with no engine
 * (unit tests, a malformed URL) keeps the config-derived answer.
 */
function routeOf(routeFor, url, fallback) {
  if (typeof routeFor === 'function') {
    try {
      const route = routeFor(url)
      if (route !== null && typeof route === 'object' && typeof route.proxied === 'boolean') return route.proxied
    } catch {
      /* fall through to the configured selection */
    }
  }
  return fallback()
}

/** Default probe timeout (ms). */
export const DEFAULT_TEST_TIMEOUT_MS = 20000

/**
 * Probe one model key with a minimal chat-completions request.
 * @param settings - the host settings seam.
 * @param key - `<providerId>/<modelId>`.
 * @param options - `{ fetchImpl, env, timeoutMs, routeFor }` (defaults: global fetch /
 *   process.env / 20s / the configured selection).
 * @returns a structured outcome; `ok` is the probe result, not the RPC envelope.
 */
export async function runConnectionTest(settings, key, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    env = process.env,
    timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
    routeFor,
  } = options
  const started = Date.now()
  const target = findTestTarget(settings, key, env, settings)
  if (target.error !== undefined) {
    return { key, ok: false, code: target.error.code, message: target.error.message }
  }
  if (target.apiKey === undefined) {
    return { key, ok: false, code: 'missing-credential', message: '未找到该模型的 API Key（检查 设置 → 模型 或 apiKeyEnv 环境变量）' }
  }
  const url = chatCompletionsURL(target.baseURL)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + target.apiKey,
      },
      body: JSON.stringify({
        model: target.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        // Some providers (e.g. B.AI) reject max_tokens <= 2 with HTTP 400;
        // 8 is still a tiny ping but above every known minimum.
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - started
    const viaProxy = routeOf(routeFor, url, () => isProxied(settings, key))
    const status = response.status
    if (status >= 200 && status < 300) {
      return { key, ok: true, status, latencyMs, viaProxy, code: 'ok', message: 'HTTP ' + status }
    }
    // Failure: read the provider error body (capped + sanitized) so HTTP
    // 400/401/... show the REAL reason instead of just the status code.
    const body = sanitizeBody(await readBodyText(response), target.apiKey)
    const detail = body.length > 0 ? ' — ' + body : ''
    if (status === 401 || status === 403) {
      return { key, ok: false, status, latencyMs, viaProxy, code: 'auth', message: 'HTTP ' + status + ' 认证失败（检查 API Key）' + detail, body }
    }
    if (status === 404) {
      return { key, ok: false, status, latencyMs, viaProxy, code: 'not-found', message: 'HTTP 404：端点或模型不存在（检查 baseURL / 模型 ID）' + detail, body }
    }
    if (status === 429) {
      return { key, ok: false, status, latencyMs, viaProxy, code: 'rate-limit', message: 'HTTP 429 触发限流' + detail, body }
    }
    if (status >= 500) {
      return { key, ok: false, status, latencyMs, viaProxy, code: 'server', message: 'HTTP ' + status + ' 服务端错误' + detail, body }
    }
    return { key, ok: false, status, latencyMs, viaProxy, code: 'http', message: 'HTTP ' + status + detail, body }
  } catch (error) {
    const latencyMs = Date.now() - started
    const name = error?.name
    const code = error?.code
    if (name === 'AbortError' || name === 'TimeoutError') {
      return {
        key, ok: false, code: 'timeout',
        message: '请求超时（' + Math.round(timeoutMs / 1000) + 's）——直连不通？请先把它勾进「走代理的模型」',
      }
    }
    return {
      key, ok: false, code: 'network',
      message: '网络错误' + (code !== undefined ? '（' + code + '）' : '') + '——代理地址或目标不可达',
    }
  }
}
