import { spawnSync } from 'node:child_process';

/** git 的薄包裝。全部走 spawnSync，非同步交給上層。 */

export interface GitChange {
  /** porcelain 的兩碼狀態，例如 ` M`、`??`、`R ` */
  status: string;
  /** 相對 workspace，正斜線 */
  rel: string;
}

function run(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

export function isGitRepo(root: string): boolean {
  return run(root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}

/**
 * 最後一次動到 docs 目錄的 commit。
 * 這就是「上次同步」的基準點——不用另外存狀態檔。
 */
export function baselineCommit(root: string, relDocsDir: string): string {
  const r = run(root, ['log', '-1', '--format=%H', '--', relDocsDir]);
  return r.ok ? r.out.trim() : '';
}

/** 未 commit 的改動，含未追蹤檔（.gitignore 已由 git 過濾）。 */
export function statusChanges(root: string): GitChange[] {
  const r = run(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!r.ok) return [];

  const out: GitChange[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let rel = line.slice(3).trim();

    // rename 只取新路徑
    const arrow = rel.indexOf(' -> ');
    if (arrow >= 0) rel = rel.slice(arrow + 4).trim();

    // git 會用雙引號包住含空白/非 ASCII 的路徑（並做 octal 逃脫），先去掉外層引號
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);

    out.push({ status, rel: rel.replace(/\\/g, '/') });
  }
  return out;
}

/**
 * 某個檔案相對 baseline 的變動行範圍（1-based，含頭含尾）。
 * 只看新檔（`+` 側）：那是「現在」的行號，才能跟 symbol range 對上。
 */
export function changedLineRanges(root: string, baseline: string, relFile: string): Array<[number, number]> {
  const r = run(root, ['diff', '-U0', '--no-color', baseline, '--', relFile]);
  if (!r.ok) return [];

  const ranges: Array<[number, number]> = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count <= 0) continue; // 純刪除，沒有新行可對應
    ranges.push([start, start + count - 1]);
  }
  return ranges;
}

export function isTracked(root: string, relFile: string): boolean {
  return run(root, ['ls-files', '--error-unmatch', '--', relFile]).ok;
}

/**
 * 專案裡的 .cs（含未追蹤、排除 .gitignore）。
 * 全量建置也走這條，讓「.gitignore 就是邊界」在第一次就成立。
 */
export function listCsFiles(root: string): string[] {
  const r = run(root, ['ls-files', '-co', '--exclude-standard', '--', '*.cs']);
  if (!r.ok) return [];
  return r.out
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .sort();
}
