# Changelog

## 0.1.0 — 2026-10-22

First release.

- Generate a Markdown documentation set from existing C# source code
- One `.md` per `.cs`, mirroring the source tree
- Each member gets a heading, signature, pseudocode steps (or a one-line summary), and call links
- Incremental sync: only changed members are rewritten; untouched blocks stay byte-identical
- Deleted `.cs` files remove their `.md` (and empty folders)
- Sidebar view: actions, last run summary, document tree
- Settings panel: provider presets, model, API key, docs folder, language, connection test
- Output language: English (default) or Traditional Chinese
- Privacy: source snippets are sent only to the endpoint you configure
