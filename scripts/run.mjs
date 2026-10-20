#!/usr/bin/env node
/**
 * S-IDE CLI —— 直接在終端機跑同一條管線（外掛用的是同一份 core）。
 *
 *   用法： node scripts/run.mjs [workspaceRoot]
 *
 *   環境：
 *     SIDE_MODE=compile|execute|rebuild   預設 execute
 *     SIDE_BASE_URL                       OpenAI 相容端點
 *     SIDE_MODEL                          模型名稱
 *     SIDE_API_KEY                        API Key（BYOK）
 *     SIDE_MAX_RETRY                      重試上限，預設 2
 *     SIDE_FORCE=1                        忽略 manifest，全量重生
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = require(path.join(ROOT, 'out', 'core', 'index.js'));

const workspaceRoot = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
const mode = process.env.SIDE_MODE ?? 'execute';
const apiKey = process.env.SIDE_API_KEY ?? '';

const opts = {
  workspaceRoot,
  extensionPath: ROOT,
  log: (line) => console.log(line),
  ai: {
    baseUrl: process.env.SIDE_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.SIDE_MODEL ?? '',
    apiKey,
  },
  maxRetry: Number(process.env.SIDE_MAX_RETRY ?? 2),
  force: process.env.SIDE_FORCE === '1',
};

const hyphen = '─'.repeat(60);
console.log(hyphen);
console.log(`S-IDE CLI   workspace: ${workspaceRoot}`);
console.log(`mode: ${mode}   AI: ${apiKey ? `${opts.ai.model} @ ${opts.ai.baseUrl}` : '（未設定 API Key）'}`);
console.log(hyphen + '\n');

const fn = mode === 'rebuild' ? core.rebuildAll : mode === 'compile' ? core.compile : core.execute;

fn(opts)
  .then((r) => {
    console.log('');
    console.log(`結果：${r.ok ? '✅ 成功' : '❌ 失敗'}   沿用 ${r.reused}、重生 ${r.regenerated.length}、移除 ${r.orphans.length}`);
    if (r.diagnostics.length) console.log(`規格診斷：${r.diagnostics.length} 筆`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error(`\n管線錯誤：${e.message}`);
    process.exit(1);
  });
