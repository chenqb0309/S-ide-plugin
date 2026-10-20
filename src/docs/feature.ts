import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from '../core';

/**
 * semDocs：把 C# 翻成可讀的語義文件。
 *
 * 分工（不可妥協）：
 *   拓撲  = VS Code 的 DocumentSymbol + CallHierarchy → 連結永遠正確
 *   語義  = AI（每個節點一句話）→ 錯了也只錯一句，不會污染結構
 *   排版  = 程式 → 未變動的區塊原樣保留，diff 乾淨
 *
 * 本檔只做「跟宿主要資料」與「寫檔」；決策在 core/docs。
 */

const KEY_SECRET = 'side.apiKey';

export interface DocsDeps {
  workspaceRoot: () => string | undefined;
  config: () => vscode.WorkspaceConfiguration;
  out: vscode.OutputChannel;
  secrets: vscode.SecretStorage;
  status: vscode.StatusBarItem;
}

interface RunStats {
  mode: core.docs.SyncMode;
  reason: string;
  files: number;
  rewritten: number;
  removed: number;
}

let running = false;
let queued: 'auto' | 'full' | undefined;

export async function syncDocs(deps: DocsDeps, mode: 'auto' | 'full' = 'auto'): Promise<void> {
  if (running) {
    queued = mode;
    return;
  }

  const root = deps.workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage('S-IDE：請先開啟一個資料夾。');
    return;
  }

  // 沒有 AI 就沒有產品：不允許產出「有結構、沒說明」的文件。
  const ai = await aiConfig(deps);
  if (!ai.apiKey || !ai.model) {
    const action = await vscode.window.showErrorMessage(
      'S-IDE：尚未設定 API Key 或模型。語義文件需要 AI 產生說明，因此不會執行。',
      '設定 API Key',
      '開啟設定',
    );
    if (action === '設定 API Key') await vscode.commands.executeCommand('side.setApiKey');
    else if (action === '開啟設定') await vscode.commands.executeCommand('workbench.action.openSettings', 'side.model');
    return;
  }

  running = true;
  deps.status.text = '$(sync~spin) semDocs';

  try {
    const stats = await runSync(deps, root, mode, ai);
    report(deps, stats);
  } catch (e) {
    const msg = (e as Error).message;
    deps.out.appendLine(`❌ semDocs 同步失敗：${msg}`);
    deps.out.show(true);
    void vscode.window.showErrorMessage(`S-IDE：${msg}`);
  } finally {
    running = false;
    deps.status.text = '$(book) semDocs';
    const next = queued;
    queued = undefined;
    if (next) void syncDocs(deps, next);
  }
}

