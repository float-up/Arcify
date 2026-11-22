const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const settle = () => new Promise(resolve => setImmediate(resolve));
function worker({ local = {}, session = {}, tabs = [], permitted = true, registered = [] } = {}) {
  const handlers = {}, calls = [];
  const event = name => ({ addListener: fn => { (handlers[name] ||= []).push(fn); } });
  const localStore = { pins: [], folders: [], ...local }, sessionStore = { bindings: {}, ...session };
  const storage = values => ({
    get: async keys => keys == null ? structuredClone(values) : Object.fromEntries([].concat(keys).filter(key => key in values).map(key => [key, structuredClone(values[key])])),
    set: async value => Object.assign(values, structuredClone(value))
  });
  let scripts = [...registered];
  const chrome = {
    sidePanel: { setPanelBehavior() {} },
    storage: { local: storage(localStore), session: storage(sessionStore), onChanged: event('storage') },
    permissions: { contains: async () => permitted, onRemoved: event('permissionsRemoved') },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => scripts.filter(id => ids.includes(id)).map(id => ({ id })),
      registerContentScripts: async list => { calls.push(['register', list.map(item => item.id)]); scripts.push(...list.map(item => item.id)); },
      updateContentScripts: async list => calls.push(['update', list.map(item => item.id)]),
      unregisterContentScripts: async ({ ids }) => { calls.push(['unregister', ids]); scripts = scripts.filter(id => !ids.includes(id)); },
      executeScript: async () => {}
    },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async message => calls.push(['broadcast', message]), getURL: path => `chrome-extension://abc/${path}` },
    tabs: {
      SPLIT_VIEW_ID_NONE: -1,
      query: async query => tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active)).map(tab => ({ ...tab })),
      get: async id => { const tab = tabs.find(item => item.id === id); if (!tab) throw new Error('missing'); return { ...tab }; },
      move: async (ids, options) => calls.push(['move', ids, options.index]),
      remove: async ids => calls.push(['remove', ids]), update: async () => ({}), sendMessage: async () => {},
      onCreated: event('created'), onActivated: event('activated'), onUpdated: event('updated'), onMoved: event('moved'), onAttached: event('attached'), onDetached: event('detached'), onRemoved: event('removed')
    },
    windows: { get: async () => ({ type: 'normal', width: 1440, height: 900 }), create: async options => { calls.push(['window', options]); return { id: 99 }; }, onRemoved: event('windowRemoved') },
    webNavigation: { onCreatedNavigationTarget: event('navigation') }
  };
  const context = vm.createContext({ chrome, console, URL, crypto: { randomUUID }, setTimeout, structuredClone });
  vm.runInContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), context);
  const send = (message, sender = {}) => new Promise(resolve => handlers.message[0](message, sender, resolve));
  const fire = (name, ...args) => handlers[name].forEach(fn => fn(...args));
  return { handlers, calls, send, fire, scripts: () => scripts, run: vm.runInContext('run', context), context, localStore, sessionStore };
}

test('turning the floating window off unregisters the page scripts', async () => {
  const app = worker({ registered: ['peek-links', 'peek-open'], local: { peekEnabled: false } });
  app.fire('storage', { peekEnabled: { oldValue: true, newValue: false } }, 'local');
  await app.run(async () => {});
  assert.deepEqual(app.scripts(), []);
  // Unrelated storage changes do nothing.
  app.fire('storage', { pins: {} }, 'local');
  await app.run(async () => {});
  assert.equal(app.calls.filter(call => call[0] === 'unregister').length, 1);
});

test('startup and permission removal also clean up when the feature cannot run', async () => {
  let app = worker({ registered: ['peek-links', 'peek-open'], local: { peekEnabled: true }, permitted: false });
  app.fire('permissionsRemoved', { origins: ['https://*/*'] });
  await app.run(async () => {});
  assert.deepEqual(app.scripts(), []);
  app = worker({ registered: ['peek-links'], local: { peekEnabled: false } });
  app.fire('startup');
  await settle(); await app.run(async () => {});
  assert.deepEqual(app.scripts(), []);
  app = worker({ local: { peekEnabled: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(await app.send({ type: 'PREPARE_PEEK' }))), {});
  assert.deepEqual(app.scripts().sort(), ['peek-links', 'peek-open']);
});

test('links opened from ordinary tabs are shown at once and placed next to the active tab', async () => {
  const tabs = [{ id: 1, windowId: 10, index: 0, active: true }, { id: 2, windowId: 10, index: 1 }, { id: 3, windowId: 10, index: 2 }];
  const app = worker({ tabs, local: { peekEnabled: true }, session: { bindings: { 10: { pin: 7 } } } });
  app.fire('activated', { windowId: 10, tabId: 1 });
  const created = { id: 3, windowId: 10, index: 2, active: false, openerTabId: 1 };
  app.fire('created', created);
  app.fire('navigation', { tabId: 3, sourceTabId: 1, url: 'https://example.com/' });
  await settle(); await app.run(async () => {}); await settle();
  assert.deepEqual(app.calls.filter(call => call[0] === 'move'), [['move', 3, 1]], 'repositioned beside its opener');
  assert.equal(app.calls.some(call => call[0] === 'window'), false);
  const snapshot = await app.send({ type: 'GET_SNAPSHOT', windowId: 10 });
  assert.deepEqual(snapshot.data.tabs.map(tab => tab.id), [1, 2, 3], 'not hidden as a pending floating window');
});

test('links from a Pin page with the feature on still become floating windows', async () => {
  const tabs = [{ id: 1, windowId: 10, index: 0 }, { id: 3, windowId: 10, index: 1, active: true }];
  const app = worker({ tabs, local: { peekEnabled: true }, session: { bindings: { 10: { pin: 1 } } } });
  app.fire('created', { id: 3, windowId: 10, index: 1, active: true });
  app.fire('navigation', { tabId: 3, sourceTabId: 1, url: 'https://example.com/' });
  // The worker hands off through a real timer; wait for the outcome instead of counting ticks.
  for (let attempt = 0; attempt < 50 && !app.calls.some(call => call[0] === 'window'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2)); await app.run(async () => {});
  }
  const popup = app.calls.find(call => call[0] === 'window');
  assert.equal(popup?.[1].tabId, 3);
  assert.equal(popup[1].type, 'popup');
});

