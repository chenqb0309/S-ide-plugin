import path from 'node:path';
import type { AiConfig } from './translate';
import type { CompileResult, LintDiagnostic, RunResult, SemFile } from './types';
import { parseSem } from './parse';
import { collectSymbols, hasBlocking, lint, lintLinks, lintStaleSyntax } from './lint';
import { contextMapForPrompt, genClassSkeleton, genDto, genMethodFile, planUnits, signatureIndexText } from './codegen';
import { build, executeBackend, generatedDir } from './build';
import {
  buildManifest,
  cleanOrphans,
  markStale,
  readManifest,
  signatureIndexVersion,
  writeManifest,
} from './manifest';
import { scaffold } from './scaffold';
import { Translator } from './translate';
import { readText, removeDir, scanSemFiles, writeText } from './fsx';

export interface PipelineOptions {
  workspaceRoot: string;
  /** 擴充套件根目錄，用來取得 Prelude 資產。CLI 開發時傳 repo 根目錄。 */
  extensionPath: string;
  log: (line: string) => void;
  ai: AiConfig;
  maxRetry: number;
  force?: boolean;
  mock?: boolean;
  mockFail?: number;
  /** 指定要處理的 .sem（相對路徑）。未給則掃描整個 workspace。 */
  semFiles?: string[];
}

function readSpecs(opts: PipelineOptions): SemFile[] {
  const rels = opts.semFiles ?? scanSemFiles(opts.workspaceRoot);
  const files: SemFile[] = [];
  for (const rel of rels) {
    const abs = path.join(opts.workspaceRoot, rel);
    try {
      files.push(parseSem(rel, readText(abs)));
    } catch (e) {
      opts.log(`  ❌ 解析失敗 ${rel}：${(e as Error).message}`);
    }
  }
  return files;
}

