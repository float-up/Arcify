const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function simulate({ initialActive, currentActive, enabled = true, pinned = true, sameWindow = true, directOpenCount = 0, navigate = true, metadataFails = false, peekSize, createdActive }) {
  const handlers = {};
  const event = name => ({ addListener: fn => { handlers[name] = fn; } });
  const created = [], removed = [];
  let targetReads = 0;
  const source = { id: 1, windowId: 10 };
  const chrome = {
    sidePanel: { setPanelBehavior() {} },
    storage: {
      local: { get: async key => key === 'peekEnabled' ? { peekEnabled: enabled } : key === 'peekSize' ? { peekSize } : { pins: [], folders: [] }, set: async () => {} },
      session: { get: async () => ({ bindings: pinned ? { 10: { pin: 1 } } : {} }), set: async () => { if (metadataFails) throw new Error('session write failed'); } }
    },
    scripting: { executeScript: async () => {} },
    tabs: {
      query: async () => [],
      get: async id => id === 1 ? source : { id: 2, windowId: sameWindow ? 10 : 11, active: targetReads++ === 0 ? initialActive : currentActive },
      remove: async id => { removed.push(id); },
      create: async () => { created.push({ fallback: true }); },
      onRemoved: event('removed'), onDetached: event('detached'), onCreated: event('created'),
      onUpdated: event('updated'), onActivated: event('activated'), onMoved: event('moved'), onAttached: event('attached')
    },
    windows: { get: async () => ({ type: 'normal', width: 1440, height: 900, left: 0, top: 0 }), create: async options => { created.push(options); if (metadataFails) return { id: 20, tabs: [{ id: 2 }] }; }, onRemoved: event('windowRemoved') },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async () => {} },
    webNavigation: { onCreatedNavigationTarget: event('navigation') }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), { chrome, console, setTimeout: (fn, ms) => { if (!(ms > 1000)) fn(); } });
  for (let index = 0; index < directOpenCount; index++) {
    await new Promise(resolve => handlers.message({ type: 'PEEK_OPEN', url: 'https://example.com/' }, { tab: source, frameId: 0 }, resolve));
  }
  if (createdActive !== undefined) handlers.created({ id: 2, windowId: 10, active: createdActive });
  if (navigate) handlers.navigation({ tabId: 2, sourceTabId: 1, url: 'https://example.com/' });
  await new Promise(resolve => setImmediate(resolve));
  return { created, removed };
}
test('foreground tab is converted even if activation follows creation', async () => {
  const { created } = await simulate({ initialActive: false, currentActive: true });
  assert.equal(created.length, 1);
  // Default size: 80% × 85% of the 1440 × 900 browser window, centered on it.
  assert.deepEqual({ width: created[0].width, height: created[0].height, left: created[0].left, top: created[0].top }, { width: 1152, height: 765, left: 144, top: 68 });
});
test('background tab stays in its window', async () => {
  assert.equal((await simulate({ initialActive: false, currentActive: false })).created.length, 0);
});
test('disabled, non-pin and separate-window navigation stay unchanged', async () => {
  for (const options of [{ enabled: false }, { pinned: false }, { sameWindow: false }]) {
    assert.equal((await simulate({ initialActive: true, currentActive: true, ...options })).created.length, 0);
  }
});
test('same-URL navigation after a popup never deletes a user-created tab', async () => {
  for (const options of [{ initialActive: false, currentActive: false }, { initialActive: true, currentActive: true, sameWindow: false }, { initialActive: true, currentActive: true }]) {
    const { removed } = await simulate({ ...options, directOpenCount: 1 });
    assert.deepEqual(removed, []);
  }
});
test('separate user clicks are not deduplicated', async () => {
  const { created, removed } = await simulate({ initialActive: true, currentActive: true, directOpenCount: 2, navigate: false });
  assert.equal(created.length, 2);
  assert.deepEqual(removed, []);
});

test('popup metadata failure does not create a second copy of an opened page', async () => {
  const { created } = await simulate({ directOpenCount: 1, navigate: false, metadataFails: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'popup');
});

test('floating window size follows the settings percentage and is clamped', async () => {
  let { created } = await simulate({ initialActive: true, currentActive: true, peekSize: { width: 50, height: 60 } });
  assert.deepEqual({ width: created[0].width, height: created[0].height }, { width: 720, height: 540 });
  ({ created } = await simulate({ initialActive: true, currentActive: true, peekSize: { width: 500, height: 'x' } }));
  assert.deepEqual({ width: created[0].width, height: created[0].height }, { width: 1440, height: 765 });
  ({ created } = await simulate({ directOpenCount: 1, navigate: false, peekSize: { width: 40, height: 40 } }));
  assert.deepEqual({ width: created[0].width, height: created[0].height, url: created[0].url }, { width: 576, height: 360, url: 'https://example.com/' });
});

test('a tab created in the foreground is moved without waiting for Chrome to report it active', async () => {
  assert.equal((await simulate({ initialActive: false, currentActive: false, createdActive: true })).created.length, 1);
  assert.equal((await simulate({ initialActive: false, currentActive: false, createdActive: false })).created.length, 0);
});
