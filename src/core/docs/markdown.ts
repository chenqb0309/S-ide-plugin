import path from 'node:path';
import type { MemberDoc } from './types';

/**
 * 文件模板。
 *
 * 規則：**一個符號 = 一個可獨立重寫的區塊**，區塊之間沒有聚合敘述。
 * Anchor 一律用「標題 → slug」的標準 Markdown 規則，不插入 `<a id>`——
 * 這樣 VS Code、GitHub、Obsidian 都能正確跳轉。
 */

export const DOC_VERSION = 3;
export const MARKER_FILE = '.semrc.json';
export const INDEX_FILE = 'index.md';

export interface CallLink {
  id: string;
  label: string;
  /** 目標所在的文件（相對 workspace，正斜線）。跨檔連結需要它。 */
  relMd: string;
  /** 目標節點的 anchor（heading slug） */
  anchor: string;
}

/**
 * 與 VS Code / GitHub 相同的 slug 規則：
 * trim → 小寫 → 移除標點 → 空白換成 `-`。
 * （出處：vscode/extensions/markdown-language-features/src/slugify.ts）
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function renderClassHeading(className: string): string {
  return `## ${className}`;
}

/**
 * @param prose 字串 → 一句摘要；陣列 → 編號步驟（偽代碼）
 */
export function renderMember(
  member: MemberDoc,
  prose: string | string[] | undefined,
  calls: readonly CallLink[],
  fromRelMd: string,
): string {
  const lines: string[] = [];
  lines.push(`### ${member.heading}`);
  if (member.signature) lines.push('`' + oneLine(member.signature) + '`');

  const body = normalizeProse(prose);
  if (body.length) {
    lines.push('');
    if (body.length === 1) {
      lines.push(`> ${body[0]}`);
    } else {
      body.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  }

  const unique = dedupe(calls);
  if (unique.length) {
    lines.push('');
    for (const call of unique) lines.push(`- 呼叫 → [${call.label}](${docHref(fromRelMd, call)})`);
  }

  return lines.join('\n');
}

export function renderFileHeader(relCs: string): string {
  return [
    `# ${relCs.split('/').pop() ?? relCs}`,
    '',
    `<!-- source: ${relCs} -->`,
    '',
    '> 本檔由 S-IDE 從原始碼產生。**請勿手動編輯**；改完 code 後執行「S-IDE: 同步語義文件」。',
  ].join('\n');
}

/**
 * 解析既有文件裡的區塊：anchor(slug) → 原文。
 * 認 `### ` 標題；到下一個標題或 `## ` 為止。
 */
export function parseBlocks(md: string): Map<string, string> {
  const map = new Map<string, string>();
  let current: { anchor: string; buf: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    map.set(current.anchor, current.buf.join('\n').trimEnd());
    current = null;
  };

  for (const line of md.split(/\r?\n/)) {
    const member = /^###\s+(.+?)\s*$/.exec(line);
    if (member) {
      flush();
      current = { anchor: headingSlug(member[1]), buf: [line] };
      continue;
    }
    if (/^##\s+/.test(line) || /^#\s+/.test(line)) {
      flush();
      continue;
    }
    if (current) current.buf.push(line);
  }
  flush();
  return map;
}

/** 組回整份檔案。未變動的區塊原樣接回，不重新序列化。 */
export function renderFile(
  relCs: string,
  classes: ReadonlyArray<{ name: string; blocks: string[] }>,
): string {
  const parts: string[] = [renderFileHeader(relCs)];

  for (const cls of classes) {
    parts.push(renderClassHeading(cls.name));
    for (const block of cls.blocks) parts.push(block);
  }

  return parts.join('\n\n') + '\n';
}

export interface IndexEntry {
  relMd: string;
  classes: string[];
}

export function renderIndex(entries: readonly IndexEntry[]): string {
  const lines = [
    '# 語義文件索引',
    '',
    '> 由 S-IDE 產生。這裡只列檔案與類別，內容請點進各檔案。',
    '',
    '| 檔案 | 類別 |',
    '| --- | --- |',
  ];

  for (const entry of [...entries].sort((a, b) => a.relMd.localeCompare(b.relMd))) {
    const link = entry.relMd;
    const classes = entry.classes.join('、') || '—';
    lines.push(`| [${link}](${link}) | ${classes} |`);
  }

  return lines.join('\n') + '\n';
}

/** 區塊是否已經有內容（一句摘要或編號步驟）。用來決定下次要不要重問 AI。 */
export function hasProse(block: string | undefined): boolean {
  if (!block) return false;
  return /^(?:>\s+\S|\d+\.\s+\S|[-*]\s+\S)/m.test(block);
}

/**
 * 同一份文件裡標題必須唯一，否則所有讀器的 dedupe 規則會各自為政。
 * 重複時依序加上 ` (2)`、` (3)`；slug 會是 `-2`、`-3`。
 */
export function uniqueHeading(name: string, used: Set<string>): { heading: string; anchor: string } {
  const base = headingSlug(name);
  let n = 0;
  let heading = name;
  let anchor = base;

  while (used.has(anchor)) {
    n += 1;
    heading = `${name} (${n + 1})`;
    anchor = `${base}-${n + 1}`;
  }

  used.add(anchor);
  return { heading, anchor };
}

function normalizeProse(prose: string | string[] | undefined): string[] {
  if (!prose) return [];
  const raw = Array.isArray(prose) ? prose : [prose];
  return raw.map((s) => oneLine(s)).filter(Boolean);
}

/** 跨檔連結：相對路徑 + anchor；同檔則只給 anchor。 */
function docHref(fromRelMd: string, call: CallLink): string {
  if (!call.relMd || call.relMd === fromRelMd) return `#${call.anchor}`;
  const rel = path.posix.relative(path.posix.dirname(fromRelMd), call.relMd);
  return `${rel}#${call.anchor}`;
}

function oneLine(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*>\s*/, '')
    .replace(/^\s*\d+\.\s*/, '')
    .trim();
}

function dedupe(calls: readonly CallLink[]): CallLink[] {
  const seen = new Set<string>();
  const out: CallLink[] = [];
  for (const call of calls) {
    const key = `${call.relMd}#${call.anchor}`;
    if (!call.anchor || seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
