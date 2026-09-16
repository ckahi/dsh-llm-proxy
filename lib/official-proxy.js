/**
 * dsh-llm-proxy v1.4.0 — official `@deepseek-ai/dsh-http-proxy` bridge.
 *
 * DSH ships its own outbound-proxy package: `@deepseek-ai/dsh-http-proxy`
 * resolves ONE process-wide policy from the launch environment and installs it
 * as undici's global dispatcher, with the same per-origin `factory` shape this
 * plugin used to hand-roll. When that package is present, re-implementing the
 * transport layer would only fight it — whichever side calls
 * `setGlobalDispatcher` last wins, and the loser's extras (subprocess
 * environment propagation, the `proxy-exempt` web-fetch seam, its IPv6/CIDR
 * matcher) silently stop applying.
 *
 * So this module lets the plugin ride the official transport instead:
 *
 *   1. **Detect** the package (bare import, then resolution from the host CLI
 *      entry point, since a profile's plugin directory is not on the CLI's own
 *      module chain).
 *   2. **Feed it a policy** through its public seam:
 *      `installProxyFromEnvironment(envLookup, report)` accepts any
 *      `{ get(name) }` — the launcher passes its launch-environment snapshot
 *      and this plugin passes a computed one, so the routing decision stays the
 *      plugin's while the matcher, dispatcher and child-environment
 *      publication stay the official, tested ones. Official supports layered
 *      installs and hands back a disposer that restores the launcher's policy.
 *   3. **Ask it** where a single request goes (`proxyRouteFor`) so the card's
 *      测试连接 reports the real route rather than the configured intent.
 *
 * The policy this plugin installs is the official one — "proxy by default, the
 * bypass list stays direct" — with the bypass list computed to mean "every
 * configured provider host except the ones you ticked": the user-visible intent
 * (国内 API 直连，勾选的境外模型走代理) is preserved, expressed in the
 * vocabulary the official package actually routes by.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The official package this bridge drives. */
export const OFFICIAL_PROXY_PACKAGE = '@deepseek-ai/dsh-http-proxy'

/** Proxy environment names the official policy owns (lowercase first, as undici reads them). */
const PROXY_URL_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY']

/** Every proxy name, so a lookup can answer "absent" for the ones it does not own. */
const ALL_PROXY_NAMES = [...PROXY_URL_NAMES, ...NO_PROXY_NAMES, 'all_proxy', 'ALL_PROXY']

/**
 * Test hook state. `undefined` = resolve for real (production), `null` = the
 * package is treated as NOT installed, a module face = stand in for it. The
 * distinct "forced absent" value keeps the bundled-engine tests hermetic: a
 * machine that happens to have the official package somewhere on the module
 * path (e.g. under a parent directory) must not flip their engine.
 */
let injected
/** Resolved-once cache: `{ module, from }` or `null` when the package is absent. */
let cached
let resolving

/**
 * Split a comma/whitespace separated bypass list into trimmed entries.
 * Mirrors how the official package reads the same value, so entries this
 * plugin merges in survive the round trip unchanged.
 *
 * @param value - the raw list, or anything else.
 * @returns the non-empty entries.
 */
