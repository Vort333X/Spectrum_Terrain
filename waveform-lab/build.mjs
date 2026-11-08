import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const lab = new URL('./', import.meta.url);
const output = new URL('./dist/', lab);
await mkdir(output, { recursive: true });
await Promise.all([
  build({
    absWorkingDir: fileURLToPath(lab),
    entryPoints: ['src/main.ts'],
    bundle: true,
    minify: false,
    sourcemap: true,
    format: 'iife',
    target: 'chrome90',
    legalComments: 'inline',
    outfile: fileURLToPath(new URL('spectrum-terrain.js', output)),
  }),
  copyFile(new URL('src/index.html', lab), new URL('index.html', output)),
  copyFile(new URL('src/style.css', lab), new URL('style.css', output)),
  copyFile(new URL('../node_modules/three/LICENSE', lab), new URL('three-LICENSE.txt', output)),
  copyFile(new URL('../LICENSE', lab), new URL('LICENSE.txt', output)),
]);
console.log('Built waveform-lab/dist/index.html (unminified, with source map)');
