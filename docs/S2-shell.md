# S2 — VS Code 外掛殼

> ⚠️ **本文是 S2 當時的狀態記錄。** 之後有兩項文法變更：
> 連結語法由 `[[類別.方法]]` 改為**反引號** `` `類別.方法` ``；
> 修飾符（`【...】`）全部廢除。以 [01-sem-v0.md](01-sem-v0.md) 為準。

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

## 進入點慣例

後台是一個 console 專案，它總得知道要呼叫什麼。慣例：

```sem
類別 程式 {
    方法 主 { ... }
}
```

`Program.cs` 由 harness **機械生成**（不經 AI）：

```csharp
using SemanticBackend;
using SIDE.Prelude;

Console.OutputEncoding = System.Text.Encoding.UTF8;
Telemetry.Step("程式啟動");

var 入口 = new 程式();
入口.主();
```

沒有這個類別時，`Program.cs` 會生成一段「未定義進入點」的提示，而不是編譯失敗。

---

## 驗收（已實測）

| # | 項目 | 結果 |
|---|---|---|
| 1 | workspace 級管線（多個 `.sem` 共用一個後台專案） | ✅ 掃描、生成、manifest 都是 workspace 級 |
| 2 | 首次使用自動 scaffold `.semantic_backend` | ✅ 含 `Backend.csproj`、`Program.cs`、`Prelude/`、`S-IDE.md` |
| 3 | 無改動 | ✅ 沿用 6、重生 0 |
| 4 | 只改一行 body | ✅ **沿用 5、重生 1** |
| 5 | 斷鏈（`[[不存在.方法]]`） | ✅ 報錯並**阻斷生成** |
| 6 | 類別重複定義 | ✅ 報錯並阻斷生成 |
| 7 | 刪掉 `Generated/` 完全重建 | ✅ 6 個 unit 全部重生並執行成功 |
| 8 | 分層規則 | ✅ `npm run check` 通過：`src/core/` 對 `vscode` 零相依 |
| 9 | 業務時序鏈輸出 | ✅ `程式.主 → 建立樣本 → 計算單層箱數` |

**未經 VS Code GUI 實測**：高亮上色、DocumentLink 的 Ctrl+click、診斷紅線的視覺呈現、狀態列。
這些需要真的開一個 Extension Development Host 才看得到，程式碼已編譯通過但沒有 GUI 驗證。

---

## 實作後補的兩個決策

### 1. DocumentLink 不夠，還要 DefinitionProvider

`DocumentLink` 的 `target` 只接受 `Uri`，而 **VS Code 對檔案 Uri 會忽略 fragment** ——
所以 Ctrl+click 只會「開啟目標檔案」，**不會跳到那一行**。

要精確跳行，必須另外註冊 `DefinitionProvider`（回傳 `Location` + `Position`）。
因此兩個都註冊：DocumentLink 負責把 `[[...]]` 畫成可點擊的藍色連結，DefinitionProvider 負責精確定位。

> 白皮書原本寫「DocumentLinkProvider 會跳轉到對應行數」，這是錯的。

### 2. ⚠️ 修飾符不能只靠 prompt（重要）

原本以為 `【獨佔鎖定】` → `SemaphoreSlim` 只是 prompt 的一條規則。**不是。**

鎖物件必須是一個**欄位**，否則 AI 只能在方法內 `new SemaphoreSlim(1,1)`——
每一次呼叫都拿一把新鎖，**完全沒有互斥效果**。而欄位落在 `契約` 區，屬於 harness 的職責。

所以修飾符的正確實作是：

| 層 | 要做的事 |
|---|---|
| harness | 從 `契約` 或修飾符推導出**欄位宣告**，寫進 `<類別>.Fields.g.cs` |
| harness | 對 `【並行處理】` 決定方法簽章要不要 `async`（簽章是 harness 生成的） |
| prompt | 才輪到「在 body 裡使用那個欄位」 |

**這推翻了「四個中文字 → 完整機制」的想像**：機制的一半在 harness 的程式碼生成裡，不在 prompt 裡。
這是 **S3** 的工作，也是這份文件目前最重要的一條修正。

---

## 明確不做

| 不做 | 理由 |
|---|---|
| Webview 面板 | `OutputChannel` 就夠；Webview 是 v1 的「拓撲看板」 |
| 樹狀檢視、自訂側邊欄 | 內建檔案樹就能過濾 `.sem`，不需要 |
| 設定頁 | S4 |
| 打包成 vsix | S4 |
