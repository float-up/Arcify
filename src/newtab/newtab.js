import {
  DEFAULT_SHORTCUTS, SOURCE_LABELS, buildRows, normalizeShortcuts, parseShortcutInput, rank, validateShortcut,
  parseUrl,
} from './search.js';
import { createRemoteQuery } from './remote-query.js';

const SPRITE = '../../assets/icons.svg';
const SELF = chrome.runtime.getURL('src/newtab/newtab.html');
const MAX_RESULTS = 8;
const input = document.querySelector('#query');
const list = document.querySelector('#results');
const chip = document.querySelector('#scope-chip');
const settings = document.querySelector('#settings');
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
document.querySelector('#mod-key').textContent = isMac ? '⌘' : 'Ctrl';

// ---------- Focus ----------
// focus-boot.js already made this a page that is allowed to take focus. These listeners
// keep the caret in the input in every other case: the tab opened in the background and
// activated later, the window regaining focus, Back into a cached page, or focus ending
// up on the page body. They never take focus away from the settings dialog.
function focusInput({ force = false } = {}) {
  if (settings.open) return;
  const active = document.activeElement;
  if (!force && active && active !== document.body && active !== document.documentElement && active !== input) return;
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}
focusInput({ force: true });
requestAnimationFrame(() => focusInput());
addEventListener('focus', () => focusInput());
addEventListener('pageshow', () => focusInput({ force: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) focusInput(); });
// Safety net: a printable key pressed while the body has focus goes to the input. Moving
// focus during keydown makes Chrome insert the character into the input.
document.addEventListener('keydown', event => {
  if (settings.open || event.target !== document.body || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.length === 1 || event.key === 'Backspace' || event.key.startsWith('Arrow')) focusInput({ force: true });
}, true);
document.querySelector('#spotlight').addEventListener('mousedown', event => {
  if (event.target === event.currentTarget) { event.preventDefault(); focusInput({ force: true }); }
});

// ---------- State ----------
let shortcuts = normalizeShortcuts(undefined);
let frequent = {};
let topSites = [];
let scope = null;
let rows = [];
let selected = -1;
let navigated = false; // the user moved the selection since the last keystroke

const stored = await chrome.storage.local.get(['newtabShortcuts', 'newtabFrequent', 'appearance']);
window.SidebarAppearance?.apply(stored.appearance);
shortcuts = normalizeShortcuts(stored.newtabShortcuts);
frequent = stored.newtabFrequent || {};
setTimeout(() => warm(Object.values(frequent)), 0);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.appearance) window.SidebarAppearance?.apply(changes.appearance.newValue);
  if (changes.newtabShortcuts) { shortcuts = normalizeShortcuts(changes.newtabShortcuts.newValue); renderShortcutList(); }
  if (changes.newtabFrequent) { frequent = changes.newtabFrequent.newValue || {}; update({ background: true }); }
});
chrome.topSites?.get().then(sites => { topSites = sites || []; update({ background: true }); }).catch(() => {});

// ---------- Search ----------
// Results are computed synchronously from in-memory indexes on every keystroke, so the
// list always matches what is typed (and Enter always acts on it). The slow, serialized
// chrome.history query only runs when typing pauses and adds older matches afterwards.
const HISTORY_PRELOAD = { days: 90, max: 3000 };
const historyIndex = new Map(); // url -> history item
let bookmarkIndex = [];
function mergeHistory(items) {
  for (const item of items || []) {
    if (!item?.url) continue;
    const known = historyIndex.get(item.url);
    if (!known || (item.lastVisitTime || 0) >= (known.lastVisitTime || 0)) historyIndex.set(item.url, item);
  }
}
async function loadBookmarks() {
  if (!chrome.bookmarks) return;
  const flat = [];
  const stack = await chrome.bookmarks.getTree().catch(() => []);
  while (stack.length) {
    const node = stack.pop();
    if (node.url) flat.push(node);
    if (node.children) stack.push(...node.children);
  }
  bookmarkIndex = flat;
  warm(flat);
  update({ background: true });
}
let bookmarkReload;
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onImportEnded']) {
  chrome.bookmarks?.[event]?.addListener(() => { clearTimeout(bookmarkReload); bookmarkReload = setTimeout(loadBookmarks, 300); });
}
const remote = createRemoteQuery({
  async run({ query, domains }) {
    const texts = domains ? domains.map(domain => `${query} ${domain}`.trim()) : [query];
    const batches = await Promise.all(texts.map(text => chrome.history.search({ text, startTime: 0, maxResults: 100 })));
    const before = historyIndex.size;
    batches.forEach(mergeHistory);
    if (historyIndex.size !== before) update({ background: true });
  },
});
// Parse indexed URLs in idle time, so the first keystroke does not pay for thousands of parses.
function warm(items) {
  const queue = [...items];
  const idle = globalThis.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 16));
  const step = deadline => {
    while (queue.length && deadline.timeRemaining() > 2) {
      for (const item of queue.splice(0, 200)) parseUrl(item.url);
    }
    if (queue.length) idle(step);
  };
  idle(step);
}
// Index loading starts after the first paint so it never delays focus or the first frame.
setTimeout(() => {
  loadBookmarks();
  chrome.history?.search({ text: '', startTime: Date.now() - HISTORY_PRELOAD.days * 86_400_000, maxResults: HISTORY_PRELOAD.max })
    .then(items => { mergeHistory(items); warm(items); update({ background: true }); }).catch(() => {});
}, 0);

