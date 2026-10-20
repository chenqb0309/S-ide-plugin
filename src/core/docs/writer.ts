import type { ProseMap } from './types';
import { aiError, aiHeaders, chatUrl } from '../ai';

export interface DocAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ProseItem {
  id: string;
  signature: string;
  code: string;
}

export interface ProseResult {
  prose: ProseMap;
  /** 重試到底仍然拿不到說明的節點。呼叫端要把它當成「明確的缺口」報出來。 */
  failed: string[];
}

const MAX_CODE_CHARS = 1800;
const MAX_ITEMS_PER_CALL = 8;
const MAX_DEPTH = 2; // 8 → 4 → 2 → 1
const MAX_TOKENS = 4096;

/**
 * 只有「這一步」需要 AI：把 code 翻成一句業務說明。
 * 連結、anchor、排版全部由程式產生，AI 碰不到——所以它錯了也只錯一句話。
 *
 * 供應商偶爾會回空內容（思考吃光 token、格式偏差、純粹抽風），
 * 所以策略是：整批失敗就對半切、逐層縮小。最後仍拿不到的節點回報給呼叫端，
 * 讓它成為「看得見的缺口」，而不是安靜的空區塊。
 */
export async function writeProse(
  cfg: DocAiConfig,
  items: readonly ProseItem[],
  log?: (line: string) => void,
): Promise<ProseResult> {
  if (!cfg.apiKey || !cfg.model) throw new Error('尚未設定 API Key 或模型，無法產生說明');

  const prose: ProseMap = new Map();
  const failed: string[] = [];
  if (!items.length) return { prose, failed };

  let reported = 0;

  const run = async (batch: readonly ProseItem[], depth: number): Promise<void> => {
    if (!batch.length) return;

    try {
      const { data, raw, meta } = await callOnce(cfg, batch);
      const missing: ProseItem[] = [];

      for (const item of batch) {
        const value = normalizeValue(data[item.id]);
        if (value) prose.set(item.id, value);
        else missing.push(item);
      }

      if (!missing.length) return;

      // 只留前幾筆，避免把 Output 灌爆；這幾筆就足以判斷原因
      if (missing.length === batch.length && reported < 3) {
        reported += 1;
        log?.(
          `  ⚠️  ${batch.length} 個節點拿不到說明 | ${meta} | body: ${raw.slice(0, 200).replace(/\s+/g, ' ')}`,
        );
      }

      if (depth < MAX_DEPTH && batch.length > 1) {
        const mid = Math.ceil(missing.length / 2);
        await run(missing.slice(0, mid), depth + 1);
        await run(missing.slice(mid), depth + 1);
        return;
      }

      for (const item of missing) failed.push(item.id);
    } catch (e) {
      const message = (e as Error).message;
      if (depth < MAX_DEPTH && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await run(batch.slice(0, mid), depth + 1);
        await run(batch.slice(mid), depth + 1);
        return;
      }
      if (reported < 3) {
        reported += 1;
        log?.(`  ⚠️  請求失敗（${batch.length} 個節點）：${message.slice(0, 300)}`);
      }
      for (const item of batch) failed.push(item.id);
    }
  };

  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    await run(items.slice(i, i + MAX_ITEMS_PER_CALL), 0);
  }

  // 一句都沒拿到＝這次等於沒做事。不要寫出「有結構、沒說明」的文件。
  if (prose.size === 0) {
    throw new Error('AI 沒有產生任何說明（模型回傳空結果），已中止同步。詳見上方診斷。');
  }

  return { prose, failed };
}

interface CallResult {
  data: Record<string, string | string[]>;
  raw: string;
  /** 給 log 用的一行摘要：finish_reason + usage */
  meta: string;
}

