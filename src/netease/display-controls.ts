import { APPEARANCES, DEFAULT_DISPLAY, readDisplayOptions, SHAPES, type DisplayOptions } from '../shared/display-options';
import type { Terrain } from '../shared/terrain';

export const DISPLAY_STORAGE_KEY = 'spectrum-terrain-netease-display';

export function bindDisplayControls(root: HTMLElement, terrain: Pick<Terrain, 'setDisplay'>) {
  const shape = root.querySelector<HTMLSelectElement>('[data-shape]')!;
  const appearance = root.querySelector<HTMLSelectElement>('[data-appearance]')!;
  const columns = root.querySelector<HTMLSelectElement>('[data-columns]')!;
  const gap = root.querySelector<HTMLInputElement>('[data-gap]')!;
  const gapValue = root.querySelector<HTMLOutputElement>('[data-gap-value]')!;
  const bandControls = root.querySelector<HTMLElement>('[data-band-controls]')!;
  const columnsLabel = root.querySelector<HTMLElement>('[data-columns-label]')!;
  const gapLabel = root.querySelector<HTMLElement>('[data-gap-label]')!;
  const hint = root.querySelector<HTMLElement>('[data-shape-hint]')!;
  for (const key of ['terrain', 'bars', 'fins', 'ridges'] as const) shape.add(new Option(SHAPES[key].label, key));
  for (const [key, label] of Object.entries(APPEARANCES)) appearance.add(new Option(label, key));

  function apply(options: DisplayOptions, persist: boolean) {
    shape.value = options.shape;
    appearance.value = options.appearance;
    columns.value = String(options.columns);
    gap.value = String(options.gap);
    gapValue.value = `${options.gap}%`;
    const fins = options.shape === 'fins';
    bandControls.hidden = options.shape !== 'bars' && !fins;
    columnsLabel.textContent = fins ? '鳍片数量' : '柱体数量';
    gapLabel.textContent = fins ? '片间缝隙' : '柱体间隙';
    for (const option of Array.from(columns.options)) option.textContent = `${option.value} ${fins ? '片' : '柱'}`;
    hint.textContent = SHAPES[options.shape].hint;
    terrain.setDisplay(options);
    if (persist) {
      try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(options)); } catch { /* Works without storage. */ }
    }
  }

  function update() {
    apply(readDisplayOptions({
      shape: shape.value, appearance: appearance.value, columns: Number(columns.value), gap: gap.valueAsNumber,
    }), true);
  }

  for (const input of [shape, appearance, columns]) input.addEventListener('change', update);
  gap.addEventListener('input', update);
  root.querySelector('[data-reset-display]')!.addEventListener('click', () => apply(DEFAULT_DISPLAY, true));
  let stored: unknown;
  try { stored = JSON.parse(localStorage.getItem(DISPLAY_STORAGE_KEY) ?? 'null'); } catch { /* Start with defaults. */ }
  apply(readDisplayOptions(stored), false);
}