// `background`: new data arrived while the input did not change; keep the user's selection.
function update({ background = false } = {}) {
  if (composing) return;
  if (!background) navigated = false;
  const text = input.value;
  const parsed = scope ? null : parseShortcutInput(text, shortcuts);
  if (parsed?.activate) { setScope(parsed.activate, parsed.rest); return; }
  if (parsed?.suggestions) { render(buildRows({ suggestions: parsed.suggestions }), { keep: background && navigated }); return; }
  const query = text.trim();
  const searching = !!(query || scope);
  const results = rank({
    query, scope, frequent, now: Date.now(), limit: MAX_RESULTS, exclude: [SELF],
    topSites: searching ? topSites : topSites.slice(0, 8),
    history: searching ? historyIndex.values() : [],
    bookmarks: searching ? bookmarkIndex : [],
  });
  render(buildRows({ query, scope, results, shortcuts }), { keep: background && navigated });
  if (chrome.history && searching && !background) remote.request(`${scope?.key ?? ''}|${query.toLowerCase()}`, { query, domains: scope?.domains });
}
// IME (e.g. Chinese pinyin): do not search for every intermediate letter.
let composing = false;
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; update(); });
function setScope(shortcut, rest = '') {
  scope = shortcut;
  chip.hidden = !shortcut;
  if (shortcut) {
    chip.replaceChildren(Object.assign(document.createElement('b'), { textContent: `/${shortcut.key}` }), document.createTextNode(shortcut.name));
    chip.title = `只搜索 ${shortcut.domains.join('、')}（Backspace 或 Esc 退出）`;
  }
  input.placeholder = shortcut ? `在 ${shortcut.name} 中搜索…` : '搜索或输入网址，输入 / 使用快捷词';
  input.value = rest;
  update();
}

