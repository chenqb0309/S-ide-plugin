# `.sem` v0 文法（子集）

> `.sem` 是一份**偽代碼文件**（代碼文件化）。
> **第一目的是閱讀**：讓人清楚看到 **spec 被轉化成 code 的前一步**。生成程式碼是第二目的。

這份文法同時被三個地方消費，所以它是三者的唯一真相：

1. **TextMate grammar** — 關鍵字高亮
2. **parser** — 抽簽章與依賴，算 cache key、解析連結
3. **AI System Prompt** — 穩定文法才可能下穩定約束

---

## 語言界線（最重要）

`.sem` 裡有三層，各用各的語言：

| 層 | 用什麼 | 為什麼 |
|---|---|---|
| **框架**：`class` / `func` / `data` / `requires` / `in:` / `out:` / `str` / `int` | **英文的習慣寫法** | 開發者一眼就懂，閱讀最快 |
| **識別字**（類別／方法／參數／欄位名） | **ASCII**（英文） | 它們會被**沿用**進 C#，不是被翻譯 |
| **敘述**（步驟、說明、字串） | **任何語言，可混用** | 不進 C#，由 AI 轉譯 |

### 為什麼識別字一定要 ASCII

偽代碼可以中文命名，**程式碼不行**。中文識別字會：

- 讓序列化後的 JSON 欄位名變中文，跟外部系統不相容
- 讓反射／ORM／source generator 踩雷
- 讓 linter／analyzer 等工具鏈不保證支援
- **實測**：生成的檔案非得加 BOM 才編得過

所以這條規則在**規格層**就擋掉（`lintNames`），讓它永遠到不了 C#。
**中文請留在敘述、步驟與字串裡——那裡才是給人讀的地方。**

---

## 定址規則（v0 的關鍵約定）

連結、快取失效、依賴圖三件事都要**唯一定址**。因此 v0 立下三條硬約定：

| # | 約定 | 為什麼 |
|---|---|---|
| 1 | **類別名全域唯一**（一個 workspace 內不可重複） | 讓 `類別.方法` 只靠 regex 就能解析，不需語意分析 |
| 2 | **禁止多載**（不可同名不同參數） | 否則 `類別.方法` 無法唯一定址 |
| 3 | `unit key = 類別名.方法名` | 連結、cache key、manifest 共用同一個 key |

> **違反 1 或 2 時，harness 直接報錯（規格 lint），不進生成。** 這是免費拿到的第一層驗證。

---

## 頂層結構

```
註解         # 到行尾
頂層宣告      class | data
慣例         一檔一類別
```

---

## class

```sem
class ShippingService {
    requires {
        `ShippingFeeCalculator`
        `InventoryService`
        `AuditLog`
    }

    func Ship {
        in: Order order
        out: str

        呼叫 `InventoryService.HasStock`，不足則返回「單號 庫存不足」
        ...
    }
}
```

`requires` 是**這個類別會用到的協作者清單**，每一行就是一個連結。

**它只宣告「需要什麼」，不寫「怎麼來」。** 欄位與實例由 harness 生成：

```csharp
public partial class ShippingService
{
    private readonly ShippingFeeCalculator ShippingFeeCalculator = new ShippingFeeCalculator();
    private readonly InventoryService       InventoryService = new InventoryService();
    private readonly AuditLog               AuditLog = new AuditLog();
}
```

（欄位名 = 類別名。body 直接寫 `InventoryService.HasStock(order)`，**不要自己 `new`**。）

**這是 unit 邊界能成立的前提：AI 只能「使用」`requires` 裡的東西，不能「發明」。**

> 這條規則是為了消滅一類修不好的錯誤。例：AI 自己寫出一個 `_db` 卻沒人宣告它 → `CS0103` → 迴圈重寫一百次 body 都修不好，因為欄位不在方法 body 裡。詳見 [02-prelude-v0.md](02-prelude-v0.md)。

> **`requires` 的內容會進 context map**，AI 看得見欄位名。這是免費的護欄。

---

## data（DTO）

```sem
data User {
    str Email
    str PasswordHash
}
```

`data` 與 `requires` 形狀都是 `型別 名稱`，但語意相反：

| | 意思 | 生成 |
|---|---|---|
| `data` | 它**是**什麼（值物件，會被傳遞／序列化） | `public class X { public T A { get; set; } }` |
| `requires` | 它**用**什麼（協作者，由 harness 注入） | `private readonly T name = new T();` |

---

## func

**上半是契約，下半是實作。**

```sem
func CalculateFee {
    in: Order order
    out: decimal

    步驟 "免運門檻"
    order.TotalAmount 達到 1000 元，運費為 0 並直接返回
    返回 fee
}
```

| 行 | 意義 | 可省略 |
|---|---|---|
| `in: 型別 名稱` | 參數（多個用逗號：`in: BoxSpec spec, int palletHeight`） | 是 → 無參數 |
| `out: 型別` | 回傳型別 | 是 → `void` |

```sem
func Main {
    步驟 "建立樣本"
    ...
}
```

- **`in` / `out` 之後就是 body**，body 是自由散文——這就是「骨架精確，body 自由」的字面形狀
- **簽章是凍結契約**：改簽章 = 全專案失效事件（見 [S1](S1-incremental.md)）

---

## 型別

