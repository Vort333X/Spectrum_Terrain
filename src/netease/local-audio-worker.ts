// BetterNCM provides these globals to injected plugin scripts.
declare const plugin: { pluginPath: string } | undefined;
declare const betterncm: { fs?: { mountDir(path: string): Promise<string> } } | undefined;

export interface AnalysisWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

let mountedAssets: Promise<URL> | undefined;

function mountAssets() {
  const fs = typeof betterncm === 'undefined' ? undefined : betterncm?.fs;
  const path = typeof plugin === 'undefined' ? undefined : plugin?.pluginPath;
  if (!fs?.mountDir || !path) throw new Error('BetterNCM 本地文件挂载接口不可用');
  mountedAssets ??= fs.mountDir(`${path}/worker`).then((address) => {
    const url = new URL(`${address.replace(/\/$/, '')}/index.html`);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('BetterNCM 未返回本机 HTTP 地址');
    }
    return url;
  }).catch((error) => {
    mountedAssets = undefined;
    throw error;
  });
  return mountedAssets;
}

/** Create the Worker in an HTTP document, outside the client's custom scheme. */
export class LocalAudioWorker implements AnalysisWorker {
  onmessage: AnalysisWorker['onmessage'] = null;
  onerror: AnalysisWorker['onerror'] = null;
  onmessageerror: AnalysisWorker['onmessageerror'] = null;
  private readonly channel: MessageChannel;
  private frame?: HTMLIFrameElement;
  private closed = false;
  private origin = '';
  private connected = false;

  constructor() {
    const assets = mountAssets();
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = (event) => this.onmessage?.(event);
    this.channel.port1.onmessageerror = (event) => this.onmessageerror?.(event);
    window.addEventListener('message', this.onHostMessage);
    void assets.then((url) => {
      if (this.closed) return;
      this.origin = url.origin;
      const frame = document.createElement('iframe');
      this.frame = frame;
      frame.hidden = true;
      frame.style.display = 'none';
      frame.dataset.spectrumWorkerHost = '';
      frame.title = 'Spectrum Terrain 音频后台宿主';
      frame.sandbox.add('allow-scripts', 'allow-same-origin');
      frame.onload = () => {
        if (this.closed || this.connected) return;
        try {
          frame.contentWindow?.postMessage({ type: 'spectrum-terrain-connect' }, this.origin, [this.channel.port2]);
          this.connected = true;
        } catch (error) {
          this.reportError(error instanceof Error ? error.message : String(error));
        }
      };
      frame.onerror = () => this.reportError('本地音频宿主加载失败');
      frame.src = url.href;
      document.body.append(frame);
    }).catch((error) => this.reportError(error instanceof Error ? error.message : String(error)));
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    if (this.closed) throw new Error('本地音频后台已关闭');
    this.channel.port1.postMessage(message, transfer);
  }

  terminate() {
    this.closed = true;
    window.removeEventListener('message', this.onHostMessage);
    this.channel.port1.close();
    this.channel.port2.close();
    this.frame?.remove();
    this.frame = undefined;
  }

  private onHostMessage = (event: MessageEvent) => {
    if (event.source === this.frame?.contentWindow && event.origin === this.origin &&
        event.data?.type === 'spectrum-terrain-worker-error') {
      this.reportError(String(event.data.message));
    }
  };

  private reportError(message: string) {
    if (!this.closed) this.onerror?.(new ErrorEvent('error', { message }));
  }
}