// ---------- Rendering ----------
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ui-icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE}#${name}`); svg.append(use);
  return svg;
}
function favicon(url) {
  const image = document.createElement('img');
  image.className = 'favicon'; image.alt = ''; image.decoding = 'async';
  // Chrome's local favicon store: same origin, no network request.
  image.src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
  return image;
}
function displayUrl(url) {
  try {
    const parsed = new URL(url);
    let rest = parsed.pathname === '/' ? '' : parsed.pathname;
    try { rest = decodeURI(rest); } catch {}
    return parsed.host.replace(/^www\./, '') + rest + parsed.search;
  } catch { return url; }
}
function rowContent(row) {
  const lead = document.createElement('span'); lead.className = 'lead';
  const main = document.createElement('span'); main.className = 'main';
  const title = document.createElement('span'); title.className = 'title';
  const sub = document.createElement('span'); sub.className = 'sub';
  let badge = '';
  if (row.type === 'result') {
    lead.append(favicon(row.url));
    title.textContent = row.title || displayUrl(row.url);
    sub.textContent = displayUrl(row.url);
    badge = SOURCE_LABELS[row.source];
  } else if (row.type === 'shortcut') {
    lead.append(Object.assign(document.createElement('span'), { className: 'slash', textContent: '/' }));
    title.textContent = `/${row.shortcut.key}  ${row.shortcut.name}`;
    sub.textContent = `只在 ${row.shortcut.domains.join('、')} 中搜索`;
    badge = 'Tab';
  } else {
    lead.append(row.type === 'search' ? icon('search') : favicon(row.url));
    title.textContent = row.label;
    if (row.type === 'url' && !row.label.includes(row.url)) sub.textContent = displayUrl(row.url);
  }
  main.append(title);
  if (sub.textContent) main.append(sub);
  const tail = document.createElement('span'); tail.className = 'tail';
  if (badge) tail.append(Object.assign(document.createElement('span'), { className: `badge ${row.source || row.type}`, textContent: badge }));
  tail.append(Object.assign(document.createElement('kbd'), { className: 'enter', textContent: '↵' }));
  return [lead, main, tail];
}
// Rows are reused by content, so an unchanged row (and its favicon) is not rebuilt,
// re-requested or re-laid out while typing.
let rowElements = new Map();
function rowSignature(row) {
  return [row.type, row.url || '', row.text || '', row.title || row.label || '', row.source || '', row.shortcut?.key || ''].join('\u0001');
}
function createRow(row) {
  const item = document.createElement('li');
  item.className = `row ${row.type}`; item.setAttribute('role', 'option');
  item.append(...rowContent(row));
  item.addEventListener('mousemove', () => { const index = Number(item.dataset.index); if (selected !== index) { navigated = true; select(index); } });
  item.addEventListener('mousedown', event => event.preventDefault()); // keep focus in the input
  item.addEventListener('click', event => activate(Number(item.dataset.index), { newTab: event.metaKey || event.ctrlKey }));
  return item;
}
function render(built, { keep = false } = {}) {
  const keptSignature = keep && selected >= 0 && rows[selected] ? rowSignature(rows[selected]) : null;
  rows = built.rows;
  const next = new Map();
  const items = rows.map((row, index) => {
    const signature = rowSignature(row);
    const item = (!next.has(signature) && rowElements.get(signature)) || createRow(row);
    next.set(signature, item);
    item.dataset.index = index; item.id = `row-${index}`;
    return item;
  });
  rowElements = next;
  if (items.length !== list.children.length || items.some((item, index) => list.children[index] !== item)) list.replaceChildren(...items);
  list.hidden = !rows.length;
  input.setAttribute('aria-expanded', String(!!rows.length));
  const kept = keptSignature ? rows.findIndex(row => rowSignature(row) === keptSignature) : -1;
  select(kept >= 0 ? kept : built.selected);
}
function select(index) {
  const previous = selected;
  selected = rows.length ? Math.max(-1, Math.min(index, rows.length - 1)) : -1;
  [...list.children].forEach((item, position) => item.setAttribute('aria-selected', String(position === selected)));
  if (selected >= 0) { input.setAttribute('aria-activedescendant', `row-${selected}`); if (selected !== previous) list.children[selected].scrollIntoView({ block: 'nearest' }); }
  else input.removeAttribute('aria-activedescendant');
}

// ---------- Actions ----------
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
}
async function activate(index, { newTab = false } = {}) {
  const row = rows[index];
  if (!row) return;
  try {
    if (row.type === 'shortcut') { setScope(row.shortcut); return; }
    if (row.type === 'search') await send({ type: 'newtab:search', text: row.text, newTab });
    else await send({ type: 'newtab:open', url: row.url, title: row.title || '', record: row.type === 'result' || row.record === true, newTab });
    if (newTab) toast('已在后台标签页打开');
  } catch (error) { toast(error.message, true); }
}
input.addEventListener('input', () => update());
input.addEventListener('keydown', event => {
  // IME composition (e.g. Chinese pinyin): Enter / arrows belong to the input method.
  if (event.isComposing || event.keyCode === 229) return;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const move = delta => {
    event.preventDefault();
    if (!rows.length) return;
    const next = selected + delta;
    navigated = true;
    select(next < 0 ? rows.length - 1 : next >= rows.length ? 0 : next);
  };
  if (event.key === 'ArrowDown' || (isMac && event.ctrlKey && event.key === 'n')) move(1);
  else if (event.key === 'ArrowUp' || (isMac && event.ctrlKey && event.key === 'p')) move(-1);
  else if (event.key === 'Enter') { event.preventDefault(); if (selected >= 0) activate(selected, { newTab: mod }); }
  else if (event.key === 'Tab' && !event.shiftKey && rows[selected]?.type === 'shortcut') { event.preventDefault(); setScope(rows[selected].shortcut); }
  else if (event.key === 'Tab' && !event.shiftKey && !scope) {
    // "/git" + Tab activates the scope like "/git ".
    const parsed = parseShortcutInput(input.value, shortcuts);
    const exact = parsed?.suggestions?.find(item => item.key === parsed.typed);
    if (exact) { event.preventDefault(); setScope(exact); }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (input.value) { input.value = ''; update(); } else if (scope) setScope(null);
  } else if (event.key === 'Backspace' && scope && input.selectionStart === 0 && input.selectionEnd === 0) {
    event.preventDefault(); setScope(null);
  }
});
chip.addEventListener('click', () => { setScope(null); focusInput({ force: true }); });

