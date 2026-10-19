import type { LintDiagnostic, SemFile } from './types';
import { findLinks } from './parse';
import { BCL_TYPES, baseTypeName } from './typing';

export const ENTRY_CLASS = 'App';
export const ENTRY_METHOD = 'Main';

export interface SymbolTable {
  /** class 名 → 定義所在的 .sem 相對路徑與行號（0-based） */
  classes: Map<string, { relPath: string; line: number }>;
  /** `class.func` → 定義位置 */
  methods: Map<string, { relPath: string; line: number }>;
  /** data 名 → 定義位置 */
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
 *   1. class 名全域唯一
 *   2. 禁止多載
 *   3. 連結必須指向存在的單元
 *
 * 這些是免費拿到的第一層驗證——完全不需要編譯器。
 */
export function lint(files: SemFile[]): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];

  // 1. class／data 名全域唯一
  for (const kind of ['classes', 'datas'] as const) {
    const seen = new Map<string, string>();
    const label = kind === 'classes' ? 'class' : 'data';
    for (const f of files) {
      for (const decl of f[kind]) {
        const prev = seen.get(decl.name);
        if (prev) {
          diags.push({
            relPath: f.relPath,
            line: decl.line - 1,
            severity: 'error',
            message: `${label}「${decl.name}」重複定義（已在 ${prev} 定義）。${label} 名必須全域唯一——這是 \`class.func\` 能被唯一定址的前提。若你開啟的資料夾含多個樣本，請改開單一樣本（例：samples/WarehouseShipping）。`,
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
            message: `func「${c.name}.${m.name}」在同一個 class 重複宣告（第 ${prev} 行已有）。v0 禁止多載——否則 \`class.func\` 無法唯一定址。`,
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

/**
 * 檢查斷鏈。
 *
 * ⚠️ 這裡**不跳過任何連結**。之前的版本對「沒有 `.` 的目標」直接 `continue`，
 * 造成靜默失敗——漏寫前綴不會有任何提示。連結是唯一的依賴宣告，
 * 靜默等於規格殘缺，所以一律檢查、一律報錯。
 */
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
      const known = symbols.methods.has(t) || symbols.classes.has(t) || symbols.datas.has(t);
      if (!known) {
        diags.push({
          relPath: f.relPath,
          line: link.line,
          severity: 'error',
          message: `斷鏈：找不到 \`${t}\` 的目標。連結必須是 \`class\` 或 \`class.func\`（class 名全域唯一，名稱需完全相符）。`,
        });
      }
    }
  }
  return diags;
}

const ASCII_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 識別字一律 ASCII。
 *
 * 偽代碼可以中文命名，但**程式碼不行**。中文識別字會讓 JSON 欄位名變中文、
 * 讓反射／ORM／analyzer 踩雷、讓工具鏈不保證支援——而且我們實測過，
 * 生成的檔案非得加 BOM 才編得過。
 *
 * 所以這條規則在**規格層**就擋掉，讓它永遠到不了 C#。
 * 中文請留在敘述、步驟與字串裡——那裡才是給人讀的地方。
 */
export function lintNames(files: SemFile[]): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const bad = (relPath: string, line: number, kind: string, name: string): void => {
    if (ASCII_NAME.test(name)) return;
    diags.push({
      relPath,
      line,
      severity: 'error',
      message: `${kind}名「${name}」不是 ASCII 識別字。偽代碼可以中文命名，但生成的程式碼不行——請改成英文，中文留在敘述裡。`,
    });
  };

  for (const f of files) {
    for (const d of f.datas) {
      bad(f.relPath, d.line - 1, 'data', d.name);
      for (const fl of d.fields) bad(f.relPath, d.line - 1, '欄位', fl.name);
    }
    for (const c of f.classes) {
      bad(f.relPath, c.line - 1, 'class', c.name);
      for (const fl of c.fields) bad(f.relPath, c.line - 1, '欄位', fl.name);
      for (const m of c.methods) {
        bad(f.relPath, m.line - 1, 'func', m.name);
        for (const p of m.params) bad(f.relPath, m.line - 1, '參數', p.name);
      }
    }
  }
  return diags;
}

/**
 * 未知型別在規格層就擋掉。
 *
 * 若放行到編譯器，它會變成生成檔裡的 `CS0246` —— 那不在 AI 的 action space 內
 * （型別是簽章的一部分，不在 body 裡），自我修復迴圈修不了，只是白燒重試次數。
 */
export function lintTypes(files: SemFile[], symbols: SymbolTable): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const known = (t: string): boolean => {
    const base = baseTypeName(t);
    return BCL_TYPES.has(base) || symbols.classes.has(base) || symbols.datas.has(base);
  };
  const check = (relPath: string, line: number, t: string, where: string): void => {
    if (known(t)) return;
    diags.push({
      relPath,
      line,
      severity: 'error',
      message: `未知型別「${t}」（${where}）。可用的是白名單（str／int／long／decimal／bool／date／void／list<T>）或本專案宣告的 class／data。`,
    });
  };

  for (const f of files) {
    for (const d of f.datas) {
      for (const fl of d.fields) check(f.relPath, d.line - 1, fl.type, `data ${d.name}`);
    }
    for (const c of f.classes) {
      for (const fl of c.fields.filter((x) => x.dependency)) {
        check(f.relPath, c.line - 1, fl.type, `class ${c.name} 的 requires`);
      }
      for (const m of c.methods) {
        for (const p of m.params) check(f.relPath, m.line - 1, p.type, `${c.name}.${m.name} 參數`);
        check(f.relPath, m.line - 1, m.returns, `${c.name}.${m.name} 回傳`);
      }
    }
  }
  return diags;
}

/**
 * 抓已經改掉的舊寫法——避免它們**靜默失效**。
 *
 * v0 的框架詞彙已經全面改成英文。舊的中文關鍵字在新 parser 下一個字都解析不到：
 * 方法會整條消失、指向它的連結全變斷鏈，而沒有任何訊息。所以一律當場報錯。
 */
export function lintStaleSyntax(files: SemFile[], reader: (relPath: string) => string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const STALE: [RegExp, string][] = [
    [/^\s*類別\s+\S+\s*\{$/, '類別'],
    [/^\s*資料\s+\S+\s*\{$/, '資料'],
    [/^\s*方法\s+\S+\s*[({]/, '方法'],
    [/^\s*契約\s*\{$/, '契約'],
    [/^\s*輸入\s*[:：]/, '輸入'],
    [/^\s*輸出\s*[:：]/, '輸出'],
  ];
  // 宣告的左大括號必須在行末。單行寫法（`func A { }`）在 v0 一個字都抓不到，
  // 方法會整條消失——這正是最貴的那種錯，所以也當場報錯。
  const INLINE: [RegExp, string][] = [
    [/^\s*(class|func|data)\s+\S+\s*\{.+$/, '宣告'],
    [/^\s*requires\s*\{.+$/, 'requires'],
  ];

  for (const f of files) {
    const lines = reader(f.relPath).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      let hit: string | null = null;
      for (const [re, word] of STALE) {
        if (re.test(lines[i])) {
          hit = `「${word}」是舊的寫法。v0 框架詞彙已全面改為英文：class／func／data／requires／in:／out:。用舊寫法會整條解析不到，不會有任何提示。`;
          break;
        }
      }
      if (!hit) {
        for (const [re] of INLINE) {
          if (re.test(lines[i])) {
            hit =
              '宣告的左大括號必須在行末。`func A { }` 這種單行寫法在 v0 不會被解析，整條內容會消失。請寫成多行：`func A {` … `}`。';
            break;
          }
        }
      }
      if (hit) diags.push({ relPath: f.relPath, line: i, severity: 'error', message: hit });
    }
  }
  return diags;
}

export function hasBlocking(diags: LintDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
