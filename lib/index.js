/**
 * @superfish058/dsh-llm-proxy — per-model proxy routing for DSH LLM requests,
 * configurable live from the DSH 设置 page (模型代理).
 *
 * v1.4.0 — 官方优先（ride the official transport instead of replacing it）：
 *
 *   - **官方引擎**：检测到官方出站代理包时不再自建 dispatcher，而是用它的公开接缝
 *     `installProxyFromEnvironment(envLookup, report)` 喂一份算好的策略（代理 URL 取自
 *     本卡，no_proxy = 其余所有已配置 provider 主机）。官方自己的匹配器、子进程环境
 *     发布、web-fetch 例外语义全部保留，插件只负责「勾了哪个模型」这一个官方明确
 *     不做的决定。
 *   - **旧版回退**：没有该包（如 dsh ≤ 0.1.2）时仍用自带的 RoutingDispatcher，
 *     行为与 1.3.0 一致。
 *   - **传输层重试已删除**：官方 dsh-llm-retry 按每个 provider 的 retryPolicy 重放失败
 *     请求，卡片的 retries／retryIntervalMs 只镜像进该配置（syncRetryPolicy）。此前的
 *     RetryAgent 与官方策略叠加（最坏情况重试次数²），还刻意忽略 Retry-After、把
 *     400/402 当可重试，与官方语义冲突。
 *   - **测试连接报告真实路由**：探测结果里的 经代理／直连 现在来自当前引擎
 *     （官方 proxyRouteFor 或自带 planFor），不再是配置意图。
 *
 * v1.5.0 — 适配 dsh 0.1.7 的设置体系（本次改动）：
 *
 *   - **设置文档按 entry id 寻址**：0.1.7 删除了 `settings.register()`／namespace
 *     接缝，改为用插件的 Loader entry id（本插件为 `llm-proxy`）指向其 Config
 *     schema 派生的设置文档。Config 的每个字段都标了 `.volatile()`：既让
 *     `settings.describe()` 收下这条 entry（否则插件页不显示卡片），也让
 *     `settings.mutate` 放行写入。
 *   - **实时值来自 live accessor**：volatile 字段以访问器形式交给 apply()
 *     （`config.proxyHost.get()`），写入由 cordis-plugin-loader 的 `_commitVolatile`
 *     就地更新并只在**本 fiber** 上 emit `loader/volatile-update`——插件据此重装
 *     代理策略，不再需要注册作用域或 watch。
 *   - **多模态镜像已删除**：0.1.7 起模型图片输入由官方 `ui-settings-models` 页面
 *     维护（`inputModalities`），本插件不再充当镜像；`multimodalModels` 字段移除。
 *
 * Earlier releases: v1.4.0 official transport reuse; v1.0.3 retryPolicy mirroring
 * + pi-ai catalog fallback; v1.0.0 two-part proxy endpoint, model-level
 * selection, everything else direct. ctx.llm providers stay untouched.
 */
import Schema from '@deepseek-ai/schemastery'
import { RoutingDispatcher, normalizeProxyEndpoint } from './routing-dispatcher.js'
import { loadOfficialProxy, policyEnvLookup, splitProxyList } from './official-proxy.js'
import { LLM_PROXY_NAMESPACE, makeBridgeRoutes } from './settings.js'
import { catalogBuiltinModels, ensureCatalog } from './catalog.js'
import { DEEPSEEK_OFFICIAL_PROVIDER_ID, deepSeekConnection } from './deepseek-official.js'

export const name = 'dsh-llm-proxy'

/**
 * Deployment configuration; every tunable is validated at load.
 *
 * dsh 0.1.7 derives a plugin's settings document from this schema, addressed
 * by the plugin's Loader entry id (`llm-proxy`); an entry is only offered a
 * settings form while the schema declares at least one `volatile()` field, and
 * `ctx.settings.mutate` refuses any path outside a volatile node. Volatile
 * fields therefore carry the whole card: the loader hands them to `apply()` as
 * live accessors and commits a settings write into them in place, without
 * re-applying the plugin. Every field below goes through `live()`, which is
 * `.volatile()` with a graceful fallback for an older schema library.
 *
 * The pre-1.0.0 fields (proxyUrl, proxies, routes, defaultProxy, rateLimits,
 * maxQueueDepth) are intentionally gone; v1.5.0 dropped `multimodalModels`
 * because dsh now owns each model's input modalities itself.
 */
