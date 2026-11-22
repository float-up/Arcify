const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ originExists = true } = {}) {
  const handlers = {};
  const event = name => ({ addListener: fn => { (handlers[name] ||= []).push(fn); } });
  const session = { bindings: {}, peekWindows: { 20: { originWindowId: 10, tabId: 2 } } };
  const moves = [], tabUpdates = [], windowUpdates = [], windowsCreated = [];
  const chrome = {
    sidePanel: { setPanelBehavior() {} },
    commands: { onCommand: event('command') },
    storage: {
      local: { get: async () => ({ pins: [], folders: [], peekEnabled: true }), set: async () => {} },
      session: {
        get: async key => typeof key === 'string' ? { [key]: structuredClone(session[key]) } : structuredClone(session),
        set: async value => Object.assign(session, structuredClone(value))
      }
    },
    scripting: { executeScript: async () => {} },
    tabs: {
      query: async () => [], get: async () => null,
      move: async (id, options) => { moves.push({ id, ...options }); },
      update: async (id, options) => { tabUpdates.push({ id, ...options }); },
      sendMessage: async () => {},
      onRemoved: event('removed'), onDetached: event('detached'), onCreated: event('created'),
      onUpdated: event('updated'), onActivated: event('activated'), onMoved: event('moved'), onAttached: event('attached')
    },
    windows: {
      get: async id => {
        if (id === 10 && originExists) return { id: 10, type: 'normal' };
        throw new Error('missing');
      },
      update: async (id, options) => { windowUpdates.push({ id, ...options }); },
      create: async options => { windowsCreated.push(options); return { id: 30 }; },
      onRemoved: event('windowRemoved')
    },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async () => {} },
    webNavigation: { onCreatedNavigationTarget: event('navigation') }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), { chrome, console, URL, setTimeout, structuredClone });
  async function message(message, sender) {
    const listener = handlers.message[0];
    return new Promise(resolve => listener(message, sender, resolve));
  }
  return { message, session, moves, tabUpdates, windowUpdates, windowsCreated, handlers };
}

test('return button moves the existing popup tab back to its original normal window', async () => {
  const app = setup();
  const result = await app.message({ type: 'PEEK_RETURN' }, { tab: { id: 2, windowId: 20 }, frameId: 0 });
  assert.equal(result.returned, true);
  assert.deepEqual(app.moves, [{ id: 2, windowId: 10, index: -1 }]);
  assert.deepEqual(app.tabUpdates, [{ id: 2, active: true }]);
  assert.deepEqual(app.windowUpdates, [{ id: 10, focused: true }]);
  assert.deepEqual(app.windowsCreated, []);
  assert.equal(app.session.peekWindows[20], undefined);
});

test('return button creates a normal window with the same tab when the origin is gone', async () => {
  const app = setup({ originExists: false });
  const result = await app.message({ type: 'PEEK_RETURN' }, { tab: { id: 2, windowId: 20 }, frameId: 0 });
  assert.equal(result.returned, true);
  assert.deepEqual(app.moves, []);
  assert.deepEqual(structuredClone(app.windowsCreated), [{ tabId: 2, type: 'normal', focused: true }]);
  assert.equal(app.session.peekWindows[20], undefined);
});

test('return button is rejected for windows not created by the extension', async () => {
  const app = setup();
  const result = await app.message({ type: 'PEEK_RETURN' }, { tab: { id: 9, windowId: 99 }, frameId: 0 });
  assert.match(result.error, /不是插件创建/);
  assert.deepEqual(app.moves, []);
});
