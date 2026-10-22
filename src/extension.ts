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

function lang(): Lang {
  return normalizeLang(config().get<string>('language'));
}

function ui(): UiStrings {
  return uiFor(lang());
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('side');
}
