import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readText, writeText } from '../fsx';
import { DOC_VERSION, INDEX_FILE, MARKER_FILE, renderIndex } from './markdown';
import { labelsFor, type DocLabels } from './labels';

export const DOCS_DIR_DEFAULT = 'semDocs';

export interface Marker {
  version: number;
  generator: string;
  createdAt: string;
  /** 上次產生時的輸出語言；不同就要全量重建，避免中英混在一起 */
  language?: string;
}

export function markerPath(dir: string): string {
  return path.join(dir, MARKER_FILE);
}

export function readMarker(dir: string): Marker | null {
  const file = markerPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readText(file)) as Partial<Marker>;
    return {
      version: Number(parsed.version ?? 0),
      generator: String(parsed.generator ?? ''),
      createdAt: String(parsed.createdAt ?? ''),
      language: typeof parsed.language === 'string' ? parsed.language : undefined,
    };
  } catch {
    return null;
  }
}

export function writeMarker(dir: string, previous?: Marker | null, language = 'en'): void {
  const marker: Marker = {
    version: DOC_VERSION,
    generator: 's-ide/docs',
    // 版本升級時保留原本的建立時間，避免每次同步都改這一行
    createdAt: previous?.createdAt || new Date().toISOString(),
    language,
  };
  writeText(markerPath(dir), JSON.stringify(marker, null, 2) + '\n');
}

/** `Services/ShippingService.cs` → `semDocs/Services/ShippingService.md` */
export function mdRelPath(relCs: string, relDocsDir: string): string {
  const withoutExt = relCs.replace(/\.cs$/i, '');
  return `${relDocsDir.replace(/\/+$/, '')}/${withoutExt}.md`;
}

/** `semDocs/Services/A.md` → `Services/A.cs` */
export function csRelFromMd(relMd: string, relDocsDir: string): string {
  const prefix = relDocsDir.replace(/\/+$/, '') + '/';
  const rest = relMd.toLowerCase().startsWith(prefix.toLowerCase()) ? relMd.slice(prefix.length) : relMd;
  return rest.replace(/\.md$/i, '.cs');
}

/** 遞迴列出目錄下所有 .md（相對路徑，正斜線），排除 index.md。 */
export function listDocFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== INDEX_FILE) {
        found.push(path.relative(dir, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(dir);
  return found.sort();
}

/** 從文件抓 `## Class` 標題，供 index 使用。 */
export function classesIn(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 刪除後往上清掉空目錄（不刪到 docRoot 之外）。 */
export function pruneEmptyDirs(dir: string, stopAt: string): void {
  let current = dir;
  const stop = path.resolve(stopAt);
  while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** 重建 index.md。內容全部由檔案推導，不存任何狀態。 */
export function writeIndex(dir: string, labels: DocLabels = labelsFor('en')): void {
  ensureDir(dir);
  const entries = listDocFiles(dir).map((rel) => ({
    relMd: rel,
    classes: classesIn(readText(path.join(dir, rel))),
  }));
  writeText(path.join(dir, INDEX_FILE), renderIndex(entries, labels));
}
