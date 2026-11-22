const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createDocument } = require('../helpers/fake-dom.cjs');

const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup({ platform = 'MacIntel', href = 'https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top', historyLength = 2, canGoBack, status = { enabled: false, popup: true }, replies = {} } = {}) {
  const document = createDocument();
  const messages = [], copied = [], calls = [], timers = [], windowListeners = {};
  let runtimeListener;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { runtimeListener = fn; }, removeListener() {} },
      sendMessage: async message => {
        messages.push(message);
        if (message.type === 'PEEK_STATUS') return typeof status === 'function' ? status() : status;
        const reply = replies[message.type];
        if (reply instanceof Error) throw reply;
        return reply ?? {};
      }
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } }
  };
  const context = vm.createContext({
    chrome, document, URL, decodeURI, Date, HTMLAnchorElement: class {},
    location: { href, reload: () => calls.push('reload') },
    history: { length: historyLength, back: () => calls.push('back'), forward: () => calls.push('forward') },
    navigator: { platform, clipboard: { writeText: async value => copied.push(value) } },
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn); },
    window: {}
  });
  if (canGoBack !== undefined) context.navigation = { canGoBack, addEventListener() {}, removeEventListener() {} };
  vm.runInContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), context);
  await settle();
  const host = () => document.documentElement.children.find(child => child.id === '__sidebar-peek-toolbar' && !child.removed);
  const part = predicate => host()?.find(predicate);
  const ui = {
    wrap: () => part(node => node.classes.has('wrap')),
    button: action => part(node => node.classes.has('action') && node.dataset.action === action),
    urlView: () => part(node => node.classes.has('url-view')),
    input: () => part(node => node.classes.has('url-input')),
    status: () => part(node => node.classes.has('status')),
    text: name => part(node => node.classes.has(name))?.textContent,
  };
  const runTimers = () => { for (const timer of timers.splice(0)) timer.fn?.(); };
  const key = (init, target = { tagName: 'BODY' }) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, composedPath: () => [target], ...init };
    for (const fn of windowListeners.keydown || []) fn(event);
    return event;
  };
  return { document, messages, copied, calls, timers, runTimers, key, host, ui, context, push: message => runtimeListener(message) };
}

test('floating window shows a formatted, decoded address and folds into a domain pill', async () => {
  const app = await setup();
  assert.ok(app.host(), 'toolbar is mounted');
  assert.equal(app.ui.text('host'), 'www.example.com');
  assert.equal(app.ui.text('rest'), '/docs/中文?q=1#top');
  assert.equal(app.ui.text('pill-text'), 'example.com');
  assert.equal(app.ui.urlView().title, 'https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top');
  assert.equal(app.ui.button('back').title, '后退（⌘[）');
  assert.equal(app.ui.button('return').title, '回到标签页（⌘⇧O）');
  assert.equal(app.ui.wrap().classes.has('expanded'), true);
  app.runTimers();
  assert.equal(app.ui.wrap().classes.has('expanded'), false, 'collapses after the initial preview');
  app.ui.wrap().dispatch('pointerenter');
  assert.equal(app.ui.wrap().classes.has('expanded'), true);
  app.ui.wrap().dispatch('pointerleave');
  app.runTimers();
  assert.equal(app.ui.wrap().classes.has('expanded'), false);
});

test('ordinary pages and plain http pages get no toolbar or an insecure badge', async () => {
  assert.equal((await setup({ status: { enabled: true, popup: false } })).host(), undefined);
  const app = await setup({ href: 'http://intranet.local/' });
  const badge = app.host().find(node => node.classes.has('security'));
  assert.equal(badge.classes.has('insecure'), true);
  assert.equal(badge.title, '连接不安全');
});

