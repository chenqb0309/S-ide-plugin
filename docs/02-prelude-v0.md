# Prelude 前導庫 v0

## 核心原則

> **AI 生成的程式碼，只能引用三樣東西：BCL、白名單套件、Prelude。**

這不是風格偏好，是**為了讓自我修復迴圈能收斂**。

任何「AI 自己發明、但專案裡不存在」的引用，都會產生一個它**修不了**的編譯錯誤——因為修法不在 unit 的 action space 內。

---

## 為什麼需要（這條規則的來源）

原始白皮書的自我修復示範 prompt 是：

> 「CS0103 名稱 `_db` 不存在。請修正並重新輸出純程式碼。」

**這正是迴圈修不了的例子。**

`_db` 是一個**欄位**。欄位不在方法 body 裡——它在類別的欄位宣告區、以及 DI 註冊裡。**這些全都在方法這個 unit 的邊界之外。** AI 重寫一百次 body，`_db` 都不會存在。

**解法：所有「自動注入」的東西（attribute、Telemetry、DI 介面、套件）都必須由 harness 先提供。AI 只是「使用」，不是「發明」。**

這一個概念同時消滅一整類迴圈失敗。

---

## v0 內容

### 1. `SemanticSourceAttribute`

把執行期對回規格來源。

```csharp
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class SemanticSourceAttribute(string srcFile, int line) : Attribute
{
    public string SrcFile { get; } = srcFile;
    public int Line { get; } = line;
}
```

> **v1 的斷點映射會改用 C# 內建的 `#line` 指示詞**（編譯器直接把除錯資訊指向 `.sem`，任何現成除錯器都會顯示中文檔名與行號）。attribute 從此留作 metadata，不再承擔行號映射。

### 2. `Telemetry.Step`

**業務時序鏈的資料來源。這不是裝飾，是承重結構**——當語法不可見時，這是人類唯一能看到行為的通道。

```csharp
public static class Telemetry
{
    public static void Step(string message);
    // 輸出：[10:01] PalletStacker.BoxesPerLayer → 步驟2 判斷重量級距
}
```

### 3. 資料存取點（**S3 才加入，v0 不需要**）

```csharp
public interface 資料庫
{
    用戶? 查詢用戶(string email);
    void 新增用戶(用戶 user);
}
// Prelude 提供 SQLite 實作，連線由 harness 管理
```

使用者在 `.sem` 的 `requires` 只寫 `` `Database` ``，AI 直接用 `Database.QueryUser(...)`，**不需要知道連線怎麼來的**。

這是 v0 完全不需要 DI 自動裝配的原因。

---

## 套件白名單

| 階段 | 套件 | 用途 |
|---|---|---|
| v0 | **（無）** | S0 / S1 / S2 零外部依賴 |
| S3 | `Microsoft.Data.Sqlite` | 資料庫 |

> **版本於實作時以 `dotnet add package` 決定並寫回本表，不憑記憶填寫。**

---

## 目標框架

```xml
<TargetFramework>net10.0</TargetFramework>
```

本機 SDK 為 `10.0.401`，**必須釘死**，否則 TFM 會跟著 SDK 版本漂移。

---

## 與契約的關係

| | 提供者 | AI 的角色 |
|---|---|---|
| 型別、簽章、欄位 | `.sem` 的 `契約` 區 | 使用 |
| Attribute、Telemetry、資料存取 | Prelude | 使用 |
| 第三方能力 | 白名單套件 | 使用 |
| 方法內的實作描述 | `.sem` 的 body | **生成** |

**AI 真正能自由發揮的，只有最後一行。這是刻意的。**
