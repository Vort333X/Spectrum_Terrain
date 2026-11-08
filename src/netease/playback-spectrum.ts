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
  private workerKind: 'blob' | 'data' = 'blob';
  private workerReady = false;
  private failure = '';

  constructor() {
    this.startWorker('blob');
  }

  private startWorker(kind: 'blob' | 'data') {
    this.worker?.terminate();
    this.worker = undefined;
    this.releaseStartup();
    this.workerKind = kind;
    this.workerReady = false;
    this.requestId++;
    this.pending = false;
    this.pendingSteps = 0;
    try {
      // CEF custom-scheme pages may reject blob workers. A self-contained data
      // worker also has an opaque origin and needs no remote script or server.
      const url = kind === 'data'
        ? `data:text/javascript;charset=utf-8,${encodeURIComponent(AUDIO_WORKER_SOURCE)}`
        : (this.workerUrl = URL.createObjectURL(new Blob([AUDIO_WORKER_SOURCE], { type: 'text/javascript' })));
      const worker = new Worker(url);
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.closed || this.worker !== worker) return;
        if (data.type === 'ready') {
          this.workerReady = true;
          this.releaseStartup();
        }
        if (data.type === 'spectrum' && data.id === this.requestId) {
          this.pending = false;
          this.levels.set(data.levels);
        }
      };
      worker.onerror = (event) => {
        if (this.closed || this.worker !== worker) return;
        event.preventDefault();
        this.workerFailed(event.message || 'Worker 加载失败');
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.workerFailed('Worker 消息无法解码');
      };
      this.startupTimer = window.setTimeout(() => {
        if (this.worker === worker) this.workerFailed('Worker 启动超时');
      }, 1500);
      if (this.lastBytes) this.sendPcm(this.lastBytes, this.lastPts);
    } catch (error) {
      this.workerFailed(error instanceof Error ? error.message : String(error));
    }
  }

  get active() {
    return !this.closed && performance.now() - this.lastPacket < 600;
  }

  get mode() {
    return this.worker ? this.workerReady ? '后台线程' : '启动中' : '兼容方式';
  }

  get diagnostic() {
    return this.failure;
  }

  push(bytes: Uint8Array, pts?: number) {
    if (this.closed || bytes.length < 4 || bytes.length % 4) return;
    if (performance.now() - this.lastPacket > 1000) this.levels.fill(0);
    this.lastPacket = performance.now();
    this.lastBytes = bytes;
    this.lastPts = pts;
    if (this.worker) {
      this.sendPcm(bytes, pts);
    } else {
      this.fallback!.push(bytes, pts);
    }
  }

  sample(target: Float32Array) {
    if (this.closed || !this.active) {
      target.fill(0);
      return;
    }
    if (this.pending && performance.now() - this.requestedAt > 1000) this.workerFailed('Worker 分析响应超时');
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
      } catch (error) {
        this.workerFailed(error instanceof Error ? error.message : String(error));
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
      } catch (error) {
        this.workerFailed(error instanceof Error ? error.message : String(error));
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

  private sendPcm(bytes: Uint8Array, pts?: number) {
    // Native lyric effects may retain the original packet. Transfer a copy.
    const copy = bytes.slice();
    try {
      this.worker!.postMessage({ type: 'pcm', bytes: copy, pts }, [copy.buffer]);
    } catch (error) {
      this.workerFailed(error instanceof Error ? error.message : String(error));
    }
  }

  private workerFailed(reason: string) {
    if (this.closed || this.fallback) return;
    this.failure = `${this.workerKind}: ${reason}`;
    console.warn('[SpectrumTerrain] 后台分析', this.failure);
    if (this.workerKind === 'blob') {
      this.startWorker('data');
      return;
    }
    this.useFallback();
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
