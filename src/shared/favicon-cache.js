// Favicon cache for the side panel.
//
// Reopening the side panel creates a new page. Loading every row's favicon from its
// remote URL again made icons blank out and pop in. Icons are therefore kept as small
// data: URLs in localStorage, which is readable synchronously: a reopened panel paints
// each row with its icon in the very first frame and does no image requests at all
// while the cached icon is still current.
//
// Icons are filled from Chrome's local favicon database (the `_favicon` endpoint,
// "favicon" permission). It is same-origin with the panel, so it can be drawn to a
// canvas and stored; a site's own favicon URL cannot (the canvas would be tainted).
const STORAGE_KEY = 'sidebar-favicons-v1';
const MAX_ENTRIES = 400;
const STALE_AFTER = 7 * 24 * 60 * 60 * 1000;
const SIZE = 32;

export function pageKey(url) {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return ''; }
}
function originKey(url) {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? `origin:${parsed.origin}` : ''; } catch { return ''; }
}
// Tab favicons can be long data: URLs; remember which one was cached by a short id.
export function sourceId(reported) {
  const text = String(reported || '');
  if (text.length <= 512) return text;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `#${text.length}:${(hash >>> 0).toString(36)}`;
}

export function faviconApiUrl(getURL, pageUrl, size = SIZE) {
  const url = new URL(getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

function browserLoadImage(src) {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  return image.decode().then(() => image);
}
async function browserRasterize(src) {
  const image = await browserLoadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  canvas.getContext('2d').drawImage(image, 0, 0, SIZE, SIZE);
  return canvas.toDataURL('image/png'); // throws for a cross-origin (tainted) image
}

export function createFaviconCache({
  storage = globalThis.localStorage,
  apiUrl = null, // pageUrl => _favicon URL, or null without the "favicon" permission
  loadImage = browserLoadImage,
  rasterize = browserRasterize,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let entries = {};
  try { entries = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')?.entries || {}; } catch { entries = {}; }
  const loads = new Map();
  let dirty = false, saveTimer = null, defaultIcon;

  function flush() {
    saveTimer = null;
    if (!dirty || !storage) return;
    dirty = false;
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => entries[b].t - entries[a].t).slice(MAX_ENTRIES).forEach(key => { delete entries[key]; });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { storage.setItem(STORAGE_KEY, JSON.stringify({ entries })); return; }
      catch {
        // Quota exceeded: keep the most recently stored half and retry.
        const sorted = Object.keys(entries).sort((a, b) => entries[b].t - entries[a].t);
        sorted.slice(Math.ceil(sorted.length / 2)).forEach(key => { delete entries[key]; });
      }
    }
  }
  function saveSoon() {
    dirty = true;
    if (!saveTimer) saveTimer = schedule(flush, 400);
  }
  function put(pageUrl, data, reported) {
    const record = { d: data, s: sourceId(reported), t: now() };
    const exact = pageKey(pageUrl);
    if (exact) entries[exact] = record;
    // Same-site pages usually share an icon: a good first guess for new pages.
    const origin = originKey(pageUrl);
    if (origin) entries[origin] = { d: data, s: '', t: record.t };
    saveSoon();
  }
  // Synchronous lookup used while rendering a row.
  function get(pageUrl) {
    const exact = entries[pageKey(pageUrl)];
    if (exact) return { data: exact.d, source: exact.s, stale: now() - exact.t > STALE_AFTER, exact: true };
    const origin = entries[originKey(pageUrl)];
    return origin ? { data: origin.d, source: '', stale: true, exact: false } : null;
  }
  // Is the cached icon for this page still the one the browser reports?
  function isCurrent(pageUrl, reported) {
    const hit = get(pageUrl);
    return !!hit && hit.exact && !hit.stale && hit.source === sourceId(reported);
  }
  // Chrome returns a generic globe for pages it has no icon for (e.g. Pins restored
  // from a backup); compare against it so such pages still try the site's own icon.
  function genericIcon() {
    defaultIcon ??= rasterize(apiUrl('https://sidebar-no-favicon.invalid/')).catch(() => null);
    return defaultIcon;
  }
  async function fetchIcon(pageUrl, reported) {
    let source = null;
    if (/^data:image\//i.test(reported)) source = reported;
    else if (apiUrl && /^https?:/i.test(pageUrl)) source = apiUrl(pageUrl);
    if (source) {
      try {
        const data = await rasterize(source);
        if (source === reported || data !== await genericIcon()) { put(pageUrl, data, reported); return data; }
      } catch {}
    }
    // Not cacheable (no favicon permission, chrome:// page …): show the site's icon once it has loaded.
    try { await loadImage(reported); return reported; } catch { return null; }
  }
  // Resolves to an image source that is already loaded, so swapping it in never blanks.
  function load(pageUrl, reported) {
    const id = `${pageKey(pageUrl)}\n${sourceId(reported)}`;
    if (!loads.has(id)) loads.set(id, fetchIcon(pageUrl, reported));
    return loads.get(id);
  }
  return { get, isCurrent, load, flush, get size() { return Object.keys(entries).length; } };
}
