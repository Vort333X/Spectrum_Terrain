import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { build } from 'esbuild';
import manifest from '../src/netease/manifest.json' with { type: 'json' };

const output = 'dist-netease';
const files = ['manifest.json', 'main.js', 'three-LICENSE.txt'];
const archive = `${output}/${manifest.name}-${manifest.version}`;
const webPage = await readFile('index.html', 'utf8');
const effectControls = webPage.match(/<form id="effects">[\s\S]*?<\/form>/)?.[0];
if (!effectControls) throw new Error('Cannot find the shared effect controls in index.html.');

await mkdir(output, { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/netease/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    loader: { '.css': 'text' },
    define: { NETEASE_EFFECT_CONTROLS: JSON.stringify(effectControls.replace(/\b(id|for)="/g, '$1="spectrum-terrain-')) },
    target: 'chrome91',
    outfile: `${output}/main.js`,
  }),
  copyFile('src/netease/manifest.json', `${output}/manifest.json`),
  copyFile('node_modules/three/LICENSE', `${output}/three-LICENSE.txt`),
]);

execFileSync('tar.exe', ['-a', '-cf', `${archive}.zip`, '-C', output, ...files], { stdio: 'inherit' });
await rename(`${archive}.zip`, `${archive}.plugin`);
console.log(`Built ${archive}.plugin`);
