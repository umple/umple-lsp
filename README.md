# Umple LSP

A Language Server Protocol implementation for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files across multiple editors.

## Features

- **Diagnostics** - Real-time error and warning detection via the Umple compiler
- **Go-to-definition** - Jump to classes, attributes, state machines, states, and associations
- **Code completion** - Context-aware keyword and symbol suggestions
- **Syntax highlighting** - Tree-sitter grammar for accurate highlighting
- **Cross-file support** - Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** - Errors in imported files shown on the `use` statement line

## Editor Plugins

| Editor | Repo |
|--------|------|
| VS Code | [umple.vscode](https://github.com/DraftTin/umple.vscode) |
| Neovim | [umple.nvim](https://github.com/DraftTin/umple.nvim) |
| Sublime Text | [Setup guide](editors/sublime/) (config only, no plugin needed) |

## Prerequisites

- **Node.js 18+**
- **Java 11+** (for the Umple compiler)

## Quick Start

```bash
npm install
npm run compile
npm run download-jar
```

Then install the plugin for your editor (see table above).

## Architecture

```
umple-lsp/
├── packages/
│   ├── server/              # Standalone LSP server (npm: umple-lsp-server)
│   └── tree-sitter-umple/   # Tree-sitter grammar & queries
├── editors/                 # Setup guides for Sublime, manual Neovim config
└── test/                    # Sample .ump files
```

```
Editor Plugin (separate repos)
  |
  +-- (stdio) --> server.js --> umplesync.jar (diagnostics)
                    |
                    +-- tree-sitter (go-to-definition, symbol indexing)
```

- **Server** (`packages/server/`) - Editor-agnostic LSP server (npm-publishable as `umple-lsp-server`)
- **Tree-sitter grammar** (`packages/tree-sitter-umple/`) - Parser and syntax highlighting queries

The server uses lazy indexing: files are only parsed when opened, and only files reachable via `use` statements are indexed. This keeps startup fast regardless of workspace size.

## Tree-sitter Grammar

The tree-sitter grammar in `packages/tree-sitter-umple/` is used by both the LSP server (for symbol indexing) and editors like Neovim (for syntax highlighting).

After editing `grammar.js`:

```bash
cd packages/tree-sitter-umple
npx tree-sitter generate      # Regenerate parser
npx tree-sitter build --wasm  # Rebuild WASM for LSP server
```

## Configuration

The LSP server accepts these initialization options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `umpleSyncJarPath` | string | required | Path to umplesync.jar |
| `umpleSyncPort` | number | 5556 | Port for umplesync socket server |
| `umpleSyncHost` | string | "localhost" | Host for umplesync connection |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync requests |

Environment variables: `UMPLESYNC_JAR_PATH`, `UMPLESYNC_HOST`, `UMPLESYNC_PORT`, `UMPLESYNC_TIMEOUT_MS`, `UMPLE_TREE_SITTER_WASM_PATH`

Use different ports if running multiple editor instances simultaneously.

## Development

```bash
npm run compile    # Build server
npm run watch      # Watch mode
```

Test by running the server directly:

```bash
node packages/server/out/server.js --stdio
```