async function runSync(
  deps: DocsDeps,
  root: string,
  forced: 'auto' | 'full',
  ai: core.docs.DocAiConfig,
): Promise<RunStats> {
  const cfg = deps.config();
  const relDocsDir = cfg.get<string>('docsDir', core.docs.DOCS_DIR_DEFAULT) || core.docs.DOCS_DIR_DEFAULT;
  const docsRoot = path.join(root, relDocsDir);

  const hasGit = core.docs.isGitRepo(root);
  const marker = core.docs.readMarker(docsRoot);
  // baseline：優先用「上次同步」那個 commit；還沒同步過就用 HEAD。
  // 兩者都沒有（連一個 commit 都沒有）才退回全量。
  const semDocsCommit = hasGit ? core.docs.baselineCommit(root, relDocsDir) : '';
  const head = hasGit ? core.docs.headCommit(root) : '';
  const baseline = semDocsCommit || head;
  const changes = hasGit ? core.docs.statusChanges(root) : [];
  // 已 commit 的改動 status 看不到，要另外從 diff 補。
  const diffed = baseline ? core.docs.diffNameStatus(root, baseline) : [];

  const decision = forced === 'full'
    ? { mode: 'full' as const, reason: '使用者要求全量重建' }
    : core.docs.decide({
        hasGit,
        hasMarker: marker !== null,
        markerVersion: marker?.version ?? 0,
        baseline,
        changes: [...changes, ...diffed],
        relDocsDir,
      });

  log(deps, `模式：${decision.mode} —— ${decision.reason}`);

  if (decision.mode === 'none') {
    void vscode.window.showInformationMessage('S-IDE：語義文件已同步，沒有需要更新的地方。');
    return { mode: 'none', reason: decision.reason, files: 0, rewritten: 0, removed: 0 };
  }

  const stats: RunStats = {
    mode: decision.mode,
    reason: decision.reason,
    files: 0,
    rewritten: 0,
    removed: 0,
  };

  // 決定要處理哪些檔案
  const targets = new Map<string, 'full' | 'diff'>();
  /** 延後到全部算完才刪，避免中途失敗留下半套 */
  const deletes: string[] = [];
  if (decision.mode === 'full') {
    // 有 git 就讓 .gitignore 決定範圍；沒有 git 才退回檔案系統掃描
    const all = hasGit ? core.docs.listCsFiles(root) : core.scanCsFiles(root, [relDocsDir]);
    for (const rel of all) {
      if (rel.toLowerCase().startsWith(relDocsDir.toLowerCase() + '/')) continue;
      targets.set(rel, 'full');
    }
  } else {
    // 兩個來源取聯集：
    //   status → 未 commit 的改動（含未追蹤）
    //   diff   → 已 commit、但文件還沒跟上的改動
    const planned = new Map<string, 'full' | 'diff' | 'delete'>();

    for (const change of core.docs.touchedSources(changes, relDocsDir)) {
      if (core.docs.isDeletion(change)) planned.set(change.rel, 'delete');
      else if (core.docs.isUntracked(change)) planned.set(change.rel, 'full');
      else planned.set(change.rel, 'diff');
    }

    if (baseline) {
      const prefix = relDocsDir.replace(/\/+$/, '').toLowerCase() + '/';
      for (const entry of diffed) {
        if (!entry.rel.toLowerCase().endsWith('.cs')) continue;
        if (entry.rel.toLowerCase().startsWith(prefix)) continue;
        if (entry.status.startsWith('D')) planned.set(entry.rel, 'delete');
        else if (!planned.has(entry.rel)) planned.set(entry.rel, 'diff');
      }
    }

    for (const [rel, kind] of planned) {
      if (kind === 'delete') {
        deletes.push(rel);
        stats.removed += 1;
      } else {
        targets.set(rel, kind);
      }
    }
  }

  if (!targets.size && !deletes.length) {
    return stats;
  }

  const index = new SymbolIndex(root, relDocsDir);
  const pending: Array<{ abs: string; text: string; relMd: string }> = [];
  const missingProse: string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'S-IDE：同步語義文件', cancellable: true },
    async (progress, token) => {
      let done = 0;
      for (const [relCs, how] of [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (token.isCancellationRequested) break;
        progress.report({ message: relCs, increment: 100 / targets.size });

        const fileDoc = await index.get(path.join(root, relCs));
        if (!fileDoc) {
          log(deps, `  跳過 ${relCs}（語言伺服器沒有回傳符號）`);
          continue;
        }

        // 哪些節點要重寫
        const changed = new Set<string>();
        if (how === 'full') {
          for (const cls of fileDoc.classes) for (const m of cls.members) changed.add(m.id);
        } else {
          const ranges = core.docs.changedLineRanges(root, baseline, relCs);
          for (const cls of fileDoc.classes) {
            for (const id of core.docs.changedMemberIds(cls.members, ranges)) changed.add(id);
          }
        }

        const out = await writeOne(deps, root, docsRoot, relDocsDir, fileDoc, changed, ai, index, missingProse);
        if (out) {
          pending.push(out);
          stats.rewritten += 1;
        }
        stats.files += 1;
        done += 1;
      }
      if (done === 0 && targets.size) log(deps, '  沒有任何檔案被處理');
    },
  );

  // 全部算完才落地：中途失敗不會留下半套文件。
  for (const rel of deletes) {
    removeDoc(docsRoot, relDocsDir, rel);
    log(deps, `  🗑️  ${core.docs.mdRelPath(rel, relDocsDir)}`);
  }
  for (const item of pending) {
    core.writeText(item.abs, item.text);
    log(deps, `  ✏️  ${item.relMd}`);
  }

  core.docs.writeIndex(docsRoot);
  if (!core.docs.readMarker(docsRoot)) core.docs.writeMarker(docsRoot);

  // 這是一個會靜默漏改動的坑：semDocs 還沒 commit 時，baseline 只能退到 HEAD；
  // 一旦使用者先 commit 了 code，那個改動就從 diff 消失了。先講清楚。
  if (hasGit && !core.docs.isDirTracked(root, relDocsDir)) {
    log(deps, '');
    log(deps, `⚠️  ${relDocsDir}/ 還沒納入版控。`);
    log(deps, '    目前 baseline 會退到 HEAD；若你先 commit code 再同步，那次改動會被漏掉。');
    log(deps, `    建議現在 commit 一次 ${relDocsDir}/，之後增量才會穩定。`);
  }

  if (missingProse.length) {
    log(deps, '');
    log(deps, `⚠️  ${missingProse.length} 個節點沒有說明（結構仍然正確，下次同步會補）：`);
    for (const id of missingProse.slice(0, 10)) log(deps, `    - ${id}`);
    if (missingProse.length > 10) log(deps, `    …其餘 ${missingProse.length - 10} 個`);
  }

  return stats;
}

