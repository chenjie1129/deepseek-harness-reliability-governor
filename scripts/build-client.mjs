import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const packageId = '@chenjie1129/dsh-reliability-governor-plugin'
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  sourcemap: 'inline',
  legalComments: 'none',
})

const output = result.outputFiles[0]
if (output === undefined) throw new Error('client build produced no JavaScript output')
const body = output.text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`

await mkdir('dist', { recursive: true })
await writeFile('dist/client.js', wrapped)
