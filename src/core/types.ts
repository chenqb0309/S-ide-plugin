/** 型別與資料結構。core 是純 Node 模組，不得 import 'vscode'。 */

export interface Field {
  type: string;
  name: string;
  /** 來自 `requires` 區的依賴宣告 */
  dependency?: boolean;
}

export interface Param {
  type: string;
  name: string;
}

export interface Method {
  className: string;
  name: string;
  /** 在 .sem 中的行號（1-based） */
  line: number;
  params: Param[];
  returns: string;
  bodyText: string;
  srcFile: string;
}

export interface DataDecl {
  name: string;
  line: number;
  fields: Field[];
  srcFile: string;
}

export interface ClassDecl {
  name: string;
  line: number;
  fields: Field[];
  methods: Method[];
  srcFile: string;
}

export interface SemFile {
  /** 相對於 workspaceRoot 的路徑 */
  relPath: string;
  srcFile: string;
  datas: DataDecl[];
  classes: ClassDecl[];
}

export type UnitKind = 'dto' | 'fields' | 'method';

export interface Unit {
  key: string;
  kind: UnitKind;
  /** 生成的檔名，例如 `PalletStacker.BoxesPerLayer.g.cs` */
  file: string;
  /** 簽章的文字（型別／欄位／參數） */
  contract: string;
  /** 實作描述的文字（僅 method 有） */
  body: string;
  srcFile: string;
  line: number | null;
  method?: Method;
  dto?: DataDecl;
  cls?: ClassDecl;
  /** 由 manifest 階段填入 */
  cacheKey?: string;
  /** null = 可沿用；字串 = 重生的原因 */
  stale?: string | null;
  generatedAt?: string | null;
  attempts?: number;
}

export interface UnitManifestEntry {
  sem: string;
  semLine: number | null;
  cs: string;
  cacheKey: string;
  generatedAt: string | null;
  attempts: number;
}

export interface Manifest {
  preludeVersion: string;
  promptVersion: string;
  signatureIndexVersion: string;
  units: Record<string, UnitManifestEntry>;
}

export interface LintDiagnostic {
  /** 相對於 workspaceRoot 的路徑 */
  relPath: string;
  /** 0-based */
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface CompileResult {
  ok: boolean;
  blocked: boolean;
  diagnostics: LintDiagnostic[];
  units: Unit[];
  regenerated: Unit[];
  reused: number;
  orphans: string[];
  manifest: Manifest | null;
  errors: string[];
}

export interface RunResult extends CompileResult {
  output: string;
  exitCode: number | null;
}
