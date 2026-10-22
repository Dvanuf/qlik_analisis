import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: `${here}src`,
  base: './',
  plugins: [react()],
  build: {
    outDir: `${here}dist/renderer`,
    emptyOutDir: true,
    sourcemap: true,
  },
});
