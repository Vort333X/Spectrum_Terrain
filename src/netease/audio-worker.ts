import { BANDS } from '../shared/audio';
import { PcmSpectrum } from './pcm-spectrum';

type Request =
  | { type: 'pcm'; bytes: Uint8Array; pts?: number }
  | { type: 'sample'; id: number; steps: number }
  | { type: 'reset' };

const audio = new PcmSpectrum();
const levels = new Float32Array(BANDS);
type Channel = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};
let channel = self as unknown as Channel;

function handleRequest({ data }: MessageEvent<Request>) {
  if (data.type === 'pcm') audio.push(data.bytes, data.pts);
  if (data.type === 'reset') audio.reset();
  if (data.type === 'sample') {
    audio.sample(levels, data.steps);
    channel.postMessage({ type: 'spectrum', id: data.id, levels });
  }
}

self.onmessage = (event: MessageEvent) => {
  if (event.data?.type === 'connect' && event.ports.length === 1) {
    channel = event.ports[0];
    channel.onmessage = handleRequest;
    channel.postMessage({ type: 'ready' });
  } else {
    handleRequest(event);
  }
};
channel.postMessage({ type: 'ready' });
