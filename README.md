# S-IDE Plugin

> **語義是唯一的原始碼；C# 是可拋棄的產物。**

一個讓工程師只維護「結構化中文規格」，真實 C# 程式碼完全隱匿在後台的 **VS Code 外掛**。

---

## 這個 repo 是什麼

VS Code 外掛的實作。

先前規劃的路線是「自建前端（Vite + Monaco）→ 之後打包 Electron」。**本 repo 推翻該路線，改為寄生 VS Code**，因此獨立另起，不繼承任何既有 repo。

---

## 為什麼寄生 VS Code

寄生宿主一次砍掉下列全部工作：

| 原本要自建 | VS Code 直接提供 |
|---|---|
| Electron 殼 | 宿主本身就是 |
| Monaco 整合 | 內建（VS Code 就是 Monaco） |
| 檔案樹 | 內建 |
| 終端機、命令面板、狀態列 | 內建 API |
| 語法高亮引擎 | 寫一份 TextMate grammar **宣告檔**，不用寫程式 |
| 快捷鍵、設定頁、金鑰加密儲存 | `keybindings` / `configuration` / `SecretStorage` |
| 發佈管道 | Marketplace |
| 安裝、更新、簽章、通知 | 微軟做完 |

| | 舊路線（自建） | 新路線（寄生） |
|---|---|---|
| 宿主 | Electron + Vite + Monaco | VS Code |
| 檔案樹 / 終端機 | 自己寫 / xterm.js | 內建 |
| 跳轉 | 自己寫 AST | `DocumentLinkProvider` |
| 發佈 | 打包 + 簽章 | Marketplace |
| 工時 | 兩個月 | **一週（v0）** |

**代價：綁死宿主。** 因此管線**必須**與 `vscode` API 解耦（見 [docs/S2-shell.md](docs/S2-shell.md) 的分層規則）。

---

## 核心宣稱（唯一要證明的事）

> **改一行規格，只有一個方法被重建；其餘一個位元組都沒動。**
> 而編譯器會在 1 秒內告訴你對不對。

不是「中文能生程式碼」——那是 2023 年就有的東西。
是「**生成物有可證明的爆炸半徑，而且有裁判**」。

---

## 與市場的關係

2026 年 SDD 已成熟：**Tessl**（規格是唯一真相、**不能編輯生成碼**）、**Kiro**、**GitHub Spec Kit**、**OpenSpec**、**BMAD**、**SPECLAN**（VS Code 規格層，已上架）。

**「規格優先 + 生成碼不可編輯」這個位置已經被佔據。**

但全場有一個共同缺口（來自公開評測的抱怨）：

- Spec Kit：「沒有 diff。只改一小段，整份已審過的計畫被完全取代。」
- 社群結論：「真正的魔法是**只把相關文檔過濾進 AI 的 context**。」
- 「Spec bloat：半小時的功能生出 800 行 markdown。」

| | 全場現況 | 本專案 |
|---|---|---|
| 規格載體 | markdown 散文 | **型別化契約** |
| 粒度 | feature / 整份文件 | **method** |
| 重生 | 全量取代 | **hash 增量** |
| 改一行 | 整份重生、無 diff | **manifest diff：N 檔只有 1 檔變** |
| 驗證 | 人讀 | **編譯器 oracle** |

> **差異化在「單位級增量失效」，不在「中文」。**
> 中文只是最表層、最容易被抄、最容易被說「Tessl 做過了」的那一層。

被問到「你跟 Tessl 差在哪」時，答案是上面那張表的第三行與第四行。

---

## 範圍

### v0 做

- `.sem` → C# 生成、編譯、**失敗自動修復**、執行
- 保守增量重算 + `manifest.json`（**可證明**的爆炸半徑）
- VS Code 外掛殼：高亮、跨檔連結跳轉、**斷鏈紅線**、輸出面板
- 業務時序鏈
- 全刪 `Generated/` → 重建
- BYOK 設定（OpenAI 相容端點）

### v0 不做

| 排除項 | 理由 |
|---|---|
| 斷點映射 | 需讀 PDB 或接 DAP；幾週不是幾天。留 v1，用 `#line` 實作 |
| DI 自動裝配 | Prelude 自己持有連線，v0 不需要 |
| 精確依賴圖 | v0 用保守失效（改簽章即全量重生） |
| 跨檔傳遞失效 | 同上 |
| runtime oracle | v0 只有 build oracle |
| 觀測性、prompt 版控、eval | 跑通之後再說 |
| 獨立桌面版 | 寄生的意義就是不獨立 |
| 影片、上架 | 實作完成後處理 |

---

## 里程碑

