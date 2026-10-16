#!/usr/bin/env node
/**
 * 分層檢查：`src/core/**` 不得 import 'vscode'。
 *
 * 寄生的代價是綁死宿主。這條規則保住未來脫離宿主的自由——
 * 要改成 CLI、要跑在 CI、要獨立成 app，core 都不用重寫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'src', 'core');

const offenders = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name.endsWith('.ts')) {
      const src = fs.readFileSync(p, 'utf8');
      if (/from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/.test(src)) {
        offenders.push(path.relative(ROOT, p));
      }
    }
  }
};
walk(CORE);

if (offenders.length) {
  console.error('❌ 分層違規：src/core/ 不得相依 vscode');
  for (const o of offenders) console.error(`   ${o}`);
  process.exit(1);
}
console.log('✅ 分層檢查通過：src/core/ 對 vscode 零相依');
