// Runs in the page's MAIN world. Sites often open links with window.open()
// instead of <a target="_blank">; Chrome would first show that page as a
// foreground tab in the Pin's window (address bar flashes) before the worker
// could move it. Ask the isolated content script first: if it claims the URL,
// the extension opens the floating window directly and no tab is ever created.
(() => {
  const marker = Symbol.for('sidebar-peek-open');
  if (window.open?.[marker]) return;
  const nativeOpen = window.open;
  // Only plain "open in a new tab" calls; sized/featured popups (OAuth, etc.) keep native behavior.
  const tabFeatures = /^\s*((noopener|noreferrer)\s*(=\s*(yes|1|true)\s*)?[\s,]*)*$/i;
  // window.open() normally returns a WindowProxy. Returning null would look like a
  // blocked popup: many sites then navigate the current tab instead (the address bar
  // flash this hook exists to prevent), and code such as `w.opener = null` throws.
  function detachedWindow() {
    const noop = () => {};
    return { closed: false, opener: null, location: {}, focus: noop, blur: noop, close: noop, postMessage: noop };
  }
  function open(url, target, features) {
    try {
      const name = target == null ? '' : String(target).toLowerCase();
      if (url != null && String(url).trim() && (name === '' || name === '_blank') && (features == null || tabFeatures.test(String(features)))) {
        const href = new URL(String(url), document.baseURI).href;
        if (/^https?:\/\//i.test(href)) {
          const request = new CustomEvent('__sidebar-peek-open', { detail: href, cancelable: true });
          // dispatchEvent returns false when the extension claimed the link.
          if (!document.dispatchEvent(request)) return detachedWindow();
        }
      }
    } catch {}
    return nativeOpen.apply(this, arguments);
  }
  Object.defineProperty(open, marker, { value: true });
  window.open = open;
})();
