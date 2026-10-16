import fs from 'node:fs';
import path from 'node:path';

/**
 * 安全檔案操作。
 *
 * ⚠️ 本檔案**禁用 `fs.rmSync`**：只要路徑含非 ASCII 字元，
 * Node v24.9.0 在 Windows 上會硬崩潰（0xC0000409 / STATUS_STACK_BUFFER_OVERRUN），
 * 連 try/catch 都攔不到。而本專案的檔名全是中文。
 * 實測矩陣見 docs/S1-incremental.md。
 */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * 寫入文字檔。
 * @param bom 生成的 C# 要帶 BOM，確保 Roslyn 一定以 UTF-8 讀取（中文識別字）
 */
export function writeText(file: string, text: string, opts: { bom?: boolean } = {}): void {
  ensureDir(path.dirname(file));
  const body = text.replace(/\r?\n/g, '\n');
  fs.writeFileSync(file, (opts.bom ? '\uFEFF' : '') + body, 'utf8');
}

/** 刪檔。用 unlinkSync，不用 rmSync。 */
export function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在就當成功 */
  }
}

/** 遞迴刪目錄。用 unlinkSync + rmdirSync，不用 rmSync。 */
export function removeDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeDir(p);
    else removeFile(p);
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* 目錄可能已被清空但無法刪除；不致命 */
  }
}

export function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && filter(e.name))
    .map((e) => e.name);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'bin', 'obj', '.semantic_backend', '.vscode-test']);

/** 遞迴掃描 workspace 內的 .sem（相對路徑） */
export function scanSemFiles(workspaceRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.sem')) {
        found.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(workspaceRoot);
  return found.sort();
}

export function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
}
