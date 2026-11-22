// Service-worker side of the Arcify new tab page (Spotlight).
// The page sends `newtab:*` messages; the worker owns the frequency table, so a page that
// navigates away right after opening a result cannot lose the update.
import { recordVisit, isOpenable } from '../newtab/search.js';

const FREQUENT_KEY = 'newtabFrequent';
let writes = Promise.resolve();

function fromNewTabPage(sender) {
  const base = chrome.runtime.getURL('src/newtab/');
  return !!sender?.tab && typeof sender.url === 'string' && sender.url.startsWith(base);
}
async function record(url, title) {
  // Serialized read-modify-write: two quick opens must both count.
  writes = writes.then(async () => {
    const { [FREQUENT_KEY]: table = {} } = await chrome.storage.local.get(FREQUENT_KEY);
    await chrome.storage.local.set({ [FREQUENT_KEY]: recordVisit(table, { url, title }, Date.now()) });
  }).catch(console.error);
  return writes;
}
async function open(message, tab) {
  const url = String(message.url || '');
  if (!isOpenable(url) && !/^(chrome|about|view-source):/i.test(url)) throw new Error('无法打开该地址');
  // Navigate first: counting the visit (a storage read + write) must not delay the page.
  const navigation = message.newTab
    ? chrome.tabs.create({ url, active: false, windowId: tab.windowId, index: tab.index + 1 })
    : chrome.tabs.update(tab.id, { url });
  await Promise.all([navigation, message.record ? record(url, message.title) : null]);
}
async function search(message, tab) {
  const text = String(message.text || '').trim();
  if (!text) throw new Error('请输入搜索内容');
  if (message.newTab) await chrome.search.query({ text, disposition: 'NEW_TAB' });
  else await chrome.search.query({ text, tabId: tab.id });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('newtab:')) return;
  if (!fromNewTabPage(sender)) { respond({ error: '不支持的请求来源' }); return; }
  // `ping` only wakes the worker, so the first Enter does not wait for it to start.
  const handlers = { 'newtab:open': open, 'newtab:search': search, 'newtab:ping': async () => {} };
  const handler = handlers[message.type];
  if (!handler) { respond({ error: `未知操作：${message.type}` }); return; }
  handler(message, sender.tab).then(() => respond({ ok: true }), error => respond({ error: error.message }));
  return true;
});
