import * as vscode from 'vscode';
import * as docsFeature from './docs/feature';
import { DocsTreeProvider } from './views/docsTree';
import { openSettingsPanel } from './views/settingsPanel';

/**
 * S-IDE 的 VS Code 外掛。
 *
 * 這個檔案**只做接線**：宿主給事件，feature 做決策。
 * 業務邏輯在 `src/core/`，而 core 不得 import 'vscode'。
 */

const KEY_SECRET = 'side.apiKey';

let ctx: vscode.ExtensionContext;
let out: vscode.OutputChannel;
let tree: DocsTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('S-IDE');

  tree = new DocsTreeProvider(workspaceRoot, docsDir);

  context.subscriptions.push(
    out,
    vscode.window.registerTreeDataProvider('side.docs', tree),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    registerCommands(),
  );

  out.appendLine('S-IDE 已啟用。');
  out.appendLine(`  工作區：${workspaceRoot() ?? '(未開啟資料夾)'}`);
  out.appendLine('  semDocs：從側邊欄按「同步語義文件」');
}

export function deactivate(): void {
  /* nothing to do */
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
      tree.refresh();
      void vscode.window.showInformationMessage('S-IDE：API Key 已儲存。');
    }),

    vscode.commands.registerCommand('side.syncDocs', async () => {
      await docsFeature.syncDocs(docsDeps(), 'auto');
      tree.refresh();
    }),

    vscode.commands.registerCommand('side.rebuildDocs', async () => {
      await docsFeature.syncDocs(docsDeps(), 'full');
      tree.refresh();
    }),

    vscode.commands.registerCommand('side.openSettings', async () => {
      await openSettingsPanel(ctx, () => tree.refresh());
    }),
  );
}

function docsDeps(): docsFeature.DocsDeps {
  return { workspaceRoot, config, out, secrets: ctx.secrets };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function docsDir(): string {
  return config().get<string>('docsDir', 'semDocs') || 'semDocs';
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('side');
}
