/**
 * Client-bundle build check: verifies lib/client.js exists (run `npm run
 * build` first) and carries the loader handoff, the plugin id, the
 * `plugins.item` page registration, the configForms binding and the
 * apply/inject exports the shell expects.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

test('client bundle is built and well-formed', () => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `npm run build` first')
  const source = readFileSync(path, 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'loader handoff present')
  assert.ok(source.includes('"@superfish058/dsh-llm-proxy"'), 'scoped bundle id stamped')
  assert.ok(source.includes('plugins.item'), 'plugins.item page registration present')
  // dsh 0.1.7: the Plugins page renders one tab per entry (id/order/label),
  // and the settings document is served by the shared configForms service —
  // the rc.6/rc.7 service-name inject + keyed slot must be gone.
  assert.ok(source.includes('"llm-proxy"'), 'page id present')
  assert.ok(source.includes('configForms'), 'configForms binding present')
  assert.ok(!source.includes('settings.plugin.item'), 'rc.7 slot name removed')
  assert.ok(!/exports\.inject\s*=\s*\[[^\]]*settingsScope/.test(source), 'rc.7 settingsScope service name removed')
  assert.ok(/exports\.apply\s*=/.test(source), 'apply exported')
  assert.ok(/exports\.inject\s*=/.test(source), 'inject exported')
})

test('client manifest is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh?.client, 'dsh.client manifest missing')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.exports?.['./client'], './lib/client.js')
})
