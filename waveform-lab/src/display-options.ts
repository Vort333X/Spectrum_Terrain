export const SHAPES = {
  bars: { label: '离散频率柱', hint: '独立频段柱体，保留 2.5 秒历史。调整柱数和间隙可以改变颗粒感。' },
  terrain: { label: '连续地形 · 原版', hint: '原版连续曲面与前沿亮线，用于对比新样式。' },
  ridges: { label: '层叠光带', hint: '用 32 层独立曲线展现频谱历史，保留黑色留白和纵深。' },
} as const;

export const APPEARANCES = {
  glass: '柔光透明',
  solid: '实体渐变',
  neon: '霓虹边缘',
} as const;

export interface DisplayOptions {
  shape: keyof typeof SHAPES;
  appearance: keyof typeof APPEARANCES;
  columns: 32 | 64 | 128;
  gap: number;
}

export const DISPLAY_STORAGE_KEY = 'spectrum-terrain-lab-display';
export const DEFAULT_DISPLAY: DisplayOptions = { shape: 'bars', appearance: 'glass', columns: 64, gap: 28 };

export function readDisplayOptions(value: unknown): DisplayOptions {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    shape: typeof stored.shape === 'string' && Object.prototype.hasOwnProperty.call(SHAPES, stored.shape)
      ? stored.shape as DisplayOptions['shape'] : DEFAULT_DISPLAY.shape,
    appearance: typeof stored.appearance === 'string' && Object.prototype.hasOwnProperty.call(APPEARANCES, stored.appearance)
      ? stored.appearance as DisplayOptions['appearance'] : DEFAULT_DISPLAY.appearance,
    columns: stored.columns === 32 || stored.columns === 64 || stored.columns === 128 ? stored.columns : DEFAULT_DISPLAY.columns,
    gap: typeof stored.gap === 'number' && Number.isFinite(stored.gap)
      ? Math.min(65, Math.max(5, stored.gap)) : DEFAULT_DISPLAY.gap,
  };
}
