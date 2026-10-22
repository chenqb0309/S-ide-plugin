import * as path from 'node:path';
import * as vscode from 'vscode';
import * as core from '../core';
import { normalizeLang, uiFor, type UiStrings } from '../i18n';

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
  const lang = normalizeLang(deps.config().get<string>('language'));
  const t = uiFor(lang);

  if (!root) {
    void vscode.window.showErrorMessage(t.openFolderFirst);
    return;
  }

  // No AI, no product: refuse to emit structure without descriptions.
  const ai = await aiConfig(deps);
  if (!ai.apiKey || !ai.model) {
    const action = await vscode.window.showErrorMessage(t.noApiConfig, t.btnSetKey, t.btnOpenSettings);
    if (action === t.btnSetKey) await vscode.commands.executeCommand('side.setApiKey');
    else if (action === t.btnOpenSettings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'side.model');
    }
    return;
  }

  running = true;

  try {
    const stats = await runSync(deps, root, mode, ai, t, lang);
    report(deps, stats, t, lang);
  } catch (e) {
    const msg = (e as Error).message;
    deps.out.appendLine(`ERROR ${t.syncFailed(msg)}`);
    deps.out.show(true);
    void vscode.window.showErrorMessage(`S-IDE: ${msg}`);
  } finally {
    running = false;
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
  t: UiStrings,
  language: 'en' | 'zh-TW',
): Promise<RunStats> {
  const cfg = deps.config();
  const relDocsDir = cfg.get<string>('docsDir', core.docs.DOCS_DIR_DEFAULT) || core.docs.DOCS_DIR_DEFAULT;
  const labels = core.docs.labelsFor(language);
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

  const decision =
    forced === 'full'
      ? { mode: 'full' as const, reasonText: t.reasonForced }
      : marker && marker.language && marker.language !== language
        ? { mode: 'full' as const, reasonText: t.reasonLanguage(marker.language, language) }
        : (() => {
            const d = core.docs.decide({
              hasGit,
              hasMarker: marker !== null,
              markerVersion: marker?.version ?? 0,
              baseline,
              changes: [...changes, ...diffed],
              relDocsDir,
            });
            return { mode: d.mode, reasonText: reasonText(d, t) };
          })();

  log(deps, t.modeLine(decision.mode, decision.reasonText));

  if (decision.mode === 'none') {
    void vscode.window.showInformationMessage(t.upToDate);
    return { mode: 'none', reason: decision.reasonText, files: 0, rewritten: 0, removed: 0 };
  }

  const stats: RunStats = {
    mode: decision.mode,
    reason: decision.reasonText,
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

  // 全量：每一輪都要完整圖，用 references 反推（每個成員一次查詢）。
  // 增量：outgoing 只取決於「呼叫者自己的 body」，所以只掃變動檔案裡的呼叫點，
  //       用 definition 精準解析——不需要全域圖，也不需要快取。
  const universe = decision.mode === 'full' ? collectUniverse(targets, docsRoot, relDocsDir) : [...targets.keys()];

  const graph = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t.progressGraph, cancellable: true },
    async (progress, token) => {
      const tick = (rel: string, increment: number): void => progress.report({ message: rel, increment });
      const logLine = (line: string): void => log(deps, line);
      return decision.mode === 'full'
        ? buildCallGraph(index, root, universe, tick, token, logLine, t)
        : buildCallGraphLocal(index, root, universe, tick, token, logLine, t);
    },
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t.progressSync, cancellable: true },
    async (progress, token) => {
      let done = 0;
      for (const [relCs, how] of [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (token.isCancellationRequested) break;
        progress.report({ message: relCs, increment: 100 / targets.size });

        const fileDoc = await index.get(path.join(root, relCs));
        if (!fileDoc) {
          log(deps, t.skippedNoSymbols(relCs));
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

        const out = await writeOne(deps, root, docsRoot, relDocsDir, fileDoc, changed, ai, graph, missingProse, labels, t);
        if (out) {
          pending.push(out);
          stats.rewritten += 1;
        }
        stats.files += 1;
        done += 1;
      }
      if (done === 0 && targets.size) log(deps, t.noFilesProcessed);
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

  core.docs.writeIndex(docsRoot, labels);
  // 版本升級或語言切換時也要更新；否則 marker 會停在舊狀態，每次同步都判定不一致。
  if (!marker || marker.version !== core.docs.DOC_VERSION || marker.language !== language) {
    core.docs.writeMarker(docsRoot, marker, language);
  }

  // 這是一個會靜默漏改動的坑：semDocs 還沒 commit 時，baseline 只能退到 HEAD；
  // 一旦使用者先 commit 了 code，那個改動就從 diff 消失了。先講清楚。
  if (hasGit && !core.docs.isDirTracked(root, relDocsDir)) {
    log(deps, '');
    log(deps, t.notTrackedWarning);
    log(deps, t.baselineWarning);
    log(deps, t.commitWarning(relDocsDir));
  }

  if (missingProse.length) {
    log(deps, '');
    log(deps, t.missingProse(missingProse.length));
    for (const id of missingProse.slice(0, 10)) log(deps, `    - ${id}`);
    if (missingProse.length > 10) log(deps, t.missingMore(missingProse.length - 10));
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
  graph: Map<string, core.docs.CallLink[]>,
  missingProse: string[],
  labels: core.docs.DocLabels,
  t: UiStrings,
): Promise<{ abs: string; text: string; relMd: string } | undefined> {
  const mdAbs = path.join(root, fileDoc.relMd);
  const oldText = core.exists(mdAbs) ? core.readText(mdAbs) : '';
  const oldBlocks = core.docs.parseBlocks(oldText);

  // 需要新說明的節點：有變動、沒有舊區塊、或舊區塊沒有說明
  const needs: core.docs.MemberDoc[] = [];
  for (const cls of fileDoc.classes) {
    for (const member of cls.members) {
      const old = oldBlocks.get(member.anchor);
      const mustWrite = changed.has(member.id) || !old || !core.docs.hasProse(old);
      if (mustWrite) needs.push(member);
    }
  }

  const currentAnchors = new Set<string>();
  for (const cls of fileDoc.classes) {
    if (cls.props.length) currentAnchors.add(core.docs.propsAnchor(labels));
    for (const m of cls.members) currentAnchors.add(m.anchor);
  }
  const currentClasses = fileDoc.classes.map((c) => c.name);
  const oldClasses = core.docs.classesIn(oldText);
  const classChanged =
    currentClasses.length !== oldClasses.length || currentClasses.some((name) => !oldClasses.includes(name));
  const structureChanged =
    classChanged || currentAnchors.size !== oldBlocks.size || [...currentAnchors].some((a) => !oldBlocks.has(a));

  if (!needs.length && oldText && !structureChanged) return undefined;

  let prose: core.docs.ProseMap = new Map();
  if (needs.length) {
    const items = needs.map((m) => ({ id: m.id, signature: m.signature, code: m.code }));
    const result = await core.docs.writeProse(ai, items, (line) => log(deps, line));
    prose = result.prose;
    if (result.failed.length) {
      log(deps, t.missingProseFile(fileDoc.relMd, result.failed.length, items.length));
      for (const id of result.failed) missingProse.push(id);
    }
  }

  const classes = fileDoc.classes.map((cls) => ({
    name: cls.name,
    props: cls.props,
    blocks: cls.members.map((member) => {
      const old = oldBlocks.get(member.anchor);
      if (old && !changed.has(member.id) && core.docs.hasProse(old)) return old;

      // 有變動但這次拿不到說明時，寧可留白（會被回報），也不要沿用舊的可能已錯的敘述
      const text = core.docs.renderMember(member, prose.get(member.id), graph.get(member.id) ?? [], fileDoc.relMd, labels);
      return text;
    }),
  }));

  const next = core.docs.renderFile(fileDoc.relCs, classes, labels);
  if (next === oldText) return undefined;

  return { abs: mdAbs, text: next, relMd: fileDoc.relMd };
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
]);

class SymbolIndex {
  private readonly cache = new Map<string, core.docs.FileDoc | null>();
  private readonly uris = new Map<string, vscode.Uri>();

  constructor(
    private readonly root: string,
    private readonly relDocsDir: string,
  ) {}

  /** 用「實際被打開的那份文件」的 uri，避免自己重拼造成 LSP 對不上。 */
  async uriOf(absPath: string): Promise<vscode.Uri | undefined> {
    const key = absPath.toLowerCase();
    const cached = this.uris.get(key);
    if (cached) return cached;

    try {
      const textDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      this.uris.set(key, textDoc.uri);
      return textDoc.uri;
    } catch {
      return undefined;
    }
  }

  async get(absPath: string): Promise<core.docs.FileDoc | undefined> {
    const key = absPath.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const relCs = path.relative(this.root, absPath).replace(/\\/g, '/');
    const relMd = core.docs.mdRelPath(relCs, this.relDocsDir);

    let doc: core.docs.FileDoc | undefined;
    try {
      const textDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      this.uris.set(key, textDoc.uri);
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

  /** 由「檔案 + 行號」回推節點——比對呼叫目標時用，不依賴 detail 字串。 */
  async idAt(
    absPath: string,
    line: number,
  ) : Promise<{
    id: string;
    label: string;
    relMd: string;
    anchor: string;
    isInterface: boolean;
    nameLine: number;
    nameCharacter: number;
  } | undefined> {
    const fileDoc = await this.get(absPath);
    if (!fileDoc) return undefined;
    for (const cls of fileDoc.classes) {
      for (const member of cls.members) {
        if (line >= member.startLine && line <= member.endLine) {
          return {
            id: member.id,
            label: `${cls.name}.${member.name}`,
            relMd: fileDoc.relMd,
            anchor: member.anchor,
            isInterface: cls.isInterface,
            nameLine: member.nameLine,
            nameCharacter: member.nameCharacter,
          };
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
  /** 檔案內的名稱計數：用來決定多載要不要把參數型別寫進標題 */
  const nameCounts = new Map<string, number>();

  const visit = (symbol: vscode.DocumentSymbol, outer: string[]): void => {
    const isType = CLASS_KINDS.has(symbol.kind);
    const path = isType ? [...outer, symbol.name] : outer;

    if (isType) {
      const members: core.docs.MemberDoc[] = [];
      const props: Array<{ name: string; type: string }> = [];

      for (const child of symbol.children ?? []) {
        // field 是實作細節（_context、_dbSet），不是業務節點
        if (!MEMBER_KINDS.has(child.kind)) continue;

        const raw = child.detail || child.name;
        const bare = core.docs.bareName(raw);
        // C# 有時把建構子回報成 Method，名字會等於 class 名（泛型類別要去掉 <T> 再比）
        const classBare = symbol.name.replace(/<[^<>]*>/g, '').trim();
        const isCtor = child.kind === vscode.SymbolKind.Constructor || bare === classBare;
        const name = isCtor ? 'ctor' : bare;
        const code = doc.getText(child.range);
        const params = core.docs.paramTypesOf(raw);

        // 純 auto-property 不進 AI，只列進「屬性一覽」
        if (child.kind === vscode.SymbolKind.Property && core.docs.isTrivialProperty(code)) {
          props.push({ name, type: core.docs.typeOf(raw) });
          continue;
        }

        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
        members.push({
          id: core.docs.memberId(path.join('.'), name, params),
          heading: name,
          anchor: '',
          kind: child.kind === vscode.SymbolKind.Property ? 'property' : 'method',
          name,
          params,
          signature: raw,
          startLine: child.range.start.line,
          endLine: child.range.end.line,
          nameLine: child.selectionRange.start.line,
          nameCharacter: child.selectionRange.start.character,
          code,
        });
      }

      members.sort((a, b) => a.startLine - b.startLine);
      classes.push({
        name: symbol.name,
        heading: symbol.name,
        anchor: core.docs.classAnchor(path.join('.')),
        isInterface: symbol.kind === vscode.SymbolKind.Interface,
        startLine: symbol.range.start.line,
        endLine: symbol.range.end.line,
        members,
        props,
      });
    }

    for (const child of symbol.children ?? []) visit(child, path);
  };

  for (const symbol of symbols) visit(symbol, []);

  // 第二輪才決定標題：多載用參數型別；沒有參數可區分時用類別名（比 `(2)` 有意義）
  const usedAnchors = new Set<string>();
  for (const cls of classes) {
    for (const m of cls.members) {
      const duplicated = (nameCounts.get(m.name) ?? 0) > 1;
      const useClass = m.name === 'ctor' || m.params.length === 0;
      const qualifier = useClass ? core.docs.clampType(cls.name) : m.params.map(core.docs.clampType).join(', ');
      const label = duplicated ? `${m.name} (${qualifier})` : m.name;
      const { heading, anchor } = core.docs.uniqueHeading(label, usedAnchors);
      m.heading = heading;
      m.anchor = anchor;
    }
  }

  // 第三輪：類別標題也要唯一（巢狀類別可能同名），並與檔頭目錄的 anchor 對齊
  const usedClassAnchors = new Set<string>();
  for (const cls of classes) {
    const { heading, anchor } = core.docs.uniqueHeading(cls.name, usedClassAnchors);
    cls.heading = heading;
    cls.anchor = anchor;
  }

  classes.sort((a, b) => a.startLine - b.startLine);
  return { relCs, relMd, classes };
}

/** 全量時要覆蓋「所有已建文件」的成員，否則跨檔連結會漏。 */
function collectUniverse(
  targets: Map<string, 'full' | 'diff'>,
  docsRoot: string,
  relDocsDir: string,
): string[] {
  const all = new Set<string>(targets.keys());
  for (const relMd of core.docs.listDocFiles(docsRoot)) {
    all.add(core.docs.csRelFromMd(relMd, relDocsDir));
  }
  return [...all];
}

/** 這些不是呼叫，掃 body 時要跳過。 */
const NOT_CALLS = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'return', 'nameof', 'typeof', 'sizeof',
  'new', 'lock', 'fixed', 'checked', 'unchecked', 'throw', 'await', 'base', 'this', 'when', 'get', 'set',
  'init', 'value', 'default', 'is', 'as', 'in', 'out', 'ref',
]);

/**
 * 增量用：outgoing 的來源是「呼叫者的 body」，所以只掃變動檔案裡的呼叫點，
 * 每個呼叫點用 definition 精準解析（不是字串比對）。
 *
 * 成本＝變動檔案的呼叫點數，與專案大小無關。
 */
async function buildCallGraphLocal(
  index: SymbolIndex,
  root: string,
  relFiles: readonly string[],
  tick: (rel: string, increment: number) => void,
  token: vscode.CancellationToken,
  log: (line: string) => void,
  t: UiStrings,
): Promise<Map<string, core.docs.CallLink[]>> {
  const outgoing = new Map<string, core.docs.CallLink[]>();
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;

  let queries = 0;
  let edges = 0;
  let failed = 0;

  for (const relCs of relFiles) {
    if (token.isCancellationRequested) break;
    tick(relCs, relFiles.length ? 100 / relFiles.length : 0);

    const fileDoc = await index.get(path.join(root, relCs));
    const uri = await index.uriOf(path.join(root, relCs));
    if (!fileDoc || !uri) continue;

    for (const cls of fileDoc.classes) {
      for (const member of cls.members) {
        if (member.kind === 'property') continue;

        const seen = new Set<number>();
        callRe.lastIndex = 0;
        let hit: RegExpExecArray | null;

        while ((hit = callRe.exec(member.code))) {
          const name = hit[1];
          if (NOT_CALLS.has(name)) continue;

          const at = hit.index;
          if (seen.has(at)) continue;
          seen.add(at);

          const pos = positionInMember(member, at);
          queries += 1;

          try {
            const defs = await vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeDefinitionProvider',
              uri,
              pos,
            );
            // 同一個呼叫點可能同時解析到介面與實作：只留一條，優先介面
            let chosen: {
              id: string;
              label: string;
              relMd: string;
              anchor: string;
              isInterface: boolean;
            } | undefined;

            for (const def of defs ?? []) {
              if (!def.uri.fsPath.toLowerCase().endsWith('.cs')) continue;
              const target = await index.idAt(def.uri.fsPath, def.range.start.line);
              if (!target || target.id === member.id) continue;
              if (!chosen || (!chosen.isInterface && target.isInterface)) chosen = target;
            }

            if (chosen) {
              const list = outgoing.get(member.id) ?? [];
              list.push({ id: chosen.id, label: chosen.label, relMd: chosen.relMd, anchor: chosen.anchor });
              outgoing.set(member.id, list);
              edges += 1;
            }
          } catch {
            failed += 1;
          }
        }
      }
    }
  }

  log(t.callGraphLocal(queries, edges, failed));
  return outgoing;
}

/** 把「成員程式碼內的位移」換算成文件的絕對位置。 */
function positionInMember(member: core.docs.MemberDoc, offset: number): vscode.Position {
  const before = member.code.slice(0, offset).split('\n');
  return new vscode.Position(member.startLine + before.length - 1, before[before.length - 1].length);
}

/**
 * C# 的 call hierarchy 在部分環境沒有註冊（prepare 一律回空），
 * 但 references 是好的（CodeLens 的「N 個參考」就是它算的）。
 *
 * 做法：對每個成員問「誰參考我」→ 每個參考位置回推它落在哪個成員裡 → 得到 caller → callee。
 */
async function buildCallGraph(
  index: SymbolIndex,
  root: string,
  relFiles: readonly string[],
  tick: (rel: string, increment: number) => void,
  token: vscode.CancellationToken,
  log: (line: string) => void,
  t: UiStrings,
): Promise<Map<string, core.docs.CallLink[]>> {
  const outgoing = new Map<string, core.docs.CallLink[]>();
  const candidates = new Map<
    string,
    { callerId: string; link: core.docs.CallLink; isInterface: boolean }
  >();
  const members: Array<{
    relCs: string;
    relMd: string;
    member: core.docs.MemberDoc;
    label: string;
    isInterface: boolean;
  }> = [];

  for (const relCs of relFiles) {
    const fileDoc = await index.get(path.join(root, relCs));
    if (!fileDoc) continue;
    for (const cls of fileDoc.classes) {
      for (const m of cls.members) {
        members.push({
          relCs,
          relMd: fileDoc.relMd,
          member: m,
          label: `${cls.name}.${m.name}`,
          isInterface: cls.isInterface,
        });
      }
    }
  }

  let ok = 0;
  let empty = 0;
  let failed = 0;

  for (const entry of members) {
    if (token.isCancellationRequested) break;
    tick(entry.relCs, members.length ? 100 / members.length : 0);

    const uri = await index.uriOf(path.join(root, entry.relCs));
    if (!uri) {
      failed += 1;
      continue;
    }

    let refs: vscode.Location[] | undefined;
    try {
      refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        namePosition(entry.member),
      );
    } catch {
      failed += 1;
      continue;
    }

    if (!refs?.length) {
      empty += 1;
      continue;
    }
    ok += 1;

    for (const ref of refs) {
      const caller = await index.idAt(ref.uri.fsPath, ref.range.start.line);
      if (!caller || caller.id === entry.member.id) continue;

      // 落在呼叫者自己的宣告上 → 那是「實作介面」，不是呼叫
      if (ref.range.start.line === caller.nameLine && ref.range.start.character === caller.nameCharacter) continue;

      // 同一個呼叫點可能同時回報介面與實作；用位置去重，優先留介面
      const key = `${caller.id}@${ref.uri.fsPath.toLowerCase()}:${ref.range.start.line}:${ref.range.start.character}`;
      const candidate = {
        callerId: caller.id,
        link: { id: entry.member.id, label: entry.label, relMd: entry.relMd, anchor: entry.member.anchor },
        isInterface: entry.isInterface,
      };
      const prev = candidates.get(key);
      if (!prev || (!prev.isInterface && candidate.isInterface)) candidates.set(key, candidate);
    }
  }

  for (const c of candidates.values()) {
    const list = outgoing.get(c.callerId) ?? [];
    list.push(c.link);
    outgoing.set(c.callerId, list);
  }

  log(t.callGraphRefs(members.length, ok, empty, failed, outgoing.size));
  return outgoing;
}

/**
 * LSP 要的是「識別字本身的位置」。
 * 直接用 DocumentSymbol.selectionRange 的起點，不要自己從程式碼裡找字串——
 * 建構子被改名成 `ctor` 之後就找不到了。
 */
function namePosition(member: core.docs.MemberDoc): vscode.Position {
  return new vscode.Position(member.nameLine, member.nameCharacter);
}

// ── AI 設定 ─────────────────────────────────────────────────────────────────

async function aiConfig(deps: DocsDeps): Promise<core.docs.DocAiConfig> {
  const cfg = deps.config();
  return {
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: cfg.get<string>('model', ''),
    apiKey: (await deps.secrets.get(KEY_SECRET)) ?? '',
    lang: cfg.get<string>('language', 'en'),
  };
}

function log(deps: DocsDeps, line: string): void {
  deps.out.appendLine(line);
}

let lastSummary = '';

/** 側邊欄顯示用：上一次同步的結果摘要。 */
export function lastRunSummary(): string {
  return lastSummary;
}

/** 把 core 回傳的 reasonKey 翻成目前語言。 */
function reasonText(d: core.docs.Decision, t: UiStrings): string {
  switch (d.reasonKey) {
    case 'noMarker':
      return t.reasonNoMarker;
    case 'versionMismatch':
      return t.reasonVersion(Number(d.reasonParams?.from ?? 0), Number(d.reasonParams?.to ?? 0));
    case 'noGit':
      return t.reasonNoGit;
    case 'noCommits':
      return t.reasonNoCommits;
    case 'noChanges':
      return t.reasonNoChanges;
    case 'changed':
      return t.reasonChanged(Number(d.reasonParams?.count ?? 0));
  }
}

function report(deps: DocsDeps, stats: RunStats, t: UiStrings, language: 'en' | 'zh-TW'): void {
  deps.out.show(true);
  deps.out.appendLine('');
  deps.out.appendLine(t.completed(stats.files, stats.rewritten, stats.removed, stats.mode));

  const locale = language === 'zh-TW' ? 'zh-TW' : 'en-GB';
  const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  lastSummary =
    stats.mode === 'none'
      ? t.summaryUpToDate(time)
      : t.summaryUpdated(stats.rewritten, stats.files, time);

  if (stats.mode === 'none') return;
  void vscode.window.setStatusBarMessage(t.statusDone(stats.rewritten, stats.files), 4000);
}