| `.sem` | C# | 備註 |
|---|---|---|
| `str` | `string` | |
| `int` / `long` | `int` / `long` | |
| `decimal` / `double` | `decimal` / `double` | |
| `bool` | `bool` | |
| `date` | `DateTime` | |
| `void` | `void` | `out:` 省略時的預設 |
| `list<T>` | `List<T>` | |
| `T?` | `T?` | 可空 |
| 自訂名稱 | 同名的 `class` / `data` | |

> **未知型別在規格層就報錯**（`lintTypes`）。若放行到編譯器，它會變成生成檔裡的
> `CS0246`——那不在 AI 的 action space 內，迴圈修不了，只是白燒重試次數。

---

## 語句（v0 子集）

| 語法 | 意義 | 生成 |
|---|---|---|
| `` `類別` `` `` `類別.方法` `` | **可跳轉的單元引用** | 方法呼叫 |
| `如果 條件 { }` | 條件分支 | `if` |
| `否則如果 條件 { }` | — | `else if` |
| `否則 { }` | — | `else` |
| `每個 X 於 集合 { }` | 走訪 | `foreach` |
| `重複 N 次 { }` | 固定次數 | `for` |
| `返回 值` | 回傳 | `return` |
| `拋出 錯誤(X)` | 丟例外 | `throw` |
| `嘗試 { } 捕捉 錯誤 { }` | 例外處理 | `try/catch` |
| `步驟 "說明"` | **業務時序鏈**的標記點 | `Telemetry.Step(...)` |

v0 **不做**：`當`（while，可後補）、集合字面值、字串插值、泛型方法的型別參數、`大於`/`小於` 以外的運算式語法。

**除了連結與 `步驟`，其餘都是自由散文**——那些中文標記只是慣例，parser 不解析它們。

---

## 機制不住文件裡

v0 **沒有修飾符**。並行、鎖、可見性、資料存取這些機制，一律由 **harness 的規則**決定，不寫進 `.sem`。

判準：**這個標記，是在描述「要什麼」，還是在告訴機器「怎麼做」？**

| 想要的效果 | 舊寫法（已廢除） | 現在的寫法 |
|---|---|---|
| 同一時間只准一個人扣庫存 | `【獨佔鎖定】` | 不用寫——對 `requires` 協作者的寫入由 harness 依規則序列化 |
| 回傳 `Task<T>` | `【非同步】` | 不用寫——`out:` 已經表達了 |
| `internal` 可見性 | `【僅內部】` | 不用寫——由架構層決定 |
| 這幾步可以同時跑 | `【並行處理】` | 不用寫——v0 一律循序（**保守＝安全**） |

> **每次想加語法，先問：這個機制能不能由 harness 依意圖推斷？能，就不要寫。**
>
> 這條原則同時產生三個決定：連結用**維基式反引號**、修飾符**全部廢除**、
> 框架詞彙**全面改英文**。

---

## 連結語法

**反引號：`` `類別` `` 或 `` `類別.方法` ``。**

選反引號而不是 `[[...]]`，因為程式設計師對「反引號 = 識別字」已經有肌肉記憶，寫在中文句子裡也讀得順：

```sem
呼叫 `InventoryService.HasStock`，不足則返回「單號 庫存不足」
```

它是**維基連結**，不是函式呼叫——所以**不帶參數**。參數用敘述寫：

| 像程式（不要） | 像規格（要這樣） |
|---|---|
| `` `Inventory.Deduct(amount)` `` | 從 `Inventory` 扣掉 amount |

- `DocumentLinkProvider` 渲染為可點擊連結
- `Ctrl + 點擊` 跨檔跳轉；`F12` 精確跳到目標行
- **指向不存在的目標 → 當場畫紅線**（`DiagnosticCollection`）

**這讓 `.sem` 不只是文字，而是一張有連結的圖。**

而且**斷鏈偵測是免費的規格 lint** ——在完全沒有底層程式碼的狀態下，靠純文字拓撲抓出規格層的錯誤。

> 連結**不會被靜默跳過**：任何解析不到的目標都報錯。連結是唯一的依賴宣告，靜默等於規格殘缺。

---

## 規格 lint 總表（全部免費，不需要編譯器）

| 檢查 | 函式 | 擋掉什麼 |
|---|---|---|
| 類別／資料名全域唯一 | `lint` | 定址歧義 |
| 禁止多載 | `lint` | 定址歧義 |
| 斷鏈 | `lintLinks` | 依賴宣告指向不存在的東西 |
| **識別字非 ASCII** | `lintNames` | 中文命名滲進程式碼 |
| **未知型別** | `lintTypes` | 變成迴圈修不了的 `CS0246` |
| **舊寫法** | `lintStaleSyntax` | 整條靜默消失 |

---

## 範例

| 樣本 | 用途 |
|---|---|
| [`samples/PalletStacker/`](../samples/PalletStacker/PalletStacker.sem) | 零外部依賴、一分鐘講完。用來驗證高亮／跳轉／增量 |
| [`samples/WarehouseShipping/`](../samples/WarehouseShipping/WarehouseShipping.sem) | 多類別、requires 注入、真實業務規則。用來驗證「這東西到底有沒有用」 |

> **每個樣本自成一格工作區。** 用 `node scripts/run.mjs samples/<樣本名>` 執行，或在 VS Code 直接開啟該資料夾。

---

## 註解

`#` 到行尾。註解進 context map（供人閱讀），但不進生成結果。
