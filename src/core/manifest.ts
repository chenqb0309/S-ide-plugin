import path from 'node:path';
import crypto from 'node:crypto';
import type { Manifest, Unit } from './types';
import { PRELUDE_VERSION, PROMPT_VERSION } from './versions';
import { ensureDir, exists, listFiles, readText, removeFile, writeText } from './fsx';
import { generatedDir } from './build';

export const MANIFEST_FILE = 'manifest.json';

const sha1 = (s: string): string => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);

export function cacheKeyOf(u: Unit, signatureIndexVersion: string): string {
  return sha1([u.key, u.contract, u.body, signatureIndexVersion, PRELUDE_VERSION, PROMPT_VERSION].join('\n'));
}

export function signatureIndexVersion(indexText: string): string {
  return sha1(indexText);
}

export function readManifest(workspaceRoot: string): Manifest | null {
  const file = path.join(generatedDir(workspaceRoot), MANIFEST_FILE);
  if (!exists(file)) return null;
  try {
    return JSON.parse(readText(file)) as Manifest;
  } catch {
    return null;
  }
}

export function writeManifest(workspaceRoot: string, manifest: Manifest): void {
  const dir = generatedDir(workspaceRoot);
  ensureDir(dir);
  writeText(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

export function buildManifest(
  sigVer: string,
  units: Unit[],
  previous: Manifest | null,
): Manifest {
  const entries: Manifest['units'] = {};
  for (const u of units) {
    const old = previous?.units[u.key];
    entries[u.key] = {
      sem: u.srcFile,
      semLine: u.line,
      cs: `Generated/${u.file}`,
      cacheKey: u.cacheKey as string,
      // 沿用的 unit 不會重新產生，要保留上一次的值
      generatedAt: u.generatedAt ?? old?.generatedAt ?? null,
      attempts: u.attempts ?? old?.attempts ?? 0,
    };
  }
  return {
    preludeVersion: PRELUDE_VERSION,
    promptVersion: PROMPT_VERSION,
    signatureIndexVersion: sigVer,
    units: entries,
  };
}

/**
 * 保守失效的判定。
 *
 *   改 body            → 只有該 unit 重生
 *   改任何簽章／型別    → 簽章索引版本變 → 全專案重生
 *   改 Prelude／prompt → 全專案重生
 */
export function markStale(
  workspaceRoot: string,
  units: Unit[],
  sigVer: string,
  previous: Manifest | null,
  force: boolean,
): void {
  const dir = generatedDir(workspaceRoot);

  for (const u of units) {
    u.cacheKey = cacheKeyOf(u, sigVer);
    const old = previous?.units[u.key];

    if (force) u.stale = '強制重建';
    else if (!exists(path.join(dir, u.file))) u.stale = '檔案不存在'; // 含手動刪掉整個 Generated/
    else if (!old) u.stale = 'manifest 無紀錄';
    else if (old.cacheKey !== u.cacheKey) {
      u.stale = previous && previous.signatureIndexVersion !== sigVer ? '簽章索引變動' : '內容變動';
    } else u.stale = null;
  }
}

/** 孤兒清理：Generated/ 中不屬於當前規格的 *.g.cs 一律刪除。 */
export function cleanOrphans(workspaceRoot: string, units: Unit[]): string[] {
  const dir = generatedDir(workspaceRoot);
  const expected = new Set(units.map((u) => u.file));
  const removed: string[] = [];
  for (const name of listFiles(dir, (n) => n.endsWith('.g.cs'))) {
    if (!expected.has(name)) {
      removeFile(path.join(dir, name));
      removed.push(name);
    }
  }
  return removed;
}
