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

    const mData = t.match(/^data\s+([^\s{]+)\s*\{$/);
    if (mData) {
      const b = readBlock(lines, i);
      datas.push({ name: mData[1], line: lines[i].line, srcFile, fields: parseFields(b.body) });
      i = b.next;
      continue;
    }

    const mClass = t.match(/^class\s+([^\s{]+)\s*\{$/);
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

    if (t === 'requires {') {
      const b = readBlock(body, i);
      // requires 的每一行就是一個連結：`類別名`（宣告「我需要這個協作者」）
      for (const l of b.body) {
        const m = l.text.trim().match(/^`([^`]+)`$/);
        if (m) fields.push({ type: m[1], name: m[1], dependency: true });
      }
      i = b.next;
      continue;
    }

    const m = t.match(/^func\s+([^\s{]+)\s*\{$/);
    if (m) {
      const b = readBlock(body, i);
      const sig = readSignature(b.body);
      methods.push({
        className: name,
        name: m[1],
        line: body[i].line,
        params: sig.params,
        returns: sig.returns,
        bodyText: normalize(sig.body.map((l) => l.text).join('\n')),
        srcFile,
      });
      i = b.next;
      continue;
    }

    i += 1;
  }

  return { name, line, fields, methods, srcFile };
}

/**
 * func 區塊的上半是**契約**（`in:` / `out:`），下半才是**實作**。
 *
 * 這就是「骨架精確，body 自由」的字面形狀：一眼看得出哪幾行是機器要的，
 * 哪幾行是給人讀的。兩者都不寫也可以——那就是無參數、無回傳。
 */
function readSignature(body: Located[]): { params: Param[]; returns: string; body: Located[] } {
  const params: Param[] = [];
  let returns = 'void';
  let k = 0;

  for (; k < body.length; k += 1) {
    const t = body[k].text.trim();
    if (!t) continue;

    const mi = t.match(/^in\s*[:：]\s*(.*)$/);
    if (mi) {
      if (mi[1].trim()) params.push(...parseParams(mi[1]));
      continue;
    }

    const mo = t.match(/^out\s*[:：]\s*(.*)$/);
    if (mo) {
      returns = mo[1].trim() || 'void';
      continue;
    }

    break;
  }

  return { params, returns, body: body.slice(k) };
}

function parseParams(raw: string): Param[] {
  const s = raw.trim();
  if (!s) return [];
  return s.split(/[,，]/).map((p) => {
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

/**
 * 取出所有反引號連結（含行號與欄位位置）。
 *
 * 用反引號而非 `[[...]]`：程式設計師對「反引號 = 識別字」已經有肌肉記憶，
 * 寫在中文句子裡也讀得順（`` 呼叫 `庫存服務.檢查庫存` 並回傳結果 ``）。
 */
export interface LinkRef {
  raw: string;
  target: string;
  line: number;
  startChar: number;
  endChar: number;
}

export function findLinks(relPath: string, src: string): LinkRef[] {
  const out: LinkRef[] = [];
  // 先去掉註解，否則註解裡的反引號會被當成連結
  const lines = src.split(/\r?\n/).map(stripComment);
  for (let i = 0; i < lines.length; i += 1) {
    const re = /`([^`\n]+)`/g;
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
