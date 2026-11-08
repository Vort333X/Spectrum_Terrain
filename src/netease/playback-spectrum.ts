import { BANDS } from '../shared/audio';
import { PcmSpectrum } from './pcm-spectrum';
import { LocalAudioWorker, type AnalysisWorker } from './local-audio-worker';

declare const AUDIO_WORKER_SOURCE: string;

export function summarizeWorkerError(reason: string) {
  return reason.replace(/data:[^\s'"<>]+/g, 'data:[内嵌脚本]');
}

export class PlaybackSpectrum {
  private worker?: AnalysisWorker;
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
  private workerKind: 'blob' | 'data' | 'local' = 'blob';
  private workerReady = false;
  private readonly failures: string[] = [];

  constructor() {
    this.startWorker('blob');
  }

  private startWorker(kind: 'blob' | 'data' | 'local') {
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
      const worker = kind === 'local' ? new LocalAudioWorker() : new Worker(kind === 'data'
        ? `data:text/javascript;charset=utf-8,${encodeURIComponent(AUDIO_WORKER_SOURCE)}`
        : (this.workerUrl = URL.createObjectURL(new Blob([AUDIO_WORKER_SOURCE], { type: 'text/javascript' }))));
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.closed || this.worker !== worker) return;
        if (data.type === 'ready') {
          this.workerReady = true;
          this.requestedAt = performance.now();
          this.releaseStartup();
          if (this.lastBytes) this.sendPcm(this.lastBytes, this.lastPts);
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
      }, kind === 'local' ? 5000 : 1500);
    } catch (error) {
      this.workerFailed(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }

  get active() {
    return !this.closed && performance.now() - this.lastPacket < 600;
  }

  get mode() {
    return this.worker ? this.workerReady ? '后台线程' : '启动中' : '兼容方式';
  }

  get diagnostic() {
    const status = this.workerReady && this.workerKind === 'local' ? '已通过本机 HTTP 宿主启动后台线程。\n' : '';
    return status + this.failures.join('\n');
  }

  push(bytes: Uint8Array, pts?: number) {
    if (this.closed || bytes.length < 4 || bytes.length % 4) return;
    if (performance.now() - this.lastPacket > 1000) this.levels.fill(0);
    this.lastPacket = performance.now();
    this.lastBytes = bytes;
    this.lastPts = pts;
    if (this.worker) {
      if (this.workerReady) this.sendPcm(bytes, pts);
    } else {
      this.fallback!.push(bytes, pts);
    }
  }

  sample(target: Float32Array) {
    if (this.closed || !this.active) {
      target.fill(0);
      return;
    }
    if (this.workerReady && this.pending && performance.now() - this.requestedAt > 1000) this.workerFailed('Worker 分析响应超时');
    if (this.fallback) {
      this.fallback.sample(target);
      return;
    }
    target.set(this.levels);
    if (!this.workerReady) return;
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
    if (this.worker && this.workerReady) {
      try {
        this.worker.postMessage({ type: 'reset' });
      } catch (error) {
        this.workerFailed(error instanceof Error ? error.message : String(error));
      }
    }
  }

  dispose() {
    this.closed = true;
    this.workerReady = false;
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
    const failure = `${this.workerKind}: ${summarizeWorkerError(reason)}`;
    this.failures.push(failure);
    console.warn('[SpectrumTerrain] 后台分析', failure);
    if (this.workerKind === 'blob') {
      this.startWorker('data');
      return;
    }
    if (this.workerKind === 'data') {
      this.startWorker('local');
      return;
    }
    this.useFallback();
  }

  private useFallback() {
    if (this.closed || this.fallback) return;
    this.worker?.terminate();
    this.worker = undefined;
    this.workerReady = false;
    this.releaseStartup();
    this.pending = false;
    this.fallback = new PcmSpectrum();
    if (this.lastBytes) this.fallback.push(this.lastBytes, this.lastPts);
    console.warn('[SpectrumTerrain] 后台分析不可用，已使用兼容分析方式。');
  }
}