test('Pin ordering leaves split tabs in place and ignores split pairs between Pins', async () => {
  const pins = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }, { id: 'c', order: 2 }];
  let app = worker({ local: { pins }, session: { bindings: { 10: { a: 1, b: 2, c: 5 } } }, tabs: [
    { id: 1, windowId: 10, index: 0 }, { id: 3, windowId: 10, index: 1, splitViewId: 4 }, { id: 4, windowId: 10, index: 2, splitViewId: 4 },
    { id: 2, windowId: 10, index: 3 }, { id: 5, windowId: 10, index: 4, splitViewId: 8 }, { id: 6, windowId: 10, index: 5, splitViewId: 8 }
  ] });
  app.fire('moved', 1, { windowId: 10 });
  await settle(); await app.run(async () => {});
  assert.deepEqual(app.calls.filter(call => call[0] === 'move'), [], 'already ordered once split tabs are skipped');

  app = worker({ local: { pins }, session: { bindings: { 10: { a: 1, b: 2, c: 5 } } }, tabs: [
    { id: 2, windowId: 10, index: 0 }, { id: 1, windowId: 10, index: 1 }, { id: 5, windowId: 10, index: 2, splitViewId: 8 }, { id: 6, windowId: 10, index: 3, splitViewId: 8 }
  ] });
  app.fire('moved', 1, { windowId: 10 });
  await settle(); await app.run(async () => {});
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.filter(call => call[0] === 'move'))), [['move', [1, 2], 0]], 'split Pin tab 5 is never moved');
});

test('Pin and tab operations are refused from content scripts', async () => {
  const app = worker({ tabs: [{ id: 1, windowId: 10, index: 0 }, { id: 2, windowId: 10, index: 1 }] });
  const page = { tab: { id: 1, windowId: 10 }, frameId: 0, url: 'https://evil.example/' };
  for (const type of ['CLEAR_TABS', 'GET_SNAPSHOT', 'PREPARE_PEEK']) {
    assert.match((await app.send({ type, windowId: 10 }, page)).error, /不支持/);
  }
  assert.equal(app.calls.some(call => call[0] === 'remove'), false);
  const extensionTab = { tab: { id: 2, windowId: 10 }, url: 'chrome-extension://abc/sidepanel.html' };
  assert.ok((await app.send({ type: 'GET_SNAPSHOT', windowId: 10 }, extensionTab)).data);
  assert.ok((await app.send({ type: 'GET_SNAPSHOT', windowId: 10 }, {})).data, 'the side panel has no tab');
});

test('closing a tab refreshes only that window panel', async () => {
  const app = worker({ session: { bindings: { 10: { pin: 1 } } } });
  app.fire('removed', 1, { windowId: 10, isWindowClosing: false });
  await app.run(async () => {});
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.filter(call => call[0] === 'broadcast').map(call => call[1]))), [{ type: 'CHANGED', windowId: 10 }]);
  assert.deepEqual(app.sessionStore.bindings, { 10: {} });
});

test('floating window toolbar host resists page CSS', async () => {
  const { createDocument } = require('../helpers/fake-dom.cjs');
  const document = createDocument();
  const chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => ({ popup: true }) }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), { chrome, document, URL, location: { href: 'https://example.com/' } });
  await settle();
  const host = document.documentElement.children[0];
  assert.match(host.style.cssText, /position:fixed!important/);
  assert.match(host.style.cssText, /transform:translateX\(-50%\)!important/);
});

test('the sidebar worker leaves namespaced messages (newtab:*) to their own module', async () => {
  const app = worker();
  let answered = false;
  const keep = app.handlers.message[0]({ type: 'newtab:open', url: 'https://x.com/' }, {}, () => { answered = true; });
  await app.run(async () => {});
  assert.equal(keep, undefined);
  assert.equal(answered, false);
});
