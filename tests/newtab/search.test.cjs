const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/newtab/search.js');
const plain = value => JSON.parse(JSON.stringify(value));
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

test('results follow the priority frequent > history > bookmarks, then match quality', async () => {
  const { rank } = await load();
  const results = rank({
    query: 'git', now: NOW,
    frequent: { a: { url: 'https://gitlab.com/team', title: 'Team · GitLab', score: 3, t: NOW } },
    history: [{ url: 'https://github.com/', title: 'GitHub', visitCount: 90, typedCount: 20, lastVisitTime: NOW }],
    bookmarks: [{ url: 'https://git-scm.com/docs', title: 'Git docs', dateAdded: NOW }],
  });
  assert.deepEqual(results.map(item => [item.source, item.url]), [
    ['frequent', 'https://gitlab.com/team'], ['history', 'https://github.com/'], ['bookmark', 'https://git-scm.com/docs'],
  ]);
});

test('within a tier, host-prefix and title-word matches beat substring matches; all terms must match', async () => {
  const { rank, matchScore } = await load();
  const history = [
    { url: 'https://example.com/digital', title: 'Something', visitCount: 500 },
    { url: 'https://github.com/x', title: 'Repo', visitCount: 1 },
    { url: 'https://news.site/', title: 'Git internals explained', visitCount: 1 },
  ];
  assert.deepEqual(rank({ query: 'git', history, now: NOW }).map(item => item.url), ['https://github.com/x', 'https://news.site/', 'https://example.com/digital']);
  assert.equal(rank({ query: 'git rust', history, now: NOW }).length, 0);
  assert.equal(matchScore(['周报'], 'Notion 周报 2026', 'https://notion.so/x'), 0.85, 'CJK terms match inside titles');
  assert.equal(matchScore(['mail'], 'Inbox', 'https://mail.google.com/'), 1);
  assert.equal(matchScore(['google'], 'Inbox', 'https://mail.google.com/'), 0.92);
});

test('duplicates across sources collapse into the best tier and keep every source', async () => {
  const { rank } = await load();
  const [item, ...rest] = rank({
    query: 'react', now: NOW,
    frequent: { k: { url: 'https://react.dev/', title: 'React', score: 1, t: NOW } },
    history: [{ url: 'https://www.react.dev/#top', title: 'React', visitCount: 3 }],
    bookmarks: [{ url: 'http://react.dev', title: 'React docs' }],
  });
  assert.equal(rest.length, 0);
  assert.equal(item.source, 'frequent');
  assert.deepEqual(item.sources.sort(), ['bookmark', 'frequent', 'history']);
});

test('LFU: repeated opens rank higher, and old habits decay with a 14-day half-life', async () => {
  const { recordVisit, decayed, rank, HALF_LIFE } = await load();
  let table = {};
  for (let i = 0; i < 5; i++) table = recordVisit(table, { url: 'https://old.example/', title: 'Old' }, NOW - 60 * DAY);
  table = recordVisit(table, { url: 'https://new.example/', title: 'New' }, NOW);
  table = recordVisit(table, { url: 'https://new.example/#x', title: 'New' }, NOW);
  assert.equal(Object.keys(table).length, 2, 'fragment is the same page');
  assert.equal(table['new.example'].count, 2);
  assert.ok(Math.abs(decayed(table['old.example'], NOW) - 5 * 0.5 ** (60 * DAY / HALF_LIFE)) < 1e-9);
  assert.deepEqual(rank({ frequent: table, now: NOW }).map(item => item.url), ['https://new.example/#x', 'https://old.example/']);
  assert.deepEqual(recordVisit({}, { url: 'chrome://settings' }, NOW), {}, 'internal pages are not counted');
});

test('the frequency table is bounded and evicts the least used entries', async () => {
  const { recordVisit } = await load();
  let table = {};
  for (let i = 0; i < 12; i++) table = recordVisit(table, { url: `https://s${i}.example/` }, NOW + i, { max: 10 });
  assert.equal(Object.keys(table).length, 10);
  assert.ok(table['s11.example'] && !table['s0.example']);
});

test('shortcut input: "/gi" suggests, "/git " activates the scope with the rest as the query', async () => {
  const { parseShortcutInput, DEFAULT_SHORTCUTS } = await load();
  const shortcuts = [...DEFAULT_SHORTCUTS, { key: 'gl', name: 'GitLab', domains: ['gitlab.com'], searchUrl: '' }];
  assert.deepEqual(parseShortcutInput('/g', shortcuts).suggestions.map(item => item.key), ['git', 'gl']);
  assert.deepEqual(parseShortcutInput('/gl', shortcuts).suggestions.map(item => item.key), ['gl']);
  assert.deepEqual(parseShortcutInput('/', shortcuts).suggestions.length, 4);
  const parsed = parseShortcutInput('/git  react hooks', shortcuts);
  assert.equal(parsed.activate.key, 'git');
  assert.equal(parsed.rest, 'react hooks');
  assert.equal(parseShortcutInput('/nope x', shortcuts), null);
  assert.equal(parseShortcutInput('git', shortcuts), null);
  assert.equal(parseShortcutInput('/usr/bin', shortcuts), null, 'paths are not shortcuts');
});

