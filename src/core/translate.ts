import type { Method } from './types';
import { methodSignature } from './codegen';

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface TranslatorOptions extends AiConfig {
  /** 不呼叫 AI，改用罐頭回應，用來驗證管線本身 */
  mock?: boolean;
  /** 搭配 mock：前 N 次故意回傳壞掉的 body，驗證自我修復迴圈 */
  mockFail?: number;
}

export class Translator {
  private readonly calls = new Map<string, number>();

  constructor(private readonly opts: TranslatorOptions) {}

  get isMock(): boolean {
    return !!this.opts.mock || !this.opts.apiKey;
  }

  get label(): string {
    return this.isMock ? 'MOCK（未設定 API Key）' : `${this.opts.model} @ ${this.opts.baseUrl}`;
  }

  async body(m: Method, contextMap: string, hint?: string): Promise<string> {
    if (this.isMock) return this.mockBody(m);

    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt(contextMap) },
          { role: 'user', content: userPrompt(m, hint) },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`AI 呼叫失敗 ${res.status}：${(await res.text()).slice(0, 400)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return stripFence(data.choices?.[0]?.message?.content ?? '');
  }

  private mockBody(m: Method): string {
    const key = `${m.className}.${m.name}`;
    // 允許用 `<檔名>.sem:<類別>.<方法>` 覆寫——多個樣本工作區都以 `程式.主` 為入口
    const scoped = `${m.srcFile}:${key}`;
    const body = MOCK_BODIES[scoped] ?? MOCK_BODIES[key];
    if (!body) throw new Error(`MOCK 模式沒有 ${scoped} 的罐頭回應`);

    if (this.opts.mockFail) {
      const n = (this.calls.get(key) ?? 0) + 1;
      this.calls.set(key, n);
      if (n <= this.opts.mockFail) return 'return "型別錯誤";';
    }
    return body;
  }
}

function systemPrompt(contextMap: string): string {
  return [
    '你是 S-IDE 語義編譯器。把結構化規格中的「方法實作描述」轉譯為 C#。',
    '規格中的識別字（類別／方法／參數／欄位）已經是英文，直接沿用，不要改名。',
    '',
    '【輸出格式】',
    '1. 只輸出方法 body 的 C# 敘述。不要輸出 class、方法簽章、或外層大括號。',
    '2. 不要有任何 markdown 標記（```），不要有任何前後說明文字。',
    '',
    '【硬約束】',
    '3. 只能使用下方「可用型別」與「可用前導庫」列出的成員。',
    '   絕對不要發明新的型別、欄位、方法或套件——它們不存在，而且你沒有能力新增它們。',
    '4. 除此之外只能使用 BCL（System.*）。',
    '',
    '【基礎設施注入】',
    '5. 規格中的每個 `步驟 "說明"`，在對應位置生成 Telemetry.Step("說明")。字串原文照抄，不要翻譯。',
    '6. `requires` 宣告的協作者，harness 已經注入成欄位（欄位名 = 類別名）。',
    '   直接使用它們，例如 `AuditLog.Write("...")`；**絕對不要自己 new**。',
    '',
    '【可用型別】',
    contextMap,
    '',
    '【可用前導庫】',
    'Telemetry.Step(string message)   // 業務時序鏈標記',
    'SemanticSource(string srcFile, int line)  // 已由 harness 注入，不要自己寫',
    '',
    '【編譯目標】.NET 10 / C#；命名空間 SemanticBackend',
  ].join('\n');
}

function userPrompt(m: Method, hint?: string): string {
  const parts = [`方法簽章：${methodSignature(m)}`, '', '.sem 實作描述：', '```sem', m.bodyText, '```'];
  if (hint) parts.push('', '【上次編譯失敗，請修正】', hint);
  return parts.join('\n');
}

