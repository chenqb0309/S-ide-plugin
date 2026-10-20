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

const MAX_CODE_CHARS = 1800;
const MAX_ITEMS_PER_CALL = 12;

/**
 * 只有「這一步」需要 AI：把 code 翻成一句業務說明。
 * 連結、anchor、排版全部由程式產生，AI 碰不到——所以它錯了也只錯一句話。
 */
export async function writeProse(cfg: DocAiConfig, items: readonly ProseItem[]): Promise<ProseMap> {
  if (!cfg.apiKey || !cfg.model) throw new Error('尚未設定 API Key 或模型，無法產生說明');
  const result: ProseMap = new Map();
  if (!items.length) return result;

  let failures = 0;
  let lastError = '';
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    const batch = items.slice(i, i + MAX_ITEMS_PER_CALL);
    try {
      const body = await callOnce(cfg, batch);
      for (const [id, text] of Object.entries(body)) {
        const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
        if (clean) result.set(id, clean);
      }
    } catch (e) {
      failures += 1;
      lastError = (e as Error).message;
    }
  }

  // 一句都沒拿到＝這次等於沒做事。不要寫出「有結構、沒說明」的文件。
  if (result.size === 0) {
    const why = failures > 0 ? `${failures} 批請求失敗：${lastError}` : '模型回傳空結果';
    throw new Error(`AI 沒有產生任何說明（${why}），已中止同步。`);
  }

  return result;
}

async function callOnce(cfg: DocAiConfig, batch: readonly ProseItem[]): Promise<Record<string, string>> {
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
      messages: [
        {
          role: 'system',
          content: [
            '你是資深工程師，負責把 C# 程式碼濃縮成一句「業務上在做什麼」。',
            '',
            '【規則】',
            '1. 每個 id 輸出一句繁體中文，40 字以內。',
            '2. 只描述業務意圖與關鍵條件，不要描述語法（不要說「使用 foreach」「宣告變數」）。',
            '3. 不要提到 class 名稱，看的人已經在該區塊裡了。',
            '4. 純查詢/取值就直說「取得 X」；有分支就寫出條件。',
            '',
            '【輸出】',
            '只輸出 JSON 物件，鍵是 id、值是句子。不要 markdown、不要解釋。',
            '格式：{"id":"說明"}',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });

  if (!res.ok) throw new Error(await aiError(res));

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return parseJsonObject(text);
}

function parseJsonObject(text: string): Record<string, string> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    /* 模型偶爾會多包一層 markdown，失敗就當這批沒有結果 */
  }
  return {};
}
