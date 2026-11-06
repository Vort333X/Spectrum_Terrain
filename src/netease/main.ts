import { SAMPLES_PER_SECOND, testSpectrum, type TestSignal } from '../audio';
import { bindEffects } from '../effects';
import { coverTheme, fitCover } from '../player/artwork';
import { SpectrumHistory } from '../spectrum-history';
import { Terrain } from '../terrain';
import { probeAudio } from './audio-probe';
import css from './style.css';

declare const NETEASE_EFFECT_CONTROLS: string;

const LAYOUT = '#vinyl-page-container .VinylPageLayoutContainer_vwagppq';
const COVER = '[data-testid="tid_vinylcover_cover"] img';
const STAGE_CLASS = 'spectrum-terrain-stage';
const LAYOUT_CLASS = 'spectrum-terrain-layout';
const STYLE_ID = 'spectrum-terrain-netease-css';
const COVER_POLL_MS = 350;
const REFERENCE_EFFECTS = { opacity: 70, trail: 51, glow: 50, radius: 12, gain: 115, smoothing: 50, orbitspeed: 10 };

function mount(layout: HTMLElement, pane: HTMLElement, lyrics: HTMLElement) {
  const stage = document.createElement('div');
  stage.className = STAGE_CLASS;
  stage.setAttribute('aria-label', 'Spectrum Terrain 立体频谱预览');
  const axes = document.createElement('div');
  axes.dataset.spectrumAxes = '';
  const tools = document.createElement('details');
  tools.className = 'spectrum-terrain-tools';
  tools.innerHTML = `
    <summary>频谱设置</summary>
    <div class="spectrum-terrain-panel">
      <div class="spectrum-terrain-meta"><span>演示频谱</span><output data-fps>— FPS</output></div>
      <div class="spectrum-terrain-actions">
        <button type="button" data-orbit aria-pressed="false">自动绕转</button>
        <button type="button" data-reset-view>复位视角</button>
      </div>
      ${NETEASE_EFFECT_CONTROLS}
      <button type="button" data-probe>检测网易云音频</button>
      <p role="status" hidden></p>
    </div>`;
  stage.append(axes, tools);
  layout.append(stage);

  function sizeStage() {
    const bounds = layout.getBoundingClientRect();
    const lyricsLeft = lyrics.getBoundingClientRect().left;
    const bleed = bounds.width >= 1000 ? Math.min(160, bounds.width * 0.1) : 0;
    const right = Math.min(bounds.right - 12, lyricsLeft + bleed);
    stage.style.right = `${bounds.right - right}px`;
    stage.style.setProperty('--spectrum-bleed', `${Math.max(0, right - lyricsLeft)}px`);
  }

  sizeStage();

  let terrain: Terrain;
  try {
    terrain = new Terrain(stage, SAMPLES_PER_SECOND, false, 'embedded-player');
  } catch (error) {
    stage.remove();
    throw error;
  }
  const resizeObserver = new ResizeObserver(sizeStage);
  resizeObserver.observe(layout);
  resizeObserver.observe(lyrics);
  const form = tools.querySelector('form')!;
  for (const [name, value] of Object.entries(REFERENCE_EFFECTS)) {
    (form.elements.namedItem(name) as HTMLInputElement).defaultValue = String(value);
  }
  bindEffects(form, (settings) => terrain.applyEffects(settings), true);
  const history = new SpectrumHistory(terrain, SAMPLES_PER_SECOND);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const signal = tools.querySelector<HTMLSelectElement>('#spectrum-terrain-test-signal')!;
  const freeze = tools.querySelector<HTMLInputElement>('#spectrum-terrain-freeze')!;
  const orbit = tools.querySelector<HTMLButtonElement>('[data-orbit]')!;
  const check = tools.querySelector<HTMLButtonElement>('[data-probe]')!;
  const status = tools.querySelector<HTMLElement>('[role="status"]')!;
  const fpsLabel = tools.querySelector<HTMLOutputElement>('[data-fps]')!;
  const sample = (time: number, levels: Float32Array) => testSpectrum(signal.value as TestSignal, time, levels);
  history.reset(sample);
  signal.addEventListener('change', () => history.reset(sample));
  orbit.addEventListener('click', () => {
    terrain.autoRotate = !terrain.autoRotate;
    orbit.setAttribute('aria-pressed', String(terrain.autoRotate));
  });
  tools.querySelector('[data-reset-view]')!.addEventListener('click', () => terrain.resetCamera());
  const canvas = stage.querySelector('canvas')!;
  let frameId = 0;
  let lastFrame: number | undefined;
  let lastCover = '';
  let request = 0;
  let cancelProbe: (() => void) | undefined;
  let fpsSince = 0;
  let renderedFrames = 0;

  function frame(now: number) {
    const delta = lastFrame === undefined ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!reducedMotion.matches && !freeze.checked) history.advance(delta, sample);
    terrain.render(delta, history.phase);
    if (tools.open) {
      fpsSince ||= now;
      renderedFrames++;
      if (now - fpsSince >= 600) {
        fpsLabel.value = `${Math.round(renderedFrames * 1000 / (now - fpsSince))} FPS`;
        renderedFrames = 0;
        fpsSince = now;
      }
    }
    frameId = requestAnimationFrame(frame);
  }

  tools.addEventListener('toggle', () => {
    fpsSince = renderedFrames = 0;
    fpsLabel.value = '— FPS';
  });

  function restoreCover() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    lastFrame = undefined;
    delete stage.dataset.ready;
    layout.classList.remove(LAYOUT_CLASS);
  }

  async function setCover(image: HTMLImageElement) {
    const src = image.currentSrc || image.src;
    if (!src || lastCover === src || !image.complete || !image.naturalWidth) return;
    lastCover = src;
    const current = ++request;
    try {
      let cover = fitCover(image);
      let theme;
      try {
        theme = coverTheme(cover);
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
        const corsImage = new Image();
        corsImage.crossOrigin = 'anonymous';
        corsImage.src = src;
        await corsImage.decode();
        cover = fitCover(corsImage);
        theme = coverTheme(cover);
      }
      if (request !== current || !stage.isConnected) return;
      terrain.setCover(cover);
      terrain.setColors(theme.stops, frameId && !reducedMotion.matches ? 0.6 : 0);
      stage.style.setProperty('--spectrum-accent', theme.accent);
      stage.style.setProperty('--spectrum-wash', theme.wash);
      layout.classList.add(LAYOUT_CLASS);
      stage.dataset.ready = '';
      if (!frameId) frameId = requestAnimationFrame(frame);
    } catch (error) {
      if (request !== current) return;
      restoreCover();
      console.warn('[SpectrumTerrain] 读取封面失败', error);
    }
  }

  function showProbeResult(message: string) {
    check.disabled = false;
    status.textContent = message;
    console.info('[SpectrumTerrain]', message);
  }

  check.addEventListener('click', () => {
    check.disabled = true;
    status.hidden = false;
    status.textContent = '检测中，请保持播放…';
    try {
      cancelProbe = probeAudio(showProbeResult);
    } catch (error) {
      console.warn('[SpectrumTerrain] 音频检测失败', error);
      showProbeResult('音频检测失败');
    }
  });

  canvas.addEventListener('webglcontextlost', restoreCover);

  return {
    layout,
    pane,
    lyrics,
    setCover,
    dispose() {
      request++;
      resizeObserver.disconnect();
      cancelProbe?.();
      canvas.removeEventListener('webglcontextlost', restoreCover);
      restoreCover();
      terrain.dispose();
      stage.remove();
    },
  };
}

