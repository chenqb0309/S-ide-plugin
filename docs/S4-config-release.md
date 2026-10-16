# S4 — BYOK 設定與打包

## 目標

**讓一個沒看過這系統的人，在全新機器上填入金鑰就能跑通。**

---

## 一、BYOK 設定（三格）

| 設定 | 存放位置 | 說明 |
|---|---|---|
| `side.baseUrl` | `contributes.configuration` | 預設 `https://api.openai.com/v1`，可改 |
| `side.model` | `contributes.configuration` | 預設留空，使用者自填 |
| API Key | **`vscode.SecretStorage`** | **絕不寫進 `settings.json`** |

**為什麼要「OpenAI 相容端點」而不是「支援 OpenAI」：**

一個 code path 同時吃掉 OpenAI / DeepSeek / OpenRouter / Groq / 本機 Ollama / 自架 proxy。
**零額外工作量，但把「支援哪些模型」這個問題永久消滅。**

> 金鑰用 `SecretStorage` 而不是設定值，是因為設定值會進 `settings.json`，可能被同步、被提交、被截圖。
> 鍵盤命令：`S-IDE: 設定 API Key`（用 `showInputBox({ password: true })`）。

---

## 二、前置環境偵測

| 檢查 | 失敗時 |
|---|---|
| `dotnet --version` 存在 | 提示安裝 .NET 10 SDK，附連結 |
| SDK 版本 ≥ 10 | 警告：TFM 釘 `net10.0`，版本不足無法建置 |
| API Key 已設定 | 引導至設定命令 |

**這三條在 demo 時不重要，但在別人電腦上會決定成敗。**

---

## 三、打包

```bash
npx @vscode/vsce package
```

`.vscodeignore` 必排除：

```
samples/**
spike/**
docs/**
src/**            # 只留 out/
```

> `docs/` 與 `spike/` 不進發佈包，但**要留在 repo**——它們是這個專案最值錢的部分。

---

## 四、Marketplace 上架前置

| 項目 | 說明 |
|---|---|
| publisher 帳號 | Azure DevOps PAT |
| `icon` | 128×128 PNG |
| `README.md` | Marketplace 會直接顯示 |
| `CHANGELOG.md` | 審查會看 |
| `repository` 欄位 | 指向本 repo |

> 上架前先確認 extension ID 沒被佔用，並**先確認「規格層」這個定位有沒有別人先註冊走**。

---

## 驗收

1. 在**乾淨的機器**上安裝 vsix → 填入三格設定 → 開一個 `.sem` 資料夾 → 能跑通完整閉環
2. 未設金鑰時，錯誤訊息是「請先設定 API Key」，而不是一個 undefined 例外
3. 未裝 .NET 時，錯誤訊息指向安裝連結

---

## 明確不做

| 不做 | 理由 |
|---|---|
| 遙測上報 | 無伺服器；且與「本地執行」的隱私定位衝突 |
| 授權驗證 / 付費牆 | 商業模式未定 |
| 自動更新 | Marketplace 處理 |
| 影片、行銷素材 | 實作完成後處理 |
