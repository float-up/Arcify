chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Serialize mutations: Chrome events can arrive while an operation awaits storage.
let queue = Promise.resolve();
const pendingNavigationTabs = new Set();
const lastActiveTabs = new Map();
// Floating window size, as a percentage of the Pin's browser window (settings page).
const PEEK_SIZE_DEFAULT = { width: 80, height: 85 };
function normalizePeekSize(value) {
  const clamp = (number, fallback) => Number.isFinite(Number(number)) ? Math.min(100, Math.max(30, Math.round(Number(number)))) : fallback;
  return { width: clamp(value?.width, PEEK_SIZE_DEFAULT.width), height: clamp(value?.height, PEEK_SIZE_DEFAULT.height) };
}
async function readPeekSize() {
  return normalizePeekSize((await chrome.storage.local.get('peekSize'))?.peekSize);
}
function peekWindowBounds(win, size = PEEK_SIZE_DEFAULT) {
  const baseWidth = win.width || 1440, baseHeight = win.height || 900;
  const width = Math.min(baseWidth, Math.max(420, Math.round(baseWidth * size.width / 100)));
  const height = Math.min(baseHeight, Math.max(320, Math.round(baseHeight * size.height / 100)));
  const bounds = { width, height };
  if (Number.isInteger(win.left) && Number.isInteger(win.top)) {
    bounds.left = Math.round(win.left + ((win.width || width) - width) / 2);
    bounds.top = Math.round(win.top + ((win.height || height) - height) / 2);
  }
  return bounds;
}
function run(fn) {
  const result = queue.then(fn);
  queue = result.catch(console.error);
  return result;
}
async function read() {
  const [{ pins = [], folders = [] }, { bindings = {} }] = await Promise.all([
    chrome.storage.local.get(['pins', 'folders']), chrome.storage.session.get('bindings')
  ]);
  normalizeOrder(pins, folders);
  return { pins, folders, bindings };
}
// Legacy data displayed leading Pins, then folders, then ordinary Pins.
function normalizeOrder(pins, folders) {
  const legacy = [...pins.filter(pin => pin.beforeFolders), ...folders, ...pins.filter(pin => !pin.beforeFolders)];
  legacy.forEach((item, index) => { if (!Number.isFinite(item.order)) item.order = index; });
}
function placeItem(pins, folders, item, kind, message) {
  const parentId = (kind === 'folder' ? item.parentId : item.folderId) || null;
  const superPin = kind === 'pin' && item.superPin === true;
  const siblings = [
    ...pins.filter(pin => (pin.superPin === true) === superPin && (pin.folderId || null) === parentId).map(item => ({ item, kind: 'pin' })),
    ...folders.filter(folder => !superPin && (folder.parentId || null) === parentId).map(item => ({ item, kind: 'folder' }))
  ].filter(entry => entry.item !== item).sort((a, b) => a.item.order - b.item.order);
  const nextPin = pins.slice(pins.indexOf(item) + 1).find(pin => (pin.superPin === true) === superPin && (pin.folderId || null) === parentId);
  const anchor = message.placement || (kind === 'pin' && Number.isInteger(message.index) && !message.beforeFolders && nextPin ? { kind: 'pin', id: nextPin.id, side: 'before' } : null);
  let index = siblings.length;
  if (anchor) {
    const found = siblings.findIndex(entry => entry.kind === anchor.kind && entry.item.id === anchor.id);
    if (found < 0) throw new Error('拖放目标已变化，请重新拖动');
    index = found + (anchor.side === 'after' ? 1 : 0);
  } else if (message.beforeFolders === true) index = 0;
  siblings.splice(index, 0, { item, kind });
  siblings.forEach((entry, index) => { entry.item.order = index; });
}
function sortPinsByTree(pins, folders) {
  const ordered = pins.filter(pin => pin.superPin === true).sort((a, b) => a.order - b.order);
  const children = new Map(), visited = new Set();
  function add(parentId, item, kind) {
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push({ item, kind });
  }
  for (const pin of pins) if (!pin.superPin) add(pin.folderId || null, pin, 'pin');
  for (const folder of folders) add(folder.parentId || null, folder, 'folder');
  for (const entries of children.values()) entries.sort((a, b) => a.item.order - b.item.order);
  const stack = [...(children.get(null) || [])].reverse();
  while (stack.length) {
    const { item, kind } = stack.pop();
    if (kind === 'pin') ordered.push(item);
    else if (!visited.has(item.id)) {
      visited.add(item.id);
      const entries = children.get(item.id) || [];
      for (let index = entries.length - 1; index >= 0; index--) stack.push(entries[index]);
    }
  }
  const included = new Set(ordered);
  pins.splice(0, pins.length, ...ordered, ...pins.filter(pin => !included.has(pin)));
}
async function saveBindings(bindings) { await chrome.storage.session.set({ bindings }); }
async function readPeekWindows() {
  return (await chrome.storage.session.get('peekWindows')).peekWindows || {};
}
async function rememberPeekWindow(win, originWindowId, tabId) {
  let popupTabId = tabId || win?.tabs?.[0]?.id;
  if (!Number.isInteger(popupTabId) && Number.isInteger(win?.id)) {
    const [popupTab] = await chrome.tabs.query({ windowId: win.id });
    popupTabId = popupTab?.id;
  }
  if (!Number.isInteger(win?.id) || !Number.isInteger(popupTabId)) return;
  const peekWindows = await readPeekWindows();
  peekWindows[win.id] = { originWindowId, tabId: popupTabId };
  await chrome.storage.session.set({ peekWindows });
  // The registered content script (document_start) asks for its state on load and
  // also listens for this push, so a second injection would only re-initialize it.
  await chrome.tabs.sendMessage(popupTabId, { type: 'PEEK_WINDOW_STATE', popup: true }).catch(() => {});
}
async function returnPeekToTab(tab) {
  const peekWindows = await readPeekWindows();
  const peek = peekWindows[tab.windowId];
  if (!peek || peek.tabId !== tab.id) throw new Error('当前页面不是插件创建的悬浮窗口');
  const origin = await chrome.windows.get(peek.originWindowId).catch(() => null);
  if (origin?.type === 'normal') {
    await chrome.tabs.move(tab.id, { windowId: origin.id, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(origin.id, { focused: true });
  } else {
    await chrome.windows.create({ tabId: tab.id, type: 'normal', focused: true });
  }
  delete peekWindows[tab.windowId];
  await chrome.storage.session.set({ peekWindows });
  await chrome.tabs.sendMessage(tab.id, { type: 'PEEK_WINDOW_STATE', popup: false }).catch(() => {});
}
// Address bar input in the floating window: a URL (scheme optional) or a search.
const ADDRESS_SCHEMES = new Set(['http:', 'https:', 'file:', 'chrome:', 'about:', 'view-source:']);
const HOST_LIKE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\]|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;
function resolveAddress(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (!/\s/.test(text)) {
    if (HOST_LIKE.test(text)) {
      const local = /^(localhost|\d|\[)/i.test(text);
      try { return { url: new URL(`${local ? 'http' : 'https'}://${text}`).href }; } catch {}
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
      try { const url = new URL(text); if (ADDRESS_SCHEMES.has(url.protocol)) return { url: url.href }; } catch {}
    }
  }
  return { search: text };
}
async function navigatePeek(tab, input) {
  const peekWindows = await readPeekWindows();
  if (peekWindows[tab.windowId]?.tabId !== tab.id) throw new Error('当前页面不是插件创建的悬浮窗口');
  const target = resolveAddress(input);
  if (!target) throw new Error('请输入网址或搜索内容');
  if (target.url) await chrome.tabs.update(tab.id, { url: target.url });
  else if (typeof chrome.search?.query === 'function') await chrome.search.query({ text: target.search, tabId: tab.id });
  else await chrome.tabs.update(tab.id, { url: `https://www.google.com/search?q=${encodeURIComponent(target.search)}` });
}
function isPinnableUrl(value) {
  try {
    return new Set(['http:', 'https:', 'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:', 'file:', 'about:', 'view-source:']).has(new URL(value).protocol);
  } catch { return false; }
}
async function syncPinnedTabOrder(windowId, pins, map) {
  if (!pins.some(pin => Number.isInteger(map[pin.id]))) return;
  const tabs = await chrome.tabs.query({ windowId });
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const firstUnpinnedIndex = tabs.filter(tab => tab.pinned).length;
  // Moving one half of a Split View separates it, so split Pin tabs keep their place.
  const orderedTabIds = pins.map(pin => map[pin.id]).filter(tabId => {
    const tab = byId.get(tabId);
    return tab && !tab.pinned && !isSplitTab(tab);
  });
  if (!orderedTabIds.length) return;
  const splitBefore = index => tabs.filter(tab => !tab.pinned && isSplitTab(tab) && tab.index < index).length;
  const alreadyOrdered = orderedTabIds.every((tabId, offset) => {
    const index = byId.get(tabId).index;
    return index - splitBefore(index) === firstUnpinnedIndex + offset;
  });
  if (!alreadyOrdered) await chrome.tabs.move(orderedTabIds, { index: firstUnpinnedIndex });
}
const PEEK_MATCHES = ['http://*/*', 'https://*/*'];
const PEEK_SCRIPTS = [
  { id: 'peek-links', matches: PEEK_MATCHES, js: ['src/content/peek-content.js'], runAt: 'document_start' },
  // MAIN world: intercepts window.open() before Chrome creates a tab (no address bar flash).
  { id: 'peek-open', matches: PEEK_MATCHES, js: ['src/content/peek-main.js'], runAt: 'document_start', world: 'MAIN' },
];
function injectPeekScripts(tabId) {
  return Promise.all([
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/peek-main.js'], world: 'MAIN' }),
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/peek-content.js'] }),
  ]);
}
async function unregisterPeekScripts() {
  const ids = (await chrome.scripting.getRegisteredContentScripts({ ids: PEEK_SCRIPTS.map(script => script.id) })).map(script => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
}
async function restorePeekScripts() {
  const [{ peekEnabled }, { bindings }, peekWindows] = await Promise.all([chrome.storage.local.get('peekEnabled'), read(), readPeekWindows()]);
  // Disabled: stop loading scripts into every page (each load would wake the worker).
  if (!peekEnabled || !await chrome.permissions.contains({ origins: PEEK_MATCHES })) { await unregisterPeekScripts(); return; }
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts({ ids: PEEK_SCRIPTS.map(script => script.id) })).map(script => script.id));
  const missing = PEEK_SCRIPTS.filter(script => !registered.has(script.id));
  const existing = PEEK_SCRIPTS.filter(script => registered.has(script.id));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
  if (existing.length) await chrome.scripting.updateContentScripts(existing);
  const tabIds = new Set([...Object.values(bindings).flatMap(map => Object.values(map)), ...Object.values(peekWindows).map(item => item.tabId)]);
  const tabs = await chrome.tabs.query({});
  const injectableTabIds = tabs.filter(tab => tabIds.has(tab.id) && /^https?:\/\//i.test(tab.url || '')).map(tab => tab.id);
  const results = await Promise.allSettled(injectableTabIds.map(injectPeekScripts));
  if (results.some(result => result.status === 'rejected')) throw new Error('部分 Pin 页面无法启用链接拦截，请检查 Chrome 的网站访问权限并刷新页面');
}
chrome.runtime.onInstalled.addListener(() => { restorePeekScripts().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { restorePeekScripts().catch(console.error); });
// Enabling goes through PREPARE_PEEK (to report errors); disabling only needs cleanup.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.peekEnabled && changes.peekEnabled.newValue !== true) run(unregisterPeekScripts).catch(console.error);
});
chrome.permissions?.onRemoved?.addListener(() => { run(restorePeekScripts).catch(console.error); });
const SPLIT_VIEW_ID_NONE = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;
const isSplitTab = tab => Number.isInteger(tab?.splitViewId) && tab.splitViewId !== SPLIT_VIEW_ID_NONE;
// Chrome Split View (Chrome 155+) requires two adjacent tabs with the same window, pinned and group state.
async function splitTabs(windowId, tabId, targetTabId, side) {
  if (typeof chrome.tabs.createSplit !== 'function') throw new Error('当前 Chrome 版本不支持分屏，请升级到 Chrome 155 或更高版本');
  if (tabId === targetTabId) return;
  const load = () => Promise.all([chrome.tabs.get(tabId), chrome.tabs.get(targetTabId)]);
  let [tab, target] = await load();
  if (tab.windowId !== windowId || target.windowId !== windowId) throw new Error('标签页已移到其他窗口，请重试');
  if (isSplitTab(target)) throw new Error('目标标签页已在分屏中，请先取消分屏');
  if (!!tab.pinned !== !!target.pinned) throw new Error('Chrome 固定标签页只能与固定标签页分屏');
  if (isSplitTab(tab)) { await chrome.tabs.unsplit(tab.splitViewId); [tab, target] = await load(); }
  const targetGroup = target.groupId ?? -1;
  if ((tab.groupId ?? -1) !== targetGroup) {
    if (targetGroup === -1) await chrome.tabs.ungroup(tab.id);
    else await chrome.tabs.group({ groupId: targetGroup, tabIds: [tab.id] });
    [tab, target] = await load();
  }
  const left = side === 'left';
  if (tab.index !== target.index + (left ? -1 : 1)) {
    await chrome.tabs.move(tab.id, { index: (left ? target.index : target.index + 1) - (tab.index < target.index ? 1 : 0) });
    [tab, target] = await load();
  }
  if (Math.abs(tab.index - target.index) !== 1 || (tab.groupId ?? -1) !== (target.groupId ?? -1)) throw new Error('无法将两个标签页排到相邻位置，请稍后重试');
  await chrome.tabs.createSplit(tab.index < target.index ? [tab.id, target.id] : [target.id, tab.id]);
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
}
async function unsplitTab(windowId, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId) throw new Error('标签页已移到其他窗口，请重试');
  if (!isSplitTab(tab)) return;
  if (typeof chrome.tabs.unsplit !== 'function') throw new Error('当前 Chrome 版本不支持取消分屏');
  await chrome.tabs.unsplit(tab.splitViewId);
}
async function snapshot(windowId) {
  const [{ pins, folders, bindings }, tabs] = await Promise.all([read(), chrome.tabs.query({ windowId })]);
  const map = bindings[windowId] || {};
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const used = new Set(Object.values(map));
  return {
    pins: pins.map(pin => {
      const tab = byId.get(map[pin.id]);
      const currentUrl = tab?.url || '';
      const navigated = !!currentUrl && currentUrl !== pin.url;
      return { ...pin, currentUrl, navigated, splitViewId: tab?.splitViewId ?? -1, active: tab?.active === true, loading: tab?.status === 'loading', tabId: tab?.id, status: !tab ? 'closed' : tab.active ? 'active' : tab.status === 'loading' ? 'loading' : 'open' };
    }),
    folders,
    tabs: tabs.filter(tab => !used.has(tab.id) && !pendingNavigationTabs.has(tab.id))
  };
}
async function change(message) {
  const { type, windowId, tabId, pinId, index, folderId } = message;
  if (type === 'SPLIT_TABS' || type === 'UNSPLIT_TAB') {
    if (type === 'SPLIT_TABS') await splitTabs(windowId, tabId, message.targetTabId, message.side);
    else await unsplitTab(windowId, tabId);
    refresh(windowId);
    return;
  }
  if (['ACTIVATE_TAB', 'CLOSE_TAB', 'MOVE_TAB'].includes(type)) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== windowId) throw new Error('标签页已移到其他窗口，请重试');
    if (type === 'ACTIVATE_TAB') await chrome.tabs.update(tabId, { active: true });
    else if (type === 'CLOSE_TAB') await chrome.tabs.remove(tabId);
    else await chrome.tabs.move(tabId, { index });
    refresh(windowId);
    return;
  }
  const { pins, folders, bindings } = await read();
  const previousPins = JSON.stringify({ pins, folders });
  const previousBindings = JSON.stringify(bindings);
  const previousTabIds = new Set(Object.values(bindings).flatMap(windowMap => Object.values(windowMap)));
  const map = bindings[windowId] || {};
  const pin = pins.find(item => item.id === pinId);
  if (['PIN_TAB', 'REORDER_PIN'].includes(type) && message.superPin === true && !pin?.superPin && pins.filter(item => item.superPin === true).length >= 8) throw new Error('图标区最多容纳 8 个页面，请先拖出一个');
  if (type === 'CLEAR_TABS') {
    const tabs = await chrome.tabs.query({ windowId });
    const protectedIds = new Set(Object.values(map));
    // Both halves of the active Split View are on screen; keep the inactive half too.
    const activeSplit = tabs.find(tab => tab.active && isSplitTab(tab))?.splitViewId;
    for (const tab of tabs) if (activeSplit !== undefined && tab.splitViewId === activeSplit) protectedIds.add(tab.id);
    const ids = tabs.filter(tab => !tab.active && !tab.pinned && !protectedIds.has(tab.id) && !pendingNavigationTabs.has(tab.id)).map(tab => tab.id);
    if (ids.length) await chrome.tabs.remove(ids);
    refresh(windowId);
    return;
  } else if (type === 'IMPORT_PINS') {
    const merged = mergeBackup(pins, folders, message.backup);
    pins.splice(0, pins.length, ...merged.pins);
    folders.splice(0, folders.length, ...merged.folders);
  } else if (type === 'PIN_TAB') {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== windowId || !isPinnableUrl(tab.url)) throw new Error('此页面地址不支持固定');
    if (Object.values(map).includes(tabId)) throw new Error('此页面已经固定');
    const item = { id: crypto.randomUUID(), url: tab.url, title: tab.title || tab.url, faviconUrl: tab.favIconUrl || '', folderId: folders.some(folder => folder.id === folderId) ? folderId : null };
    item.superPin = message.superPin === true;
    if (item.superPin) item.folderId = null;
    item.beforeFolders = message.beforeFolders === true;
    pins.splice(Math.max(0, Math.min(index ?? pins.length, pins.length)), 0, item);
    placeItem(pins, folders, item, 'pin', message);
    map[item.id] = tabId;
  } else if (type === 'OPEN_PIN' && pin) {
    const existing = map[pinId] && await chrome.tabs.get(map[pinId]).catch(() => null);
    if (existing && existing.windowId === windowId) await chrome.tabs.update(existing.id, { active: true });
    else { const tab = await chrome.tabs.create({ windowId, url: pin.url }); map[pinId] = tab.id; }
  } else if (type === 'CLOSE_PIN' && map[pinId]) {
    const existing = await chrome.tabs.get(map[pinId]).catch(() => null);
    if (existing?.windowId === windowId) await chrome.tabs.remove(existing.id);
    delete map[pinId];
  } else if (type === 'REMOVE_PIN' && pin) {
    pins.splice(pins.indexOf(pin), 1);
    for (const windowMap of Object.values(bindings)) delete windowMap[pinId];
  } else if (type === 'UNPIN' && pin) {
    if (!map[pinId]) await chrome.tabs.create({ windowId, url: pin.url, active: false });
    pins.splice(pins.indexOf(pin), 1);
    for (const windowMap of Object.values(bindings)) delete windowMap[pinId];
  } else if (type === 'REORDER_PIN' && pin) {
    if (message.placement?.kind === 'pin' && message.placement.id === pin.id) return;
    pin.superPin = message.superPin === true;
    pin.beforeFolders = message.beforeFolders === true;
    pin.folderId = !pin.superPin && folders.some(folder => folder.id === folderId) ? folderId : null;
    pins.splice(pins.indexOf(pin), 1); pins.splice(Math.max(0, Math.min(index, pins.length)), 0, pin);
    placeItem(pins, folders, pin, 'pin', message);
  } else if (type === 'UPDATE_PIN') {
    if (!pin) throw new Error('Pin 不存在');
    const name = String(message.name || '').trim();
    if (!name) throw new Error('Pin 名称不能为空');
    pin.title = name;
  } else if (type === 'CREATE_FOLDER') {
    const name = String(message.name || '').trim();
    if (name) folders.push({ id: crypto.randomUUID(), name, expanded: true, parentId: folders.some(folder => folder.id === message.parentId) ? message.parentId : null });
  } else if (type === 'UPDATE_FOLDER') {
    const folder = folders.find(item => item.id === folderId);
    if (folder && typeof message.expanded === 'boolean') folder.expanded = message.expanded;
    if (folder && typeof message.name === 'string' && message.name.trim()) folder.name = message.name.trim();
  } else if (type === 'DELETE_FOLDER') {
    const position = folders.findIndex(item => item.id === folderId);
    const parentId = folders[position]?.parentId || null;
    if (position !== -1) folders.splice(position, 1);
    for (const item of pins) if (item.folderId === folderId) item.folderId = parentId;
    for (const folder of folders) if (folder.parentId === folderId) folder.parentId = parentId;
  } else if (type === 'MOVE_FOLDER') {
    const folder = folders.find(item => item.id === folderId);
    const parentId = message.parentId || null;
    if (!folder || (parentId && !folders.some(item => item.id === parentId))) throw new Error('文件夹不存在');
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === folderId) throw new Error('不能将文件夹移入自身或其子文件夹');
      ancestor = folders.find(item => item.id === ancestor)?.parentId;
    }
    if (message.placement?.kind === 'folder' && message.placement.id === folder.id) return;
    folder.parentId = parentId;
    placeItem(pins, folders, folder, 'folder', message);
  }
  normalizeOrder(pins, folders);
  sortPinsByTree(pins, folders);
  if (Object.keys(map).length) bindings[windowId] = map;
  if (JSON.stringify({ pins, folders }) !== previousPins) await chrome.storage.local.set({ pins, folders });
  if (JSON.stringify(bindings) !== previousBindings) await saveBindings(bindings);
  // Persist the successful operation before best-effort browser tab positioning.
  let warning;
  if (['PIN_TAB', 'OPEN_PIN', 'CLOSE_PIN', 'REMOVE_PIN', 'UNPIN', 'REORDER_PIN', 'MOVE_FOLDER', 'DELETE_FOLDER', 'IMPORT_PINS'].includes(type)) {
    const sharedOrderChanged = ['PIN_TAB', 'REMOVE_PIN', 'UNPIN', 'REORDER_PIN', 'MOVE_FOLDER', 'DELETE_FOLDER', 'IMPORT_PINS'].includes(type);
    const affectedWindows = sharedOrderChanged ? Object.entries(bindings) : [[windowId, map]];
    for (const [id, windowMap] of affectedWindows) {
      try { await syncPinnedTabOrder(Number(id), pins, windowMap); }
      catch { warning = '操作已保存，但 Chrome 暂时无法调整标签顺序，请结束拖动后重试。'; }
    }
  }
  if (['PIN_TAB', 'OPEN_PIN', 'CLOSE_PIN', 'REMOVE_PIN', 'UNPIN'].includes(type)) {
    const { peekEnabled } = await chrome.storage.local.get('peekEnabled');
    const currentTabIds = new Set(Object.values(bindings).flatMap(windowMap => Object.values(windowMap)));
    if (type === 'PIN_TAB' && peekEnabled && /^https?:\/\//i.test(pins.find(item => map[item.id] === tabId)?.url || '')) {
      await injectPeekScripts(tabId).catch(() => {});
    }
    await Promise.all([...new Set([...previousTabIds, ...currentTabIds])].filter(id => previousTabIds.has(id) !== currentTabIds.has(id)).map(id =>
      chrome.tabs.sendMessage(id, { type: 'PEEK_STATE', enabled: peekEnabled === true && currentTabIds.has(id) }).catch(() => {})
    ));
  }
  refresh();
  return warning ? { warning } : undefined;
}
async function peekStatus(tab) {
  const [{ peekEnabled }, { bindings = {}, peekWindows = {} }] = await Promise.all([
    chrome.storage.local.get('peekEnabled'), chrome.storage.session.get(['bindings', 'peekWindows'])
  ]);
  return { enabled: peekEnabled === true && Object.values(bindings[tab.windowId] || {}).includes(tab.id), popup: peekWindows[tab.windowId]?.tabId === tab.id };
}
function isExtensionPage(sender) {
  if (!sender?.tab) return true; // the side panel is not a tab; content scripts always are
  const base = typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : null;
  return !!base && typeof sender.url === 'string' && sender.url.startsWith(base);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // `module:action` messages (e.g. `newtab:*`) belong to other Arcify modules.
  if (typeof message?.type === 'string' && message.type.includes(':')) return;
  if (message.type === 'CHANGED') return;
  if (message.type === 'PREPARE_PEEK') {
    if (!isExtensionPage(sender)) { respond({ error: '不支持的请求来源' }); return; }
    run(restorePeekScripts).then(() => respond({}), error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'PEEK_STATUS') {
    (sender.tab && sender.frameId === 0 ? peekStatus(sender.tab) : Promise.resolve({ enabled: false, popup: false }))
      .then(respond, error => respond({ enabled: false, error: error.message }));
    return true;
  }
  if (message.type === 'PEEK_NAVIGATE') {
    run(async () => {
      if (!sender.tab || sender.frameId !== 0) throw new Error('当前页面不是插件创建的悬浮窗口');
      await navigatePeek(sender.tab, message.input);
      return { navigated: true };
    }).then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'PEEK_OPEN' || message.type === 'PEEK_RETURN') {
    run(async () => {
      const tab = sender.tab;
      if (!tab || sender.frameId !== 0) return { enabled: false };
      if (message.type === 'PEEK_RETURN') {
        await returnPeekToTab(tab);
        return { returned: true };
      }
      const { enabled, popup } = await peekStatus(tab);
      if (!enabled) return { enabled, popup };
      if (!/^https?:\/\//i.test(message.url)) return { enabled: false };
      const win = await chrome.windows.get(tab.windowId);
      if (win.type !== 'normal') return { enabled: false };
      const options = { url: message.url, type: 'popup', ...peekWindowBounds(win, await readPeekSize()) };
      let createdWindow;
      try { createdWindow = await chrome.windows.create(options); }
      catch (error) {
        console.error('无法创建浮窗，改为打开普通标签页', error);
        await chrome.tabs.create({ windowId: tab.windowId, url: message.url });
        return { enabled: true };
      }
      // The page already exists; metadata failure must not open another copy.
      await rememberPeekWindow(createdWindow, tab.windowId).catch(console.error);
      return { enabled: true };
    }).then(respond, error => respond({ enabled: false, error: error.message }));
    return true;
  }
  // Pin / tab operations come only from extension pages (the side panel), never content scripts.
  if (!isExtensionPage(sender)) { respond({ error: '不支持的请求来源' }); return; }
  run(() => message.type === 'GET_SNAPSHOT' ? snapshot(message.windowId) : change(message))
    .then(data => respond({ data }), error => respond({ error: error.message }));
  return true;
});
chrome.commands?.onCommand.addListener(command => {
  if (command !== 'copy-peek-url') return;
  run(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    const peekWindows = await readPeekWindows();
    if (peekWindows[tab.windowId]?.tabId !== tab.id) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'PEEK_COPY_URL' });
  });
});
function refresh(windowId) { chrome.runtime.sendMessage({ type: 'CHANGED', ...(Number.isInteger(windowId) ? { windowId } : {}) }).catch(() => {}); }
async function forgetTabBinding(tabId, windowId) {
  const { bindings = {} } = await chrome.storage.session.get('bindings');
  let changed = false;
  for (const map of Object.values(bindings)) for (const [id, value] of Object.entries(map)) {
    if (value === tabId) { delete map[id]; changed = true; }
  }
  if (changed) {
    await saveBindings(bindings);
    await chrome.tabs.sendMessage(tabId, { type: 'PEEK_STATE', enabled: false }).catch(() => {});
  }
  // Bindings are per window, so only that window's panel needs a new snapshot.
  refresh(windowId);
}
chrome.tabs.onRemoved.addListener((tabId, info) => run(() => forgetTabBinding(tabId, info?.windowId)));
chrome.tabs.onDetached.addListener((tabId, info) => run(() => forgetTabBinding(tabId, info?.oldWindowId)));
chrome.windows.onRemoved.addListener(windowId => run(async () => {
  lastActiveTabs.delete(windowId);
  const [{ bindings = {} }, peekWindows] = await Promise.all([chrome.storage.session.get('bindings'), readPeekWindows()]);
  if (bindings[windowId]) { delete bindings[windowId]; await saveBindings(bindings); }
  if (peekWindows[windowId]) { delete peekWindows[windowId]; await chrome.storage.session.set({ peekWindows }); }
  refresh();
}));
chrome.tabs.onCreated.addListener(tab => refresh(tab.windowId));
chrome.tabs.onActivated.addListener(info => refresh(info.windowId));
chrome.tabs.onMoved.addListener((tabId, info) => refresh(info.windowId));
chrome.tabs.onAttached.addListener((tabId, info) => refresh(info.newWindowId));
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (['status', 'title', 'url', 'favIconUrl', 'pinned', 'discarded', 'splitViewId'].some(key => key in changes)) refresh(tab?.windowId);
  if ('pinned' in changes) chrome.tabs.get(tabId).then(tab => schedulePinnedTabOrder(tab.windowId)).catch(() => {});
});

