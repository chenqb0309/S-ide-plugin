import * as vscode from 'vscode';
import * as ai from '../core/ai';

/**
 * 設定界面：供應商／模型／API Key／文件目錄，外加「測試連線」。
 *
 * 抽成 Webview 的理由只有一個：測試連線。事後翻 Output 猜 401 太慢。
 */

const KEY_SECRET = 'side.apiKey';

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  opencode: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'glm-5.3-flash' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
};

export async function openSettingsPanel(
  context: vscode.ExtensionContext,
  onSaved: () => void,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('side');
  const hasKey = !!(await context.secrets.get(KEY_SECRET));

  const panel = vscode.window.createWebviewPanel('side.settings', 'S-IDE 設定', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  panel.webview.html = renderHtml(nonce, {
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: cfg.get<string>('model', ''),
    docsDir: cfg.get<string>('docsDir', 'semDocs'),
    hasKey,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; [k: string]: unknown }) => {
    if (msg.type === 'save') {
      const baseUrl = String(msg.baseUrl ?? '').trim();
      const model = String(msg.model ?? '').trim();
      const docsDir = String(msg.docsDir ?? '').trim() || 'semDocs';
      const apiKey = String(msg.apiKey ?? '').trim();

      await cfg.update('baseUrl', baseUrl, configTarget());
      await cfg.update('model', model, configTarget());
      await cfg.update('docsDir', docsDir, configTarget());
      if (apiKey) await context.secrets.store(KEY_SECRET, apiKey);

      onSaved();
      panel.webview.postMessage({ type: 'saved', hasKey: hasKey || !!apiKey });
      void vscode.window.showInformationMessage('S-IDE：設定已儲存。');
      return;
    }

    if (msg.type === 'test') {
      const baseUrl = String(msg.baseUrl ?? '').trim();
      const model = String(msg.model ?? '').trim();
      const typedKey = String(msg.apiKey ?? '').trim();
      const key = typedKey || (await context.secrets.get(KEY_SECRET)) || '';

      if (!baseUrl || !model) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: '缺少 baseUrl 或 model' });
        return;
      }
      if (!key) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: '尚未設定 API Key' });
        return;
      }

      const started = Date.now();
      try {
        const res = await fetch(ai.chatUrl(baseUrl), {
          method: 'POST',
          headers: ai.aiHeaders(key),
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: 'user', content: '回覆 OK 兩個字' }],
          }),
        });
        const ms = Date.now() - started;

        if (!res.ok) {
          const detail = await ai.aiError(res);
          panel.webview.postMessage({ type: 'testResult', ok: false, text: `${detail}（${ms}ms）` });
          return;
        }

        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const reply = (data.choices?.[0]?.message?.content ?? '').trim() || '(空回應)';
        panel.webview.postMessage({
          type: 'testResult',
          ok: true,
          text: `200 · ${ms}ms · ${reply.slice(0, 60)}`,
        });
      } catch (e) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: (e as Error).message });
      }
    }
  });
}

/** 有開資料夾就寫工作區設定（跟著專案走），否則寫使用者設定。 */
function configTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function renderHtml(
  nonce: string,
  initial: { baseUrl: string; model: string; docsDir: string; hasKey: boolean },
): string {
  const state = JSON.stringify({
    baseUrl: initial.baseUrl,
    model: initial.model,
    docsDir: initial.docsDir,
    hasKey: initial.hasKey,
    presets: PRESETS,
  });

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; max-width: 620px; }
  h2 { font-size: 16px; margin: 0 0 16px; }
  label { display: block; margin: 14px 0 4px; font-size: 12px; opacity: .8; }
  input, select { width: 100%; box-sizing: border-box; padding: 6px 8px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .row { display: flex; gap: 8px; margin-top: 20px; }
  button { padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  #result { margin-top: 16px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  .ok { color: var(--vscode-testing-iconPassed); }
  .bad { color: var(--vscode-errorForeground); }
  .hint { font-size: 11px; opacity: .7; margin-top: 6px; }
</style>
</head>
<body>
  <h2>S-IDE 設定</h2>

  <label for="provider">供應商</label>
  <select id="provider">
    <option value="">自訂</option>
    <option value="openai">OpenAI</option>
    <option value="opencode">OpenCode Go</option>
    <option value="deepseek">DeepSeek</option>
    <option value="ollama">Ollama（本機）</option>
  </select>

  <label for="baseUrl">Base URL</label>
  <input id="baseUrl" type="text" spellcheck="false" />

  <label for="model">模型</label>
  <input id="model" type="text" spellcheck="false" />

  <label for="apiKey">API Key</label>
  <input id="apiKey" type="password" spellcheck="false" />
  <div class="hint" id="keyHint"></div>

  <label for="docsDir">文件目錄</label>
  <input id="docsDir" type="text" spellcheck="false" />

  <div class="row">
    <button id="save">儲存</button>
    <button id="test" class="secondary">測試連線</button>
  </div>

  <div id="result"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = ${state};

  const $ = (id) => document.getElementById(id);
  const provider = $('provider'), baseUrl = $('baseUrl'), model = $('model');
  const apiKey = $('apiKey'), docsDir = $('docsDir'), result = $('result');

  baseUrl.value = state.baseUrl || '';
  model.value = state.model || '';
  docsDir.value = state.docsDir || '';
  $('keyHint').textContent = state.hasKey ? '已設定；留空則不變更' : '尚未設定';

  // 選了 preset 就把端點與建議模型填好（自訂則保留原值）
  provider.addEventListener('change', () => {
    const preset = state.presets[provider.value];
    if (!preset) return;
    baseUrl.value = preset.baseUrl;
    model.value = preset.model;
  });

  $('save').addEventListener('click', () => {
    vscode.postMessage({
      type: 'save',
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value,
      docsDir: docsDir.value,
    });
  });

  $('test').addEventListener('click', () => {
    result.className = '';
    result.textContent = '測試中…';
    vscode.postMessage({
      type: 'test',
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value,
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'testResult') {
      result.className = msg.ok ? 'ok' : 'bad';
      result.textContent = (msg.ok ? '✅ ' : '❌ ') + msg.text;
    }
    if (msg.type === 'saved') {
      $('keyHint').textContent = msg.hasKey ? '已設定；留空則不變更' : '尚未設定';
      apiKey.value = '';
    }
  });
</script>
</body>
</html>`;
}
