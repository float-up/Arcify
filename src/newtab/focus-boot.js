// Runs synchronously in <head>, before anything is rendered.
//
// Chrome opens a new tab with keyboard focus in the address bar, and a page shown through
// chrome_url_overrides cannot take it: input.focus() then has no visible effect. A page
// that navigates to itself does receive focus, so the overridden instance immediately
// replaces itself with the same page plus a marker. location.replace keeps history clean
// (Back never returns to the first instance); the marker is removed again right away so
// the address bar stays tidy. Doing this before the first paint keeps the window in
// which typing still lands in the address bar as short as possible.
(() => {
  const MARKER = 'arcify-focus';
  const url = new URL(location.href);
  if (!url.searchParams.has(MARKER)) {
    url.searchParams.set(MARKER, '1');
    document.documentElement.dataset.hop = '';
    location.replace(url.href);
    return;
  }
  url.searchParams.delete(MARKER);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
})();