async function callOnce(cfg: DocAiConfig, batch: readonly ProseItem[]): Promise<CallResult> {
  const payload = batch.map((item) => ({
    id: item.id,
    signature: item.signature,
    code: item.code.slice(0, MAX_CODE_CHARS),
  }));

  const res = await fetch(chatUrl(cfg.baseUrl), {
    method: 'POST',
    headers: aiHeaders(cfg.apiKey),
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content: [
            '你是資深工程師，把 C# 濃縮成「人類看得懂的偽代碼」。',
            '',
            '【形狀】',
            'A. 有邏輯的方法 → 輸出字串陣列，每項是一個步驟（最多 7 步）。',
            '   依執行順序排列；條件、計算、提早返回、寫入、丟例外都要寫成一步。',
            'B. 只有單一動作（getter、單純轉發）→ 輸出一句話字串。',
            'C. property → 一句話說明它的業務意義，不要寫「取得或設定」。',
            '',
            '【規則】',
            '1. 繁體中文，每個步驟 40 字以內。',
            '2. 必須寫出具體門檻、數量、比例（例如「滿 1000 元免運」）。',
            '3. 不要描述語法（if/foreach/變數宣告），要寫業務行為。',
            '4. 不要重述參數與回傳型別，不要提 class 名稱。',
            '5. 只寫程式碼裡確實存在的規則，不要推測、不要補充。',
            '6. 不要 markdown 標記、不要編號前綴（1. 2.），系統會自己加。',
            '',
            '【輸出】',
            '只輸出 JSON 物件，鍵是 id，值是字串或字串陣列。必須包含每一個 id。',
            '格式：{"id":"一句話"} 或 {"id":["步驟一","步驟二"]}',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });

  if (!res.ok) throw new Error(await aiError(res));

  const body = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; reasoning_content?: string | null };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  const choice = body.choices?.[0];
  // 有些推理模型把答案放在 reasoning_content，content 會是空的
  const raw = (choice?.message?.content || choice?.message?.reasoning_content || '').trim();
  const meta = [
    `finish=${choice?.finish_reason ?? '?'}`,
    `completion=${body.usage?.completion_tokens ?? '?'}`,
    `reasoning=${body.usage?.completion_tokens_details?.reasoning_tokens ?? '-'}`,
    `chars=${raw.length}`,
  ].join(' ');

  return { data: parseProse(raw), raw, meta };
}

/**
 * 模型不一定會乖乖給 `{id: text}`。這裡容忍三種常見變形：
 *   - 物件：{"id":"說明"} 或 {"id":["步驟一","步驟二"]}
 *   - 陣列：[{"id":"...","text":"..."}]
 *   - 包一層：{"items":[...]} / {"data":[...]} / {"result":{...}}
 */
function parseProse(text: string): Record<string, string | string[]> {
  const start = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const from = start < 0 ? arrStart : arrStart < 0 ? start : Math.min(start, arrStart);
  if (from < 0) return {};

  const isArray = from === arrStart;
  const end = isArray ? text.lastIndexOf(']') : text.lastIndexOf('}');
  if (end <= from) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(from, end + 1));
  } catch {
    return {};
  }

  const out: Record<string, string | string[]> = {};

  const take = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) take(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const id = record.id ?? record.key ?? record.name;
    const value2 =
      record.steps ?? record.text ?? record.value ?? record.prose ?? record.description ?? record.summary;
    if (typeof id === 'string') {
      const normalized = normalizeValue(value2);
      if (normalized) {
        out[id] = normalized;
        return;
      }
    }
    for (const key of ['items', 'data', 'result', 'results', 'nodes']) {
      if (key in record) take(record[key]);
    }
    for (const [key, text] of Object.entries(record)) {
      const normalized = normalizeValue(text);
      if (normalized) out[key] = normalized;
    }
  };

  take(parsed);
  return out;
}

/** 把任意形狀壓成「字串」或「字串陣列」；空的回 undefined。 */
function normalizeValue(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const steps = value.map((v) => String(v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return steps.length ? steps : undefined;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || undefined;
  }
  return undefined;
}
