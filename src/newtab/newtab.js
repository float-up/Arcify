import {
  DEFAULT_SHORTCUTS, SOURCE_LABELS, buildRows, normalizeShortcuts, parseShortcutInput, rank, validateShortcut,
  parseUrl, engineQuery,
} from './search.js';
import { createRemoteQuery } from './remote-query.js';
import { ESCAPE_WINDOW, createEscapeGuard } from './escape-guard.js';
import * as Wallpaper from './wallpaper.js';

const SPRITE = '../../assets/icons.svg';
const SELF = chrome.runtime.getURL('src/newtab/newtab.html');
const MAX_RESULTS = 8;
const input = document.querySelector('#query');
const list = document.querySelector('#results');
const chip = document.querySelector('#scope-chip');
const settings = document.querySelector('#settings');
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
// Shortcut list in settings: ⌘ on macOS, Ctrl elsewhere; Ctrl+N/P is macOS only.
for (const key of document.querySelectorAll('.key-list .mod')) key.textContent = isMac ? '⌘' : 'Ctrl';
for (const extra of document.querySelectorAll('.key-list .mac-only')) extra.hidden = !isMac;

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

const stored = await chrome.storage.local.get(['newtabShortcuts', 'newtabFrequent', 'appearance', 'newtabEscapeClose', Wallpaper.STORAGE_KEY]);
window.SidebarAppearance?.apply(stored.appearance);
let escapeClose = stored.newtabEscapeClose !== false;
const escapeGuard = createEscapeGuard();
shortcuts = normalizeShortcuts(stored.newtabShortcuts);
frequent = stored.newtabFrequent || {};
setTimeout(() => warm(Object.values(frequent)), 0);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.appearance) window.SidebarAppearance?.apply(changes.appearance.newValue);
  if (changes.newtabShortcuts) { shortcuts = normalizeShortcuts(changes.newtabShortcuts.newValue); renderShortcutList(); }
  if (changes.newtabEscapeClose) { escapeClose = changes.newtabEscapeClose.newValue !== false; document.querySelector('#escape-close').checked = escapeClose; }
  if (changes[Wallpaper.STORAGE_KEY]) showWallpaper(Wallpaper.normalizeWallpaper(changes[Wallpaper.STORAGE_KEY].newValue));
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
  // The search row also shows its own shortcut, since it is often far down the list.
  if (row.type === 'search') tail.append(Object.assign(document.createElement('kbd'), { className: 'engine-key', textContent: '⇧↵', title: 'Shift+Enter：随时用默认搜索引擎搜索' }));
  tail.append(Object.assign(document.createElement('kbd'), { className: 'enter', textContent: '↵' }));
  tail.append(Object.assign(document.createElement('span'), { className: 'spinner', role: 'img', ariaLabel: '正在打开' }));
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
// Shift+Enter: search the typed text with the default search engine, whatever is selected.
// A typed URL or a "/git" suggestion is searched as plain text too.
// ---------- Opening feedback ----------
// From the moment a choice is confirmed until the target page commits (which unloads this
// page), show that it is opening: an indeterminate bar on the card and a spinner on the
// chosen row. Nothing else can be triggered meanwhile. If the tab never leaves (a download,
// a 204 response, an error) the state clears itself.
const card = document.querySelector('.search-card');
const OPENING_TIMEOUT = 15_000;
let opening = null;
function startOpening(index) {
  stopOpening();
  const item = index >= 0 ? list.children[index] : null;
  item?.classList.add('opening');
  item?.scrollIntoView({ block: 'nearest' }); // e.g. Shift+Enter: the search row is often far down
  card.classList.add('opening');
  card.setAttribute('aria-busy', 'true');
  input.readOnly = true;
  opening = { item, timer: setTimeout(() => stopOpening(), OPENING_TIMEOUT) };
}
function stopOpening() {
  if (!opening) return;
  clearTimeout(opening.timer);
  opening.item?.classList.remove('opening');
  card.classList.remove('opening');
  card.removeAttribute('aria-busy');
  input.readOnly = false;
  opening = null;
  focusInput({ force: true });
}
// Back into this page from the bfcache: it must not still look busy.
addEventListener('pageshow', event => { if (event.persisted) stopOpening(); });
async function navigate(message, index, newTab) {
  if (opening) return;
  if (newTab) {
    try { await send({ ...message, newTab }); toast(message.type === 'newtab:search' ? '已在后台标签页搜索' : '已在后台标签页打开'); }
    catch (error) { toast(error.message, { error: true }); }
    return;
  }
  startOpening(index); // before the message: feedback is immediate
  try { await send(message); }
  catch (error) { stopOpening(); toast(error.message, { error: true }); }
}
async function searchEngine({ newTab = false } = {}) {
  const text = engineQuery(input.value, scope);
  if (!text) return;
  navigate({ type: 'newtab:search', text }, rows.findIndex(row => row.type === 'search' && row.text === text), newTab);
}
async function activate(index, { newTab = false } = {}) {
  const row = rows[index];
  if (!row || opening) return;
  if (row.type === 'shortcut') { setScope(row.shortcut); return; }
  const message = row.type === 'search'
    ? { type: 'newtab:search', text: row.text }
    : { type: 'newtab:open', url: row.url, title: row.title || '', record: row.type === 'result' || row.record === true };
  navigate(message, index, newTab);
}
// Wake the service worker while the user is still typing, so Enter does not wait for it.
let lastPing = 0;
function wakeWorker() {
  if (Date.now() - lastPing < 20_000) return;
  lastPing = Date.now();
  chrome.runtime.sendMessage({ type: 'newtab:ping' }).catch(() => {});
}
wakeWorker();
// Any edit (typing, paste, IME) between the two presses cancels the pending close.
input.addEventListener('input', () => { wakeWorker(); if (escapeGuard.armed) { escapeGuard.reset(); hideToast('escape'); } update(); });
input.addEventListener('keydown', event => {
  // IME composition (e.g. Chinese pinyin): Enter / arrows belong to the input method.
  if (event.isComposing || event.keyCode === 229) return;
  if (opening) {
    // The page is about to be replaced: ignore further input. Esc only dismisses the indicator.
    if (event.key === 'Escape') stopOpening();
    if (!['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) event.preventDefault();
    return;
  }
  if (event.key !== 'Escape' && !['Shift', 'Meta', 'Control', 'Alt'].includes(event.key) && escapeGuard.armed) { escapeGuard.reset(); hideToast('escape'); }
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
  else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); searchEngine({ newTab: mod }); }
  else if (event.key === 'Enter') { event.preventDefault(); if (selected >= 0) activate(selected, { newTab: mod }); }
  else if (event.key === 'Tab' && !event.shiftKey && rows[selected]?.type === 'shortcut') { event.preventDefault(); setScope(rows[selected].shortcut); }
  else if (event.key === 'Tab' && !event.shiftKey && !scope) {
    // "/git" + Tab activates the scope like "/git ".
    const parsed = parseShortcutInput(input.value, shortcuts);
    const exact = parsed?.suggestions?.find(item => item.key === parsed.typed);
    if (exact) { event.preventDefault(); setScope(exact); }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (escapeClose && escapeGuard.press() === 'close') { hideToast('escape'); closeTab(); return; }
    if (input.value) { input.value = ''; update(); } else if (scope) setScope(null);
    if (escapeClose) toast('再按一次 Esc 关闭标签页', { duration: ESCAPE_WINDOW, countdown: true, tag: 'escape' });
  } else if (event.key === 'Backspace' && scope && input.selectionStart === 0 && input.selectionEnd === 0) {
    event.preventDefault(); setScope(null);
  }
});
chip.addEventListener('click', () => { setScope(null); focusInput({ force: true }); });

