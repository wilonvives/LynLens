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
    include: ['@lynlens/core'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
