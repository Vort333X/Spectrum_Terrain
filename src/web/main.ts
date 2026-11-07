import { BANDS, SAMPLES_PER_SECOND, SystemAudioMonitor, testSpectrum, WALLPAPER_BANDS, type TestSignal } from '../shared/audio';
import { Terrain } from '../shared/terrain';
import { DEFAULT_PALETTE, isPalette, PALETTES, type Palette } from '../shared/palettes';
import { bindEffects } from '../shared/effects';
import { SpectrumHistory } from '../shared/spectrum-history';

declare global {
  interface Window {
    wallpaperRegisterAudioListener?: (listener: (levels: number[]) => void) => void;
    wallpaperPropertyListener?: {
      applyUserProperties(properties: Record<string, { value: unknown }>): void;
    };
  }
}

const WALLPAPER_SAMPLE_RATE = 30;

function start() {
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const monitorButton = document.querySelector<HTMLButtonElement>('#monitor')!;
  const monitorLabel = document.querySelector<HTMLElement>('#monitor-label')!;
  const monitorHint = document.querySelector<HTMLElement>('#monitor-hint')!;
  const fpsLabel = document.querySelector<HTMLElement>('#fps')!;
  const sourceLabel = document.querySelector<HTMLElement>('#source')!;
  const audio = new SystemAudioMonitor();
  const signalSelect = document.querySelector<HTMLSelectElement>('#test-signal')!;
  const freeze = document.querySelector<HTMLInputElement>('#freeze')!;
  const effects = document.querySelector<HTMLFormElement>('#effects')!;
  const captureHelp = monitorHint.textContent!;
  const orbit = document.querySelector<HTMLButtonElement>('#orbit')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset')!;
  const isWallpaper = typeof window.wallpaperRegisterAudioListener === 'function';

  if (isWallpaper) document.body.dataset.mode = 'wallpaper';

  const sampleRate = isWallpaper ? WALLPAPER_SAMPLE_RATE : SAMPLES_PER_SECOND;
  const terrain = new Terrain(stage, sampleRate, isWallpaper);
  const history = new SpectrumHistory(terrain, sampleRate);
  const setEffects = bindEffects(effects, (settings) => terrain.applyEffects(settings), !isWallpaper);
  const systemBands = new Float32Array(WALLPAPER_BANDS);
  let mode: 'demo' | 'capture' | 'wallpaper' = isWallpaper ? 'wallpaper' : 'demo';
  let signal: TestSignal = 'demo';

  function resetHistory() {
    freeze.checked = false;
    history.reset(mode === 'demo' ? sample : undefined);
  }

  function sample(age: number, target: Float32Array) {
    if (mode === 'demo') testSpectrum(signal, age, target);
    if (mode === 'wallpaper') {
      for (let band = 0; band < BANDS; band++) {
        const index = band * (WALLPAPER_BANDS - 1) / (BANDS - 1);
        const lower = Math.floor(index);
        const upper = Math.min(lower + 1, WALLPAPER_BANDS - 1);
        target[band] = systemBands[lower] + (systemBands[upper] - systemBands[lower]) * (index - lower);
      }
    }
    if (mode === 'capture') audio.sample(target);
  }

  if (isWallpaper) {
    window.wallpaperPropertyListener = {
      applyUserProperties(properties) {
        setEffects(Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.value])));
        const palette = properties.palette?.value;
        if (isPalette(palette)) terrain.setPalette(palette);
      },
    };
    window.wallpaperRegisterAudioListener!((levels) => {
      if (levels.length !== WALLPAPER_BANDS * 2) return;
      for (let index = 0; index < WALLPAPER_BANDS; index++) {
        const left = Math.max(0, Number(levels[index]) || 0);
        const right = Math.max(0, Number(levels[WALLPAPER_BANDS + index]) || 0);
        systemBands[index] = Math.sqrt(Math.min(1, (left + right) * 0.5));
      }
    });
  }

  function returnToDemo(message = captureHelp) {
    audio.stop();
    mode = 'demo';
    terrain.setMaxFrequency(audio.maxFrequency);
    sourceLabel.textContent = signal === 'demo' ? '演示信号' : signalSelect.selectedOptions[0].textContent;
    monitorLabel.textContent = '监听系统音频';
    monitorButton.setAttribute('aria-pressed', 'false');
    monitorHint.textContent = message;
    resetHistory();
  }

  signalSelect.addEventListener('change', () => {
    signal = signalSelect.value as TestSignal;
    returnToDemo();
  });

  monitorButton.addEventListener('click', async () => {
    if (mode === 'capture') {
      returnToDemo();
      return;
    }

    monitorButton.disabled = true;
    signalSelect.disabled = true;
    sourceLabel.textContent = '选择共享来源';
    monitorHint.textContent = captureHelp;

    try {
      await audio.start(() => returnToDemo('共享已结束，可以重新开始监听。'));
      mode = 'capture';
      terrain.setMaxFrequency(audio.maxFrequency);
      sourceLabel.textContent = '共享音频';
      monitorLabel.textContent = '停止监听';
      monitorButton.setAttribute('aria-pressed', 'true');
      monitorHint.textContent = '正在实时分析共享的音频。';
      resetHistory();
    } catch (error) {
      returnToDemo(error instanceof Error ? error.message : '无法开启音频监听。');
    } finally {
      monitorButton.disabled = false;
      signalSelect.disabled = false;
    }
  });

  orbit.setAttribute('aria-pressed', String(terrain.autoRotate));
  orbit.addEventListener('click', () => {
    terrain.autoRotate = !terrain.autoRotate;
    orbit.setAttribute('aria-pressed', String(terrain.autoRotate));
  });
  reset.addEventListener('click', () => terrain.resetCamera());
  if (!isWallpaper) {
    const swatches = document.querySelector<HTMLElement>('.swatches')!;
    let selected: HTMLButtonElement | undefined;

    for (const name of Object.keys(PALETTES) as Palette[]) {
      const { label, colors } = PALETTES[name];
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.dataset.palette = name;
      swatch.textContent = label;
      swatch.style.setProperty('--gradient', `linear-gradient(110deg, ${colors.join(', ')})`);
      swatch.setAttribute('aria-pressed', String(name === DEFAULT_PALETTE));
      if (name === DEFAULT_PALETTE) selected = swatch;
      swatch.addEventListener('click', () => {
        terrain.setPalette(name);
        selected?.setAttribute('aria-pressed', 'false');
        swatch.setAttribute('aria-pressed', 'true');
        selected = swatch;
      });
      swatches.append(swatch);
    }
  }

  resetHistory();
  let last = performance.now();
  let fpsSince = last;
  let renderedFrames = 0;

  function frame(now: number) {
    const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (!freeze.checked) history.advance(delta, sample);
    terrain.render(delta, history.phase);
    if (!isWallpaper) {
      renderedFrames++;
      const elapsed = now - fpsSince;
      if (elapsed >= 1000) {
        fpsLabel.textContent = `${Math.round(renderedFrames * 1000 / elapsed)} FPS`;
        fpsSince = now;
        renderedFrames = 0;
      }
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

try {
  start();
} catch (error) {
  console.error(error);
  document.querySelector<HTMLElement>('#stage-error')!.hidden = false;
}
