import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/web/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome90',
  legalComments: 'inline',
  outfile: 'dist/spectrum-terrain.js',
});

await Promise.all([
  copyFile('src/web/index.html', 'dist/index.html'),
  copyFile('src/web/style.css', 'dist/style.css'),
  copyFile('node_modules/three/LICENSE', 'dist/three-LICENSE.txt'),
  copyFile('LICENSE', 'dist/LICENSE.txt'),
  readFile('dist/spectrum-terrain.js').then((bundle) => {
    console.log(`Built dist/index.html (${Math.round(bundle.length / 1024)} KiB JavaScript)`);
  }),
]);
