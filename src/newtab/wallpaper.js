// New tab background image.
//
// The image itself lives in IndexedDB (a Blob, no size limit worth worrying about and no
// base64 bloat); its settings live in chrome.storage.local. A tiny blurred placeholder plus
// the settings are mirrored into localStorage, where wallpaper-boot.js reads them
// synchronously before the first paint, so a new tab never flashes a plain background
// while the full image is read and decoded.
export const CACHE_KEY = 'arcify-wallpaper';
export const STORAGE_KEY = 'newtabWallpaper';
export const DEFAULTS = Object.freeze({ enabled: false, dim: 25, blur: 0, placeholder: '', version: 0 });
const PLACEHOLDER = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
export function normalizeWallpaper(value) {
  const input = value && typeof value === 'object' ? value : {};
  const placeholder = PLACEHOLDER.test(input.placeholder || '') ? input.placeholder : '';
  return {
    enabled: input.enabled === true && !!placeholder,
    dim: clamp(input.dim, 0, 80, DEFAULTS.dim),
    blur: clamp(input.blur, 0, 30, DEFAULTS.blur),
    placeholder,
    version: clamp(input.version, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}
// Scale down so the longest side is at most `max`; never scale up.
export function fitSize(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
// Large enough for this screen at its pixel density, capped at 4K.
export function targetSize(screen = globalThis.screen, ratio = globalThis.devicePixelRatio || 1) {
  const longest = Math.max(screen?.width || 1920, screen?.height || 1080) * ratio;
  return Math.min(3840, Math.max(1920, Math.round(longest)));
}

// ---------- Image processing (browser only) ----------
async function encode(bitmap, size, type, quality) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return canvas.convertToBlob({ type, quality });
}
function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
// Downscales and re-encodes a picked file: a multi-megabyte photo becomes a few hundred KB.
export async function processImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('请选择图片文件');
  if (file.size > MAX_INPUT_BYTES) throw new Error('图片不能超过 40 MB');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('无法读取这张图片，请换一张 JPG、PNG 或 WebP 图片'); }
  try {
    const size = fitSize(bitmap.width, bitmap.height, targetSize());
    const blob = await encode(bitmap, size, 'image/webp', 0.88);
    const placeholder = await dataUrl(await encode(bitmap, fitSize(bitmap.width, bitmap.height, 32), 'image/jpeg', 0.7));
    return { blob, placeholder };
  } finally { bitmap.close(); }
}

// ---------- IndexedDB ----------
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('arcify', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('files', mode);
      const request = action(transaction.objectStore('files'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
export const readImage = () => withStore('readonly', store => store.get('wallpaper'));
export const writeImage = blob => withStore('readwrite', store => store.put(blob, 'wallpaper'));
export const deleteImage = () => withStore('readwrite', store => store.delete('wallpaper'));

// ---------- Applying ----------
export function applyVariables(settings, root = document.documentElement) {
  if (!settings.enabled) { delete root.dataset.wallpaper; return; }
  root.dataset.wallpaper = '';
  root.style.setProperty('--wallpaper-placeholder', `url("${settings.placeholder}")`);
  root.style.setProperty('--wallpaper-dim', `${settings.dim}%`);
  root.style.setProperty('--wallpaper-blur', `${settings.blur}px`);
}
export function writeCache(settings, storage = globalThis.localStorage) {
  try {
    if (settings.enabled) storage.setItem(CACHE_KEY, JSON.stringify(settings));
    else storage.removeItem(CACHE_KEY);
  } catch {}
}
