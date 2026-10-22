import * as path from 'node:path';
import * as vscode from 'vscode';
import * as docsFeature from './docs/feature';
import { normalizeLang, uiFor, type Lang, type UiStrings } from './i18n';
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

  tree = new DocsTreeProvider(workspaceRoot, docsDir, ui);

  context.subscriptions.push(
    out,
    vscode.window.registerTreeDataProvider('side.docs', tree),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('side.language')) tree.refresh();
    }),
    registerCommands(),
  );

  const t = ui();
  out.appendLine(t.activated);
  out.appendLine(t.workspaceLine(workspaceRoot() ?? t.noFolderOpen));
  out.appendLine(t.sidebarHint);
}

export function deactivate(): void {
  /* nothing to do */
}

function registerCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('side.setApiKey', async () => {
      const t = ui();
      const value = await vscode.window.showInputBox({
        title: t.apiKeyTitle,
        prompt: t.apiKeyPrompt,
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      await ctx.secrets.store(KEY_SECRET, value.trim());
      tree.refresh();
      void vscode.window.showInformationMessage(t.apiKeySaved);
    }),

    vscode.commands.registerCommand('side.syncDocs', async () => {
      if (!(await ensureCsharp())) return;
      await docsFeature.syncDocs(docsDeps(), 'auto');
      tree.refresh();
    }),

    vscode.commands.registerCommand('side.rebuildDocs', async () => {
      if (!(await ensureCsharp())) return;
      await docsFeature.syncDocs(docsDeps(), 'full');
      tree.refresh();
    }),

    vscode.commands.registerCommand('side.openSettings', async () => {
      await openSettingsPanel(ctx, () => tree.refresh());
    }),

    // 樹節點的右鍵／行內按鈕：需要編輯時才開原始碼
    vscode.commands.registerCommand('side.openSource', async (node?: { kind?: string; rel?: string }) => {
      const root = workspaceRoot();
      if (!root || !node?.rel) return;
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, node.rel)));
    }),
  );
}

function docsDeps(): docsFeature.DocsDeps {
  return { workspaceRoot, config, out, secrets: ctx.secrets };
}

/** 沒有 C# 擴充就拿不到符號；先提示，不要讓使用者看到「跳過所有檔案」。 */
async function ensureCsharp(): Promise<boolean> {
  if (!workspaceRoot()) return true;
  if (vscode.extensions.getExtension('ms-dotnettools.csharp')) return true;

  const t = ui();
  const action = await vscode.window.showWarningMessage(t.noCsharp, t.btnInstallCsharp);
  if (action === t.btnInstallCsharp) {
    await vscode.commands.executeCommand('workbench.extensions.search', 'ms-dotnettools.csharp');
  }
  return false;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function docsDir(): string {
  return config().get<string>('docsDir', 'semDocs') || 'semDocs';
}

function lang(): Lang {
  return normalizeLang(config().get<string>('language'));
}

function ui(): UiStrings {
  return uiFor(lang());
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('side');
}
