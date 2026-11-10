import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  server: { fs: { allow: [resolve(here, '../..')] } },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
});
