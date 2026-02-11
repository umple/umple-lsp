# Editor Integrations

Editors with full plugin support have their own repos. Editors that only need LSP client config have setup guides here.

| Editor | Setup | Diagnostics | Go-to-def | Completion | Syntax Highlighting |
|--------|-------|-------------|-----------|------------|---------------------|
| [VS Code](vscode/) | [Separate repo](https://github.com/umple/umple.vscode) | ✅ | ✅ | ✅ | ✅ (TextMate) |
| [Neovim](neovim/) | [Separate repo](https://github.com/umple/umple.nvim) | ✅ | ✅ | ✅ | ✅ (tree-sitter) |
| [Zed](zed/) | [Separate repo](https://github.com/umple/umple.zed) | ✅ | ✅ | ✅ | ✅ |
| [Sublime Text](sublime/) | Config in this repo | ✅ | ✅ | ✅ | ⚠️ (basic regex) |

## Prerequisites (All Editors)

1. **Node.js 18+**: Required to run the LSP server
2. **Java 11+**: Required for umplesync.jar (Umple compiler)

Build the LSP server first:

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
                     └─ tree-sitter (go-to-definition, lazy indexing)
```

## Initialization Options

When configuring an LSP client, pass these initialization options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `umpleSyncJarPath` | string | required | Path to umplesync.jar |
| `umpleSyncPort` | number | 5556 | Port for umplesync socket server |
| `umpleSyncHost` | string | "localhost" | Host for umplesync connection |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync requests |

Use different ports for each editor if running multiple instances simultaneously.

## Adding Support for a New Editor

1. If the editor needs a plugin/extension with its own build step → create a separate repo (e.g., `umple.zed`)
2. If the editor just needs LSP client config → add a folder here with a `README.md` and any config files
