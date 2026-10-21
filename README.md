# S-IDE

> 把既有的 C# 原始碼翻成「帶呼叫鏈的 Markdown 文件群」，讓人看得懂程式在做什麼。

按一個按鈕（狀態列／命令面板／Source Control 標題列），在 `semDocs/` 產生對應的文件。
code 是真相，Markdown 是可拋棄的投影。

## 這個 repo 是什麼

- VS Code 外掛
- 主要對象：既有專案（legacy、沒人想動的那種）
- 核心取捨：**拓撲由語言伺服器算，AI 只寫敘述**
- 不含 `.sem` 規格管線（那條線在 `source/repos/s-ide`）

## 目錄

```
src/
├─ extension.ts          # 只做接線
├─ docs/feature.ts       # 符號、呼叫圖、寫檔
└─ core/                 # 純 Node/TS，禁止 import 'vscode'
   ├─ ai.ts              # OpenAI 相容呼叫（含 OpenCode Go 的 session header）
   ├─ fsx.ts             # 檔案操作（禁用 fs.rmSync）
   └─ docs/              # 文件模型、排版、增量、AI prompt
```

`npm run check` 會強制 `src/core/**` 不得相依 `vscode`。

## 開發

```bash
npm install
npm run compile     # tsc
npm run check       # 分層檢查
```

按 <kbd>F5</kbd> 開 Extension Development Host，開啟一個 C# 專案。

## 設定

| 設定 | 說明 |
|---|---|
| `side.baseUrl` | OpenAI 相容端點，預設 `https://api.openai.com/v1` |
| `side.model` | 模型名稱（空白會拒絕執行） |
| `side.docsDir` | 輸出目錄，預設 `semDocs` |

API Key 用命令 **`S-IDE: 設定 API Key`** 存進 `SecretStorage`，不會寫進 `settings.json`。

常見端點：

| 供應商 | `side.baseUrl` | 範例模型 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | `glm-5.3-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Ollama | `http://localhost:11434/v1` | `qwen2.5-coder:7b` |

## 文件長相

```markdown
### HandleAsync
`Task<ActionResult<List<ProductDto>>> HandleAsync(CancellationToken ct)`

1. 從資料來源取得全部產品
2. 將每筆產品轉為回應格式
3. 回傳清單

- 呼叫 → [IRepository<T>.GetAllAsync](../Core/Interfaces/IRepository.md#getallasync)
```

- anchor = 標題 slug（標準 Markdown，VS Code／GitHub／Obsidian 都能跳）
- 類別之間以 `---` 分隔，檔頭有類別目錄
- 簡單 auto-property 集中成「屬性一覽」表，不花 AI
- 增量更新：只重寫有變動的節點，其餘原字節保留

## 前置條件

- 需要 C# 語言伺服器（C# Dev Kit / OmniSharp）提供符號與 references
- 沒有 API Key 不會執行（不產出「有結構、沒說明」的空殼）

## 授權

UNLICENSED（私有專案）
