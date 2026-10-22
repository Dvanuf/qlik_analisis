/**
 * Сборка main- и preload-процессов Electron в CommonJS.
 * Ядро анализа (../src) бандлится в main — оно остаётся единственным источником правды
 * и для десктопа, и для CLI, и для CI.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(root, 'electron/main.ts')],
  outfile: resolve(root, 'dist/main/main.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'electron/preload.ts')],
  outfile: resolve(root, 'dist/main/preload.js'),
});

console.log('main и preload собраны');