| 階段 | 目標 | 驗收 | 文件 |
|---|---|---|---|
| **S0** ✅ | 命令列閉環：`.sem` → 生成 → 編譯 → 修復 → 執行 | 連續改 10 次，10 次成功執行 | [S0](docs/S0-skeleton.md) |
| **S1** ✅ | 保守增量 + manifest + 一單元一檔 | 改 body 只有 1 個 cacheKey 變；刪 `Generated/` 可完全重建 | [S1](docs/S1-incremental.md) |
| **S2** ✅ | VS Code 外掛殼，接線到 core | 高亮、跳轉、斷鏈紅線、存檔觸發、設定頁、首次 scaffold | [S2](docs/S2-shell.md) |
| **S3** | 業務時序鏈面板 + 修飾符注入 + DB 樣本 | 時序鏈面板；`【獨佔鎖定】` 長出 `SemaphoreSlim` | [S3](docs/S3-timeline.md) |
| **S4** | 打包 + 上架 | 全新機器填入金鑰即可跑通 | [S4](docs/S4-config-release.md) |

**順序理由：S0 是最危險的一步（`spawn dotnet` + 錯誤解析），所以排第一，而且刻意不做 UI。**
跳轉、高亮是最容易做得漂亮、但最不承載論點的部分，排在後面。

---

## 技術棧

| 層 | 選擇 | 備註 |
|---|---|---|
| 宿主 | VS Code 外掛 | 寄生，不獨立 |
| 語言 | TypeScript | extension host 是 Node |
| AI | **BYOK**，OpenAI 相容端點 | base URL / model / key 三格；使用者自填 |
| 金鑰 | `vscode.SecretStorage` | 不進 `settings.json` |
| 目標語言 | C# / .NET 10 | **TFM 釘 `net10.0`** |
| Oracle | `dotnet build` | v0 唯一 oracle |
| 資料 | SQLite（S3 起） | Prelude 持有連線，AI 不做 DI |
| 高亮 | TextMate grammar | 宣告檔，無程式邏輯 |

---

## 目錄結構

```
s-ide-plugin/
├─ package.json                    # extension manifest（contributes / 設定 / 命令）
├─ language-configuration.json     # 括號配對、註解符號
├─ syntaxes/sem.tmLanguage.json    # 高亮（宣告檔，無程式邏輯）
├─ prelude/                        # C# 前導庫。AI 只能引用，不能發明
│  ├─ SemanticSourceAttribute.cs
│  └─ Telemetry.cs
├─ src/
│  ├─ extension.ts                 # 薄 adapter：只接線，不做邏輯
│  └─ core/                        # 純 Node + TS，禁止 import 'vscode'
│     ├─ parse.ts                  # .sem → AST
│     ├─ lint.ts                   # 定址規則 lint（類別唯一／禁多載／斷鏈）
│     ├─ codegen.ts                # 簽章索引、單元切割、harness 骨架生成
│     ├─ manifest.ts               # cache key / 保守增量 / 孤兒清理
│     ├─ translate.ts              # OpenAI 相容呼叫（BYOK）
│     ├─ build.ts                  # spawn dotnet + CS 錯誤解析
│     ├─ scaffold.ts               # 首次使用偷偷建 .semantic_backend
│     ├─ pipeline.ts               # 串起整條管線
│     └─ fsx.ts                    # 安全檔案操作（禁用 fs.rmSync）
├─ scripts/
│  ├─ run.mjs                      # CLI：終端機跑同一條管線
│  └─ check-layering.mjs           # 強制 src/core/ 不得相依 vscode
├─ samples/棧板堆疊器.sem
├─ docs/
└─ .vscode/                        # F5 啟動設定
```

**為什麼不用 monorepo（workspaces）**：v0 不需要，會多一層建置複雜度。
**但分層規則用腳本強制**：`npm run check` 會讓 `src/core/**` 相依 `vscode` 直接失敗。這是寄生策略唯一的保險。

---

## 決策摘要

| 項目 | 決定 | 理由 |
|---|---|---|
| 形態 | VS Code 外掛 | 砍掉最多成本，且取得發佈管道 |
| 核心宣稱 | 單位級增量失效 | 全場共同缺口，且可證明 |
| 粒度 | method；一單元一 `partial class` 檔 | 讓「只重生一個方法」=「只有一個檔案 hash 變」 |
| 定址 | `類別.方法`；**類別全域唯一**；**禁止多載** | 讓連結只靠 regex 解析 |
| 觸發 | **存檔**觸發，非每次修改 | 打字觸發 = 成本與延遲失控 |
| 增量 | 保守失效（改簽章即全量重生） | 永遠正確，不需維護依賴圖 |
| AI | BYOK，OpenAI 相容端點 | 一個 code path 吃掉所有供應商；無伺服器 |
| Oracle | `dotnet build` | 確定性、免費、且不討好你 |
| 斷點映射 | 延到 v1，用 `#line` | 自訂 PDB 解析是幾週的工作 |

---

## 文件

