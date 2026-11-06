type AudioCallback = (...args: unknown[]) => void;

interface AudioBridge {
  appendRegisterCall(event: string, scope: string, callback: AudioCallback): boolean;
  removeRegisterCall(event: string, scope: string, callback: AudioCallback): boolean;
  _Adapter: { registerCallMap: Record<string, AudioCallback | AudioCallback[] | undefined> };
}

interface AudioSdk {
  Bridge: AudioBridge;
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
    const id = 'spectrum-terrain-audio-probe';
    // Webpack 4 passes the active runtime to a new module without reloading host modules.
    chunks.push([[], { [id]: (_module: unknown, _exports: unknown, runtime: WebpackCache) => {
      webpack = runtime;
    } }, [[id]]]);
  }
  return Object.values(webpack?.c ?? {}).map(({ exports }) => exports).find((sdk): sdk is AudioSdk =>
    typeof sdk?.AudioPlayer?.setAudioDataEnableState === 'function' &&
    typeof sdk.Bridge?.appendRegisterCall === 'function' &&
    typeof sdk.Bridge.removeRegisterCall === 'function' &&
    !!sdk.Bridge._Adapter?.registerCallMap,
  );
}

interface Packet {
  data?: ArrayBuffer | ArrayBufferView | number[];
  pts?: number;
  [key: string]: unknown;
}

function packetList(args: unknown[]) {
  const value = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return value.filter((packet): packet is Packet => !!packet && typeof packet === 'object' && 'data' in packet);
}

export function probeAudio(report: (status: string) => void) {
  const sdk = getAudioSdk();
  if (!sdk) {
    report('未找到客户端音频接口');
    return;
  }
  const { Bridge: bridge, AudioPlayer: player } = sdk;
  const hasListener = () => {
    const callbacks = bridge._Adapter.registerCallMap['audioplayer.onAudioData'];
    return Array.isArray(callbacks) ? callbacks.length > 0 : !!callbacks;
  };
  const ownsEnable = !hasListener();
  const sizes = new Set<number>();
  const deltas = new Set<number>();
  const metadata = new Set<string>();
  let lastPts: number | undefined;
  let stopped = false;
  let count = 0;
  let timer = 0;

  function receive(...args: unknown[]) {
    for (const packet of packetList(args)) {
      const data = packet.data;
      const size = Array.isArray(data) ? data.length : data?.byteLength;
      if (!size) continue;
      count++;
      if (sizes.size < 4) sizes.add(size);
      if (typeof packet.pts === 'number' && Number.isFinite(packet.pts)) {
        if (lastPts !== undefined && packet.pts > lastPts && deltas.size < 4) {
          deltas.add(Number((packet.pts - lastPts).toFixed(3)));
        }
        lastPts = packet.pts;
      }
      for (const key of ['sampleRate', 'sample_rate', 'channels', 'channelCount', 'channel_count', 'format', 'sampleFormat', 'sample_fmt']) {
        const value = packet[key];
        if (typeof value === 'number' || (typeof value === 'string' && /^[\w-]{1,20}$/.test(value))) {
          metadata.add(`${key}=${value}`);
        }
      }
    }
    if (count >= 12) {
      const format = metadata.size ? [...metadata].join(' ') : '无格式字段';
      finish(`${count} 包 · ${[...sizes].join('/')} B · PTS 间隔 ${[...deltas].join('/') || '未知'} · ${format}`);
    }
  }

  function finish(status?: string) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    bridge.removeRegisterCall('AudioData', 'audioplayer', receive);
    if (ownsEnable && !hasListener()) void player.setAudioDataEnableState(false).catch(console.warn);
    if (status) report(status);
  }

  bridge.appendRegisterCall('AudioData', 'audioplayer', receive);
  timer = window.setTimeout(() => finish(`收到 ${count} 个音频包。请保持歌曲播放后重试。`), 6000);
  if (ownsEnable) {
    void player.setAudioDataEnableState(true).catch(() => finish('客户端未能开启音频数据'));
  }
  return finish;
}
