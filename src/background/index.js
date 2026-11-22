// Arcify service worker entry. Chrome allows one service worker per extension, so each
// feature registers its listeners from its own module. Messages for a module other than
// the sidebar use a `module:action` type (e.g. `newtab:record`).
import './sidebar.js';
import './newtab.js';
