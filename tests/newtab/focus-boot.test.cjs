const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function boot(href) {
  const replaced = [], states = [];
  const html = { dataset: {} };
  const context = vm.createContext({
    URL, location: { href, replace: url => replaced.push(url) },
    history: { state: { keep: true }, replaceState: (state, title, url) => states.push({ state, url }) },
    document: { documentElement: html },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../../src/newtab/focus-boot.js'), 'utf8'), context);
  return { replaced, states, html };
}
const BASE = 'chrome-extension://abc/src/newtab/newtab.html';

test('the overridden new tab replaces itself once (no history entry) and hides until then', () => {
  const app = boot(BASE);
  assert.deepEqual(app.replaced, [`${BASE}?arcify-focus=1`]);
  assert.equal(app.html.dataset.hop, '', 'body stays hidden: nothing half-rendered flashes');
  assert.deepEqual(app.states, []);
});

test('the focus-capable instance removes the marker and keeps other parameters', () => {
  let app = boot(`${BASE}?arcify-focus=1`);
  assert.deepEqual(app.replaced, []);
  assert.deepEqual(JSON.parse(JSON.stringify(app.states)), [{ state: { keep: true }, url: '/src/newtab/newtab.html' }]);
  assert.equal(app.html.dataset.hop, undefined);
  app = boot(`${BASE}?q=1&arcify-focus=1#x`);
  assert.equal(app.states[0].url, '/src/newtab/newtab.html?q=1#x');
});

test('the manifest overrides the new tab page and loads focus-boot synchronously before any stylesheet', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../../manifest.json'), 'utf8'));
  assert.equal(manifest.chrome_url_overrides.newtab, 'src/newtab/newtab.html');
  for (const permission of ['history', 'bookmarks', 'topSites', 'favicon', 'search']) assert.ok(manifest.permissions.includes(permission), permission);
  const html = fs.readFileSync(require.resolve('../../src/newtab/newtab.html'), 'utf8');
  const bootAt = html.indexOf('<script src="focus-boot.js"></script>');
  assert.ok(bootAt > 0 && bootAt < html.indexOf('<link rel="stylesheet"'), 'boot runs before CSS is requested');
  assert.doesNotMatch(html.slice(0, bootAt), /type="module"|defer|async/);
  assert.match(html, /<input id="query"[^>]*autofocus/);
});
