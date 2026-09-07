/**
 * @superfish058/dsh-llm-proxy v1.0.3 — per-model proxy routing + retry for DSH LLM requests,
 * configurable live from the DSH 设置 page (模型代理).
 *
 * v1.0.3 (retry-policy mirroring + pi-ai catalog fallback, on top of v1.0.0):
 *
 *   - **pi-ai 目录回退**：只配了 `apiKeyEnv` 的 provider（如 `xiaomi`）的模型列表
 *     从 pi-ai 内置目录（`@earendil-works/pi-ai`）补齐，与官方模型选择器同步；
 *     `resolveProxyHosts` / `syncRetryPolicy` / 设置卡片列表共用同一回退（lib/catalog.js）。
 *   - **retryPolicy 镜像**：卡片 `retries` / `retryIntervalMs` 镜像进被勾选
 *     provider 的官方 `retryPolicy`，取消勾选还原默认（lib/index.js）。
 *
 * v1.0.0 (model-level intent, replacing the earlier hostname-routing +
 * token-bucket design):
 *
 *   - **Two-part proxy endpoint** (`proxyHost` + `proxyPort`, default
 *     127.0.0.1:7897) — the proxy does not have to live on this machine.
 *   - **走代理的模型** (`proxiedModels`): the user picks models from the
 *     configured model list (llm-pi-ai + llm-deepseek providers); the
 *     selected models' baseURL hosts go through the proxy, everything else
 *     stays DIRECT (domestic APIs etc.). Loopback hosts are always direct.
 *   - **Retry** (`retries` / `retryIntervalMs`, default 3 / 1000ms): a
 *     transport error, HTTP 429 or any 5xx restarts the request. This keeps
 *     requests alive when a provider rate-limits — the earlier token-bucket
 *     queue is gone.
 *
 * Everything happens at the fetch layer via `setGlobalDispatcher`, below the
 * LLM adapter: `ctx.llm` providers and settings.yaml stay untouched.
 */
import Schema from '@deepseek-ai/schemastery'
import { RoutingDispatcher } from './routing-dispatcher.js'
import { LLM_PROXY_NAMESPACE, makeBridgeRoutes } from './settings.js'
import { catalogBuiltinModels, ensureCatalog } from './catalog.js'
import { DEEPSEEK_OFFICIAL_PROVIDER_ID, deepSeekConnection } from './deepseek-official.js'

export const name = 'dsh-llm-proxy'

/**
 * Deployment configuration; every tunable is validated at load. The
 * pre-1.0.0 fields (proxyUrl, proxies, routes, defaultProxy, rateLimits,
 * maxQueueDepth) are intentionally gone.
 */
export const Config = Schema.object({
  /** Proxy hostname/IP; does not have to be this machine. */
  proxyHost: Schema.string().default('127.0.0.1'),
  /** Proxy port. */
  proxyPort: Schema.number().min(1).max(65535).step(1).default(7897),
  /**
   * Model keys whose baseURL hosts route through the proxy. Each entry is
   * `<providerId>/<modelId>` resolved against the configured model list
   * (llm-pi-ai + llm-deepseek); unknown keys are ignored with a warning.
   */
  proxiedModels: Schema.array(Schema.string()).default([]),
  /**
   * Model keys to advertise as multimodal (`<providerId>/<modelId>`). The
   * selected models' `input` / `inputModalities` fields are mirrored into the
   * owning provider namespace (llm-pi-ai / llm-deepseek), so the model list
   * exposes them as supporting image input and image-bearing requests are no
   * longer refused with UNSUPPORTED_CONTENT.
   */
  multimodalModels: Schema.array(Schema.string()).default([]),
  /** Maximum retry attempts for a failed request (transport error / 429 / 5xx). */
  retries: Schema.number().min(0).max(10).step(1).default(3),
  /** Delay between retry attempts, in milliseconds. */
  retryIntervalMs: Schema.number().min(0).max(60000).step(1).default(1000),
  /**
   * 反代部署信任的公共访问源（完整 origin，如 `https://dsh.example.com`）。
   * 仅当请求从回环 socket 进入、且 Host/Origin 与这里某一项同源时才放行设置
   * 桥接端点；空（默认）时保持仅本机可用。CSRF 同源校验始终生效。
   */
  trustedOrigins: Schema.array(Schema.string()).default([]),
})

