// Schedules the slow chrome.history queries behind the instant in-memory results.
//
// Chrome runs history queries one at a time, so firing one per keystroke made each new
// query wait behind all the stale ones. Here: wait until typing pauses (debounce), keep
// at most one query in flight, run only the newest request after it, and never repeat a
// query that already ran (e.g. after Backspace).
export function createRemoteQuery({ run, delay = 120, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, busy = false, wanted = null;
  const done = new Set();
  async function flush() {
    timer = null;
    if (busy || !wanted) return;
    const request = wanted;
    wanted = null;
    if (done.has(request.id)) return;
    busy = true;
    try { await run(request); done.add(request.id); }
    catch {}
    finally {
      busy = false;
      if (wanted) flush(); // typing continued while this query ran
    }
  }
  return {
    request(id, data) {
      if (timer) cancel(timer);
      timer = null;
      if (id == null || done.has(id)) { wanted = null; return; }
      wanted = { id, ...data };
      timer = schedule(flush, delay);
    },
    get busy() { return busy; },
  };
}
