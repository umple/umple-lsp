# Editor Integrations

Editors with full plugin support have their own repos. Editors that only need LSP client config have setup guides here.

| Editor | Setup | Diagnostics | Go-to-def | Completion | Syntax Highlighting |
|--------|-------|-------------|-----------|------------|---------------------|
| [VS Code](vscode/) | [Separate repo](https://github.com/umple/umple.vscode) | ✅ | ✅ | ✅ | ✅ (TextMate + semantic tokens) |
| [Neovim](neovim/) | [Separate repo](https://github.com/umple/umple.nvim) | ✅ | ✅ | ✅ | ✅ (tree-sitter) |
| [Zed](zed/) | [Separate repo](https://github.com/umple/umple.zed) | ✅ | ✅ | ✅ | ✅ (tree-sitter) |
| [Sublime Text](sublime/) | Config in this repo | ✅ | ✅ | ✅ | ⚠️ (basic regex) |
| [BBEdit](bbedit/) | Config in this repo | ✅ | ✅ | ✅ | ⚠️ (codeless language module) |

## Prerequisites

- **Node.js 20+**: Required to run the LSP server (tested on 20 and 23)
- **Java 11+**: Required for umplesync.jar (Umple compiler diagnostics — optional otherwise)

How each editor delivers the LSP server differs:

- **Zed and Neovim** auto-pull `umple-lsp-server` from npm during plugin install / extension load. Users get new server versions automatically.
- **VS Code** bundles a pinned `umple-lsp-server` build inside the published `.vsix` at packaging time. Users only get a new server when the extension is repackaged + republished. (See `umple.vscode/README.md` for the local-tarball workflow.)
- **Sublime Text, BBEdit, IntelliJ** require a manual install: `npm install -g umple-lsp-server`.

For development or manual setup, build the server first:

```bash
cd umple-lsp
npm install
npm run compile
npm run download-jar
```

## Architecture

All editors connect to the same LSP server (`packages/server/out/server.js`) via stdio.

```
Your Editor
    │
    └─ (stdio) ─→ server.js ─→ umplesync.jar (diagnostics)
                     │
                     └─ tree-sitter (go-to-definition, completion,
                                      references, rename, hover,
                                      formatting, symbols, semantic tokens)
```

## Where Features Live

Core language behavior belongs in this repo, not in the editor wrappers:

- `packages/server`: diagnostics, completion, hover, go-to-definition, references, rename, formatting, workspace symbols, code actions, and LSP semantic tokens
- `packages/tree-sitter-umple`: parser and query files such as `highlights.scm`
- `umple.vscode`, `umple.nvim`, `umple.zed`: editor install/runtime wrappers, packaging, editor-specific UI, cache handling, and grammar sync

For highlighting, fix shared tree-sitter captures in `packages/tree-sitter-umple/queries/highlights.scm` first. VS Code can additionally show LSP semantic tokens mapped in `packages/server/src/semanticTokens.ts`; Neovim and Zed primarily show the tree-sitter highlight query from their local/synced grammar copy.

## Initialization Options

When configuring an LSP client, you may pass these initialization options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `umpleSyncJarPath` | string | auto-discovered at `<server>/../umplesync.jar` (since v0.2.6) | Path to umplesync.jar. Diagnostics are silently disabled if the jar can't be found. |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync subprocess (ms). Override with `UMPLESYNC_TIMEOUT_MS` env var. |

The server spawns `java -jar umplesync.jar` as a subprocess per validation request. There is no socket server / port — earlier docs that mentioned `umpleSyncPort` / `umpleSyncHost` referred to a design that was never shipped.

## Adding Support for a New Editor

1. If the editor needs a plugin/extension with its own build step → create a separate repo (e.g., `umple.zed`)
2. If the editor just needs LSP client config → add a folder here with a `README.md` and any config files
