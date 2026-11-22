// Theme engine shared by the side panel. Loaded synchronously in <head> so the
// cached appearance is applied before first paint (no flash of default colors).
(() => {
  const CACHE_KEY = 'sidebar-appearance';
  const HEX = /^#[0-9a-f]{6}$/i;
  const THEMES = ['system', 'light', 'dark'];
  const DEFAULTS = Object.freeze({ theme: 'system', background: 'default', accent: 'default' });
  // Each preset has a light and a dark variant so it follows the theme mode.
  const BACKGROUNDS = [
    { id: 'default', name: '默认', light: '#f5f6f8', dark: '#1e2024' },
    { id: 'paper', name: '暖纸', light: '#f7f3ec', dark: '#23201c' },
    { id: 'mint', name: '薄荷', light: '#eef5f1', dark: '#1a2420' },
    { id: 'sky', name: '晴空', light: '#eef3fa', dark: '#1a202b' },
    { id: 'lavender', name: '薰衣草', light: '#f3f1fa', dark: '#211e2b' },
    { id: 'rose', name: '蔷薇', light: '#faf0f2', dark: '#291e22' },
    { id: 'slate', name: '石板', light: '#eceef1', dark: '#17191d' },
  ];
  const ACCENTS = [
    { id: 'default', name: '松绿', light: '#3f7d5f', dark: '#8fd1ae' },
    { id: 'blue', name: '湖蓝', light: '#2f6fd6', dark: '#8ab4f8' },
    { id: 'indigo', name: '靛青', light: '#5b5bd6', dark: '#a5a8f5' },
    { id: 'violet', name: '紫罗兰', light: '#8b4fc7', dark: '#cba6f2' },
    { id: 'rose', name: '玫红', light: '#c74a72', dark: '#f29bb6' },
    { id: 'amber', name: '琥珀', light: '#b0650f', dark: '#f0b867' },
    { id: 'teal', name: '青碧', light: '#12808a', dark: '#79d0d6' },
    { id: 'graphite', name: '石墨', light: '#4a5260', dark: '#b8c0cc' },
  ];
  const media = matchMedia('(prefers-color-scheme: dark)');
  let current = { ...DEFAULTS };

  function luminance(hex) {
    const channel = index => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    };
    return .2126 * channel(1) + .7152 * channel(3) + .0722 * channel(5);
  }
  function pick(value, presets) {
    if (HEX.test(value)) return value.toLowerCase();
    return presets.some(preset => preset.id === value) ? value : 'default';
  }
  function normalize(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      theme: THEMES.includes(input.theme) ? input.theme : DEFAULTS.theme,
      background: pick(input.background, BACKGROUNDS),
      accent: pick(input.accent, ACCENTS),
    };
  }
  function resolve(value, presets, tone) {
    return HEX.test(value) ? value : (presets.find(preset => preset.id === value) || presets[0])[tone];
  }
  function apply(value, { persist = true } = {}) {
    current = normalize(value);
    const systemTone = current.theme === 'system' ? (media.matches ? 'dark' : 'light') : current.theme;
    // A custom background decides its own tone so text always stays readable.
    const tone = HEX.test(current.background) ? (luminance(current.background) < .18 ? 'dark' : 'light') : systemTone;
    const background = resolve(current.background, BACKGROUNDS, tone);
    const accent = resolve(current.accent, ACCENTS, tone);
    const root = document.documentElement;
    root.dataset.tone = tone;
    root.style.setProperty('--bg', background);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--on-accent', luminance(accent) > .42 ? '#14181d' : '#ffffff');
    if (persist) try { localStorage.setItem(CACHE_KEY, JSON.stringify(current)); } catch {}
    const detail = { ...current, tone, resolvedBackground: background, resolvedAccent: accent };
    document.dispatchEvent(new CustomEvent('sidebar-appearance', { detail }));
    return detail;
  }
  function cached() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
  }
  media.addEventListener('change', () => { if (current.theme === 'system') apply(current); });
  apply(cached());
  window.SidebarAppearance = {
    DEFAULTS, BACKGROUNDS, ACCENTS, apply, normalize, luminance,
    get current() { return { ...current }; },
  };
})();
