# S-IDE

> Turn existing C# source code into a Markdown documentation set with call chains, so humans can understand what the code does.

Code stays the source of truth. The Markdown is a disposable projection: a second view on top of the code, not a replacement for it.

## What it does

Click one button and get a `semDocs/` folder that mirrors your source tree:

```
semDocs/
  index.md
  Endpoints/
    ProductEndpoints.md
  Infrastructure/
    Repositories/
      Repository.md
```

Every class becomes a section; every method and property becomes a heading with:

- its signature
- **pseudocode steps** (or a one-line summary for trivial members)
- **call links** to other documented members

```markdown
### HandleAsync
`Task<ActionResult<List<ProductDto>>> HandleAsync(CancellationToken ct)`

1. Fetch all products from the repository
2. Project each product into a response DTO
3. Return the list

- Calls → IRepository<T>.GetAllAsync
```

Call links are plain relative links (`../Path/File.md#anchor`), so they work in the VS Code preview, GitHub, and Obsidian.

## Quick start

1. Install the [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) (required for symbols and references).
2. Open a C# workspace.
3. Click the **S-IDE** icon in the Activity Bar.
4. Press the gear icon → pick a provider → paste your API key → **Test connection**.
5. Press **Sync Semantic Docs**.

The first run builds everything. After that, only changed members are rewritten — untouched blocks are copied byte-for-byte, so `git diff` stays readable.

Commit `semDocs/` once after the first run. That makes the incremental baseline stable.

## Privacy

**This extension sends C# source snippets to the OpenAI-compatible endpoint you configure.** Nothing is sent anywhere else. There is no telemetry, no analytics, and no server operated by this extension.

Your API key is stored in VS Code's encrypted `SecretStorage`, never in `settings.json`.

## Settings

| Setting | Description |
|---|---|
| `side.language` | Output language: `en` (default) or `zh-TW` |
| `side.baseUrl` | OpenAI-compatible endpoint |
| `side.model` | Model name |
| `side.docsDir` | Output folder (default `semDocs`) |

Common endpoints:

| Provider | Base URL | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | `glm-5.3-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Ollama | `http://localhost:11434/v1` | `qwen2.5-coder:7b` |

Use a cheap, non-reasoning model. This task is many small requests with a strict output format; reasoning models mostly add cost and empty responses.

## How it works

- **Topology is computed, not generated.** Nodes come from VS Code's `DocumentSymbol`; call edges come from `executeReferenceProvider` (full build) or `executeDefinitionProvider` (incremental).
- **AI only writes prose.** Links, anchors, and layout are produced by code, so a bad description can never break a link.
- **Incremental by design.** `git status` plus `git diff` decide which members to rebuild. Unchanged blocks are reused verbatim.

## Requirements

- VS Code 1.90 or newer
- The C# extension (`ms-dotnettools.csharp`)
- An OpenAI-compatible API key

## Known limitations

- `Program.cs` with top-level statements produces no symbols, so it is skipped.
- Partial classes produce one document per file.
- A change to code that does not change the generated text leaves that file "pending" until the next document change is committed.
- Large repositories make the first full build slow (one metadata query per member).

## Development

```bash
npm install
npm run compile
npm run check     # enforces that src/core has no vscode dependency
```

Press <kbd>F5</kbd> to launch the Extension Development Host.

## License

MIT
