const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('Esc: the first press arms, a second press within the window closes, a late one re-arms', async () => {
  const { createEscapeGuard, ESCAPE_WINDOW } = await import('../../src/newtab/escape-guard.js');
  let now = 0;
  const guard = createEscapeGuard({ now: () => now });
  assert.equal(ESCAPE_WINDOW, 1500);
  assert.equal(guard.press(), 'armed');
  now = 1400; assert.equal(guard.press(), 'close');
  now = 1500; assert.equal(guard.press(), 'armed', 'after closing the guard starts over');
  now = 3100; assert.equal(guard.press(), 'armed', 'too slow: counts as a new first press');
  assert.equal(guard.armed, true);
  guard.reset();
  now = 3200; assert.equal(guard.armed, false);
  assert.equal(guard.press(), 'armed', 'typing in between (reset) requires two presses again');
});

test('wallpaper settings are clamped, and a wallpaper without a valid placeholder is off', async () => {
  const { normalizeWallpaper, DEFAULTS } = await import('../../src/newtab/wallpaper.js');
  const placeholder = 'data:image/jpeg;base64,AAAA';
  assert.deepEqual(normalizeWallpaper(undefined), { ...DEFAULTS });
  assert.deepEqual(normalizeWallpaper({ enabled: true, placeholder, dim: 200, blur: -4, version: 7 }), { enabled: true, dim: 80, blur: 0, placeholder, version: 7 });
  assert.equal(normalizeWallpaper({ enabled: true, placeholder: 'https://evil.example/x.png' }).enabled, false);
  assert.equal(normalizeWallpaper({ enabled: true, placeholder: 'data:image/jpeg;base64,AA");background:url(x' }).placeholder, '', 'no CSS injection through the cached value');
  assert.equal(normalizeWallpaper({ enabled: true, placeholder, dim: 'x' }).dim, DEFAULTS.dim);
});

test('images are scaled down to the screen (never up), capped at 4K', async () => {
  const { fitSize, targetSize } = await import('../../src/newtab/wallpaper.js');
  assert.deepEqual(fitSize(6000, 4000, 3000), { width: 3000, height: 2000 });
  assert.deepEqual(fitSize(800, 600, 3000), { width: 800, height: 600 });
  assert.deepEqual(fitSize(4000, 10, 32), { width: 32, height: 1 });
  assert.equal(targetSize({ width: 1512, height: 982 }, 2), 3024);
  assert.equal(targetSize({ width: 2560, height: 1440 }, 2), 3840);
  assert.equal(targetSize({ width: 1280, height: 800 }, 1), 1920);
});

function boot(cached) {
  const props = {}, root = { dataset: {}, style: { setProperty: (name, value) => { props[name] = value; } } };
  const storage = { getItem: () => cached === undefined ? null : JSON.stringify(cached) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/newtab/wallpaper-boot.js'), 'utf8'), { localStorage: storage, document: { documentElement: root }, JSON, Math, Number });
  return { root, props };
}
test('the cached placeholder is painted before first render, and only safe cached values are used', () => {
  let app = boot({ enabled: true, placeholder: 'data:image/jpeg;base64,QUJD', dim: 40, blur: 6 });
  assert.equal(app.root.dataset.wallpaper, '');
  assert.deepEqual(app.props, { '--wallpaper-placeholder': 'url("data:image/jpeg;base64,QUJD")', '--wallpaper-dim': '40%', '--wallpaper-blur': '6px' });
  for (const cached of [undefined, { enabled: false, placeholder: 'data:image/jpeg;base64,QUJD' }, { enabled: true, placeholder: 'javascript:x' }]) {
    app = boot(cached);
    assert.equal(app.root.dataset.wallpaper, undefined);
  }
  app = boot({ enabled: true, placeholder: 'data:image/png;base64,QQ==', dim: 999, blur: 'x' });
  assert.equal(app.props['--wallpaper-dim'], '80%');
  assert.equal(app.props['--wallpaper-blur'], '0px');
});

test('the wallpaper boot script runs synchronously in <head>, and the page has the settings controls', () => {
  const html = fs.readFileSync(require.resolve('../../src/newtab/newtab.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script src="wallpaper-boot.js"><\/script>/);
  for (const id of ['wallpaper', 'wallpaper-image', 'wallpaper-file', 'wallpaper-dim', 'wallpaper-blur', 'remove-wallpaper', 'escape-close']) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('key hints live only in settings, and the list documents Shift+Enter', () => {
  const html = fs.readFileSync(require.resolve('../../src/newtab/newtab.html'), 'utf8');
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.doesNotMatch(main, /<kbd|class="hints"/, 'no hint bar under the search box');
  const keys = html.slice(html.indexOf('<dl class="key-list">'), html.indexOf('</dl>'));
  for (const text of ['<kbd>⇧</kbd><kbd>↵</kbd>', '默认搜索引擎', '连按两次', '后台新标签页打开', '快捷词']) assert.ok(keys.includes(text), text);
});
