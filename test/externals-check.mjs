// List the external requires the built client bundle makes (must all be
// module-table entries provided by the shell at runtime).
import { readFileSync } from 'node:fs'
const s = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const specifiers = [...s.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
const unique = [...new Set(specifiers)]
console.log(unique.join('\n'))
const PLATFORM = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-store',
])
const unknown = unique.filter((x) => !PLATFORM.has(x))
console.log('---')
console.log(unknown.length === 0 ? 'ALL EXTERNALS ARE MODULE-TABLE ENTRIES ✓' : `UNKNOWN EXTERNALS: ${unknown.join(', ')}`)
