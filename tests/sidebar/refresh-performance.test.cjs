const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('snapshot reads once and never moves real tabs during panel refresh', async () => {
  let queries = 0;
  const context = vm.createContext({ read: async () => ({ pins: [], folders: [], bindings: {} }), pendingNavigationTabs: new Set(), chrome: { tabs: { query: async () => { queries++; return []; } } } });
  const source = fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function snapshot('), source.indexOf('async function change(')), context);
  await context.snapshot(1);
  assert.equal(queries, 1);
});
test('hidden panels skip snapshots; concurrent refreshes share the in-flight request', async () => {
  let queries = 0, renders = 0, resolve;
  const timers = [];
  const context = vm.createContext({ document: { hidden: true }, refreshPending: false, refreshInFlight: false, refreshTimer: null, revision: 0,
    send: () => { queries++; return new Promise(done => { resolve = done; }); }, render: () => renders++, showError: error => { throw error; }, setTimeout: callback => { timers.push(callback); return 1; } });
  const source = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function refresh()'), source.indexOf('function button(')), context);
  await context.refresh(); assert.equal(queries, 0);
  context.document.hidden = false;
  const pending = context.refresh();
  await context.refresh(); await context.refresh();
  assert.equal(queries, 1);
  resolve({ pins: [], tabs: [] }); await pending;
  assert.equal(renders, 1);
  assert.equal(timers.length, 1);
});

test('Pin navigation reminder follows the bound tab and clears on return or close', async () => {
  const pins = [{ id: 'pin', title: 'My Pin', url: 'https://example.com/home', superPin: true }];
  let tabs = [{ id: 7, windowId: 1, url: pins[0].url }];
  const context = vm.createContext({
    read: async () => ({ pins, folders: [], bindings: { 1: { pin: 7 }, 2: { pin: 8 } } }),
    pendingNavigationTabs: new Set(),
    chrome: { tabs: { query: async ({ windowId }) => tabs.filter(tab => tab.windowId === windowId) } }
  });
  const source = fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function snapshot('), source.indexOf('async function change(')), context);
  for (const url of [pins[0].url, 'https://example.com/home/child', 'https://example.com/home?q=1', 'https://example.com/home#section', 'https://other.example/', pins[0].url]) {
    tabs[0].url = url;
    const pin = (await context.snapshot(1)).pins[0];
    assert.equal(pin.navigated, url !== pins[0].url);
    assert.equal(pin.currentUrl, url);
    assert.equal(pin.url, pins[0].url);
    assert.equal(pin.title, 'My Pin');
    assert.equal((await context.snapshot(2)).pins[0].navigated, false);
  }
  tabs = [];
  const closed = (await context.snapshot(1)).pins[0];
  assert.equal(closed.navigated, false);
  assert.equal(closed.currentUrl, '');
  assert.equal(pins[0].navigated, undefined, 'navigation state is not persisted into the Pin');
});
