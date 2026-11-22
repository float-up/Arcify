// Builds dist/arcify-<version>.zip for the Chrome Web Store: only what the extension loads.
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
const out = `dist/arcify-${version}.zip`;
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
rmSync(new URL(`../${out}`, import.meta.url), { force: true });
const result = spawnSync('zip', ['-r', '-X', out, 'manifest.json', 'src', 'assets', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
if (result.error) { console.error('需要系统 zip 命令：', result.error.message); process.exit(1); }
if (result.status) process.exit(result.status);
console.log(`\n已生成 ${out}`);
