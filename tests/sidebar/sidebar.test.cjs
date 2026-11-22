const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function setup({ pins = [], folders = [], bindings = {}, tabs = [] } = {}) {
  const handlers = {}, removed = [], moves = [], created = [];
  const event = name => ({ addListener(fn) { (handlers[name] ||= []).push(fn); } });
  const local = { pins, folders }, session = { bindings };
  const storage = values => ({ get: async () => structuredClone(values), set: async value => Object.assign(values, structuredClone(value)) });
  const chrome = {
    sidePanel: { setPanelBehavior() {} }, storage: { local: storage(local), session: storage(session) },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async () => {} },
    tabs: {
      query: async query => tabs.filter(tab => (!query.windowId || tab.windowId === query.windowId) && (!query.active || tab.active)),
      get: async id => { const tab = tabs.find(item => item.id === id); if (!tab) throw new Error('missing'); return { ...tab }; },
      create: async options => {
        const tab = { id: Math.max(0, ...tabs.map(item => item.id)) + 1, index: tabs.filter(item => item.windowId === options.windowId).length, ...options };
        tabs.push(tab); created.push({ ...options }); return { ...tab };
      },
      remove: async ids => removed.push(...[].concat(ids)), update: async (id, options) => ({ id, ...options }), move: async (id, options) => moves.push({ id, ...options }), sendMessage: async () => {},
      onCreated: event('created'), onActivated: event('activated'), onUpdated: event('updated'), onMoved: event('moved'), onAttached: event('attached'), onDetached: event('detached'), onRemoved: event('removed')
    },
    windows: { get: async () => ({ type: 'normal' }), onRemoved: event('windowRemoved') },
    webNavigation: { onCreatedNavigationTarget: event('navigation') }
  };
  const context = vm.createContext({ chrome, console, URL, crypto: { randomUUID }, setTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), context);
  const api = vm.runInContext('({ change, mergeBackup, run })', context);
  return { ...api, local, session, removed, moves, created, handlers, chrome, context };
}
test('Clear protects active, Sidebar Pin and native pinned tabs in current window', async () => {
  const app = setup({ bindings: { 10: { pin: 2 } }, tabs: [
    { id: 1, windowId: 10, active: true }, { id: 2, windowId: 10 },
    { id: 3, windowId: 10 }, { id: 4, windowId: 11 }, { id: 5, windowId: 10, pinned: true }
  ] });
  await app.change({ type: 'CLEAR_TABS', windowId: 10 });
  assert.deepEqual(app.removed, [3]);
});
test('backup roundtrip preserves nested folders; repeated merge is idempotent', () => {
  const app = setup();
  const backup = { format: 'Sidebar', version: 1, folders: [
    { id: 'child', name: 'Child', parentId: 'root', expanded: false }, { id: 'root', name: 'Root' }
  ], pins: [{ id: 'pin', url: 'chrome://extensions/', folderId: 'child' }] };
  const first = app.mergeBackup([], [], backup);
  const second = app.mergeBackup(first.pins, first.folders, backup);
  assert.equal(second.pins.length, 1);
  assert.equal(second.folders.length, 2);
  const child = first.folders.find(folder => folder.name === 'Child');
  assert.equal(child.parentId, first.folders.find(folder => folder.name === 'Root').id);
  assert.equal(child.expanded, false);
  assert.equal(first.pins[0].folderId, child.id);
  backup.folders[1].parentId = 'child';
  assert.throws(() => app.mergeBackup([], [], backup), /层级/);
});
test('folders reject cycles and promote retained children when deleted', async () => {
  const app = setup({ folders: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'b' }], pins: [{ id: 'pin', folderId: 'b' }] });
  await assert.rejects(app.change({ type: 'MOVE_FOLDER', windowId: 10, folderId: 'a', parentId: 'c' }), /子文件夹/);
  await app.change({ type: 'DELETE_FOLDER', windowId: 10, folderId: 'b' });
  assert.equal(app.local.folders.find(folder => folder.id === 'c').parentId, 'a');
  assert.equal(app.local.pins[0].folderId, 'a');
});
test('Pin display name can be changed without changing its URL or binding', async () => {
  const app = setup({
    pins: [{ id: 'pin', title: 'Original', url: 'https://example.com/' }],
    bindings: { 10: { pin: 7 } },
    tabs: [{ id: 7, windowId: 10, index: 0, url: 'https://example.com/' }]
  });
  await app.change({ type: 'UPDATE_PIN', windowId: 10, pinId: 'pin', name: '  My Page  ' });
  assert.equal(app.local.pins[0].title, 'My Page');
  assert.equal(app.local.pins[0].url, 'https://example.com/');
  assert.equal(app.session.bindings[10].pin, 7);
  await assert.rejects(app.change({ type: 'UPDATE_PIN', windowId: 10, pinId: 'pin', name: '   ' }), /不能为空/);
});
test('chrome internal pages can be pinned and move to the front of normal tabs', async () => {
  const app = setup({ tabs: [
    { id: 1, windowId: 10, index: 0, pinned: true, url: 'https://native.example/' },
    { id: 2, windowId: 10, index: 1, url: 'https://ordinary.example/' },
    { id: 3, windowId: 10, index: 2, url: 'chrome://extensions/', title: '扩展程序' }
  ] });
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 3 });
  assert.equal(app.local.pins[0].url, 'chrome://extensions/');
  assert.deepEqual(app.moves, [{ id: [3], index: 1 }]);
});
test('closed chrome internal Pin reopens as a real tab', async () => {
  const app = setup({ pins: [{ id: 'extensions', url: 'chrome://extensions/' }], bindings: { 10: {} }, tabs: [
    { id: 1, windowId: 10, index: 0, url: 'https://ordinary.example/' }
  ] });
  await app.change({ type: 'OPEN_PIN', windowId: 10, pinId: 'extensions' });
  assert.deepEqual(app.created, [{ windowId: 10, url: 'chrome://extensions/' }]);
  assert.deepEqual(app.moves, [{ id: [2], index: 0 }]);
});
test('open Sidebar Pins follow Pin order at the front of normal tabs', async () => {
  const pins = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const app = setup({ pins, bindings: { 10: { one: 11, two: 12, three: 13 } }, tabs: [
    { id: 20, windowId: 10, index: 0, pinned: true },
    { id: 11, windowId: 10, index: 3 }, { id: 12, windowId: 10, index: 1 },
    { id: 13, windowId: 10, index: 4 }, { id: 21, windowId: 10, index: 2 }
  ] });
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: 'three', index: 0 });
  assert.deepEqual(app.moves, [{ id: [13, 11, 12], index: 1 }]);
});
test('new foreground and background tabs are placed right of the previous active tab', async () => {
  for (const active of [true, false]) {
    const app = setup({ tabs: [{ id: 1, windowId: 10, index: 2, active: true }, { id: 2, windowId: 10, index: 8, active }] });
    for (const handler of app.handlers.activated) handler({ tabId: 1, windowId: 10 });
    for (const handler of app.handlers.created) handler({ id: 2, windowId: 10 });
    if (active) for (const handler of app.handlers.activated) handler({ tabId: 2, windowId: 10 });
    await app.run(async () => {});
    assert.deepEqual(app.moves, [{ id: 2, index: 3 }]);
  }
});
test('new ordinary tabs stay after the open Sidebar Pin block', async () => {
  const app = setup({ pins: [{ id: 'one' }, { id: 'two' }], bindings: { 10: { one: 1, two: 2 } }, tabs: [
    { id: 1, windowId: 10, index: 0, active: true }, { id: 2, windowId: 10, index: 1 },
    { id: 3, windowId: 10, index: 5 }
  ] });
  for (const handler of app.handlers.activated) handler({ tabId: 1, windowId: 10 });
  for (const handler of app.handlers.created) handler({ id: 3, windowId: 10 });
  await app.run(async () => {});
  assert.deepEqual(app.moves, [{ id: 3, index: 2 }]);
});

