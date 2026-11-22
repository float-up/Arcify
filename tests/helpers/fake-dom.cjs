// Minimal DOM stand-in for the floating window toolbar (no jsdom dependency).
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.style = { setProperty(name, value, priority) { this[name] = priority ? `${value} !${priority}` : value; } };
    this.ownText = ''; this.value = ''; this.disabled = false; this.focused = false;
    const classes = new Set();
    this.classes = classes;
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : !!force; if (on) classes.add(name); else classes.delete(name); return on; },
      contains: name => classes.has(name),
    };
  }
  set className(value) { this.classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => this.classes.add(name)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
  dispatch(type, init = {}) {
    const event = { type, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  click() { if (!this.disabled) return this.dispatch('click'); }
  attachShadow() { this.shadowRoot = new FakeNode('#shadow-root'); return this.shadowRoot; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  blur() { if (this.focused) { this.focused = false; this.dispatch('blur'); } }
  select() { this.selected = true; }
  find(predicate) {
    for (const child of [...this.children, ...(this.shadowRoot ? [this.shadowRoot] : [])]) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}
function createDocument() {
  const document = new FakeNode('#document');
  document.documentElement = new FakeNode('html');
  document.createElement = tag => new FakeNode(tag);
  document.createElementNS = (ns, tag) => new FakeNode(tag);
  return document;
}
module.exports = { FakeNode, createDocument };
