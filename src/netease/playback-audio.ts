type AudioCallback = (...args: unknown[]) => void;

interface AudioAdapter {
  registerCallAdapter(event: string, callback: AudioCallback, scope?: string): void;
  registerCallMap: Record<string, AudioCallback | AudioCallback[] | undefined>;
  _registerCallQueue(event: string): AudioCallback;
}

interface AudioSdk {
  Bridge: { _Adapter: AudioAdapter };
  AudioPlayer: { setAudioDataEnableState(enabled: boolean): Promise<unknown> };
}

interface WebpackCache {
  c: Record<string, { exports?: Partial<AudioSdk> }>;
}

let webpack: WebpackCache | undefined;

function getAudioSdk() {
  if (!webpack) {
    const chunks = (window as Window & { webpackJsonp?: unknown[] }).webpackJsonp;
    if (!chunks || chunks.push === Array.prototype.push) return;
    const id = 'spectrum-terrain-playback-audio';
    // Webpack 4 passes the active runtime to a new module without reloading host modules.
    chunks.push([[], { [id]: (_module: unknown, _exports: unknown, runtime: WebpackCache) => {
      webpack = runtime;
    } }, [[id]]]);
  }
  return Object.values(webpack?.c ?? {}).map(({ exports }) => exports).find((sdk): sdk is AudioSdk =>
    typeof sdk?.AudioPlayer?.setAudioDataEnableState === 'function' &&
    typeof sdk.Bridge?._Adapter?.registerCallAdapter === 'function' &&
    typeof sdk.Bridge._Adapter._registerCallQueue === 'function' &&
    !!sdk.Bridge._Adapter?.registerCallMap,
  );
}

function packetBytes(data: unknown) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
}

export function listenToPlayback(push: (bytes: Uint8Array, pts?: number) => void, onError: () => void) {
  const sdk = getAudioSdk();
  if (!sdk) return;
  const adapter = sdk.Bridge._Adapter;
  const player = sdk.AudioPlayer;
  const event = 'audioplayer.onAudioData';
  const register = adapter.registerCallAdapter;
  const forward = adapter._registerCallQueue(event);
  const setEnabled = player.setAudioDataEnableState;
  const callbacks = adapter.registerCallMap[event];
  let hostEnabled = Array.isArray(callbacks) ? callbacks.length > 0 : !!callbacks;
  let consume: typeof push | undefined = push;
  let stopped = false;

  function dispatch(...args: unknown[]) {
    forward(...args);
    if (!consume) return;
    const packets = args.length === 1 && Array.isArray(args[0]) ? args[0] as unknown[] : args;
    for (const packet of packets) {
      if (!packet || typeof packet !== 'object' || !('data' in packet)) continue;
      const bytes = packetBytes(packet.data);
      const pts = 'pts' in packet && typeof packet.pts === 'number' && Number.isFinite(packet.pts) ? packet.pts : undefined;
      if (bytes) consume(bytes, pts);
    }
  }

  function registerWithTap(this: AudioAdapter, name: string, callback: AudioCallback, scope?: string) {
    register.call(this, name, name === event ? dispatch : callback, scope);
  }

  function keepEnabled(this: AudioSdk['AudioPlayer'], enabled: boolean) {
    hostEnabled = enabled;
    return enabled ? setEnabled.call(this, true) : Promise.resolve(true);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    consume = undefined;
    if (adapter.registerCallAdapter === registerWithTap) {
      adapter.registerCallAdapter = register;
      try {
        register.call(adapter, event, forward, 'websdk');
      } catch (error) {
        console.warn('[SpectrumTerrain] 无法恢复客户端音频回调', error);
      }
    }
    if (player.setAudioDataEnableState === keepEnabled) {
      player.setAudioDataEnableState = setEnabled;
      if (!hostEnabled) void setEnabled.call(player, false).catch(console.warn);
    }
  }

  // The native event has one registration slot. Keep the host callback map intact
  // so built-in lyric effects can still register and unregister independently.
  adapter.registerCallAdapter = registerWithTap;
  player.setAudioDataEnableState = keepEnabled;
  try {
    register.call(adapter, event, dispatch, 'websdk');
    void setEnabled.call(player, true).catch(() => {
      if (stopped) return;
      stop();
      onError();
    });
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
