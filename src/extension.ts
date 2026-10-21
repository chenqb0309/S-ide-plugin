import * as vscode from 'vscode';
import * as docsFeature from './docs/feature';

/**
 * S-IDE 的 VS Code 外掛。
 *
 * 這個檔案**只做接線**：宿主給事件，feature 做決策。
 * 業務邏輯在 `src/core/`，而 core 不得 import 'vscode'。
 */

const KEY_SECRET = 'side.apiKey';

let ctx: vscode.ExtensionContext;
let out: vscode.OutputChannel;
let status: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('S-IDE');

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'side.syncDocs';
  status.text = '$(book) semDocs';
  status.tooltip = 'S-IDE：同步語義文件（code → Markdown）';

  context.subscriptions.push(
    out,
    status,
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncStatusVisibility()),
    registerCommands(),
  );

  syncStatusVisibility();

  out.appendLine('S-IDE 已啟用。');
  out.appendLine(`  工作區：${workspaceRoot() ?? '(未開啟資料夾)'}`);
  out.appendLine('  semDocs：點狀態列「semDocs」，或執行「S-IDE: 同步語義文件」');
}

export function deactivate(): void {
  /* nothing to do */
}

/** 沒有開資料夾時就不顯示，避免按了只得到錯誤。 */
function syncStatusVisibility(): void {
  if (workspaceRoot()) status.show();
  else status.hide();
}

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

    vscode.commands.registerCommand('side.syncDocs', () => docsFeature.syncDocs(docsDeps(), 'auto')),
    vscode.commands.registerCommand('side.rebuildDocs', () => docsFeature.syncDocs(docsDeps(), 'full')),
  );
}

function docsDeps(): docsFeature.DocsDeps {
  return { workspaceRoot, config, out, secrets: ctx.secrets, status };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('side');
}
