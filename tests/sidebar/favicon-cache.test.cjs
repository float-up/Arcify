const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/shared/favicon-cache.js');
function memoryStorage(initial) {
  const data = new Map(initial ? [['sidebar-favicons-v1', initial]] : []);
  return { data, getItem: key => data.get(key) ?? null, setItem(key, value) { if (this.full) throw new Error('QuotaExceededError'); data.set(key, value); } };
}
const api = pageUrl => `ext://_favicon/?pageUrl=${pageUrl}`;
const GENERIC = 'data:image/png;base64,GLOBE';
function setup(options = {}) {
  const rasterized = [], loaded = [], timers = [];
  let clock = 1_000;
  return load().then(({ createFaviconCache }) => {
    const cache = createFaviconCache({
      storage: options.storage ?? memoryStorage(), apiUrl: 'apiUrl' in options ? options.apiUrl : api,
      rasterize: async src => {
        rasterized.push(src);
        if (src.includes('invalid')) return GENERIC;
        if (options.unknown?.some(url => src.includes(url))) return GENERIC;
        if (options.failRaster) throw new Error('tainted');
        return `data:image/png;base64,${src.length}`;
      },
      loadImage: async src => { loaded.push(src); if (options.failLoad) throw new Error('404'); },
      now: () => clock, schedule: (fn) => { timers.push(fn); return timers.length; }
    });
    return { cache, rasterized, loaded, timers, tick: ms => { clock += ms; }, flush: () => timers.splice(0).forEach(fn => fn()) };
  });
}

test('an icon is fetched from Chrome\'s local favicon database once and then served synchronously', async () => {
  const storage = memoryStorage();
  const app = await setup({ storage });
  assert.equal(app.cache.get('https://github.com/a'), null);
  const src = await app.cache.load('https://github.com/a#readme', 'https://github.githubassets.com/favicon.svg');
  assert.match(src, /^data:image\/png/);
  assert.deepEqual(app.rasterized, ['ext://_favicon/?pageUrl=https://github.com/a#readme', 'ext://_favicon/?pageUrl=https://sidebar-no-favicon.invalid/']);
  assert.deepEqual(app.loaded, [], 'the remote favicon is never requested');
  assert.equal(app.cache.get('https://github.com/a').data, src, 'hash is ignored in the key');
  assert.equal(app.cache.isCurrent('https://github.com/a', 'https://github.githubassets.com/favicon.svg'), true);
  assert.equal(app.cache.isCurrent('https://github.com/a', 'https://github.githubassets.com/other.svg'), false, 'a new reported icon triggers a refresh');
  // Repeated loads in one panel session are shared.
  await app.cache.load('https://github.com/a', 'https://github.githubassets.com/favicon.svg');
  assert.equal(app.rasterized.length, 2);

  // A reopened panel (new cache over the same storage) has it without any loading.
  app.flush();
  const reopened = await setup({ storage });
  assert.equal(reopened.cache.get('https://github.com/a').data, src);
  assert.equal(reopened.cache.isCurrent('https://github.com/a', 'https://github.githubassets.com/favicon.svg'), true);
  assert.deepEqual(reopened.rasterized, []);
});

test('other pages of a known site start with the site icon as a first guess', async () => {
  const app = await setup();
  const src = await app.cache.load('https://mail.example.com/inbox', 'https://mail.example.com/favicon.ico');
  const guess = app.cache.get('https://mail.example.com/thread/42');
  assert.deepEqual({ ...guess }, { data: src, source: '', stale: true, exact: false });
  assert.equal(app.cache.isCurrent('https://mail.example.com/thread/42', 'https://mail.example.com/favicon.ico'), false);
});

test('data: favicons are cached directly; long ones are tracked by a short id', async () => {
  const { sourceId } = await load();
  const app = await setup({ apiUrl: null });
  const big = `data:image/png;base64,${'A'.repeat(5000)}`;
  await app.cache.load('https://chat.example.com/', big);
  assert.deepEqual(app.rasterized, [big]);
  assert.equal(app.cache.get('https://chat.example.com/').source, sourceId(big));
  assert.ok(sourceId(big).length < 30);
  assert.equal(app.cache.isCurrent('https://chat.example.com/', big), true);
});

test('pages Chrome has no icon for fall back to the site icon without caching the generic globe', async () => {
  const app = await setup({ unknown: ['restored.example'] });
  const src = await app.cache.load('https://restored.example/', 'https://restored.example/icon.png');
  assert.equal(src, 'https://restored.example/icon.png');
  assert.deepEqual(app.loaded, ['https://restored.example/icon.png']);
  assert.equal(app.cache.get('https://restored.example/'), null);
});

test('without the favicon permission or for chrome:// pages the remote icon is just displayed; failures yield null', async () => {
  let app = await setup({ apiUrl: null });
  assert.equal(await app.cache.load('https://a.example/', 'https://a.example/f.ico'), 'https://a.example/f.ico');
  assert.equal(app.cache.get('https://a.example/'), null);
  app = await setup();
  assert.equal(await app.cache.load('chrome://settings/', 'chrome://theme/IDR_SETTINGS_FAVICON'), 'chrome://theme/IDR_SETTINGS_FAVICON');
  assert.deepEqual(app.rasterized, []);
  app = await setup({ apiUrl: null, failLoad: true });
  assert.equal(await app.cache.load('https://b.example/', 'https://b.example/missing.ico'), null);
});

test('entries go stale after a week, and storage is bounded and survives quota errors', async () => {
  const storage = memoryStorage();
  const app = await setup({ storage });
  await app.cache.load('https://old.example/', 'https://old.example/f.ico');
  app.tick(8 * 24 * 60 * 60 * 1000);
  assert.equal(app.cache.get('https://old.example/').stale, true);
  assert.equal(app.cache.isCurrent('https://old.example/', 'https://old.example/f.ico'), false);

  for (let index = 0; index < 450; index++) { app.tick(1); await app.cache.load(`https://site${index}.example/`, `https://site${index}.example/f.ico`); }
  app.flush();
  const saved = JSON.parse(storage.data.get('sidebar-favicons-v1')).entries;
  assert.equal(Object.keys(saved).length, 400);
  assert.ok(saved['https://site449.example/'], 'newest entries are kept');

  storage.full = true;
  await app.cache.load('https://late.example/', 'https://late.example/f.ico');
  assert.doesNotThrow(() => app.flush());
  const corrupt = await setup({ storage: memoryStorage('{not json') });
  assert.equal(corrupt.cache.size, 0);
});
