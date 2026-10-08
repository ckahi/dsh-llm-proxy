// Quick shape check for the built client bundle.
import { readFileSync } from 'node:fs'
const s = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const checks = {
  'ModuleLoader handoff': s.includes('window.__ModuleLoader__.load'),
  'bundle id dsh-llm-proxy': /load\(\{\s*id: "@superfish058\/dsh-llm-proxy"/.test(s),
  'apply exported': /exports\.apply\s*=/.test(s),
  'inject exported': /exports\.inject\s*=/.test(s),
  'list seat registered': s.includes('plugins.item'),
  'official seat registered': s.includes('plugins.bundle.config'),
  'family seat registered': s.includes('web-ui.plugin.item'),
  '0.2.0 icon name': s.includes('IconChevronDownOutlineRegular'),
  'bundle key': s.includes('@superfish058/dsh-llm-proxy'),
  'configForms bound': s.includes('configForms'),
  'bridge prefix': s.includes('/api/dsh-llm-proxy/settings'),
  'locale zh keys': s.includes('模型代理'),
}
let fail = false
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) fail = true
}
process.exit(fail ? 1 : 0)
