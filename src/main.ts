import { BANDS, demoSpectrum, HISTORY_ROWS, SAMPLES_PER_SECOND, SystemAudioMonitor } from './audio';
import { Terrain, type Palette } from './terrain';

declare global {
  interface Window {
    wallpaperRegisterAudioListener?: (listener: (levels: number[]) => void) => void;
  }
}

const WALLPAPER_SAMPLE_RATE = 30;
const WALLPAPER_BANDS = 64;

function start() {
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const monitorButton = document.querySelector<HTMLButtonElement>('#monitor')!;
  const monitorLabel = document.querySelector<HTMLElement>('#monitor-label')!;
  const monitorHint = document.querySelector<HTMLElement>('#monitor-hint')!;
  const fpsLabel = document.querySelector<HTMLElement>('#fps')!;
  const sourceLabel = document.querySelector<HTMLElement>('#source')!;
  const audio = new SystemAudioMonitor();
  const captureHelp = monitorHint.textContent!;
  const orbit = document.querySelector<HTMLButtonElement>('#orbit')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset')!;
  const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-palette]'));
  const isWallpaper = typeof window.wallpaperRegisterAudioListener === 'function';

  if (isWallpaper) document.body.dataset.mode = 'wallpaper';

  const sampleRate = isWallpaper ? WALLPAPER_SAMPLE_RATE : SAMPLES_PER_SECOND;
  const stepDuration = 1 / sampleRate;
  const terrain = new Terrain(stage, sampleRate);
  const target = new Float32Array(BANDS);
  const smoothed = new Float32Array(BANDS);
  const systemBands = new Float32Array(WALLPAPER_BANDS);
  let mode: 'demo' | 'capture' | 'wallpaper' = isWallpaper ? 'wallpaper' : 'demo';
  let head = 0;
  let age = 0;
  let carry = 0;


  function resetHistory() {
    head = 0;
    age = 0;
    carry = 0;
    smoothed.fill(0);
    const history = new Float32Array(HISTORY_ROWS * BANDS);
    if (mode === 'demo') {
      for (let row = 0; row < HISTORY_ROWS; row++) {
        demoSpectrum(-row * stepDuration, target);
        history.set(target, row * BANDS);
      }
      smoothed.set(history.subarray(0, BANDS));
    }
    terrain.replaceHistory(history);
  }

  function step() {
    if (mode === 'demo') demoSpectrum(age, target);
    if (mode === 'wallpaper') {
      for (let band = 0; band < BANDS; band++) {
        const index = band * (WALLPAPER_BANDS - 1) / (BANDS - 1);
        const lower = Math.floor(index);
        const upper = Math.min(lower + 1, WALLPAPER_BANDS - 1);
        target[band] = systemBands[lower] + (systemBands[upper] - systemBands[lower]) * (index - lower);
      }
    }
    if (mode === 'capture') audio.sample(target);

    for (let index = 0; index < BANDS; index++) {
      const value = target[index];
      const response = value > smoothed[index] ? 0.90 : 0.50;
      smoothed[index] += (value - smoothed[index]) * response;
    }

    head = (head + HISTORY_ROWS - 1) % HISTORY_ROWS;
    terrain.pushRow(head, smoothed);
    age += stepDuration;
  }

  if (isWallpaper) {
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
    sourceLabel.textContent = '演示信号';
    monitorLabel.textContent = '监听系统音频';
    monitorButton.setAttribute('aria-pressed', 'false');
    monitorHint.textContent = message;
    resetHistory();
  }

  monitorButton.addEventListener('click', async () => {
    if (mode === 'capture') {
      returnToDemo();
      return;
    }

    monitorButton.disabled = true;
    sourceLabel.textContent = '选择共享来源';
    monitorHint.textContent = captureHelp;

    try {
      await audio.start(() => returnToDemo('共享已结束，可以重新开始监听。'));
      mode = 'capture';
      sourceLabel.textContent = '共享音频';
      monitorLabel.textContent = '停止监听';
      monitorButton.setAttribute('aria-pressed', 'true');
      monitorHint.textContent = '正在实时分析共享的音频。';
      resetHistory();
    } catch (error) {
      returnToDemo(error instanceof Error ? error.message : '无法开启音频监听。');
    } finally {
      monitorButton.disabled = false;
    }
  });

  orbit.setAttribute('aria-pressed', String(terrain.autoRotate));
  orbit.addEventListener('click', () => {
    terrain.autoRotate = !terrain.autoRotate;
    orbit.setAttribute('aria-pressed', String(terrain.autoRotate));
  });
  reset.addEventListener('click', () => terrain.resetCamera());
  for (const swatch of swatches) {
    swatch.addEventListener('click', () => {
      terrain.setPalette(swatch.dataset.palette as Palette);
      for (const button of swatches) {
        button.setAttribute('aria-pressed', String(button === swatch));
      }
    });
  }

  resetHistory();
  let last = performance.now();
  let fpsSince = last;
  let renderedFrames = 0;

  function frame(now: number) {
    const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    carry += delta;
    if (carry >= stepDuration) {
      do {
        step();
        carry -= stepDuration;
      } while (carry >= stepDuration);
    }
    terrain.render(delta, carry / stepDuration);
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