let toastTimer;
function toast(message, error = false) {
  const el = document.querySelector('#toast');
  el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------- Settings: shortcut words ----------
const fields = {
  key: document.querySelector('#shortcut-key'), name: document.querySelector('#shortcut-name'),
  domains: document.querySelector('#shortcut-domains'), searchUrl: document.querySelector('#shortcut-search'),
};
const formError = document.querySelector('#shortcut-error');
const saveButton = document.querySelector('#save-shortcut');
const cancelButton = document.querySelector('#cancel-edit');
let editingKey = null;
function resetEditor() {
  editingKey = null;
  for (const field of Object.values(fields)) field.value = '';
  formError.hidden = true;
  saveButton.textContent = '添加'; cancelButton.hidden = true;
  document.querySelector('#editor-title').textContent = '新增快捷词';
}
function renderShortcutList() {
  const listEl = document.querySelector('#shortcut-list');
  if (!shortcuts.length) { listEl.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: '还没有快捷词' })); return; }
  listEl.replaceChildren(...shortcuts.map(shortcut => {
    const item = document.createElement('li');
    const info = document.createElement('span'); info.className = 'info';
    info.append(Object.assign(document.createElement('b'), { textContent: `/${shortcut.key}` }),
      Object.assign(document.createElement('span'), { textContent: shortcut.name }),
      Object.assign(document.createElement('small'), { textContent: shortcut.domains.join(', ') + (shortcut.searchUrl ? ' · 支持站内搜索' : '') }));
    const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-button', title: '编辑' });
    edit.setAttribute('aria-label', `编辑 /${shortcut.key}`); edit.append(icon('edit'));
    edit.onclick = () => {
      editingKey = shortcut.key;
      fields.key.value = shortcut.key; fields.name.value = shortcut.name;
      fields.domains.value = shortcut.domains.join(', '); fields.searchUrl.value = shortcut.searchUrl;
      saveButton.textContent = '保存'; cancelButton.hidden = false; formError.hidden = true;
      document.querySelector('#editor-title').textContent = `编辑 /${shortcut.key}`;
      fields.key.focus();
    };
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-button danger', title: '删除' });
    remove.setAttribute('aria-label', `删除 /${shortcut.key}`); remove.append(icon('trash'));
    remove.onclick = () => saveShortcuts(shortcuts.filter(item => item.key !== shortcut.key));
    item.append(info, edit, remove);
    return item;
  }));
}
async function saveShortcuts(next) {
  shortcuts = next;
  renderShortcutList();
  await chrome.storage.local.set({ newtabShortcuts: next });
  if (scope && !next.some(item => item.key === scope.key)) setScope(null);
}
saveButton.onclick = async () => {
  const others = shortcuts.filter(item => item.key !== editingKey);
  const { shortcut, error } = validateShortcut(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])), others);
  if (error) { formError.textContent = error; formError.hidden = false; return; }
  const next = editingKey ? shortcuts.map(item => item.key === editingKey ? shortcut : item) : [...shortcuts, shortcut];
  await saveShortcuts(next);
  toast(editingKey ? `已保存 /${shortcut.key}` : `已添加 /${shortcut.key}`);
  resetEditor();
};
cancelButton.onclick = resetEditor;
document.querySelector('#reset-shortcuts').onclick = () => saveShortcuts(DEFAULT_SHORTCUTS.map(item => ({ ...item, domains: [...item.domains] })));
document.querySelector('#clear-frequent').onclick = async () => {
  frequent = {};
  await chrome.storage.local.remove('newtabFrequent');
  toast('已清除常用网址记录');
  update();
};
for (const field of Object.values(fields)) field.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveButton.click(); }
});
document.querySelector('#open-settings').onclick = () => { resetEditor(); renderShortcutList(); settings.showModal(); fields.key.focus(); };
settings.addEventListener('close', () => focusInput({ force: true }));
settings.addEventListener('click', event => { if (event.target === settings) settings.close(); });

renderShortcutList();
update();
