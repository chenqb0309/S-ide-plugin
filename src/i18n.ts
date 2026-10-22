/**
 * 執行期字串（Output、通知、側邊欄、設定頁）。
 *
 * 只跟 `side.language` 走。`package.json` 的命令標題／設定描述是靜態的，
 * 只能靠 `package.nls.*` 跟 VS Code 顯示語言——那是平台限制。
 */

export type Lang = 'en' | 'zh-TW';

export interface UiStrings {
  // extension
  activated: string;
  workspaceLine: (root: string) => string;
  noFolderOpen: string;
  sidebarHint: string;
  apiKeyTitle: string;
  apiKeyPrompt: string;
  apiKeySaved: string;

  // tree
  groupActions: string;
  groupDocs: string;
  actionSync: string;
  actionRebuild: string;
  actionSettings: string;
  notSynced: string;
  noDocuments: string;
  open: string;

  // settings panel
  settingsTitle: string;
  labelProvider: string;
  labelBaseUrl: string;
  labelModel: string;
  labelApiKey: string;
  labelDocsDir: string;
  labelLanguage: string;
  languageHint: string;
  keySet: string;
  keyNotSet: string;
  btnSave: string;
  btnTest: string;
  testing: string;
  settingsSaved: string;
  missingBase: string;
  missingKey: string;
  emptyResponse: (ms: number) => string;
  testPrompt: string;
  customProvider: string;

  // sync
  openFolderFirst: string;
  noApiConfig: string;
  btnSetKey: string;
  btnOpenSettings: string;
  upToDate: string;
  progressGraph: string;
  progressSync: string;
  skippedNoSymbols: (file: string) => string;
  noFilesProcessed: string;
  notTrackedWarning: string;
  baselineWarning: string;
  commitWarning: (dir: string) => string;
  missingProse: (count: number) => string;
  missingProseFile: (file: string, failed: number, total: number) => string;
  missingMore: (count: number) => string;
  syncFailed: (message: string) => string;
  modeLine: (mode: string, reason: string) => string;
  completed: (files: number, rewritten: number, removed: number, mode: string) => string;
  summaryUpToDate: (time: string) => string;
  summaryUpdated: (rewritten: number, files: number, time: string) => string;
  statusDone: (rewritten: number, files: number) => string;
  callGraphRefs: (total: number, ok: number, empty: number, failed: number, outgoing: number) => string;
  callGraphLocal: (queries: number, edges: number, failed: number) => string;

  // plan reasons
  reasonNoMarker: string;
  reasonVersion: (from: number, to: number) => string;
  reasonNoGit: string;
  reasonNoCommits: string;
  reasonNoChanges: string;
  reasonChanged: (count: number) => string;
  reasonForced: string;
  reasonLanguage: (from: string, to: string) => string;
}

