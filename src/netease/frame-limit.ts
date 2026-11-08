export const FRAME_LIMIT_KEY = 'spectrum-terrain-netease-fps';
export const DEFAULT_FRAME_LIMIT = 60;

export function normalizeFrameLimit(value: number, fallback = DEFAULT_FRAME_LIMIT) {
  return Number.isFinite(value) ? Math.min(240, Math.max(0, Math.round(value))) : fallback;
}

export class FrameLimit {
  private next?: number;
  private limit = DEFAULT_FRAME_LIMIT;

  set fps(value: number) {
    this.limit = normalizeFrameLimit(value, this.limit);
    this.reset();
  }

  get fps() {
    return this.limit;
  }

  reset() {
    this.next = undefined;
  }

  due(now: number) {
    if (!this.limit) return true;
    const interval = 1000 / this.limit;
    this.next ??= now;
    // rAF timestamps have fractional rounding. Keep the schedule anchored so
    // limiting a 60 Hz display to 60 FPS does not accidentally halve its rate.
    if (now + 0.1 < this.next) return false;
    this.next += Math.max(1, Math.floor((now - this.next + 0.1) / interval) + 1) * interval;
    return true;
  }
}
