/**
 * Anchor id 規則。
 *
 * 只允許 `[a-z0-9-]`：Markdown 連結 `[x](#id)` 內的括號與逗號會破壞解析，
 * 所以簽章裡的參數型別要壓成 dash 分隔。id 由名稱推導，不落地、不查表。
 */

export function slug(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 把 C# 型別壓成 id 片段：`List<Order>` → `list-order`、`Order?` → `order` */
export function typeSlug(type: string): string {
  return slug(type.replace(/[<>[\]?*(),]/g, ' '));
}

/** method / property 的 anchor id。重載靠參數型別區分。 */
export function memberId(className: string, name: string, paramTypes: readonly string[]): string {
  const base = `${slug(className)}-${slug(name)}`;
  const params = paramTypes.map(typeSlug).filter(Boolean);
  return params.length ? `${base}-${params.join('-')}` : base;
}

/** class 的 anchor id。 */
export function classAnchor(className: string): string {
  return slug(className);
}

/**
 * 從 `detail`（例如 `decimal CalculateFee(Order order, bool remote)`）抽參數型別。
 * 抽不到就回空陣列——寧可讓重載撞 id，也不要瞎猜。
 */
export function paramTypesOf(detail: string | undefined): string[] {
  if (!detail) return [];
  const open = detail.indexOf('(');
  const close = detail.lastIndexOf(')');
  if (open < 0 || close <= open) return [];

  const inside = detail.slice(open + 1, close).trim();
  if (!inside) return [];

  return splitTopLevel(inside)
    .map((part) => {
      const noDefault = part.split('=')[0].trim();
      // 去掉參數名，只留型別：`Order order` → `Order`
      const pieces = noDefault.split(/\s+/);
      return pieces.length > 1 ? pieces.slice(0, -1).join(' ') : noDefault;
    })
    .filter(Boolean);
}

/** 逗號切分，但忽略泛型 `<...>` 內的逗號。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}
