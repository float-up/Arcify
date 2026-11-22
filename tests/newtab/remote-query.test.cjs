const { test } = require('node:test');
const assert = require('node:assert/strict');

function clock() {
  let now = 0; const timers = [];
  return {
    schedule: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    cancel: timer => { timer.fn = null; },
    async advance(ms) {
      now += ms;
      // Fire due timers without awaiting them: a deliberately slow query must not block the clock.
      for (const timer of timers.filter(item => item.fn && item.at <= now)) { const fn = timer.fn; timer.fn = null; fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
async function setup({ slow = false } = {}) {
  const { createRemoteQuery } = await import('../../src/newtab/remote-query.js');
  const time = clock(), runs = [];
  let release;
  const remote = createRemoteQuery({ delay: 100, schedule: time.schedule, cancel: time.cancel,
    run: request => { runs.push(request.query); return slow ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); } });
  const type = word => [...word].forEach((_, i) => remote.request(word.slice(0, i + 1), { query: word.slice(0, i + 1) }));
  return { remote, time, runs, type, release: () => release() };
}

test('typing quickly sends one history query, for the final text, after typing pauses', async () => {
  const app = await setup();
  app.type('github react');
  await app.time.advance(50);
  assert.deepEqual(app.runs, []);
  await app.time.advance(100);
  assert.deepEqual(app.runs, ['github react']);
});

test('while a query runs, newer input waits and only the newest request runs next', async () => {
  const app = await setup({ slow: true });
  app.type('git'); await app.time.advance(100);
  assert.deepEqual(app.runs, ['git']);
  app.type('github'); await app.time.advance(100);
  app.type('github react'); await app.time.advance(100);
  assert.deepEqual(app.runs, ['git'], 'no pile-up behind the running query');
  app.release(); await app.time.advance(0);
  assert.deepEqual(app.runs, ['git', 'github react']);
});

test('a query that already ran is not repeated, and clearing the input cancels the pending one', async () => {
  const app = await setup();
  app.remote.request('react', { query: 'react' }); await app.time.advance(100);
  app.remote.request('reac', { query: 'reac' });
  app.remote.request('react', { query: 'react' }); await app.time.advance(100);
  app.remote.request('vue', { query: 'vue' });
  app.remote.request(null); await app.time.advance(100);
  assert.deepEqual(app.runs, ['react']);
});

test('parsed URLs are cached and still produce the same keys and hosts', async () => {
  const { parseUrl, urlKey, hostOf, matchScore } = await import('../../src/newtab/search.js');
  assert.equal(parseUrl('https://www.GitHub.com/a/?q=1#x'), parseUrl('https://www.GitHub.com/a/?q=1#x'), 'same object: parsed once');
  assert.equal(urlKey('https://www.github.com/a/?q=1#x'), 'github.com/a?q=1');
  assert.equal(hostOf('not a url'), '');
  assert.equal(matchScore(['中文'], '', 'https://x.com/docs/%E4%B8%AD%E6%96%87'), 0.5, 'decoded path still matches');
});
