import type { MemberDoc } from './types';

/**
 * 文件模板。
 *
 * 規則：**一個符號 = 一個可獨立重寫的區塊**，區塊之間沒有聚合敘述。
 * 唯一例外是 `## Class` 標題——它由符號名直接產生，不含內容，所以重寫不掉任何東西。
 */

export const DOC_VERSION = 1;
export const MARKER_FILE = '.semrc.json';
export const INDEX_FILE = 'index.md';

export const ANCHOR_RE = /^<a id="([^"]+)"><\/a>\s*$/;

export interface CallLink {
  id: string;
  label: string;
}

export function renderClassHeading(className: string, anchor: string): string {
  return `<a id="${anchor}"></a>\n## ${className}`;
}

export function renderMember(member: MemberDoc, prose: string, calls: readonly CallLink[]): string {
  const lines: string[] = [];
  lines.push(`<a id="${member.id}"></a>`);
  lines.push(`### ${member.name}`);
  if (member.signature) lines.push('`' + oneLine(member.signature) + '`');

  const text = oneLine(prose);
  if (text) {
    lines.push('');
    lines.push(`> ${text}`);
  }

  const unique = dedupe(calls);
  if (unique.length) {
    lines.push('');
    for (const call of unique) lines.push(`- 呼叫 → [${call.label}](#${call.id})`);
  }

  return lines.join('\n');
}

export function renderFileHeader(relCs: string): string {
  return [
    `# ${relCs.split('/').pop() ?? relCs}`,
    '',
    '> 本檔由 S-IDE 從原始碼產生。**請勿手動編輯**；改完 code 後執行「S-IDE: 同步語義文件」。',
  ].join('\n');
}

/**
 * 解析既有文件裡的區塊：id → 原文。
 * 只認 `<a id="...">` 開頭、到下一個 anchor / `## ` 為止的內容。
 */
export function parseBlocks(md: string): Map<string, string> {
  const map = new Map<string, string>();
  let current: { id: string; buf: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    // class anchor 不是可重寫的區塊：只認後面接著 `### ` 的 anchor
    const isMemberBlock = current.buf.some((l) => /^### /.test(l));
    if (isMemberBlock) map.set(current.id, current.buf.join('\n').trimEnd());
    current = null;
  };

  for (const line of md.split(/\r?\n/)) {
    const m = ANCHOR_RE.exec(line);
    if (m) {
      flush();
      current = { id: m[1], buf: [line] };
      continue;
    }
    if (current) {
      if (/^## /.test(line)) {
        flush();
        continue;
      }
      current.buf.push(line);
    }
  }
  flush();
  return map;
}

/** 組回整份檔案。未變動的區塊原樣接回，不重新序列化。 */
export function renderFile(
  relCs: string,
  classes: ReadonlyArray<{ name: string; anchor: string; blocks: string[] }>,
): string {
  const parts: string[] = [renderFileHeader(relCs)];

  for (const cls of classes) {
    parts.push(renderClassHeading(cls.name, cls.anchor));
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

function oneLine(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*>\s*/, '')
    .trim();
}

function dedupe(calls: readonly CallLink[]): CallLink[] {
  const seen = new Set<string>();
  const out: CallLink[] = [];
  for (const call of calls) {
    if (!call.id || seen.has(call.id)) continue;
    seen.add(call.id);
    out.push(call);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
