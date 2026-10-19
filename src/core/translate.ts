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
    '你是 S-IDE 語義編譯器。把結構化中文規格中的「方法實作描述」轉譯為 C#。',
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
    '5. 規格中的每個 `步驟 "說明"`，在對應位置生成 Telemetry.Step("說明")。',
    '6. `契約` 宣告的協作者，harness 已經注入成欄位（欄位名 = 類別名）。',
    '   直接使用它們，例如 `庫存服務.檢查庫存(單)`；**絕對不要自己 new**。',
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
const MOCK_BODIES: Record<string, string> = {
  '棧板堆疊器.計算單層箱數': [
    'if (規格.重量 > 15m)',
    '{',
    '    return 4;',
    '}',
    'return 8;',
  ].join('\n'),

  '棧板堆疊器.計算可堆疊層數': 'return 棧板高度 / 規格.高;',

  '程式.主': [
    'Telemetry.Step("建立樣本");',
    'var 規格 = new 箱規格 { 重量 = 18m, 長 = 400, 寬 = 300, 高 = 250 };',
    'var 堆疊器 = new 棧板堆疊器();',
    'Telemetry.Step("計算單層箱數");',
    'var 單層 = 堆疊器.計算單層箱數(規格);',
    'Telemetry.Step("計算可堆疊層數");',
    'var 層數 = 堆疊器.計算可堆疊層數(規格, 1800);',
    'Console.WriteLine($"單層箱數   = {單層}");',
    'Console.WriteLine($"可堆疊層數 = {層數}");',
  ].join('\n'),

  // ── 重量級樣本 samples/倉儲出貨（用來離線驗證 harness，不含 AI） ──────────
  '稽核日誌.記錄': [
    'Telemetry.Step("輸出稽核訊息");',
    'Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {訊息}");',
  ].join('\n'),

  '運費計算器.計算運費': [
    'Telemetry.Step("免運門檻");',
    'if (單.總金額 >= 1000m)',
    '{',
    '    return 0m;',
    '}',
    '',
    'Telemetry.Step("依區域分級計價");',
    'decimal 每公斤 = 單.配送區域 switch',
    '{',
    '    "北部" => 30m,',
    '    "中部" => 35m,',
    '    "南部" => 40m,',
    '    _ => 50m,',
    '};',
    'decimal 最低收費 = 單.配送區域 switch',
    '{',
    '    "北部" => 100m,',
    '    "中部" => 120m,',
    '    "南部" => 150m,',
    '    _ => 150m,',
    '};',
    'decimal 運費 = Math.Max(單.重量公斤 * 每公斤, 最低收費);',
    '',
    'Telemetry.Step("偏遠地區加成");',
    'if (單.偏遠地區)',
    '{',
    '    運費 += 200m;',
    '}',
    '',
    'Telemetry.Step("超重加成");',
    'if (單.重量公斤 > 20m)',
    '{',
    '    運費 += (單.重量公斤 - 20m) * 10m;',
    '}',
    '',
    'Telemetry.Step("記錄試算");',
    '稽核日誌.記錄($"{單.單號} 運費 {運費}");',
    '',
    'return 運費;',
  ].join('\n'),

  '庫存服務.檢查庫存': [
    'Telemetry.Step("檢查庫存量");',
    'if (單.重量公斤 > 500m)',
    '{',
    '    return false;',
    '}',
    'return true;',
  ].join('\n'),

  '出貨服務.出貨': [
    'Telemetry.Step("檢查庫存");',
    'if (!庫存服務.檢查庫存(單))',
    '{',
    '    return $"{單.單號} 庫存不足";',
    '}',
    '',
    'Telemetry.Step("計算運費");',
    'var 運費 = 運費計算器.計算運費(單);',
    '',
    'Telemetry.Step("產出出貨單");',
    'var 出貨單文字 = $"{單.單號} 運費 {運費} 總金額 {單.總金額}";',
    '',
    'Telemetry.Step("記錄出貨");',
    '稽核日誌.記錄(出貨單文字);',
    '',
    'return 出貨單文字;',
  ].join('\n'),

  '倉儲出貨.sem:程式.主': [
    'Telemetry.Step("第一張：北部、已達免運門檻");',
    'var 單1 = new 訂單 { 單號 = "A001", 配送區域 = "北部", 總金額 = 1200m, 重量公斤 = 18m, 偏遠地區 = false };',
    'var 出貨 = new 出貨服務();',
    'Console.WriteLine(出貨.出貨(單1));',
    '',
    'Telemetry.Step("第二張：南部、偏遠、超重");',
    'var 單2 = new 訂單 { 單號 = "A002", 配送區域 = "南部", 總金額 = 500m, 重量公斤 = 26m, 偏遠地區 = true };',
    'Console.WriteLine(出貨.出貨(單2));',
    '',
    'Telemetry.Step("第三張：庫存不足");',
    'var 單3 = new 訂單 { 單號 = "A003", 配送區域 = "北部", 總金額 = 800m, 重量公斤 = 700m, 偏遠地區 = false };',
    'Console.WriteLine(出貨.出貨(單3));',
  ].join('\n'),
};
