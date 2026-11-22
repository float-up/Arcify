import { createFaviconCache, faviconApiUrl } from '../shared/favicon-cache.js';
// SVG sprite shared by sidepanel.html and the rows rendered here.
const ICON_SPRITE = '../../assets/icons.svg';
// Startup: one window lookup and one storage read instead of several sequential round trips.
const [{ id: windowId }, startup, { panelSessionId }] = await Promise.all([
  chrome.windows.getCurrent(),
  chrome.storage.local.get(['peekSize', 'fontSize', 'floatuFont14Updated', 'appearance']),
  chrome.storage.session.get('panelSessionId').catch(() => ({})),
]);
const FAVICON_API = chrome.runtime.getManifest().permissions?.includes('favicon');
const favicons = createFaviconCache({ apiUrl: FAVICON_API ? pageUrl => faviconApiUrl(chrome.runtime.getURL, pageUrl) : null });
// Session storage is cleared when Chrome restarts, when window and tab ids are reused.
const sessionId = panelSessionId || crypto.randomUUID();
if (!panelSessionId) chrome.storage.session.set({ panelSessionId: sessionId }).catch(() => {});
const SNAPSHOT_KEY = `sidebar-snapshot:${windowId}`;
const pinsEl = document.querySelector('#pins');
const tabsEl = document.querySelector('#tabs');
const superPinsEl = document.createElement('div');
superPinsEl.id = 'super-pins';
superPinsEl.setAttribute('role', 'group');
superPinsEl.setAttribute('aria-label', '快捷固定页面');
const superPinsHost = document.createElement('div');
superPinsHost.id = 'super-pins-host';
superPinsHost.append(superPinsEl);
document.querySelector('#sidebar').before(superPinsHost);
const pinAppendDropEl = document.querySelector('#pin-append-drop');
const pinPrependDropEl = document.createElement('div');
pinPrependDropEl.className = 'append-drop prepend-drop';
pinPrependDropEl.setAttribute('aria-label', '添加到 Pin 顶部');
pinPrependDropEl.hidden = true;
document.querySelector('#pins').before(pinPrependDropEl);
const fontInput = document.querySelector('#font-size');
const peekInput = document.querySelector('#peek-enabled');
const textDialog = document.querySelector('#text-dialog');
const textDialogForm = document.querySelector('#text-dialog-form');
const textDialogInput = document.querySelector('#text-dialog-input');
const textDialogError = document.querySelector('#text-dialog-error');
const textDialogConfirm = document.querySelector('#text-dialog-confirm');
let textDialogResolve = null;
function finishTextDialog(value) {
  const resolve = textDialogResolve;
  textDialogResolve = null;
  if (textDialog.open) textDialog.close();
  resolve?.(value);
}
function requestText({ title, description, label = '名称', value = '', confirmText = '保存' }) {
  if (textDialogResolve) finishTextDialog(null);
  document.querySelector('#text-dialog-title').textContent = title;
  document.querySelector('#text-dialog-description').textContent = description;
  document.querySelector('#text-dialog-label').textContent = label;
  textDialogInput.value = value;
  textDialogError.hidden = true;
  textDialogError.textContent = '';
  textDialogConfirm.textContent = confirmText;
  textDialog.showModal();
  queueMicrotask(() => { textDialogInput.focus(); textDialogInput.select(); });
  return new Promise(resolve => { textDialogResolve = resolve; });
}
textDialogForm.addEventListener('submit', event => {
  event.preventDefault();
  const value = textDialogInput.value.trim();
  if (!value) {
    textDialogError.textContent = '名称不能为空';
    textDialogError.hidden = false;
    textDialogInput.focus();
    return;
  }
  finishTextDialog(value);
});
document.querySelector('#text-dialog-cancel').onclick = () => finishTextDialog(null);
textDialog.addEventListener('cancel', event => { event.preventDefault(); finishTextDialog(null); });
textDialog.addEventListener('click', event => { if (event.target === textDialog) finishTextDialog(null); });
function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ui-icon ${className}`); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${ICON_SPRITE}#${name}`); svg.append(use);
  return svg;
}
document.querySelector('#open-settings').replaceChildren(icon('settings'));
document.querySelector('#new-folder').replaceChildren(icon('folder-plus'));
document.querySelector('#close-settings').replaceChildren(icon('back'), document.createTextNode('返回'));
async function updateShortcut() {
  const commands = await chrome.commands.getAll();
  document.querySelector('#shortcut-value').textContent = commands.find(command => command.name === '_execute_action')?.shortcut || '未绑定';
}
document.querySelector('#configure-shortcut').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(showError);
const peekNotice = document.createElement('p');
peekNotice.id = 'peek-notice'; peekNotice.hidden = true; peekNotice.setAttribute('role', 'status');
document.body.prepend(peekNotice);
async function initializePeekSetting() {
  const peekConfigured = (await chrome.storage.local.get('peekEnabled')).peekEnabled === true;
  if (!peekConfigured) { peekInput.checked = false; return; }
  const permitted = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  peekInput.checked = permitted;
  if (!permitted) {
    await chrome.storage.local.set({ peekEnabled: false });
    peekNotice.textContent = '链接浮窗需要网页访问权限，请在设置中重新开启并授权。';
    peekNotice.hidden = false;
  }
}
peekInput.addEventListener('change', async () => {
  peekInput.disabled = true;
  try {
    if (peekInput.checked) {
      const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (!granted) { peekInput.checked = false; await chrome.storage.local.set({ peekEnabled: false }); return; }
      await chrome.storage.local.set({ peekEnabled: true });
      const ready = await chrome.runtime.sendMessage({ type: 'PREPARE_PEEK' });
      if (ready?.error) throw new Error(ready.error);
      document.querySelector('#peek-notice').hidden = true;
    } else await chrome.storage.local.set({ peekEnabled: false });
  } catch (error) { peekInput.checked = false; await chrome.storage.local.set({ peekEnabled: false }); showError(error); }
  finally { peekInput.disabled = false; }
});
// Floating window size (percent of the Pin's browser window); background.js applies it.
const PEEK_SIZE_DEFAULT = { width: 80, height: 85 };
const peekWidthInput = document.querySelector('#peek-width');
const peekHeightInput = document.querySelector('#peek-height');
const peekPresets = [...document.querySelectorAll('#peek-size-presets .chip')];
function normalizePeekSize(value) {
  const clamp = (number, fallback) => Number.isFinite(Number(number)) ? Math.min(100, Math.max(30, Math.round(Number(number)))) : fallback;
  return { width: clamp(value?.width, PEEK_SIZE_DEFAULT.width), height: clamp(value?.height, PEEK_SIZE_DEFAULT.height) };
}
function renderPeekSize(value) {
  const size = normalizePeekSize(value);
  for (const [input, percent] of [[peekWidthInput, size.width], [peekHeightInput, size.height]]) {
    input.value = percent;
    input.style.setProperty('--range-fill', `${(percent - 30) / 70 * 100}%`);
  }
  document.querySelector('#peek-size-value').textContent = `${size.width}% × ${size.height}%`;
  const preview = document.querySelector('#peek-preview-window');
  preview.style.width = `${size.width}%`; preview.style.height = `${size.height}%`;
  for (const chip of peekPresets) chip.setAttribute('aria-pressed', String(Number(chip.dataset.width) === size.width && Number(chip.dataset.height) === size.height));
  return size;
}
function savePeekSize(value) { chrome.storage.local.set({ peekSize: renderPeekSize(value) }).catch(showError); }
const currentPeekSize = () => ({ width: peekWidthInput.value, height: peekHeightInput.value });
for (const input of [peekWidthInput, peekHeightInput]) {
  input.addEventListener('input', () => renderPeekSize(currentPeekSize()));
  input.addEventListener('change', () => savePeekSize(currentPeekSize()));
}
for (const chip of peekPresets) chip.onclick = () => savePeekSize({ width: chip.dataset.width, height: chip.dataset.height });
renderPeekSize(startup.peekSize);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.peekSize) renderPeekSize(changes.peekSize.newValue); });
chrome.windows.get(windowId).then(win => {
  if (win.width && win.height) document.querySelector('#peek-preview').style.aspectRatio = `${win.width} / ${win.height}`;
}).catch(() => {});
// Floating window toolbar shortcuts; keep in sync with KEYS in peek-content.js.
{
  const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const rows = mac
    ? [['编辑地址', '⌘L'], ['后退 / 前进', '⌘[ / ⌘]'], ['刷新', '⌘R'], ['复制链接', '⌘⇧L'], ['回到标签页', '⌘⇧O'], ['取消编辑', 'Esc']]
    : [['编辑地址', 'Ctrl+L'], ['后退 / 前进', 'Alt+← / Alt+→'], ['刷新', 'Ctrl+R'], ['复制链接', 'Ctrl+Shift+L'], ['回到标签页', 'Ctrl+Shift+O'], ['取消编辑', 'Esc']];
  document.querySelector('#peek-shortcuts').replaceChildren(...rows.flatMap(([name, keys]) => {
    const term = document.createElement('dt'); term.textContent = name;
    const value = document.createElement('dd');
    value.append(...keys.split(' / ').flatMap((combo, index) => {
      const kbd = document.createElement('kbd'); kbd.textContent = combo;
      return index ? [document.createTextNode(' '), kbd] : [kbd];
    }));
    return [term, value];
  }));
}
function applyFontSize(value) {
  const size = Math.min(18, Math.max(11, Number(value) || 14));
  document.documentElement.style.setProperty('--font-size', `${size}px`);
  fontInput.value = size;
  fontInput.style.setProperty('--range-fill', `${(size - 11) / 7 * 100}%`);
  document.querySelector('#font-size-value').textContent = `${size}px`;
}
if (!startup.floatuFont14Updated) chrome.storage.local.set({ fontSize: 14, floatuFont14Updated: true }).catch(console.error);
applyFontSize(startup.floatuFont14Updated ? startup.fontSize : 14);
fontInput.addEventListener('input', () => applyFontSize(fontInput.value));
fontInput.addEventListener('change', () => chrome.storage.local.set({ fontSize: Number(fontInput.value) }).catch(showError));
document.querySelector('#reset-font').onclick = () => { applyFontSize(14); chrome.storage.local.set({ fontSize: 14 }).catch(showError); };
const Appearance = window.SidebarAppearance;
const themeButtons = [...document.querySelectorAll('#theme-mode [data-theme]')];
const appearanceControls = {
  background: { el: document.querySelector('#background-swatches'), output: document.querySelector('#background-value'), presets: Appearance.BACKGROUNDS },
  accent: { el: document.querySelector('#accent-swatches'), output: document.querySelector('#accent-value'), presets: Appearance.ACCENTS },
};
const checkColor = hex => Appearance.luminance(hex) > .45 ? '#1b1f24' : '#ffffff';
function saveAppearance(patch) {
  const next = Appearance.normalize({ ...Appearance.current, ...patch });
  Appearance.apply(next);
  chrome.storage.local.set({ appearance: next }).catch(showError);
}
for (const [key, control] of Object.entries(appearanceControls)) {
  control.buttons = control.presets.map(preset => {
    const swatch = document.createElement('button');
    swatch.type = 'button'; swatch.className = 'swatch'; swatch.title = preset.name;
    swatch.setAttribute('role', 'radio'); swatch.setAttribute('aria-label', preset.name);
    swatch.append(icon('check'));
    swatch.onclick = () => saveAppearance({ [key]: preset.id });
    return swatch;
  });
  control.custom = document.createElement('span');
  control.custom.className = 'swatch custom'; control.custom.title = '自定义颜色';
  control.input = document.createElement('input');
  control.input.type = 'color'; control.input.setAttribute('aria-label', `自定义${key === 'background' ? '背景颜色' : '强调色'}`);
  control.input.addEventListener('input', () => Appearance.apply({ ...Appearance.current, [key]: control.input.value }, { persist: false }));
  control.input.addEventListener('change', () => saveAppearance({ [key]: control.input.value }));
  control.custom.append(control.input, icon('check'), icon('eyedropper', 'picker-icon'));
  control.el.replaceChildren(...control.buttons, control.custom);
}
function renderAppearance(detail) {
  for (const option of themeButtons) option.setAttribute('aria-checked', String(option.dataset.theme === detail.theme));
  document.querySelector('#theme-override-hint').hidden = !detail.background.startsWith('#');
  for (const [key, control] of Object.entries(appearanceControls)) {
    const value = detail[key];
    control.presets.forEach((preset, index) => {
      const swatch = control.buttons[index];
      swatch.style.setProperty('--swatch', preset[detail.tone]);
      swatch.style.setProperty('--swatch-check', checkColor(preset[detail.tone]));
      swatch.setAttribute('aria-checked', String(value === preset.id));
    });
    const custom = value.startsWith('#');
    control.custom.classList.toggle('selected', custom);
    if (custom) {
      control.custom.dataset.color = value;
      control.custom.style.setProperty('--swatch', value);
      control.custom.style.setProperty('--swatch-check', checkColor(value));
    } else delete control.custom.dataset.color;
    control.input.value = key === 'background' ? detail.resolvedBackground : detail.resolvedAccent;
    control.output.textContent = custom ? value.toUpperCase() : control.presets.find(preset => preset.id === value).name;
  }
}
document.addEventListener('sidebar-appearance', event => renderAppearance(event.detail));
for (const option of themeButtons) option.onclick = () => saveAppearance({ theme: option.dataset.theme });
document.querySelector('#reset-appearance').onclick = () => saveAppearance(Appearance.DEFAULTS);
Appearance.apply(startup.appearance);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.appearance) Appearance.apply(changes.appearance.newValue); });
document.querySelector('#open-settings').onclick = () => { document.querySelector('#sidebar').hidden = true; document.querySelector('#settings').hidden = false; updateShortcut().catch(showError); };
window.addEventListener('focus', () => { if (!document.querySelector('#settings').hidden) updateShortcut().catch(showError); });
document.querySelector('#close-settings').onclick = () => { document.querySelector('#settings').hidden = true; document.querySelector('#sidebar').hidden = false; revealActiveTab(); };
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.fontSize) applyFontSize(changes.fontSize.newValue); if (area === 'local' && changes.peekEnabled) peekInput.checked = changes.peekEnabled.newValue === true; });
let state = { pins: [], folders: [], tabs: [] };
const SPLIT_SUPPORTED = typeof chrome.tabs?.createSplit === 'function';
const isSplit = item => Number.isInteger(item?.splitViewId) && item.splitViewId !== -1;
const DROP_CLASSES = ['over', 'drop-before', 'drop-after', 'drop-split-left', 'drop-split-right'];
const DROP_MARKS = DROP_CLASSES.map(name => `.${name}`).join(',');
let drag = null;
let revision = 0;
let refreshInFlight = false;
let refreshPending = false;
const tabRows = new Map();
const pinRows = new Map();
const folderRows = new Map();
let pendingRender = false;
let refreshTimer;
let revealedTabId = null;
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, windowId, ...extra });
  if (response?.error) throw new Error(response.error);
  if (response?.data?.warning) showError(new Error(response.data.warning));
  return response?.data;
}
let errorTimer;
function showError(error) {
  const el = document.querySelector('#error'); el.textContent = error.message; el.style.display = 'block';
  // A newer message gets its full display time instead of the previous message's remainder.
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}
function startDrag(value, event) {
  closeContextMenu();
  drag = value;
  superPinsEl.classList.toggle('drag-ready', value.kind !== 'folder');
  pinAppendDropEl.hidden = false;
  pinPrependDropEl.hidden = value.kind === 'folder';
  for (const entry of folderRows.values()) entry.appendDrop.hidden = false;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(value.id));
}
async function refresh() {
  if (document.hidden) { refreshPending = true; return; }
  if (refreshInFlight) { refreshPending = true; return; }
  refreshInFlight = true;
  refreshPending = false;
  const current = ++revision;
  try {
    const data = await send('GET_SNAPSHOT');
    if (current === revision && !document.hidden) { state = data; render(); }
    else refreshPending = true;
  } catch (error) { showError(error); }
  finally {
    refreshInFlight = false;
    if (refreshPending && !document.hidden) scheduleRefresh();
  }
}
function scheduleRefresh() {
  if (document.hidden) { refreshPending = true; return; }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 100);
}
function button(label, title, action) {
  const el = document.createElement('button');
  const glyph = { '×': 'close', '＋': 'plus', '✎': 'edit' }[label];
  if (glyph) el.append(icon(glyph)); else el.textContent = label;
  el.title = title; el.setAttribute('aria-label', title);
  el.onclick = event => { event.stopPropagation(); action().catch(showError); }; return el;
}
function row(item, kind, index, cache) {
  let entry = cache.get(item.id);
  if (!entry) {
  const el = document.createElement('div'); el.draggable = true;
  const placeholder = icon('window', 'fallback-icon');
  const iconWrap = document.createElement('span'); iconWrap.className = 'row-icon'; iconWrap.append(placeholder);
  const title = document.createElement('span'); title.className = 'title';
  el.append(iconWrap, title, icon('split', 'split-badge'));
  const status = kind === 'pin' ? document.createElement('span') : null;
  if (status) iconWrap.append(status);
  const navigation = kind === 'pin' ? document.createElement('span') : null;
  if (navigation) {
    navigation.className = 'pin-navigation'; navigation.textContent = '↗';
    navigation.setAttribute('aria-hidden', 'true'); navigation.hidden = true;
    iconWrap.append(navigation);
  }
  const actions = document.createElement('span'); actions.className = 'row-actions';
  const close = button('×', '', async () => {
    const current = entry.item;
    await send(kind === 'pin' ? (current.tabId ? 'CLOSE_PIN' : 'REMOVE_PIN') : 'CLOSE_TAB', kind === 'pin' ? { pinId: current.id } : { tabId: current.id });
  });
  if (kind === 'pin') actions.append(button('✎', '重命名 Pin', async () => {
    const current = entry.item;
    const name = await requestText({ title: '重命名 Pin', description: '只修改侧边栏中的展示名称，不会改变网页地址。', label: 'Pin 名称', value: current.title || current.url });
    if (name === null) return;
    await send('UPDATE_PIN', { pinId: current.id, name });
  }));
  actions.append(close); el.append(actions);
  entry = { el, icon: placeholder, iconWrap, title, status, navigation, actions, close, item, index, iconSrc: '', iconWant: null };
  cache.set(item.id, entry);
  el.onclick = () => send(kind === 'pin' ? 'OPEN_PIN' : 'ACTIVATE_TAB', kind === 'pin' ? { pinId: entry.item.id } : { tabId: entry.item.id }).catch(showError);
  el.ondragstart = event => startDrag({ kind, id: entry.item.id, index: entry.index }, event);
  el.ondragend = clearDrag;
  if (kind === 'pin') bindPositionDrop(el, () => ({ kind, item: entry.item }));
  else bindTabDrop(el, () => entry);
  el.oncontextmenu = event => openContextMenu(event, rowMenuItems(kind, entry), el);
  }
  const previousUrl = entry.item.url;
  entry.item = item; entry.index = index;
  entry.el.classList.toggle('active', !!(item.active || item.status === 'active'));
  entry.el.classList.add('row');
  const superPin = kind === 'pin' && item.superPin === true;
  const navigated = kind === 'pin' && item.navigated === true;
  if (entry.navigation) entry.navigation.hidden = !navigated;
  entry.el.classList.toggle('super-pin', superPin);
  if (!superPin) entry.el.style.removeProperty('grid-column');
  entry.title.hidden = superPin; entry.actions.hidden = superPin;
  if (entry.status) entry.status.hidden = superPin;
  entry.el.setAttribute('role', 'button');
  entry.el.tabIndex = 0;
  entry.el.setAttribute('aria-label', (item.title || item.url || '新标签页') + (navigated ? '，已离开固定地址' : '') + (isSplit(item) ? '，分屏中' : ''));
  entry.el.onkeydown = event => { if (event.target === entry.el && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); entry.el.click(); } };
  entry.el.title = navigated ? `已离开固定地址\n当前：${item.currentUrl}\n固定：${item.url}` : item.url || item.title || '';
  const text = item.title || item.url || '新标签页';
  if (entry.title.textContent !== text) entry.title.textContent = text;
  updateIcon(entry, item.url || '', (kind === 'pin' ? item.faviconUrl : item.favIconUrl) || '', previousUrl);
  if (entry.status) { const status = item.loading ? 'loading' : item.status; entry.status.className = `status ${status}`; entry.status.title = ({ active:'当前页面', open:'已打开', closed:'已关闭', loading:'加载中' })[status]; }
  const label = kind === 'pin' ? (item.tabId ? '关闭页面' : '移除固定 URL') : '关闭标签页';
  entry.close.title = label; entry.close.setAttribute('aria-label', label);
  return entry.el;
}
function showIcon(entry, src) {
  if (entry.iconSrc === src) return;
  entry.iconSrc = src;
  let node;
  if (src) {
    node = document.createElement('img');
    node.className = 'favicon'; node.alt = '';
    // Cached icons are in-memory data: URLs; decode them with the first paint.
    node.decoding = src.startsWith('data:') ? 'sync' : 'async';
    node.onerror = () => { if (entry.icon === node) showIcon(entry, ''); };
    node.src = src;
  } else node = icon('window', 'fallback-icon');
  entry.icon.replaceWith(node); entry.icon = node;
}
// Cached icon first (synchronous, no flash); refresh it in the background only when the
// browser reports a different icon or the cache is old, and swap it in once loaded.
function updateIcon(entry, pageUrl, reported, previousUrl) {
  const want = `${pageUrl}\n${reported}`;
  if (entry.iconWant === want) return;
  entry.iconWant = want;
  const hit = favicons.get(pageUrl);
  if (hit) showIcon(entry, hit.data);
  else if (pageUrl !== previousUrl) showIcon(entry, '');
  // No icon reported yet (page still loading): keep what is shown.
  if (!reported || favicons.isCurrent(pageUrl, reported)) return;
  favicons.load(pageUrl, reported).then(src => { if (src && entry.iconWant === want) showIcon(entry, src); });
}
function clearDrag() { drag = null; superPinsEl.classList.remove('drag-ready'); pinAppendDropEl.hidden = true; pinPrependDropEl.hidden = true; for (const entry of folderRows.values()) entry.appendDrop.hidden = true; document.querySelectorAll(DROP_MARKS).forEach(el => el.classList.remove(...DROP_CLASSES)); if (pendingRender) { pendingRender = false; render(); } }
function dropPosition(el, event, kind) {
  const rect = el.getBoundingClientRect();
  const fraction = kind === 'super' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
  if (kind === 'folder' && fraction >= .25 && fraction <= .75) return 'inside';
  return fraction < .5 ? 'before' : 'after';
}
// Tab rows: outer quarters reorder; the middle half splits, and the horizontal half picks the side.
function tabDropZone(el, event, canSplit) {
  const rect = el.getBoundingClientRect();
  const fraction = (event.clientY - rect.top) / rect.height;
  if (canSplit && fraction >= .25 && fraction <= .75) return (event.clientX - rect.left) / rect.width < .5 ? 'split-left' : 'split-right';
  return fraction < .5 ? 'before' : 'after';
}
// chrome.tabs.move takes the final index, so account for the dragged tab leaving its old slot.
function tabMoveIndex(fromIndex, toIndex, side) {
  return toIndex + (side === 'after' ? 1 : 0) - (Number.isInteger(fromIndex) && fromIndex < toIndex ? 1 : 0);
}
function bindPositionDrop(el, getEntry) {
  el.ondragover = event => {
    if (!drag || (getEntry().item.superPin && drag.kind === 'folder')) return;
    event.preventDefault(); event.stopPropagation();
    document.querySelectorAll('.over,.drop-before,.drop-after').forEach(node => node.classList.remove('over', 'drop-before', 'drop-after'));
    const side = dropPosition(el, event, getEntry().item.superPin ? 'super' : getEntry().kind);
    el.classList.add(side === 'inside' ? 'over' : `drop-${side}`);
  };
  el.ondragleave = () => el.classList.remove('over', 'drop-before', 'drop-after');
  el.ondrop = event => {
    event.preventDefault(); event.stopPropagation();
    const { kind, item } = getEntry();
    if (item.superPin && drag?.kind === 'folder') return;
    const side = dropPosition(el, event, item.superPin ? 'super' : kind);
    if (side === 'inside') drop('pin', state.pins.length, null, item.id).catch(showError);
    else {
      const parentId = (kind === 'folder' ? item.parentId : item.folderId) || null;
      drop('pin', state.pins.length, null, parentId, false, { kind, id: item.id, side }, item.superPin === true).catch(showError);
    }
    clearDrag();
  };
}
function canSplitWith(target) {
  if (!SPLIT_SUPPORTED || drag?.kind !== 'tab' || drag.id === target.id || isSplit(target)) return false;
  const source = state.tabs.find(tab => tab.id === drag.id);
  return !!source && !!source.pinned === !!target.pinned;
}
function bindTabDrop(el, getEntry) {
  const zone = event => drag?.kind === 'tab' ? tabDropZone(el, event, canSplitWith(getEntry().item)) : 'before';
  el.ondragover = event => {
    if (!drag) return;
    event.preventDefault(); event.stopPropagation();
    const mark = `drop-${zone(event)}`;
    document.querySelectorAll(DROP_MARKS).forEach(node => { if (node !== el) node.classList.remove(...DROP_CLASSES); });
    for (const name of DROP_CLASSES) el.classList.toggle(name, name === mark);
  };
  el.ondragleave = event => { if (!el.contains(event.relatedTarget)) el.classList.remove(...DROP_CLASSES); };
  el.ondrop = event => {
    event.preventDefault(); event.stopPropagation();
    const { item, index } = getEntry();
    const side = zone(event);
    if (drag?.kind === 'tab' && drag.id === item.id) { clearDrag(); return; }
    if (side.startsWith('split-')) send('SPLIT_TABS', { tabId: drag.id, targetTabId: item.id, side: side.slice(6) }).catch(showError);
    else {
      const source = drag?.kind === 'tab' ? state.tabs.find(tab => tab.id === drag.id) : null;
      drop('tab', index, tabMoveIndex(source?.index, item.index, side)).catch(showError);
    }
    clearDrag();
  };
}
function bindFolderDrop(el, folderId) {
  el.ondragover = event => {
    if (!drag) return;
    event.preventDefault(); event.stopPropagation(); el.classList.add('over');
  };
  el.ondragleave = event => { if (!el.contains(event.relatedTarget)) el.classList.remove('over'); };
  el.ondrop = event => {
    event.preventDefault(); event.stopPropagation();
    drop('pin', state.pins.length, null, folderId).catch(showError);
    clearDrag();
  };
}
async function drop(target, index, tabIndex, folderId = null, beforeFolders = false, placement = null, superPin = false) {
  if (!drag) return;
  const position = { ...(placement ? { placement } : {}), ...(superPin ? { superPin: true } : {}) };
  if (drag.kind === 'folder') { if (target === 'pin') await send('MOVE_FOLDER', { folderId: drag.id, parentId: folderId, ...position }); return; }
  if (target === 'pin' && drag.kind === 'tab') await send('PIN_TAB', { tabId: drag.id, index, folderId, beforeFolders, ...position });
  else if (target === 'pin') await send('REORDER_PIN', { pinId: drag.id, folderId, index: index - (drag.index < index ? 1 : 0), beforeFolders, ...position });
  else if (drag.kind === 'pin') await send('UNPIN', { pinId: drag.id });
  else await send('MOVE_TAB', { tabId: drag.id, index: tabIndex ?? -1 });
}
function reconcile(parent, desired, emptyText) {
  if (!desired.length && emptyText) {
    let empty = parent.querySelector(':scope > .empty');
    if (!empty) { empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = emptyText; }
    desired = [empty];
  }
  const keep = new Set(desired);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  desired.forEach((element, index) => { const current = parent.children[index]; if (current !== element) parent.insertBefore(element, current || null); });
}
function revealActiveTab() {
  const sidebar = document.querySelector('#sidebar');
  if (drag || sidebar.hidden) return;
  const pin = state.pins.find(item => item.status === 'active');
  const tab = state.tabs.find(item => item.active);
  const tabId = pin?.tabId ?? tab?.id;
  if (tabId == null) { revealedTabId = null; return; }
  if (tabId === revealedTabId) return;
  const entry = pin ? pinRows.get(pin.id) : tabRows.get(tab.id);
  if (!entry) return;
  revealedTabId = tabId;
  if (pin?.superPin) return;
  let folderId = pin?.folderId;
  const visited = new Set();
  while (folderId && !visited.has(folderId)) {
    visited.add(folderId);
    const folder = folderRows.get(folderId);
    if (!folder) break;
    if (folder.children.hidden) {
      folder.children.hidden = false;
      folder.toggle.setAttribute('aria-expanded', 'true');
      folder.folder.expanded = true;
      folder.folderIcon.querySelector('use').setAttribute('href', `${ICON_SPRITE}#folder-open`);
      send('UPDATE_FOLDER', { folderId, expanded: true }).catch(showError);
    }
    folderId = folder.folder.parentId;
  }
  const bounds = sidebar.getBoundingClientRect();
  const rowBounds = entry.el.getBoundingClientRect();
  if (rowBounds.top < bounds.top || rowBounds.bottom > bounds.bottom) {
    sidebar.scrollTo({ top: sidebar.scrollTop + rowBounds.top - bounds.top - (sidebar.clientHeight - rowBounds.height) / 2, behavior: 'instant' });
  }
}
function render() {
  if (drag) { pendingRender = true; return; }
  const pinIds = new Set(state.pins.map(item => item.id));
  const tabIds = new Set(state.tabs.map(item => item.id));
  const folderIds = new Set(state.folders.map(item => item.id));
  for (const [id, entry] of pinRows) if (!pinIds.has(id)) { entry.el.remove(); pinRows.delete(id); }
  for (const [id, entry] of tabRows) if (!tabIds.has(id)) { entry.el.remove(); tabRows.delete(id); }
  for (const [id, entry] of folderRows) if (!folderIds.has(id)) { entry.group.remove(); folderRows.delete(id); }
  for (const folder of state.folders) {
    let entry = folderRows.get(folder.id);
    if (!entry) {
    const group = document.createElement('div'); group.className = 'folder';
    const heading = document.createElement('div'); heading.className = 'folder-heading';
    const toggle = document.createElement('button'); toggle.className = 'folder-toggle';
    const chevron = icon('chevron', 'folder-chevron');
    const folderIcon = icon('folder', 'folder-icon');
    const name = document.createElement('span'); name.className = 'folder-name';
    toggle.append(chevron, folderIcon, name);
    const children = document.createElement('div'); children.className = 'folder-children';
    const appendDrop = document.createElement('div'); appendDrop.className = 'append-drop folder-append-drop';
    appendDrop.setAttribute('aria-label', '添加到文件夹末尾'); appendDrop.hidden = true;
    bindFolderDrop(children, folder.id);
    bindFolderDrop(appendDrop, folder.id);
    entry = { group, heading, toggle, children, appendDrop, folder, folderIcon, name }; folderRows.set(folder.id, entry);
    toggle.onclick = () => send('UPDATE_FOLDER', { folderId: entry.folder.id, expanded: !entry.folder.expanded }).catch(showError);
    heading.append(toggle, button('＋', '新建子文件夹', async () => {
      const name = await requestText({ title: '新建子文件夹', description: `将在“${entry.folder.name}”中创建文件夹。`, label: '文件夹名称', confirmText: '创建' });
      if (name !== null) await send('CREATE_FOLDER', { name, parentId: entry.folder.id });
    }), button('✎', '重命名文件夹', async () => {
      const name = await requestText({ title: '重命名文件夹', description: '文件夹中的 Pin 和子文件夹会保持不变。', label: '文件夹名称', value: entry.folder.name });
      if (name !== null) await send('UPDATE_FOLDER', { folderId: entry.folder.id, name });
    }), button('×', '删除文件夹（保留内容）', () => send('DELETE_FOLDER', { folderId: entry.folder.id })));
    heading.draggable = true;
    heading.ondragstart = event => startDrag({ kind: 'folder', id: entry.folder.id }, event);
    heading.ondragend = clearDrag;
    bindPositionDrop(heading, () => ({ kind: 'folder', item: entry.folder }));
    group.append(heading, children);
    }
    entry.folder = folder;
    entry.toggle.setAttribute('aria-expanded', String(folder.expanded));
    const symbol = `${ICON_SPRITE}#${folder.expanded ? 'folder-open' : 'folder'}`;
    const use = entry.folderIcon.querySelector('use');
    if (use.getAttribute('href') !== symbol) use.setAttribute('href', symbol);
    if (entry.name.textContent !== folder.name) entry.name.textContent = folder.name;
    entry.children.hidden = !folder.expanded;
  }
  const childrenByParent = new Map();
  function addChild(parentId, entry) {
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(entry);
  }
  state.pins.forEach((item, index) => {
    if (!item.superPin) addChild(folderIds.has(item.folderId) ? item.folderId : null, { item, index, kind: 'pin' });
  });
  for (const item of state.folders) addChild(folderIds.has(item.parentId) ? item.parentId : null, { item, kind: 'folder' });
  for (const entries of childrenByParent.values()) entries.sort((a, b) => a.item.order - b.item.order);
  function level(parentId, ancestors = new Set()) {
    const elements = [];
    const entries = childrenByParent.get(parentId) || [];
    for (const { item, index, kind } of entries) {
      if (kind === 'pin') elements.push(row(item, 'pin', index, pinRows));
      else if (!ancestors.has(item.id)) {
        const entry = folderRows.get(item.id);
        reconcile(entry.children, [...level(item.id, new Set([...ancestors, item.id])), entry.appendDrop]);
        elements.push(entry.group);
      }
    }
    return elements;
  }
  const superPins = state.pins.map((item, index) => ({ item, index })).filter(({ item }) => item.superPin === true).sort((a, b) => a.item.order - b.item.order);
  reconcile(superPinsEl, superPins.map(({ item, index }, position) => {
    const el = row(item, 'pin', index, pinRows);
    const rowCount = Math.min(4, superPins.length - Math.floor(position / 4) * 4);
    el.style.gridColumn = `span ${12 / rowCount}`;
    return el;
  }));
  for (const entry of pinRows.values()) if (!entry.item.superPin) entry.el.style.removeProperty('grid-column');
  reconcile(pinsEl, level(null), '拖入标签页以固定 URL');
  reconcile(tabsEl, state.tabs.map((item, index) => row(item, 'tab', index, tabRows)), '没有普通标签页');
  markSplitRows();
  document.querySelector('#pin-count').textContent = state.pins.length;
  document.querySelector('#tab-count').textContent = state.tabs.length;
  revealActiveTab();
  saveSnapshotSoon();
}
// The last rendered state is reused for the first paint when the panel is reopened,
// instead of an empty list while the background worker wakes up and answers.
let snapshotTimer = null;
function saveSnapshot() {
  clearTimeout(snapshotTimer); snapshotTimer = null;
  // Long data: favicons live in the favicon cache; the snapshot only needs to be small.
  const slim = item => ({ ...item, favIconUrl: (item.favIconUrl || '').length > 2048 ? '' : item.favIconUrl, faviconUrl: (item.faviconUrl || '').length > 2048 ? '' : item.faviconUrl });
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ session: sessionId, data: { pins: state.pins.map(slim), folders: state.folders, tabs: state.tabs.map(slim) } }));
    // Drop snapshots of windows from earlier browser sessions.
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith('sidebar-snapshot:') && key !== SNAPSHOT_KEY && !localStorage.getItem(key)?.includes(`"session":"${sessionId}"`)) localStorage.removeItem(key);
    }
  } catch {}
}
function saveSnapshotSoon() { if (!snapshotTimer) snapshotTimer = setTimeout(saveSnapshot, 500); }
function readSnapshot() {
  try {
    const cached = JSON.parse(localStorage.getItem(SNAPSHOT_KEY));
    return cached?.session === sessionId && Array.isArray(cached.data?.pins) && Array.isArray(cached.data?.tabs) ? cached.data : null;
  } catch { return null; }
}
// Adjacent tabs sharing a splitViewId render as one joined block.
function markSplitRows() {
  state.tabs.forEach((item, index) => {
    const entry = tabRows.get(item.id);
    if (!entry) return;
    const split = isSplit(item);
    const joinedBefore = split && state.tabs[index - 1]?.splitViewId === item.splitViewId;
    const joinedAfter = split && state.tabs[index + 1]?.splitViewId === item.splitViewId;
    entry.el.classList.toggle('split', split);
    entry.el.classList.toggle('split-start', joinedAfter && !joinedBefore);
    entry.el.classList.toggle('split-end', joinedBefore && !joinedAfter);
  });
  for (const entry of pinRows.values()) entry.el.classList.toggle('split', isSplit(entry.item) && !entry.item.superPin);
}
const contextMenu = document.querySelector('#context-menu');
let contextMenuReturnFocus = null;
function closeContextMenu({ restoreFocus = false } = {}) {
  if (contextMenu.hidden) return;
  contextMenu.hidden = true; contextMenu.replaceChildren();
  if (restoreFocus) contextMenuReturnFocus?.focus();
  contextMenuReturnFocus = null;
}
function rowMenuItems(kind, entry) {
  const item = entry.item;
  const items = [];
  const tabId = kind === 'pin' ? item.tabId : item.id;
  if (isSplit(item) && Number.isInteger(tabId)) items.push({ label: '取消分屏', icon: 'unsplit', action: () => send('UNSPLIT_TAB', { tabId }) });
  else if (kind === 'tab' && SPLIT_SUPPORTED) {
    const active = state.tabs.find(tab => tab.active);
    if (active && active.id !== item.id && !isSplit(active) && !!active.pinned === !!item.pinned) {
      items.push({ label: '与当前标签页分屏', icon: 'split', action: () => send('SPLIT_TABS', { tabId: item.id, targetTabId: active.id, side: 'right' }) });
    }
  }
  if (item.superPin) return items;
  if (items.length) items.push('separator');
  const rename = entry.actions.querySelector('[aria-label="重命名 Pin"]');
  if (rename) items.push({ label: '重命名', icon: 'edit', action: async () => rename.click() });
  items.push({ label: entry.close.title, icon: 'close', danger: true, action: async () => entry.close.click() });
  return items;
}
function openContextMenu(event, items, anchor) {
  if (drag || !items.length) return;
  event.preventDefault();
  contextMenuReturnFocus = anchor;
  contextMenu.replaceChildren(...items.map(item => {
    if (item === 'separator') { const line = document.createElement('div'); line.className = 'menu-separator'; line.setAttribute('role', 'separator'); return line; }
    const option = document.createElement('button');
    option.type = 'button'; option.setAttribute('role', 'menuitem'); option.tabIndex = -1;
    if (item.danger) option.classList.add('danger');
    const label = document.createElement('span'); label.textContent = item.label;
    option.append(icon(item.icon), label);
    option.onclick = () => { closeContextMenu(); item.action().catch(showError); };
    return option;
  }));
  contextMenu.hidden = false;
  const bounds = anchor.getBoundingClientRect();
  const keyboard = event.clientX === 0 && event.clientY === 0;
  const x = keyboard ? bounds.left + 24 : event.clientX;
  const y = keyboard ? bounds.bottom - 4 : event.clientY;
  const { offsetWidth: width, offsetHeight: height } = contextMenu;
  contextMenu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
  contextMenu.style.top = `${y + height + 6 > innerHeight ? Math.max(6, y - height) : y}px`;
  contextMenu.querySelector('[role="menuitem"]')?.focus();
}
contextMenu.addEventListener('keydown', event => {
  const options = [...contextMenu.querySelectorAll('[role="menuitem"]')];
  const current = options.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    options[(current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); options[event.key === 'Home' ? 0 : options.length - 1]?.focus(); }
  else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeContextMenu({ restoreFocus: true }); }
});
document.addEventListener('pointerdown', event => { if (!contextMenu.contains(event.target)) closeContextMenu(); }, true);
document.addEventListener('scroll', () => closeContextMenu(), true);
window.addEventListener('blur', () => closeContextMenu());
window.addEventListener('resize', () => closeContextMenu());
superPinsEl.ondragover = event => {
  if (!drag || drag.kind === 'folder') return;
  event.preventDefault(); event.stopPropagation(); superPinsEl.classList.add('over');
};
superPinsEl.ondragleave = event => { if (!superPinsEl.contains(event.relatedTarget)) superPinsEl.classList.remove('over'); };
superPinsEl.ondrop = event => {
  event.preventDefault(); event.stopPropagation();
  if (drag && drag.kind !== 'folder') drop('pin', state.pins.length, null, null, false, null, true).catch(showError);
  clearDrag();
};
for (const [el, kind] of [[pinsEl,'pin'],[tabsEl,'tab']]) {
  el.ondragover = event => { if (drag) { event.preventDefault(); el.classList.add('over'); } };
  el.ondragleave = event => { if (!el.contains(event.relatedTarget)) el.classList.remove('over'); };
  el.ondrop = event => { event.preventDefault(); drop(kind, kind === 'pin' ? state.pins.length : state.tabs.length, -1).catch(showError); clearDrag(); };
}
pinAppendDropEl.ondragover = event => { if (drag) { event.preventDefault(); event.stopPropagation(); pinAppendDropEl.classList.add('over'); } };
pinAppendDropEl.ondragleave = () => pinAppendDropEl.classList.remove('over');
pinPrependDropEl.ondragover = event => { if (drag && drag.kind !== 'folder') { event.preventDefault(); event.stopPropagation(); pinPrependDropEl.classList.add('over'); } };
pinPrependDropEl.ondragleave = () => pinPrependDropEl.classList.remove('over');
pinPrependDropEl.ondrop = event => { event.preventDefault(); event.stopPropagation(); if (drag?.kind !== 'folder') drop('pin', 0, null, null, true).catch(showError); clearDrag(); };
pinAppendDropEl.ondrop = event => { event.preventDefault(); event.stopPropagation(); drop('pin', state.pins.length, null, null).catch(showError); clearDrag(); };
document.querySelector('#new-folder').onclick = async () => {
  try {
    const name = await requestText({ title: '新建文件夹', description: '用文件夹整理 Pin，稍后仍可拖动调整层级。', label: '文件夹名称', confirmText: '创建' });
    if (name !== null) await send('CREATE_FOLDER', { name });
  } catch (error) { showError(error); }
};
document.querySelector('#clear-tabs').onclick = () => send('CLEAR_TABS').catch(showError);
document.querySelector('#export-pins').onclick = async () => {
  try {
    const { pins = [], folders = [] } = await chrome.storage.local.get(['pins', 'folders']);
    const backup = { format: 'Sidebar', version: 1, exportedAt: new Date().toISOString(), pins, folders };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `sidebar-pins-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showError(error); }
};
const backupFile = document.querySelector('#backup-file');
document.querySelector('#import-pins').onclick = () => backupFile.click();
backupFile.onchange = async () => {
  try {
    const file = backupFile.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error('备份文件不能超过 10 MB');
    await send('IMPORT_PINS', { backup: JSON.parse(await file.text()) });
  } catch (error) { showError(error); }
  finally { backupFile.value = ''; }
};
chrome.runtime.onMessage.addListener(message => { if (message.type === 'CHANGED' && (message.windowId == null || message.windowId === windowId)) scheduleRefresh(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(refreshTimer); refreshTimer = null; favicons.flush(); if (snapshotTimer) saveSnapshot(); }
  else refresh();
});
// Closing the panel destroys the page: write pending caches synchronously first.
addEventListener('pagehide', () => { favicons.flush(); if (snapshotTimer) saveSnapshot(); });
const cachedSnapshot = readSnapshot();
if (cachedSnapshot) { state = { folders: [], ...cachedSnapshot }; render(); }
refresh();
initializePeekSetting().catch(showError);
