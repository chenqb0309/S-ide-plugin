import type { Method } from './types';
import { methodSignature } from './codegen';
import { aiError, aiHeaders, chatUrl } from './ai';

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

    const res = await fetch(chatUrl(this.opts.baseUrl), {
      method: 'POST',
      headers: aiHeaders(this.opts.apiKey),
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
      throw new Error(`AI 呼叫失敗 ${await aiError(res)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return stripFence(data.choices?.[0]?.message?.content ?? '');
  }

  private mockBody(m: Method): string {
    const key = `${m.className}.${m.name}`;
    // 允許用 `<檔名>.sem:<class>.<func>` 覆寫——多個樣本工作區都以 `App.Main` 為入口
    const scoped = `${m.srcFile}:${key}`;
    const body = MOCK_BODIES[scoped] ?? MOCK_BODIES[key];
    if (!body) throw new Error(`找不到 ${scoped} 的離線回應。請設定 API Key 與 side.model 後再執行。`);

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
    '規格中的識別字（class／func／參數／欄位）已經是英文，直接沿用，不要改名。',
    '',
    '【輸出格式】',
    '1. 只輸出 func body 的 C# 敘述。不要輸出 class、func 簽章、或外層大括號。',
    '2. 不要有任何 markdown 標記（```），不要有任何前後說明文字。',
    '',
    '【硬約束】',
    '3. 只能使用下方「可用型別」與「可用前導庫」列出的成員。',
    '   絕對不要發明新的型別、欄位、方法或套件——它們不存在，而且你沒有能力新增它們。',
    '4. 除此之外只能使用 BCL（System.*）。',
    '',
    '【基礎設施注入】',
    '5. 規格中的每個 `步驟 "說明"`，在對應位置生成 Telemetry.Step("說明")。字串原文照抄，不要翻譯。',
    '6. `requires` 宣告的協作者，harness 已經注入成欄位（欄位名 = class 名）。',
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

// ── MOCK 罐頭回應 ──────────────────────────────────────────────────────────
// 樣本已移出本 repo，這裡不再內建任何 body。
// 沒有 API Key 時直接報錯，而不是產出看起來能跑、其實是假的程式碼。
const MOCK_BODIES: Record<string, string> = {};
