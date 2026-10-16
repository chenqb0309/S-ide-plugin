import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from './core';

/**
 * S-IDE 的 VS Code 外掛。
 *
 * 這個檔案**只做接線**：宿主給事件，core 做決策。
 * 業務邏輯一律在 `src/core/`，而 core 不得 import 'vscode'——
 * 那是寄生策略唯一的保險：將來要脫離宿主時，core 不用重寫。
 */

const KEY_SECRET = 'side.apiKey';
const DEBOUNCE_MS = 400;
const LANGUAGE_ID = 'sem';

let ctx: vscode.ExtensionContext;
let out: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let diags: vscode.DiagnosticCollection;
let lastDiff = '(尚未執行過)';
let running = false;
let queued = false;
let debounce: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('S-IDE');
  diags = vscode.languages.createDiagnosticCollection('sem');

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'side.execute';
  status.text = '$(beaker) S-IDE';
  status.tooltip = 'S-IDE：點擊執行';
  status.show();

  context.subscriptions.push(
    out,
    diags,
    status,
    { dispose: () => debounce && clearTimeout(debounce) },
    registerLinks(),
    registerDefinitions(),
    registerEvents(),
    registerCommands(),
  );

  if (vscode.workspace.textDocuments.some((d) => d.languageId === LANGUAGE_ID)) refreshDiagnostics();
}

export function deactivate(): void {
  /* nothing to do */
}

// ── 語法高亮：由 TextMate grammar 負責（宣告檔，不寫程式） ─────────────────

// ── `[[類別.方法]]` 可點擊 ─────────────────────────────────────────────────
function registerLinks(): vscode.Disposable {
  return vscode.languages.registerDocumentLinkProvider({ language: LANGUAGE_ID }, {
    provideDocumentLinks(doc) {
      const links: vscode.DocumentLink[] = [];
      for (const ref of core.findLinks(doc.uri.fsPath, doc.getText())) {
        const target = resolveLink(ref.target);
        if (!target) continue;
        const range = new vscode.Range(ref.line, ref.startChar, ref.line, ref.endChar);
        const link = new vscode.DocumentLink(range, vscode.Uri.file(target.abs));
        link.tooltip = `→ ${target.relPath}:${target.line + 1}`;
        links.push(link);
      }
      return links;
    },
  });
}

/**
 * DocumentLink 只會開啟目標檔案，**不會定位到行**。
 * 所以另外註冊 DefinitionProvider，讓 Ctrl+click / F12 精確跳到目標行。
 */
function registerDefinitions(): vscode.Disposable {
  return vscode.languages.registerDefinitionProvider({ language: LANGUAGE_ID }, {
    provideDefinition(doc, position) {
      for (const ref of core.findLinks(doc.uri.fsPath, doc.getText())) {
        if (ref.line !== position.line) continue;
        if (position.character < ref.startChar || position.character > ref.endChar) continue;
        const target = resolveLink(ref.target);
        if (!target) return undefined;
        return new vscode.Location(vscode.Uri.file(target.abs), new vscode.Position(target.line, 0));
      }
      return undefined;
    },
  });
}

// ── 事件 ────────────────────────────────────────────────────────────────────
function registerEvents(): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== LANGUAGE_ID) return;
      refreshDiagnostics();
      if (!config().get<boolean>('autoGenerateOnSave', true)) return;
      // 存檔才觸發，不是每次修改；再加 debounce，避免連續存檔灌爆管線
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void run('compile'), DEBOUNCE_MS);
    }),
  );

  disposables.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === LANGUAGE_ID) refreshDiagnostics();
    }),
  );

  disposables.push(vscode.workspace.onDidCloseTextDocument(() => refreshDiagnostics()));

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('side')) refreshDiagnostics();
    }),
  );

  return vscode.Disposable.from(...disposables);
}

// ── 命令 ────────────────────────────────────────────────────────────────────
function registerCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('side.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        title: 'S-IDE: API Key',
        prompt: '只存在 VS Code 的加密儲存區，不會寫進 settings.json',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      await ctx.secrets.store(KEY_SECRET, value.trim());
      void vscode.window.showInformationMessage('S-IDE：API Key 已儲存。');
    }),

    vscode.commands.registerCommand('side.generate', () => run('compile')),
    vscode.commands.registerCommand('side.execute', () => run('execute')),
    vscode.commands.registerCommand('side.rebuildAll', () => run('rebuild')),

    vscode.commands.registerCommand('side.showContextMap', () => {
      const { files } = analyze();
      out.clear();
      out.appendLine('# .sem 全專案簽章索引（這就是 AI 看到的全部護欄）');
      out.appendLine('');
      out.appendLine(core.contextMapForPrompt(files));
      out.show(true);
    }),

    vscode.commands.registerCommand('side.showManifestDiff', () => {
      out.clear();
      out.appendLine('# 上次執行的 manifest 變動');
      out.appendLine('');
      out.appendLine(lastDiff);
      out.show(true);
    }),
  );
}

