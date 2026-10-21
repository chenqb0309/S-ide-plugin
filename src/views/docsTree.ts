import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from '../core';
import * as feature from '../docs/feature';

/**
 * 側邊欄：動作 + 狀態 + 文件清單。
 *
 * 只做「導覽」，不放業務邏輯——按鈕全都呼叫既有的命令。
 */

type Node =
  | { kind: 'group'; id: 'actions' | 'files'; label: string }
  | { kind: 'action'; label: string; command: string; icon: string; description?: string }
  | { kind: 'status'; label: string; description?: string }
  | { kind: 'file'; label: string; rel: string };

export class DocsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly workspaceRoot: () => string | undefined,
    private readonly docsDir: () => string,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `side.group.${node.id}`;
      return item;
    }

    if (node.kind === 'action') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = { command: node.command, title: node.label };
      item.description = node.description;
      return item;
    }

    if (node.kind === 'status') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      item.description = node.description;
      item.tooltip = node.label;
      return item;
    }

    const root = this.workspaceRoot();
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('markdown');
    item.description = path.posix.dirname(node.rel) === '.' ? '' : path.posix.dirname(node.rel);
    item.tooltip = node.rel;
    if (root) {
      item.command = {
        command: 'vscode.open',
        title: '開啟',
        arguments: [vscode.Uri.file(path.join(root, node.rel))],
      };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [
        { kind: 'group', id: 'actions', label: '動作' },
        { kind: 'group', id: 'files', label: '文件' },
      ];
    }

    if (node.kind === 'group' && node.id === 'actions') {
      return [
        { kind: 'action', label: '同步語義文件', command: 'side.syncDocs', icon: 'sync' },
        { kind: 'action', label: '重建全部', command: 'side.rebuildDocs', icon: 'refresh' },
        { kind: 'action', label: '設定 AI', command: 'side.openSettings', icon: 'gear' },
        { kind: 'status', label: feature.lastRunSummary() || '尚未同步', description: '' },
      ];
    }

    if (node.kind === 'group' && node.id === 'files') {
      const root = this.workspaceRoot();
      if (!root) return [{ kind: 'status', label: '尚未開啟資料夾' }];

      const docsRoot = path.join(root, this.docsDir());
      const dir = this.docsDir();
      let files: string[] = [];
      try {
        files = core.docs.listDocFiles(docsRoot).map((rel) => `${dir}/${rel}`);
      } catch {
        files = [];
      }

      if (!files.length) return [{ kind: 'status', label: '還沒有文件，先按「同步語義文件」' }];

      return files
        .sort((a, b) => a.localeCompare(b))
        .map((rel) => ({ kind: 'file' as const, label: path.posix.basename(rel), rel }));
    }

    return [];
  }
}
