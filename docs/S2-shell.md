# S2 — VS Code 外掛殼

## 目標

把 S0/S1 的管線接到 VS Code，**但不把邏輯寫進外掛裡**。

外掛只做接線：宿主給事件，core 做決策。

---

## 全部工作 = 9 個 API

| 功能 | VS Code 機制 | 說明 |
|---|---|---|
| 中文關鍵字高亮 | `contributes.grammars` + `syntaxes/sem.tmLanguage.json` | **宣告檔，零程式邏輯** |
| 括號配對、註解符號 | `language-configuration.json` | 同上 |
| `[[類別.方法]]` 可點擊 | `languages.registerDocumentLinkProvider` | |
| 斷鏈紅線 | `languages.createDiagnosticCollection` | 指向不存在的單元 |
| 存檔觸發管線 | `workspace.onDidSaveTextDocument` | **存檔才觸發** |
| 執行 `dotnet` | `child_process.spawn` | extension host 就是 Node |
| 顯示 context map / manifest diff | `window.createOutputChannel` | 最便宜的呈現方式 |
| 全刪重生 | `commands.registerCommand` | |
| 狀態列（生成中／成功／失敗） | `window.createStatusBarItem` | |

> 注意這裡**沒有**：Electron、Monaco、xterm.js、檔案樹、打包器、更新器。
> 那些全部是宿主給的。這就是寄生的價值。

---

## 分層規則（本階段最重要的一條）

```
src/extension.ts        ← 薄 adapter：只接線，不做邏輯
src/core/**             ← 純 Node + TS，禁止 import 'vscode'
```

**用 lint 強制**（一行 eslint 規則）：

```
"no-restricted-imports": ["error", { "paths": ["vscode"] }]   // 只套用在 src/core/**
```

**理由：** 寄生的代價是綁死宿主。這條規則保住未來脫離宿主的自由——要改成 CLI、要跑在 CI、要獨立成 app，core 都不用重寫。

**判斷標準：** 一個檔案若需要 `import 'vscode'`，它就不屬於 core。

**另外一條硬規則（理由見 [S1 文件](S1-incremental.md)）：** `src/core/` **禁用 `fs.rmSync`**。
它對中文路徑會讓 Node 硬崩潰（`0xC0000409`），而本專案的檔名全是中文。刪檔用 `fs.unlinkSync`。

---

## 高亮 token 清單（TextMate grammar）

| scope | 內容 |
|---|---|
| `keyword.control.sem` | `如果` `否則如果` `否則` `每個` `重複` `返回` `拋出` `嘗試` `捕捉` |
| `keyword.declaration.sem` | `類別` `方法` `資料` `契約` `使用` |
| `storage.modifier.sem` | `【並行處理】` `【獨佔鎖定】` `【非同步】` `【僅內部】` |
| `entity.name.type.sem` | 型別名（`字串` `整數` …） |
| `string.quoted.sem` | `"..."` |
| `comment.line.sem` | `#` 到行尾 |
| `markup.underline.link.sem` | `[[類別.方法]]` |

> **視覺目的**：關鍵字變色，其餘中文敘述保持常規色 → 一眼看出「這是規格，不是程式」。
> 這是整個 demo 裡成本最低、效果最直接的一拍。

---

## 斷鏈偵測（免費的規格 lint）

`DocumentLinkProvider` 解析 `[[類別.方法]]` 時：

| 情況 | 行為 |
|---|---|
| 目標存在 | 產生可點擊連結，點擊跳到目標 `.sem` 的對應行 |
| 目標不存在 | **產生 `Diagnostic`，畫紅線** |

解析方式：**regex 掃全 workspace 的 `.sem`**，不需語意分析——這正是 [定址規則](01-sem-v0.md) 的紅利。

> **這個功能比高亮與跳轉更有說服力。**
> 「我們在完全沒有底層程式碼的狀態下，靠純文字拓撲抓出了規格層的斷鏈。」

---

## 輸出面板

`OutputChannel` 顯示三樣東西（demo 時直接打在投影幕上）：

1. **context map JSON** —「看，這就是 AI 看到的全部。」展示 context 是被裁剪過的
2. **manifest diff** — 改一行後，N 個 unit 裡只有 1 個 cacheKey 變
3. **每次生成的 prompt 版本與 token 用量**

---

## 啟動設定

```json
"activationEvents": ["workspaceContains:**/*.sem"]
```

**不要用 `*`。** 否則每次開 VS Code 都啟動外掛，拖慢所有人的啟動時間。

---

## 驗收

1. 開一個含 `.sem` 的資料夾 → 外掛自動啟用，關鍵字上色
2. `Ctrl + 點擊` `[[類別.方法]]` → 跳轉到目標檔案的正確行
3. 把目標方法改名 → **當場出現紅線**
4. 存檔 → 觸發管線，狀態列顯示進度
5. 改一行 body → OutputChannel 的 manifest diff 顯示**只有 1 個 unit 變**
6. **`src/core/**` 對 `vscode` 零相依**（`grep -r "from 'vscode'" src/core` 為空）

---

## 明確不做

| 不做 | 理由 |
|---|---|
| Webview 面板 | `OutputChannel` 就夠；Webview 是 v1 的「拓撲看板」 |
| 樹狀檢視、自訂側邊欄 | 內建檔案樹就能過濾 `.sem`，不需要 |
| 設定頁 | S4 |
| 打包成 vsix | S4 |
