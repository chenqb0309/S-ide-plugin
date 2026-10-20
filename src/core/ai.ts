/**
 * OpenAI 相容呼叫的共用細節。
 *
 * 這裡放的是「所有供應商都吃、但某些供應商必需」的東西：
 * - `x-opencode-session`：OpenCode Go 用它做路由，缺了直接 400 MissingSessionID
 * - `User-Agent`：表明身分，不要用 Node 內建的通用 UA
 *
 * 其他供應商（OpenAI、DeepSeek、Ollama）多收這兩個 header 不會有副作用，
 * 所以不做條件判斷——少一個分支就少一個出錯的地方。
 */

export const AI_CLIENT_VERSION = '0.1.0';

/** 一個 process 一個 session id；同一輪同步的所有批次共用，讓供應商能做 prompt cache。 */
export const AI_SESSION_ID = `s-ide-plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

export function aiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': `s-ide-plugin/${AI_CLIENT_VERSION}`,
    'x-opencode-session': AI_SESSION_ID,
  };
}

interface TextResponse {
  status: number;
  text(): Promise<string>;
}

/** 把 HTTP 錯誤變成看得懂的字：狀態碼 + 供應商回傳的內容（截斷）。 */
export async function aiError(res: TextResponse): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    /* 讀不到 body 就只報狀態碼 */
  }
  return body ? `HTTP ${res.status}：${body}` : `HTTP ${res.status}`;
}