test('top Pin placement persists, survives backup, and clears when moved to a folder', async () => {
  const app = setup({ folders: [{ id: 'folder', name: 'Folder' }], tabs: [{ id: 42, windowId: 10, url: 'https://example.com' }] });
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 42, index: 0, beforeFolders: true });
  const pin = app.local.pins[0];
  assert.equal(pin.folderId, null);
  assert.equal(pin.beforeFolders, true);
  const restored = app.mergeBackup([], [], { format: 'Sidebar', version: 1, pins: app.local.pins, folders: app.local.folders });
  assert.equal(restored.pins[0].beforeFolders, true);
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: pin.id, folderId: 'folder', index: 0 });
  assert.equal(app.local.pins[0].beforeFolders, false);
  assert.equal(app.local.pins[0].folderId, 'folder');
});

test('Tabs insert on either side of a folder between mixed siblings and retain their order', async () => {
  const app = setup({
    pins: [{ id: 'a', url: 'https://a.test', order: 0 }, { id: 'b', url: 'https://b.test', order: 2 }],
    folders: [{ id: 'folder', name: 'Folder', order: 1 }],
    tabs: [{ id: 41, windowId: 10, url: 'https://new.test' }, { id: 42, windowId: 10, url: 'https://after.test' }]
  });
  const sequence = () => [...app.local.pins, ...app.local.folders].sort((a, b) => a.order - b.order).map(item => item.url || item.name);
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 41, index: 2, placement: { kind: 'folder', id: 'folder', side: 'before' } });
  assert.deepEqual(sequence(), ['https://a.test', 'https://new.test', 'Folder', 'https://b.test']);
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 42, index: 3, placement: { kind: 'folder', id: 'folder', side: 'after' } });
  assert.deepEqual(sequence(), ['https://a.test', 'https://new.test', 'Folder', 'https://after.test', 'https://b.test']);
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: 'b', index: 0, placement: { kind: 'pin', id: 'a', side: 'after' } });
  assert.deepEqual(sequence(), ['https://a.test', 'https://b.test', 'https://new.test', 'Folder', 'https://after.test']);
  const restored = app.mergeBackup([], [], { format: 'Sidebar', version: 1, pins: app.local.pins, folders: app.local.folders });
  assert.deepEqual([...restored.pins, ...restored.folders].sort((a, b) => a.order - b.order).map(item => item.url || item.name), sequence());
});

