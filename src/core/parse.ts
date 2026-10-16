import path from 'node:path';
import type { ClassDecl, DataDecl, Field, Method, Param, SemFile } from './types';

/**
 * `.sem` 解析器。
 *
 * S2 用 line-based 的笨解析，只抓簽章與 body 文字。
 * 完整 parser（含運算式）留待之後——因為 body 依設計是自由文字，
 * harness 只需要「簽章 + body 原文」這兩樣。
 */

interface Located {
  text: string;
  line: number;
}

export function parseSem(relPath: string, src: string): SemFile {
  const srcFile = path.basename(relPath);
  const lines: Located[] = src
    .split(/\r?\n/)
    .map((text, i) => ({ text: stripComment(text), line: i + 1 }));

  const datas: DataDecl[] = [];
  const classes: ClassDecl[] = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].text.trim();

    const mData = t.match(/^資料\s+([^\s{]+)\s*\{$/);
    if (mData) {
      const b = readBlock(lines, i);
      datas.push({ name: mData[1], line: lines[i].line, srcFile, fields: parseFields(b.body) });
      i = b.next;
      continue;
    }

    const mClass = t.match(/^類別\s+([^\s{]+)\s*\{$/);
    if (mClass) {
      const b = readBlock(lines, i);
      classes.push(parseClass(mClass[1], lines[i].line, srcFile, b.body));
      i = b.next;
      continue;
    }

    i += 1;
  }

  return { relPath, srcFile, datas, classes };
}

function stripComment(text: string): string {
  const i = text.indexOf('#');
  return i === -1 ? text : text.slice(0, i);
}

/** lines[i] 必須是含 `{` 的開頭行；回傳大括號內的內容與下一個索引。 */
function readBlock(lines: Located[], i: number): { body: Located[]; next: number } {
  const body: Located[] = [];
  let depth = 0;
  let started = false;

  for (let k = i; k < lines.length; k += 1) {
    const raw = lines[k].text;
    for (const ch of raw) {
      if (ch === '{') {
        depth += 1;
        started = true;
        continue;
      }
      if (ch === '}') depth -= 1;
    }
    if (started && depth === 0) return { body, next: k + 1 };
    if (k > i) body.push(lines[k]);
  }

  throw new Error(`第 ${lines[i].line} 行的區塊沒有閉合`);
}

function parseFields(body: Located[]): Field[] {
  return body
    .map((l) => l.text.trim())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(\S+)\s+([^\s{]+)$/);
      if (!m) throw new Error(`無法解析欄位：${t}`);
      return { type: m[1], name: m[2] };
    });
}

function parseClass(name: string, line: number, srcFile: string, body: Located[]): ClassDecl {
  const fields: Field[] = [];
  const methods: Method[] = [];
  let i = 0;

  while (i < body.length) {
    const t = body[i].text.trim();

    if (t === '契約 {') {
      const b = readBlock(body, i);
      for (const l of b.body) {
        const m = l.text.trim().match(/^使用\s+(\S+)\s+([^\s]+)$/);
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
        srcFile,
      });
      i = b.next;
      continue;
    }

    i += 1;
  }

  return { name, line, fields, methods, srcFile };
}

function parseParams(raw: string): Param[] {
  const s = raw.trim();
  if (!s) return [];
  return s.split(',').map((p) => {
    const m = p.trim().match(/^(\S+)\s+([^\s]+)$/);
    if (!m) throw new Error(`無法解析參數：${p}`);
    return { type: m[1], name: m[2] };
  });
}

/** 正規化：trim + 去空行。避免換行／縮排差異造成假的「變動」。 */
export function normalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** 取出所有 `[[類別.方法]]` 連結（含行號與欄位位置） */
export interface LinkRef {
  raw: string;
  target: string;
  line: number;
  startChar: number;
  endChar: number;
}

export function findLinks(relPath: string, src: string): LinkRef[] {
  const out: LinkRef[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const re = /\[\[([^\]\n]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      out.push({
        raw: m[0],
        target: m[1].trim(),
        line: i,
        startChar: m.index,
        endChar: m.index + m[0].length,
      });
    }
  }
  void relPath;
  return out;
}
