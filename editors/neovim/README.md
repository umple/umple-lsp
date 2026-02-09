# Umple LSP for Neovim

This guide explains how to set up the Umple Language Server with Neovim.

For a plug-and-play lazy.nvim plugin, see [umple-lsp.nvim](https://github.com/DraftTin/umple-lsp.nvim) (coming soon).

## Prerequisites

- Neovim 0.8+ (with built-in LSP support)
- Node.js 18+
- Java 11+ (for umplesync.jar)
- [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig)
- [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter) (for syntax highlighting)

## Installation

### 1. Build the LSP server

```bash
git clone https://github.com/DraftTin/umple-lsp.git
cd umple-lsp
npm install
npm run compile
npm run download-jar
```

### 2. Add LSP configuration to Neovim

Add to your `init.lua` (update the path):

```lua
dofile('/path/to/umple-lsp/editors/neovim/umple.lua')
```

Or copy the contents of `umple.lua` into your config. Update `UMPLE_LSP_PATH` at the top.

### 3. Install tree-sitter parser

Run in Neovim:

```vim
:TSInstall umple
```

### 4. Symlink highlight queries

```bash
# For standard nvim-treesitter:
ln -s /path/to/umple-lsp/packages/tree-sitter-umple/queries ~/.local/share/nvim/queries/umple

# For lazy.nvim users:
ln -s /path/to/umple-lsp/packages/tree-sitter-umple/queries ~/.local/share/nvim/lazy/nvim-treesitter/queries/umple
```

## Features

- **Diagnostics**: Real-time error and warning detection
- **Go-to-definition**: Jump to class, attribute, state definitions
- **Code completion**: Context-aware keyword and symbol completion
- **Syntax highlighting**: Via tree-sitter grammar

## Updating

```bash
cd /path/to/umple-lsp
git pull
npm install
npm run compile
npm run download-jar
```

In Neovim, reinstall the tree-sitter parser if grammar changed:

```vim
:TSInstall umple
```

## Troubleshooting

### LSP not starting

1. Check if Java is installed: `java -version`
2. Check if the server runs manually:
   ```bash
   node /path/to/umple-lsp/packages/server/out/server.js --stdio
   ```
3. Check Neovim LSP logs: `:LspLog`

### No syntax highlighting

1. Ensure tree-sitter parser is installed: `:TSInstallInfo`
2. Verify filetype is set: `:set filetype?` (should show `umple`)
3. Check if queries are linked correctly
