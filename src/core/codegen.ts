import type { ClassDecl, DataDecl, Method, SemFile, Unit } from './types';
import { normalize } from './parse';
import { ENTRY_CLASS, ENTRY_METHOD } from './lint';

export const NAMESPACE = 'SemanticBackend';

// ── 型別對映 ────────────────────────────────────────────────────────────────
const TYPE_MAP: Record<string, string> = {
  字串: 'string',
  整數: 'int',
  長整數: 'long',
  小數: 'decimal',
  布林: 'bool',
  日期: 'DateTime',
  空: 'void',
};

export function mapType(t: string): string {
  const s = t.trim();
  const list = s.match(/^清單<(.+)>$/);
  if (list) return `List<${mapType(list[1])}>`;
  const nullable = s.match(/^可空<(.+)>$/);
  if (nullable) return `${mapType(nullable[1])}?`;
  return TYPE_MAP[s] ?? s;
}

export function methodSignature(m: Method): string {
  const params = m.params.map((p) => `${mapType(p.type)} ${p.name}`).join(', ');
  return `${mapType(m.returns)} ${m.name}(${params})`;
}

// ── 契約文字（進簽章索引與 cache key） ──────────────────────────────────────
export const dtoContract = (d: DataDecl): string =>
  `資料 ${d.name} { ${d.fields.map((f) => `${f.type} ${f.name}`).join('; ')} }`;

export const depsContract = (c: ClassDecl): string =>
  `類別 ${c.name} 契約 { ${c.fields.map((f) => `${f.type} ${f.name}`).join('; ')} }`;

export const sigOf = (m: Method): string =>
  `方法 ${m.className}.${m.name}(${m.params.map((p) => `${p.type} ${p.name}`).join(', ')}) : ${m.returns}`;

// ── 單元切割 ────────────────────────────────────────────────────────────────
export function planUnits(files: SemFile[]): Unit[] {
  const units: Unit[] = [];
  for (const f of files) {
    for (const d of f.datas) {
      units.push({
        key: `資料 ${d.name}`,
        kind: 'dto',
        file: `${d.name}.g.cs`,
        contract: dtoContract(d),
        body: '',
        srcFile: d.srcFile,
        line: d.line,
        dto: d,
      });
    }
    for (const c of f.classes) {
      units.push({
        key: `契約 ${c.name}`,
        kind: 'fields',
        file: `${c.name}.Fields.g.cs`,
        contract: depsContract(c),
        body: '',
        srcFile: c.srcFile,
        line: c.line,
        cls: c,
      });
      for (const m of c.methods) {
        units.push({
          key: `${m.className}.${m.name}`,
          kind: 'method',
          file: `${m.className}.${m.name}.g.cs`,
          contract: sigOf(m),
          body: normalize(m.bodyText),
          srcFile: m.srcFile,
          line: m.line,
          method: m,
        });
      }
    }
  }
  return units;
}

/** 簽章索引版本：任一簽章／型別／欄位變動 → 全專案失效（保守策略） */
export function signatureIndexText(files: SemFile[], units: Unit[]): string {
  const lines: string[] = [
    ...files.flatMap((f) => f.datas.map(dtoContract)),
    ...files.flatMap((f) => f.classes.map(depsContract)),
    ...units.filter((u) => u.kind === 'method').map((u) => u.contract),
  ];
  return lines.sort().join('\n');
}

// ── 生成：harness 負責的部分 ────────────────────────────────────────────────
export function genDto(d: DataDecl): string {
  const props = d.fields.map((f) => `    public ${mapType(f.type)} ${f.name} { get; set; }`).join('\n');
  return [
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    `[SemanticSource("${d.srcFile}", ${d.line})]`,
    `public class ${d.name}`,
    '{',
    props || '    // 無欄位',
    '}',
    '',
  ].join('\n');
}

/**
 * `契約` → 真實欄位。
 *
 * 這一段是「基礎設施注入」的核心：`.sem` 只寫 `使用 稽核日誌 稽核`，
 * 欄位與實例由 harness 生成。AI 只能「使用」，不能「發明」——
 * 所以 `稽核.記錄(...)` 這種引用保證編得過，自我修復迴圈不會死在
 * 「欄位不存在」這種它根本修不了的錯誤上（見 docs/02-prelude-v0.md）。
 */
export function genClassSkeleton(c: ClassDecl): string {
  const deps = c.fields
    .filter((f) => f.dependency)
    .map((f) => `    private readonly ${mapType(f.type)} ${f.name} = new ${mapType(f.type)}();`)
    .join('\n');
  return [
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    `public partial class ${c.name}`,
    '{',
    deps || '    // 契約為空',
    '}',
    '',
  ].join('\n');
}

/** AI 只提供 `body`；namespace / using / partial class / attribute / 簽章全部由 harness 注入。 */
export function genMethodFile(m: Method, body: string): string {
  const params = m.params.map((p) => `${mapType(p.type)} ${p.name}`).join(', ');
  const indented = body
    .trim()
    .split('\n')
    .map((l) => '        ' + l)
    .join('\n');
  return [
    'using SIDE.Prelude;',
    '',
    `namespace ${NAMESPACE};`,
    '',
    `public partial class ${m.className}`,
    '{',
    `    [SemanticSource("${m.srcFile}", ${m.line})]`,
    `    public ${mapType(m.returns)} ${m.name}(${params})`,
    '    {',
    indented,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** 入口是機械生成的，不交給 AI。 */
export function genProgramCs(files: SemFile[]): string {
  const hasEntry = files.some(
    (f) =>
      f.classes.some((c) => c.name === ENTRY_CLASS) &&
      f.classes.some((c) => c.name === ENTRY_CLASS && c.methods.some((m) => m.name === ENTRY_METHOD && m.params.length === 0)),
  );

  if (!hasEntry) {
    return [
      '// 由 S-IDE 生成。請勿手動編輯。',
      'Console.OutputEncoding = System.Text.Encoding.UTF8;',
      'Console.WriteLine("未定義進入點。請在 .sem 中宣告：");',
      `Console.WriteLine("    類別 ${ENTRY_CLASS} { 方法 ${ENTRY_METHOD}() { ... } }");`,
      '',
    ].join('\n');
  }

  return [
    '// 由 S-IDE 生成。請勿手動編輯。',
    'using SemanticBackend;',
    'using SIDE.Prelude;',
    '',
    'Console.OutputEncoding = System.Text.Encoding.UTF8;',
    '',
    'Telemetry.Step("程式啟動");',
    '',
    `var 入口 = new ${ENTRY_CLASS}();`,
    `入口.${ENTRY_METHOD}();`,
    '',
  ].join('\n');
}

/** 讓 AI 看見的全域護欄（context map 的給 AI 版本） */
export function contextMapForPrompt(files: SemFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    for (const d of f.datas) {
      lines.push(`${d.name}: ${d.fields.map((x) => `${mapType(x.type)} ${x.name}`).join(', ')}`);
    }
    for (const c of f.classes) {
      // 契約必須讓 AI 看見，否則它不知道協作者的欄位名，只能自己發明 → CS0103
      const deps = c.fields
        .filter((x) => x.dependency)
        .map((x) => `  契約欄位 ${mapType(x.type)} ${x.name}`)
        .join('\n');
      const methods = c.methods.map((m) => `  ${methodSignature(m)}`).join('\n');
      lines.push(`class ${c.name} {\n${deps ? `${deps}\n` : ''}${methods}\n}`);
    }
  }
  return lines.join('\n');
}
