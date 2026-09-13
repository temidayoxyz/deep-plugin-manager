/**
 * Client factory build: the browser half must be the loader's lazy-CJS
 * factory artifact (`window.__ModuleLoader__.load`), not a bare ESM import
 * (a bare `import` in the served combo kills the whole page script).
 * React stays external: the harness client runtime owns the React instance.
 * The Host half is plain ESM for Node.
 */
import type { UserConfig } from 'tsdown'

const ID = 'dsh-deep-plugin-manager'

const PLATFORM = new Set(['react', 'react/jsx-runtime'])

const host: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib/client',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => PLATFORM.has(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'index.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
