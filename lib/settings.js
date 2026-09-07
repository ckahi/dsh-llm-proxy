/**
 * dsh-llm-proxy — host-side settings wiring.
 *
 * Two halves:
 *
 * 1. **Settings namespace** `llm-proxy`: registered through the host settings
 *    seam (`ctx.settings`) with the plugin's own Schemastery `Config` schema.
 *    The composition layer (`base`) carries the cordis.patch.yml config, so
 *    the resolved value is schema defaults → patch config → user layer. The
 *    user-editable layer is what the Web settings page writes; the plugin
 *    watches the resolved value and re-applies the global dispatcher live
 *    (`applies: 'live'`), no restart needed.
 *
 * 2. **Settings bridge**: rc.6 host-apiproxy serves only a hard-coded
 *    namespace allowlist, so every third-party namespace answers
 *    `settings-not-exposed` at the RPC boundary. This module re-serves the
 *    `llm-proxy` namespace over a same-origin, loopback-only HTTP pair
 *    (`/api/dsh-llm-proxy/settings/{describe,mutate}`) riding the host
 *    settings seam — official schema validation, revision fencing,
 *    persistence and event emission for free, with the allowlist gate the
 *    apiproxy would otherwise provide. On hosts whose apiproxy already
 *    exposes the namespace, the client prefers the official scope and the
 *    bridge never activates.
 */
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { catalogBuiltinModels, ensureCatalog } from './catalog.js'
import { runConnectionTest } from './connection-test.js'
import { DEEPSEEK_OFFICIAL_PROVIDER_ID, deepSeekConnection } from './deepseek-official.js'

/**
 * Settings namespace owned by this plugin (kebab-case per brand rules).
 * Written as a plain literal instead of the rc.8 `settingsNamespace()`
 * brand helper so the host half has no `@deepseek-ai/dsh-settings` export
 * dependency beyond `SettingsConflictError` (which DSH ≥ 0.1.2 also exports).
 */
export const LLM_PROXY_NAMESPACE = 'llm-proxy'

/** Bridge route prefix (same-origin, loopback-only). */
export const SETTINGS_BRIDGE_PREFIX = '/api/dsh-llm-proxy/settings'

/**
 * Model keys referenced by `proxiedModels`. One row per configured model:
 * `key` is `<providerId>/<modelId>`, the same spelling `proxiedModels` uses.
 * `name` is the display name of the model itself; `providerLabel` groups
 * models by provider in the UI.
 *
 * A provider whose profile declares no explicit `models` falls back to the
 * pi-ai built-in catalog (the same source the official DSH model selector
 * uses), so e.g. the `xiaomi` profile — configured with only an apiKeyEnv —
 * still lists every MiMo model instead of a single placeholder row.
 */
export function listModels(settings) {
  const rows = []
  try {
    const descriptors = settings.describe({ redactSecrets: true })
    for (const descriptor of descriptors) {
      const ns = String(descriptor.ns)
      const value = descriptor.value
      if (typeof value !== 'object' || value === null) continue
      if (ns === 'llm-pi-ai' && typeof value.providers === 'object' && value.providers !== null) {
        for (const [providerId, profile] of Object.entries(value.providers)) {
          if (typeof profile !== 'object' || profile === null) continue
          const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : ''
          const models = Array.isArray(profile.models) ? profile.models : []
          const modelIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
          const providerLabel = typeof profile.displayName === 'string' && profile.displayName.length > 0
            ? profile.displayName
            : providerId
          if (modelIds.length > 0) {
            for (const model of models) {
              const modelId = model?.id
              if (typeof modelId !== 'string' || modelId.length === 0) continue
              rows.push({
                key: `${providerId}/${modelId}`,
                providerId,
                modelId,
                name: typeof model.name === 'string' && model.name.length > 0 ? model.name : modelId,
                providerLabel,
                host: hostOf(baseURL),
                inputModalities: Array.isArray(model.input) ? model.input.map(String) : [],
              })
            }
          } else {
            // No explicit models: mirror the official selector's fallback to
            // the pi-ai built-in catalog (catalog rows keep the provider's own
            // baseURL when the catalog entry has none).
            const catalog = catalogBuiltinModels(providerId)
            const catalogModels = Array.isArray(catalog) && catalog.length > 0
              ? catalog.map((model) => {
                  const overrides = (typeof profile.modelOverrides === 'object' && profile.modelOverrides !== null)
                    ? profile.modelOverrides[model?.id]
                    : undefined
                  return {
                    key: `${providerId}/${model?.id}`,
                    providerId,
                    modelId: model?.id,
                    name: typeof model?.name === 'string' && model.name.length > 0 ? model.name : model?.id,
                    providerLabel,
                    host: hostOf(typeof model?.baseUrl === 'string' && model.baseUrl.length > 0 ? model.baseUrl : baseURL),
                    inputModalities: Array.isArray(overrides?.input)
                      ? overrides.input.map(String)
                      : (Array.isArray(model?.input) ? model.input.map(String) : []),
                  }
                }).filter((row) => typeof row.modelId === 'string' && row.modelId.length > 0)
              : []
            if (catalogModels.length > 0) {
              rows.push(...catalogModels)
            } else {
              rows.push({
                key: providerId,
                providerId,
                modelId: '',
                name: providerLabel,
                providerLabel,
                host: hostOf(baseURL),
                inputModalities: [],
              })
            }
          }
        }
      } else if (ns === 'llm-deepseek') {
        // The official adapter resolves built-in defaults for the model
        // catalog and apiKeyEnv, but NOT for baseURL (its schema field has no
        // default). Fall back to the official built-in view so an empty
        // `llm-deepseek: {}` still lists the real DeepSeek models with the
        // public endpoint — exactly what the official model selector shows.
        const { models, baseURL } = deepSeekConnection(value)
        const providerLabel = 'DeepSeek'
        const modelRows = []
        for (const model of models) {
          const modelId = model?.id
          if (typeof modelId !== 'string' || modelId.length === 0) continue
          modelRows.push({
            key: `${DEEPSEEK_OFFICIAL_PROVIDER_ID}/${modelId}`,
            providerId: DEEPSEEK_OFFICIAL_PROVIDER_ID,
            modelId,
            name: typeof model.name === 'string' && model.name.length > 0 ? model.name : modelId,
            providerLabel,
            host: hostOf(baseURL),
            inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.map(String) : [],
          })
        }
        if (modelRows.length > 0) {
          rows.push(...modelRows)
        } else {
          rows.push({
            key: DEEPSEEK_OFFICIAL_PROVIDER_ID,
            providerId: DEEPSEEK_OFFICIAL_PROVIDER_ID,
            modelId: '',
            name: providerLabel,
            providerLabel,
            host: hostOf(baseURL),
          })
        }
      }
    }
  } catch (error) {
    /* malformed settings seam: return what we have */
  }
  return rows
}

