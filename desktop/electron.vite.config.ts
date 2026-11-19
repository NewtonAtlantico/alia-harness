import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Three bundles:
 *  - main:    `out/main/index.js` (the broker) and `out/main/engine.js` (the engine, run in a utilityProcess).
 *  - preload: `out/preload/index.cjs`. CommonJS on purpose: a sandboxed preload cannot be an ES module.
 *  - renderer: the React app.
 *
 * The desktop package has no runtime `dependencies`, so nothing is externalized: `core` and its
 * packages (openai, unpdf, fflate, diff) are bundled into engine.js and the app needs no node_modules.
 * `alia-harness/core` points at the source, so the app never depends on a stale `dist/`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = resolve(here, '../src/core/index.ts');

export default defineConfig({
  main: {
    resolve: {
      alias: {
        'alia-harness/core': coreEntry,
        // fflate's Node build declares its own `require`, which clashes with the one electron-vite
        // injects into an ES-module bundle. Core uses only the synchronous API, which the browser build has.
        fflate: 'fflate/browser',
      },
    },
    build: {
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(here, 'src/main/index.ts'),
          engine: resolve(here, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(here, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    plugins: [react()],
    // The renderer's root is a sub-folder, so tell Vite where the packages and its cache really are
    // (without this the dev server loaded two copies of React: "Invalid hook call").
    cacheDir: resolve(here, 'node_modules/.vite'),
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    build: { rollupOptions: { input: resolve(here, 'src/renderer/index.html') } },
  },
});
