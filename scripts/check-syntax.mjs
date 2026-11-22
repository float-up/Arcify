// Syntax-checks every extension script with `node --check` (no bundler, no dependencies).
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(entry.name)) files.push(path);
  }
})(join(root, 'src'));

let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const name = relative(root, file);
  if (result.status === 0) console.log(`ok   ${name}`);
  else { failed++; console.error(`FAIL ${name}\n${result.stderr}`); }
}
if (failed) process.exit(1);
