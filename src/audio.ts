export const BANDS = 64;
export const SAMPLES_PER_SECOND = 30;
export const HISTORY_ROWS = 120;

const MIN_HZ = 30;
const MAX_HZ = 16_000;
const FFT_SIZE = 8192;
const FLOOR_DB = -85;
const CEILING_DB = -18;

interface Capture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  ranges: { start: number; end: number }[];
}

export class SystemAudioMonitor {
  private capture?: Capture;
  private bins = new Float32Array(FFT_SIZE / 2);

  async start(onEnded: () => void) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('此浏览器无法监听系统音频，请用 Chrome、Edge 或 Wallpaper Engine。');
    }

    const options: DisplayMediaStreamOptions & { systemAudio: 'include' } = {
      video: { displaySurface: 'monitor', frameRate: { ideal: 2 } },
      audio: true,
      systemAudio: 'include',
    };
    const stream = await navigator.mediaDevices.getDisplayMedia(options).catch((error: unknown) => {
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
        throw new Error('未开始共享，可重新选择音频来源。');
      }
      throw new Error('无法开启共享，请检查浏览器和系统权限。');
    });
    let context: AudioContext | undefined;

    try {
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('没有收到音频，请勾选「共享系统音频」后重试。');

      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.38;
      // The video track keeps the browser's share open. Only audio enters the analyser.
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      await context.resume();

      if (track.readyState !== 'live' || !stream.active) throw new Error('共享已结束，请重新开始监听。');
      const hzPerBin = context.sampleRate / FFT_SIZE;
      const topHz = Math.min(MAX_HZ, context.sampleRate / 2);
      const bandBin = (edge: number) => MIN_HZ * (topHz / MIN_HZ) ** (edge / BANDS) / hzPerBin;
      const ranges = Array.from({ length: BANDS }, (_, index) => {
        const start = Math.floor(bandBin(index));
        const end = Math.min(this.bins.length, Math.max(start + 1, Math.ceil(bandBin(index + 1))));
        return { start, end };
      });
      this.capture = { stream, context, source, analyser, ranges };

      for (const sharedTrack of stream.getTracks()) {
        sharedTrack.addEventListener('ended', () => {
          if (this.capture?.stream !== stream) return;
          this.stop();
          onEnded();
        }, { once: true });
      }
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      if (context) void context.close().catch(() => {});
      throw error;
    }
  }

  stop() {
    const capture = this.capture;
    if (!capture) return;

    this.capture = undefined;
    capture.source.disconnect();
    for (const track of capture.stream.getTracks()) track.stop();
    void capture.context.close().catch(() => {});
  }

  sample(target: Float32Array) {
    const capture = this.capture;
    if (!capture) {
      target.fill(0);
      return;
    }

    capture.analyser.getFloatFrequencyData(this.bins);
    for (const [band, range] of capture.ranges.entries()) {
      let peak = FLOOR_DB;
      for (let bin = range.start; bin < range.end; bin++) {
        peak = Math.max(peak, this.bins[bin]);
      }
      target[band] = Math.min(1, (peak - FLOOR_DB) / (CEILING_DB - FLOOR_DB));
    }
  }
}

export function demoSpectrum(time: number, target: Float32Array) {
  const bassCenter = 0.13 + 0.075 * Math.sin(time * 1.23);
  const midCenter = 0.43 + 0.17 * Math.sin(time * 0.72 + 1.2);
  const trebleCenter = 0.77 + 0.105 * Math.cos(time * 0.94);
  const kick = (0.5 + 0.5 * Math.sin(time * Math.PI * 3.6)) ** 3;
  const bassGain = 0.51 + 0.34 * kick + 0.09 * Math.sin(time * 2.2);
  const midGain = 0.29 + 0.28 * (0.5 + 0.5 * Math.sin(time * 2.95 - 0.7));
  const trebleGain = 0.11 + 0.22 * (0.5 + 0.5 * Math.sin(time * 5.2));

  for (let band = 0; band < target.length; band++) {
    const x = band / (target.length - 1);
    const bass = bassGain * Math.exp(-((x - bassCenter) ** 2) / 0.012);
    const mids = midGain * Math.exp(-((x - midCenter) ** 2) / 0.022);
    const treble = trebleGain * Math.exp(-((x - trebleCenter) ** 2) / 0.009);
    const detail = 0.82 + 0.12 * Math.sin(x * 41 - time * 2.8) + 0.06 * Math.cos(x * 89 + time * 3.1);
    target[band] = Math.min(1, (bass + mids + treble) * detail);
  }
}
