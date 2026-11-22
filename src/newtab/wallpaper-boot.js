// Runs synchronously in <head>: paints the cached wallpaper placeholder in the first frame.
// The full image is loaded by newtab.js (see wallpaper.js).
(() => {
  try {
    const cached = JSON.parse(localStorage.getItem('arcify-wallpaper') || 'null');
    if (cached?.enabled !== true || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(cached.placeholder || '')) return;
    const root = document.documentElement;
    const number = (value, max) => Math.min(max, Math.max(0, Number(value) || 0));
    root.dataset.wallpaper = '';
    root.style.setProperty('--wallpaper-placeholder', `url("${cached.placeholder}")`);
    root.style.setProperty('--wallpaper-dim', `${number(cached.dim, 80)}%`);
    root.style.setProperty('--wallpaper-blur', `${number(cached.blur, 30)}px`);
  } catch {}
})();
