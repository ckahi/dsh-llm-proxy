/**
 * dsh-llm-proxy — browser half. Registers the 模型代理 page inside 设置 → 插件
 * (Built-in plugins) through the `settings.plugin.item` slot the Plugins page
 * (@deepseek-ai/dsh-client-ui-settings-plugins) declares at runtime, and binds
 * the plugin's settings document through the official `configForms` service.
 *
 * dsh 0.2.0 renamed the Plugins-page card slot `plugins.item` (list) →
 * `settings.plugin.item` (keyed by the edited settings namespace); the card
 * therefore registers under `key: 'llm-proxy'` and the tab pairs it with the
 * Host-served namespace without learning what it means.
 *
 * dsh 0.1.7 renamed the client settings binder `settingsScope` → `configForms`
 * and addresses a settings document by the owning plugin's Loader entry id
 * (`llm-proxy`) instead of a separately registered namespace. The service is
 * therefore resolved with `ctx.inject(['configForms'], …)` rather than a hard
 * `inject` entry: a hard inject of a service a host does not provide leaves the
 * fiber pending forever and the boot audit then reports this plugin with no
 * error text at all ("The client Loader did not provide an error message").
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`, `configForms`, `remote`); the bundle purity gate forbids
 * value imports of other @deepseek-ai packages.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useSyncExternalStore } from 'react'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ProxyModelCard } from './ProxyModelCard.tsx'
import type { ProxyModelCardInjected } from './ProxyModelCard.tsx'
import { configFormsOf, LlmProxySettingsBinder, LLM_PROXY_NAMESPACE } from './settings-scope.ts'
import type { ProxyModelScope } from './settings-scope.ts'
import { en, zh, type ProxyKey } from './locales.ts'

export type { ProxyModelCardInjected, ProxyModelCardProps } from './ProxyModelCard.tsx'
export type { ProxyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The 模型代理 page copy. */
    'settings.llm-proxy': ProxyKey
  }
  interface SlotMap {
    /**
     * One configurable plugin card (keyed slot, root scope), declared at
     * runtime by @deepseek-ai/dsh-client-ui-settings-plugins and keyed by the
     * edited settings namespace. Declared here so this package keeps
     * compiling without that package's typings installed.
     */
    'settings.plugin.item': { kind: 'keyed', scope: 'root' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.llm-proxy'

/** Required services (cordis fiber inject) — core UI services only. */
export const inject = ['slots', 'locale']

/**
 * Mount the 模型代理 page once the settings service answers, and bind the
 * llm-proxy settings document it serves.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-llm-proxy: copy dictionaries')
  const t = ctx.locale.bind(NS) as ProxyModelCardInjected['t']

  // Dynamic inject: this plugin must boot on a host without the settings
  // service, and only the card depends on it.
  ctx.inject(['configForms'], (child) => {
    const forms = configFormsOf(child)
    if (forms === undefined) return
    const binder = new LlmProxySettingsBinder(child)
    const scope: ProxyModelScope = binder.bind(forms)
    const useSnapshot = (): ReturnType<ProxyModelScope['getSnapshot']> =>
      useSyncExternalStore(scope.subscribe, scope.getSnapshot)
    const injected = (): ProxyModelCardInjected => ({ scope, useSnapshot, t })

    // The card exists only while the Host serves this plugin's settings
    // document (entry id `llm-proxy`): a deployment that does not compose this
    // plugin shows no trace of it. Keyed by the namespace — the tab pairs the
    // card with the served namespace it claims (dsh 0.2.0 slot contract).
    child.effect(() => forms.whileServed([LLM_PROXY_NAMESPACE], () => child.slots.inject('settings.plugin.item', () => child.slots.register({
      name: 'settings.plugin.item',
      key: LLM_PROXY_NAMESPACE,
      order: 50,
      locale: NS,
      inject: injected,
    }, ProxyModelCard))), 'dsh-llm-proxy: settings page')
  })
}
