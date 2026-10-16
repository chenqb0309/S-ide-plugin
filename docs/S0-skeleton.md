# S0 — 命令列閉環（最危險的一步）

## 目標

**讓環自己閉上，而且不看 UI。**

```
.sem ─→ 生成 C# ─→ dotnet build ─→[失敗]→ 反向餵錯 ↺（上限 2）
                                 [成功]↓
                              執行 ─→ 看得到結果
```

S0 刻意**不做 UI**。因為它要驗證的是整條管線裡最危險的東西：`spawn dotnet` 與錯誤解析。
這些東西跟編輯器無關，用命令列驗證最快、除錯最直接。

---

## 產出

```
spike/
├─ sample.sem          # 從 docs/01-sem-v0.md 抄一份，單類別兩方法
├─ .backend/           # dotnet new console，手動建一次，之後不動
│  ├─ Backend.csproj   # TFM 釘 net10.0
│  ├─ Program.cs       # 手寫：呼叫生成的類別並印結果
│  ├─ Generated/       # 生成物寫這裡
│  └─ Prelude/         # 從 /prelude 複製過來
└─ runner.mjs          # 主程式
```

> `spike/` 是**拋棄式**的。S2 會把 `runner.mjs` 的邏輯搬進 `src/core/`，spike 本身刪掉。

---

## 實作要點

`runner.mjs` 依序做六件事：

1. **讀 `.sem`** — 先用最笨的 regex 抓 `類別` / `方法` / 簽章。**不要在這一步寫完整 parser**，S1 才需要。
2. **組 prompt** — 把方法 body + 該方法的簽章 + Prelude 可用清單塞進去。
3. **呼叫 AI** — 讀三個環境變數：

   | 變數 | 範例 |
   |---|---|
   | `SIDE_BASE_URL` | `https://api.openai.com/v1` |
   | `SIDE_MODEL` | `gpt-4o` |
   | `SIDE_API_KEY` | `sk-...` |

   這就是 BYOK 的形狀。S4 只是把同一組值改由 `SecretStorage` 供給，管線一行都不用動。

4. **寫 `.backend/Generated/<類別>.<方法>.g.cs`** — 用 `partial class`。
5. **`spawn('dotnet', ['build', backendPath, '-nologo'])`**
6. **解析 `error CS####`** — 失敗則把錯誤訊息附回 prompt 重呼，**上限 2 次**。

---

## 驗收

**連續改 10 次 `.sem`，10 次都成功執行並印出正確結果。**

這條不通過，後面全部不用談。

---

## 明確不做

| 不做 | 為什麼 |
|---|---|
| VS Code 外掛 | S2 |
| manifest / 增量 / cache key | S1 |
| 多檔 `.sem` | S1 |
| 資料庫 | S3 |
| 業務時序鏈面板 | S3（`Telemetry` 本身在 S0 就注入，只是先印在 console） |
| 重試以外的錯誤分類 | S1 |

---

## 踩雷清單

| # | 雷 | 處理 |
|---|---|---|
| 1 | **`dotnet` 輸出在 Windows 的編碼** | 中文會變亂碼。spawn 時強制 UTF-8，並設 `chcp 65001` 或設定 `Console.OutputEncoding` |
| 2 | **AI 回傳夾 markdown fence** | 一定要 strip ``` ```csharp ```。但更好的做法是用結構化輸出，從源頭消除 |
| 3 | **prompt 沒寫死「只輸出純 C#」** | 任何前後解釋文字都會讓 `Generated/*.g.cs` 編譯失敗 |
| 4 | **先加 retry 才對** | ❌ 反了。**先求一次成功，再加 retry。** 若 AI 連編譯都編不過，重試迴圈只會把問題藏起來 |
| 5 | `dotnet` 不在 PATH | spawn 用絕對路徑或先驗證 `dotnet --version` |
| 6 | `partial class` 少了 `namespace` 或 `using` | 生成檔頂部由 harness 統一注入，不交給 AI 寫 |

> 第 6 點是 Prelude 原則的延伸：**骨架（namespace、using、attribute）由 harness 提供，AI 只填方法內容。** 這樣 AI 出錯的表面積就只剩「方法實作」一項。

---

## 完成後的下一步

S1：把「每次都全量重生」換成「保守增量 + manifest」。
那一步才會產生**核心宣稱**（改一行，只有一個方法被重建）。