chrome.storage.session.get('lastActiveTabs').then(({ lastActiveTabs: saved = {} }) => {
  for (const [windowId, tabId] of Object.entries(saved)) if (!lastActiveTabs.has(Number(windowId))) lastActiveTabs.set(Number(windowId), tabId);
}).catch(console.error);
chrome.tabs.query({ active: true }).then(tabs => {
  for (const tab of tabs) if (!lastActiveTabs.has(tab.windowId)) lastActiveTabs.set(tab.windowId, tab.id);
}).catch(console.error);
chrome.tabs.onActivated.addListener(({ windowId, tabId }) => {
  lastActiveTabs.set(windowId, tabId);
  chrome.storage.session.set({ lastActiveTabs: Object.fromEntries(lastActiveTabs) }).catch(console.error);
});
// Foreground state at creation time; Chrome may mark the tab active only later.
const createdForeground = new Map();
chrome.tabs.onCreated.addListener(tab => {
  createdForeground.set(tab.id, tab.active === true);
  setTimeout(() => createdForeground.delete(tab.id), 5000);
  const anchorId = lastActiveTabs.get(tab.windowId) || tab.openerTabId;
  run(async () => {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.type !== 'normal' || !anchorId || anchorId === tab.id) return;
    const [{ pins, bindings }, anchor, current, tabs] = await Promise.all([
      read(), chrome.tabs.get(anchorId).catch(() => null), chrome.tabs.get(tab.id).catch(() => null), chrome.tabs.query({ windowId: tab.windowId })
    ]);
    if (!anchor || !current || anchor.windowId !== current.windowId || current.pinned) return;
    // About to move into a floating window: repositioning would only add visible tab-strip motion.
    if (pendingNavigationTabs.has(current.id) || await navigationDecisions.get(current.id)) return;
    // Tabs created as part of a Split View must stay next to their partner.
    if (isSplitTab(current)) return;
    const map = bindings[tab.windowId] || {};
    const boundIds = new Set(Object.values(map));
    if (boundIds.has(current.id)) {
      await syncPinnedTabOrder(tab.windowId, pins, map);
      return;
    }
    const pinBoundary = tabs.filter(item => item.pinned || boundIds.has(item.id)).length;
    const index = Math.max(pinBoundary, anchor.index + (current.index > anchor.index ? 1 : 0));
    if (current.index !== index) await chrome.tabs.move(tab.id, { index }).catch(() => {});
  });
});

