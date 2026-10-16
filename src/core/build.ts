import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BACKEND_DIR_NAME = '.semantic_backend';
export const GENERATED_DIR_NAME = 'Generated';
export const ASSEMBLY_NAME = 'Backend';

export function backendDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, BACKEND_DIR_NAME);
}

export function generatedDir(workspaceRoot: string): string {
  return path.join(backendDir(workspaceRoot), GENERATED_DIR_NAME);
}

export function assemblyPath(workspaceRoot: string): string {
  return path.join(backendDir(workspaceRoot), 'bin', 'Debug', 'net10.0', `${ASSEMBLY_NAME}.dll`);
}

/** 強制英文訊息：避免 MSBuild 在非 UTF-8 主控台碼頁下輸出亂碼，導致錯誤解析失敗。 */
function dotnetEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' };
}

export interface BuildResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  /** 檔名（basename）→ 錯誤訊息 */
  errorsByFile: Map<string, string[]>;
  /** 解析不出 error CS#### 時的原始尾段 */
  rawTail: string;
}

export function checkDotnet(): { ok: boolean; version: string | null } {
  const r = spawnSync('dotnet', ['--version'], { encoding: 'utf8', env: dotnetEnv() });
  if (r.status !== 0) return { ok: false, version: null };
  return { ok: true, version: (r.stdout ?? '').trim() };
}

export function build(workspaceRoot: string): BuildResult {
  const r = spawnSync('dotnet', ['build', backendDir(workspaceRoot), '-nologo', '-v:q'], {
    encoding: 'utf8',
    env: dotnetEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });

  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const errorsByFile = new Map<string, string[]>();
  const seen = new Set<string>();

  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const m = line.match(/([^\s()]+\.cs)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+)/);
    if (!m) continue;
    const base = m[1].replace(/\\/g, '/').split('/').pop() as string;
    const msg = `${m[1]}(${m[2]},${m[3]}): ${m[4]} ${m[5]}`.trim();
    if (seen.has(base + msg)) continue; // stdout 與 stderr 會重複同一行
    seen.add(base + msg);
    const list = errorsByFile.get(base) ?? [];
    list.push(msg);
    errorsByFile.set(base, list);
  }

  return {
    ok: r.status === 0,
    status: r.status,
    stdout,
    stderr,
    errorsByFile,
    rawTail: stdout.split(/\r?\n/).slice(-25).join('\n'),
  };
}

export function executeBackend(workspaceRoot: string): { output: string; exitCode: number | null } {
  const r = spawnSync('dotnet', ['exec', assemblyPath(workspaceRoot)], {
    encoding: 'utf8',
    env: dotnetEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return { output: (r.stdout ?? '') + (r.stderr ?? ''), exitCode: r.status };
}
