import * as vscode from 'vscode';
import * as ai from '../core/ai';
import { normalizeLang, uiFor, type UiStrings } from '../i18n';

/**
 * 設定界面：供應商／模型／API Key／文件目錄／語言，外加「測試連線」。
 *
 * 為什麼是 Webview：測試連線。事後翻 Output 猜 401 太慢。
 * 所有標籤都跟 `side.language` 走。
 */

const KEY_SECRET = 'side.apiKey';

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  opencode: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'glm-5.3-flash' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
};

interface SettingsState {
  baseUrl: string;
  model: string;
  docsDir: string;
  language: string;
  hasKey: boolean;
}

export async function openSettingsPanel(
  context: vscode.ExtensionContext,
  onSaved: () => void,
): Promise<void> {
  let state = await readState(context);
  let lang = normalizeLang(state.language);
  let t = uiFor(lang);

  const panel = vscode.window.createWebviewPanel('side.settings', t.settingsTitle, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const paint = (): void => {
    panel.title = t.settingsTitle;
    panel.webview.html = renderHtml(newNonce(), state, t);
  };
  paint();

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; [k: string]: unknown }) => {
    if (msg.type === 'save') {
      const next: SettingsState = {
        baseUrl: String(msg.baseUrl ?? '').trim(),
        model: String(msg.model ?? '').trim(),
        docsDir: String(msg.docsDir ?? '').trim() || 'semDocs',
        language: normalizeLang(String(msg.language ?? 'en')),
        hasKey: state.hasKey,
      };
      const apiKey = String(msg.apiKey ?? '').trim();

      const cfg = vscode.workspace.getConfiguration('side');
      await cfg.update('baseUrl', next.baseUrl, configTarget());
      await cfg.update('model', next.model, configTarget());
      await cfg.update('docsDir', next.docsDir, configTarget());
      await cfg.update('language', next.language, configTarget());
      if (apiKey) {
        await context.secrets.store(KEY_SECRET, apiKey);
        next.hasKey = true;
      }

      const languageChanged = next.language !== state.language;
      state = next;

      onSaved();
      void vscode.window.showInformationMessage(t.settingsSaved);

      // 語言換了就把整頁重繪，否則標籤會停在舊語言
      if (languageChanged) {
        lang = normalizeLang(state.language);
        t = uiFor(lang);
        paint();
      } else {
        panel.webview.postMessage({ type: 'saved', hasKey: state.hasKey });
      }
      return;
    }

    if (msg.type === 'test') {
      const baseUrl = String(msg.baseUrl ?? '').trim();
      const model = String(msg.model ?? '').trim();
      const typedKey = String(msg.apiKey ?? '').trim();
      const key = typedKey || (await context.secrets.get(KEY_SECRET)) || '';

      if (!baseUrl || !model) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: t.missingBase });
        return;
      }
      if (!key) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: t.missingKey });
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
            messages: [{ role: 'user', content: t.testPrompt }],
          }),
        });
        const ms = Date.now() - started;

        if (!res.ok) {
          const detail = await ai.aiError(res);
          panel.webview.postMessage({ type: 'testResult', ok: false, text: `${detail} (${ms}ms)` });
          return;
        }

        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const reply = (data.choices?.[0]?.message?.content ?? '').trim();
        panel.webview.postMessage({
          type: 'testResult',
          ok: true,
          text: reply ? `200 · ${ms}ms · ${reply.slice(0, 60)}` : t.emptyResponse(ms),
        });
      } catch (e) {
        panel.webview.postMessage({ type: 'testResult', ok: false, text: (e as Error).message });
      }
    }
  });
}

async function readState(context: vscode.ExtensionContext): Promise<SettingsState> {
  const cfg = vscode.workspace.getConfiguration('side');
  return {
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: cfg.get<string>('model', ''),
    docsDir: cfg.get<string>('docsDir', 'semDocs'),
    language: cfg.get<string>('language', 'en'),
    hasKey: !!(await context.secrets.get(KEY_SECRET)),
  };
}

/** 有開資料夾就寫工作區設定（跟著專案走），否則寫使用者設定。 */
function configTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function newNonce(): string {
  return String(Date.now()) + Math.random().toString(36).slice(2);
}

function renderHtml(nonce: string, state: SettingsState, t: UiStrings): string {
  const boot = JSON.stringify({
    baseUrl: state.baseUrl,
    model: state.model,
    docsDir: state.docsDir,
    language: normalizeLang(state.language),
    hasKey: state.hasKey,
    presets: PRESETS,
    text: {
      testing: t.testing,
      keySet: t.keySet,
      keyNotSet: t.keyNotSet,
      customProvider: t.customProvider,
    },
  });

  return `<!DOCTYPE html>
<html lang="${normalizeLang(state.language)}">
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
  <h2>${t.settingsTitle}</h2>

  <label for="provider">${t.labelProvider}</label>
  <select id="provider">
    <option value="">${t.customProvider}</option>
    <option value="openai">OpenAI</option>
    <option value="opencode">OpenCode Go</option>
    <option value="deepseek">DeepSeek</option>
    <option value="ollama">Ollama</option>
  </select>

  <label for="baseUrl">${t.labelBaseUrl}</label>
  <input id="baseUrl" type="text" spellcheck="false" />

  <label for="model">${t.labelModel}</label>
  <input id="model" type="text" spellcheck="false" />

  <label for="apiKey">${t.labelApiKey}</label>
  <input id="apiKey" type="password" spellcheck="false" />
  <div class="hint" id="keyHint"></div>

  <label for="docsDir">${t.labelDocsDir}</label>
  <input id="docsDir" type="text" spellcheck="false" />

  <label for="language">${t.labelLanguage}</label>
  <select id="language">
    <option value="en">English</option>
    <option value="zh-TW">繁體中文</option>
  </select>
  <div class="hint">${t.languageHint}</div>

  <div class="row">
    <button id="save">${t.btnSave}</button>
    <button id="test" class="secondary">${t.btnTest}</button>
  </div>

  <div id="result"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = ${boot};

  const $ = (id) => document.getElementById(id);
  const provider = $('provider'), baseUrl = $('baseUrl'), model = $('model');
  const apiKey = $('apiKey'), docsDir = $('docsDir'), language = $('language'), result = $('result');

  baseUrl.value = state.baseUrl || '';
  model.value = state.model || '';
  docsDir.value = state.docsDir || '';
  language.value = state.language === 'zh-TW' ? 'zh-TW' : 'en';
  $('keyHint').textContent = state.hasKey ? state.text.keySet : state.text.keyNotSet;

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
      language: language.value,
    });
  });

  $('test').addEventListener('click', () => {
    result.className = '';
    result.textContent = state.text.testing;
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
      $('keyHint').textContent = msg.hasKey ? state.text.keySet : state.text.keyNotSet;
      apiKey.value = '';
    }
  });
</script>
</body>
</html>`;
}
