const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('pin state update takes precedence over an older status response', async () => {
  let listener, click, resolveStatus;
  const messages = [];
  class Anchor { constructor() { this.href = 'https://example.com/'; this.target = '_blank'; } hasAttribute() { return false; } }
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage(message) { messages.push(message); return message.type === 'PEEK_STATUS' ? new Promise(resolve => { resolveStatus = resolve; }) : Promise.resolve({ enabled: true }); } },
    storage: { onChanged: { addListener() {} } }
  };
  const document = { addEventListener(name, fn) { if (name === 'click') click = fn; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), { chrome, document, HTMLAnchorElement: Anchor, window: {} });
  listener({ type: 'PEEK_STATE', enabled: true });
  resolveStatus({ enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  let prevented = false;
  let stopped = false;
  click({ button: 0, composedPath: () => [new Anchor()], preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(messages.at(-1).type, 'PEEK_OPEN');
  prevented = false;
  click({ button: 0, metaKey: true, composedPath: () => [new Anchor()], preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented, false);
});

test('reinjecting replaces the old click handler and cancels native new-tab navigation', async () => {
  const clicks = new Set(), keydowns = new Set(), openHooks = new Set(), listeners = new Set(), storageListeners = new Set();
  const messages = [];
  class Anchor { constructor() { this.href = 'http://localhost:8000/peek-test.html?case=foreground'; this.target = '_blank'; } hasAttribute() { return false; } }
  const chrome = {
    runtime: {
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage(message) { messages.push(message); return Promise.resolve({ enabled: true }); }
    },
    storage: { onChanged: { addListener: fn => storageListeners.add(fn), removeListener: fn => storageListeners.delete(fn) } }
  };
  const document = {
    addEventListener(name, fn, capture) { assert.equal(capture, true); ({ click: clicks, keydown: keydowns }[name] || openHooks).add(fn); },
    removeEventListener(name, fn) { ({ click: clicks, keydown: keydowns }[name] || openHooks).delete(fn); }
  };
  const context = vm.createContext({ chrome, document, HTMLAnchorElement: Anchor, window: {} });
  const source = fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8');
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks.size, 1);
  assert.equal(keydowns.size, 1);
  assert.equal(openHooks.size, 1);
  assert.equal(listeners.size, 1);
  const link = new Anchor();
  for (const modifier of [null, 'metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'middle']) {
    const event = { button: modifier === 'middle' ? 1 : 0, defaultPrevented: false, propagationStopped: false, composedPath: () => [link], preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.propagationStopped = true; } };
    if (modifier && modifier !== 'middle') event[modifier] = true;
    for (const click of clicks) click(event);
    assert.equal(event.defaultPrevented, modifier === null);
    assert.equal(event.propagationStopped, modifier === null);
  }
  assert.equal(messages.filter(message => message.type === 'PEEK_OPEN').length, 1);
});

test('ordinary storage and CHANGED events do not poll popup status', async () => {
  let onMessage, onStorage;
  const messages = [];
  const chrome = {
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, sendMessage: async message => { messages.push(message); return { enabled: false, popup: false }; } },
    storage: { onChanged: { addListener(fn) { onStorage = fn; } } }
  };
  const document = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), { chrome, document });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) {
    onMessage({ type: 'CHANGED' });
    onStorage({ pins: {} }, 'local');
    onStorage({ bindings: {} }, 'session');
  }
  assert.equal(messages.length, 1);
  onStorage({ peekEnabled: {} }, 'local');
  assert.equal(messages.length, 2);
});

test('window.open hook is honored only for an enabled Pin with a user gesture, once per gesture', async () => {
  const listeners = {}, messages = [];
  let onMessage;
  const chrome = {
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, sendMessage(message) { messages.push(message); return Promise.resolve({ enabled: true }); } },
    storage: { onChanged: { addListener() {} } }
  };
  const document = { addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener() {} };
  const navigator = { userActivation: { isActive: true } };
  class Anchor { constructor() { this.href = 'https://example.com/a'; this.target = '_blank'; } hasAttribute() { return false; } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), { chrome, document, navigator, HTMLAnchorElement: Anchor, window: {}, Date });
  await new Promise(resolve => setImmediate(resolve));
  const request = url => ({ detail: url, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  onMessage({ type: 'PEEK_STATE', enabled: false });
  assert.equal((listeners['__sidebar-peek-open'](request('https://example.com/a')), messages.filter(m => m.type === 'PEEK_OPEN').length), 0);
  onMessage({ type: 'PEEK_STATE', enabled: true });
  navigator.userActivation.isActive = false;
  const blocked = request('https://example.com/a');
  listeners['__sidebar-peek-open'](blocked);
  assert.equal(blocked.defaultPrevented, false);
  navigator.userActivation.isActive = true;
  const claimed = request('https://example.com/a');
  listeners['__sidebar-peek-open'](claimed);
  assert.equal(claimed.defaultPrevented, true);
  // The same gesture's anchor click is swallowed instead of opening a second window.
  const click = { button: 0, composedPath: () => [new Anchor()], preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
  listeners.click(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(messages.filter(m => m.type === 'PEEK_OPEN').map(m => m.url), ['https://example.com/a']);
});
