export type MemberKind = 'method' | 'property';

/** 一個可獨立重寫的語義節點（＝文件中的一個區塊）。 */
export interface MemberDoc {
  /** 穩定識別碼，用來比對「是不是同一個節點」（不是 Markdown anchor） */
  id: string;
  /** 文件上的標題文字（可能帶 ` (2)` 以確保檔內唯一） */
  heading: string;
  /** 由 heading 推導的 Markdown anchor；連到這個節點時用它 */
  anchor: string;
  kind: MemberKind;
  name: string;
  /** 給人看的簽章，例如 decimal CalculateFee(Order order) */
  signature: string;
  /** 0-based，含頭不含尾 */
  startLine: number;
  endLine: number;
  /** 原始碼切片，餵給 AI 用 */
  code: string;
}

/** 一個 class 在文件中的容器。class 本身不是可獨立重寫的節點。 */
export interface ClassDoc {
  name: string;
  anchor: string;
  startLine: number;
  endLine: number;
  members: MemberDoc[];
}

/** 一個 .cs 對應一份 .md。 */
export interface FileDoc {
  /** 相對 workspace 的 .cs 路徑，正斜線 */
  relCs: string;
  /** 相對 workspace 的 .md 路徑，正斜線 */
  relMd: string;
  classes: ClassDoc[];
}

/** AI 回傳的說明：字串＝一句摘要；陣列＝編號步驟，以 id 為鍵。 */
export type ProseMap = Map<string, string | string[]>;
