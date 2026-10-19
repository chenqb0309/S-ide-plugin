/**
 * 型別詞彙。
 *
 * 框架一律用英文的習慣寫法：`str` / `int` / `decimal` / `bool` / `date` / `void`。
 * 查不到的型別**原樣穿過**——那是自訂的 `class`／`data`。
 *
 * 這一支刻意獨立成一個模組（不放在 codegen，也不放在 lint），
 * 因為兩邊都需要它，而 codegen 已經反過來依賴 lint 的進入點常數——
 * 再加一條反向依賴就變成循環。
 */

const TYPE_ALIAS: Record<string, string> = {
  str: 'string',
  date: 'DateTime',
  boolean: 'bool',
  datetime: 'DateTime',
};

/** BCL 白名單：這些型別可以直接寫，不需要在 `.sem` 宣告。 */
export const BCL_TYPES = new Set([
  'string',
  'int',
  'long',
  'decimal',
  'double',
  'float',
  'bool',
  'void',
  'DateTime',
  'object',
  'Guid',
  'TimeSpan',
]);

export function mapType(t: string): string {
  const s = t.trim();
  const list = s.match(/^list<(.+)>$/i);
  if (list) return `List<${mapType(list[1])}>`;
  const nullable = s.match(/^(.+)\?$/);
  if (nullable) return `${mapType(nullable[1])}?`;
  return TYPE_ALIAS[s] ?? s;
}

/** 拆掉 `list<>` / `?` 之後的裸型別名，用來檢查它到底存不存在。 */
export function baseTypeName(t: string): string {
  const s = t.trim();
  const list = s.match(/^list<(.+)>$/i);
  if (list) return baseTypeName(list[1]);
  const nullable = s.match(/^(.+)\?$/);
  if (nullable) return baseTypeName(nullable[1]);
  return TYPE_ALIAS[s] ?? s;
}
