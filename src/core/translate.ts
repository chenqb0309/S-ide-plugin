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
    const body = MOCK_BODIES[key];
    if (!body) throw new Error(`MOCK 模式沒有 ${key} 的罐頭回應`);

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
};
