import { BANDS } from '../shared/audio';
import { PcmSpectrum } from './pcm-spectrum';

declare const AUDIO_WORKER_SOURCE: string;

export class PlaybackSpectrum {
  private worker?: Worker;
  private fallback?: PcmSpectrum;
  private readonly levels = new Float32Array(BANDS);
  private workerUrl?: string;
  private startupTimer = 0;
  private requestId = 0;
  private pending = false;
  private pendingSteps = 0;
  private requestedAt = 0;
  private lastPacket = -Infinity;
  private lastBytes?: Uint8Array;
  private lastPts?: number;
  private closed = false;

  constructor() {
    try {
      this.workerUrl = URL.createObjectURL(new Blob([AUDIO_WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(this.workerUrl);
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.closed || this.worker !== worker) return;
        if (data.type === 'ready') this.releaseStartup();
        if (data.type === 'spectrum' && data.id === this.requestId) {
          this.pending = false;
          this.levels.set(data.levels);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.useFallback();
      };
      worker.onmessageerror = () => this.useFallback();
      this.startupTimer = window.setTimeout(() => this.useFallback(), 1500);
    } catch {
      this.useFallback();
    }
  }

  get active() {
    return !this.closed && performance.now() - this.lastPacket < 600;
  }

  get mode() {
    return this.worker ? '后台线程' : '兼容方式';
  }

  push(bytes: Uint8Array, pts?: number) {
    if (this.closed || bytes.length < 4 || bytes.length % 4) return;
    if (performance.now() - this.lastPacket > 1000) this.levels.fill(0);
    this.lastPacket = performance.now();
    this.lastBytes = bytes;
    this.lastPts = pts;
    if (this.worker) {
      // Native lyric effects may retain the original packet. Transfer a copy.
      const copy = bytes.slice();
      try {
        this.worker.postMessage({ type: 'pcm', bytes: copy, pts }, [copy.buffer]);
      } catch {
        this.useFallback();
      }
    } else {
      this.fallback!.push(bytes, pts);
    }
  }

  sample(target: Float32Array) {
    if (this.closed || !this.active) {
      target.fill(0);
      return;
    }
    if (this.pending && performance.now() - this.requestedAt > 1000) this.useFallback();
    if (this.fallback) {
      this.fallback.sample(target);
      return;
    }
    target.set(this.levels);
    this.pendingSteps = Math.min(4, this.pendingSteps + 1);
    if (!this.pending) {
      this.pending = true;
      this.requestedAt = performance.now();
      try {
        this.worker!.postMessage({ type: 'sample', id: ++this.requestId, steps: this.pendingSteps });
        this.pendingSteps = 0;
      } catch {
        this.useFallback();
      }
    }
  }

  reset() {
    this.requestId++;
    this.pending = false;
    this.pendingSteps = 0;
    this.levels.fill(0);
    this.lastBytes = undefined;
    this.lastPts = undefined;
    this.lastPacket = -Infinity;
    this.fallback?.reset();
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'reset' });
      } catch {
        this.useFallback();
      }
    }
  }

  dispose() {
    this.closed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.releaseStartup();
    this.fallback?.reset();
    this.lastBytes = undefined;
  }

  private releaseStartup() {
    clearTimeout(this.startupTimer);
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = undefined;
  }

  private useFallback() {
    if (this.closed || this.fallback) return;
    this.worker?.terminate();
    this.worker = undefined;
    this.releaseStartup();
    this.pending = false;
    this.fallback = new PcmSpectrum();
    if (this.lastBytes) this.fallback.push(this.lastBytes, this.lastPts);
    console.warn('[SpectrumTerrain] 后台分析不可用，已使用兼容分析方式。');
  }
}
