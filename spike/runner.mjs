#!/usr/bin/env node
/**
 * S-IDE spike runner — S0（命令列閉環）
 *
 *   用法： node spike/runner.mjs [samples/xxx.sem]
 *
 *   環境：
 *     SIDE_BASE_URL   OpenAI 相容端點，預設 https://api.openai.com/v1
 *     SIDE_MODEL      模型名稱
 *     SIDE_API_KEY    API Key（BYOK）
 *     SIDE_MOCK=1     不呼叫 AI，改用罐頭回應，用來驗證管線本身
 *     SIDE_MOCK_FAIL=1  搭配 MOCK：第一次故意回傳壞掉的 body，用來驗證自我修復迴圈
 *
 *   這支程式是拋棄式的，S2 會把邏輯搬進 src/core/。
 *
 *   設計原則（見 docs/02-prelude-v0.md）：
 *     AI 只負責「方法 body」。namespace / using / partial class / attribute / DTO
 *     全部由 harness 產生。AI 出錯的表面積只剩方法實作一項。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── 設定 ────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'spike', '.backend');
const GEN = path.join(BACKEND, 'Generated');
const DBG_DLL = path.join(BACKEND, 'bin', 'Debug', 'net10.0', 'Backend.dll');
const SEM = path.resolve(ROOT, process.argv[2] ?? 'samples/棧板堆疊器.sem');

const MAX_RETRY = Number(process.env.SIDE_MAX_RETRY ?? 2);
const PROMPT_VERSION = 's0-1';
const PRELUDE_VERSION = '0.1.0';
const NAMESPACE = 'SemanticBackend';

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

// ── 解析 .sem（S0 用最笨的 line-based 解析，S1 才需要完整 parser） ──────────
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
      classes.push(parseClass(m[1], b.body));
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
        bodyText: b.body.map((l) => l.text.trim()).filter(Boolean).join('\n'),
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
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    `[SemanticSource("${d.srcFile}", ${d.line})]`,
    `public class ${d.name}`,
    '{',
    props,
    '}',
    '',
  ].join('\n');
}

function genClassSkeleton(cls) {
  const decl = cls.fields
    .filter((f) => f.dependency)
    .map((f) => `    // 由 .sem 契約宣告：${f.type} ${f.name}`)
    .join('\n');
  return [
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    'public partial class ' + cls.name,
    '{',
    decl,
    '}',
    '',
  ].join('\n');
}

function genMethodFile(m, body) {
  const params = m.params.map((p) => `${mapType(p.type)} ${p.name}`).join(', ');
  const ret = mapType(m.returns);
  const srcFile = path.basename(SEM);
  const indented = body.trim().split('\n').map((l) => '        ' + l).join('\n');

  return [
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    `public partial class ${m.className}`,
    '{',
    `    [SemanticSource("${srcFile}", ${m.line})]`,
    `    public ${ret} ${m.name}(${params})`,
    '    {',
    indented,
    '    }',
    '}',
    '',
  ].join('\n');
}

function methodFileName(m) {
  return `${m.className}.${m.name}.g.cs`;
}

function genFieldsFileName(cls) {
  return `${cls.name}.Fields.g.cs`;
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
    '4. 例外：可以使用 BCL（System.*）與 tel/前置庫提供的 Telemetry。',
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
  const parts = [
    `方法簽章：${sig}`,
    '',
    `.sem 實作描述：`,
    '```sem',
    m.bodyText,
    '```',
  ];
  if (hint) {
    parts.push('', '【上次編譯失敗，請修正】', hint);
  }
  return parts.join('\n');
}

async function callAi(system, user) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`AI 呼叫失敗 ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

/** 防禦性移除 markdown fence */
function stripFence(text) {
  let s = String(text).trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) s = fenced[1];
  return s
    .split(/\r?\n/)
    .filter((l) => !/^\s*```/.test(l))
    .join('\n')
    .trim();
}

async function translate(m, ctx, hint) {
  if (MOCK) {
    const body = MOCK_BODIES[m.name];
    if (!body) throw new Error(`MOCK 模式沒有 ${m.name} 的罐頭回應`);
    if (MOCK_FAIL) {
      const n = (mockCalls.get(m.name) ?? 0) + 1;
      mockCalls.set(m.name, n);
      // 前 N 次故意回傳型別錯誤（int 方法回傳 string）→ 逼出編譯失敗
      if (n <= MOCK_FAIL) return 'return "型別錯誤";';
    }
    return body;
  }
  const raw = await callAi(systemPrompt(ctx), userPrompt(m, hint));
  return stripFence(raw);
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

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== S-IDE S0 spike ===`);
  console.log(`sample : ${path.relative(ROOT, SEM)}`);
  console.log(`prompt : ${PROMPT_VERSION}  prelude: ${PRELUDE_VERSION}`);
  console.log(`AI     : ${MOCK ? 'MOCK（未設 SIDE_API_KEY 或 SIDE_MOCK=1）' : `${MODEL} @ ${BASE_URL}`}\n`);

  const src = fs.readFileSync(SEM, 'utf8');
  const { datas, classes } = parseSem(src);
  const methods = classes.flatMap((c) => c.methods);

  console.log(`解析：${datas.length} 個資料、${classes.length} 個類別、${methods.length} 個方法`);
  for (const m of methods) console.log(`  - ${m.className}.${m.name}  (第 ${m.line} 行)`);

  // 1. 全量清空重建（S0 還沒有增量）
  fs.rmSync(GEN, { recursive: true, force: true });
  fs.mkdirSync(GEN, { recursive: true });

  for (const d of datas) {
    writeCs(path.join(GEN, `${d.name}.g.cs`), genDto(d));
  }
  for (const c of classes) {
    writeCs(path.join(GEN, genFieldsFileName(c)), genClassSkeleton(c));
  }

  // 2. context：AI 只能看到這些
  const ctx = {
    types: datas.map((d) => `${d.name}: ${d.fields.map((f) => `${mapType(f.type)} ${f.name}`).join(', ')}`).join('\n'),
    prelude: 'Telemetry.Step(string message)  // 業務時序鏈標記',
  };

  // 3. 逐方法生成（AI 只負責 body）
  for (const m of methods) {
    const body = await translate(m, ctx, null);
    writeCs(path.join(GEN, methodFileName(m)), genMethodFile(m, body));
    console.log(`  生成 ${methodFileName(m)}`);
  }

  // 4. build + 自我修復迴圈
  let lastSignature = '';
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt += 1) {
    console.log(`\n[build] 第 ${attempt} 次`);
    const r = build();
    if (r.status === 0) {
      console.log('  ✅ 編譯成功');
      break;
    }

    const errors = parseErrors(r.stdout, r.stderr);
    if (errors.size === 0) {
      console.log('  ❌ 編譯失敗，但解析不出 error CS####：');
      console.log((r.stdout ?? '').split(/\r?\n/).slice(-25).join('\n'));
      process.exit(1);
    }

    for (const [file, msgs] of errors) console.log(`  ❌ ${file}\n     ${msgs.join('\n     ')}`);

    // 同一組錯誤重複出現 = 錯誤不在 AI 的 action space 內（骨架／Prelude／Program.cs）。
    // 再餵回去只是燒 token，直接交給人類。
    const signature = [...errors.entries()]
      .map(([f, msgs]) => `${f}|${[...msgs].sort().join(';')}`)
      .sort()
      .join('\n');
    if (signature === lastSignature) {
      console.log('\n⚠️  錯誤與上一輪完全相同 —— 這個錯誤不在 AI 的 action space 內。');
      console.log('   （骨架、Prelude 或 Program.cs 的問題，重寫方法 body 不可能修好。）');
      process.exit(1);
    }
    lastSignature = signature;

    if (attempt > MAX_RETRY) {
      console.log(`\n已達重試上限 ${MAX_RETRY}，把錯誤交給人類。`);
      process.exit(1);
    }

    const failed = methods.filter((m) => errors.has(methodFileName(m)));
    if (failed.length === 0) {
      console.log('\n錯誤不在生成檔內（可能在 Program.cs 或 Prelude），不進迴圈。');
      process.exit(1);
    }

    console.log(`\n回饋給 AI 修正 ${failed.length} 個方法…`);
    for (const m of failed) {
      const body = await translate(m, ctx, errors.get(methodFileName(m)).slice(0, 5).join('\n'));
      writeCs(path.join(GEN, methodFileName(m)), genMethodFile(m, body));
    }
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
