const CACHE_PREFIX = 'orpheus://cache/?';
const COVER_REQUEST_SIZE = '1440y1440';

export function highResolutionCover(source: string) {
  const prefix = source.startsWith(CACHE_PREFIX) ? CACHE_PREFIX : '';
  try {
    const url = new URL(source.slice(prefix.length));
    if (!/^https?:$/.test(url.protocol) || !url.hostname.endsWith('.music.126.net')) return;
    const params = url.searchParams;
    const sizeKey = params.has('thumbnail') ? 'thumbnail' : params.has('param') ? 'param' : undefined;
    if (!sizeKey) return;
    params.set(sizeKey, COVER_REQUEST_SIZE);
    params.set('quality', '100');
    return prefix + url.href;
  } catch {
    return;
  }
}

export async function loadCover(source: string) {
  const image = new Image();
  if (/^https?:/.test(source)) image.crossOrigin = 'anonymous';
  image.src = source;
  await image.decode();
  return image;
}
