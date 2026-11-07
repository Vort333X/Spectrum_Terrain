import { SAMPLES_PER_SECOND } from '../shared/audio';
import { bindEffects } from '../shared/effects';
import { coverTheme, fitCover } from '../shared/artwork';
import { SpectrumHistory } from '../shared/spectrum-history';
import { Terrain } from '../shared/terrain';
import { highResolutionCover, loadCover } from './cover-source';
import { PcmSpectrum } from './pcm-spectrum';
import { listenToPlayback } from './playback-audio';
import css from './style.css';

declare const NETEASE_EFFECT_CONTROLS: string;

const LAYOUT = '#vinyl-page-container .VinylPageLayoutContainer_vwagppq';
const COVER = '[data-testid="tid_vinylcover_cover"] img';
const STAGE_CLASS = 'spectrum-terrain-stage';
const LAYOUT_CLASS = 'spectrum-terrain-layout';
const STYLE_ID = 'spectrum-terrain-netease-css';
const COVER_TEXTURE_SIZE = 1024;
const REFERENCE_EFFECTS = { opacity: 70, trail: 51, glow: 50, radius: 12, gain: 115, smoothing: 50, orbitspeed: 10 };

function mount(layout: HTMLElement, pane: HTMLElement, lyrics: HTMLElement) {
  const stage = document.createElement('div');
  stage.className = STAGE_CLASS;
  stage.setAttribute('aria-label', 'Spectrum Terrain 实时三维频谱');
  const axes = document.createElement('div');
  axes.dataset.spectrumAxes = '';
  const tools = document.createElement('details');
  tools.className = 'spectrum-terrain-tools';
  tools.innerHTML = `
    <summary>频谱设置</summary>
    <div class="spectrum-terrain-panel">
      <div class="spectrum-terrain-meta"><span data-audio role="status">等待播放音频</span><output data-fps>— FPS</output></div>
      <div class="spectrum-terrain-actions">
        <button type="button" data-orbit aria-pressed="false">自动绕转</button>
        <button type="button" data-reset-view>复位视角</button>
      </div>
      ${NETEASE_EFFECT_CONTROLS}
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
  const audio = new PcmSpectrum();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const freeze = tools.querySelector<HTMLInputElement>('#spectrum-terrain-freeze')!;
  const orbit = tools.querySelector<HTMLButtonElement>('[data-orbit]')!;
  const audioLabel = tools.querySelector<HTMLElement>('[data-audio]')!;
  const fpsLabel = tools.querySelector<HTMLOutputElement>('[data-fps]')!;
  const sample = (_time: number, levels: Float32Array) => audio.sample(levels);
  history.reset();
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
  let stopAudio: (() => void) | undefined;
  let fpsSince = 0;
  let renderedFrames = 0;

  function frame(now: number) {
    const delta = lastFrame === undefined ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!freeze.checked) history.advance(delta, sample);
    terrain.render(delta, history.phase);
    if (tools.open) {
      updateAudioLabel();
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

  function updateAudioLabel() {
    const label = !stopAudio ? '客户端音频不可用' : audio.active ? '网易云实时音频' : '等待播放音频';
    if (audioLabel.textContent !== label) audioLabel.textContent = label;
  }

  function startAudio() {
    if (stopAudio) return;
    try {
      stopAudio = listenToPlayback((bytes, pts) => audio.push(bytes, pts), () => {
        stopAudio = undefined;
        updateAudioLabel();
      });
    } catch (error) {
      console.warn('[SpectrumTerrain] 无法连接网易云音频', error);
    }
    updateAudioLabel();
  }

  function restoreCover() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    lastFrame = undefined;
    stopAudio?.();
    stopAudio = undefined;
    audio.reset();
    history.reset();
    delete stage.dataset.ready;
    layout.classList.remove(LAYOUT_CLASS);
  }

  async function setCover(image: HTMLImageElement) {
    const src = image.currentSrc || image.src;
    const highRes = src ? highResolutionCover(src) : undefined;
    const key = highRes ?? src;
    if (!src || lastCover === key || !image.complete || !image.naturalWidth) return;
    lastCover = key;
    const current = ++request;
    const stillCurrent = () => request === current && stage.isConnected;

    function applyCover(source: HTMLImageElement) {
      if (!stillCurrent()) return false;
      const cover = fitCover(source, COVER_TEXTURE_SIZE);
      const theme = coverTheme(cover);
      terrain.setCover(cover);
      terrain.setColors(theme.stops, frameId && !reducedMotion.matches ? 0.6 : 0);
      stage.style.setProperty('--spectrum-accent', theme.accent);
      stage.style.setProperty('--spectrum-wash', theme.wash);
      layout.classList.add(LAYOUT_CLASS);
      stage.dataset.ready = '';
      if (!frameId) {
        startAudio();
        frameId = requestAnimationFrame(frame);
      }
      return true;
    }

    let applied = false;
    try {
      applied = applyCover(image);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') {
        console.warn('[SpectrumTerrain] 读取封面失败', error);
      }
    }

    if (highRes && highRes !== src && (!applied || Math.max(image.naturalWidth, image.naturalHeight) < COVER_TEXTURE_SIZE)) {
      try {
        const upgraded = await loadCover(highRes);
        if (!applied || Math.max(upgraded.naturalWidth, upgraded.naturalHeight) > Math.max(image.naturalWidth, image.naturalHeight)) {
          applied = applyCover(upgraded) || applied;
        }
      } catch {
        // Leave the existing cover visible while offline or if the CDN rejects the larger request.
      }
    }
    if (!applied && stillCurrent()) {
      try {
        applied = applyCover(await loadCover(src));
      } catch (error) {
        console.warn('[SpectrumTerrain] 无法读取客户端封面', error);
      }
      if (!applied && stillCurrent()) restoreCover();
    }
  }

  canvas.addEventListener('webglcontextlost', restoreCover);

  return {
    layout,
    pane,
    lyrics,
    setCover,
    dispose() {
      request++;
      resizeObserver.disconnect();
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
  let page: HTMLElement | null | undefined;
  let contentWatching = false;
  let refreshTimer = 0;

  function scheduleRefresh() {
    if (!refreshTimer) refreshTimer = window.setTimeout(refresh, 0);
  }

  const visibilityObserver = new MutationObserver(scheduleRefresh);
  const pageObserver = new MutationObserver(scheduleRefresh);
  const contentObserver = new MutationObserver((records) => {
    if (!mounted || !mounted.pane.isConnected || records.some((record) => mounted!.pane.contains(record.target))) {
      scheduleRefresh();
    }
  });

  function onCoverLoaded(event: Event) {
    if (event.target instanceof HTMLImageElement && event.target.matches(COVER)) scheduleRefresh();
  }

  function stopWatchingContent() {
    contentObserver.disconnect();
    page?.removeEventListener('load', onCoverLoaded, true);
    contentWatching = false;
  }

  function bindPage() {
    const next = document.querySelector<HTMLElement>('#vinyl-page-container');
    if (next === page) return;
    stopWatchingContent();
    visibilityObserver.disconnect();
    pageObserver.disconnect();
    mounted?.dispose();
    mounted = undefined;
    failedPane = undefined;
    page = next;
    if (page) {
      visibilityObserver.observe(page, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      pageObserver.observe(page.parentNode!, { childList: true });
    } else {
      pageObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function refresh() {
    refreshTimer = 0;
    bindPage();
    // The client sets display:none after closing the player. Check that first,
    // so the hidden page never needs periodic layout reads.
    const pageStyle = page && !document.hidden ? getComputedStyle(page) : undefined;
    const displayed = pageStyle && pageStyle.display !== 'none' &&
      pageStyle.visibility === 'visible' && pageStyle.opacity !== '0' && !page!.hidden;
    const bounds = displayed ? page!.getBoundingClientRect() : undefined;
    const visible = bounds && bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
      bounds.top < innerHeight && bounds.left < innerWidth;
    if (!visible) {
      stopWatchingContent();
      mounted?.dispose();
      mounted = undefined;
      return;
    }
    if (!contentWatching) {
      contentObserver.observe(page!, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
      });
      page!.addEventListener('load', onCoverLoaded, true);
      contentWatching = true;
    }
    const layout = document.querySelector<HTMLElement>(LAYOUT);
    const pane = layout?.querySelector<HTMLElement>(':scope > .vinyl');
    const lyrics = layout?.querySelector<HTMLElement>(':scope > .display');
    const image = pane?.querySelector<HTMLImageElement>(COVER);
    if (mounted && (!image ||
        layout !== mounted.layout || pane !== mounted.pane || lyrics !== mounted.lyrics)) {
      mounted.dispose();
      mounted = undefined;
    }
    if (!layout || !pane || !lyrics || !image || pane === failedPane) return;
    try {
      mounted ??= mount(layout, pane, lyrics);
      void mounted.setCover(image);
    } catch (error) {
      failedPane = pane;
      console.warn('[SpectrumTerrain] 无法创建三维场景', error);
    }
  }

  document.addEventListener('visibilitychange', scheduleRefresh);
  window.addEventListener('resize', scheduleRefresh);
  window.addEventListener('pagehide', () => {
    clearTimeout(refreshTimer);
    document.removeEventListener('visibilitychange', scheduleRefresh);
    window.removeEventListener('resize', scheduleRefresh);
    stopWatchingContent();
    visibilityObserver.disconnect();
    pageObserver.disconnect();
    mounted?.dispose();
    style.remove();
  }, { once: true });
  refresh();
}