/**
 * Mark one Config field as live-editable (`Schema#volatile`, schemastery
 * ≥ 3.18.4) — the only shape the 0.1.7 settings service exposes for writes.
 * An older schema library has no such method: the field keeps working as a
 * static option, but the Host then owns no writable path and the 设置 → 插件
 * page stays hidden, so warn once instead of failing the whole plugin load.
 */
let warnedNoVolatile = false
function live(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile()
  if (!warnedNoVolatile) {
    warnedNoVolatile = true
    console.warn('dsh-llm-proxy: @deepseek-ai/schemastery < 3.18.4 has no Schema#volatile — Config fields stay static, so 设置 → 插件 → 模型代理 will not appear (edit cordis.patch.yml instead).')
  }
  return schema
}

export const Config = Schema.object({
  /** Proxy hostname/IP; does not have to be this machine. */
  proxyHost: live(Schema.string().default('127.0.0.1')),
  /** Proxy port. */
  proxyPort: live(Schema.number().min(1).max(65535).step(1).default(7897)),
  /**
   * Model keys whose baseURL hosts route through the proxy. Each entry is
   * `<providerId>/<modelId>` resolved against the configured model list
   * (llm-pi-ai + llm-deepseek); unknown keys are ignored with a warning.
   */
  proxiedModels: live(Schema.array(Schema.string()).default([])),
  /** Maximum retry attempts for a failed request (transport error / 429 / 5xx). */
  retries: live(Schema.number().min(0).max(10).step(1).default(3)),
  /** Delay between retry attempts, in milliseconds. */
  retryIntervalMs: live(Schema.number().min(0).max(60000).step(1).default(1000)),
  /**
   * 反代部署信任的公共访问源（完整 origin，如 `https://dsh.example.com`）。
   * 仅当请求从回环 socket 进入、且 Host/Origin 与这里某一项同源时才放行设置
   * 桥接端点；空（默认）时保持仅本机可用。CSRF 同源校验始终生效。
   */
  trustedOrigins: live(Schema.array(Schema.string()).default([])),
})

/**
 * One Config field's current value, unwrapping the live accessor dsh 0.1.7
 * hands over for a `volatile()` field. Falls back to the plain value so a
 * fake/plain config object (tests, older hosts) keeps working.
 */
function fieldValue(config, key, fallback) {
  const node = config?.[key]
  if (node !== undefined && node !== null && typeof node.get === 'function') {
    const value = node.get()
    return value === undefined ? fallback : value
  }
  return node === undefined || node === null ? fallback : node
}

/**
 * Plain resolved proxy configuration from the config object `apply()` was
 * given; the single reader every install path shares.
 * @param config - the resolved plugin config (volatile accessors or plain).
 * @returns detached plain values.
 */
export function plainProxyConfig(config) {
  return {
    proxyHost: fieldValue(config, 'proxyHost', '127.0.0.1'),
    proxyPort: fieldValue(config, 'proxyPort', 7897),
    proxiedModels: fieldValue(config, 'proxiedModels', []) ?? [],
    retries: fieldValue(config, 'retries', 3),
    retryIntervalMs: fieldValue(config, 'retryIntervalMs', 1000),
    trustedOrigins: fieldValue(config, 'trustedOrigins', []) ?? [],
  }
}

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
 * Walk every configured provider host, one row per provider baseURL.
 *
 * `modelKeys` are the `<providerId>/<modelId>` spellings `proxiedModels` uses;
 * a provider that declares no explicit models falls back to the pi-ai built-in
 * catalog (the same source the official selector uses), so e.g. `xiaomi` —
 * configured with only an `apiKeyEnv` — still contributes its real models.
 * `providerKey` is the bare provider id, which on its own also matches.
 *
 * @param settings - the host settings seam (`ctx.settings`), when available.
 * @param logger - cordis logger.
 * @returns rows `{ host, providerKey, modelKeys }`; hosts are deduplicated by callers.
 */