async function restorePinnedTabOrder(windowId) {
  const { pins, bindings } = await read();
  await syncPinnedTabOrder(windowId, pins, bindings[windowId] || {});
}
const pendingOrderWindows = new Set();
function schedulePinnedTabOrder(windowId) {
  if (pendingOrderWindows.has(windowId)) return;
  pendingOrderWindows.add(windowId);
  run(async () => {
    try { await restorePinnedTabOrder(windowId); }
    finally { pendingOrderWindows.delete(windowId); }
  });
}
chrome.tabs.onMoved.addListener((tabId, { windowId }) => schedulePinnedTabOrder(windowId));
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => schedulePinnedTabOrder(newWindowId));

function mergeBackup(pins, folders, backup) {
  if (backup?.format !== 'Sidebar' || backup.version !== 1 || !Array.isArray(backup.pins) || !Array.isArray(backup.folders)) throw new Error('备份格式不正确');
  const folderIds = new Set(), pinIds = new Set();
  for (const folder of backup.folders) {
    if (!folder || typeof folder.id !== 'string' || !folder.id || folderIds.has(folder.id) || typeof folder.name !== 'string' || !folder.name.trim()) throw new Error('备份包含无效文件夹');
    folderIds.add(folder.id);
  }
  for (const folder of backup.folders) {
    const visited = new Set([folder.id]);
    let parent = folder.parentId;
    while (parent) {
      if (!folderIds.has(parent) || visited.has(parent)) throw new Error('备份中的文件夹层级无效');
      visited.add(parent); parent = backup.folders.find(item => item.id === parent).parentId;
    }
  }
  for (const pin of backup.pins) {
    if (!pin || typeof pin.id !== 'string' || !pin.id || pinIds.has(pin.id) || !isPinnableUrl(pin.url) || (pin.folderId && !folderIds.has(pin.folderId))) throw new Error('备份包含无效固定 URL');
    pinIds.add(pin.id);
  }
  const resultFolders = folders.map(item => ({ ...item }));
  const remap = new Map();
  function addFolder(folder) {
    if (remap.has(folder.id)) return remap.get(folder.id);
    const parentId = folder.parentId ? addFolder(backup.folders.find(item => item.id === folder.parentId)) : null;
    const existing = resultFolders.find(item => item.name === folder.name && (item.parentId || null) === parentId);
    const id = existing?.id || crypto.randomUUID();
    remap.set(folder.id, id);
    if (!existing) resultFolders.push({ id, parentId, name: folder.name, expanded: folder.expanded !== false, ...(Number.isFinite(folder.order) ? { order: folder.order } : {}) });
    return id;
  }
  backup.folders.forEach(addFolder);
  const resultPins = pins.map(item => ({ ...item }));
  for (const pin of backup.pins) {
    const folderId = remap.get(pin.folderId) || null;
    if (!resultPins.some(item => item.url === pin.url && (item.folderId || null) === folderId)) resultPins.push({ id: crypto.randomUUID(), url: pin.url, title: typeof pin.title === 'string' ? pin.title : pin.url, faviconUrl: typeof pin.faviconUrl === 'string' ? pin.faviconUrl : '', folderId: pin.superPin === true && resultPins.filter(item => item.superPin === true).length < 8 ? null : folderId, superPin: pin.superPin === true && resultPins.filter(item => item.superPin === true).length < 8, beforeFolders: pin.beforeFolders === true, ...(Number.isFinite(pin.order) ? { order: pin.order } : {}) });
  }
  return { pins: resultPins, folders: resultFolders };
}