test('a scope restricts every source to its domains, including subdomains', async () => {
  const { rank, DEFAULT_SHORTCUTS } = await load();
  const scope = DEFAULT_SHORTCUTS[0];
  const results = rank({
    query: 'react', scope, now: NOW,
    frequent: { a: { url: 'https://react.dev/', title: 'React', score: 9, t: NOW } },
    history: [{ url: 'https://github.com/facebook/react', title: 'facebook/react' }, { url: 'https://gist.github.com/x/react', title: 'react gist' }, { url: 'https://notgithub.com/react', title: 'react' }],
    bookmarks: [{ url: 'https://github.com/reactjs/react.dev', title: 'react.dev source' }],
  });
  assert.deepEqual(results.map(item => item.url).sort(), ['https://gist.github.com/x/react', 'https://github.com/facebook/react', 'https://github.com/reactjs/react.dev']);
});

test('shortcut validation normalizes domains and rejects bad input', async () => {
  const { validateShortcut, normalizeShortcuts, DEFAULT_SHORTCUTS } = await load();
  assert.deepEqual(plain(validateShortcut({ key: '/Jira', name: '', domains: 'https://www.mycorp.atlassian.net/browse, *.jira.dev', searchUrl: '' })), {
    shortcut: { key: 'jira', name: 'mycorp.atlassian.net', domains: ['mycorp.atlassian.net', 'jira.dev'], searchUrl: '' },
  });
  assert.match(validateShortcut({ key: 'a b', domains: 'x.com' }).error, /快捷词/);
  assert.match(validateShortcut({ key: 'git', domains: 'x.com' }, DEFAULT_SHORTCUTS).error, /已存在/);
  assert.equal(validateShortcut({ key: 'git', domains: 'x.com' }, DEFAULT_SHORTCUTS, { editingKey: 'git' }).error, undefined);
  assert.match(validateShortcut({ key: 'x', domains: '' }).error, /域名/);
  assert.match(validateShortcut({ key: 'x', domains: 'ok.com, not a domain' }).error, /无效域名/);
  assert.match(validateShortcut({ key: 'x', domains: 'x.com', searchUrl: 'https://x.com/search' }).error, /%s/);
  assert.equal(normalizeShortcuts(undefined).length, DEFAULT_SHORTCUTS.length);
  assert.deepEqual(normalizeShortcuts([]), [], 'an emptied list stays empty');
  assert.deepEqual(normalizeShortcuts([{ key: 'ok', domains: ['ok.com'] }, { key: 'ok', domains: ['dup.com'] }, null]).map(item => item.key), ['ok']);
});

test('rows: typed URLs and weak matches lead with the action; strong matches lead with the result', async () => {
  const { buildRows, DEFAULT_SHORTCUTS } = await load();
  const strong = { url: 'https://github.com/', title: 'GitHub', match: 1, source: 'history' };
  const weak = { url: 'https://x.com/digital', title: 'x', match: 0.5, source: 'history' };
  assert.deepEqual(buildRows({ query: 'git', results: [strong] }).rows.map(row => row.type), ['result', 'search']);
  assert.deepEqual(buildRows({ query: 'git', results: [weak] }).rows.map(row => row.type), ['search', 'result']);
  const typed = buildRows({ query: 'localhost:3000/app', results: [strong] }).rows[0];
  assert.deepEqual({ type: typed.type, url: typed.url }, { type: 'url', url: 'http://localhost:3000/app' });
  const scoped = buildRows({ query: 'react hooks', scope: DEFAULT_SHORTCUTS[0], results: [] }).rows[0];
  assert.equal(scoped.url, 'https://github.com/search?q=react%20hooks&type=repositories');
  assert.equal(scoped.record, false, 'search pages are not counted as frequent sites');
  const noSearchUrl = buildRows({ query: 'x', scope: { key: 'a', name: 'A', domains: ['a.com'], searchUrl: '' }, results: [] }).rows[0];
  assert.deepEqual({ type: noSearchUrl.type, text: noSearchUrl.text }, { type: 'search', text: 'site:a.com x' });
  const home = buildRows({ query: '', scope: DEFAULT_SHORTCUTS[0], results: [] });
  assert.equal(home.rows[0].url, 'https://github.com/');
  assert.equal(buildRows({ query: '', results: [weak] }).selected, -1, 'Enter on an empty input opens nothing');
  assert.deepEqual(buildRows({ suggestions: DEFAULT_SHORTCUTS }).rows.map(row => row.shortcut.key), ['git', 'yt', 'mdn']);
});

test('internal and excluded pages never appear', async () => {
  const { rank } = await load();
  const results = rank({ query: '', now: NOW, exclude: ['chrome-extension://id/src/newtab/newtab.html'],
    topSites: [{ url: 'chrome://settings', title: 'Settings' }, { url: 'https://a.example/', title: 'A' }],
    frequent: { x: { url: 'chrome-extension://id/src/newtab/newtab.html', title: 'New tab', score: 5, t: NOW } } });
  assert.deepEqual(results.map(item => item.url), ['https://a.example/']);
});

test('Shift+Enter search text: the raw input, limited to the scope domain, nothing for empty input', async () => {
  const { engineQuery, buildRows, DEFAULT_SHORTCUTS } = await load();
  assert.equal(engineQuery('  react hooks '), 'react hooks');
  assert.equal(engineQuery('github.com'), 'github.com', 'a typed URL is searched as text');
  assert.equal(engineQuery('hooks', DEFAULT_SHORTCUTS[0]), 'site:github.com hooks');
  assert.equal(engineQuery('   '), '');
  const row = buildRows({ query: 'x y', results: [] }).rows.find(item => item.type === 'search');
  assert.equal(row.text, engineQuery('x y'), 'the search row and Shift+Enter send the same text');
});
