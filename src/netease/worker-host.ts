// Only bootstrap the worker here. PCM travels directly over the transferred
// MessagePort, rather than being forwarded on this iframe's interface thread.
let worker: Worker | undefined;

window.addEventListener('message', (event) => {
  if (worker || event.source !== parent || event.data?.type !== 'spectrum-terrain-connect' || event.ports.length !== 1) return;
  const reportError = (message: string) => parent.postMessage({ type: 'spectrum-terrain-worker-error', message }, '*');
  try {
    worker = new Worker('./audio-worker.js');
    worker.onerror = (error) => {
      error.preventDefault();
      reportError(error.message || '本地 Worker 加载失败');
    };
    worker.onmessageerror = () => reportError('本地 Worker 消息无法解码');
    worker.postMessage({ type: 'connect' }, [event.ports[0]]);
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }
});

window.addEventListener('pagehide', () => worker?.terminate(), { once: true });

export {};
