import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { build } from 'esbuild';
import manifest from '../src/netease/manifest.json' with { type: 'json' };

const output = 'dist-netease';
const files = ['manifest.json', 'main.js', 'three-LICENSE.txt'];
const archive = `${output}/${manifest.name}-${manifest.version}`;

await mkdir(output, { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/netease/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    loader: { '.css': 'text' },
    target: 'chrome91',
    outfile: `${output}/main.js`,
  }),
  copyFile('src/netease/manifest.json', `${output}/manifest.json`),
  copyFile('node_modules/three/LICENSE', `${output}/three-LICENSE.txt`),
]);

execFileSync('tar.exe', ['-a', '-cf', `${archive}.zip`, '-C', output, ...files], { stdio: 'inherit' });
await rename(`${archive}.zip`, `${archive}.plugin`);
console.log(`Built ${archive}.plugin`);