// ── 分析與診斷 ──────────────────────────────────────────────────────────────
interface Analysis {
  root: string | undefined;
  files: core.SemFile[];
  symbols: core.SymbolTable;
  diagnostics: core.LintDiagnostic[];
}

function analyze(): Analysis {
  const root = workspaceRoot();
  if (!root) return { root, files: [], symbols: core.collectSymbols([]), diagnostics: [] };

  const files: core.SemFile[] = [];
  for (const rel of core.scanSemFiles(root)) {
    try {
      files.push(core.parseSem(rel, core.readText(path.join(root, rel))));
    } catch {
      /* 解析失敗不在這裡報；lint 與編譯器會給更具體的訊息 */
    }
  }

  const symbols = core.collectSymbols(files);
  const diagnostics = [
    ...core.lint(files),
    ...core.lintLinks(files, symbols, (rel) => core.readText(path.join(root, rel))),
  ];

  return { root, files, symbols, diagnostics };
}

function refreshDiagnostics(): void {
  const { root, diagnostics } = analyze();
  diags.clear();
  if (!root) return;

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of diagnostics) {
    const abs = path.join(root, d.relPath);
    const range = new vscode.Range(d.line, 0, d.line, Number.MAX_SAFE_INTEGER);
    const diag = new vscode.Diagnostic(
      range,
      d.message,
      d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diag.source = 'S-IDE';
    const list = byFile.get(abs) ?? [];
    list.push(diag);
    byFile.set(abs, list);
  }

  for (const [file, list] of byFile) diags.set(vscode.Uri.file(file), list);
}

interface Resolved {
  abs: string;
  relPath: string;
  line: number;
}

function resolveLink(target: string): Resolved | undefined {
  const { root, symbols } = analyze();
  if (!root) return undefined;
  const hit = symbols.methods.get(target) ?? symbols.classes.get(target) ?? symbols.datas.get(target);
  if (!hit) return undefined;
  return { abs: path.join(root, hit.relPath), relPath: hit.relPath, line: hit.line };
}

// ── 管線 ────────────────────────────────────────────────────────────────────
type Mode = 'compile' | 'execute' | 'rebuild';

async function run(mode: Mode): Promise<void> {
  // 任務佇列：同一時間只有一條管線；後來的請求合併成一次，避免舊請求覆蓋新檔案
  if (running) {
    queued = true;
    return;
  }

  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage('S-IDE：請先開啟一個資料夾。');
    return;
  }

  running = true;
  out.show(true);
  status.text = '$(sync~spin) S-IDE';

  try {
    const cfg = config();
    const apiKey = (await ctx.secrets.get(KEY_SECRET)) ?? '';

    if (!apiKey) {
      out.appendLine('⚠️  未設定 API Key —— 以 MOCK 模式執行（罐頭回應，不會呼叫 AI）。');
      out.appendLine('   請執行命令「S-IDE: 設定 API Key」。');
      out.appendLine('');
    }

    const dotnet = core.checkDotnet();
    if (!dotnet.ok) {
      out.appendLine('❌ 找不到 dotnet。S-IDE 需要 .NET 10 SDK 才能編譯與執行。');
      void vscode.window.showErrorMessage('S-IDE：找不到 dotnet，請先安裝 .NET 10 SDK。');
      return;
    }

    const opts: core.PipelineOptions = {
      workspaceRoot: root,
      extensionPath: ctx.extensionUri.fsPath,
      log: (line) => out.appendLine(line),
      ai: {
        baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
        model: cfg.get<string>('model', ''),
        apiKey,
      },
      maxRetry: cfg.get<number>('maxRetry', 2),
    };

    const t0 = Date.now();
    const result =
      mode === 'execute' ? await core.execute(opts)
      : mode === 'rebuild' ? await core.rebuildAll(opts)
      : await core.compile(opts);

    lastDiff = diffText(result);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    out.appendLine('');
    out.appendLine(`完成（${secs}s）：${result.ok ? '成功' : '失敗'}`);

    if (result.ok) {
      void vscode.window.setStatusBarMessage(`$(check) S-IDE：完成（${secs}s）`, 4000);
    } else {
      void vscode.window.showWarningMessage('S-IDE：管線未通過，詳見「S-IDE」輸出面板。');
    }
  } catch (e) {
    out.appendLine('');
    out.appendLine(`管線錯誤：${(e as Error).message}`);
    void vscode.window.showErrorMessage(`S-IDE：${(e as Error).message}`);
  } finally {
    running = false;
    status.text = '$(beaker) S-IDE';
    if (queued) {
      queued = false;
      void run(mode);
    }
  }
}

function diffText(result: core.CompileResult): string {
  const lines = [`沿用 ${result.reused}、重生 ${result.regenerated.length}、移除 ${result.orphans.length}`, ''];
  for (const u of result.regenerated) lines.push(`${u.key}   [${u.stale}]   ${u.cacheKey}`);
  for (const o of result.orphans) lines.push(`移除孤兒 ${o}`);
  return lines.join('\n');
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('side');
}
