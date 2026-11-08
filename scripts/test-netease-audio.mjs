import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      export { PcmSpectrum } from './src/netease/pcm-spectrum';
      export { listenToPlayback } from './src/netease/playback-audio';
      export { SpectrumHistory } from './src/shared/spectrum-history';
      export { Terrain } from './src/shared/terrain';
      export { PlaybackSpectrum, summarizeWorkerError } from './src/netease/playback-spectrum';
      export { FrameLimit, normalizeFrameLimit } from './src/netease/frame-limit';
    `,
  },
  bundle: true,
  format: 'esm',
  define: { AUDIO_WORKER_SOURCE: JSON.stringify('/* controlled worker test */') },
  write: false,
});
const { PcmSpectrum, listenToPlayback, SpectrumHistory, Terrain, PlaybackSpectrum, FrameLimit, normalizeFrameLimit, summarizeWorkerError } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
);

const originalPerformance = globalThis.performance;
const originalWindow = globalThis.window;
const originalWorker = globalThis.Worker;
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
  for (const displayRate of [60, 120, 144, 240]) {
    for (const cap of [0, 24, 30, 50, 60, 90, 144, 240]) {
      const limiter = new FrameLimit();
      limiter.fps = cap;
      let count = 0;
      for (let tick = 0; tick < displayRate * 10; tick++) {
        if (limiter.due(tick * 1000 / displayRate)) count++;
      }
      assert.ok(Math.abs(count - Math.min(displayRate, cap || displayRate) * 10) <= 1,
        `Incorrect frame pacing for ${cap} FPS on a ${displayRate} Hz display: ${count}`);
      assert.ok(limiter.due(20_000), 'A delayed frame did not resume rendering.');
      if (cap) assert.equal(limiter.due(20_000.01), false, 'A stall triggered an immediate catch-up render.');
      limiter.fps = 30;
      assert.ok(limiter.due(20_001), 'Changing the cap did not reset the schedule.');
    }
  }
  assert.equal(normalizeFrameLimit(NaN), 60);
  assert.equal(normalizeFrameLimit(-10), 0);
  assert.equal(normalizeFrameLimit(999), 240);
  assert.equal(summarizeWorkerError("Access to 'data:text/javascript," + 'x'.repeat(10000) + "' is blocked from origin 'orpheus://orpheus'."),
    "Access to 'data:[内嵌脚本]' is blocked from origin 'orpheus://orpheus'.");
  console.log('PASS: custom FPS caps across 60/120/144/240 Hz, unlimited mode, runtime changes and stall recovery.');

  const workerBundle = await build({
    entryPoints: ['src/netease/audio-worker.ts'], bundle: true, format: 'iife', target: 'chrome91', write: false,
  });
  const directReplies = [];
  const workerSelf = { postMessage: (message) => directReplies.push(message) };
  runInNewContext(workerBundle.outputFiles[0].text, { self: workerSelf, performance: { now: () => 0 } });
  assert.equal(directReplies[0].type, 'ready');
  const portReplies = [];
  const port = { onmessage: null, postMessage: (message) => portReplies.push(structuredClone(message)) };
  workerSelf.onmessage({ data: { type: 'connect' }, ports: [port] });
  assert.equal(portReplies[0].type, 'ready');
  port.onmessage({ data: { type: 'pcm', bytes: tone(1000), pts: 0 } });
  port.onmessage({ data: { type: 'sample', id: 123, steps: 1 } });
  assert.equal(portReplies.at(-1).id, 123);
  assert.ok(Math.abs(dominantHz(portReplies.at(-1).levels) / 1000 - 1) < 0.1);
  assert.equal(directReplies.length, 1, 'PCM results were forwarded through the host instead of the direct port.');
  port.onmessage({ data: { type: 'reset' } });
  port.onmessage({ data: { type: 'sample', id: 124, steps: 1 } });
  assert.ok(portReplies.at(-1).levels.every(value => value === 0));
  console.log('PASS: hosted worker receives native PCM, replies directly over MessagePort and resets on playback changes.');
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
  const stepped = new PcmSpectrum();
  stepped.push(tone(1000), 0);
  stepped.sample(levels);
  const cursorBefore = stepped.cursor;
  stepped.push(tone(1000, 3200), 3200 / 48);
  stepped.sample(levels, 2);
  assert.equal(stepped.cursor - cursorBefore, 1600, 'Worker sampling lost the number of elapsed spectrum steps.');
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

  const workers = [];
  globalThis.window.setTimeout = setTimeout;
  globalThis.Worker = class {
    messages = [];
    terminated = false;
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message, transfer = []) {
      this.messages.push(structuredClone(message, { transfer }));
    }
    terminate() { this.terminated = true; }
    emit(message) { this.onmessage({ data: message }); }
  };
  const background = new PlaybackSpectrum();
  const worker = workers[0];
  worker.emit({ type: 'ready' });
  const sharedBytes = tone(1000);
  background.push(sharedBytes, 0);
  assert.equal(sharedBytes.byteLength, 12_800, 'Transferring PCM detached the native packet.');
  for (let sample = 0; sample < 8; sample++) background.sample(levels);
  assert.equal(worker.messages.filter((message) => message.type === 'sample').length, 1, 'FFT requests accumulated.');
  assert.equal(worker.messages.at(-1).steps, 1);
  const oldRequest = worker.messages.at(-1).id;
  background.reset();
  worker.emit({ type: 'spectrum', id: oldRequest, levels: new Float32Array(128).fill(1) });
  background.push(sharedBytes, 0);
  background.sample(levels);
  assert.ok(levels.every((value) => value === 0), 'A stale worker result revived the previous track.');
  const currentRequest = worker.messages.at(-1).id;
  worker.emit({ type: 'spectrum', id: currentRequest, levels: new Float32Array(128).fill(0.5) });
  background.sample(levels);
  assert.ok(levels.every((value) => value === 0.5));
  background.dispose();
  assert.ok(worker.terminated);
  assert.equal(background.active, false);
  background.sample(levels);
  assert.ok(levels.every((value) => value === 0));

  const retry = new PlaybackSpectrum();
  const blobWorker = workers.at(-1);
  retry.push(sharedBytes, 0);
  blobWorker.onerror({ preventDefault() {}, message: 'Blob scheme unavailable' });
  const dataWorker = workers.at(-1);
  assert.ok(blobWorker.terminated);
  assert.match(dataWorker.url, /^data:text\/javascript/);
  for (let packet = 0; packet < 100; packet++) retry.push(sharedBytes, packet);
  retry.sample(levels);
  assert.equal(dataWorker.messages.length, 0, 'Audio accumulated while the worker was starting.');
  dataWorker.emit({ type: 'ready' });
  assert.equal(dataWorker.messages.length, 1);
  assert.equal(dataWorker.messages[0].type, 'pcm', 'Retry discarded the newest live packet.');
  assert.equal(dataWorker.messages[0].pts, 99, 'Startup replayed old audio instead of the newest packet.');
  assert.equal(retry.mode, '后台线程');
  blobWorker.onerror({ preventDefault() {}, message: 'Late error' });
  assert.equal(dataWorker.terminated, false, 'A stale worker error terminated the replacement.');
  assert.match(retry.diagnostic, /Blob scheme unavailable/);
  retry.dispose();

  globalThis.Worker = class { constructor() { throw new Error('Worker blocked'); } };
  const fallback = new PlaybackSpectrum();
  fallback.push(sharedBytes, 0);
  fallback.sample(levels);
  assert.ok(Math.max(...levels) > 0, 'Worker failure disabled live audio.');
  fallback.dispose();
  console.log('PASS: bounded worker requests, native packet ownership, stale result rejection, shutdown and fallback.');
} finally {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
}
