# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Umple Language Reference

Before working on this project, familiarize yourself with Umple syntax:

- **User Manual**: https://cruise.umple.org/umple/GettingStarted.html
- **Try Online**: https://try.umple.org

Key syntax patterns:

```umple
class Person {
  name;                      // Attribute (String by default)
  Integer age;               // Typed attribute
  1 -- * Address addresses;  // Inline association with role name
}

class Student {
  isA Person;                // Inheritance
}

association {                // Standalone association block
  0..1 Mentor -- * Student;
}

class GarageDoor {
  status {                   // State machine
    Open { buttonOrObstacle -> Closing; }
    Closing { buttonOrObstacle -> Opening; reachBottom -> Closed; }
    Closed { buttonOrObstacle -> Opening; }
    Opening { buttonOrObstacle -> Closing; reachTop -> Open; }
  }
}

use "OtherFile.ump";         // Include another Umple file (semicolon optional)
use AnotherFile.ump          // Also valid without quotes or semicolon
```

## Project Overview

This is a VS Code Language Server Protocol (LSP) extension for the Umple modeling language. It provides IDE features including diagnostics, code completion, and go-to-definition for `.ump` files. Also includes a tree-sitter grammar for syntax highlighting in editors like Neovim.

## Build Commands

```bash
# Compile both client and server
npm run compile

# Watch mode for development
npm run watch

# Install all dependencies (runs automatically via postinstall)
npm run postinstall
```

### Tree-sitter Grammar

```bash
cd tree-sitter-umple

# Regenerate parser after grammar.js changes
npx tree-sitter generate

# Build WebAssembly version (used by LSP server)
npx tree-sitter build --wasm

# Test parsing
npx tree-sitter parse ../test/Student.ump
```

**Files in tree-sitter-umple/:**

| File | Type | Description |
|------|------|-------------|
| `grammar.js` | Manual | Grammar definition - edit this to change parsing rules |
| `queries/highlights.scm` | Manual | Syntax highlighting queries |
| `queries/locals.scm` | Manual | Scope and definition tracking |
| `src/parser.c` | Generated | C parser (regenerate with `tree-sitter generate`) |
| `src/grammar.json` | Generated | JSON representation of grammar |
| `src/node-types.json` | Generated | All valid node types (useful for writing queries) |
| `tree-sitter-umple.wasm` | Generated | WebAssembly parser (regenerate with `tree-sitter build --wasm`) |

**Workflow after editing grammar.js:**

```bash
cd tree-sitter-umple
npx tree-sitter generate      # Regenerate src/parser.c
npx tree-sitter build --wasm  # Rebuild .wasm for LSP
cd ..
npm run compile               # Recompile TypeScript
# In Neovim: :TSInstall umple  # Reinstall native parser
```

## Testing

No automated test framework is configured. Testing is done manually via VS Code's Extension Development Host:

- Press F5 in VS Code to launch a new window with the extension loaded
- Open `.ump` files in the test window to verify functionality

Sample test files are in the `/test/` directory.

## Architecture

```
Client (client/src/extension.ts)
    │
    └─ Launches → Server (server/src/server.ts)
                      │
                      ├─ Diagnostics   → UmpleSync.jar (socket server, port 5556)
                      ├─ Completion    → Keywords (keywords.ts) + context detection
                      └─ Go-To-Def     → SymbolIndex (tree-sitter based)

Tree-sitter Grammar (tree-sitter-umple/)
    │
    ├─ grammar.js              → Grammar definition (manual)
    ├─ queries/highlights.scm  → Syntax highlighting (manual)
    ├─ queries/locals.scm      → Scope tracking (manual)
    ├─ src/parser.c            → Generated parser
    └─ tree-sitter-umple.wasm  → WebAssembly parser for LSP
```

### Key Components

**Client (`client/src/extension.ts`)**: VS Code extension entry point. Launches the language server and passes initialization options (JAR paths, port configuration).

**Server (`server/src/server.ts`)**: Core LSP implementation handling:

- Document synchronization (open/change/close events)
- Diagnostics via UmpleSync.jar socket connection with debounced validation
- Context-aware code completion (detects if cursor is in class/statemachine/association/enum)
- Go-to-definition using tree-sitter symbol index with transitive `use` statement resolution

