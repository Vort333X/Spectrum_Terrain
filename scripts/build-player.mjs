import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist-player', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/player/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'chrome90',
    legalComments: 'inline',
    outfile: 'dist-player/player.js',
  }),
  copyFile('player.html', 'dist-player/index.html'),
  copyFile('src/player/style.css', 'dist-player/player.css'),
  copyFile('node_modules/three/LICENSE', 'dist-player/three-LICENSE.txt'),
]);
console.log('Built dist-player/index.html');
