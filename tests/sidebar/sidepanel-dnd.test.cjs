const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Pin area exposes a drag-only append target wired to the end index', () => {
  const html = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.css'), 'utf8');
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');

  assert.match(html, /id="pin-append-drop"[^>]*hidden/);
  assert.match(css, /\.append-drop\s*\{[^}]*height:\s*0;/s);
  assert.match(css, /\.append-drop\.over::after\s*\{[^}]*height:\s*2px;/s);
  assert.match(html, /id="pin-append-drop"[^>]*><\/div>/);
  assert.doesNotMatch(script, /textContent = '添加到/);
  assert.match(script, /pinAppendDropEl\.hidden = false/);
  assert.match(script, /pinAppendDropEl\.hidden = true/);
  assert.match(script, /pinAppendDropEl\.ondragover[\s\S]*?event\.preventDefault\(\)/);
  assert.match(script, /pinAppendDropEl\.ondrop[\s\S]*?drop\('pin', state\.pins\.length, null, null\)/);
});

const vm = require('node:vm');

function folderDropHarness(drag, folderId = 'nested') {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  const messages = [];
  const classes = new Set();
  const el = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) }, contains: () => false };
  const context = vm.createContext({
    drag, state: { pins: [{ id: 'first' }, { id: 'other-folder' }, { id: 'last' }] },
    send: async (type, args) => messages.push({ type, ...args }),
    clearDrag: () => { context.drag = null; }, showError: error => { throw error; }
  });
  vm.runInContext(script.slice(script.indexOf('function bindFolderDrop('), script.indexOf('function reconcile(')), context);
  context.bindFolderDrop(el, folderId);
  const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  return { el, event, messages, classes, context };
}

test('folder append accepts a tab and stops the drop from reaching the root', async () => {
  const app = folderDropHarness({ kind: 'tab', id: 42 });
  app.el.ondragover(app.event);
  assert.equal(app.event.prevented, true);
  assert.equal(app.event.stopped, true);
  assert.equal(app.classes.has('over'), true);
  app.event.stopped = false;
  app.el.ondrop(app.event);
  await Promise.resolve();
  assert.equal(app.event.stopped, true);
  assert.equal(app.context.drag, null);
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages)), [{ type: 'PIN_TAB', tabId: 42, index: 3, folderId: 'nested', beforeFolders: false }]);
});

test('folder append moves an existing Pin after the last item, accounting for removal', async () => {
  const app = folderDropHarness({ kind: 'pin', id: 'first', index: 0 });
  app.el.ondrop(app.event);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages)), [{ type: 'REORDER_PIN', pinId: 'first', index: 2, folderId: 'nested', beforeFolders: false }]);
});

test('folder append ignores external drags', () => {
  const app = folderDropHarness(null);
  app.el.ondragover(app.event);
  assert.equal(app.event.prevented, false);
  assert.equal(app.classes.size, 0);
});

test('top drop requests a root Pin before folders at index zero', async () => {
  const app = folderDropHarness({ kind: 'tab', id: 42 });
  await app.context.drop('pin', 0, null, null, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages)), [{ type: 'PIN_TAB', tabId: 42, index: 0, folderId: null, beforeFolders: true }]);
});

test('render places top Pins before folders and ordinary Pins after folders', () => {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  const context = vm.createContext({
    state: { pins: [{ id: 'ordinary', order: 2 }, { id: 'top', order: 0 }], folders: [{ id: 'folder', order: 1 }] },
    folderIds: new Set(['folder']), folderRows: new Map([['folder', { group: 'folder', children: {}, appendDrop: 'append' }]]),
    pinRows: new Map(), row: item => item.id, reconcile() {}
  });
  vm.runInContext(script.slice(script.indexOf('  const childrenByParent ='), script.indexOf('  const superPins =')), context);
  assert.deepEqual(Array.from(context.level(null)), ['top', 'folder', 'ordinary']);
});

test('row halves and folder edges distinguish insertion from moving inside', () => {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(script.slice(script.indexOf('function dropPosition('), script.indexOf('function bindPositionDrop(')), context);
  const el = { getBoundingClientRect: () => ({ top: 100, height: 40 }) };
  assert.equal(context.dropPosition(el, { clientY: 102 }, 'folder'), 'before');
  assert.equal(context.dropPosition(el, { clientY: 120 }, 'folder'), 'inside');
  assert.equal(context.dropPosition(el, { clientY: 138 }, 'folder'), 'after');
  assert.equal(context.dropPosition(el, { clientY: 110 }, 'pin'), 'before');
  assert.equal(context.dropPosition(el, { clientY: 130 }, 'pin'), 'after');
});

test('icon area renders one or two equally divided rows for one through eight Pins', () => {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  for (let count = 1; count <= 8; count++) {
    let elements;
    const context = vm.createContext({
      state: { pins: Array.from({ length: count }, (_, i) => ({ id: i, superPin: true, order: i })) },
      superPinsEl: {}, pinRows: new Map(), row: () => ({ style: {} }),
      reconcile: (_, desired) => { elements = desired; }
    });
    vm.runInContext(script.slice(script.indexOf('  const superPins ='), script.indexOf('  reconcile(pinsEl, level(null)')), context);
    assert.equal(elements.length, count);
    for (let offset = 0; offset < count; offset += 4) {
      const row = elements.slice(offset, offset + 4);
      assert.ok(row.every(el => el.style.gridColumn === `span ${12 / row.length}`));
    }
  }
});

test('icon area drops reuse Pin mutations and preserve icon presentation in sorting', async () => {
  const app = folderDropHarness({ kind: 'tab', id: 42 });
  await app.context.drop('pin', 3, null, null, false, null, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages)), [{ type: 'PIN_TAB', tabId: 42, index: 3, folderId: null, beforeFolders: false, superPin: true }]);
});