**Symbol Index (`server/src/symbolIndex.ts`)**: Tree-sitter based symbol indexing:

- Parses `.ump` files using web-tree-sitter (WASM)
- **Lazy indexing**: Files are indexed on-demand when opened, not upfront
- When a file is opened, it and all files it references via `use` statements are indexed
- Maintains in-memory index of symbol definitions (classes, interfaces, traits, enums, attributes, methods, state machines, states, associations)
- Content hash caching for efficient re-indexing
- Comment detection to prevent go-to-definition inside comments

**Keywords (`server/src/keywords.ts`)**: Keyword database organized by context (topLevel, classLevel, statemachine, etc.) for context-aware completion.

### External Dependencies

- `umplesync.jar`: Compiler wrapper running as socket server for diagnostics

### Go-To-Definition

The go-to-definition feature uses tree-sitter for fast, accurate symbol lookup:

1. **Lazy Indexing**: Files are indexed when opened (not on workspace open)
2. **Transitive Use Resolution**: When a file is opened, all files it imports via `use` statements are also indexed
3. **Scoped Lookup**: Go-to-definition only returns symbols from files reachable via `use` statements from the current file
4. **Use Statement Navigation**: Go-to-definition on a `use` statement opens the referenced file
5. **Comment Detection**: Go-to-definition is disabled when cursor is inside a comment

### Diagnostics

Diagnostics are provided via UmpleSync.jar, which runs as a socket server.

**Shadow Workspace**: For accurate cross-file diagnostics, the server creates a temporary shadow workspace that:
1. Includes only files reachable via `use` statements (lazy approach)
2. Overlays unsaved document content from open editors
3. Runs UmpleSync on the shadow workspace
4. Cleans up after compilation

This ensures diagnostics reflect unsaved changes while keeping the workspace minimal.

**Import Error Handling** (similar to clangd):
- Errors in directly imported files appear on the `use` statement line
- Errors in transitively imported files (A uses B, B uses C, C has error) appear on the direct `use` line (the `use B.ump` line in A)
- Message format: `"In imported file (filename:line): error message"`

**Dependent File Validation**:
- When a file is modified, all open files that import it (directly or transitively) are automatically re-validated
- Uses debouncing (500ms) to avoid excessive re-validation during rapid edits
- Only re-validates files that actually depend on the changed file

## Configuration

Server initialization options (passed from client):

- `umpleSyncJarPath`: Path to umplesync.jar
- `umpleSyncPort` (default 5556), `umpleSyncHost`, `umpleSyncTimeoutMs`: Socket configuration

Environment variable overrides: `UMPLESYNC_HOST`, `UMPLESYNC_PORT`, `UMPLESYNC_TIMEOUT_MS`

## Neovim Integration

To use the tree-sitter grammar with Neovim:

### How It Works

Neovim's nvim-treesitter uses a naming convention to match parsers with filetypes:

1. **Filetype**: When you open `.ump` file, Neovim sets `filetype=umple`
2. **Parser**: nvim-treesitter looks for a parser named `umple`
3. **Queries**: Loaded from `~/.local/share/nvim/queries/umple/` (or plugin directories)

The parser name in your Neovim config (`parser_config.umple`) must match the query folder name.

### Setup Steps

1. Register the parser in your Neovim config:

```lua
local parser_config = require("nvim-treesitter.parsers").get_parser_configs()
parser_config.umple = {
  install_info = {
    url = "/path/to/umple-lsp/tree-sitter-umple",
    files = { "src/parser.c" },
  },
  filetype = "umple",
}
```

2. Symlink queries to Neovim runtime:

```bash
mkdir -p ~/.local/share/nvim/queries
ln -s /path/to/umple-lsp/tree-sitter-umple/queries ~/.local/share/nvim/queries/umple
```

3. Set filetype for `.ump` files:

```lua
vim.filetype.add({ extension = { ump = "umple" } })
```

4. Install the parser:

```vim
:TSInstall umple
```

### Updating After Grammar Changes

After modifying `grammar.js`:

```bash
cd tree-sitter-umple
npx tree-sitter generate
```

Then in Neovim, reinstall the parser to recompile from `src/parser.c`:

```vim
:TSInstall umple
```

Note: The `.wasm` file is only used by the LSP server, not by Neovim. Neovim compiles a native `.so` from `src/parser.c`.