test('back, forward and reload work from buttons and Mac shortcuts', async () => {
  const app = await setup();
  app.ui.button('back').click();
  app.ui.button('reload').click();
  for (const init of [{ key: '[', metaKey: true }, { key: ']', metaKey: true }, { key: 'r', metaKey: true }, { key: 'ArrowLeft', metaKey: true }]) {
    assert.equal(app.key(init).defaultPrevented, true);
  }
  assert.deepEqual(app.calls, ['back', 'reload', 'back', 'forward', 'reload', 'back']);
  assert.equal(app.ui.wrap().classes.has('reloading'), true);
});

test('Windows shortcuts use Ctrl / Alt and leave caret keys inside text fields alone', async () => {
  const app = await setup({ platform: 'Win32' });
  assert.equal(app.ui.button('reload').title, '刷新（Ctrl+R）');
  for (const init of [{ key: 'ArrowLeft', altKey: true }, { key: 'ArrowRight', altKey: true }, { key: 'F5' }, { key: 'r', ctrlKey: true }]) app.key(init);
  assert.deepEqual(app.calls, ['back', 'forward', 'reload', 'reload']);
  assert.equal(app.key({ key: 'ArrowLeft', altKey: true }, { tagName: 'TEXTAREA' }).defaultPrevented, false);
  assert.equal(app.key({ key: 'r', metaKey: true }).defaultPrevented, false, 'Meta is not the primary key on Windows');
  app.key({ key: 'd', altKey: true });
  assert.equal(app.ui.input().focused, true);
});

test('the page keeps priority: handled, composing and non-popup keys are ignored', async () => {
  const app = await setup();
  assert.equal(app.key({ key: 'r', metaKey: true, defaultPrevented: true }).defaultPrevented, true);
  app.key({ key: 'l', metaKey: true, isComposing: true });
  app.key({ key: 'ArrowLeft', metaKey: true }, { tagName: 'INPUT' });
  app.key({ key: 'ArrowLeft', metaKey: true }, { isContentEditable: true });
  assert.deepEqual(app.calls, []);
  assert.equal(app.ui.input().focused, false);
  app.push({ type: 'PEEK_WINDOW_STATE', popup: false });
  assert.equal(app.host(), undefined);
  assert.equal(app.key({ key: 'r', metaKey: true }).defaultPrevented, false);
});

test('back is disabled without history and explains instead of leaving the page', async () => {
  const app = await setup({ canGoBack: false });
  assert.equal(app.ui.button('back').disabled, true);
  app.key({ key: '[', metaKey: true });
  assert.deepEqual(app.calls, []);
  assert.equal(app.ui.status().textContent, '没有可后退的页面');
  assert.equal(app.ui.wrap().classes.has('notice'), true);
});

test('⌘L edits the address; Enter navigates through the worker, Escape restores it', async () => {
  const app = await setup({ replies: { PEEK_NAVIGATE: { navigated: true } } });
  app.runTimers();
  assert.equal(app.key({ key: 'l', metaKey: true }).defaultPrevented, true);
  const input = app.ui.input();
  assert.equal(app.ui.wrap().classes.has('expanded'), true);
  assert.equal(app.ui.wrap().classes.has('editing'), true);
  assert.equal(input.focused, true);
  assert.equal(input.selected, true);
  assert.equal(input.value, 'https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top');
  app.runTimers();
  assert.equal(app.ui.wrap().classes.has('expanded'), true, 'stays open while editing');
  const typed = input.dispatch('keydown', { key: 'j' });
  assert.equal(typed.propagationStopped, true, 'page shortcuts do not see address typing');
  assert.equal(input.dispatch('keyup', { key: 'j' }).propagationStopped, true);
  input.value = '  github.com/anthropics  ';
  const enter = input.dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(app.messages.filter(message => message.type === 'PEEK_NAVIGATE').map(message => message.input), ['github.com/anthropics']);
  assert.equal(app.ui.wrap().classes.has('editing'), false);
  assert.equal(app.ui.status().textContent, '正在打开…');

  app.ui.urlView().click();
  app.ui.input().value = 'something else';
  app.ui.input().dispatch('keydown', { key: 'Escape' });
  assert.equal(app.ui.wrap().classes.has('editing'), false);
  assert.equal(app.ui.input().value, 'https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top');
  assert.equal(app.messages.filter(message => message.type === 'PEEK_NAVIGATE').length, 1);
  app.ui.input().dispatch('keydown', { key: 'Enter', isComposing: true });
  assert.equal(app.messages.filter(message => message.type === 'PEEK_NAVIGATE').length, 1, 'IME confirmation does not navigate');
});

