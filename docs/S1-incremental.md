# S1 — 保守增量與 manifest

> **程式碼位置變更（S2 時）**：增量邏輯已搬進 `src/core/manifest.ts`，
> 由 `scripts/run.mjs` 驅動。`spike/` 已刪除。

## 目標

把 S0 的「每次全量重生」換成**增量**，並產出**可證明的爆炸半徑**。

> 這是本專案的核心宣稱所在：**改一行規格，只有一個方法被重建。**
> 這個階段做完，demo 才有可打在投影幕上的東西。

---

## 一單元一檔

生成到 `Generated/<類別>.<方法>.g.cs`，用 C# 的 `partial class`：

```csharp
// Generated/棧板堆疊器.計算單層箱數.g.cs
using SIDE.Prelude;

namespace SemanticBackend;

[SemanticSource("棧板堆疊器.sem", 12)]
public partial class 棧板堆疊器
{
    public int 計算單層箱數(箱規格 規格) { ... }
}
```

這樣「只重生一個方法」就**是字面上的「只有一個檔案 hash 變了」**——可驗證，不是形容詞。

**欄位與依賴宣告集中於 `Generated/<類別>.Fields.g.cs`**（由 `契約` 區生成）。

---

## 保守失效（v0 策略）

v0 **不實作精確依賴圖**，改用保守失效——寧可多重生，不可少重生：

```
cache key = hash(unit 契約 + unit body
                 + 全專案簽章索引版本
                 + Prelude 版本 + prompt 版本)
```

| 改動 | 行為 |
|---|---|
| 只改某 unit 的 body | **只有該 unit 重生** |
| 改任何簽章 / 型別 | 簽章索引版本變 → **全專案重生** |
| 改 Prelude 或 prompt | 全專案重生 |

**保守 = 永遠正確，且不需要維護依賴圖。** 代價是改簽章時做白工，可接受。
精確 fan-out（由 cache key 推導依賴）留給 v1。

---

## manifest

`Generated/manifest.json` 是增量的事實來源，**也是 demo 要打在投影幕上的東西**：

```json
{
  "preludeVersion": "0.1.0",
  "promptVersion": "p1-1",
  "signatureIndexVersion": "a3f1c9e2",
  "units": {
    "棧板堆疊器.計算單層箱數": {
      "sem": "棧板堆疊器.sem",
      "semLine": 12,
      "cs": "Generated/棧板堆疊器.計算單層箱數.g.cs",
      "cacheKey": "7d48e188...",
      "generatedAt": "2026-10-16T10:00:00+08:00",
      "attempts": 1
    }
  }
}
```

**Demo 的關鍵畫面：** 改一行 body → manifest diff 顯示 3 個 unit 裡面只有 1 個 `cacheKey` 變動。

---

## 孤兒清理

刪掉或改名 `.sem` 單元後，舊的 `.g.cs` 不會自己消失，`dotnet build` 會永遠失敗。

**每次編譯前先 reconcile**：`manifest.json` 裡沒有的 `.g.cs` → 刪除。

---

## 驗收

1. 改一行 body → **manifest diff 只有 1 個 cacheKey 變**
2. 改一個簽章 → 全部 cacheKey 變（保守行為正確）
3. 刪掉一個方法 → 對應的 `.g.cs` 被清掉，build 仍成功
4. **刪掉整個 `Generated/` → 完全重建成功**（證明產物可拋棄）

第 4 條是 demo 的 money shot，必須能重複執行。

---

## 明確不做

| 不做 | 留給 |
|---|---|
| 精確依賴圖 | v1 |
| 跨檔傳遞失效 | v1 |
| 專案級不變式區塊 | v1 |
| 行為 oracle | v1 |

---

## 風險

| 風險 | 說明 | 處置 |
|---|---|---|
| hash 不穩定 | 若 body 的 hash 含行號或空白，會誤判變動 | **正規化後再 hash**（trim、去空行、統一換行）——已實作 |
| 全量重生太慢 | 保守策略在改簽章時會全量。若樣本只有 3 個 unit，這不是問題 | 接受 |
| `Fields.g.cs` 的失效 | 欄位變動等同簽章變動 → 全量 | **不要試圖做局部欄位失效** |

---

## ⚠️ Node 在 Windows 的檔案操作雷（實測，非理論）

**`fs.rmSync` 只要路徑含非 ASCII 字元，就會讓 Node 硬崩潰 —— 不是拋例外，是整個行程死掉，連 `try/catch` 都攔不到。**

實測環境：**Node v24.9.0 / Windows**，exit code `0xC0000409`（`STATUS_STACK_BUFFER_OVERRUN`，即原生緩衝區溢位）。

| 操作 | CJK 路徑 | ASCII 路徑 |
|---|---|---|
| `fs.unlinkSync(file)` | ✅ | ✅ |
| `fs.rmdirSync(dir)`（空目錄） | ✅ | ✅ |
| `fs.rmSync(file)` | ❌ **崩潰** | ✅ |
| `fs.rmSync(file, { force: true })` | ❌ **崩潰** | ✅ |
| `fs.rmSync(dir, { recursive: true, force: true })` | ❌ **崩潰** | ✅ |

### 為什麼這件事對本專案特別致命

這個專案的設計是**全面使用中文檔名**（`棧板堆疊器.sem`、`棧板堆疊器.計算單層箱數.g.cs`）。
所以它不是「偶爾踩到」，而是 **100% 會踩到**。

### 規則（必須寫進 `src/core/`）

> **全面禁用 `fs.rmSync`。**
> 刪檔一律 `fs.unlinkSync`；刪目錄先用 `unlinkSync` 清空，再 `rmdirSync`。

S2 之後外掛會對中文檔名的 `.sem` 做檔案操作，這條規則屆時仍然是硬性的。

---

## 已驗證（S1 完成）

| # | 驗收項 | 結果 |
|---|---|---|
| 1 | 只改一行 body | **沿用 3、重生 1**，簽章索引版本不變 ✅ |
| 2 | 改一個簽章（`整數`→`長整數`） | 簽章索引版本改變 → **沿用 0、重生 4** ✅ |
| 3 | 無改動 | **沿用 4、重生 0**，`generatedAt` 正確保留 ✅ |
| 4 | 手動丟入殘留 `.g.cs` | **移除 1**，build 仍成功 ✅ |
| 5 | **刪掉整個 `Generated/`（含 manifest）** | **完全重建**，4 個 unit 全部重生並執行成功 ✅ |

> 第 1 與第 5 項就是 demo 的 money shot，兩者都已可重複執行。
