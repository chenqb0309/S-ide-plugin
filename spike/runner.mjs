#!/usr/bin/env node
/**
 * S-IDE spike runner — S1（保守增量 + manifest）
 *
 *   用法： node spike/runner.mjs [samples/xxx.sem]
 *
 *   環境：
 *     SIDE_BASE_URL     OpenAI 相容端點，預設 https://api.openai.com/v1
 *     SIDE_MODEL        模型名稱
 *     SIDE_API_KEY      API Key（BYOK）
 *     SIDE_MOCK=1       不呼叫 AI，改用罐頭回應，用來驗證管線本身
 *     SIDE_MOCK_FAIL=N  搭配 MOCK：前 N 次故意回傳壞掉的 body，驗證自我修復迴圈
 *     SIDE_MAX_RETRY=N  重試上限，預設 2
 *     SIDE_FORCE=1      忽略 manifest，全量重生
 *
 *   這支程式是拋棄式的，S2 會把邏輯搬進 src/core/。
 *
 *   設計原則（見 docs/02-prelude-v0.md）：
 *     AI 只負責「方法 body」。namespace / using / partial class / attribute / DTO
 *     全部由 harness 產生。AI 出錯的表面積只剩方法實作一項。
 *
 *   增量策略（見 docs/S1-incremental.md）：
 *     保守失效 —— 寧可多重生，不可少重生。
 *     改 body           → 只有該 unit 重生
 *     改任何簽章／型別   → 簽章索引版本變 → 全專案重生
 *     改 Prelude／prompt → 全專案重生
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── 設定 ────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'spike', '.backend');
const GEN = path.join(BACKEND, 'Generated');
const MANIFEST = path.join(GEN, 'manifest.json');
const DBG_DLL = path.join(BACKEND, 'bin', 'Debug', 'net10.0', 'Backend.dll');
const SEM = path.resolve(ROOT, process.argv[2] ?? 'samples/棧板堆疊器.sem');

const MAX_RETRY = Number(process.env.SIDE_MAX_RETRY ?? 2);
const PROMPT_VERSION = 's1-1';
const PRELUDE_VERSION = '0.1.0';
const NAMESPACE = 'SemanticBackend';
const FORCE = process.env.SIDE_FORCE === '1';

const BASE_URL = (process.env.SIDE_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.SIDE_MODEL ?? '';
const API_KEY = process.env.SIDE_API_KEY ?? '';
const MOCK = process.env.SIDE_MOCK === '1' || !API_KEY;
const MOCK_FAIL = Number(process.env.SIDE_MOCK_FAIL || 0);
const mockCalls = new Map();

// ── 型別對映 ────────────────────────────────────────────────────────────────
const TYPE_MAP = {
  字串: 'string', 整數: 'int', 長整數: 'long', 小數: 'decimal',
  布林: 'bool', 日期: 'DateTime', 空: 'void',
};

function mapType(t) {
  t = String(t).trim();
  let m = t.match(/^清單<(.+)>$/);
  if (m) return `List<${mapType(m[1])}>`;
  m = t.match(/^可空<(.+)>$/);
  if (m) return `${mapType(m[1])}?`;
  return TYPE_MAP[t] ?? t; // 自訂名稱直接用
}

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);

/** 正規化：trim + 去空行。避免換行／縮排差異造成假的「變動」。 */
const normalize = (text) =>
  String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');

