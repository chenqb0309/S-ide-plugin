/** 從 DocumentSymbol 的字串推導出文件上要用的名稱與型別。純字串處理，可單元測試。 */

/** `Foo(int) : void` → `Foo`；`Name : string` → `Name` */
export function bareName(raw: string): string {
  const noParams = raw.split('(')[0];
  return noParams.split(' : ')[0].trim() || raw.trim();
}

/** `Name : string` → `string`；抓不到就回空字串 */
export function typeOf(raw: string): string {
  const idx = raw.indexOf(' : ');
  return idx >= 0 ? raw.slice(idx + 3).trim() : '';
}

/** 標題裡的型別不能帶泛型：`List<Product>` 的 `<` `>` 會被 Markdown 當成 HTML。 */
export function clampType(type: string): string {
  return type.replace(/<[^<>]*>/g, '').replace(/\[\]/g, '').trim() || type;
}

/**
 * 只有 `{ get; set; }` 這類 auto-property 才算「簡單」。
 * 有 body、有 `=>`、或 getter 內有邏輯的一律保留（那才是業務語義）。
 */
export function isTrivialProperty(code: string): boolean {
  const open = code.indexOf('{');
  const close = code.lastIndexOf('}');
  if (open < 0 || close <= open) return false;
  const body = code
    .slice(open + 1, close)
    .replace(/\s+/g, ' ')
    .trim();
  return /^get;(?: (?:(?:public|private|protected|internal) )?(?:(?:set|init);)?)?$/.test(body);
}
