const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const scrolls = [];
  const sidebar = { hidden: false, scrollTop: 0, clientHeight: 400, getBoundingClientRect: () => ({ top: 0, bottom: 400 }), scrollTo: value => scrolls.push(value) };
  const context = vm.createContext({ document: { querySelector: () => sidebar }, drag: null, revealedTabId: null,
    state: { pins: [], tabs: [{ id: 1, active: true }] }, pinRows: new Map(), folderRows: new Map(),
    tabRows: new Map([[1, { el: { getBoundingClientRect: () => ({ top: 800, bottom: 838, height: 38 }) } }]]) });
  const source = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function revealActiveTab()'), source.indexOf('function render()')), context);
  return { context, sidebar, scrolls };
}
test('new active tab is revealed once without stealing later manual scrolling', () => {
  const { context, scrolls } = setup();
  context.revealActiveTab();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].top, 619);
  context.state.tabs.push({ id: 2, active: false });
  context.revealActiveTab();
  assert.equal(scrolls.length, 1);
});
test('settings and dragging defer reveal until the sidebar is usable', () => {
  const { context, sidebar, scrolls } = setup();
  sidebar.hidden = true; context.revealActiveTab();
  sidebar.hidden = false; context.drag = {}; context.revealActiveTab();
  assert.equal(scrolls.length, 0);
  context.drag = null; context.revealActiveTab();
  assert.equal(scrolls.length, 1);
});
test('already visible rows and fixed icon Pins do not scroll the list', () => {
  const { context, scrolls } = setup();
  context.tabRows.get(1).el.getBoundingClientRect = () => ({ top: 100, bottom: 138, height: 38 });
  context.revealActiveTab();
  context.state.pins = [{ id: 'p', tabId: 2, status: 'active', superPin: true }];
  context.pinRows.set('p', {});
  context.revealActiveTab();
  assert.equal(scrolls.length, 0);
});
