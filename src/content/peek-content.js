(() => {
  // Replace an older listener when the extension is reloaded into an open page.
  globalThis.__sidebarPeekCleanup?.();
  let enabled = false;
  let popup = false;
  let revision = 0;
  let popupRevision = 0;
  // Timers are optional so the script also loads in minimal test sandboxes.
  const later = (fn, ms) => typeof setTimeout === 'function' ? setTimeout(fn, ms) : 0;
  const cancel = id => { if (id && typeof clearTimeout === 'function') clearTimeout(id); };
  const currentHref = () => String(globalThis.location?.href || '');
  const platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
  const isMac = /mac|iphone|ipad/i.test(platform);
  const KEYS = isMac
    ? { edit: '⌘L', back: '⌘[', forward: '⌘]', reload: '⌘R', copy: '⌘⇧L', return: '⌘⇧O' }
    : { edit: 'Ctrl+L', back: 'Alt+←', forward: 'Alt+→', reload: 'Ctrl+R', copy: 'Ctrl+Shift+L', return: 'Ctrl+Shift+O' };

  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement('textarea');
    input.value = value; input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    (document.body || document.documentElement).append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('浏览器拒绝访问剪贴板');
  }

  // ---------- Floating window toolbar ----------
  // A compact address bar in a closed shadow root: back, reload, editable URL,
  // copy link and return-to-tab. It folds into a small domain pill so it does
  // not cover the page, and expands on hover, focus or a shortcut.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    back: ['m14.5 6-6 6 6 6'],
    reload: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3l2.2 2.3', 'M19.5 4.5V9H15'],
    copy: ['M9.5 8.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z', 'M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1'],
    return: ['M14 4.5h5.5V10', 'M19.5 4.5 11 13', 'M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10'],
    lock: ['M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5', 'M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5V12a1.5 1.5 0 0 1 1.5-1.5Z'],
    warn: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 7.8v5', 'M12 16.2h.01'],
  };
  const TOOLBAR_CSS = `
:host{all:initial;position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);display:block;font:500 13px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;color-scheme:light;
--bg:rgb(255 255 255/.9);--solid:#fff;--fg:#1f2329;--muted:#646b75;--line:rgb(15 20 30/.12);--hover:rgb(15 20 30/.07);--field:rgb(15 20 30/.05);--accent:#2f6fd6;--ok:#16834a;--warn:#b45309;--shadow:0 8px 28px -8px rgb(0 0 0/.32),0 1px 3px rgb(0 0 0/.12)}
@media (prefers-color-scheme:dark){:host{color-scheme:dark;--bg:rgb(36 38 42/.9);--solid:#2a2c31;--fg:#e8eaed;--muted:#a0a6ae;--line:rgb(255 255 255/.13);--hover:rgb(255 255 255/.09);--field:rgb(255 255 255/.06);--accent:#8ab4f8;--ok:#5fd394;--warn:#f0bf5a;--shadow:0 10px 30px -8px rgb(0 0 0/.7),0 1px 3px rgb(0 0 0/.4)}}
*{box-sizing:border-box}
button{all:unset;box-sizing:border-box;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.wrap{display:flex;justify-content:center}
.pill,.bar{border:1px solid var(--line);background:var(--bg);color:var(--fg);box-shadow:var(--shadow);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5)}
.pill{display:flex;align-items:center;gap:6px;max-width:240px;height:24px;padding:0 11px 0 9px;border-radius:999px;color:var(--muted);font-size:12px;opacity:.88;transition:opacity .15s}
.pill:hover{opacity:1}
.pill-text{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.bar{display:none;align-items:center;gap:2px;width:min(580px,calc(100vw - 24px));height:38px;padding:3px;border-radius:12px;animation:bar-in .16s cubic-bezier(.2,.7,.3,1)}
.expanded .pill{display:none}
.expanded .bar{display:flex}
@keyframes bar-in{from{opacity:0;transform:translateY(-4px) scale(.98)}}
.action{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:8px;color:var(--muted);transition:background-color .12s,color .12s}
.action:hover{background:var(--hover);color:var(--fg)}
.action:active{transform:scale(.94)}
.action:disabled{opacity:.35;cursor:default;background:none;transform:none}
.reloading [data-action=reload] svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.field{display:flex;align-items:center;gap:7px;flex:1;min-width:0;height:30px;margin:0 4px;padding:0 10px;border-radius:8px;background:var(--field);transition:background-color .12s,box-shadow .12s}
.field:hover{background:var(--hover)}
.editing .field{background:var(--solid);box-shadow:inset 0 0 0 1.5px var(--accent)}
.security{display:grid;place-items:center;flex:none;color:var(--muted)}
.security svg{width:13px;height:13px}
.security.insecure{color:var(--warn)}
.url-view{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:text}
.host{color:var(--fg)}
.rest{color:var(--muted)}
.url-input{all:unset;display:none;flex:1;min-width:0;height:100%;color:var(--fg);font:inherit;cursor:text}
.url-input::placeholder{color:var(--muted)}
.editing .url-input{display:block}
.editing .url-view,.editing .field .security{display:none}
.status{display:none;flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ok)}
.status.error{color:var(--warn)}
.notice:not(.editing) .status{display:block}
.notice:not(.editing) .url-view{display:none}
@media print{.wrap{display:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
  let toolbar = null;
  let editing = false, hovering = false;
  let collapseTimer = 0, noticeTimer = 0, urlPoll = 0;

  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.append(path); }
    return svg;
  }
  function node(tag, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }
  function actionButton(action, label, iconName = action) {
    const button = node('button', 'action');
    button.type = 'button'; button.dataset.action = action;
    button.title = KEYS[action] ? `${label}（${KEYS[action]}）` : label;
    button.setAttribute('aria-label', label);
    button.append(svgIcon(iconName));
    button.addEventListener('click', () => perform(action));
    return button;
  }
  function applyStyles(root) {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
      try { const sheet = new CSSStyleSheet(); sheet.replaceSync(TOOLBAR_CSS); root.adoptedStyleSheets = [sheet]; return; } catch {}
    }
    const style = document.createElement('style'); style.textContent = TOOLBAR_CSS; root.append(style);
  }
  function urlParts(href) {
    try {
      const url = new URL(href);
      let rest = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash;
      try { rest = decodeURI(rest); } catch {}
      const host = url.host || href;
      return { secure: url.protocol === 'https:', host, rest, short: host.replace(/^www\./, '') };
    } catch { return { secure: false, host: href, rest: '', short: href }; }
  }
  function canGoBack() {
    const nav = globalThis.navigation;
    return typeof nav?.canGoBack === 'boolean' ? nav.canGoBack : (globalThis.history?.length || 0) > 1;
  }
  function syncUrl() {
    if (!toolbar) return;
    toolbar.back.disabled = !canGoBack();
    const href = currentHref();
    if (href === toolbar.href) return;
    toolbar.href = href;
    const parts = urlParts(href);
    toolbar.hostText.textContent = parts.host;
    toolbar.restText.textContent = parts.rest;
    toolbar.pillText.textContent = parts.short;
    toolbar.urlView.title = href;
    for (const badge of [toolbar.security, toolbar.pillSecurity]) {
      badge.replaceChildren(svgIcon(parts.secure ? 'lock' : 'warn'));
      badge.classList.toggle('insecure', !parts.secure);
      badge.title = parts.secure ? '连接安全' : '连接不安全';
    }
    if (!editing) toolbar.input.value = href;
  }
  function setExpanded(value) { toolbar?.wrap.classList.toggle('expanded', value); }
  function expand() { cancel(collapseTimer); collapseTimer = 0; setExpanded(true); }
  function scheduleCollapse(delay) {
    cancel(collapseTimer);
    collapseTimer = later(() => { collapseTimer = 0; if (toolbar && !editing && !hovering) setExpanded(false); }, delay);
  }
  function showNotice(text, error = false) {
    if (!toolbar) return;
    toolbar.status.textContent = text;
    toolbar.status.classList.toggle('error', error);
    toolbar.wrap.classList.add('notice');
    expand();
    cancel(noticeTimer);
    noticeTimer = later(() => {
      noticeTimer = 0;
      if (!toolbar) return;
      toolbar.wrap.classList.remove('notice');
      if (!hovering && !editing) scheduleCollapse(900);
    }, error ? 2600 : 1400);
  }
  async function copyCurrentUrl() {
    if (!toolbar) return;
    try { await writeClipboard(currentHref()); showNotice('已复制链接'); }
    catch (error) { showNotice(`复制失败：${error.message}`, true); }
  }
  function startEditing() {
    if (!toolbar) return;
    expand();
    editing = true;
    toolbar.wrap.classList.add('editing');
    toolbar.input.value = currentHref();
    toolbar.input.focus();
    toolbar.input.select();
  }
  function stopEditing() {
    if (!editing || !toolbar) return;
    editing = false;
    toolbar.wrap.classList.remove('editing');
    toolbar.input.value = toolbar.href || '';
    if (!hovering) scheduleCollapse(900);
  }
  async function navigate(value) {
    const input = String(value || '').trim();
    if (!input) return;
    stopEditing();
    toolbar?.input.blur();
    showNotice('正在打开…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'PEEK_NAVIGATE', input });
      if (result?.error) throw new Error(result.error);
    } catch (error) { showNotice(`无法打开：${error.message}`, true); }
  }
  async function returnToTab() {
    const button = toolbar?.returnButton;
    if (!button || button.disabled) return;
    button.disabled = true;
    showNotice('正在移回标签页…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'PEEK_RETURN' });
      if (!result?.returned) throw new Error(result?.error || '无法移回标签页');
      popupRevision++; popup = false; renderToolbar();
    } catch (error) {
      if (toolbar?.returnButton !== button) return;
      button.disabled = false;
      showNotice(`无法移回：${error.message}`, true);
    }
  }
  function perform(action) {
    if (!toolbar) return;
    if (action === 'edit') startEditing();
    else if (action === 'back') { if (canGoBack()) globalThis.history?.back(); else showNotice('没有可后退的页面', true); }
    else if (action === 'forward') globalThis.history?.forward();
    else if (action === 'reload') { toolbar.wrap.classList.add('reloading'); globalThis.location?.reload(); }
    else if (action === 'copy') copyCurrentUrl();
    else if (action === 'return') returnToTab();
  }
  function onInputKey(event) {
    // Keep typing in the address bar away from page shortcuts (Gmail j/k, GitHub s …).
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); navigate(toolbar.input.value); }
    else if (event.key === 'Escape') { event.preventDefault(); toolbar.input.blur(); stopEditing(); }
  }
  // Page rules such as `div { position: relative; transform: none }` apply to the host
  // element and outrank :host, so pin its box with inline !important declarations.
  const HOST_STYLE = 'all:initial!important;position:fixed!important;z-index:2147483647!important;top:8px!important;left:50%!important;transform:translateX(-50%)!important;display:block!important;margin:0!important';
  const onFullscreen = () => {
    if (toolbar) toolbar.hostEl.style.setProperty('display', document.fullscreenElement ? 'none' : 'block', 'important');
  };
  const navigationEvents = ['currententrychange', 'navigatesuccess'];
  function renderToolbar() {
    if (!popup) { teardownToolbar(); return; }
    if (toolbar) return;
    const hostEl = document.createElement('div');
    hostEl.id = '__sidebar-peek-toolbar';
    hostEl.style.cssText = HOST_STYLE;
    const root = hostEl.attachShadow({ mode: 'closed' });
    applyStyles(root);
    const wrap = node('div', 'wrap expanded');
    const pill = node('button', 'pill');
    pill.type = 'button'; pill.title = `展开浮窗工具条（${KEYS.edit} 编辑地址）`; pill.setAttribute('aria-label', '展开浮窗工具条');
    const pillSecurity = node('span', 'security'), pillText = node('span', 'pill-text');
    pill.append(pillSecurity, pillText);
    pill.addEventListener('click', expand);
    const bar = node('div', 'bar');
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '浮窗工具条');
    const back = actionButton('back', '后退');
    const reload = actionButton('reload', '刷新');
    const field = node('div', 'field');
    const security = node('span', 'security');
    const urlView = node('button', 'url-view');
    urlView.type = 'button'; urlView.dataset.action = 'edit'; urlView.setAttribute('aria-label', `编辑地址（${KEYS.edit}）`);
    const hostText = node('span', 'host'), restText = node('span', 'rest');
    urlView.append(hostText, restText);
    urlView.addEventListener('click', startEditing);
    const input = node('input', 'url-input');
    input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off';
    input.setAttribute('aria-label', '地址'); input.setAttribute('placeholder', '输入网址或搜索内容');
    input.addEventListener('keydown', onInputKey);
    for (const type of ['keyup', 'keypress']) input.addEventListener(type, event => event.stopPropagation());
    input.addEventListener('blur', stopEditing);
    const status = node('span', 'status');
    status.setAttribute('role', 'status');
    field.append(security, urlView, input, status);
    const copy = actionButton('copy', '复制链接');
    const returnButton = actionButton('return', '回到标签页');
    bar.append(back, reload, field, copy, returnButton);
    wrap.append(pill, bar);
    wrap.addEventListener('pointerenter', () => { hovering = true; expand(); });
    wrap.addEventListener('pointerleave', () => { hovering = false; if (!editing) scheduleCollapse(700); });
    root.append(wrap);
    toolbar = { hostEl, wrap, pill, pillText, pillSecurity, back, reload, security, urlView, hostText, restText, input, status, copy, returnButton, href: null };
    editing = false; hovering = false;
    (document.documentElement || document).append(hostEl);
    syncUrl();
    // Show the full address briefly on each page load, then fold into the pill.
    scheduleCollapse(2200);
    const nav = globalThis.navigation;
    if (typeof nav?.addEventListener === 'function') for (const type of navigationEvents) nav.addEventListener(type, syncUrl);
    else if (typeof setInterval === 'function') urlPoll = setInterval(syncUrl, 1000);
    globalThis.addEventListener?.('popstate', syncUrl);
    globalThis.addEventListener?.('hashchange', syncUrl);
    document.addEventListener?.('fullscreenchange', onFullscreen);
  }
  function teardownToolbar() {
    if (!toolbar) return;
    cancel(collapseTimer); cancel(noticeTimer); collapseTimer = noticeTimer = 0;
    if (urlPoll && typeof clearInterval === 'function') clearInterval(urlPoll);
    urlPoll = 0;
    for (const type of navigationEvents) globalThis.navigation?.removeEventListener?.(type, syncUrl);
    globalThis.removeEventListener?.('popstate', syncUrl);
    globalThis.removeEventListener?.('hashchange', syncUrl);
    document.removeEventListener?.('fullscreenchange', onFullscreen);
    toolbar.hostEl.remove();
    toolbar = null; editing = false; hovering = false;
  }

  // ---------- Popup state ----------
  async function update() {
    const current = ++revision;
    const currentPopup = ++popupRevision;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'PEEK_STATUS' });
      if (current === revision) enabled = result?.enabled === true;
      if (currentPopup === popupRevision) { popup = result?.popup === true; renderToolbar(); }
    } catch {
      if (current === revision) enabled = false;
      if (currentPopup === popupRevision) { popup = false; renderToolbar(); }
    }
  }
  update();
  const onMessage = message => {
    if (message.type === 'PEEK_STATE') { revision++; enabled = message.enabled === true; }
    else if (message.type === 'PEEK_WINDOW_STATE') { popupRevision++; popup = message.popup === true; renderToolbar(); }
    else if (message.type === 'PEEK_COPY_URL' && popup) copyCurrentUrl();
  };
  // Pin membership is pushed to affected tabs by the worker. A title edit or
  // ordinary tab action must not wake every injected page.
  const onStorage = (changes, area) => {
    if ((area === 'local' && changes.peekEnabled) || (area === 'session' && changes.peekWindows && popup)) update();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);

  // ---------- Link interception in Pin pages ----------
  // One gesture can reach both the window.open hook and the anchor click; open it once.
  let claimedUrl = '', claimedAt = 0;
  function claim(url) {
    const duplicate = url === claimedUrl && Date.now() - claimedAt < 1000;
    claimedUrl = url; claimedAt = Date.now();
    return !duplicate;
  }
  function requestPeek(url) {
    chrome.runtime.sendMessage({ type: 'PEEK_OPEN', url }).then(result => {
      if (!result?.enabled) window.open(url, '_blank', 'noopener');
    }).catch(() => window.open(url, '_blank', 'noopener'));
  }
  // Fired synchronously by peek-main.js (MAIN world) from inside window.open().
  // Require a real user gesture so a page cannot use the hook to spawn windows.
  const onOpenRequest = event => {
    if (!enabled || typeof event.detail !== 'string' || !/^https?:\/\//i.test(event.detail)) return;
    if (globalThis.navigator?.userActivation && !navigator.userActivation.isActive) return;
    event.preventDefault();
    if (claim(event.detail)) requestPeek(event.detail);
  };
  const onClick = event => {
    if (!enabled || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.composedPath().find(element => element instanceof HTMLAnchorElement && element.href);
    if (!link || link.target.toLowerCase() !== '_blank' || link.hasAttribute('download') || !/^https?:\/\//i.test(link.href)) return;
    event.preventDefault();
    // The link is now owned by the extension. Do not let a page click handler
    // also call window.open for the same gesture and create another popup.
    event.stopImmediatePropagation();
    if (claim(link.href)) requestPeek(link.href);
  };

  // ---------- Keyboard shortcuts in floating windows ----------
  // Copy link is captured first so it works even when Chrome assigns no command.
  const onKeydown = event => {
    if (!popup || event.defaultPrevented || event.repeat || event.altKey || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key?.toLowerCase() !== 'l') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    copyCurrentUrl();
  };
  function isEditable(event) {
    const target = event.composedPath?.()[0] || event.target;
    return !!target && (target.isContentEditable === true || /^(input|textarea|select)$/i.test(target.tagName || ''));
  }
  function shortcutAction(event) {
    const key = String(event.key || '').toLowerCase();
    const code = String(event.code || '');
    const letter = name => key === name || code === `Key${name.toUpperCase()}`;
    const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (primary && !event.altKey) {
      if (!event.shiftKey && letter('l')) return 'edit';
      if (!event.shiftKey && letter('r')) return 'reload';
      if (event.shiftKey && letter('o')) return 'return';
      if (isMac && !event.shiftKey && (key === '[' || code === 'BracketLeft')) return 'back';
      if (isMac && !event.shiftKey && (key === ']' || code === 'BracketRight')) return 'forward';
      // ⌘←/→ move the caret inside text fields, as in Chrome.
      if (isMac && !event.shiftKey && !isEditable(event) && key === 'arrowleft') return 'back';
      if (isMac && !event.shiftKey && !isEditable(event) && key === 'arrowright') return 'forward';
    }
    if (!isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (letter('d')) return 'edit';
      if (!isEditable(event) && key === 'arrowleft') return 'back';
      if (!isEditable(event) && key === 'arrowright') return 'forward';
    }
    if (!isMac && plain && event.key === 'F5') return 'reload';
    if (!isMac && plain && event.key === 'F6') return 'edit';
    return null;
  }
  // Bubble phase on window: the page keeps priority, like Chrome's own
  // accelerators. Only keys the page did not handle reach the toolbar.
  const onShortcut = event => {
    if (!popup || !toolbar || event.defaultPrevented || event.isComposing || event.repeat) return;
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    perform(action);
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('__sidebar-peek-open', onOpenRequest, true);
  globalThis.addEventListener?.('keydown', onShortcut);
  globalThis.__sidebarPeekCleanup = () => {
    enabled = false; popup = false; revision++; popupRevision++;
    teardownToolbar();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('__sidebar-peek-open', onOpenRequest, true);
    globalThis.removeEventListener?.('keydown', onShortcut);
    try { chrome.runtime.onMessage.removeListener(onMessage); chrome.storage.onChanged.removeListener(onStorage); } catch {}
  };
})();