/** 防禦性移除 markdown fence——即使 prompt 已經要求不要用。 */
export function stripFence(text: string): string {
  let s = String(text).trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) s = fenced[1];
  return s
    .split(/\r?\n/)
    .filter((l) => !/^\s*```/.test(l))
    .join('\n')
    .trim();
}

// ── MOCK 罐頭回應（只給示範樣本用） ────────────────────────────────────────
// 識別字一律英文——它們就是 C# 的識別字。中文只留在敘述與日誌字串裡。
const MOCK_BODIES: Record<string, string> = {
  'PalletStacker.sem:PalletStacker.BoxesPerLayer': [
    'Telemetry.Step("判斷重量級距");',
    'if (spec.Weight > 15m)',
    '{',
    '    return 4;',
    '}',
    'return 8;',
  ].join('\n'),

  'PalletStacker.sem:PalletStacker.LayersFor': [
    'Telemetry.Step("計算層數");',
    'return palletHeight / spec.Height;',
  ].join('\n'),

  'PalletStacker.sem:App.Main': [
    'Telemetry.Step("建立樣本");',
    'var spec = new BoxSpec { Weight = 18m, Length = 400, Width = 300, Height = 250 };',
    'var stacker = new PalletStacker();',
    'Telemetry.Step("計算單層箱數");',
    'var boxes = stacker.BoxesPerLayer(spec);',
    'Telemetry.Step("計算可堆疊層數");',
    'var layers = stacker.LayersFor(spec, 1800);',
    'Console.WriteLine($"單層箱數   = {boxes}");',
    'Console.WriteLine($"可堆疊層數 = {layers}");',
  ].join('\n'),

  // ── 重量級樣本 samples/WarehouseShipping（離線驗證 harness，不含 AI） ──────
  'WarehouseShipping.sem:AuditLog.Write': [
    'Telemetry.Step("輸出稽核訊息");',
    'Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");',
  ].join('\n'),

  'WarehouseShipping.sem:ShippingFeeCalculator.CalculateFee': [
    'Telemetry.Step("免運門檻");',
    'if (order.TotalAmount >= 1000m)',
    '{',
    '    return 0m;',
    '}',
    '',
    'Telemetry.Step("依區域分級計價");',
    'decimal perKg = order.Region switch',
    '{',
    '    "北部" => 30m,',
    '    "中部" => 35m,',
    '    "南部" => 40m,',
    '    _ => 50m,',
    '};',
    'decimal minCharge = order.Region switch',
    '{',
    '    "北部" => 100m,',
    '    "中部" => 120m,',
    '    "南部" => 150m,',
    '    _ => 150m,',
    '};',
    'decimal fee = Math.Max(order.WeightKg * perKg, minCharge);',
    '',
    'Telemetry.Step("偏遠地區加成");',
    'if (order.Remote)',
    '{',
    '    fee += 200m;',
    '}',
    '',
    'Telemetry.Step("超重加成");',
    'if (order.WeightKg > 20m)',
    '{',
    '    fee += (order.WeightKg - 20m) * 10m;',
    '}',
    '',
    'Telemetry.Step("記錄試算");',
    'AuditLog.Write($"{order.OrderNo} 運費 {fee}");',
    '',
    'return fee;',
  ].join('\n'),

  'WarehouseShipping.sem:InventoryService.HasStock': [
    'Telemetry.Step("檢查庫存量");',
    'if (order.WeightKg > 500m)',
    '{',
    '    return false;',
    '}',
    'return true;',
  ].join('\n'),

  'WarehouseShipping.sem:ShippingService.Ship': [
    'Telemetry.Step("檢查庫存");',
    'if (!InventoryService.HasStock(order))',
    '{',
    '    return $"{order.OrderNo} 庫存不足";',
    '}',
    '',
    'Telemetry.Step("計算運費");',
    'var fee = ShippingFeeCalculator.CalculateFee(order);',
    '',
    'Telemetry.Step("產出出貨單");',
    'var note = $"{order.OrderNo} 運費 {fee} 總金額 {order.TotalAmount}";',
    '',
    'Telemetry.Step("記錄出貨");',
    'AuditLog.Write(note);',
    '',
    'return note;',
  ].join('\n'),

  'WarehouseShipping.sem:App.Main': [
    'Telemetry.Step("第一張：北部、已達免運門檻");',
    'var order1 = new Order { OrderNo = "A001", Region = "北部", TotalAmount = 1200m, WeightKg = 18m, Remote = false };',
    'var shipping = new ShippingService();',
    'Console.WriteLine(shipping.Ship(order1));',
    '',
    'Telemetry.Step("第二張：南部、偏遠、超重");',
    'var order2 = new Order { OrderNo = "A002", Region = "南部", TotalAmount = 500m, WeightKg = 26m, Remote = true };',
    'Console.WriteLine(shipping.Ship(order2));',
    '',
    'Telemetry.Step("第三張：庫存不足");',
    'var order3 = new Order { OrderNo = "A003", Region = "北部", TotalAmount = 800m, WeightKg = 700m, Remote = false };',
    'Console.WriteLine(shipping.Ship(order3));',
  ].join('\n'),
};