const EN: UiStrings = {
  activated: 'S-IDE is active.',
  workspaceLine: (root) => `  workspace: ${root}`,
  noFolderOpen: '(no folder open)',
  sidebarHint: '  semDocs: run "Sync Semantic Docs" from the sidebar',
  apiKeyTitle: 'S-IDE: API Key',
  apiKeyPrompt: 'Stored in VS Code SecretStorage only; never written to settings.json',
  apiKeySaved: 'S-IDE: API key saved.',

  groupActions: 'Actions',
  groupDocs: 'Documents',
  actionSync: 'Sync Semantic Docs',
  actionRebuild: 'Rebuild All',
  actionSettings: 'Settings',
  notSynced: 'Not synced yet',
  noDocuments: 'No documents yet; run "Sync Semantic Docs"',
  open: 'Open',

  settingsTitle: 'S-IDE Settings',
  labelProvider: 'Provider',
  labelBaseUrl: 'Base URL',
  labelModel: 'Model',
  labelApiKey: 'API Key',
  labelDocsDir: 'Documentation folder',
  labelLanguage: 'Language',
  languageHint: 'Affects generated documents and messages.',
  keySet: 'Key is set; leave blank to keep it',
  keyNotSet: 'Not set yet',
  btnSave: 'Save',
  btnTest: 'Test connection',
  testing: 'Testing...',
  settingsSaved: 'S-IDE: settings saved.',
  missingBase: 'Missing base URL or model',
  missingKey: 'API key is not set',
  emptyResponse: (ms) => `200 · ${ms}ms · (empty response)`,
  testPrompt: 'Reply with OK.',
  customProvider: 'Custom',

  openFolderFirst: 'S-IDE: open a folder first.',
  noApiConfig:
    'S-IDE: API key or model is not configured. Semantic docs need AI descriptions, so nothing was generated.',
  btnSetKey: 'Set API Key',
  btnOpenSettings: 'Open Settings',
  upToDate: 'S-IDE: semantic docs are up to date.',
  progressGraph: 'S-IDE: Building call graph',
  progressSync: 'S-IDE: Syncing semantic docs',
  skippedNoSymbols: (file) => `  Skipped ${file} (language server returned no symbols)`,
  noFilesProcessed: '  No files were processed',
  notTrackedWarning: 'WARN  documentation folder is not tracked by git yet.',
  baselineWarning:
    '    The baseline falls back to HEAD; if you commit code before syncing, that change is skipped.',
  commitWarning: (dir) => `    Commit ${dir}/ once now to make incremental sync reliable.`,
  missingProse: (count) =>
    `WARN  ${count} node(s) have no description (structure is still correct; the next sync retries):`,
  missingProseFile: (file, failed, total) =>
    `  WARN  ${file}: ${failed}/${total} node(s) have no description (next sync retries)`,
  missingMore: (count) => `    ...and ${count} more`,
  syncFailed: (message) => `semDocs sync failed: ${message}`,
  modeLine: (mode, reason) => `Mode: ${mode} — ${reason}`,
  completed: (files, rewritten, removed, mode) =>
    `Completed: ${files} file(s), ${rewritten} document(s) rewritten, ${removed} removed (${mode})`,
  summaryUpToDate: (time) => `Up to date · ${time}`,
  summaryUpdated: (rewritten, files, time) => `${rewritten} updated · ${files} file(s) · ${time}`,
  statusDone: (rewritten, files) => `$(check) S-IDE docs: ${rewritten} updated (${files} files)`,
  callGraphRefs: (total, ok, empty, failed, outgoing) =>
    `Call graph: ${total} nodes, ${ok} with references, ${empty} without, ${failed} failed (${outgoing} with outgoing)`,
  callGraphLocal: (queries, edges, failed) =>
    `Call graph (incremental): ${queries} call site(s), ${edges} edge(s), ${failed} failure(s)`,

  reasonNoMarker: 'No semantic docs yet; running a full build',
  reasonVersion: (from, to) => `Template version ${from} != ${to}; rebuilding everything`,
  reasonNoGit: 'Not a git repository; cannot diff, running a full build',
  reasonNoCommits: 'Repository has no commits yet; running a full build',
  reasonNoChanges: 'No .cs changes since the last sync',
  reasonChanged: (count) => `${count} .cs file(s) changed`,
  reasonForced: 'User requested a full rebuild',
  reasonLanguage: (from, to) => `Output language ${from} -> ${to}; rebuilding everything`,
};

