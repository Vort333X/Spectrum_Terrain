import { Color } from 'three';

const COVER_SIZE = 640;
const SAMPLE_SIZE = 36;
const HUE_BUCKETS = 24;

export interface CoverTheme {
  stops: readonly [string, string, string];
  accent: string;
  wash: string;
}

function canvasAtSize(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}

export function fitCover(image: HTMLImageElement, size = COVER_SIZE) {
  const canvas = canvasAtSize(size);
  const context = canvas.getContext('2d')!;
  const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.fillStyle = '#15151a';
  context.fillRect(0, 0, size, size);
  if (size > COVER_SIZE) context.imageSmoothingQuality = 'high';
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas;
}

export function coverTheme(cover: HTMLCanvasElement): CoverTheme {
  const context = canvasAtSize(SAMPLE_SIZE).getContext('2d')!;
  context.drawImage(cover, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ weight: 0, red: 0, green: 0, blue: 0 }));
  const color = new Color();
  const hsl = { h: 0, s: 0, l: 0 };
  let chromaticPixels = 0;

  for (let pixel = 0; pixel < data.length; pixel += 4) {
    color.setRGB(data[pixel] / 255, data[pixel + 1] / 255, data[pixel + 2] / 255).getHSL(hsl);
    if (data[pixel + 3] < 128 || hsl.s < 0.16 || hsl.l < 0.08 || hsl.l > 0.91) continue;
    const bucket = buckets[Math.floor(hsl.h * HUE_BUCKETS) % HUE_BUCKETS];
    const weight = 0.4 + 0.6 * hsl.s;
    bucket.weight += weight;
    bucket.red += color.r * weight;
    bucket.green += color.g * weight;
    bucket.blue += color.b * weight;
    chromaticPixels++;
  }

  let hue = 0;
  let saturation = 0;
  if (chromaticPixels >= SAMPLE_SIZE * SAMPLE_SIZE * 0.10) {
    // Neighboring buckets keep a hue near the red wrap or a bucket edge together.
    const neighbors = (index: number) => [
      buckets[(index + HUE_BUCKETS - 1) % HUE_BUCKETS],
      buckets[index],
      buckets[(index + 1) % HUE_BUCKETS],
    ];
    let dominant = 0;
    let score = 0;
    for (let index = 0; index < HUE_BUCKETS; index++) {
      const total = neighbors(index).reduce((sum, bucket) => sum + bucket.weight, 0);
      if (total > score) {
        score = total;
        dominant = index;
      }
    }
    const cluster = neighbors(dominant);
    color.setRGB(
      cluster.reduce((sum, bucket) => sum + bucket.red, 0) / score,
      cluster.reduce((sum, bucket) => sum + bucket.green, 0) / score,
      cluster.reduce((sum, bucket) => sum + bucket.blue, 0) / score,
    ).getHSL(hsl);
    hue = hsl.h;
    saturation = Math.min(0.88, Math.max(0.42, hsl.s));
  }

  const tone = (strength: number, lightness: number) =>
    '#' + color.setHSL(hue, saturation * strength, lightness).getHexString();
  const stops = [tone(0.72, 0.18), tone(1, 0.51), tone(0.76, 0.79)] as const;
  return { stops, accent: stops[2], wash: tone(0.68, 0.075) };
}

export const DEMO_TRACKS = [
  { title: '潮汐信号', artworkTitle: 'TIDAL SIGNAL', dark: '#071720', base: '#12686d', light: '#9ef2da', duration: 42 },
  { title: '余烬档案', artworkTitle: 'EMBER ARCHIVE', dark: '#260e0a', base: '#a84c29', light: '#ffd098', duration: 48 },
  { title: '紫夜航线', artworkTitle: 'VIOLET HOURS', dark: '#130b2d', base: '#6140ae', light: '#decbff', duration: 45 },
] as const;

export function demoCover(index: number) {
  const track = DEMO_TRACKS[index];
  const canvas = canvasAtSize(COVER_SIZE);
  const context = canvas.getContext('2d')!;
  const backdrop = context.createLinearGradient(0, 0, COVER_SIZE, COVER_SIZE);
  backdrop.addColorStop(0, track.dark);
  backdrop.addColorStop(0.52, track.base);
  backdrop.addColorStop(1, track.dark);
  context.fillStyle = backdrop;
  context.fillRect(0, 0, COVER_SIZE, COVER_SIZE);

  const orb = context.createRadialGradient(270, 194, 6, 320, 280, 180);
  orb.addColorStop(0, track.light);
  orb.addColorStop(0.38, track.base);
  orb.addColorStop(1, track.dark);
  context.fillStyle = orb;
  context.beginPath();
  context.arc(320, 272, 174, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = track.light;
  context.globalAlpha = 0.66;
  context.stroke();

  context.lineWidth = 1.25;
  for (let row = 0; row < 23; row++) {
    context.beginPath();
    const baseY = 274 + row * 9;
    for (let x = 34; x <= 608; x += 3) {
      const y = baseY + (17 + row * 0.6) * Math.sin(x / 75 + row * 0.19 + index * 0.9);
      if (x === 34) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.globalAlpha = 0.12 + (row % 5 === 0 ? 0.32 : 0.13);
    context.stroke();
  }

  context.globalAlpha = 0.9;
  context.fillStyle = '#fff9f2';
  context.font = '15px monospace';
  context.fillText('SPECTRUM TERRAIN', 40, 50);
  context.textAlign = 'right';
  context.fillText('0' + (index + 1), 600, 50);
  context.textAlign = 'left';
  context.font = '600 42px "Segoe UI", sans-serif';
  context.fillText(track.artworkTitle, 38, 568);
  context.font = '15px monospace';
  context.fillText('SPECTRAL EDITION', 41, 600);
  return canvas;
}
