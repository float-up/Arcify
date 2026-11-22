const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('all naming flows use the themed dialog instead of native prompts', () => {
  const html = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.css'), 'utf8');
  const script = fs.readFileSync(require.resolve('../../src/sidebar/sidepanel.js'), 'utf8');

  assert.match(html, /<dialog id="text-dialog" class="app-dialog">/);
  assert.match(html, /id="text-dialog-input"/);
  assert.match(css, /\.app-dialog::backdrop/);
  assert.match(css, /@keyframes dialog-in/);
  assert.match(script, /function requestText\(/);
  assert.match(script, /textDialog\.addEventListener\('cancel'/);
  assert.match(script, /title: '重命名 Pin'/);
  assert.match(script, /title: '新建文件夹'/);
  assert.match(script, /title: '新建子文件夹'/);
  assert.match(script, /title: '重命名文件夹'/);
  assert.doesNotMatch(script, /\b(?:prompt|confirm|alert)\s*\(/);
});
