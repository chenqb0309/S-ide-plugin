import type { LintDiagnostic, SemFile } from './types';
import { findLinks } from './parse';

export const ENTRY_CLASS = '程式';
export const ENTRY_METHOD = '主';

export interface SymbolTable {
  /** 類別名 → 定義所在的 .sem 相對路徑與行號（0-based） */
  classes: Map<string, { relPath: string; line: number }>;
  /** `類別.方法` → 定義位置 */
  methods: Map<string, { relPath: string; line: number }>;
  /** 資料名 → 定義位置 */
  datas: Map<string, { relPath: string; line: number }>;
}

export function collectSymbols(files: SemFile[]): SymbolTable {
  const classes = new Map<string, { relPath: string; line: number }>();
  const methods = new Map<string, { relPath: string; line: number }>();
  const datas = new Map<string, { relPath: string; line: number }>();

  for (const f of files) {
    for (const c of f.classes) {
      classes.set(c.name, { relPath: f.relPath, line: c.line - 1 });
      for (const m of c.methods) {
        methods.set(`${c.name}.${m.name}`, { relPath: f.relPath, line: m.line - 1 });
      }
    }
    for (const d of f.datas) {
      datas.set(d.name, { relPath: f.relPath, line: d.line - 1 });
    }
  }

  return { classes, methods, datas };
}

/**
 * 規格 lint。
 *
 * 這裡實作的是「定址規則」（docs/01-sem-v0.md）：
 *   1. 類別名全域唯一
 *   2. 禁止多載
 *   3. 連結必須指向存在的單元
 *
 * 這些是免費拿到的第一層驗證——完全不需要編譯器。
 */
export function lint(files: SemFile[]): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];

  // 1. 類別／資料名全域唯一
  for (const kind of ['classes', 'datas'] as const) {
    const seen = new Map<string, string>();
    const label = kind === 'classes' ? '類別' : '資料';
    for (const f of files) {
      for (const decl of f[kind]) {
        const prev = seen.get(decl.name);
        if (prev) {
          diags.push({
            relPath: f.relPath,
            line: decl.line - 1,
            severity: 'error',
            message: `${label}「${decl.name}」重複定義（已在 ${prev} 定義）。類別名必須全域唯一——這是 [[類別.方法]] 能被唯一定址的前提。`,
          });
        } else {
          seen.set(decl.name, f.relPath);
        }
      }
    }
  }

  // 2. 禁止多載
  for (const f of files) {
    for (const c of f.classes) {
      const seen = new Map<string, number>();
      for (const m of c.methods) {
        const prev = seen.get(m.name);
        if (prev !== undefined) {
          diags.push({
            relPath: f.relPath,
            line: m.line - 1,
            severity: 'error',
            message: `方法「${c.name}.${m.name}」在同一類別重複宣告（第 ${prev} 行已有）。v0 禁止多載——否則 \`類別.方法\` 無法唯一定址。`,
          });
        } else {
          seen.set(m.name, m.line);
        }
      }
    }
  }

  // 3. 連結的檢查需要原始檔案內容，見 lintLinks()

  return diags;
}

/** 檢查斷鏈。需要原始檔案內容，所以與 lint 分開。 */
export function lintLinks(
  files: SemFile[],
  symbols: SymbolTable,
  reader: (relPath: string) => string,
): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const f of files) {
    const src = reader(f.relPath);
    for (const link of findLinks(f.relPath, src)) {
      const t = link.target;
      if (!t.includes('.')) continue;
      const [head, ...rest] = t.split('.');
      const member = rest.join('.');
      const known = symbols.methods.has(`${head}.${member}`) || symbols.datas.has(head);
      if (!known) {
        diags.push({
          relPath: f.relPath,
          line: link.line,
          severity: 'error',
          message: `斷鏈：找不到 [[${t}]] 的目標。`,
        });
      }
    }
  }
  return diags;
}

export function hasBlocking(diags: LintDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
