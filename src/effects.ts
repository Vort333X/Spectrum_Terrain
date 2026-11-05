export interface EffectSettings {
  axes: boolean;
  opacity: number;
  trail: number;
  glow: number;
  radius: number;
  gain: number;
  orbitspeed: number;
}

const STORAGE_KEY = 'spectrum-terrain-effects';

export function bindEffects(form: HTMLFormElement, apply: (settings: EffectSettings) => void, persist: boolean) {
  const fields = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-effect]'));

  function update() {
    const values = fields.map((field) => {
      const value = field.type === 'checkbox' ? field.checked : field.valueAsNumber;
      const output = field.labels?.[0]?.querySelector('.effect-value');
      if (output) output.textContent = field.value + (field.dataset.unit ?? '');
      return [field.name, value];
    });
    const settings = Object.fromEntries(values) as EffectSettings;
    apply(settings);
    return settings;
  }

  function setValues(values: Record<string, unknown>) {
    for (const field of fields) {
      const value = values[field.name];
      if (field.type === 'checkbox' && typeof value === 'boolean') field.checked = value;
      if (field.type === 'range' && typeof value === 'number' && Number.isFinite(value)) field.valueAsNumber = value;
    }
    update();
  }

  function save() {
    const settings = update();
    if (!persist) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // The controls still work when storage is disabled.
    }
  }

  for (const field of fields) field.addEventListener('input', save);
  form.addEventListener('reset', (event) => {
    event.preventDefault();
    for (const field of fields) {
      if (field.type === 'checkbox') field.checked = field.defaultChecked;
      else field.value = field.defaultValue;
    }
    save();
  });

  let stored: unknown;
  if (persist) {
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      // Start with the defaults when storage is unavailable or invalid.
    }
  }
  if (stored && typeof stored === 'object') {
    setValues(stored as Record<string, unknown>);
  } else {
    update();
  }
  return setValues;
}
