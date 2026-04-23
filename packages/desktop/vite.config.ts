import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    assetsDir: '.',
    // @lynlens/core is emitted as CJS (Object.defineProperty exports) so
    // rollup's static analyzer can't see the named exports by default. Force
    // it through the commonjs plugin and pre-scan named exports.
    commonjsOptions: {
      include: [/node_modules/, /@lynlens\/core/, /packages\/core/],
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    // IMPORTANT: do NOT pre-bundle @lynlens/core. The compiled tsc output
    // uses `Object.defineProperty(exports, "foo", { get: ... })` for any
    // `export { foo } from './bar'` re-export. esbuild's cjs-module-lexer
    // can't statically see those named exports through the defineProperty
    // call, so it falls back to `export default require_dist()` only —
    // meaning `import { getEffectiveDuration } from '@lynlens/core'`
    // resolves to undefined at runtime even though TypeScript typechecks it.
    // Vite's dev-mode on-the-fly CJS↔ESM transform handles the getter-style
    // exports correctly when the module is NOT pre-bundled.
    exclude: ['@lynlens/core'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