// Only links opened from a Pin page while the feature is on can become floating
// windows. Everything else is an ordinary new tab: shown and positioned at once.
const navigationDecisions = new Map();
async function isPeekSource(tabId) {
  const [{ peekEnabled }, { bindings = {} }] = await Promise.all([chrome.storage.local.get('peekEnabled'), chrome.storage.session.get('bindings')]);
  return peekEnabled === true && Object.values(bindings).some(map => Object.values(map || {}).includes(tabId));
}
chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  if (!/^https?:\/\//i.test(details.url)) return;
  const decision = isPeekSource(details.sourceTabId).catch(() => false);
  navigationDecisions.set(details.tabId, decision);
  decision.then(candidate => {
    if (candidate) movePeekTarget(details);
    else navigationDecisions.delete(details.tabId);
  });
});
function movePeekTarget(details) {
  pendingNavigationTabs.add(details.tabId);
  refresh();
  // A newly created foreground tab may not yet be marked active at this event.
  const targetPromise = chrome.tabs.get(details.tabId).catch(() => null);
  // tabs.onCreated normally arrives first and reports the foreground state, so the
  // tab can be moved at once (minimal flash). Otherwise allow Chrome to finish
  // selecting it before checking. Inactive tabs (Cmd-click etc.) are left untouched.
  const foreground = createdForeground.get(details.tabId);
  setTimeout(() => run(async () => {
    // URL and timing cannot identify a gesture: never close a navigation target
    // as a duplicate. The content script owns and cancels intercepted clicks.
    const [target, source, settings, { bindings }, size] = await Promise.all([
      targetPromise, chrome.tabs.get(details.sourceTabId).catch(() => null),
      chrome.storage.local.get('peekEnabled'), read(), readPeekSize()
    ]);
    if (!settings.peekEnabled || !target || !source || target.windowId !== source.windowId) return;
    if (!Object.values(bindings[source.windowId] || {}).includes(source.id)) return;
    const win = await chrome.windows.get(source.windowId).catch(() => null);
    if (!win || win.type !== 'normal') return;
    // If the user has already switched away, leave the tab alone.
    const current = await chrome.tabs.get(target.id).catch(() => null);
    if (!(current?.active || (foreground === true && current)) || current.windowId !== source.windowId) return;
    try {
      const options = { tabId: target.id, type: 'popup', ...peekWindowBounds(win, size) };
      const popup = await chrome.windows.create(options);
      await rememberPeekWindow(popup, source.windowId, target.id);
    } catch (error) { console.error('无法将链接移入浮窗，保留原标签页', error); }
  }).finally(() => { pendingNavigationTabs.delete(details.tabId); navigationDecisions.delete(details.tabId); refresh(); }).catch(() => {}), foreground === true ? 0 : 200);
}