test('navigation errors are reported in the toolbar', async () => {
  const app = await setup({ replies: { PEEK_NAVIGATE: { error: '无法访问' } } });
  app.ui.urlView().click();
  app.ui.input().value = 'example.org';
  app.ui.input().dispatch('keydown', { key: 'Enter' });
  await settle();
  assert.equal(app.ui.status().textContent, '无法打开：无法访问');
  assert.equal(app.ui.status().classes.has('error'), true);
});

test('copy works from the button and the captured ⌘⇧L shortcut', async () => {
  const app = await setup();
  app.ui.button('copy').click();
  await settle();
  const event = { key: 'L', metaKey: true, shiftKey: true, defaultPrevented: false, repeat: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  for (const fn of app.document.listeners.keydown) fn(event);
  await settle();
  assert.equal(event.prevented && event.stopped, true);
  assert.deepEqual(app.copied, ['https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top', 'https://www.example.com/docs/%E4%B8%AD%E6%96%87?q=1#top']);
  assert.equal(app.ui.status().textContent, '已复制链接');
  app.push({ type: 'PEEK_COPY_URL' });
  await settle();
  assert.equal(app.copied.length, 3);
});

test('return to tab moves the tab back and removes the toolbar; failures can be retried', async () => {
  let app = await setup({ replies: { PEEK_RETURN: { returned: true } } });
  const mounted = app.host();
  app.key({ key: 'o', metaKey: true, shiftKey: true });
  await settle();
  assert.deepEqual(app.messages.map(message => message.type), ['PEEK_STATUS', 'PEEK_RETURN']);
  assert.equal(mounted.removed, true);

  app = await setup({ replies: { PEEK_RETURN: { error: '窗口已关闭' } } });
  app.ui.button('return').click();
  assert.equal(app.ui.button('return').disabled, true, 'no double submission while pending');
  await settle();
  assert.equal(app.ui.button('return').disabled, false);
  assert.equal(app.ui.status().textContent, '无法移回：窗口已关闭');
});

test('a delayed status response cannot hide newly pushed popup controls', async () => {
  let resolveStatus;
  const app = await setup({ status: () => new Promise(resolve => { resolveStatus = resolve; }) });
  app.push({ type: 'PEEK_WINDOW_STATE', popup: true });
  resolveStatus({ popup: false });
  await settle();
  assert.ok(app.host());
});

test('re-injection removes the previous toolbar and window shortcut listener', async () => {
  const app = await setup();
  const first = app.host();
  vm.runInContext(fs.readFileSync(require.resolve('../../src/content/peek-content.js'), 'utf8'), app.context);
  await settle();
  assert.equal(first.removed, true);
  assert.ok(app.host());
  app.key({ key: 'r', metaKey: true });
  assert.deepEqual(app.calls, ['reload'], 'one reload, not one per injection');
});

// ---------- worker side ----------
function worker({ peekWindows = { 20: { originWindowId: 10, tabId: 2 } }, search = true } = {}) {
  const handlers = {}, updates = [], searches = [];
  const event = name => ({ addListener: fn => { (handlers[name] ||= []).push(fn); } });
  const session = { bindings: {}, peekWindows };
  const chrome = {
    sidePanel: { setPanelBehavior() {} }, commands: { onCommand: event('command') },
    storage: {
      local: { get: async () => ({ pins: [], folders: [] }), set: async () => {} },
      session: { get: async key => typeof key === 'string' ? { [key]: structuredClone(session[key]) } : structuredClone(session), set: async value => Object.assign(session, value) }
    },
    tabs: {
      update: async (id, options) => { updates.push({ id, ...options }); }, query: async () => [], get: async () => null,
      onRemoved: event(), onDetached: event(), onCreated: event(), onUpdated: event(), onActivated: event(), onMoved: event(), onAttached: event()
    },
    windows: { onRemoved: event() },
    runtime: { onMessage: event('message'), onInstalled: event(), onStartup: event(), sendMessage: async () => {} },
    webNavigation: { onCreatedNavigationTarget: event() }
  };
  if (search) chrome.search = { query: async options => { searches.push(options); } };
  const context = vm.createContext({ chrome, console, URL, setTimeout, structuredClone });
  vm.runInContext(fs.readFileSync(require.resolve('../../src/background/sidebar.js'), 'utf8'), context);
  const send = (message, sender) => new Promise(resolve => handlers.message[0](message, sender, resolve));
  return { send, updates, searches, resolveAddress: vm.runInContext('resolveAddress', context) };
}

test('address input resolves to URLs with sensible schemes, everything else is a search', () => {
  const { resolveAddress } = worker();
  const url = input => JSON.parse(JSON.stringify(resolveAddress(input)));
  assert.deepEqual(url('example.com'), { url: 'https://example.com/' });
  assert.deepEqual(url('github.com/anthropics?tab=repos'), { url: 'https://github.com/anthropics?tab=repos' });
  assert.deepEqual(url('localhost:3000/app'), { url: 'http://localhost:3000/app' });
  assert.deepEqual(url('192.168.1.10'), { url: 'http://192.168.1.10/' });
  assert.deepEqual(url('http://example.com/x'), { url: 'http://example.com/x' });
  assert.deepEqual(url('chrome://settings'), { url: 'chrome://settings' });
  assert.deepEqual(url('例子.中国'), { url: 'https://xn--fsqu00a.xn--fiqs8s/' });
  assert.deepEqual(url('hello world'), { search: 'hello world' });
  assert.deepEqual(url('typescript'), { search: 'typescript' });
  assert.deepEqual(url('1.5'), { search: '1.5' });
  assert.deepEqual(url('javascript:alert(1)'), { search: 'javascript:alert(1)' });
  assert.equal(resolveAddress('   '), null);
});

test('only the extension floating window may navigate, via tabs.update or the default search engine', async () => {
  let app = worker();
  const popupTab = { tab: { id: 2, windowId: 20 }, frameId: 0 };
  assert.deepEqual(JSON.parse(JSON.stringify(await app.send({ type: 'PEEK_NAVIGATE', input: 'example.com/a' }, popupTab))), { navigated: true });
  await app.send({ type: 'PEEK_NAVIGATE', input: '中文 搜索' }, popupTab);
  assert.deepEqual(JSON.parse(JSON.stringify(app.updates)), [{ id: 2, url: 'https://example.com/a' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.searches)), [{ text: '中文 搜索', tabId: 2 }]);

  assert.match((await app.send({ type: 'PEEK_NAVIGATE', input: 'example.com' }, { tab: { id: 9, windowId: 20 }, frameId: 0 })).error, /不是插件创建/);
  assert.match((await app.send({ type: 'PEEK_NAVIGATE', input: 'example.com' }, { tab: { id: 2, windowId: 20 }, frameId: 3 })).error, /不是插件创建/);
  assert.match((await app.send({ type: 'PEEK_NAVIGATE', input: ' ' }, popupTab)).error, /请输入/);
  assert.equal(app.updates.length, 1);

  app = worker({ search: false });
  await app.send({ type: 'PEEK_NAVIGATE', input: 'a b' }, popupTab);
  assert.deepEqual(JSON.parse(JSON.stringify(app.updates)), [{ id: 2, url: 'https://www.google.com/search?q=a%20b' }]);
});
