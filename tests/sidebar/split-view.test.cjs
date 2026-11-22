const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Background harness with a tab strip that really reorders, so adjacency is observable.
function setup(tabs, { supported = true } = {}) {
  const calls = [];
  const event = () => ({ addListener() {} });
  const storage = values => ({ get: async () => structuredClone(values), set: async value => Object.assign(values, structuredClone(value)) });
  const strip = windowId => tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
  const reindex = windowId => strip(windowId).forEach((tab, index) => { tab.index = index; });
  const find = id => { const tab = tabs.find(item => item.id === id); if (!tab) throw new Error('missing'); return tab; };
  const chrome = {
    sidePanel: { setPanelBehavior() {} }, storage: { local: storage({ pins: [], folders: [] }), session: storage({ bindings: {} }) },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: async () => {} },
    tabs: {
      SPLIT_VIEW_ID_NONE: -1,
      query: async query => tabs.filter(tab => !query.windowId || tab.windowId === query.windowId).map(tab => ({ ...tab })),
      get: async id => ({ ...find(id) }),
      move: async (id, { index }) => {
        calls.push(['move', id, index]);
        const tab = find(id), list = strip(tab.windowId).filter(item => item !== tab);
        list.splice(index, 0, tab); list.forEach((item, position) => { item.index = position; });
      },
      group: async ({ groupId, tabIds }) => { calls.push(['group', tabIds, groupId]); for (const id of tabIds) find(id).groupId = groupId; },
      ungroup: async ids => { calls.push(['ungroup', ids]); for (const id of [].concat(ids)) find(id).groupId = -1; },
      update: async (id, options) => { calls.push(['update', id, options]); return { id }; },
      remove: async ids => calls.push(['remove', [].concat(ids)]),
      sendMessage: async () => {},
      onCreated: event(), onActivated: event(), onUpdated: event(), onMoved: event(), onAttached: event(), onDetached: event(), onRemoved: event()
    },
    windows: { get: async () => ({ type: 'normal' }), onRemoved: event() },
    webNavigation: { onCreatedNavigationTarget: event() }
  };
  if (supported) {
    chrome.tabs.createSplit = async ids => {
      calls.push(['createSplit', [...ids]]);
      const [a, b] = ids.map(find);
      assert.equal(Math.abs(a.index - b.index), 1, 'createSplit requires adjacent tabs');
      assert.equal(a.groupId ?? -1, b.groupId ?? -1, 'createSplit requires the same group');
      a.splitViewId = b.splitViewId = 99; return 99;
    };
    chrome.tabs.unsplit = async id => { calls.push(['unsplit', id]); for (const tab of tabs) if (tab.splitViewId === id) tab.splitViewId = -1; };
  }
  const context = vm.createContext({ chrome, console, URL, crypto: { randomUUID }, setTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), context);
  return { change: vm.runInContext('change', context), calls, tabs, order: () => strip(10).map(tab => tab.id) };
}
const tab = (id, index, extra = {}) => ({ id, index, windowId: 10, splitViewId: -1, groupId: -1, ...extra });

test('dropping on the right half moves a distant tab next to the target and splits it on the right', async () => {
  const app = setup([tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]);
  await app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 1, targetTabId: 3, side: 'right' });
  assert.deepEqual(app.order(), [2, 3, 1, 4]);
  assert.deepEqual(app.calls.find(call => call[0] === 'createSplit'), ['createSplit', [3, 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.at(-1))), ['update', 1, { active: true }]);
});

test('dropping on the left half places a later tab before the target', async () => {
  const app = setup([tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]);
  await app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 4, targetTabId: 2, side: 'left' });
  assert.deepEqual(app.order(), [1, 4, 2, 3]);
  assert.deepEqual(app.calls.find(call => call[0] === 'createSplit'), ['createSplit', [4, 2]]);
});

test('already adjacent tabs split without moving', async () => {
  const app = setup([tab(1, 0), tab(2, 1)]);
  await app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 2, targetTabId: 1, side: 'right' });
  assert.equal(app.calls.some(call => call[0] === 'move'), false);
  assert.deepEqual(app.calls.find(call => call[0] === 'createSplit'), ['createSplit', [1, 2]]);
});

