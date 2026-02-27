# Umple LSP

A Language Server Protocol implementation for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files across multiple editors.

## Features

- **Diagnostics** - Real-time error and warning detection via the Umple compiler
- **Go-to-definition** - Jump to classes, interfaces, traits, enums, attributes, methods, state machines, states, associations, mixsets, and requirements
- **Code completion** - Context-aware keyword and symbol suggestions
- **Syntax highlighting** - Tree-sitter grammar for accurate highlighting
- **Cross-file support** - Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** - Errors in imported files shown on the `use` statement line

## Umple Grammar Coverage

The table below shows the LSP's support for Umple language features, based on the [Umple Grammar](https://cruise.umple.org/umple/UmpleGrammar.html). Priority: `**` = high, `*` = lower.

| Feature | Priority | Status | Notes |
|---|---|---|---|
| **Directive (top level)** | | | |
| generate | * | ✅ | Language names, path, `--override`, `-s` suboption |
| suboption | * | ⚠️ | Syntax works; specific suboption names not enumerated |
| filter | * | ❌ | |
| useStatement | ** | ✅ | File paths + mixset references; file completions; go-to-def |
| requirement | ** | ✅ | Parsed, indexed, go-to-def |
| reqImplementation | ** | ✅ | Identifiers reference requirements; go-to-def |
| **Entity** | | | |
| mixsetDefinition | ** | ✅ | Top-level and inside class/SM bodies |
| classDefinition | ** | ✅ | Including nested classes |
| **Class content** | | | |
| displayColor | ** | ✅ | In class body and state body |
| abstract | ** | ✅ | `abstract;` standalone |
| immutable | ** | ✅ | `immutable;` standalone |
| keyDefinition | ** | ✅ | `key { attr1, attr2 }` with attribute references |
| softwarePattern (isA, singleton, codeInjection) | ** | ✅ | |
| depend | ** | ✅ | |
| symmetricReflexiveAssociation | ** | ✅ | |
| attribute | ** | ✅ | All modifiers, typed/untyped, defaults |
| inlineAssociation | ** | ✅ | All arrow types |
| concreteMethodDeclaration | ** | ✅ | Visibility, static, return type, params |
| constantDeclaration | ** | ✅ | |
| enumerationDefinition | ** | ✅ | Inside class or top-level |
| templateAttributeDefinition | * | ✅ | `name <<! ... !>>` |
| emitMethod | * | ✅ | `emit name(params)(templates);` |
| invariant | * | ⚠️ | Constraints `[expr]` work; named `[name: expr]` not captured |
| **State machine** | | | |
| inlineStateMachine | ** | ✅ | With queued/pooled |
| state | ** | ✅ | Nested states, concurrent regions (`\|\|`) |
| transitions (event/guard/action) | ** | ✅ | |
| entry / exit / do | ** | ✅ | |
| changeType markers (+/-/\*) | ** | ✅ | |
| standaloneTransition | ** | ✅ | In SM body and state body |
| mixsetDefinition (in SM) | ** | ✅ | |
| activeDefinition | * | ✅ | `active { code }` or `active name { code }` |
| **Top-level entities** | | | |
| traitDefinition | * | ✅ | Without traitParameters |
| interfaceDefinition | ** | ✅ | |
| associationDefinition | ** | ✅ | |
| associationClassDefinition | ** | ✅ | |
| stateMachineDefinition | ** | ✅ | |
| topLevelCodeInjection | * | ✅ | `before/after/around { Class } op { code }` |
| templateDefinition (top-level) | * | ❌ | Usage unclear; needs clarification |

**Summary**: ✅ 38 supported, ❌ 3 not supported, ⚠️ 2 partial

## Editor Plugins

| Editor | Repo | Auto-installs server? |
|--------|------|-----------------------|
| VS Code | [umple.vscode](https://github.com/umple/umple.vscode) | Yes |
| Zed | [umple.zed](https://github.com/umple/umple.zed) | Yes |
| Neovim | [umple.nvim](https://github.com/umple/umple.nvim) | Yes |
| Sublime Text | [Setup guide](editors/sublime/) (config only) | No (manual build) |

The LSP server is also available as an npm package: [`umple-lsp-server`](https://www.npmjs.com/package/umple-lsp-server)

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
npm run build-grammar          # Regenerate parser + WASM + compile server
```

## Configuration

The LSP server accepts these initialization options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `umpleSyncJarPath` | string | required | Path to umplesync.jar |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync per-request process (ms) |

Environment variables: `UMPLESYNC_JAR_PATH`, `UMPLESYNC_TIMEOUT_MS`, `UMPLE_TREE_SITTER_WASM_PATH`

## Development

```bash
npm run compile        # Build server (also copies WASM)
npm run build-grammar  # Full rebuild after grammar.js changes
npm run watch          # Watch mode
```

Test by running the server directly:

```bash
node packages/server/out/server.js --stdio
```