/** Hostname for a baseURL, or '' when unparseable. */
function hostOf(baseURL) {
  try {
    return new URL(baseURL).hostname
  } catch {
    return ''
  }
}

/** Compare two arrays of primitives by value (order-sensitive). */
function arraysEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Resolve the proxied-model selection into the set of hostnames the
 * RoutingDispatcher should route through the proxy. Reads the configured
 * model list off the settings seam (`llm-pi-ai` + `llm-deepseek`
 * namespaces); entries that match a selected model key contribute their
 * baseURL host.
 *
 * @param settings - the host settings seam (`ctx.settings`), when available.
 * @param proxiedModels - configured model keys (`<providerId>/<modelId>`).
 * @param logger - cordis logger.
 * @returns the hostnames to proxy.
 */
export function resolveProxyHosts(settings, proxiedModels, logger) {
  const selected = new Set(proxiedModels ?? [])
  if (selected.size === 0) return []
  if (!settings || typeof settings.describe !== 'function') return []

  const hosts = new Set()
  try {
    const descriptors = settings.describe({ redactSecrets: true })
    for (const descriptor of descriptors) {
      const ns = String(descriptor.ns)
      const value = descriptor.value
      if (typeof value !== 'object' || value === null) continue
      if (ns === 'llm-pi-ai' && typeof value.providers === 'object' && value.providers !== null) {
        for (const [providerId, profile] of Object.entries(value.providers)) {
          if (typeof profile !== 'object' || profile === null) continue
          const models = Array.isArray(profile.models) ? profile.models : []
          const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
          // A provider with no explicit models matches through the pi-ai
          // built-in catalog (same source as the official selector), and its
          // baseURL may come from the catalog entry (e.g. xiaomi configures
          // only an apiKeyEnv).
          const catalog = explicitIds.length === 0 ? catalogBuiltinModels(providerId) : null
          const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : []
          const modelIds = explicitIds.length > 0 ? explicitIds : catalogRows.map((m) => m?.id).filter(Boolean)
          const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0
            ? profile.baseURL
            : (catalogRows[0]?.baseUrl ?? '')
          if (typeof baseURL !== 'string' || baseURL.length === 0) continue
          const matched = modelIds.length > 0
            ? modelIds.some((modelId) => selected.has(`${providerId}/${modelId}`))
            : selected.has(providerId)
          if (matched) {
            const host = hostOf(baseURL)
            if (host) hosts.add(host)
          }
        }
      } else if (ns === 'llm-deepseek') {
        // Same built-in fallback as listModels / findTestTarget: an empty
        // `llm-deepseek: {}` still resolves to the official models + public
        // baseURL, so selecting a deepseek-official model proxies it too.
        const { models, baseURL } = deepSeekConnection(value)
        const modelIds = models.map((m) => m?.id).filter(Boolean)
        const matched = modelIds.length > 0
          ? modelIds.some((modelId) => selected.has(`${DEEPSEEK_OFFICIAL_PROVIDER_ID}/${modelId}`))
          : selected.has(DEEPSEEK_OFFICIAL_PROVIDER_ID)
        if (matched) {
          const host = hostOf(baseURL)
          if (host) hosts.add(host)
        }
      }
    }
  } catch (error) {
    logger?.warn('dsh-llm-proxy: failed to resolve proxied-model hosts from settings')
    logger?.warn(error)
  }
  return [...hosts]
}

