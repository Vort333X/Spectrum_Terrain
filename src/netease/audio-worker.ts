import { BANDS } from '../shared/audio';
import { PcmSpectrum } from './pcm-spectrum';

type Request =
  | { type: 'pcm'; bytes: Uint8Array; pts?: number }
  | { type: 'sample'; id: number; steps: number }
  | { type: 'reset' };

const audio = new PcmSpectrum();
const levels = new Float32Array(BANDS);
const channel = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

channel.onmessage = ({ data }) => {
  if (data.type === 'pcm') audio.push(data.bytes, data.pts);
  if (data.type === 'reset') audio.reset();
  if (data.type === 'sample') {
    audio.sample(levels, data.steps);
    channel.postMessage({ type: 'spectrum', id: data.id, levels });
  }
};
channel.postMessage({ type: 'ready' });
