// Spotlight search for the Arcify new tab page. Pure functions only (no chrome.* calls),
// shared by the new tab page and the service worker, and unit tested in Node.

// ---------- Shortcut words ("/git github") ----------
export const DEFAULT_SHORTCUTS = Object.freeze([
  { key: 'git', name: 'GitHub', domains: ['github.com'], searchUrl: 'https://github.com/search?q=%s&type=repositories' },
  { key: 'yt', name: 'YouTube', domains: ['youtube.com'], searchUrl: 'https://www.youtube.com/results?search_query=%s' },
  { key: 'mdn', name: 'MDN', domains: ['developer.mozilla.org'], searchUrl: 'https://developer.mozilla.org/search?q=%s' },
]);
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$|^localhost$/;

export function normalizeDomain(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
  text = text.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
  return DOMAIN_PATTERN.test(text) ? text : '';
}
// Validates one shortcut; returns { shortcut } or { error } (messages are shown in settings).
export function validateShortcut(input, existing = [], { editingKey = null } = {}) {
  const key = String(input?.key ?? '').trim().replace(/^\//, '').toLowerCase();
  if (!KEY_PATTERN.test(key)) return { error: '快捷词只能包含小写字母、数字、- 和 _，最长 16 个字符' };
  if (existing.some(item => item.key === key && item.key !== editingKey)) return { error: `快捷词 /${key} 已存在` };
  const rawDomains = Array.isArray(input?.domains) ? input.domains : String(input?.domains ?? '').split(/[\s,，、]+/);
  const domains = [...new Set(rawDomains.map(normalizeDomain).filter(Boolean))];
  if (!domains.length) return { error: '请至少填写一个有效域名，例如 github.com' };
  const invalid = rawDomains.map(String).map(item => item.trim()).filter(item => item && !normalizeDomain(item));
  if (invalid.length) return { error: `无效域名：${invalid.join('、')}` };
  const searchUrl = String(input?.searchUrl ?? '').trim();
  if (searchUrl && (!/^https?:\/\//i.test(searchUrl) || !searchUrl.includes('%s'))) return { error: '站内搜索地址需以 http(s):// 开头并包含 %s，例如 https://github.com/search?q=%s' };
  const name = String(input?.name ?? '').trim().slice(0, 40) || domains[0];
  return { shortcut: { key, name, domains, searchUrl } };
}
export function normalizeShortcuts(value) {
  if (!Array.isArray(value)) return DEFAULT_SHORTCUTS.map(item => ({ ...item, domains: [...item.domains] }));
  const result = [];
  for (const item of value) {
    const { shortcut } = validateShortcut(item, result);
    if (shortcut) result.push(shortcut);
  }
  return result;
}
// "/gi" → shortcut suggestions; "/git " → activates the GitHub scope with the rest as query.
export function parseShortcutInput(text, shortcuts) {
  const match = /^\/([^\s/]*)(\s+([\s\S]*))?$/.exec(String(text ?? ''));
  if (!match) return null;
  const typed = match[1].toLowerCase();
  if (match[2] !== undefined) {
    const shortcut = shortcuts.find(item => item.key === typed);
    return shortcut ? { activate: shortcut, rest: match[3] ?? '' } : null;
  }
  const suggestions = shortcuts
    .filter(item => item.key.startsWith(typed) || (typed && item.name.toLowerCase().includes(typed)))
    .sort((a, b) => (b.key === typed) - (a.key === typed) || (b.key.startsWith(typed)) - (a.key.startsWith(typed)) || a.key.localeCompare(b.key));
  return { typed, suggestions };
}

// ---------- URLs ----------
// Parsing URLs dominated ranking time: every keystroke re-parsed every candidate 3–4 times.
// Parsed parts are cached per URL (bounded; cleared when full).
const PARSED = new Map();
const PARSED_MAX = 20000;
export function parseUrl(url) {
  const text = String(url ?? '');
  let entry = PARSED.get(text);
  if (entry) return entry;
  entry = { host: '', hostParts: [], rest: text.toLowerCase(), key: text };
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let rest = parsed.pathname + parsed.search;
    try { rest = decodeURIComponent(rest); } catch {}
    entry = {
      host, hostParts: host.split('.'), rest: rest.toLowerCase(),
      key: `${host}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`,
    };
  } catch {}
  if (PARSED.size >= PARSED_MAX) PARSED.clear();
  PARSED.set(text, entry);
  return entry;
}
export function hostOf(url) { return parseUrl(url).host; }
export function inScope(url, scope) {
  if (!scope) return true;
  const host = hostOf(url);
  return !!host && scope.domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
// Dedupe key: scheme, "www.", fragment and trailing slash do not make a different page.
export function urlKey(url) { return parseUrl(url).key; }
const OPENABLE = /^(https?|file|ftp):/i;
export function isOpenable(url) { return OPENABLE.test(String(url || '')); }

const SCHEMES = new Set(['http:', 'https:', 'file:', 'chrome:', 'about:', 'view-source:']);
const HOST_LIKE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\]|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;
// Same rules as the Peek address bar: a URL (scheme optional) or a search.
export function resolveInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (!/\s/.test(text)) {
    if (HOST_LIKE.test(text)) {
      const local = /^(localhost|\d|\[)/i.test(text);
      try { return { url: new URL(`${local ? 'http' : 'https'}://${text}`).href }; } catch {}
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
      try { const url = new URL(text); if (SCHEMES.has(url.protocol)) return { url: url.href }; } catch {}
    }
  }
  return { search: text };
}

// ---------- Matching ----------
export function tokenize(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
function startsWord(text, term) {
  let index = text.indexOf(term);
  while (index !== -1) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1])) return true;
    index = text.indexOf(term, index + 1);
  }
  return false;
}
// 0 = no match; otherwise 0.5 … 1. Every term must match somewhere.
export function matchScore(terms, title, url) {
  if (!terms.length) return 0.5;
  const { host, hostParts, rest } = parseUrl(url);
  const name = String(title || '').toLowerCase();
  let total = 0;
  for (const term of terms) {
    let score = 0;
    if (host.startsWith(term)) score = 1;
    else if (hostParts.some(part => part.startsWith(term))) score = 0.92;
    else if (startsWord(name, term)) score = 0.85;
    else if (CJK.test(term) && name.includes(term)) score = 0.85;
    else if (host.includes(term)) score = 0.7;
    else if (name.includes(term)) score = 0.6;
    else if (rest.includes(term)) score = 0.5;
    else return 0;
    total += score;
  }
  return total / terms.length;
}