test('nested folder boundaries keep dropped Tabs in the parent level', async () => {
  const app = setup({ folders: [{ id: 'parent', name: 'Parent', order: 0 }, { id: 'child', parentId: 'parent', name: 'Child', order: 0 }], tabs: [{ id: 42, windowId: 10, url: 'https://new.test' }] });
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 42, folderId: 'parent', placement: { kind: 'folder', id: 'child', side: 'before' } });
  assert.equal(app.local.pins[0].folderId, 'parent');
  assert.ok(app.local.pins[0].order < app.local.folders.find(item => item.id === 'child').order);
});

test('super Pins preserve identity and bindings when moving between the icon area and folders', async () => {
  const app = setup({ folders: [{ id: 'folder', name: 'Folder' }], tabs: [{ id: 42, windowId: 10, url: 'chrome://extensions/', title: 'Extensions' }] });
  await app.change({ type: 'PIN_TAB', windowId: 10, tabId: 42, superPin: true });
  const id = app.local.pins[0].id;
  assert.equal(app.local.pins[0].superPin, true);
  assert.equal(app.session.bindings[10][id], 42);
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: id, folderId: 'folder', index: 0 });
  assert.equal(app.local.pins[0].superPin, false);
  assert.equal(app.local.pins[0].folderId, 'folder');
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: id, index: 0, superPin: true });
  assert.equal(app.local.pins[0].folderId, null);
  assert.equal(app.local.pins[0].title, 'Extensions');
  assert.equal(app.session.bindings[10][id], 42);
  await app.change({ type: 'UNPIN', windowId: 10, pinId: id });
  assert.equal(app.local.pins.length, 0);
  assert.equal(app.created.length, 0);
});

test('full icon area rejects incoming Tabs and Pins but permits internal reordering', async () => {
  const pins = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, url: `https://s${i}.test`, superPin: true, order: i }));
  pins.push({ id: 'ordinary', url: 'https://ordinary.test' });
  const app = setup({ pins, tabs: [{ id: 42, windowId: 10, url: 'https://new.test' }] });
  await assert.rejects(app.change({ type: 'PIN_TAB', windowId: 10, tabId: 42, superPin: true }), /8/);
  await assert.rejects(app.change({ type: 'REORDER_PIN', windowId: 10, pinId: 'ordinary', superPin: true }), /8/);
  assert.equal(app.local.pins.length, 9);
  assert.equal(app.local.pins.find(pin => pin.id === 'ordinary').superPin, undefined);
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: 's7', superPin: true, placement: { kind: 'pin', id: 's0', side: 'before' } });
  assert.equal(app.local.pins[0].id, 's7');
  assert.equal(app.local.pins.filter(pin => pin.superPin).length, 8);
});

test('super Pin backups preserve presentation and keep overflow as ordinary Pins', () => {
  const app = setup();
  const backup = { format: 'Sidebar', version: 1, folders: [], pins: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, url: `https://s${i}.test`, superPin: true, order: i })) };
  const restored = app.mergeBackup([], [], backup);
  assert.equal(restored.pins.length, 10);
  assert.equal(restored.pins.filter(pin => pin.superPin).length, 8);
  assert.equal(restored.pins[7].order, 7);
  assert.equal(app.mergeBackup(restored.pins, [], backup).pins.length, 10);
});