async function writeOne(
  deps: DocsDeps,
  root: string,
  docsRoot: string,
  relDocsDir: string,
  fileDoc: core.docs.FileDoc,
  changed: Set<string>,
  ai: core.docs.DocAiConfig,
  index: SymbolIndex,
  missingProse: string[],
): Promise<{ abs: string; text: string; relMd: string } | undefined> {
  const mdAbs = path.join(root, fileDoc.relMd);
  const oldText = core.exists(mdAbs) ? core.readText(mdAbs) : '';
  const oldBlocks = core.docs.parseBlocks(oldText);

  // 需要新說明的節點：有變動、沒有舊區塊、或舊區塊沒有說明
  const needs: core.docs.MemberDoc[] = [];
  for (const cls of fileDoc.classes) {
    for (const member of cls.members) {
      const old = oldBlocks.get(member.id);
      const hasProse = old ? /^>\s+\S/m.test(old) : false;
      const mustWrite = changed.has(member.id) || !old || !hasProse;
      if (mustWrite) needs.push(member);
    }
  }

  const currentIds = new Set<string>();
  for (const cls of fileDoc.classes) for (const m of cls.members) currentIds.add(m.id);
  const currentClasses = fileDoc.classes.map((c) => c.name);
  const oldClasses = core.docs.classesIn(oldText);
  const classChanged =
    currentClasses.length !== oldClasses.length || currentClasses.some((name) => !oldClasses.includes(name));
  const structureChanged =
    classChanged || currentIds.size !== oldBlocks.size || [...currentIds].some((id) => !oldBlocks.has(id));

  if (!needs.length && oldText && !structureChanged) return undefined;

  // 呼叫鏈：只對要重寫的節點問（CallHierarchy 是 round-trip，很貴）
  const calls = new Map<string, core.docs.CallLink[]>();
  for (const member of needs) {
    const links = await outgoingLinks(root, fileDoc.relCs, member, index);
    if (links.length) calls.set(member.id, links);
  }

  let prose = new Map<string, string>();
  if (needs.length) {
    const items = needs.map((m) => ({ id: m.id, signature: m.signature, code: m.code }));
    const result = await core.docs.writeProse(ai, items, (line) => log(deps, line));
    prose = result.prose;
    if (result.failed.length) {
      log(deps, `  ⚠️  ${fileDoc.relMd}：${result.failed.length}/${items.length} 個節點沒有說明（下次同步會補）`);
      for (const id of result.failed) missingProse.push(id);
    }
  }

  const classes = fileDoc.classes.map((cls) => ({
    name: cls.name,
    anchor: cls.anchor,
    blocks: cls.members.map((member) => {
      const old = oldBlocks.get(member.id);
      if (old && !changed.has(member.id) && /^>\s+\S/m.test(old)) return old;

      // 名稱/簽章沒變但呼叫鏈可能變了：必要時只換連結行
      const text = core.docs.renderMember(member, prose.get(member.id) ?? legacyProse(old), calls.get(member.id) ?? []);
      return text;
    }),
  }));

  const next = core.docs.renderFile(fileDoc.relCs, classes);
  if (next === oldText) return undefined;

  return { abs: mdAbs, text: next, relMd: fileDoc.relMd };
}

/** 重寫時若 AI 沒回話，沿用舊區塊裡的說明，不要把它刪掉。 */
function legacyProse(old: string | undefined): string {
  if (!old) return '';
  const m = /^>\s+(.+)$/m.exec(old);
  return m ? m[1].trim() : '';
}

function removeDoc(docsRoot: string, relDocsDir: string, relCs: string): void {
  const relMd = core.docs.mdRelPath(relCs, relDocsDir);
  const abs = path.join(path.dirname(docsRoot), relMd);
  core.removeFile(abs);
  core.docs.pruneEmptyDirs(path.dirname(abs), docsRoot);
}

// ── 符號與呼叫鏈 ────────────────────────────────────────────────────────────

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);

const MEMBER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
]);

class SymbolIndex {
  private readonly cache = new Map<string, core.docs.FileDoc | null>();

  constructor(
    private readonly root: string,
    private readonly relDocsDir: string,
  ) {}

  async get(absPath: string): Promise<core.docs.FileDoc | undefined> {
    const key = absPath.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const relCs = path.relative(this.root, absPath).replace(/\\/g, '/');
    const relMd = core.docs.mdRelPath(relCs, this.relDocsDir);

    let doc: core.docs.FileDoc | undefined;
    try {
      const textDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        textDoc.uri,
      );
      if (symbols?.length) doc = toFileDoc(relCs, relMd, textDoc, symbols);
    } catch {
      doc = undefined;
    }

