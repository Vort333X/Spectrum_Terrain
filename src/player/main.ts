import { demoSpectrum, SAMPLES_PER_SECOND, SystemAudioMonitor } from '../shared/audio';
import { SpectrumHistory } from '../shared/spectrum-history';
import { Terrain } from '../shared/terrain';
import { coverTheme, DEMO_TRACKS, demoCover, fitCover } from '../shared/artwork';

function formatTime(seconds: number) {
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

function start() {
  const player = document.querySelector<HTMLElement>('.player')!;
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const title = document.querySelector<HTMLElement>('#track-title')!;
  const subtitle = document.querySelector<HTMLElement>('#track-subtitle')!;
  const source = document.querySelector<HTMLElement>('#source')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const coverFile = document.querySelector<HTMLInputElement>('#cover-file')!;
  const monitorButton = document.querySelector<HTMLButtonElement>('#monitor')!;
  const playButton = document.querySelector<HTMLButtonElement>('#play')!;
  const progress = document.querySelector<HTMLInputElement>('#progress')!;
  const elapsedLabel = document.querySelector<HTMLElement>('#elapsed')!;
  const durationLabel = document.querySelector<HTMLElement>('#duration')!;
  const palette = document.querySelector<HTMLElement>('#track-palette')!;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const terrain = new Terrain(stage, SAMPLES_PER_SECOND, false, 'player');
  terrain.applyEffects({ axes: true, opacity: 84, trail: 32, glow: 45, radius: 8, gain: 100, smoothing: 50, orbitspeed: 0 });
  const history = new SpectrumHistory(terrain, SAMPLES_PER_SECOND);
  const audio = new SystemAudioMonitor();
  let index = 0;
  let position = 0;
  let playing = true;
  let listening = false;
  let coverRequest = 0;
  let elapsedSecond = -1;
  let frameId = 0;
  let lastFrame: number | undefined;
  let pageActive = true;

  function sampleDemo(time: number, levels: Float32Array) {
    demoSpectrum(time + index * 4.6, levels);
  }

  function sample(time: number, levels: Float32Array) {
    if (listening) audio.sample(levels);
    else sampleDemo(time, levels);
  }

  function showStatus(message: string) {
    status.textContent = message;
    status.hidden = !message;
  }

  function applyCover(cover: HTMLCanvasElement, animate: boolean) {
    const theme = coverTheme(cover);
    terrain.setCover(cover);
    terrain.setColors(theme.stops, animate && !reducedMotion.matches ? 0.6 : 0);
    player.style.setProperty('--accent', theme.accent);
    player.style.setProperty('--wash', theme.wash);
    for (const [index, swatch] of Array.from(palette.children).entries()) {
      (swatch as HTMLElement).style.backgroundColor = theme.stops[index];
    }
  }

  function updateProgress() {
    progress.value = String(position);
    const second = Math.floor(position);
    if (elapsedSecond !== second) {
      elapsedSecond = second;
      elapsedLabel.textContent = formatTime(second);
    }
  }

  function selectTrack(next: number, animate = true) {
    coverRequest++;
    index = (next + DEMO_TRACKS.length) % DEMO_TRACKS.length;
    position = 0;
    const track = DEMO_TRACKS[index];
    title.textContent = track.title;
    subtitle.textContent = track.artworkTitle + ' · 演示曲目';
    progress.max = String(track.duration);
    durationLabel.textContent = formatTime(track.duration);
    updateProgress();
    applyCover(demoCover(index), animate);
    showStatus('');
    if (!listening) history.reset(sampleDemo);
  }

  function updatePlaying() {
    playButton.dataset.playing = String(playing);
    playButton.setAttribute('aria-label', playing ? '暂停频谱动画' : '播放频谱动画');
  }

  function updateSource() {
    source.textContent = listening ? '系统音频' : '演示频谱';
    monitorButton.textContent = listening ? '停止监听' : '监听系统音频';
    monitorButton.setAttribute('aria-pressed', String(listening));
    progress.disabled = listening;
  }

  function stopListening(message = '') {
    audio.stop();
    if (listening) history.reset(sampleDemo, position);
    listening = false;
    updateSource();
    showStatus(message);
  }

  document.querySelector<HTMLButtonElement>('#choose-cover')!.addEventListener('click', () => coverFile.click());
  coverFile.addEventListener('change', async () => {
    const file = coverFile.files?.[0];
    coverFile.value = '';
    if (!file) return;
    const request = ++coverRequest;
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (request !== coverRequest) return;
      applyCover(fitCover(image), true);
      subtitle.textContent = file.name + ' · 本地封面';
      showStatus('');
    } catch {
      if (request === coverRequest) showStatus('无法读取封面，请选择可打开的图片。');
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  monitorButton.addEventListener('click', async () => {
    if (listening) {
      stopListening();
      return;
    }
    monitorButton.disabled = true;
    showStatus('在共享窗口勾选「共享系统音频」。');
    try {
      await audio.start(() => stopListening('共享已结束，已回到演示频谱。'));
      if (!pageActive) {
        audio.stop();
        return;
      }
      listening = true;
      playing = true;
      history.reset();
      updatePlaying();
      updateSource();
      showStatus('');
    } catch (error) {
      showStatus(error instanceof Error ? error.message : '无法开启系统音频监听。');
    } finally {
      monitorButton.disabled = false;
    }
  });

  document.querySelector<HTMLButtonElement>('#reset-view')!.addEventListener('click', () => terrain.resetCamera());
  document.querySelector<HTMLButtonElement>('#previous')!.addEventListener('click', () => selectTrack(index - 1));
  document.querySelector<HTMLButtonElement>('#next')!.addEventListener('click', () => selectTrack(index + 1));
  playButton.addEventListener('click', () => {
    playing = !playing;
    updatePlaying();
  });
  progress.addEventListener('input', () => {
    position = progress.valueAsNumber;
    updateProgress();
    history.reset(sampleDemo, position);
  });

  function frame(now: number) {
    const delta = lastFrame === undefined ? 0 : Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (playing) {
      if (!listening) {
        position += delta;
        if (position >= DEMO_TRACKS[index].duration) selectTrack(index + 1);
        updateProgress();
      }
      history.advance(delta, sample);
    }
    terrain.render(delta, history.phase);
    frameId = requestAnimationFrame(frame);
  }

  function updateFrameLoop() {
    if (!pageActive || document.hidden) {
      cancelAnimationFrame(frameId);
      frameId = 0;
      lastFrame = undefined;
    } else if (!frameId) {
      frameId = requestAnimationFrame(frame);
    }
  }

  document.addEventListener('visibilitychange', updateFrameLoop);
  window.addEventListener('pagehide', () => {
    pageActive = false;
    updateFrameLoop();
    stopListening();
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    updateFrameLoop();
  });

  selectTrack(0, false);
  updateSource();
  updatePlaying();
  updateFrameLoop();
}

try {
  start();
} catch (error) {
  console.error(error);
  document.querySelector<HTMLElement>('#stage-error')!.hidden = false;
}
