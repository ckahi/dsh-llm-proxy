/**
 * dsh-llm-proxy — routing dispatcher.
 *
 * Routes each request by target hostname:
 *
 *   1. loopback hosts (localhost/127.0.0.1/::1)        → direct Agent
 *   2. hosts matching the proxied-model host set       → ProxyAgent
 *   3. everything else                                 → direct Agent
 *
 * The default is DIRECT: only hosts whose models were explicitly selected as
 * "走代理的模型" go through the proxy. This mirrors the model-level intent —
 * pick the models that need the proxy, everything else stays on the direct
 * path (domestic APIs etc.).
 *
 * Retry is NOT implemented here: the plugin wraps this dispatcher in undici's
 * official `RetryAgent` (lib/index.js), which replays the request on transport
 * errors, HTTP 429 and 5xx with proper body/connection handling. This class
 * stays a pure router (route + agent selection).
 *
 * The class only needs to implement the subset of the undici Dispatcher
 * contract that `fetch` uses (`dispatch`, `close`, `destroy`, `isMockActive`),
 * so it can be installed with `setGlobalDispatcher` just like the built-in
 * agents.
 */

/** Normalize a hostname for matching (strip port, brackets, scheme). */
function normalizeHost(host) {
  if (!host) return ''
  let h = String(host).trim().toLowerCase()
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname
    } catch {
      /* fall through */
    }
  }
  h = h.replace(/:\d+$/, '').replace(/^\[(.+)\]$/, '$1')
  return h
}

/** True when `host` is a loopback address (always direct, never proxied). */
function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Normalize a possibly scheme-prefixed proxy endpoint into a ProxyAgent URI.
 *
 * Users habitually paste `http://127.0.0.1:7897` (or `socks5://…`) into the
 * `proxyHost` field; the raw `http://${proxyHost}:${proxyPort}` join would
 * produce a double-scheme URI and silently disable proxy routing. We strip the
 * scheme (remembering http/https) and let an inline port win over `proxyPort`.
 */
function normalizeProxyEndpoint(proxyHost, proxyPort) {
  let host = String(proxyHost ?? '').trim()
  let scheme = 'http'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    try {
      const url = new URL(host)
      scheme = url.protocol.replace(/:$/, '') || 'http'
      if (url.hostname) host = url.hostname
      if (url.port) proxyPort = Number(url.port)
    } catch {
      /* keep the raw host; the constructor's URL check will surface the error */
    }
  }
  return { uri: `${scheme}://${host}:${proxyPort}`, host, port: proxyPort }
}

export class RoutingDispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.undici            undici module (for Agent / ProxyAgent)
   * @param {string} [opts.proxyHost]       proxy hostname/IP (default 127.0.0.1)
   * @param {number} [opts.proxyPort]       proxy port (default 7897)
   * @param {string[]|Set<string>} [opts.proxyHosts]  hostnames that go through the proxy
   * @param {object} [opts.logger]          cordis logger (info/warn/error)
   */
  constructor({ undici, proxyHost = '127.0.0.1', proxyPort = 7897, proxyHosts = [], logger }) {
    this.undici = undici
    this.logger = logger
    this.isMockActive = false

    // Direct agent for loopback + unselected hosts.
    this.direct = new undici.Agent()

    // One ProxyAgent for the configured proxy endpoint.
    //
    // Connection-pool pitfall (undici 8.x): the ProxyAgent's internal
    // proxy-side client pool defaults to keep-alive. When the proxy (e.g.
    // Clash) silently closes an idle CONNECT tunnel, undici does not notice
    // and reuses the dead socket — the request hangs until timeout
    // ("Request timed out" / HeadersTimeoutError). Empirically this fails
    // intermittently (measured 2/10 with 2.5s idle gaps while a raw tunnel
    // succeeds 10/10). The fix disables reuse on the proxy-side pool via
    // clientFactory + pipelining: 0, so every tunnel is a fresh connection.
    let proxyUrl = ''
    try {
      proxyUrl = normalizeProxyEndpoint(proxyHost, proxyPort).uri
      this.proxy = new undici.ProxyAgent({
        uri: proxyUrl,
        clientFactory: (origin, opts) => new undici.Pool(origin, { ...opts, pipelining: 0 }),
      })
    } catch (error) {
      logger?.warn(`dsh-llm-proxy: invalid proxy endpoint "${proxyUrl}" — proxy routing disabled`)
      logger?.warn(error)
      this.proxy = null
    }

    // Hostnames selected via the 走代理的模型 list.
    this.proxyHosts = new Set()
    for (const host of proxyHosts ?? []) {
      const key = normalizeHost(host)
      if (key && !isLoopback(key)) this.proxyHosts.add(key)
    }

    this.closed = false
  }

  /**
   * @returns {import('undici').ProxyAgent|import('undici').Agent} the agent for a hostname
   */
  #agentFor(host) {
    if (this.proxy === null) return this.direct
    if (isLoopback(host)) return this.direct
    if (host && this.proxyHosts.has(host)) return this.proxy
    // Subdomain fallback: a route entry that the host ends with.
    for (const entry of this.proxyHosts) {
      if (host.endsWith(`.${entry}`)) return this.proxy
    }
    return this.direct
  }

  /**
   * undici dispatcher entry point. Returns true when the request is
   * accepted; false means the caller owns the failure.
   */
  dispatch(opts, handler) {
    if (this.closed) {
      handler?.onResponseError?.(null, new Error('dsh-llm-proxy: dispatcher closed'))
      return false
    }
    let host = ''
    try {
      host = normalizeHost(new URL(opts.origin).hostname)
    } catch {
      host = normalizeHost(String(opts.origin ?? ''))
    }
    return this.#agentFor(host).dispatch(opts, handler)
  }

  close(callback) {
    this.closed = true
    const jobs = [this.direct.close()]
    if (this.proxy !== null) jobs.push(this.proxy.close())
    if (typeof callback === 'function') {
      Promise.all(jobs).then(() => callback(null), callback)
      return
    }
    return Promise.all(jobs)
  }

  destroy(err, callback) {
    this.closed = true
    const jobs = [this.direct.destroy(err)]
    if (this.proxy !== null) jobs.push(this.proxy.destroy(err))
    if (typeof callback === 'function') {
      Promise.all(jobs).then(() => callback(null), callback)
      return
    }
    return Promise.all(jobs)
  }
}