export async function compile(opts: PipelineOptions): Promise<CompileResult> {
  const log = opts.log;
  const files = readSpecs(opts);

  // 掃不到任何 .sem 是靜默失敗的溫床（連結、診斷會全部消失），所以講清楚。
  if (files.length === 0) {
    log(`找不到任何 .sem（掃描根目錄：${opts.workspaceRoot}）`);
    log('提示：samples/ 底下每個樣本都是獨立工作區。');
    log('     請把工作區開在樣本資料夾（例：samples/倉儲出貨），不要開 repo 根目錄。');
    return {
      ok: false,
      blocked: true,
      diagnostics: [],
      units: [],
      regenerated: [],
      reused: 0,
      orphans: [],
      manifest: null,
      errors: ['找不到任何 .sem'],
    };
  }

  // ── lint（免費的第一層驗證，不需要編譯器） ──────────────────────────────
  const symbols = collectSymbols(files);
  const read = (rel: string): string => readText(path.join(opts.workspaceRoot, rel));
  const diagnostics: LintDiagnostic[] = [
    ...lint(files),
    ...lintLinks(files, symbols, read),
    ...lintStaleSyntax(files, read),
  ];
  for (const d of diagnostics) {
    log(`  ${d.severity === 'error' ? '❌' : '⚠️'} ${d.relPath}:${d.line + 1} ${d.message}`);
  }

  const units = planUnits(files);
  const methodCount = units.filter((u) => u.kind === 'method').length;
  log(`解析：${files.length} 個 .sem、${units.filter((u) => u.kind === 'dto').length} 資料、${units.filter((u) => u.kind === 'fields').length} 類別、${methodCount} 方法`);

  // ── scaffold（首次使用時偷偷建後台專案） ────────────────────────────────
  const sc = scaffold(opts.workspaceRoot, opts.extensionPath, files);
  if (sc.created) log('  🔧 建立 .semantic_backend（隱匿後台專案）');
  if (sc.copiedPrelude.length) log(`  🔧 更新 Prelude：${sc.copiedPrelude.join('、')}`);

  if (hasBlocking(diagnostics)) {
    log('\n規格有阻斷性錯誤（類別重複／多載／斷鏈），不進入生成。');
    return {
      ok: false,
      blocked: true,
      diagnostics,
      units,
      regenerated: [],
      reused: 0,
      orphans: [],
      manifest: null,
      errors: diagnostics.map((d) => `${d.relPath}:${d.line + 1} ${d.message}`),
    };
  }

  // ── 保守增量 ────────────────────────────────────────────────────────────
  const sigVer = signatureIndexVersion(signatureIndexText(files, units));
  const previous = opts.force ? null : readManifest(opts.workspaceRoot);
  markStale(opts.workspaceRoot, units, sigVer, previous, !!opts.force);

  const orphans = cleanOrphans(opts.workspaceRoot, units);

  const regenerated = units.filter((u) => u.stale !== null);
  log(`\n簽章索引版本：${sigVer}${previous ? `（上次 ${previous.signatureIndexVersion}）` : '（首次）'}`);
  log(`manifest：沿用 ${units.length - regenerated.length}、重生 ${regenerated.length}、移除 ${orphans.length}`);
  for (const u of regenerated) {
    const old = previous?.units[u.key];
    const arrow = old ? `${old.cacheKey} → ${u.cacheKey}` : `（新增）${u.cacheKey}`;
    log(`  ♻  ${u.key}  ${arrow}  [${u.stale}]`);
  }

  // ── 生成 ────────────────────────────────────────────────────────────────
  const translator = new Translator({ ...opts.ai, mock: opts.mock, mockFail: opts.mockFail });
  const dir = generatedDir(opts.workspaceRoot);
  const contextMap = contextMapForPrompt(files);

  for (const u of regenerated) {
    if (u.kind === 'dto' && u.dto) writeText(path.join(dir, u.file), genDto(u.dto), { bom: true });
    else if (u.kind === 'fields' && u.cls) writeText(path.join(dir, u.file), genClassSkeleton(u.cls), { bom: true });
    else if (u.method) {
      const body = await translator.body(u.method, contextMap);
      writeText(path.join(dir, u.file), genMethodFile(u.method, body), { bom: true });
    }
    u.generatedAt = new Date().toISOString();
    u.attempts = 0;
  }

  writeManifest(opts.workspaceRoot, buildManifest(sigVer, units, previous));

  // ── build + 自我修復迴圈 ────────────────────────────────────────────────
  let ok = false;
  let lastSignature = '';
  const errors: string[] = [];

  for (let attempt = 1; attempt <= opts.maxRetry + 1; attempt += 1) {
    log(`\n[build] 第 ${attempt} 次`);
    const result = build(opts.workspaceRoot);

    if (result.ok) {
      log('  ✅ 編譯成功');
      ok = true;
      break;
    }

    if (result.errorsByFile.size === 0) {
      log('  ❌ 編譯失敗，但解析不出 error CS####：');
      log(result.rawTail);
      errors.push(result.rawTail);
      break;
    }

    for (const [file, msgs] of result.errorsByFile) {
      log(`  ❌ ${file}\n     ${msgs.join('\n     ')}`);
      errors.push(...msgs);
    }

    // 同一組錯誤重複出現 = 錯誤不在 AI 的 action space 內（骨架／Prelude／Program.cs）。
    const signature = [...result.errorsByFile.entries()]
      .map(([f, msgs]) => `${f}|${[...msgs].sort().join(';')}`)
      .sort()
      .join('\n');
    if (signature === lastSignature) {
      log('\n⚠️  錯誤與上一輪完全相同 —— 這個錯誤不在 AI 的 action space 內。');
      log('   （骨架、Prelude 或 Program.cs 的問題，重寫方法 body 不可能修好。）');
      break;
    }
    lastSignature = signature;

    if (attempt > opts.maxRetry) {
      log(`\n已達重試上限 ${opts.maxRetry}，把錯誤交給人類。`);
      break;
    }

    const failed = units.filter((u) => u.kind === 'method' && result.errorsByFile.has(u.file));
    if (failed.length === 0) {
      log('\n錯誤不在生成檔內（可能在 Program.cs 或 Prelude），不進迴圈。');
      break;
    }

    log(`\n回饋給 AI 修正 ${failed.length} 個方法…`);
    for (const u of failed) {
      if (!u.method) continue;
      const hint = (result.errorsByFile.get(u.file) ?? []).slice(0, 5).join('\n');
      const body = await translator.body(u.method, contextMap, hint);
      writeText(path.join(dir, u.file), genMethodFile(u.method, body), { bom: true });
      u.attempts = attempt;
    }
    writeManifest(opts.workspaceRoot, buildManifest(sigVer, units, previous));
  }

  return {
    ok,
    blocked: false,
    diagnostics,
    units,
    regenerated,
    reused: units.length - regenerated.length,
    orphans,
    manifest: readManifest(opts.workspaceRoot),
    errors,
  };
}

export async function execute(opts: PipelineOptions): Promise<RunResult> {
  const result = await compile(opts);
  if (!result.ok) return { ...result, output: '', exitCode: null };

  opts.log('\n[run]');
  const run = executeBackend(opts.workspaceRoot);
  if (run.output) opts.log(run.output.replace(/\s+$/, ''));
  opts.log(`=== 結束（exit ${run.exitCode}）===`);
  return { ...result, output: run.output, exitCode: run.exitCode };
}

/** 刪掉整個 Generated/ 並重建——demo 的 money shot。 */
export async function rebuildAll(opts: PipelineOptions): Promise<CompileResult> {
  const dir = generatedDir(opts.workspaceRoot);
  removeDir(dir);
  opts.log('已刪除 Generated/（含 manifest），準備完全重建。');
  return compile(opts);
}
