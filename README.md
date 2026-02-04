# Umple LSP

A Language Server Protocol implementation for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files across multiple editors.

## Features

- **Diagnostics** - Real-time error and warning detection via the Umple compiler
- **Go-to-definition** - Jump to classes, attributes, state machines, states, and associations
- **Code completion** - Context-aware keyword and symbol suggestions
- **Syntax highlighting** - Tree-sitter grammar for accurate highlighting
- **Cross-file support** - Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** - Errors in imported files shown on the `use` statement line

## Supported Editors

| Editor | Diagnostics | Go-to-def | Completion | Syntax Highlighting |
|--------|-------------|-----------|------------|---------------------|
| [VS Code](#vs-code) | Yes | Yes | Yes | TextMate + tree-sitter |
| [Neovim](editors/neovim/) | Yes | Yes | Yes | tree-sitter |
| [Sublime Text](editors/sublime/) | Yes | Yes | Yes | Basic regex |

## Prerequisites

- **Node.js 18+**
- **Java 11+** (for the Umple compiler)

## Quick Start

```bash
npm install
npm run compile
npm run download-jar
```

Then follow the setup guide for your editor below.

## VS Code

1. Open this project in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open a `.ump` file in the new window

## Other Editors

See the [editors/](editors/) directory for setup guides:

- [Neovim](editors/neovim/) - tree-sitter highlighting + LSP via lspconfig
- [Sublime Text](editors/sublime/) - LSP package + basic syntax highlighting

All editors connect to the same LSP server (`server/out/server.js`) via stdio.

## Architecture

```
Editor
  |
  +-- (stdio) --> server.js --> umplesync.jar (diagnostics)
                    |
                    +-- tree-sitter (go-to-definition, symbol indexing)
```

- **Client** (`client/`) - VS Code extension entry point
- **Server** (`server/`) - LSP server (editor-agnostic)
- **Tree-sitter grammar** (`tree-sitter-umple/`) - Parser and syntax highlighting queries

The server uses lazy indexing: files are only parsed when opened, and only files reachable via `use` statements are indexed. This keeps startup fast regardless of workspace size.

## Tree-sitter Grammar

The tree-sitter grammar in `tree-sitter-umple/` is used by both the LSP server (for symbol indexing) and editors like Neovim (for syntax highlighting).

After editing `grammar.js`:

```bash
cd tree-sitter-umple
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

Use different ports if running multiple editor instances simultaneously.

## Development

```bash
npm run compile    # Build client and server
npm run watch      # Watch mode
```

Test by pressing `F5` in VS Code or by running the server directly:

```bash
node server/out/server.js --stdio
```
