import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { build } from 'esbuild';
import manifest from '../src/netease/manifest.json' with { type: 'json' };

const output = 'dist-netease';
const files = ['manifest.json', 'main.js', 'LICENSE.txt', 'three-LICENSE.txt'];
const archive = `${output}/${manifest.name}-${manifest.version}`;
const webPage = await readFile('src/web/index.html', 'utf8');
const effectControls = webPage.match(/<form id="effects">[\s\S]*?<\/form>/)?.[0];
if (!effectControls) throw new Error('Cannot find the shared effect controls in src/web/index.html.');
const worker = await build({
  entryPoints: ['src/netease/audio-worker.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome91',
  write: false,
});

await mkdir(output, { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/netease/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    loader: { '.css': 'text' },
    define: {
      NETEASE_EFFECT_CONTROLS: JSON.stringify(effectControls.replace(/\b(id|for)="/g, '$1="spectrum-terrain-')),
      AUDIO_WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text),
    },
    target: 'chrome91',
    outfile: `${output}/main.js`,
  }),
  copyFile('src/netease/manifest.json', `${output}/manifest.json`),
  copyFile('node_modules/three/LICENSE', `${output}/three-LICENSE.txt`),
  copyFile('LICENSE', `${output}/LICENSE.txt`),
]);

execFileSync('tar.exe', ['-a', '-cf', `${archive}.zip`, '-C', output, ...files], { stdio: 'inherit' });
await rename(`${archive}.zip`, `${archive}.plugin`);
console.log(`Built ${archive}.plugin`);
