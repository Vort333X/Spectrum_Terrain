import { FFT_SIZE, frequencyRanges, readSpectrumBands, SAMPLES_PER_SECOND } from '../audio';

// The client's lyric effects consume interleaved signed 16-bit stereo PCM at 48 kHz.
const SAMPLE_RATE = 48_000;
const FRAMES_PER_ROW = SAMPLE_RATE / SAMPLES_PER_SECOND;
const BUFFER_FRAMES = FRAMES_PER_ROW * 6;
const RING_SIZE = FFT_SIZE * 4;
const RING_MASK = RING_SIZE - 1;
const IDLE_MS = 240;

export class PcmSpectrum {
  private readonly ring = new Float32Array(RING_SIZE);
  private readonly real = new Float32Array(FFT_SIZE);
  private readonly imaginary = new Float32Array(FFT_SIZE);
  private readonly reversed = new Uint16Array(FFT_SIZE);
  private readonly window = new Float32Array(FFT_SIZE);
  private readonly cosine = new Float32Array(FFT_SIZE / 2);
  private readonly sine = new Float32Array(FFT_SIZE / 2);
  private readonly bins = new Float32Array(FFT_SIZE / 2);
  private readonly ranges = frequencyRanges(SAMPLE_RATE);
  private readonly lastBin = this.ranges[this.ranges.length - 1].end;
  private written = 0;
  private cursor = 0;
  private analysed = -1;
  private primed = false;
  private lastPacket = -Infinity;
  private lastPts?: number;

  constructor() {
    for (let index = 0; index < FFT_SIZE; index++) {
      this.reversed[index] = (this.reversed[index >> 1] >> 1) | ((index & 1) * (FFT_SIZE / 2));
      const phase = 2 * Math.PI * index / FFT_SIZE;
      this.window[index] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
      if (index < FFT_SIZE / 2) {
        this.cosine[index] = Math.cos(phase);
        this.sine[index] = -Math.sin(phase);
      }
    }
  }

  get active() {
    return performance.now() - this.lastPacket < IDLE_MS;
  }

  reset() {
    this.written = this.cursor = 0;
    this.analysed = -1;
    this.primed = false;
    this.lastPacket = -Infinity;
    this.lastPts = undefined;
  }

  push(bytes: Uint8Array, pts?: number) {
    if (bytes.length < 4 || bytes.length % 4 !== 0) return;
    const jump = pts !== undefined && this.lastPts !== undefined ? pts - this.lastPts : 0;
    if (!this.active || jump < -80 || jump > 400) this.reset();
    this.lastPacket = performance.now();
    this.lastPts = pts;
    const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let byte = 0; byte < pcm.byteLength; byte += 4) {
      const left = pcm.getInt16(byte, true);
      const right = pcm.getInt16(byte + 2, true);
      this.ring[this.written++ & RING_MASK] = (left + right) / 65_536;
    }
  }

  sample(target: Float32Array) {
    const queued = this.written - this.cursor;
    if (!this.active || (!this.primed && queued < BUFFER_FRAMES)) {
      target.fill(0);
      return;
    }
    this.primed = true;
    // Keep the 60 Hz history moving between the client's batched audio callbacks.
    if (queued > 2 * BUFFER_FRAMES) this.cursor = this.written - BUFFER_FRAMES;
    this.cursor = Math.min(this.written, this.cursor + FRAMES_PER_ROW);
    if (this.cursor !== this.analysed) this.transform();
    readSpectrumBands(this.bins, this.ranges, target);
  }

  private transform() {
    const start = this.cursor - FFT_SIZE;
    const oldest = Math.max(0, this.written - RING_SIZE);
    for (let index = 0; index < FFT_SIZE; index++) {
      const source = start + index;
      this.real[this.reversed[index]] = source < oldest ? 0 : this.ring[source & RING_MASK] * this.window[index];
    }
    this.imaginary.fill(0);
    for (let length = 2; length <= FFT_SIZE; length *= 2) {
      const half = length / 2;
      const stride = FFT_SIZE / length;
      for (let base = 0; base < FFT_SIZE; base += length) {
        for (let offset = 0; offset < half; offset++) {
          const even = base + offset;
          const odd = even + half;
          const angle = offset * stride;
          const real = this.cosine[angle] * this.real[odd] - this.sine[angle] * this.imaginary[odd];
          const imaginary = this.cosine[angle] * this.imaginary[odd] + this.sine[angle] * this.real[odd];
          this.real[odd] = this.real[even] - real;
          this.imaginary[odd] = this.imaginary[even] - imaginary;
          this.real[even] += real;
          this.imaginary[even] += imaginary;
        }
      }
    }
    for (let bin = 0; bin < this.lastBin; bin++) {
      const power = this.real[bin] ** 2 + this.imaginary[bin] ** 2;
      this.bins[bin] = 10 * Math.log10(Math.max(1e-20, power / (FFT_SIZE * FFT_SIZE)));
    }
    this.analysed = this.cursor;
  }
}
