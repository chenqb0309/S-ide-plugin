import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from '../core';
import * as feature from '../docs/feature';

/**
 * 側邊欄：動作 + 狀態 + 文件樹。
 *
 * 只做「導覽」，不放業務邏輯——按鈕全都呼叫既有的命令。
 */

type Node =
  | { kind: 'group'; id: 'actions' | 'files'; label: string }
  | { kind: 'action'; label: string; command: string; icon: string; description?: string }
  | { kind: 'status'; label: string; description?: string }
  | { kind: 'dir'; label: string; children: Node[] }
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

    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'side.dir';
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

    if (node.kind === 'dir') return node.children;

    if (node.kind === 'group' && node.id === 'actions') {
      return [
        { kind: 'action', label: '同步語義文件', command: 'side.syncDocs', icon: 'sync' },
        { kind: 'action', label: '重建全部', command: 'side.rebuildDocs', icon: 'refresh' },
        { kind: 'action', label: '設定 AI', command: 'side.openSettings', icon: 'gear' },
        { kind: 'status', label: feature.lastRunSummary() || '尚未同步' },
      ];
    }

    if (node.kind === 'group' && node.id === 'files') {
      const root = this.workspaceRoot();
      if (!root) return [{ kind: 'status', label: '尚未開啟資料夾' }];

      const dir = this.docsDir();
      let files: string[] = [];
      try {
        files = core.docs.listDocFiles(path.join(root, dir));
      } catch {
        files = [];
      }

      if (!files.length) return [{ kind: 'status', label: '還沒有文件，先按「同步語義文件」' }];
      return buildTree(files, dir);
    }

    return [];
  }
}

/**
 * 把 `Core/Entities/Product.md` 這種相對路徑組成目錄樹。
 * 資料夾排在檔案前面；資料夾預設收合（只看到第一層）。
 */
function buildTree(files: readonly string[], docsDir: string): Node[] {
  const root: Node = { kind: 'dir', label: '', children: [] };

  for (const rel of files) {
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) continue;

    let cursor = root as Extract<Node, { kind: 'dir' }>;
    for (const segment of parts.slice(0, -1)) {
      let next = cursor.children.find(
        (child): child is Extract<Node, { kind: 'dir' }> => child.kind === 'dir' && child.label === segment,
      );
      if (!next) {
        next = { kind: 'dir', label: segment, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }

    cursor.children.push({ kind: 'file', label: parts[parts.length - 1], rel: `${docsDir}/${rel}` });
  }

  sortNodes(root.children);
  return root.children;
}

function sortNodes(nodes: Node[]): void {
  nodes.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    const left = a.kind === 'dir' || a.kind === 'file' ? a.label : '';
    const right = b.kind === 'dir' || b.kind === 'file' ? b.label : '';
    return left.localeCompare(right);
  });
  for (const node of nodes) if (node.kind === 'dir') sortNodes(node.children);
}