// ---------- Frequently used (LFU with ageing) ----------
// Each open adds 1 to a score that halves every HALF_LIFE, so frequency wins but old habits fade.
export const HALF_LIFE = 14 * 24 * 60 * 60 * 1000;
export const MAX_FREQUENT = 500;
export function decayed(entry, now, halfLife = HALF_LIFE) {
  if (!entry || !Number.isFinite(entry.score)) return 0;
  return entry.score * 0.5 ** (Math.max(0, now - (entry.t || now)) / halfLife);
}
export function recordVisit(table, { url, title }, now, { halfLife = HALF_LIFE, max = MAX_FREQUENT } = {}) {
  const next = { ...(table || {}) };
  if (!isOpenable(url)) return next;
  const key = urlKey(url);
  const previous = next[key];
  next[key] = { url, title: String(title || previous?.title || ''), score: decayed(previous, now, halfLife) + 1, t: now, count: (previous?.count || 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length > max) {
    keys.sort((a, b) => decayed(next[a], now, halfLife) - decayed(next[b], now, halfLife)).slice(0, keys.length - max).forEach(item => { if (item !== key) delete next[item]; });
  }
  return next;
}

// ---------- Ranking ----------
// Sources are searched in the user's priority order: frequent > history > bookmarks.
// The tier dominates; within a tier, match quality then usage decides.
export const TIERS = { frequent: 3, history: 2, bookmark: 1 };
export const SOURCE_LABELS = { frequent: '常用', history: '历史', bookmark: '书签' };
export function rank({ query = '', scope = null, frequent = {}, topSites = [], history = [], bookmarks = [], now = Date.now(), limit = 8, exclude = [] } = {}) {
  const terms = tokenize(query);
  const excluded = new Set(exclude.map(urlKey));
  const byKey = new Map();
  function add(source, url, title, usage) {
    if (!isOpenable(url)) return;
    const match = matchScore(terms, title, url);
    if (!match || !inScope(url, scope)) return;
    const key = urlKey(url);
    if (excluded.has(key)) return;
    const score = TIERS[source] + match * 0.9 + Math.min(1, Math.max(0, usage)) * 0.09;
    const current = byKey.get(key);
    if (current) {
      current.sources.add(source);
      if (score <= current.score) return;
      Object.assign(current, { url, title: title || current.title, source, score, match });
    } else byKey.set(key, { key, url, title: title || '', source, score, match, sources: new Set([source]) });
  }
  for (const entry of Object.values(frequent || {})) {
    const value = decayed(entry, now);
    add('frequent', entry.url, entry.title, 1 - 1 / (1 + value));
  }
  // Chrome's own most-visited sites back up the table until Arcify has learned enough.
  for (const site of topSites) add('frequent', site.url, site.title, 0);
  for (const item of history) {
    const visits = (item.visitCount || 0) + 2 * (item.typedCount || 0);
    const ageDays = Math.max(0, (now - (item.lastVisitTime || 0)) / 86_400_000);
    add('history', item.url, item.title, 0.7 * (1 - 1 / (1 + visits / 5)) + 0.3 / (1 + ageDays / 7));
  }
  for (const item of bookmarks) {
    if (!item.url) continue;
    const used = item.dateLastUsed || item.dateAdded || 0;
    add('bookmark', item.url, item.title, 1 / (1 + Math.max(0, now - used) / (30 * 86_400_000)));
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, limit)
    .map(item => ({ ...item, sources: [...item.sources] }));
}

// Text sent to the default search engine for this input (also used by Shift+Enter).
// Inside a shortcut scope the search is limited to its first domain.
export function engineQuery(query, scope = null) {
  const text = String(query ?? '').trim();
  if (!text) return '';
  return scope ? `site:${scope.domains[0]} ${text}` : text;
}

// Rows shown under the input. The row selected by default always comes first:
// a typed URL, otherwise a strong match, otherwise the search action.
export function buildRows({ query = '', scope = null, results = [], shortcuts = [], suggestions = null }) {
  if (suggestions) {
    return { rows: suggestions.map(shortcut => ({ type: 'shortcut', shortcut })), selected: 0 };
  }
  const text = String(query).trim();
  let action = null;
  if (!text) {
    if (scope) action = { type: 'url', url: `https://${scope.domains[0]}/`, label: `打开 ${scope.name}`, record: true };
  } else if (scope?.searchUrl) {
    action = { type: 'url', url: scope.searchUrl.replace(/%s/g, encodeURIComponent(text)), label: `在 ${scope.name} 中搜索「${text}」`, record: false };
  } else {
    const target = resolveInput(text);
    action = target.url
      ? { type: 'url', url: target.url, label: `打开 ${target.url}`, record: true, typedUrl: true }
      : { type: 'search', text: engineQuery(text, scope), label: `搜索「${text}」` };
  }
  const resultRows = results.map(result => ({ type: 'result', ...result }));
  // Empty input: suggestions are listed, but Enter only opens one after ↑/↓ picks it.
  if (!action) return { rows: resultRows, selected: text ? 0 : -1 };
  const strong = !action.typedUrl && resultRows[0]?.match >= 0.85;
  return { rows: strong ? [...resultRows, action] : [action, ...resultRows], selected: 0 };
}
