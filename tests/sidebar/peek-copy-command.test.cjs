const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ popup = true } = {}) {
  const handlers = {}, messages = [];
  const event = name => ({ addListener: fn => { (handlers[name] ||= []).push(fn); } });
  const chrome = {
    sidePanel: { setPanelBehavior() {} },
    commands: { onCommand: event('command') },
    storage: {
      local: { get: async () => ({ pins: [], folders: [] }), set: async () => {} },
      session: { get: async key => key === 'peekWindows' ? { peekWindows: popup ? { 20: { tabId: 2, originWindowId: 10 } } : {} } : {}, set: async () => {} }
    },
    tabs: {
      query: async query => query.lastFocusedWindow ? [{ id: 2, windowId: 20, active: true }] : [],
      sendMessage: async (id, message) => { messages.push({ id, message }); },
      get: async () => null,
      onRemoved: event('removed'), onDetached: event('detached'), onCreated: event('created'),
      onUpdated: event('updated'), onActivated: event('activated'), onMoved: event('moved'), onAttached: event('attached')
    },
    windows: { get: async () => null, onRemoved: event('windowRemoved') },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async () => {} },
    webNavigation: { onCreatedNavigationTarget: event('navigation') }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), { chrome, console, URL, setTimeout });
  return { handlers, messages };
}

test('copy shortcut targets only the active extension popup tab', async () => {
  const popup = setup();
  popup.handlers.command[0]('copy-peek-url');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(structuredClone(popup.messages), [{ id: 2, message: { type: 'PEEK_COPY_URL' } }]);

  const normal = setup({ popup: false });
  normal.handlers.command[0]('copy-peek-url');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(normal.messages, []);
});

test('manifest registers the cross-platform copy shortcut and clipboard permission', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../../manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('clipboardWrite'));
  assert.equal(manifest.commands['copy-peek-url'].suggested_key.mac, 'Command+Shift+L');
  assert.equal(manifest.commands['copy-peek-url'].suggested_key.default, 'Ctrl+Shift+L');
});