function scanProviderHosts(settings, logger) {
  const rows = []
  try {
    for (const descriptor of settings.describe({ redactSecrets: true })) {
      const ns = String(descriptor.ns)
      const value = descriptor.value
      if (typeof value !== 'object' || value === null) continue
      if (ns === 'llm-pi-ai' && typeof value.providers === 'object' && value.providers !== null) {
        for (const [providerId, profile] of Object.entries(value.providers)) {
          if (typeof profile !== 'object' || profile === null) continue
          const models = Array.isArray(profile.models) ? profile.models : []
          const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : []
          // A provider with no explicit models matches through the pi-ai
          // built-in catalog, and its baseURL may come from the catalog entry.
          const catalog = explicitIds.length === 0 ? catalogBuiltinModels(providerId) : null
          const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : []
          const modelIds = explicitIds.length > 0 ? explicitIds : catalogRows.map((m) => m?.id).filter(Boolean)
          const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0
            ? profile.baseURL
            : (catalogRows[0]?.baseUrl ?? '')
          const host = hostOf(baseURL)
          if (host.length === 0) continue
          rows.push({ host, providerKey: providerId, modelKeys: modelIds.map((id) => providerId + '/' + id) })
        }
      } else if (ns === 'llm-deepseek') {
        // Same built-in fallback as listModels / findTestTarget: an empty
        // `llm-deepseek: {}` still resolves to the official models + public baseURL.
        const { models, baseURL } = deepSeekConnection(value)
        const host = hostOf(baseURL)
        if (host.length === 0) continue
        rows.push({
          host,
          providerKey: DEEPSEEK_OFFICIAL_PROVIDER_ID,
          modelKeys: models.map((m) => m?.id).filter(Boolean).map((id) => DEEPSEEK_OFFICIAL_PROVIDER_ID + '/' + id),
        })
      }
    }
  } catch (error) {
    logger?.warn('dsh-llm-proxy: failed to resolve provider hosts from settings')
    logger?.warn(error)
  }
  return rows
}

/** Whether one scanned row is selected in 走代理的模型 (a bare provider id counts). */
function isSelected(row, selected) {
  return row.modelKeys.length > 0
    ? row.modelKeys.some((key) => selected.has(key))
    : selected.has(row.providerKey)
}

/**
 * Resolve the proxied-model selection into the hostnames the engine should
 * route through the proxy.
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
  const hosts = []
  for (const row of scanProviderHosts(settings, logger)) {
    if (isSelected(row, selected) && !hosts.includes(row.host)) hosts.push(row.host)
  }
  return hosts
}

/**
 * Split the selection into the two host lists the official policy needs: the
 * hosts that go through the proxy, and every OTHER configured provider host,
 * which becomes the bypass list (`no_proxy`) so 国内 API stays direct.
 *
 * This is the one part of the routing decision the official package does not
 * make — it resolves a single process-wide policy — so the plugin tells it
 * which hosts that policy must leave alone for the ticked models to be the
 * only proxied ones.
 *
 * @returns `{ proxied, direct }` hostname arrays.
 */
export function resolveProxySelection(settings, proxiedModels, logger) {
  const selected = new Set(proxiedModels ?? [])
  const proxied = []
  const direct = []
  if (selected.size === 0) return { proxied, direct }
  if (!settings || typeof settings.describe !== 'function') return { proxied, direct }
  for (const row of scanProviderHosts(settings, logger)) {
    const bucket = isSelected(row, selected) ? proxied : direct
    if (!bucket.includes(row.host)) bucket.push(row.host)
  }
  return { proxied, direct }
}

/** Build the official engine and log the detection once; null when unusable. */
function officialEngineOrNull(ctx, official) {
  try {
    const engine = makeOfficialEngine(ctx, official.module)
    ctx.logger.info(
      'dsh-llm-proxy: engine=official — official outbound-proxy package detected (' + official.from + '); ' +
        'the transport layer stays official, this plugin only computes the per-model policy',
    )
    return engine
  } catch (error) {
    ctx.logger.warn('dsh-llm-proxy: the official outbound-proxy package is unusable — falling back to the bundled dispatcher: %o', error)
    return null
  }
}

/**
 * Bundled engine — used only on harnesses without the official outbound-proxy
 * package (dsh ≤ 0.1.2). Owns the process-global undici dispatcher and routes
 * by hostname: selected model hosts go through the proxy, everything else
 * stays direct, loopback always direct.
 */
function makeBundledEngine(ctx, undici) {
  let previous = null
  let current = null

  const install = (settings, config) => {
    const hosts = resolveProxyHosts(settings, config.proxiedModels, ctx.logger)
    const router = new RoutingDispatcher({
      undici,
      proxyHost: config.proxyHost,
      proxyPort: config.proxyPort,
      proxyHosts: hosts,
      logger: ctx.logger,
    })
    if (previous === null) previous = undici.setGlobalDispatcher(router)
    else undici.setGlobalDispatcher(router)
    const old = current
    current = router
    if (old !== null) old.destroy().catch(() => {})
    ctx.logger.info(
      'dsh-llm-proxy: global dispatcher → RoutingDispatcher ' +
        '(engine=bundled, proxy=' + config.proxyHost + ':' + config.proxyPort + ', ' +
        'proxiedHosts=[' + (hosts.join(', ') || '(none)') + '])',
    )
  }

  const teardown = () => {
    if (previous !== null) {
      try { undici.setGlobalDispatcher(previous) } catch { /* already gone */ }
      previous = null
    }
    const dying = current
    current = null
    if (dying !== null) dying.destroy().catch(() => {})
  }

  /** Real route for one URL — the card's 测试连接 verdict, not the config intent. */
  const routeFor = (url) => {
    try {
      return current === null ? { proxied: false, host: '' } : current.planFor(url)
    } catch {
      return { proxied: false, host: '' }
    }
  }

  return { kind: 'bundled', install, teardown, routeFor }
}

