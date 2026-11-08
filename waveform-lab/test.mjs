import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('./', import.meta.url)),
  stdin: {
    resolveDir: fileURLToPath(new URL('./', import.meta.url)),
    contents: `export * from './src/display-options'; export * from './src/spectrum-styles';`,
  },
  bundle: true, format: 'esm', write: false,
});
const { DEFAULT_DISPLAY, readDisplayOptions, FrequencyBars, createRidges, BAR_ROWS, RIDGE_ROWS, FIN_SEGMENTS } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'),
);

assert.deepEqual(readDisplayOptions(null), DEFAULT_DISPLAY);
assert.deepEqual(readDisplayOptions({ shape: '__proto__', appearance: 'unknown', columns: 999, gap: NaN }), DEFAULT_DISPLAY);
assert.equal(readDisplayOptions({ gap: -10 }).gap, 5);
assert.equal(readDisplayOptions({ gap: 100 }).gap, 65);
assert.equal(readDisplayOptions({ shape: 'ridges', appearance: 'neon', columns: 128 }).shape, 'ridges');
assert.equal(readDisplayOptions({ shape: 'fins' }).shape, 'fins');

const context = { uniforms: {}, sampleShader: '', width: 14, depth: 7.8, height: 3.2 };
const bars = new FrequencyBars(context);
for (const columns of [32, 64, 128]) {
  bars.configure(columns, 28);
  const geometry = bars.mesh.geometry;
  const center = geometry.getAttribute('barCenter');
  const bands = geometry.getAttribute('barBand');
  const ages = geometry.getAttribute('barAge');
  assert.equal(geometry.instanceCount, columns * BAR_ROWS);
  assert.equal(center.count, columns * BAR_ROWS);
  assert.equal(bars.frontTrace.geometry.instanceCount, columns);
  const frontBands = bars.frontTrace.geometry.getAttribute('barBand');
  const frontCenters = bars.frontTrace.geometry.getAttribute('barCenter');
  for (let column = 0; column < columns; column++) {
    const instance = center.count - columns + column;
    assert.equal(frontBands.getX(column), bands.getX(instance), 'A front highlight sampled a different frequency bucket.');
    assert.equal(frontCenters.getX(column), center.getX(instance));
    assert.equal(frontCenters.getY(column), center.getY(instance));
  }
  assert.equal(ages.getX(0), 1, 'Old history must draw before the newest row.');
  assert.equal(ages.getX(center.count - 1), 0);
  const coverage = [];
  const group = 128 / columns;
  for (let column = 0; column < columns; column++) {
    const first = (bands.getX(column) - (group - 1)) / 2;
    for (let offset = 0; offset < group; offset++) coverage.push(first + offset);
  }
  assert.deepEqual(coverage, Array.from({ length: 128 }, (_, index) => index), 'A narrow FFT peak can fall between bar buckets.');
  const width = bars.mesh.material.uniforms.barWidth.value;
  const depth = bars.mesh.material.uniforms.barDepth.value;
  for (let instance = 0; instance < center.count; instance++) {
    assert.ok(Math.abs(center.getX(instance)) + width / 2 <= context.width / 2 + 1e-5);
    assert.ok(Math.abs(center.getY(instance)) + depth / 2 <= context.depth / 2 + 1e-5);
  }
  bars.configure(columns, 65);
  assert.equal(bars.mesh.geometry, geometry, 'Changing spacing unnecessarily allocated a new geometry.');
  let disposed = false;
  let frontDisposed = false;
  bars.frontTrace.geometry.addEventListener('dispose', () => { frontDisposed = true; });
  geometry.addEventListener('dispose', () => { disposed = true; });
  bars.configure(columns === 128 ? 32 : 128, 28);
  assert.ok(disposed, 'Changing density leaked the old geometry.');
  assert.ok(frontDisposed, 'Changing density leaked the front highlights.');
}
for (const columns of [32, 64, 128]) {
  bars.configure(columns, 45, true);
  const geometry = bars.mesh.geometry;
  assert.equal(geometry.instanceCount, columns, 'Fins should connect time samples rather than instantiate a bar per history row.');
  assert.equal(bars.frontTrace.geometry.instanceCount, columns);
  assert.equal(bars.mesh.material.uniforms.barDepth.value, context.depth);
  assert.equal(bars.mesh.material.uniforms.finMode.value, 1);
  const position = geometry.getAttribute('position');
  const ages = new Set();
  for (let index = 0; index < position.count; index++) ages.add(Math.round((0.5 - position.getZ(index)) * FIN_SEGMENTS));
  assert.deepEqual([...ages].sort((left, right) => left - right), Array.from({ length: FIN_SEGMENTS + 1 }, (_, index) => index),
    'A fin has gaps in its history profile.');
  const centers = geometry.getAttribute('barCenter');
  for (let index = 0; index < centers.count; index++) assert.equal(centers.getY(index), 0);
  bars.configure(columns, 28, true);
  assert.equal(bars.mesh.geometry, geometry, 'Changing fin spacing unnecessarily replaced its history geometry.');
  let disposed = false;
  geometry.addEventListener('dispose', () => { disposed = true; });
  bars.configure(columns, 28, false);
  assert.ok(disposed, 'Switching back to bars leaked the fin geometry.');
  assert.equal(bars.mesh.geometry.instanceCount, columns * BAR_ROWS);
  assert.equal(bars.mesh.material.uniforms.finMode.value, 0);
}
const ridges = createRidges(context);
assert.equal(ridges.geometry.instanceCount, RIDGE_ROWS);
const ages = ridges.geometry.getAttribute('ridgeAge');
assert.equal(ages.getX(0), 1);
assert.equal(ages.getX(RIDGE_ROWS - 1), 0);
for (const mesh of [bars.mesh, bars.frontTrace, ridges]) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}
console.log('PASS: display options, frequency coverage, continuous fin history, bounded instancing and geometry cleanup.');
