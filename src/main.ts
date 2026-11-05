import { BANDS, demoSpectrum, HISTORY_ROWS, SAMPLES_PER_SECOND, SystemAudioMonitor } from './audio';
import { Terrain, type Palette } from './terrain';

declare global {
  interface Window {
    wallpaperRegisterAudioListener?: (listener: (levels: number[]) => void) => void;
  }
}

const STEP = 1 / SAMPLES_PER_SECOND;

function start() {
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const monitorButton = document.querySelector<HTMLButtonElement>('#monitor')!;
  const monitorLabel = document.querySelector<HTMLElement>('#monitor-label')!;
  const monitorHint = document.querySelector<HTMLElement>('#monitor-hint')!;
  const sourceLabel = document.querySelector<HTMLElement>('#source')!;
  const audio = new SystemAudioMonitor();
  const captureHelp = monitorHint.textContent!;
  const orbit = document.querySelector<HTMLButtonElement>('#orbit')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset')!;
  const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-palette]'));
  const isWallpaper = typeof window.wallpaperRegisterAudioListener === 'function';

  if (isWallpaper) document.body.dataset.mode = 'wallpaper';

  const terrain = new Terrain(stage);
  const history = new Float32Array(HISTORY_ROWS * BANDS);
  const target = new Float32Array(BANDS);
  const smoothed = new Float32Array(BANDS);
  const systemBands = new Float32Array(BANDS);
  let mode: 'demo' | 'capture' | 'wallpaper' = isWallpaper ? 'wallpaper' : 'demo';
  let head = 0;
  let age = 0;
  let carry = 0;


  function resetHistory() {
    head = 0;
    age = 0;
    carry = 0;
    smoothed.fill(0);
    history.fill(0);
    if (mode === 'demo') {
      for (let row = 0; row < HISTORY_ROWS; row++) {
        demoSpectrum(-row * STEP, target);
        history.set(target, row * BANDS);
      }
      smoothed.set(history.subarray(0, BANDS));
    }
    terrain.updateHeights(history, head);
  }

  function step() {
    if (mode === 'demo') demoSpectrum(age, target);
    if (mode === 'wallpaper') target.set(systemBands);
    if (mode === 'capture') audio.sample(target);

    for (let index = 0; index < BANDS; index++) {
      const value = target[index];
      const response = value > smoothed[index] ? 0.78 : 0.35;
      smoothed[index] += (value - smoothed[index]) * response;
    }

    head = (head + HISTORY_ROWS - 1) % HISTORY_ROWS;
    history.set(smoothed, head * BANDS);
    age += STEP;
  }

  if (isWallpaper) {
    window.wallpaperRegisterAudioListener!((levels) => {
      if (levels.length !== BANDS * 2) return;
      for (let index = 0; index < BANDS; index++) {
        const left = Math.max(0, Number(levels[index]) || 0);
        const right = Math.max(0, Number(levels[BANDS + index]) || 0);
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

  function frame(now: number) {
    const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    carry += delta;
    if (carry >= STEP) {
      do {
        step();
        carry -= STEP;
      } while (carry >= STEP);
      terrain.updateHeights(history, head);
    }
    terrain.render(delta, carry / STEP);
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
