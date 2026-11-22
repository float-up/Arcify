const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function load({ claim = true } = {}) {
  const native = [], requests = [];
  const document = {
    baseURI: 'https://app.example.com/inbox/',
    dispatchEvent(event) { requests.push(event.detail); if (claim) event.preventDefault(); return !event.defaultPrevented; }
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; this.cancelable = init.cancelable; this.defaultPrevented = false; } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } }
  const window = { open(...args) { native.push(args); return { native: true }; } };
  const context = vm.createContext({ window, document, CustomEvent, URL, Symbol, Object });
  const source = fs.readFileSync(require.resolve('../../src/content/peek-main.js'), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(source, context); // re-injection must not wrap twice
  return { window, native, requests };
}

test('plain new-tab window.open calls are claimed before Chrome creates a tab', () => {
  const app = load();
  const handle = app.window.open('/mail/42', '_blank');
  assert.ok(handle && handle.closed === false, 'returns a window-like handle, not null (null means "blocked")');
  handle.opener = null; handle.focus(); handle.close();
  assert.equal(app.window.open('https://other.example/', undefined, 'noopener,noreferrer').native, undefined);
  assert.deepEqual(app.requests, ['https://app.example.com/mail/42', 'https://other.example/']);
  assert.equal(app.native.length, 0);
});

test('popups with window features, named targets, blank and non-http URLs stay native', () => {
  const app = load();
  for (const args of [['https://a.example/', '_blank', 'width=500,height=600'], ['https://a.example/', 'oauth'], [''], [], ['javascript:void 0'], ['mailto:x@example.com']]) app.window.open(...args);
  assert.equal(app.native.length, 6);
  assert.deepEqual(app.requests, []);
});

test('unclaimed requests fall through to the native window.open', () => {
  const app = load({ claim: false });
  assert.deepEqual(app.window.open('https://a.example/'), { native: true });
  assert.equal(app.requests.length, 1);
});