// ── 解析 .sem ───────────────────────────────────────────────────────────────
function parseSem(src) {
  const lines = src.split(/\r?\n/).map((text, i) => ({ text: stripComment(text), line: i + 1 }));
  const datas = [];
  const classes = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].text.trim();
    let m = t.match(/^資料\s+([^\s{]+)\s*\{$/);
    if (m) {
      const b = readBlock(lines, i);
      datas.push({ name: m[1], srcFile: path.basename(SEM), line: lines[i].line, fields: parseFields(b.body) });
      i = b.next;
      continue;
    }
    m = t.match(/^類別\s+([^\s{]+)\s*\{$/);
    if (m) {
      const b = readBlock(lines, i);
      classes.push({ ...parseClass(m[1], b.body), line: lines[i].line });
      i = b.next;
      continue;
    }
    i += 1;
  }
  return { datas, classes };
}

function stripComment(text) {
  const i = text.indexOf('#');
  return i === -1 ? text : text.slice(0, i);
}

/** lines[i] 必須是含 `{` 的開頭行；回傳大括號內的內容與下一個索引 */
function readBlock(lines, i) {
  const body = [];
  let depth = 0;
  let started = false;

  for (let k = i; k < lines.length; k += 1) {
    const raw = lines[k].text;
    for (const ch of raw) {
      if (ch === '{') { depth += 1; started = true; continue; }
      if (ch === '}') depth -= 1;
    }
    if (started && depth === 0) return { body, next: k + 1 };
    if (k > i) body.push(lines[k]);
  }
  throw new Error(`第 ${lines[i].line} 行的區塊沒有閉合`);
}

function parseFields(body) {
  return body
    .map((l) => l.text.trim())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(\S+)\s+([^\s{]+)$/);
      if (!m) throw new Error(`無法解析欄位：${t}`);
      return { type: m[1], name: m[2] };
    });
}

