import type { GitChange } from './git';
import type { MemberDoc } from './types';
import { DOC_VERSION } from './markdown';

export type SyncMode = 'full' | 'incremental' | 'none';

export interface DecideInput {
  hasGit: boolean;
  hasMarker: boolean;
  markerVersion: number;
  baseline: string;
  changes: readonly GitChange[];
  relDocsDir: string;
}

export interface Decision {
  mode: SyncMode;
  reason: string;
}

/**
 * 使用者永遠不用選模式。這裡把「該做什麼」全部推導出來：
 *
 * - 沒有文件 → 全量
 * - 沒有 git / 沒有 baseline → 全量（無從比較）
 * - 模板版本不同 → 全量
 * - 沒有任何 .cs 變動 → 什麼都不做（不要白燒 AI）
 */
export function decide(input: DecideInput): Decision {
  if (!input.hasMarker) return { mode: 'full', reason: '尚未建立 semDocs，執行全量建置' };
  if (input.markerVersion !== DOC_VERSION) {
    return { mode: 'full', reason: `文件模板版本 ${input.markerVersion} ≠ ${DOC_VERSION}，全量重建` };
  }
  if (!input.hasGit) return { mode: 'full', reason: '此專案不是 git repo，無法比對變動，全量重建' };
  if (!input.baseline) return { mode: 'full', reason: 'semDocs 尚未 commit 過，沒有比較基準，全量重建' };

  const touched = touchedSources(input.changes, input.relDocsDir);
  if (!touched.length) return { mode: 'none', reason: '自上次同步以來沒有任何 .cs 變動' };

  return { mode: 'incremental', reason: `${touched.length} 個 .cs 有變動` };
}

/** 只留 .cs，且排除 docs 目錄自己。 */
export function touchedSources(changes: readonly GitChange[], relDocsDir: string): GitChange[] {
  const prefix = relDocsDir.replace(/\/+$/, '') + '/';
  return changes.filter(
    (c) => c.rel.toLowerCase().endsWith('.cs') && !c.rel.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

/** 刪除：` D` / `D ` / `AD` 之類，只要狀態碼含 D。 */
export function isDeletion(change: GitChange): boolean {
  return change.status.includes('D');
}

/** 未追蹤：diff 看不到內容，只能整檔重建。 */
export function isUntracked(change: GitChange): boolean {
  return change.status === '??';
}

/**
 * diff hunk（1-based，含頭含尾）與 symbol 範圍的交集。
 * 這一步決定「最小重寫單位」——property 就只是一個 property。
 */
export function changedMemberIds(members: readonly MemberDoc[], ranges: ReadonlyArray<[number, number]>): Set<string> {
  const hit = new Set<string>();
  if (!ranges.length) return hit;

  for (const member of members) {
    const start = member.startLine + 1; // 轉 1-based
    const end = member.endLine; // endLine 是 exclusive，剛好等於最後一行（1-based）
    for (const [from, to] of ranges) {
      if (from <= end && to >= start) {
        hit.add(member.id);
        break;
      }
    }
  }
  return hit;
}