/** Build a per-install dispatcher and log the effective routing summary. */
function buildDispatcher(ctx, undici, settings, config) {
  const hosts = resolveProxyHosts(settings, config.proxiedModels, ctx.logger)
  const router = new RoutingDispatcher({
    undici,
    proxyHost: config.proxyHost,
    proxyPort: config.proxyPort,
    proxyHosts: hosts,
    logger: ctx.logger,
  })
  // Retry is handled by undici's official RetryAgent wrapping the router:
  // transport errors, HTTP 429 and any 5xx replay the request (LLM calls are
  // POST, so the default method list must be overridden to include it).
  const retry = new undici.RetryAgent(router, {
    throwOnError: false,
    maxRetries: config.retries,
    minTimeout: config.retryIntervalMs,
    timeoutFactor: 1,
    maxTimeout: config.retryIntervalMs * 2,
    // Fixed-interval retries: ignore the server's Retry-After header so the
    // delay stays exactly retryIntervalMs on every attempt (undici would
    // otherwise honour Retry-After and drift away from a constant cadence).
    retryAfter: false,
    methods: ['POST', 'GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE', 'QUERY'],
    // 402 (e.g. B.AI "Insufficient Balance") is treated as transient and
    // replayed on the fixed cadence so the request auto-continues once the
    // gateway/balance issue clears.
    statusCodes: [400, 402, 429, 500, 502, 503, 504],
    errorCodes: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET'],
  })
  ctx.logger.info(
    `dsh-llm-proxy: global dispatcher → RetryAgent(RoutingDispatcher) ` +
      `(proxy=${config.proxyHost}:${config.proxyPort}, ` +
      `proxiedHosts=[${hosts.join(', ') || '(none)'}], ` +
      `retries=${config.retries}×${config.retryIntervalMs}ms)`,
  )
  return retry
}

/**
 * Installer over the global dispatcher: keeps the pre-plugin dispatcher to
 * restore on teardown, swaps on every (re)apply, and closes agents of the
 * dispatcher being replaced.
 */
function makeInstaller(ctx, undici) {
  const { setGlobalDispatcher } = undici
  let previous = null
  let current = null

  const install = (settings, config) => {
    const next = buildDispatcher(ctx, undici, settings, config)
    if (previous === null) previous = setGlobalDispatcher(next)
    else setGlobalDispatcher(next)
    const old = current
    current = next
    if (old !== null) old.destroy().catch(() => {})
  }

  const teardown = () => {
    if (previous !== null) {
      try { setGlobalDispatcher(previous) } catch { /* already gone */ }
      previous = null
    }
    const dying = current
    current = null
    if (dying !== null) dying.destroy().catch(() => {})
  }

  return { install, teardown }
}