function parseClass(name, body) {
  const fields = [];
  const methods = [];
  let i = 0;

  while (i < body.length) {
    const t = body[i].text.trim();

    if (t === '契約 {') {
      const b = readBlock(body, i);
      for (const l of b.body) {
        const s = l.text.trim();
        const m = s.match(/^使用\s+(\S+)\s+([^\s]+)$/);
        if (m) fields.push({ type: m[1], name: m[2], dependency: true });
      }
      i = b.next;
      continue;
    }

    const m = t.match(/^方法\s+([^\s(]+)\s*\((.*)\)\s*(?::\s*([^\s{]+))?\s*\{$/);
    if (m) {
      const b = readBlock(body, i);
      methods.push({
        className: name,
        name: m[1],
        line: body[i].line,
        params: parseParams(m[2]),
        returns: m[3] ?? '空',
        bodyText: normalize(b.body.map((l) => l.text).join('\n')),
      });
      i = b.next;
      continue;
    }
    i += 1;
  }

  return { name, fields, methods };
}

function parseParams(raw) {
  const s = raw.trim();
  if (!s) return [];
  return s.split(',').map((p) => {
    const m = p.trim().match(/^(\S+)\s+([^\s]+)$/);
    if (!m) throw new Error(`無法解析參數：${p}`);
    return { type: m[1], name: m[2] };
  });
}

// ── 單元（unit）與簽章索引 ──────────────────────────────────────────────────
const dtoContract = (d) => `資料 ${d.name} { ${d.fields.map((f) => `${f.type} ${f.name}`).join('; ')} }`;
const depsContract = (c) => `類別 ${c.name} 契約 { ${c.fields.map((f) => `${f.type} ${f.name}`).join('; ')} }`;
const sigOf = (m) => `方法 ${m.className}.${m.name}(${m.params.map((p) => `${p.type} ${p.name}`).join(', ')}) : ${m.returns}`;

function buildUnits(parsed) {
  const units = [];
  for (const d of parsed.datas) {
    units.push({ key: `資料 ${d.name}`, kind: 'dto', file: `${d.name}.g.cs`, contract: dtoContract(d), body: '', dto: d });
  }
  for (const c of parsed.classes) {
    units.push({ key: `契約 ${c.name}`, kind: 'fields', file: `${c.name}.Fields.g.cs`, contract: depsContract(c), body: '', cls: c });
    for (const m of c.methods) {
      units.push({
        key: `${m.className}.${m.name}`, kind: 'method', file: `${m.className}.${m.name}.g.cs`,
        contract: sigOf(m), body: m.bodyText, method: m,
      });
    }
  }
  return units;
}

/** 簽章索引版本：任一簽章／型別變動 → 全專案失效 */
function signatureIndexVersion(parsed, units) {
  const lines = [
    ...parsed.datas.map(dtoContract),
    ...parsed.classes.map(depsContract),
    ...units.filter((u) => u.kind === 'method').map((u) => u.contract),
  ];
  return sha1(lines.sort().join('\n'));
}

const cacheKeyOf = (u, sigVer) =>
  sha1([u.key, u.contract, u.body, sigVer, PRELUDE_VERSION, PROMPT_VERSION].join('\n'));

// ── 產生檔案（harness 負責的部分，不經 AI） ─────────────────────────────────
function writeCs(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 帶 BOM，確保 Roslyn 一定以 UTF-8 讀取（中文識別字）
  fs.writeFileSync(file, '\uFEFF' + text.replace(/\r?\n/g, '\n'), 'utf8');
}

function genDto(d) {
  const props = d.fields
    .map((f) => `    public ${mapType(f.type)} ${f.name} { get; set; }`)
    .join('\n');
  return [
    'using SIDE.Prelude;', '',
    `namespace ${NAMESPACE};`, '',
    `[SemanticSource("${d.srcFile}", ${d.line})]`,
    `public class ${d.name}`, '{', props, '}', '',
  ].join('\n');
}

function genClassSkeleton(cls) {
  const decl = cls.fields
    .filter((f) => f.dependency)
    .map((f) => `    // 由 .sem 契約宣告：${f.type} ${f.name}`)
    .join('\n');
  return [
    'using SIDE.Prelude;', '',
    `namespace ${NAMESPACE};`, '',
    `public partial class ${cls.name}`, '{', decl, '}', '',
  ].join('\n');
}

function genMethodFile(m, body) {
  const params = m.params.map((p) => `${mapType(p.type)} ${p.name}`).join(', ');
  const ret = mapType(m.returns);
  const srcFile = path.basename(SEM);
  const indented = body.trim().split('\n').map((l) => '        ' + l).join('\n');

  return [
    'using SIDE.Prelude;', '',
    `namespace ${NAMESPACE};`, '',
    `public partial class ${m.className}`, '{',
    `    [SemanticSource("${srcFile}", ${m.line})]`,
    `    public ${ret} ${m.name}(${params})`, '    {',
    indented, '    }', '}', '',
  ].join('\n');
}

// ── AI 轉譯：只生成方法 body ────────────────────────────────────────────────
const MOCK_BODIES = {
  計算單層箱數: 'if (規格.重量 > 15m)\n{\n    return 4;\n}\nreturn 8;',
  計算可堆疊層數: 'return 棧板高度 / 規格.高;',
};

function systemPrompt(ctx) {
  return [
    '你是 S-IDE 語義編譯器，把結構化中文偽代碼的方法實作轉譯為 C#。',
    '',
    '【嚴格約束】',
    '1. 只輸出方法「body」的 C# 敘述，不要輸出 class、方法簽章、大括號外層。',
    '2. 不要有 markdown 標記（```），不要有任何前後解釋文字。',
    '3. 只能使用下列已知型別與成員，不要發明新的型別、欄位或方法。',
    '4. 例外：可以使用 BCL（System.*）與前導庫提供的 Telemetry。',
    '',
    `【可用型別】\n${ctx.types}`,
    '',
    `【可用前導庫】\n${ctx.prelude}`,
    '',
    `【編譯目標】.NET 10 / C#；命名空間 ${NAMESPACE}`,
  ].join('\n');
}

function userPrompt(m, hint) {
  const sig = `${mapType(m.returns)} ${m.name}(${m.params.map((p) => `${mapType(p.type)} ${p.name}`).join(', ')})`;
  const parts = [`方法簽章：${sig}`, '', '.sem 實作描述：', '```sem', m.bodyText, '```'];
  if (hint) parts.push('', '【上次編譯失敗，請修正】', hint);
  return parts.join('\n');
}

async function callAi(system, user) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`AI 呼叫失敗 ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

function stripFence(text) {
  let s = String(text).trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) s = fenced[1];
  return s.split(/\r?\n/).filter((l) => !/^\s*```/.test(l)).join('\n').trim();
}

async function translate(m, ctx, hint) {
  if (MOCK) {
    const body = MOCK_BODIES[m.name];
    if (!body) throw new Error(`MOCK 模式沒有 ${m.name} 的罐頭回應`);
    if (MOCK_FAIL) {
      const n = (mockCalls.get(m.name) ?? 0) + 1;
      mockCalls.set(m.name, n);
      if (n <= MOCK_FAIL) return 'return "型別錯誤";';
    }
    return body;
  }
  return stripFence(await callAi(systemPrompt(ctx), userPrompt(m, hint)));
}

// ── 編譯與錯誤解析 ──────────────────────────────────────────────────────────
function build() {
  return spawnSync('dotnet', ['build', BACKEND, '-nologo', '-v:q'], {
    encoding: 'utf8',
    env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' },
  });
}

function parseErrors(out, err) {
  const byFile = new Map();
  const seen = new Set();
  for (const line of `${out ?? ''}\n${err ?? ''}`.split(/\r?\n/)) {
    const m = line.match(/([^\s()]+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)/);
    if (!m) continue;
    const base = m[1].replace(/\\/g, '/').split('/').pop();
    const msg = `${m[1]}(${m[2]},${m[3]}): ${m[4]} ${m[5]}`.trim();
    if (seen.has(base + msg)) continue; // stdout 與 stderr 會重複同一行
    seen.add(base + msg);
    if (!byFile.has(base)) byFile.set(base, []);
    byFile.get(base).push(msg);
  }
  return byFile;
}

// ── manifest ────────────────────────────────────────────────────────────────
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(sigVer, units, attempts, prev) {
  const unitsObj = {};
  for (const u of units) {
    const old = prev?.units?.[u.key];
    unitsObj[u.key] = {
      sem: path.basename(SEM),
      semLine: u.method?.line ?? u.dto?.line ?? u.cls?.line ?? null,
      cs: `Generated/${u.file}`,
      cacheKey: u.cacheKey,
      // 沿用的 unit 不會重新產生，要保留上一次的值
      generatedAt: u.generatedAt ?? old?.generatedAt ?? null,
      attempts: attempts.has(u.key) ? attempts.get(u.key) : (old?.attempts ?? 0),
    };
  }
  const manifest = {
    preludeVersion: PRELUDE_VERSION,
    promptVersion: PROMPT_VERSION,
    signatureIndexVersion: sigVer,
    units: unitsObj,
  };
  fs.mkdirSync(GEN, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== S-IDE spike（S1 保守增量） ===');
  console.log(`sample : ${path.relative(ROOT, SEM)}`);
  console.log(`prompt : ${PROMPT_VERSION}   prelude: ${PRELUDE_VERSION}`);
  console.log(`AI     : ${MOCK ? 'MOCK（未設 SIDE_API_KEY 或 SIDE_MOCK=1）' : `${MODEL} @ ${BASE_URL}`}`);
  console.log(`force  : ${FORCE ? '是（忽略 manifest）' : '否'}\n`);

  const parsed = parseSem(fs.readFileSync(SEM, 'utf8'));
  const units = buildUnits(parsed);
  const sigVer = signatureIndexVersion(parsed, units);
  const prev = FORCE ? null : readManifest();

  console.log(`解析：${parsed.datas.length} 資料、${parsed.classes.length} 類別、${units.filter((u) => u.kind === 'method').length} 方法`);
  console.log(`簽章索引版本：${sigVer}` + (prev ? `（上次 ${prev.signatureIndexVersion}）` : '（首次）'));

  // 1. 決定每個 unit 是否要重生
  const reasons = new Map(); // key -> 新增|重生|沿用（原因）
  for (const u of units) {
    u.cacheKey = cacheKeyOf(u, sigVer);
    const fileExists = fs.existsSync(path.join(GEN, u.file));
    const old = prev?.units?.[u.key];

    if (!fileExists) u.stale = '檔案不存在';
    else if (!old) u.stale = 'manifest 無紀錄';
    else if (old.cacheKey !== u.cacheKey) {
      u.stale = prev.signatureIndexVersion !== sigVer ? '簽章索引變動' : '內容變動';
    } else u.stale = null;

    reasons.set(u.key, u.stale);
  }

  // 2. 孤兒清理：Generated/ 裡不存在於當前規格的 *.g.cs 一律刪除
  //    注意：不可用 fs.rmSync —— 詳見 docs/S1-incremental.md 的「Node 在 Windows 的檔案操作雷」
  fs.mkdirSync(GEN, { recursive: true });
  const expected = new Set(units.map((u) => u.file));
  let orphans = 0;
  for (const f of fs.readdirSync(GEN, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.g.cs')) continue;
    if (!expected.has(f.name)) {
      fs.unlinkSync(path.join(GEN, f.name));
      orphans += 1;
      console.log(`  -  移除孤兒 ${f.name}`);
    }
  }

  // 3. 生成：沿用的不動，其餘重生
  const ctx = {
    types: parsed.datas.map((d) => `${d.name}: ${d.fields.map((f) => `${mapType(f.type)} ${f.name}`).join(', ')}`).join('\n'),
    prelude: 'Telemetry.Step(string message)  // 業務時序鏈標記',
  };
  const attempts = new Map();
  const regen = [];

  for (const u of units) {
    if (u.stale === null) continue;
    regen.push(u);
  }

  console.log(`\nmanifest：沿用 ${units.length - regen.length}、重生 ${regen.length}、移除 ${orphans}`);
  for (const u of regen) {
    const old = prev?.units?.[u.key];
    const arrow = old ? `${old.cacheKey} → ${u.cacheKey}` : `（新增）${u.cacheKey}`;
    console.log(`  ♻  ${u.key}  ${arrow}  [${u.stale}]`);
  }

  for (const u of units) {
    if (u.stale === null) continue;

    if (u.kind === 'dto') writeCs(path.join(GEN, u.file), genDto(u.dto));
    else if (u.kind === 'fields') writeCs(path.join(GEN, u.file), genClassSkeleton(u.cls));
    else writeCs(path.join(GEN, u.file), genMethodFile(u.method, await translate(u.method, ctx, null)));

    attempts.set(u.key, 0);
    u.generatedAt = new Date().toISOString();
  }

  // 便於重試：沿用的 unit 也要記在 attempts 裡
  writeManifest(sigVer, units, attempts, prev);

  // 4. build + 自我修復迴圈
  let lastSignature = '';
  let ok = false;
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt += 1) {
    console.log(`\n[build] 第 ${attempt} 次`);
    const r = build();
    if (r.status === 0) {
      console.log('  ✅ 編譯成功');
      ok = true;
      break;
    }

    const errors = parseErrors(r.stdout, r.stderr);
    if (errors.size === 0) {
      console.log('  ❌ 編譯失敗，但解析不出 error CS####：');
      console.log((r.stdout ?? '').split(/\r?\n/).slice(-25).join('\n'));
      break;
    }
    for (const [file, msgs] of errors) console.log(`  ❌ ${file}\n     ${msgs.join('\n     ')}`);

    const signature = [...errors.entries()]
      .map(([f, msgs]) => `${f}|${[...msgs].sort().join(';')}`).sort().join('\n');
    if (signature === lastSignature) {
      console.log('\n⚠️  錯誤與上一輪完全相同 —— 這個錯誤不在 AI 的 action space 內。');
      console.log('   （骨架、Prelude 或 Program.cs 的問題，重寫方法 body 不可能修好。）');
      break;
    }
    lastSignature = signature;

    if (attempt > MAX_RETRY) {
      console.log(`\n已達重試上限 ${MAX_RETRY}，把錯誤交給人類。`);
      break;
    }

    const failed = units.filter((u) => u.kind === 'method' && errors.has(u.file));
    if (failed.length === 0) {
      console.log('\n錯誤不在生成檔內（可能在 Program.cs 或 Prelude），不進迴圈。');
      break;
    }

    console.log(`\n回饋給 AI 修正 ${failed.length} 個方法…`);
    for (const u of failed) {
      const body = await translate(u.method, ctx, errors.get(u.file).slice(0, 5).join('\n'));
      writeCs(path.join(GEN, u.file), genMethodFile(u.method, body));
      attempts.set(u.key, attempt);
    }
  }

  writeManifest(sigVer, units, attempts, prev);
  if (!ok) {
    console.log('\n=== 結束（編譯未通過）===');
    process.exit(1);
  }

  // 5. 執行
  console.log('\n[run]');
  const run = spawnSync('dotnet', ['exec', DBG_DLL], {
    encoding: 'utf8',
    env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en' },
  });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  console.log(`\n=== 結束（exit ${run.status}）===`);
  process.exit(run.status ?? 0);
}

main().catch((e) => {
  console.error(`\n管線錯誤：${e.message}`);
  process.exit(1);
});