let toastTimer;
const toastEl = document.querySelector('#toast');
function toast(message, { error = false, duration = 2400, countdown = false, tag = '' } = {}) {
  toastEl.textContent = message; toastEl.dataset.tag = tag;
  toastEl.classList.toggle('error', error);
  toastEl.classList.remove('countdown');
  toastEl.style.setProperty('--countdown', `${duration}ms`);
  toastEl.hidden = false;
  if (countdown) { void toastEl.offsetWidth; toastEl.classList.add('countdown'); } // restart the bar
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, duration);
}
function hideToast(tag) {
  if (tag && toastEl.dataset.tag !== tag) return;
  clearTimeout(toastTimer); toastEl.hidden = true;
}
async function closeTab() {
  try { await chrome.tabs.remove((await chrome.tabs.getCurrent()).id); }
  catch { window.close(); }
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
document.querySelector('#open-settings').onclick = () => { resetEditor(); renderShortcutList(); settings.showModal(); settings.scrollTop = 0; document.querySelector('#choose-wallpaper').focus(); };
settings.addEventListener('close', () => focusInput({ force: true }));
settings.addEventListener('click', event => { if (event.target === settings) settings.close(); });

// ---------- Settings: Esc ----------
const escapeInput = document.querySelector('#escape-close');
escapeInput.checked = escapeClose;
escapeInput.addEventListener('change', () => {
  escapeClose = escapeInput.checked;
  if (!escapeClose) escapeGuard.reset();
  chrome.storage.local.set({ newtabEscapeClose: escapeClose }).catch(error => toast(error.message, { error: true }));
});

// ---------- Wallpaper ----------
const wallpaperLayer = document.querySelector('#wallpaper-image');
const preview = document.querySelector('#wallpaper-preview');
const dimInput = document.querySelector('#wallpaper-dim');
const blurInput = document.querySelector('#wallpaper-blur');
const fileInput = document.querySelector('#wallpaper-file');
const wallpaperError = document.querySelector('#wallpaper-error');
let wallpaper = Wallpaper.normalizeWallpaper(stored[Wallpaper.STORAGE_KEY]);
let wallpaperUrl = '', loadedVersion = -1;
function renderWallpaperControls() {
  dimInput.value = wallpaper.dim; blurInput.value = wallpaper.blur;
  document.querySelector('#wallpaper-dim-value').textContent = `${wallpaper.dim}%`;
  document.querySelector('#wallpaper-blur-value').textContent = `${wallpaper.blur}px`;
  dimInput.disabled = blurInput.disabled = !wallpaper.enabled;
  document.querySelector('#remove-wallpaper').hidden = !wallpaper.enabled;
  document.querySelector('#choose-wallpaper').textContent = wallpaper.enabled ? '更换图片' : '选择图片';
  document.querySelector('#wallpaper-empty').hidden = wallpaper.enabled;
  preview.classList.toggle('has-image', wallpaper.enabled);
  preview.style.backgroundImage = wallpaper.enabled ? `url("${wallpaperUrl || wallpaper.placeholder}")` : '';
  preview.style.setProperty('--preview-dim', `${wallpaper.dim}%`);
}
// Variables apply at once (they are cheap); the full image is read and decoded only when
// it changed, then faded in over the placeholder painted by wallpaper-boot.js.
async function showWallpaper(next) {
  wallpaper = next;
  Wallpaper.applyVariables(wallpaper);
  Wallpaper.writeCache(wallpaper);
  renderWallpaperControls();
  if (!wallpaper.enabled) {
    wallpaperLayer.classList.remove('loaded'); wallpaperLayer.style.backgroundImage = '';
    if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
    wallpaperUrl = ''; loadedVersion = -1;
    return;
  }
  if (loadedVersion === wallpaper.version) return;
  const version = wallpaper.version;
  try {
    const blob = await Wallpaper.readImage();
    if (!blob) throw new Error('missing');
    const url = URL.createObjectURL(blob);
    const image = new Image(); image.src = url;
    await image.decode();
    if (wallpaper.version !== version || !wallpaper.enabled) { URL.revokeObjectURL(url); return; }
    if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
    wallpaperUrl = url; loadedVersion = version;
    wallpaperLayer.style.backgroundImage = `url("${url}")`;
    wallpaperLayer.classList.add('loaded');
    renderWallpaperControls();
  } catch {
    // The image is gone (e.g. site data cleared): keep the placeholder only.
  }
}
async function setWallpaperFile(file) {
  if (!file) return;
  wallpaperError.hidden = true;
  preview.classList.add('busy');
  try {
    const { blob, placeholder } = await Wallpaper.processImage(file);
    await Wallpaper.writeImage(blob);
    loadedVersion = -1;
    const next = Wallpaper.normalizeWallpaper({ ...wallpaper, enabled: true, placeholder, version: Date.now() });
    await chrome.storage.local.set({ [Wallpaper.STORAGE_KEY]: next });
    await showWallpaper(next);
  } catch (error) {
    wallpaperError.textContent = error.message; wallpaperError.hidden = false;
  } finally { preview.classList.remove('busy'); fileInput.value = ''; }
}
for (const [inputEl, key] of [[dimInput, 'dim'], [blurInput, 'blur']]) {
  inputEl.addEventListener('input', () => { wallpaper = { ...wallpaper, [key]: Number(inputEl.value) }; Wallpaper.applyVariables(wallpaper); renderWallpaperControls(); });
  inputEl.addEventListener('change', () => chrome.storage.local.set({ [Wallpaper.STORAGE_KEY]: wallpaper }).catch(error => toast(error.message, { error: true })));
}
preview.onclick = () => fileInput.click();
document.querySelector('#choose-wallpaper').onclick = () => fileInput.click();
fileInput.onchange = () => setWallpaperFile(fileInput.files[0]);
preview.addEventListener('dragover', event => { event.preventDefault(); preview.classList.add('dragging'); });
preview.addEventListener('dragleave', () => preview.classList.remove('dragging'));
preview.addEventListener('drop', event => { event.preventDefault(); preview.classList.remove('dragging'); setWallpaperFile(event.dataTransfer.files[0]); });
document.querySelector('#remove-wallpaper').onclick = async () => {
  const next = Wallpaper.normalizeWallpaper({ ...wallpaper, enabled: false, placeholder: '' });
  await chrome.storage.local.set({ [Wallpaper.STORAGE_KEY]: next });
  await showWallpaper(next);
  Wallpaper.deleteImage().catch(() => {});
};
setTimeout(() => showWallpaper(wallpaper), 0);

renderShortcutList();
update();