export async function apply(ctx, config) {
  // Load the pi-ai built-in catalog before the first dispatcher install:
  // resolveProxyHosts reads it synchronously, so the proxied-host resolution
  // and the settings-bridge model list must see it from the first call on.
  // Never rejects (unavailable catalog → placeholder behaviour).
  await ensureCatalog()
  let undici
  try {
    undici = await import('undici')
  } catch (error) {
    ctx.logger.error('dsh-llm-proxy: failed to load undici — proxy routing disabled')
    ctx.logger.error(error)
    return
  }
  if (typeof undici.setGlobalDispatcher !== 'function') {
    ctx.logger.error('dsh-llm-proxy: undici does not expose setGlobalDispatcher — proxy routing disabled')
    return
  }

  const { install, teardown } = makeInstaller(ctx, undici)

  if (typeof ctx.inject === 'function') {
    // Settings-backed path: register the namespace, install the resolved
    // value, re-apply live on every committed change, and mount the bridge
    // routes so the Web settings page can read/write the namespace and fetch
    // the model list.
    ctx.inject(['settings'], (sctx) => {
      const seam = sctx.settings
      if (!seam || typeof seam.register !== 'function') {
        ctx.logger.warn('dsh-llm-proxy: settings seam unavailable — applying patch config directly')
        install(seam, config)
        return
      }
      try {
        const scope = seam.register(LLM_PROXY_NAMESPACE, Config, { base: config, applies: 'live' })
        const applyCurrent = () => {
          install(seam, scope.get())
          syncRetryPolicy()
          syncMultimodal()
        }

        // Cold-start ordering: the llm-pi-ai / llm-deepseek namespaces are
        // registered by the official provider plugins, which inject the `llm`
        // service and therefore apply AFTER this plugin's settings callback on
        // a fresh start. The first install above would then resolve zero
        // proxied hosts, silently leaving every request on the direct path
        // until the user happened to save the settings page again. Two
        // compensations close that gap:
        //   1. Retry with backoff until both provider namespaces are
        //      registered, then install against the resolved model list.
        //   2. Re-install when either provider document changes at runtime
        //      (baseURL edits etc.), which `scope.watch` alone cannot see.
        const PROVIDER_NS = new Set(['llm-pi-ai', 'llm-deepseek'])
        const providerNames = () => {
          try {
            return new Set(seam.describe({ redactSecrets: true }).map((d) => String(d.ns)))
          } catch {
            return new Set()
          }
        }
        const providerReady = () => [...PROVIDER_NS].every((ns) => providerNames().has(ns))

        // --- multimodal mirroring (v1.0.9) --------------------------------
        // The card's independent 多模态模型 section lists models to advertise
        // as accepting image input. DSH refuses image-bearing requests unless
        // the owning provider namespace declares the modality (llm-pi-ai:
        // `models[].input`, llm-deepseek: `models[].inputModalities`). Mirror
        // the selection into those fields so the model list exposes the
        // capability and image requests pass; deselected models are restored
        // to the official defaults.
        //
        // Path spelling: dsh-settings `applyPathOp` treats every non-plain-
        // object child as a plain object, so array-index paths (`models[0]`)
        // would silently corrupt the array. Model arrays are therefore
        // replaced wholesale (read → patch the entry → set the whole array);
        // catalog providers patch the plain-object `modelOverrides` path
        // instead.
        //
        // Read seam: the mirror reads the USER layer (`d.user`), never the
        // resolved value (`d.value`). The resolved value carries schema
        // defaults the pi-ai validator injects per model (`input: []`,
        // `compat`); writing it back would materialize those defaults into
        // the user document and touch models the user never configured.
        const lastMultimodal = new Map() // `${ns}|${providerId}|${modelId}` -> true
        const IMAGE_MODALITIES = ['text', 'image']
        const syncMultimodal = async () => {
          try {
            const cfg = scope.get()
            const selected = new Set(cfg.multimodalModels ?? [])
            const targets = []
            for (const d of seam.describe({ redactSecrets: true })) {
              const ns = String(d.ns)
              if (!PROVIDER_NS.has(ns)) continue
              const user = d.user
              if (typeof user !== 'object' || user === null) continue
              if (ns === 'llm-pi-ai') {
                const providers = (typeof user.providers === 'object' && user.providers !== null) ? user.providers : {}
                for (const [providerId, profile] of Object.entries(providers)) {
                  if (typeof profile !== 'object' || profile === null) continue
                  const models = Array.isArray(profile.models) ? profile.models : []
                  const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
                  if (explicitIds.length > 0) {
                    // Explicit model list (user-written): patch the target
                    // entries and replace the whole `models` array. Entries
                    // are taken from the user layer as-is, so schema defaults
                    // are never materialized into the user document.
                    let changed = false
                    let restoring = false
                    const mirroredTracks = []
                    const patched = models.map((model) => {
                      const modelId = model?.id
                      if (typeof modelId !== 'string' || modelId.length === 0) return model
                      const key = `${providerId}/${modelId}`
                      const trackKey = `llm-pi-ai|${providerId}|${modelId}`
                      const current = Array.isArray(model.input) ? model.input : []
                      const hasImage = current.includes('image')
                      if (selected.has(key)) {
                        if (!hasImage) {
                          changed = true
                          mirroredTracks.push(trackKey)
                          return { ...model, input: IMAGE_MODALITIES }
                        }
                        lastMultimodal.set(trackKey, true)
                      } else if (lastMultimodal.get(trackKey) === true) {
                        changed = true
                        restoring = true
                        lastMultimodal.delete(trackKey)
                        const { input: _dropped, ...rest } = model
                        return rest
                      }
                      return model
                    })
                    if (changed) {
                      targets.push({
                        ns,
                        label: `llm-pi-ai.providers.${providerId}.models`,
                        trackKey: `llm-pi-ai|${providerId}`,
                        tracks: mirroredTracks,
                        on: !restoring,
                        ops: [{ op: 'set', path: ['providers', providerId, 'models'], value: patched }],
                      })
                    }
                  } else {
                    // Catalog-backed provider: patch the plain-object
                    // modelOverrides path per selected model. The catalog
                    // itself is never written — a selected catalog model gains
                    // a user-layer `modelOverrides.<id>.input` entry, and a
                    // deselected one loses the entry we wrote.
                    const overrides = (typeof profile.modelOverrides === 'object' && profile.modelOverrides !== null)
                      ? profile.modelOverrides
                      : {}
                    const catalog = catalogBuiltinModels(providerId)
                    const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : []
                    const candidateIds = new Set([
                      ...catalogRows.map((m) => m?.id).filter(Boolean),
                      ...Object.keys(overrides),
                    ])
                    for (const modelId of candidateIds) {
                      if (typeof modelId !== 'string' || modelId.length === 0) continue
                      const key = `${providerId}/${modelId}`
                      const trackKey = `llm-pi-ai|${providerId}|${modelId}`
                      const label = `llm-pi-ai.providers.${providerId}.modelOverrides.${modelId}`
                      const path = ['providers', providerId, 'modelOverrides', modelId, 'input']
                      const current = Array.isArray(overrides[modelId]?.input) ? overrides[modelId].input : []
                      const hasImage = current.includes('image')
                      if (selected.has(key)) {
                        if (!hasImage) {
                          targets.push({ ns, label, trackKey, on: true, ops: [{ op: 'set', path, value: IMAGE_MODALITIES }] })
                        } else {
                          lastMultimodal.set(trackKey, true)
                        }
                      } else if (lastMultimodal.get(trackKey) === true) {
                        targets.push({ ns, label, trackKey, on: false, ops: [{ op: 'unset', path }] })
                      }
                    }
                  }
                }
              } else {
                const models = Array.isArray(user.models) ? user.models : []
                let changed = false
                let restoring = false
                const mirroredTracks = []
                const patched = models.map((model) => {
                  const modelId = model?.id
                  if (typeof modelId !== 'string' || modelId.length === 0) return model
                  const key = `deepseek-official/${modelId}`
                  const trackKey = `llm-deepseek|deepseek-official|${modelId}`
                  const current = Array.isArray(model.inputModalities) ? model.inputModalities : []
                  const hasImage = current.includes('image')
                  if (selected.has(key)) {
                    if (!hasImage) {
                      changed = true
                      mirroredTracks.push(trackKey)
                      return { ...model, inputModalities: IMAGE_MODALITIES }
                    }
                    lastMultimodal.set(trackKey, true)
                  } else if (lastMultimodal.get(trackKey) === true) {
                    changed = true
                    restoring = true
                    lastMultimodal.delete(trackKey)
                    const { inputModalities: _dropped, ...rest } = model
                    return rest
                  }
                  return model
                })
                if (changed) {
                  targets.push({
                    ns,
                    label: 'llm-deepseek.models',
                    trackKey: 'llm-deepseek',
                    tracks: mirroredTracks,
                    on: !restoring,
                    ops: [{ op: 'set', path: ['models'], value: patched }],
                  })
                }
              }
            }
            for (const t of targets) {
              await seam.mutate(t.ns, t.ops)
              if (t.trackKey) lastMultimodal.set(t.trackKey, true)
              for (const trackKey of t.tracks ?? []) lastMultimodal.set(trackKey, true)
              ctx.logger.info(
                `dsh-llm-proxy: mirrored multimodal ${t.on ? '[text, image]' : '(official defaults)'} → ${t.label}`,
              )
            }
          } catch (error) {
            ctx.logger.warn('dsh-llm-proxy: multimodal mirror failed: %o', error)
          }
        }

        // --- retry-policy mirroring (v1.0.3) -------------------------------
        // The card's `retries` / `retryIntervalMs` drive the transport-layer
        // RetryAgent only; the official dsh-llm-retry plugin renders the visible
        // "(retry/maximum)" UI from each provider's own `retryPolicy` config.
        // Mirror the card values into the retryPolicy of every provider whose
        // model is selected in `proxiedModels`, so ONE configuration drives both
        // layers, and deselected models keep the official defaults untouched.
        //
        // The mirrored backoff is deliberately FIXED-interval (maxDelayMs ==
        // initialDelayMs, jitterRatio 0): dsh-llm-retry's localDelay is
        // exponential by default (initialDelayMs * 2^(retry-1)), which would
        // otherwise turn the card's interval into a growing 1s→2s→4s→8s stack.
        const lastWritten = new Map() // `${ns}|${providerId}` -> mirrored retries
        const syncRetryPolicy = async () => {
          try {
            const cfg = scope.get()
            const { retries, retryIntervalMs } = cfg
            const selected = new Set(cfg.proxiedModels ?? [])
            const backoffInitial = Math.max(1, retryIntervalMs)
            // Mirror the full retryable-code set, including QUOTA (402
            // "Insufficient Balance") and INVALID_REQUEST (400 invalid_request)
            // so those provider responses are also auto-retried on the fixed
            // cadence, not just at the transport layer. Must keep the official
            // defaults or the provider stops retrying RATE_LIMIT/SERVER/etc.
            const retryableCodes = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'INVALID_REQUEST']
            const targets = []
            for (const d of seam.describe({ redactSecrets: true })) {
              const ns = String(d.ns)
              if (!PROVIDER_NS.has(ns)) continue
              const value = d.value
              if (typeof value !== 'object' || value === null) continue
              if (ns === 'llm-pi-ai') {
                const providers = (typeof value.providers === 'object' && value.providers !== null) ? value.providers : {}
                for (const [providerId, profile] of Object.entries(providers)) {
                  if (typeof profile !== 'object' || profile === null) continue
                  const models = Array.isArray(profile.models) ? profile.models : []
                  const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
                  const catalog = explicitIds.length === 0 ? catalogBuiltinModels(providerId) : null
                  const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : []
                  const modelIds = explicitIds.length > 0 ? explicitIds : catalogRows.map((m) => m?.id).filter(Boolean)
                  const matched = modelIds.length > 0
                    ? modelIds.some((id) => selected.has(`${providerId}/${id}`))
                    : selected.has(providerId)
                  const rp = (typeof profile.retryPolicy === 'object' && profile.retryPolicy !== null) ? profile.retryPolicy : {}
                  const key = `llm-pi-ai|${providerId}`
                  const label = `llm-pi-ai.providers.${providerId}`
                  if (matched) {
                    if (rp.maxRetries !== retries || rp.backoff?.maxDelayMs !== backoffInitial || !arraysEqual(rp.retryableCodes, retryableCodes)) {
                      targets.push({ ns, label, key, retries, ops: [{ op: 'set', path: ['providers', providerId, 'retryPolicy'], value: { mode: 'normal', maxRetries: retries, retryableCodes, backoff: { initialDelayMs: backoffInitial, maxDelayMs: backoffInitial, jitterRatio: 0 } } }] })
                    } else if (rp.maxRetries === retries) {
                      // Already mirrored (e.g. by a previous run): remember so
                      // deselecting the model can restore the official defaults.
                      lastWritten.set(key, retries)
                    }
                  } else if (lastWritten.get(key) !== undefined && rp.maxRetries === lastWritten.get(key)) {
                    targets.push({ ns, label, key, retries: undefined, ops: [{ op: 'unset', path: ['providers', providerId, 'retryPolicy'] }] })
                  }
                }
              } else {
                const modelIds = Array.isArray(value.models) ? value.models.map((m) => m?.id).filter(Boolean) : []
                const matched = modelIds.length > 0
                  ? modelIds.some((id) => selected.has(`deepseek-official/${id}`))
                  : selected.has('deepseek-official')
                const rp = (typeof value.retryPolicy === 'object' && value.retryPolicy !== null) ? value.retryPolicy : {}
                const key = 'llm-deepseek|deepseek-official'
                if (matched) {
                  if (rp.maxRetries !== retries || rp.backoff?.maxDelayMs !== backoffInitial || !arraysEqual(rp.retryableCodes, retryableCodes)) {
                    targets.push({ ns, label: 'llm-deepseek', key, retries, ops: [{ op: 'set', path: ['retryPolicy'], value: { mode: 'normal', maxRetries: retries, retryableCodes, backoff: { initialDelayMs: backoffInitial, maxDelayMs: backoffInitial, jitterRatio: 0 } } }] })
                  } else if (rp.maxRetries === retries) {
                    lastWritten.set(key, retries)
                  }
                } else if (lastWritten.get(key) !== undefined && rp.maxRetries === lastWritten.get(key)) {
                  targets.push({ ns, label: 'llm-deepseek', key, retries: undefined, ops: [{ op: 'unset', path: ['retryPolicy'] }] })
                }
              }
            }
            for (const t of targets) {
              await seam.mutate(t.ns, t.ops)
              if (t.retries !== undefined) lastWritten.set(t.key, t.retries)
              else lastWritten.delete(t.key)
              ctx.logger.info(
                `dsh-llm-proxy: mirrored retryPolicy ${t.retries !== undefined ? `maxRetries=${t.retries} fixedDelayMs=${backoffInitial}` : '(official defaults)'} → ${t.label}`,
              )
            }
          } catch (error) {
            ctx.logger.warn('dsh-llm-proxy: retryPolicy mirror failed: %o', error)
          }
        }
        const timers = []
        const scheduleRetry = (attempt) => {
          if (attempt > 8) return
          const timer = setTimeout(() => {
            if (providerReady()) {
              applyCurrent()
              return
            }
            scheduleRetry(attempt + 1)
          }, 100 * 2 ** attempt)
          timers.push(timer)
        }
        applyCurrent()
        if (!providerReady()) scheduleRetry(0)
        const disposeWatch = scope.watch((next) => {
          install(seam, next)
          syncRetryPolicy()
          syncMultimodal()
        })
        const disposeDoc = ctx.on('settings/document-updated', (ns) => {
          if (ns !== undefined && PROVIDER_NS.has(String(ns))) {
            applyCurrent()
            syncRetryPolicy()
            syncMultimodal()
          }
        })
        // Bridge routes need the webServer service, which may activate after
        // the settings seam; wait for both before mounting them.
        ctx.inject(['settings', 'webServer'], (bridgeCtx) => {
          const disposers = []
          for (const route of makeBridgeRoutes(bridgeCtx.settings, { trustedOrigins: config.trustedOrigins })) {
            disposers.push(bridgeCtx.webServer.register(route))
          }
          ctx.logger.info(
            'dsh-llm-proxy: settings bridge mounted at /api/dsh-llm-proxy/settings ' +
            `(${disposers.length} routes)`,
          )
          bridgeCtx.effect(() => () => {
            for (const dispose of disposers) dispose()
          })
        })
        ctx.logger.info('dsh-llm-proxy: settings namespace "llm-proxy" registered — live apply via 设置 → 模型代理')
        sctx.effect(() => () => {
          disposeWatch()
          disposeDoc()
          for (const timer of timers) clearTimeout(timer)
        })
      } catch (error) {
        ctx.logger.error('dsh-llm-proxy: settings namespace registration failed — applying patch config directly')
        ctx.logger.error(error)
        install(seam, config)
      }
    })
  } else {
    // No cordis inject (fake contexts, plain config).
    install(undefined, config)
  }

  // Restore the previous dispatcher on teardown and close our agents.
  ctx.on('dispose', teardown)
}

export { LLM_PROXY_NAMESPACE, makeBridgeHandlers, makeBridgeRoutes, SETTINGS_BRIDGE_PREFIX } from './settings.js'