/** Hostname for a baseURL, or '' when unparseable. */
function hostOf(baseURL) {
  try {
    return new URL(baseURL).hostname
  } catch {
    return ''
  }
}

/** Cap on JSON request bodies (a single mutate is tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority) {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { canonical: url.hostname.toLowerCase() + (rawPort === undefined ? '' : ':' + rawPort), url }
  } catch {
    return undefined
  }
}

/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(request, hostUrl) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Hot-path trust decision: loopback socket + canonical Host + same-origin.
 *
 * 反代部署：socket 仍是回环，但 Host/Origin 被上游改写成公共域名，回环主机名
 * 校验会误伤。`trustedOrigins` 白名单放行「Host 命中受信源」的请求；CSRF 防线
 * （同源校验）保留——攻击者页面发出的 Origin 永远是自身站点，与受信 Host 不一致。
 */
function isTrustedBridgeRequest(request, trustedOrigins = []) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.canonical !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  if (isLoopbackHostname(parsed.url.hostname)) return true
  return Array.isArray(trustedOrigins) && trustedOrigins.some((origin) => {
    if (typeof origin !== 'string') return false
    try {
      return new URL(origin).host === parsed.url.host
    } catch {
      return false
    }
  })
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })),
    }),
    revision: descriptor.revision,
  }
}

/** Map a seam failure onto the official-shaped refusal envelope. */
function failureOf(error) {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'settings-rejected', message }
}

/** Find the bridge view for the plugin namespace (undefined when disposed). */
function viewOf(settings) {
  const descriptor = settings.describe({ redactSecrets: true })
    .find((candidate) => String(candidate.ns) === String(LLM_PROXY_NAMESPACE))
  return descriptor === undefined ? undefined : toView(descriptor)
}

/**
 * Build the bridge handlers over the settings seam. The namespace is fixed
 * (this plugin's own), so there is no allowlist machinery.
 * @param settings - the host settings seam (`ctx.settings`).
 * @returns describe/mutate handlers returning official-shaped envelopes.
 */
export function makeBridgeHandlers(settings, deps = {}) {
  return {
    async describe() {
      const view = viewOf(settings)
      if (view === undefined) {
        return { ok: false, code: 'settings-not-exposed', message: 'settings namespace "llm-proxy" is not registered' }
      }
      return {
        ok: true,
        value: {
          namespaces: [view],
          writable: settings.writable !== false,
        },
      }
    },
    async mutate(body) {
      if (body === null || typeof body !== 'object' || body.ns !== 'llm-proxy' || !Array.isArray(body.ops)) {
        return { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' }
      }
      const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
      try {
        await settings.mutate(LLM_PROXY_NAMESPACE, body.ops, expectedRevision)
      } catch (error) {
        return failureOf(error)
      }
      const view = viewOf(settings)
      if (view === undefined) {
        return { ok: false, code: 'internal', message: 'settings namespace "llm-proxy" was disposed after the mutate' }
      }
      return { ok: true, value: view }
    },
    async test(body) {
      if (body === null || typeof body !== 'object' || typeof body.key !== 'string') {
        return { ok: false, code: 'settings-rejected', message: 'malformed bridge test request' }
      }
      // Probe rides the plugin's own global dispatcher (proxy + retry) and
      // only structured outcome fields come back — secrets never leave the host.
      const outcome = await runConnectionTest(settings, body.key, deps)
      return { ok: true, value: outcome }
    },
  }
}

/**
 * Build the loopback-default bridge routes for the plugin namespace.
 * @param settings - the host settings seam (`ctx.settings`).
 * @returns exact-path route registrations for `ctx.webServer.register`.
 */
export function makeBridgeRoutes(settings, deps = {}) {
  const handlers = makeBridgeHandlers(settings, deps)
  const guard = (req, res) => {
    if (!isTrustedBridgeRequest(req, deps.trustedOrigins)) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') })
      return false
    }
    return true
  }
  return [
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        writeJson(res, 200, await handlers.describe())
      },
    },
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        writeJson(res, 200, await handlers.mutate(body))
      },
    },
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/models`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        // Ensure the pi-ai catalog fallback is loaded so the card's list
        // matches the official model list on a cold start too.
        await ensureCatalog()
        writeJson(res, 200, { ok: true, value: { models: listModels(settings) } })
      },
    },
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/test`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        writeJson(res, 200, await handlers.test(body))
      },
    },
  ]
}
