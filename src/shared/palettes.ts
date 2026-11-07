interface PalettePreset {
  label: string;
  colors: readonly [string, string, string];
}

export const PALETTES = {
  ember: { label: '紫橙', colors: ['#331655', '#a53680', '#ffb484'] },
  jade: { label: '翡翠绿', colors: ['#103e36', '#40cd98', '#cbffd7'] },
  silver: { label: '银灰', colors: ['#2c2b40', '#7b7e92', '#f8edf5'] },
  ocean: { label: '深海蓝', colors: ['#061841', '#1462ce', '#6ae8ff'] },
  aurora: { label: '极光青', colors: ['#102b46', '#24bdad', '#d4b8ff'] },
  lava: { label: '熔岩红', colors: ['#380a13', '#ce2926', '#ff9a4b'] },
  amber: { label: '琥珀金', colors: ['#392106', '#cf8d16', '#fff0a3'] },
  neon: { label: '霓虹粉', colors: ['#3a0b2b', '#d74092', '#ffb5df'] },
  violet: { label: '电光紫', colors: ['#211246', '#7047df', '#bec1ff'] },
} as const satisfies Record<string, PalettePreset>;

export type Palette = keyof typeof PALETTES;
export const DEFAULT_PALETTE: Palette = 'jade';

export function isPalette(value: unknown): value is Palette {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PALETTES, value);
}