test('the dragged tab joins the target group, and a dragged split is undone first', async () => {
  const app = setup([tab(1, 0, { splitViewId: 5 }), tab(2, 1, { splitViewId: 5 }), tab(3, 2, { groupId: 7 })]);
  await app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 1, targetTabId: 3, side: 'left' });
  assert.deepEqual(app.calls.map(call => call[0]).slice(0, 2), ['unsplit', 'group']);
  assert.equal(app.tabs.find(item => item.id === 1).groupId, 7);
  assert.equal(app.tabs.find(item => item.id === 2).splitViewId, -1);
  assert.deepEqual(app.calls.find(call => call[0] === 'createSplit'), ['createSplit', [1, 3]]);
});

test('split is rejected for split targets, mixed pinned state, other windows and old Chrome', async () => {
  let app = setup([tab(1, 0), tab(2, 1, { splitViewId: 3 }), tab(3, 2, { splitViewId: 3 })]);
  await assert.rejects(app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 1, targetTabId: 2, side: 'right' }), /已在分屏中/);
  app = setup([tab(1, 0, { pinned: true }), tab(2, 1)]);
  await assert.rejects(app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 2, targetTabId: 1, side: 'right' }), /固定标签页/);
  app = setup([tab(1, 0), tab(2, 0, { windowId: 11 })]);
  await assert.rejects(app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 1, targetTabId: 2, side: 'right' }), /其他窗口/);
  app = setup([tab(1, 0), tab(2, 1)], { supported: false });
  await assert.rejects(app.change({ type: 'SPLIT_TABS', windowId: 10, tabId: 1, targetTabId: 2, side: 'right' }), /Chrome 155/);
  assert.equal(app.calls.length, 0);
});

test('unsplit separates the split of the given tab and ignores unsplit tabs', async () => {
  const app = setup([tab(1, 0, { splitViewId: 4 }), tab(2, 1, { splitViewId: 4 }), tab(3, 2)]);
  await app.change({ type: 'UNSPLIT_TAB', windowId: 10, tabId: 2 });
  await app.change({ type: 'UNSPLIT_TAB', windowId: 10, tabId: 3 });
  assert.deepEqual(app.calls, [['unsplit', 4]]);
});

test('Clear keeps the inactive half of the active split', async () => {
  const app = setup([tab(1, 0, { active: true, splitViewId: 8 }), tab(2, 1, { splitViewId: 8 }), tab(3, 2, { splitViewId: 9 }), tab(4, 3)]);
  await app.change({ type: 'CLEAR_TABS', windowId: 10 });
  assert.deepEqual(app.calls, [['remove', [3, 4]]]);
});

test('tab rows map edges to reordering and the middle half to a left or right split', () => {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(script.slice(script.indexOf('function dropPosition('), script.indexOf('function bindPositionDrop(')), context);
  const el = { getBoundingClientRect: () => ({ top: 100, height: 40, left: 0, width: 300 }) };
  assert.equal(context.tabDropZone(el, { clientY: 105, clientX: 50 }, true), 'before');
  assert.equal(context.tabDropZone(el, { clientY: 120, clientX: 50 }, true), 'split-left');
  assert.equal(context.tabDropZone(el, { clientY: 120, clientX: 250 }, true), 'split-right');
  assert.equal(context.tabDropZone(el, { clientY: 136, clientX: 250 }, true), 'after');
  assert.equal(context.tabDropZone(el, { clientY: 115, clientX: 50 }, false), 'before');
  assert.equal(context.tabDropZone(el, { clientY: 125, clientX: 50 }, false), 'after');
  assert.equal(context.tabMoveIndex(1, 4, 'before'), 3);
  assert.equal(context.tabMoveIndex(1, 4, 'after'), 4);
  assert.equal(context.tabMoveIndex(6, 4, 'before'), 4);
  assert.equal(context.tabMoveIndex(6, 4, 'after'), 5);
  assert.equal(context.tabMoveIndex(undefined, 4, 'before'), 4);
});