/**
 * Official engine — used whenever the official outbound-proxy package is
 * installed.
 *
 * This mode does NOT touch `setGlobalDispatcher`: it hands the official package
 * a computed environment lookup through `installProxyFromEnvironment`, the same
 * seam the launcher itself uses. That install layers over the launcher's policy
 * and returns a disposer restoring it, so the plugin owns a narrower policy for
 * as long as its selection says so, then gives the process back exactly what it
 * found.
 *
 * `no_proxy` carries every configured provider host except the ticked ones —
 * that is how 只勾选的模型走代理 is expressed in a policy whose default is
 * "proxy everything else". Hosts that are not configured providers (web fetch,
 * MCP over HTTP) follow the proxy: the official semantic, and the useful one
 * behind Clash.
 */
function makeOfficialEngine(ctx, official) {
  let dispose = null
  let queue = Promise.resolve()

  const applyPolicy = async (settings, config) => {
    const { proxied, direct } = resolveProxySelection(settings, config.proxiedModels, ctx.logger)
    // Release our previous overlay first: installs layer, and a stack of them
    // would each hold an agent and a copy of the published environment.
    const prior = dispose
    dispose = null
    if (prior !== null) {
      try { await prior() } catch (error) { ctx.logger.warn('dsh-llm-proxy: releasing the previous official policy failed: %o', error) }
    }
    if (proxied.length === 0) {
      ctx.logger.info('dsh-llm-proxy: engine=official — 走代理的模型为空，官方策略保持不变')
      return
    }
    const endpoint = normalizeProxyEndpoint(config.proxyHost, config.proxyPort)
    const scheme = endpoint.uri.slice(0, endpoint.uri.indexOf('://'))
    if (scheme !== 'http' && scheme !== 'https') {
      // The official resolver rejects anything else and resolves to a DIRECT
      // policy, which would replace the launcher's dispatcher; keep it instead.
      ctx.logger.warn('dsh-llm-proxy: "' + scheme + '://" is not a proxy URL the official package routes (http/https only) — 官方策略保持不变')
      return
    }
    const inherited = splitProxyList(process.env.no_proxy ?? process.env.NO_PROXY)
    const lookup = policyEnvLookup({ proxyUrl: endpoint.uri, bypass: [...inherited, ...direct] })
    dispose = await official.installProxyFromEnvironment(lookup, (message) => {
      ctx.logger.warn('dsh-llm-proxy: ' + message)
    })
    ctx.logger.info(
      'dsh-llm-proxy: official policy installed (engine=official, proxy=' + endpoint.host + ':' + endpoint.port + ', ' +
        'proxiedHosts=[' + proxied.join(', ') + '], directHosts=[' + (direct.join(', ') || '(none)') + '])',
    )
  }

  const install = (settings, config) => {
    queue = queue
      .then(() => applyPolicy(settings, config))
      .catch((error) => { ctx.logger.warn('dsh-llm-proxy: official proxy policy install failed: %o', error) })
    return queue
  }

  const teardown = async () => {
    const prior = dispose
    dispose = null
    if (prior !== null) {
      try { await prior() } catch { /* the launcher's policy is already back */ }
    }
  }

  /** Real route for one URL, straight from the official matcher. */
  const routeFor = (url) => {
    try {
      const parsed = new URL(url)
      const route = official.proxyRouteFor(parsed)
      return route?.proxied === true
        ? { proxied: true, proxy: route.proxy, host: parsed.hostname }
        : { proxied: false, host: parsed.hostname }
    } catch {
      return { proxied: false, host: '' }
    }
  }

  return { kind: 'official', install, teardown, routeFor }
}

