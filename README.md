# Umple LSP

A Language Server Protocol implementation for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files across multiple editors.

## Features

- **Diagnostics** - Real-time error and warning detection via the Umple compiler
- **Go-to-definition** - Jump to classes, interfaces, traits, enums, attributes, methods, state machines, states, associations, mixsets, and requirements. Container-scoped resolution prevents false cross-class jumps.
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
| filter | * | ✅ | Named/unnamed, numeric names, glob patterns, hops; class completions in `include`; go-to-def for plain names |
| useStatement | ** | ✅ | File completions and go-to-def; `lib:` paths parse cleanly (runtime resolution deferred); comma-separated `use A.ump, B.ump;` |
| requireStatement | ** | ✅ | `require [mixset]`, `require subfeature [...]` with boolean operators |
| isFeature | * | ✅ | Feature declarations in mixsets and top-level |
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
| attribute | ** | ✅ | All modifiers (incl. `immutable`), typed/untyped, defaults |
| inlineAssociation | ** | ✅ | All arrow types; type refs include traits and interfaces |
| concreteMethodDeclaration | ** | ✅ | Visibility, static, return type, params |
| constantDeclaration | ** | ✅ | |
| enumerationDefinition | ** | ✅ | Inside class or top-level |
| templateAttributeDefinition | * | ✅ | `name <<! ... !>>` |
| emitMethod | * | ✅ | `emit name(params)(templates);` |
| invariant | * | ✅ | Both `[expr]` and named `[name: expr]`; name field is structurally distinct |
| **State machine** | | | |
| inlineStateMachine | ** | ✅ | With queued/pooled |
| state | ** | ✅ | Nested states, concurrent regions (`\|\|`) |
| transitions (event/guard/action) | ** | ✅ | All forms: event, guard, pre-arrow action, post-arrow action; guard-before-event ordering |
| guard semantics | ** | ✅ | Structured constraint expressions; go-to-def and completion on attributes/constants inside guards (own + inherited); event params and method calls deferred |
| entry / exit / do | ** | ✅ | Optional guard and language-tagged code blocks |
| changeType markers (+/-/\*) | ** | ✅ | |
| standaloneTransition | ** | ✅ | In SM body and state body |
| final states | ** | ✅ | `Final` auto-terminal; `final stateName {}` explicit final |
| trace statements | * | ✅ | Common forms: `trace`, `tracecase`, `activate`/`deactivate`; postfix clauses; full MOTL coverage not yet verified |
| concreteMethodDeclaration (in state body) | * | ✅ | Methods inside state bodies |
| mixsetDefinition (in SM/state) | ** | ✅ | In SM body, state body, and top-level |
| activeDefinition | * | ✅ | `active [codeLangs] [name] moreCode+`; comma-separated lang tags are spec-valid but crash current compiler (E9100 bug) |
| **Top-level entities** | | | |
| traitDefinition | * | ✅ | Parameters (isA constraints, default types, `&`-multi-constraint), abstract methods, nested traits, application-side bindings |
| interfaceDefinition | ** | ✅ | |
| associationDefinition | ** | ✅ | |
| associationClassDefinition | ** | ✅ | |
| stateMachineDefinition | ** | ✅ | |
| topLevelCodeInjection | * | ✅ | `before/after/around { Class } op { code }` |
| templateDefinition (top-level) | * | ✅ | Excluded for project scope: official grammar defines it, but non-empty top-level templates crash the current compiler and no manual examples exist |

**Summary**: ✅ 43 supported, ❌ 0 not supported, ⚠️ 1 partial

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
│   ├── server/                        # Standalone LSP server (npm: umple-lsp-server)
│   │   ├── src/
│   │   │   ├── server.ts              # LSP wiring, handlers, diagnostics orchestration
│   │   │   ├── symbolIndex.ts         # Symbol indexing, storage, queries
│   │   │   ├── resolver.ts            # Go-to-def / hover / rename symbol resolution
│   │   │   ├── completionAnalysis.ts  # Completion context detection (scope, keywords)
│   │   │   ├── completionBuilder.ts   # Completion item assembly
│   │   │   ├── tokenAnalysis.ts       # Token/context detection at cursor position
│   │   │   ├── referenceSearch.ts     # Find-references semantic matching
│   │   │   ├── hoverBuilder.ts        # Hover markdown content builders
│   │   │   ├── documentSymbolBuilder.ts # Document outline (symbol hierarchy)
│   │   │   ├── formatter.ts           # Document formatting (indent + skip ranges)
│   │   │   ├── importGraph.ts         # Forward/reverse import edge management
│   │   │   ├── tokenTypes.ts          # Shared token/symbol type definitions
│   │   │   ├── symbolTypes.ts         # Shared symbol entry types
│   │   │   ├── treeUtils.ts           # Shared tree-walking utilities
│   │   │   └── keywords.ts            # Built-in type names
│   │   └── test/                      # Semantic regression tests
│   │       ├── semantic.test.ts       # Test runner (58 assertions)
│   │       ├── helpers.ts             # Test harness helpers
│   │       └── fixtures/semantic/     # .ump fixture files
│   └── tree-sitter-umple/             # Tree-sitter grammar & queries
├── editors/                           # Setup guides for Sublime, manual Neovim config
└── test/                              # Sample .ump files
```

```
Editor Plugin (separate repos)
  │
  └── (stdio) ──► server.ts ──► umplesync.jar (diagnostics)
                     │
                     ├── resolver.ts ──► symbolIndex.ts (go-to-def, hover, rename)
                     ├── completionAnalysis.ts + completionBuilder.ts (completion)
                     ├── referenceSearch.ts (find-references)
                     ├── hoverBuilder.ts (hover content)
                     ├── documentSymbolBuilder.ts (outline)
                     ├── formatter.ts (formatting)
                     └── tokenAnalysis.ts + treeUtils.ts (shared analysis)
```

- **Server** (`packages/server/`) — Editor-agnostic LSP server (npm-publishable as `umple-lsp-server`). Split into focused modules: `server.ts` handles LSP wiring and diagnostics orchestration; semantic logic lives in dedicated modules.
- **Tree-sitter grammar** (`packages/tree-sitter-umple/`) — Parser and syntax highlighting queries

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
npm test               # Run semantic regression tests (58 assertions)
```

### Testing

The project includes a semantic regression test harness that exercises go-to-definition, find-references, completion, hover, document symbols, and formatting. Tests use real `.ump` fixture files with `/*@marker*/` annotations for position-independent assertions.

```bash
npm test    # Compile + run all 58 assertions
```

### Manual Testing

Run the server directly for JSON-RPC testing:

```bash
node packages/server/out/server.js --stdio
```
