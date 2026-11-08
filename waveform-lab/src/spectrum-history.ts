import { BANDS, HISTORY_ROWS } from './audio';
import type { Terrain } from './terrain';

type SpectrumSampler = (time: number, levels: Float32Array) => void;

export class SpectrumHistory {
  private readonly step: number;
  private readonly target = new Float32Array(BANDS);
  private readonly smoothed = new Float32Array(BANDS);
  private head = 0;
  private time = 0;
  private carry = 0;

  constructor(private terrain: Pick<Terrain, 'replaceHistory' | 'pushRow'>, sampleRate: number) {
    this.step = 1 / sampleRate;
  }

  reset(seed?: SpectrumSampler, time = 0) {
    this.head = 0;
    this.time = time;
    this.carry = 0;
    this.smoothed.fill(0);
    const rows = new Float32Array(HISTORY_ROWS * BANDS);
    if (seed) {
      for (let row = 0; row < HISTORY_ROWS; row++) {
        seed(time - row * this.step, this.target);
        rows.set(this.target, row * BANDS);
      }
      this.smoothed.set(rows.subarray(0, BANDS));
    }
    this.terrain.replaceHistory(rows);
  }

  advance(delta: number, sample: SpectrumSampler, maxSamples = Infinity) {
    this.carry += delta;
    let remaining = Math.floor(this.carry / this.step);
    let first = true;
    while (this.carry >= this.step) {
      // Missing display frames cannot recover old live audio. Reuse the current
      // profile for older rows and reserve fresh analysis for the newest rows.
      if (first || remaining < maxSamples) sample(this.time, this.target);
      first = false;
      remaining--;
      for (let band = 0; band < BANDS; band++) {
        const value = this.target[band];
        const response = value > this.smoothed[band] ? 0.90 : 0.50;
        this.smoothed[band] += (value - this.smoothed[band]) * response;
      }
      this.head = (this.head + HISTORY_ROWS - 1) % HISTORY_ROWS;
      this.terrain.pushRow(this.head, this.smoothed);
      this.time += this.step;
      this.carry -= this.step;
    }
  }

  get phase() {
    return this.carry / this.step;
  }
}