export async function apply(ctx, config) {
  // Load the pi-ai built-in catalog before the first engine install:
  // resolveProxyHosts reads it synchronously, so the proxied-host resolution
  // and the settings-bridge model list must see it from the first call on.
  // Never rejects (unavailable catalog → placeholder behaviour).
  await ensureCatalog()

  // Engine selection (v1.4.0). The official outbound-proxy package owns the
  // transport policy process-wide; when it is present this plugin feeds it a
  // computed policy instead of installing a dispatcher of its own, so the
  // official matcher, its subprocess-environment publication and the web-fetch
  // exemption all keep working. Older harnesses keep the bundled dispatcher,
  // which is what shipped through v1.3.0.
  const official = await loadOfficialProxy()
  let active = official === null ? null : officialEngineOrNull(ctx, official)
  if (active === null) {
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
    active = makeBundledEngine(ctx, undici)
    ctx.logger.info('dsh-llm-proxy: engine=bundled — official outbound-proxy package not found, using the built-in dispatcher')
  }

  // One entry point for both engines: a rejected install must never take the
  // settings callback (or the plugin load) down with it.
  const install = (settings, cfg) => {
    try {
      const result = active.install(settings, cfg)
      if (result !== null && typeof result?.then === 'function') result.catch(() => {})
    } catch (error) {
      ctx.logger.warn('dsh-llm-proxy: proxy install failed: %o', error)
    }
  }

  if (typeof ctx.inject === 'function') {
    // Settings-backed path (dsh 0.1.7). The settings document for this plugin
    // is addressed by its Loader entry id (`llm-proxy`) and derived from the
    // exported Config schema, so there is no namespace to register and no
    // `settings.register` seam left: the config object handed to apply()
    // already carries the resolved values. Volatile fields arrive as live
    // accessors and a settings write commits into them in place
    // (cordis-plugin-loader `_commitVolatile`), which emits
    // `loader/volatile-update` on this fiber only — so the re-install rides
    // that event plus the provider documents' own updates. The bridge routes
    // stay mounted for the card's model list and connection test.
    ctx.inject(['settings'], (sctx) => {
      const seam = sctx.settings
      const scope = { get: () => plainProxyConfig(config) }
      try {
        const applyCurrent = () => {
          install(seam, scope.get())
          syncRetryPolicy()
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

        // --- retry-policy mirroring (v1.0.3, retry engine since v1.4.0) -----
        // Retry is the official dsh-llm-retry plugin's job: it replays a failed
        // request from the owning provider's own `retryPolicy` and renders the
        // visible "(retry/maximum)" hint. Since v1.4.0 this mirror IS the retry
        // feature — the plugin no longer wraps the dispatcher in a transport
        // RetryAgent, which used to stack on top of the same policy (worst case
        // retries²) and deliberately ignored `Retry-After`.
        // Mirror the card values into the retryPolicy of every provider whose
        // model is selected in `proxiedModels`; deselected providers keep the
        // official defaults untouched.
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
            // cadence. Must keep the official defaults or the provider stops
            // retrying RATE_LIMIT/SERVER/etc.
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
        // Our own card's save commits the volatile fields in place and emits
        // `loader/volatile-update` on THIS fiber only; provider edits (baseURL,
        // models, retryPolicy) surface as settings document updates instead.
        const disposeVolatile = ctx.on('loader/volatile-update', () => {
          applyCurrent()
        })
        const disposeDoc = ctx.on('settings/document-updated', (ns) => {
          if (ns !== undefined && PROVIDER_NS.has(String(ns))) {
            applyCurrent()
          }
        })
        // Bridge routes need the webServer service, which may activate after
        // the settings seam; wait for both before mounting them.
        ctx.inject(['settings', 'webServer'], (bridgeCtx) => {
          const disposers = []
          for (const route of makeBridgeRoutes(bridgeCtx.settings, {
            trustedOrigins: plainProxyConfig(config).trustedOrigins, engineKind: active.kind, routeFor: active.routeFor,
          })) {
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
        ctx.logger.info('dsh-llm-proxy: settings document "llm-proxy" served from Config — live apply via 设置 → 插件 → 模型代理')
        sctx.effect(() => () => {
          disposeVolatile()
          disposeDoc()
          for (const timer of timers) clearTimeout(timer)
        })
      } catch (error) {
        ctx.logger.error('dsh-llm-proxy: live settings install failed — applying the resolved config directly')
        ctx.logger.error(error)
        install(seam, scope.get())
      }
    })
  } else {
    // No cordis inject (fake contexts, plain config).
    install(undefined, plainProxyConfig(config))
  }

  // Give the process back what the engine found (previous dispatcher, or the
  // launcher's official policy) and close whatever it opened.
  ctx.on('dispose', () => { Promise.resolve(active.teardown()).catch(() => {}) })
}

export { LLM_PROXY_NAMESPACE, makeBridgeHandlers, makeBridgeRoutes, SETTINGS_BRIDGE_PREFIX } from './settings.js'
