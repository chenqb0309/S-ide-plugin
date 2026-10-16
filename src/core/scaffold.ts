import path from 'node:path';
import type { SemFile } from './types';
import { backendDir, generatedDir } from './build';
import { ensureDir, exists, listFiles, readText, writeText } from './fsx';
import { genProgramCs, NAMESPACE } from './codegen';
import { PRELUDE_VERSION } from './versions';

/**
 * 首次使用時，偷偷把後台專案建起來。
 *
 * 這是白皮書的「隱匿黑盒子」：使用者永遠不會看到這個目錄的內容，
 * 它只是讓 .sem 能夠變成可執行的 .NET 程式。
 *
 * Prelude 由擴充套件提供（`<extensionPath>/prelude/*.cs`），
 * 複製進 `.semantic_backend/Prelude/` —— AI 只能引用，不能發明。
 */

export interface ScaffoldResult {
  created: boolean;
  copiedPrelude: string[];
}

export function scaffold(workspaceRoot: string, extensionPath: string, files: SemFile[]): ScaffoldResult {
  const backend = backendDir(workspaceRoot);
  const created = !exists(path.join(backend, 'Backend.csproj'));

  ensureDir(backend);
  ensureDir(generatedDir(workspaceRoot));

  writeText(path.join(backend, 'Backend.csproj'), csproj());
  writeText(path.join(backend, 'S-IDE.md'), readme());
  writeText(path.join(backend, 'Program.cs'), genProgramCs(files), { bom: true });

  const copiedPrelude: string[] = [];
  const preludeSrc = path.join(extensionPath, 'prelude');
  ensureDir(path.join(backend, 'Prelude'));
  for (const name of listFiles(preludeSrc, (n) => n.endsWith('.cs'))) {
    const dest = path.join(backend, 'Prelude', name);
    const content = readText(path.join(preludeSrc, name));
    // 只在內容不同時才寫，避免每次存檔都動到檔案時間
    if (!exists(dest) || readText(dest) !== content) {
      writeText(dest, content, { bom: true });
      copiedPrelude.push(name);
    }
  }

  return { created, copiedPrelude };
}

function csproj(): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '',
    '  <!-- 由 S-IDE 生成。請勿手動編輯。 -->',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    '    <TargetFramework>net10.0</TargetFramework>',
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    `    <RootNamespace>${NAMESPACE}</RootNamespace>`,
    '    <AssemblyName>Backend</AssemblyName>',
    '    <InvariantGlobalization>true</InvariantGlobalization>',
    '  </PropertyGroup>',
    '',
    '</Project>',
    '',
  ].join('\n');
}

function readme(): string {
  return [
    '# .semantic_backend',
    '',
    '這個目錄由 **S-IDE** 自動生成與管理。**請勿手動編輯。**',
    '',
    '| 目錄 | 內容 | 可拋棄？ |',
    '|---|---|---|',
    '| `Generated/` | 由 `.sem` 生成的 C#。真實程式碼如同組合語言——你不必看 | **是**，刪掉會自動重建 |',
    '| `Prelude/` | 前導庫。由 harness 提供，AI 只能引用不能發明 | 由擴充套件覆寫 |',
    '| `Program.cs` | 入口，由 `類別 程式 { 方法 主() }` 機械生成 | 是 |',
    '',
    `Prelude 版本：${PRELUDE_VERSION}`,
    '',
    '唯一真相來源是 `.sem`。這裡的東西都是產物。',
    '',
  ].join('\n');
}
