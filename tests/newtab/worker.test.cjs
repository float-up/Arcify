const { test } = require('node:test');
const assert = require('node:assert/strict');

// The worker module imports search.js, so it is loaded as a real ES module with a fake `chrome`.
async function setup() {
  const listeners = [], calls = [];
  const local = {};
  globalThis.chrome = {
    runtime: { getURL: path => `chrome-extension://abc/${path}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, structuredClone(value)) } },
    tabs: { create: async options => calls.push(['create', options]), update: async (id, options) => calls.push(['update', id, options]) },
    search: { query: async options => calls.push(['search', options]) },
  };
  await import(`../../src/background/newtab.js?${Math.random()}`);
  const send = (message, sender) => new Promise(resolve => { const keep = listeners[0](message, sender, resolve); if (keep !== true) resolve(undefined); });
  return { send, calls, local };
}
const page = { tab: { id: 7, windowId: 1, index: 3 }, url: 'chrome-extension://abc/src/newtab/newtab.html' };

test('opening a result counts it and navigates the new tab itself; ⌘Enter opens a background tab next to it', async () => {
  const app = await setup();
  assert.deepEqual(await app.send({ type: 'newtab:open', url: 'https://github.com/', title: 'GitHub', record: true }, page), { ok: true });
  await app.send({ type: 'newtab:open', url: 'https://github.com/', title: 'GitHub', record: true, newTab: true }, page);
  assert.equal(app.local.newtabFrequent['github.com'].count, 2);
  assert.deepEqual(app.calls, [['update', 7, { url: 'https://github.com/' }], ['create', { url: 'https://github.com/', active: false, windowId: 1, index: 4 }]]);
});

test('searches use the default search engine in the same tab; unrecorded URLs are not counted', async () => {
  const app = await setup();
  await app.send({ type: 'newtab:search', text: 'arc browser' }, page);
  await app.send({ type: 'newtab:open', url: 'https://github.com/search?q=x', record: false }, page);
  assert.deepEqual(app.calls[0], ['search', { text: 'arc browser', tabId: 7 }]);
  assert.equal(app.local.newtabFrequent, undefined);
});

test('only the new tab page may send newtab messages; other modules\' messages are ignored', async () => {
  const app = await setup();
  assert.match((await app.send({ type: 'newtab:open', url: 'https://x.com/' }, { tab: page.tab, url: 'https://evil.example/' })).error, /不支持/);
  assert.equal(await app.send({ type: 'GET_SNAPSHOT' }, page), undefined);
  assert.match((await app.send({ type: 'newtab:open', url: 'javascript:alert(1)' }, page)).error, /无法打开/);
  assert.deepEqual(app.calls, []);
});
