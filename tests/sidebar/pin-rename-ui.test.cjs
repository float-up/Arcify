const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Pin rows expose a rename action wired to UPDATE_PIN', () => {
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');
  const css = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.css'), 'utf8');
  assert.match(script, /kind === 'pin'[^\n]*button\('✎', '重命名 Pin'/);
  assert.match(script, /requestText\(\{ title: '重命名 Pin'/);
  assert.match(script, /send\('UPDATE_PIN', \{ pinId: current\.id, name \}\)/);
  assert.match(script, /iconWrap\.append\(status\)/);
  assert.match(script, /actions\.append\(close\); el\.append\(actions\)/);
  assert.match(css, /\.status\s*\{[^}]*position:\s*absolute;[^}]*right:\s*-3px;[^}]*bottom:\s*-3px;/s);
  assert.match(css, /\.status\.closed\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.row-actions\s*\{[^}]*display:\s*flex;[^}]*opacity:\s*0;/s);
});