test('ordinary tab actions do not rewrite Pin data or session bindings', async () => {
  const app = setup({ tabs: [{ id: 1, windowId: 10 }] });
  const writes = [];
  app.chrome.storage.local.set = async value => writes.push(value);
  app.chrome.storage.session.set = async value => writes.push(value);
  for (const type of ['ACTIVATE_TAB', 'MOVE_TAB', 'CLOSE_TAB', 'CLEAR_TABS']) {
    await app.change({ type, windowId: 10, tabId: 1, index: 0 });
  }
  assert.deepEqual(writes, []);
});

test('Pin binding survives tab move failure and reopening reuses the tab', async () => {
  const app = setup({ pins: [{ id: 'p', url: 'https://example.com/' }], tabs: [{ id: 1, windowId: 10, index: 0 }] });
  app.chrome.tabs.move = async () => { throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); };
  await app.change({ type: 'OPEN_PIN', windowId: 10, pinId: 'p' });
  assert.equal(app.session.bindings[10].p, 2);
  await app.change({ type: 'OPEN_PIN', windowId: 10, pinId: 'p' });
  assert.equal(app.created.length, 1);
});

test('reordering shared Pins updates real tab order in every bound window', async () => {
  const app = setup({ pins: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }], bindings: { 10: { a: 1, b: 2 }, 11: { a: 3, b: 4 } }, tabs: [
    { id: 1, windowId: 10, index: 0 }, { id: 2, windowId: 10, index: 1 },
    { id: 3, windowId: 11, index: 0 }, { id: 4, windowId: 11, index: 1 }
  ] });
  await app.change({ type: 'REORDER_PIN', windowId: 10, pinId: 'b', index: 0, placement: { kind: 'pin', id: 'a', side: 'before' } });
  assert.deepEqual(app.moves.map(move => move.id), [[2, 1], [4, 3]]);
});

test('closing an ordinary tab does not rewrite unrelated Pin bindings', async () => {
  const app = setup();
  const writes = [];
  app.chrome.storage.session.set = async value => writes.push(value);
  for (const handler of app.handlers.removed) handler(42, { windowId: 10 });
  await app.run(async () => {});
  assert.deepEqual(writes, []);
});

test('failed Pin close preserves the live binding', async () => {
  const app = setup({ pins: [{ id: 'p' }], bindings: { 10: { p: 1 } }, tabs: [{ id: 1, windowId: 10 }] });
  app.chrome.tabs.remove = async () => { throw new Error('temporarily unavailable'); };
  await assert.rejects(app.change({ type: 'CLOSE_PIN', windowId: 10, pinId: 'p' }), /temporarily/);
  assert.equal(app.session.bindings[10].p, 1);
});

test('a burst of moved events queries tab order once per window', async () => {
  const app = setup({ pins: [{ id: 'p' }], bindings: { 10: { p: 1 } }, tabs: [{ id: 1, windowId: 10, index: 0 }] });
  let queries = 0;
  app.chrome.tabs.query = async () => { queries++; return [{ id: 1, windowId: 10, index: 0 }]; };
  for (let i = 0; i < 100; i++) for (const handler of app.handlers.moved) handler(1, { windowId: 10 });
  await app.run(async () => {});
  assert.equal(queries, 1);
});

test('binding changes notify only affected pages and rename sends no page messages', async () => {
  const app = setup({ pins: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }], bindings: { 10: { a: 1, b: 2 } }, tabs: [
    { id: 1, windowId: 10, index: 0 }, { id: 2, windowId: 10, index: 1 }
  ] });
  const messages = [];
  app.chrome.tabs.sendMessage = async (id, message) => messages.push({ id, message });
  await app.change({ type: 'UPDATE_PIN', windowId: 10, pinId: 'a', name: 'Renamed' });
  assert.deepEqual(messages, []);
  await app.change({ type: 'REMOVE_PIN', windowId: 10, pinId: 'a' });
  assert.deepEqual(messages.map(item => item.id), [1]);
  assert.equal(messages[0].message.enabled, false);
});

test('Clear protects navigation targets awaiting popup classification', async () => {
  const app = setup({ tabs: [{ id: 1, windowId: 10 }, { id: 2, windowId: 10 }] });
  vm.runInContext('pendingNavigationTabs.add(2)', app.context);
  await app.change({ type: 'CLEAR_TABS', windowId: 10 });
  assert.deepEqual(app.removed, [1]);
});


test('stale Pin close does not close a tab moved to another window', async () => {
  const app = setup({ pins: [{ id: 'p' }], bindings: { 10: { p: 1 } }, tabs: [{ id: 1, windowId: 11 }] });
  await app.change({ type: 'CLOSE_PIN', windowId: 10, pinId: 'p' });
  assert.deepEqual(app.removed, []);
  assert.equal(app.session.bindings[10].p, undefined);
});