| 文件 | 內容 |
|---|---|
| [docs/01-sem-v0.md](docs/01-sem-v0.md) | `.sem` v0 文法子集與**定址規則** |
| [docs/02-prelude-v0.md](docs/02-prelude-v0.md) | Prelude 前導庫 v0 契約 |
| [docs/S0-skeleton.md](docs/S0-skeleton.md) | 命令列閉環（最危險的一步） |
| [docs/S1-incremental.md](docs/S1-incremental.md) | 保守增量與 manifest |
| [docs/S2-shell.md](docs/S2-shell.md) | VS Code 外掛殼與分層 |
| [docs/S3-timeline.md](docs/S3-timeline.md) | 業務時序鏈、執行、DB 樣本 |
| [docs/S4-config-release.md](docs/S4-config-release.md) | BYOK 設定與打包 |

---

## 跑起來

### 方式一：VS Code 外掛（F5）

```bash
npm install
npm run compile
```

然後在 VS Code 按 <kbd>F5</kbd> —— 會開出一個 **Extension Development Host** 視窗。
在那個視窗開啟含 `.sem` 的資料夾（例如本 repo 的 `samples/`），就會自動啟用。

1. 執行命令 `S-IDE: 設定 API Key`，貼上金鑰（存進 `SecretStorage`，不寫入 `settings.json`）
2. 設定 `side.model`（例如 `gpt-4o`）
3. 開 `samples/棧板堆疊器.sem` → 應該看到中文關鍵字高亮
4. <kbd>Ctrl</kbd>+<kbd>S</kbd> 存檔 → 觸發生成
5. 命令 `S-IDE: 執行`，或點狀態列左下角的 **S-IDE**

> 想省錢可以用本機 Ollama：`side.baseUrl` = `http://localhost:11434/v1`、`side.model` = `qwen2.5-coder:7b`，API Key 隨便填。

### 方式二：CLI（同一條管線，除錯用）

不需要 API Key 也能驗證整條管線：

```bash
npm run compile
npm run check                          # 分層檢查

node scripts/run.mjs                   # execute（無金鑰時自動 MOCK）
SIDE_MODE=compile  node scripts/run.mjs
SIDE_MODE=rebuild  node scripts/run.mjs   # 刪掉 Generated/ 完全重建
SIDE_MOCK_FAIL=1   node scripts/run.mjs   # 自我修復迴圈
SIDE_MOCK_FAIL=9   node scripts/run.mjs   # 不可修復時提早放棄

# 真的呼叫 AI（BYOK）
SIDE_BASE_URL=https://api.openai.com/v1 SIDE_MODEL=gpt-4o SIDE_API_KEY=sk-... node scripts/run.mjs
```

**看核心宣稱**：改 `samples/棧板堆疊器.sem` 裡任一行 body，再跑一次 —— 輸出會是
`manifest：沿用 5、重生 1`，並且只有那一個 unit 的 `cacheKey` 改變。

### 疑難排解：編輯器滿江紅，但 `npm run compile` 是綠的

這是 VS Code 專案最常見的假警報，跟程式碼無關。**以 `npm run compile` 為準。**

| 症狀 | 原因 | 修法 |
|---|---|---|
| `找不到名稱 'clearTimeout'`、`找不到命名空間 'NodeJS'`、`Cannot find module 'node:path'` | TypeScript server 在 `npm install` 之前就啟動了，快取裡沒有 `node_modules/@types` | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → **`TypeScript: Restart TS Server`** |
| 重啟後仍在 | VS Code 用的是內建 TypeScript，不是專案那一份 | 本 repo 已附 `.vscode/settings.json` 釘住 `typescript.tsdk`；首次開啟會問你要不要用工作區版本，選 **Allow** |
| 完全不對 | 你開的是單一檔案，不是資料夾 | `File → Open Folder` 開**含 `tsconfig.json` 的那一層** |

診斷指令：<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → `TypeScript: Go to Project Configuration`，
應該要跳到 `tsconfig.json`。

---

## 狀態

**S0、S1、S2 完成並驗證通過。**

- S0：管線、編譯、自我修復、提早放棄、執行
- S1：保守增量、manifest、孤兒清理、全刪重建
- S2：VS Code 外掛（高亮、跳轉、斷鏈紅線、存檔觸發、BYOK 設定、首次 scaffold）、workspace 級管線

尚未驗證：**真實 AI 呼叫**（需要 BYOK 金鑰）。目前所有驗證都在 MOCK 模式，即「管線本身」已被證明，但「模型第一次能否吐出編譯得過的 body」尚未實測。

下一步：**S3 — 業務時序鏈面板與修飾符注入**。

> ⚠️ **實作前必讀**：[S1 文件裡的 Node 檔案操作雷](docs/S1-incremental.md)。
> `fs.rmSync` 對中文路徑會讓 Node 硬崩潰，本專案全面使用中文檔名，因此**禁用 `fs.rmSync`**。

---

## 授權

待定。
