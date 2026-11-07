import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      export { PcmSpectrum } from './src/netease/pcm-spectrum';
      export { listenToPlayback } from './src/netease/playback-audio';
      export { SpectrumHistory } from './src/shared/spectrum-history';
      export { Terrain } from './src/shared/terrain';
    `,
  },
  bundle: true,
  format: 'esm',
  write: false,
});
const { PcmSpectrum, listenToPlayback, SpectrumHistory, Terrain } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
);

const originalPerformance = globalThis.performance;
const originalWindow = globalThis.window;
let now = 0;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });

function tone(hz, startFrame = 0) {
  const bytes = new Uint8Array(12_800);
  const pcm = new DataView(bytes.buffer);
  for (let frame = 0; frame < 3200; frame++) {
    const value = Math.round(2400 * Math.sin(2 * Math.PI * hz * (startFrame + frame) / 48_000));
    pcm.setInt16(frame * 4, value, true);
    pcm.setInt16(frame * 4 + 2, value, true);
  }
  return bytes;
}

function dominantHz(levels) {
  const band = levels.indexOf(Math.max(...levels));
  return 30 * (16_000 / 30) ** (band / 127);
}

try {
  let analysedRows = 0;
  let writtenRows = 0;
  const history = new SpectrumHistory({
    replaceHistory() {},
    pushRow() { writtenRows++; },
  }, 60);
  const sample = (_time, target) => { analysedRows++; target.fill(0.5); };
  history.advance(1, sample, 4);
  assert.ok(analysedRows <= 4, 'A delayed frame caused an unbounded burst of audio analysis.');
  assert.ok(writtenRows >= 59, 'History stopped following elapsed time during catch-up.');
  const before = analysedRows;
  history.advance(1 / 60, sample, 4);
  assert.equal(analysedRows - before, 1, 'Normal 60 Hz analysis changed.');

  // Exercise the production upload batching without creating a browser context.
  const terrain = Object.create(Terrain.prototype);
  const rowBytes = 255 * 4;
  const rowCount = 152;
  const uploaded = new Uint8Array(rowBytes * rowCount);
  let uploads = 0;
  let lost = false;
  Object.assign(terrain, {
    rowBytes: new Uint8Array(rowBytes),
    historyBytes: new Uint8Array(uploaded.length),
    filteredRow: new Float32Array(128),
    heightUniforms: { historyHead: { value: 0 } },
    rowOffset: { y: 0 },
    rowTexture: {
      source: { data: { width: 255, height: 1 } },
      get image() { return this.source.data; },
    },
    heightMap: {},
    pendingRows: 0,
    renderer: {
      getContext: () => ({ isContextLost: () => lost }),
      copyTextureToTexture(position, source) {
        uploads++;
        uploaded.set(source.image.data, position.y * rowBytes);
      },
    },
  });
  let head = 0;
  const profile = new Float32Array(128);
  for (const batchSize of [1, 3, 40, 150, 200]) {
    uploads = 0;
    for (let row = 0; row < batchSize; row++) {
      head = (head + rowCount - 1) % rowCount;
      profile.fill((row + 1) / (batchSize + 1));
      terrain.pushRow(head, profile);
    }
    assert.equal(uploads, 0, 'History uploaded before the display frame.');
    terrain.flushHistory();
    assert.ok(uploads <= 2, 'Ring wrap generated too many GPU uploads.');
    assert.deepEqual(uploaded, terrain.historyBytes, 'Batched upload corrupted the frequency history.');
  }
  lost = true;
  terrain.pushRow((head + rowCount - 1) % rowCount, profile);
  terrain.flushHistory();
  assert.ok(terrain.pendingRows > 0);
  lost = false;
  terrain.flushHistory();
  assert.deepEqual(uploaded, terrain.historyBytes);
  console.log('PASS: bounded catch-up analysis and exact ring uploads with at most two GPU transfers per frame.');

  const audio = new PcmSpectrum();
  const levels = new Float32Array(128);
  const arrivals = [0, 67, 152, 216, 344, 604, 671, 756, 823, 1083];
  let arrival = 0;
  for (now = 0; now <= 1100; now += 1000 / 60) {
    if (arrival < arrivals.length && now >= arrivals[arrival]) {
      audio.push(tone(1000, arrival * 3200), arrival * 3200 / 48);
      arrival++;
    }
    audio.sample(levels);
    if (now >= 200) {
      assert.ok(Math.max(...levels) > 0.5, 'A continuous tone became silent between delayed packets.');
    }
  }

  // A burst after a UI stall should select fresh audio instead of replaying the backlog.
  for (let packet = 0; packet < 10; packet++) {
    audio.push(tone(6000, packet * 3200), (arrival + packet) * 3200 / 48);
  }
  audio.sample(levels);
  assert.ok(Math.abs(dominantHz(levels) / 6000 - 1) < 0.1);
  now += 300;
  audio.sample(levels);
  assert.ok(Math.max(...levels) > 0, 'A short delivery gap caused a hard cut.');
  now += 310;
  audio.sample(levels);
  assert.ok(levels.every((level) => level === 0));
  audio.push(tone(1000), 0);
  audio.sample(levels);
  assert.ok(Math.max(...levels) > 0, 'Playback recovery waited for another buffer fill.');
  audio.reset();
  audio.sample(levels);
  assert.ok(levels.every((level) => level === 0));

  const callbacks = {};
  const native = {};
  const adapter = {
    registerCallMap: callbacks,
    registerCallAdapter(event, callback) { native[event] = callback; },
    _registerCallQueue(event) {
      return (...args) => {
        const registered = callbacks[event];
        const listeners = Array.isArray(registered) ? registered : registered ? [registered] : [];
        listeners.forEach((listener) => listener(...args));
      };
    },
  };
  const bridge = {
    _Adapter: adapter,
    appendRegisterCall(event, scope, callback) {
      const name = scope + '.on' + event;
      const current = callbacks[name];
      callbacks[name] = Array.isArray(current) ? [...current, callback] : current ? [current, callback] : [callback];
      adapter.registerCallAdapter(name, adapter._registerCallQueue(name));
      return true;
    },
    removeRegisterCall(event, scope, callback) {
      const name = scope + '.on' + event;
      callbacks[name] = (callbacks[name] ?? []).filter((listener) => listener !== callback);
      return true;
    },
  };
  const gates = [];
  const player = { async setAudioDataEnableState(enabled) { gates.push(enabled); } };
  const originalRegister = adapter.registerCallAdapter;
  const originalEnable = player.setAudioDataEnableState;
  const reasons = [];
  let consumed = 0;
  let forwarded = 0;
  callbacks['audioplayer.onAudioData'] = () => forwarded++;
  globalThis.window = { webpackJsonp: [] };
  window.webpackJsonp.push = ([, modules]) => modules['spectrum-terrain-playback-audio'](
    undefined, undefined, { c: { sdk: { exports: { Bridge: bridge, AudioPlayer: player } } } }
  );
  const stop = listenToPlayback(
    () => consumed++,
    () => assert.fail('Unexpected native audio error.'),
    (reason) => reasons.push(reason),
  );
  const packet = { data: tone(1000), pts: 0 };
  native['audioplayer.onAudioData']([packet]);
  assert.equal(consumed, 1);
  assert.equal(forwarded, 1);
  native['audioplayer.onPlayState']('song1', 1, 2);
  native['audioplayer.onAudioData']([packet]);
  assert.equal(consumed, 1, 'Queued PCM continued after pause.');
  native['audioplayer.onPlayState']('song1', 2, 1);
  native['audioplayer.onAudioData']([packet]);
  assert.equal(consumed, 2);
  native['audioplayer.onSeek']('song1', 3, 0, 12_000);
  native['audioplayer.onPlayState']('song2', 4, 1);
  assert.deepEqual(reasons, ['pause', 'seek', 'track']);
  await player.setAudioDataEnableState(false);
  stop();
  assert.equal(adapter.registerCallAdapter, originalRegister);
  assert.equal(player.setAudioDataEnableState, originalEnable);
  assert.equal(gates.at(-1), false);
  for (const event of ['PlayState', 'Seek', 'End']) {
    assert.equal(callbacks['audioplayer.on' + event].length, 0);
  }
  native['audioplayer.onAudioData']([packet]);
  assert.equal(consumed, 2);
  assert.equal(forwarded, 4);
  console.log('PASS: packet jitter, fresh backlog selection, idle decay, pause/seek/track events and cleanup.');
} finally {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