const ZH_TW: UiStrings = {
  activated: 'S-IDE 已啟用。',
  workspaceLine: (root) => `  工作區：${root}`,
  noFolderOpen: '(未開啟資料夾)',
  sidebarHint: '  semDocs：從側邊欄按「同步語義文件」',
  apiKeyTitle: 'S-IDE: API Key',
  apiKeyPrompt: '只存在 VS Code 的加密儲存區，不會寫進 settings.json',
  apiKeySaved: 'S-IDE：API Key 已儲存。',

  groupActions: '動作',
  groupDocs: '文件',
  actionSync: '同步語義文件',
  actionRebuild: '重建全部',
  actionSettings: '設定',
  notSynced: '尚未同步',
  noDocuments: '還沒有文件，先按「同步語義文件」',
  open: '開啟',

  settingsTitle: 'S-IDE 設定',
  labelProvider: '供應商',
  labelBaseUrl: 'Base URL',
  labelModel: '模型',
  labelApiKey: 'API Key',
  labelDocsDir: '文件目錄',
  labelLanguage: '語言',
  languageHint: '影響產出的文件與訊息。',
  keySet: '已設定；留空則不變更',
  keyNotSet: '尚未設定',
  btnSave: '儲存',
  btnTest: '測試連線',
  testing: '測試中…',
  settingsSaved: 'S-IDE：設定已儲存。',
  missingBase: '缺少 baseUrl 或 model',
  missingKey: '尚未設定 API Key',
  emptyResponse: (ms) => `200 · ${ms}ms ·（空回應）`,
  testPrompt: '回覆 OK 兩個字',
  customProvider: '自訂',

  openFolderFirst: 'S-IDE：請先開啟一個資料夾。',
  noApiConfig: 'S-IDE：尚未設定 API Key 或模型。語義文件需要 AI 產生說明，因此不會執行。',
  btnSetKey: '設定 API Key',
  btnOpenSettings: '開啟設定',
  upToDate: 'S-IDE：語義文件已同步，沒有需要更新的地方。',
  progressGraph: 'S-IDE：建立呼叫圖',
  progressSync: 'S-IDE：同步語義文件',
  skippedNoSymbols: (file) => `  跳過 ${file}（語言伺服器沒有回傳符號）`,
  noFilesProcessed: '  沒有任何檔案被處理',
  notTrackedWarning: '⚠️  文件目錄還沒納入版控。',
  baselineWarning: '    目前 baseline 會退到 HEAD；若你先 commit code 再同步，那次改動會被漏掉。',
  commitWarning: (dir) => `    建議現在 commit 一次 ${dir}/，之後增量才會穩定。`,
  missingProse: (count) => `⚠️  ${count} 個節點沒有說明（結構仍然正確，下次同步會補）：`,
  missingProseFile: (file, failed, total) =>
    `  ⚠️  ${file}：${failed}/${total} 個節點沒有說明（下次同步會補）`,
  missingMore: (count) => `    …其餘 ${count} 個`,
  syncFailed: (message) => `semDocs 同步失敗：${message}`,
  modeLine: (mode, reason) => `模式：${mode} —— ${reason}`,
  completed: (files, rewritten, removed, mode) =>
    `完成：處理 ${files} 檔、重寫 ${rewritten} 份文件、移除 ${removed} 份（${mode}）`,
  summaryUpToDate: (time) => `已同步 · ${time}`,
  summaryUpdated: (rewritten, files, time) => `${rewritten} 份更新 · ${files} 檔 · ${time}`,
  statusDone: (rewritten, files) => `$(check) S-IDE docs：${rewritten} 份更新（${files} 檔）`,
  callGraphRefs: (total, ok, empty, failed, outgoing) =>
    `呼叫圖：${total} 個節點，${ok} 有參考、${empty} 無參考、${failed} 查詢失敗（${outgoing} 個有 outgoing）`,
  callGraphLocal: (queries, edges, failed) =>
    `呼叫圖（增量）：${queries} 個呼叫點，${edges} 條邊、${failed} 次失敗`,

  reasonNoMarker: '尚未建立 semDocs，執行全量建置',
  reasonVersion: (from, to) => `文件模板版本 ${from} ≠ ${to}，全量重建`,
  reasonNoGit: '此專案不是 git repo，無法比對變動，全量重建',
  reasonNoCommits: '此 repo 還沒有任何 commit，無從比較，全量重建',
  reasonNoChanges: '自上次同步以來沒有任何 .cs 變動',
  reasonChanged: (count) => `${count} 個 .cs 有變動`,
  reasonForced: '使用者要求全量重建',
  reasonLanguage: (from, to) => `輸出語言 ${from} → ${to}，全量重建`,
};

export function uiFor(lang: string | undefined): UiStrings {
  return lang === 'zh-TW' ? ZH_TW : EN;
}

export function normalizeLang(lang: string | undefined): Lang {
  return lang === 'zh-TW' ? 'zh-TW' : 'en';
}