export function splitProxyList(value) {
  if (typeof value !== 'string' || value.length === 0) return []
  return value.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/**
 * Build the environment lookup the official package resolves a policy from.
 *
 * The returned object satisfies its `EnvLookup` contract structurally — a
 * name in, the winning value out — which is the documented reason the official
 * module names no package to describe its input. Lowercase and uppercase are
 * always written together because undici reads the lowercase name first.
 *
 * @param options - `proxyUrl` for both schemes, `bypass` entries that stay direct.
 * @returns an `EnvLookup`-shaped object; nothing outside these names is answered.
 */
export function policyEnvLookup({ proxyUrl, bypass = [] } = {}) {
  const entries = []
  const seen = new Set()
  for (const entry of bypass) {
    for (const single of splitProxyList(entry)) {
      const key = single.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(single)
    }
  }
  const noProxy = entries.join(',')
  const values = new Map()
  if (typeof proxyUrl === 'string' && proxyUrl.length > 0) {
    for (const name of PROXY_URL_NAMES) values.set(name, proxyUrl)
  }
  if (noProxy.length > 0) for (const name of NO_PROXY_NAMES) values.set(name, noProxy)
  return {
    get(name) {
      const value = values.get(String(name))
      return value === undefined ? undefined : { value }
    },
  }
}

/** Whether a value can stand in for the official package. */
function isOfficialProxyModule(candidate) {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof candidate.installProxyFromEnvironment === 'function'
    && typeof candidate.proxyRouteFor === 'function'
}

/** Import one already-resolved absolute path as a module. */
async function importPath(path) {
  try {
    const mod = await import(pathToFileURL(path).href)
    return mod?.default !== undefined && !isOfficialProxyModule(mod) && isOfficialProxyModule(mod.default)
      ? mod.default
      : mod
  } catch {
    return null
  }
}

/**
 * Resolve the package from a specific module's perspective. A profile installs
 * plugins into its own directory, which is NOT on the dsh CLI's module chain,
 * so a bare specifier from here usually fails — resolving from the CLI entry
 * point is what actually finds the copy the harness loaded.
 */
async function importResolvedFrom(parent) {
  try {
    const require = createRequire(parent)
    const resolved = require.resolve(OFFICIAL_PROXY_PACKAGE)
    return await importPath(resolved)
  } catch {
    return null
  }
}

/** The candidate module faces, in the order they are tried. */
function candidates() {
  const parents = []
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) parents.push(process.argv[1])
  parents.push(import.meta.url)
  if (typeof process.execPath === 'string' && process.execPath.length > 0) parents.push(process.execPath)
  return parents
}

/** Resolve the official package once per process; never rejects. */
async function resolveOfficialProxy() {
  // The test hook stands in for the package: same validation, same shape, so a
  // partial stub is rejected exactly like a broken install would be.
  if (injected === null) return null // forced absent (tests)
  // The test hook stands in for the package: same validation, same shape, so a
  // partial stub is rejected exactly like a broken install would be.
  if (injected !== undefined) return isOfficialProxyModule(injected) ? { module: injected, from: 'injected' } : null
  try {
    const bare = await import(OFFICIAL_PROXY_PACKAGE)
    if (isOfficialProxyModule(bare)) return { module: bare, from: 'import' }
  } catch {
    /* not on this module chain — resolve from the host CLI instead */
  }
  const parents = candidates()
  for (let index = 0; index < parents.length; index += 1) {
    const mod = await importResolvedFrom(parents[index])
    if (isOfficialProxyModule(mod)) {
      return { module: mod, from: index === 0 ? 'host-entry' : 'module-chain' }
    }
  }
  return null
}

/**
 * Load the official outbound-proxy package.
 *
 * @returns `{ module, from }` when the package is usable, otherwise `null`
 *   (an older harness) — the caller then keeps the bundled dispatcher.
 */
export async function loadOfficialProxy() {
  if (cached !== undefined) return cached
  if (resolving === undefined) {
    resolving = resolveOfficialProxy()
      .then((result) => {
        cached = result
        return result
      })
      .catch(() => {
        cached = null
        return null
      })
      .finally(() => {
        resolving = undefined
      })
  }
  return resolving
}

/**
 * Test hook: stand in for the official package, or pass `null` to force the
 * "not installed" answer regardless of the real module path.
 */
export function __setOfficialProxyForTest(moduleFace) {
  injected = moduleFace === undefined ? null : moduleFace
  cached = undefined
  resolving = undefined
}

/** Test hook: forget the injected face and the resolution cache (resolve for real). */
export function __resetOfficialProxyForTest() {
  injected = undefined
  cached = undefined
  resolving = undefined
}

/** Proxy names the official package publishes; exported for diagnostics/tests. */
export const PROXY_ENV_NAMES = ALL_PROXY_NAMES
