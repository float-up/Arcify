// "Press Esc again to close", like ⌘Q's "press again to quit": the first press arms the
// guard, a second press within `windowMs` confirms. Any other key disarms it.
export const ESCAPE_WINDOW = 1500;
export function createEscapeGuard({ windowMs = ESCAPE_WINDOW, now = () => performance.now() } = {}) {
  let armedAt = -Infinity;
  return {
    press() {
      const time = now();
      if (time - armedAt <= windowMs) { armedAt = -Infinity; return 'close'; }
      armedAt = time;
      return 'armed';
    },
    reset() { armedAt = -Infinity; },
    get armed() { return now() - armedAt <= windowMs; },
  };
}