if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.append(style);
  let mounted: ReturnType<typeof mount> | undefined;
  let failedPane: HTMLElement | undefined;

  const refresh = () => {
    const layout = document.querySelector<HTMLElement>(LAYOUT);
    const pane = layout?.querySelector<HTMLElement>(':scope > .vinyl');
    const lyrics = layout?.querySelector<HTMLElement>(':scope > .display');
    const image = pane?.querySelector<HTMLImageElement>(COVER);
    const page = layout?.closest('#vinyl-page-container');
    const bounds = page?.getBoundingClientRect();
    const visible = bounds && bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
      bounds.top < innerHeight && bounds.left < innerWidth && getComputedStyle(page!).visibility === 'visible';
    if (mounted && (document.hidden || !visible || !image ||
        layout !== mounted.layout || pane !== mounted.pane || lyrics !== mounted.lyrics)) {
      mounted.dispose();
      mounted = undefined;
    }
    if (document.hidden || !visible || !layout || !pane || !lyrics || !image || pane === failedPane) return;
    try {
      mounted ??= mount(layout, pane, lyrics);
      void mounted.setCover(image);
    } catch (error) {
      failedPane = pane;
      console.warn('[SpectrumTerrain] 无法创建三维场景', error);
    }
  };

  const poll = window.setInterval(refresh, COVER_POLL_MS);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', () => {
    clearInterval(poll);
    document.removeEventListener('visibilitychange', refresh);
    mounted?.dispose();
    style.remove();
  }, { once: true });
  refresh();
}
