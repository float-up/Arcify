const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Pin and Tabs share the sidebar scroll container', () => {
  const html = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.css'), 'utf8');

  assert.match(html, /<main id="sidebar"><section id="pins-section">[\s\S]*<section id="tabs-section">/);
  assert.match(css, /main\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*thin;/s);
  assert.match(css, /section\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /#pins-section\s*\{[^}]*max-height:/s);
  assert.doesNotMatch(css, /#tabs-section\s*\{[^}]*flex:/s);
});
