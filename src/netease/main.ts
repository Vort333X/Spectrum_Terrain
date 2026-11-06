import { demoSpectrum, SAMPLES_PER_SECOND } from '../audio';
import { coverTheme, fitCover } from '../player/artwork';
import { SpectrumHistory } from '../spectrum-history';
import { Terrain } from '../terrain';
import { probeAudio } from './audio-probe';
import css from './style.css';

const LAYOUT = '#vinyl-page-container .VinylPageLayoutContainer_vwagppq';
const COVER = '[data-testid="tid_vinylcover_cover"] img';
const STAGE_CLASS = 'spectrum-terrain-stage';
const LAYOUT_CLASS = 'spectrum-terrain-layout';
const STYLE_ID = 'spectrum-terrain-netease-css';
const COVER_POLL_MS = 350;

function mount(layout: HTMLElement, pane: HTMLElement) {
  const stage = document.createElement('div');
  stage.className = STAGE_CLASS;
  stage.setAttribute('aria-label', 'Spectrum Terrain 立体频谱预览');
  const axes = document.createElement('div');
  axes.dataset.spectrumAxes = '';
  const tools = document.createElement('div');
  tools.className = 'spectrum-terrain-tools';
  const mode = document.createElement('span');
  mode.textContent = '演示频谱';
  const check = document.createElement('button');
  check.type = 'button';
  check.textContent = '检测网易云音频';
  const status = document.createElement('span');
  status.hidden = true;
  status.setAttribute('role', 'status');
  tools.append(mode, check, status);
  stage.append(axes, tools);
  pane.prepend(stage);

  let terrain: Terrain;
  try {
    terrain = new Terrain(stage, SAMPLES_PER_SECOND, false, 'player');
  } catch (error) {
    stage.remove();
    throw error;
  }
  terrain.applyEffects({ axes: true, opacity: 84, trail: 32, glow: 45, radius: 8, gain: 100, smoothing: 50, orbitspeed: 0 });
  const history = new SpectrumHistory(terrain, SAMPLES_PER_SECOND);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  history.reset(demoSpectrum);
  const canvas = stage.querySelector('canvas')!;
  let frameId = 0;
  let lastFrame: number | undefined;
  let lastCover = '';
  let request = 0;
  let cancelProbe: (() => void) | undefined;

  function frame(now: number) {
    const delta = lastFrame === undefined ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!reducedMotion.matches) history.advance(delta, demoSpectrum);
    terrain.render(delta, history.phase);
    frameId = requestAnimationFrame(frame);
  }

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
    pane,
    setCover,
    dispose() {
      request++;
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
    const image = pane?.querySelector<HTMLImageElement>(COVER);
    const page = layout?.closest('#vinyl-page-container');
    const bounds = page?.getBoundingClientRect();
    const visible = bounds && bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
      bounds.top < innerHeight && bounds.left < innerWidth && getComputedStyle(page!).visibility === 'visible';
    if (mounted && (document.hidden || !visible || !image || pane !== mounted.pane)) {
      mounted.dispose();
      mounted = undefined;
    }
    if (document.hidden || !visible || !layout || !pane || !image || pane === failedPane) return;
    try {
      mounted ??= mount(layout, pane);
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