    this.cache.set(key, doc ?? null);
    return doc;
  }

  /** 由「檔案 + 行號」回推節點 id——比對呼叫目標時用，不依賴 detail 字串。 */
  async idAt(absPath: string, line: number): Promise<{ id: string; label: string } | undefined> {
    const fileDoc = await this.get(absPath);
    if (!fileDoc) return undefined;
    for (const cls of fileDoc.classes) {
      for (const member of cls.members) {
        if (line >= member.startLine && line <= member.endLine) {
          return { id: member.id, label: `${cls.name}.${member.name}` };
        }
      }
    }
    return undefined;
  }
}

function toFileDoc(
  relCs: string,
  relMd: string,
  doc: vscode.TextDocument,
  symbols: readonly vscode.DocumentSymbol[],
): core.docs.FileDoc {
  const classes: core.docs.ClassDoc[] = [];

  const visit = (symbol: vscode.DocumentSymbol): void => {
    if (CLASS_KINDS.has(symbol.kind)) {
      const members: core.docs.MemberDoc[] = [];
      for (const child of symbol.children ?? []) {
        if (!MEMBER_KINDS.has(child.kind)) continue;
        const detail = child.detail || child.name;
        members.push({
          id: core.docs.memberId(symbol.name, child.name, core.docs.paramTypesOf(child.detail)),
          kind: child.kind === vscode.SymbolKind.Property || child.kind === vscode.SymbolKind.Field ? 'property' : 'method',
          name: child.name,
          signature: detail,
          startLine: child.range.start.line,
          endLine: child.range.end.line,
          code: doc.getText(child.range),
        });
      }
      members.sort((a, b) => a.startLine - b.startLine);
      classes.push({
        name: symbol.name,
        anchor: core.docs.classAnchor(symbol.name),
        startLine: symbol.range.start.line,
        endLine: symbol.range.end.line,
        members,
      });
    }

    for (const child of symbol.children ?? []) visit(child);
  };

  for (const symbol of symbols) visit(symbol);
  classes.sort((a, b) => a.startLine - b.startLine);
  return { relCs, relMd, classes };
}

/** 對一個節點問 VS Code 的 CallHierarchy，拿它呼叫了誰。 */
async function outgoingLinks(
  root: string,
  relCs: string,
  member: core.docs.MemberDoc,
  index: SymbolIndex,
): Promise<core.docs.CallLink[]> {
  try {
    const uri = vscode.Uri.file(path.join(root, relCs));
    const position = namePosition(member);
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.executeCallHierarchyProvider',
      uri,
      position,
    );
    if (!items?.length) return [];

    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      'vscode.provideOutgoingCalls',
      items[0],
    );
    if (!calls?.length) return [];

    const links: core.docs.CallLink[] = [];
    for (const call of calls) {
      const target = await index.idAt(call.to.uri.fsPath, call.to.range.start.line);
      if (target) links.push({ id: target.id, label: target.label });
    }
    return links;
  } catch {
    return [];
  }
}

/**
 * CallHierarchy 需要「符號名稱的位置」，不是宣告開頭。
 * `public decimal CalculateFee(...)` 的第 0 欄是 `public`，問不到東西。
 */
function namePosition(member: core.docs.MemberDoc): vscode.Position {
  const code = member.code;
  const idx = code.indexOf(member.name);
  if (idx < 0) return new vscode.Position(member.startLine, 0);

  const before = code.slice(0, idx);
  const newlines = before.split('\n');
  const line = member.startLine + newlines.length - 1;
  const character = newlines[newlines.length - 1].length;
  return new vscode.Position(line, character);
}

// ── AI 設定 ─────────────────────────────────────────────────────────────────

async function aiConfig(deps: DocsDeps): Promise<core.docs.DocAiConfig> {
  const cfg = deps.config();
  return {
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: cfg.get<string>('model', ''),
    apiKey: (await deps.secrets.get(KEY_SECRET)) ?? '',
  };
}

function log(deps: DocsDeps, line: string): void {
  deps.out.appendLine(line);
}

function report(deps: DocsDeps, stats: RunStats): void {
  deps.out.show(true);
  deps.out.appendLine('');
  deps.out.appendLine(
    `完成：處理 ${stats.files} 檔、重寫 ${stats.rewritten} 份文件、移除 ${stats.removed} 份（${stats.mode}）`,
  );
  if (stats.mode === 'none') return;
  void vscode.window.setStatusBarMessage(
    `$(check) S-IDE docs：${stats.rewritten} 份更新（${stats.files} 檔）`,
    4000,
  );
}
