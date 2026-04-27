# Umple LSP

[![CI](https://github.com/umple/umple-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/umple/umple-lsp/actions/workflows/ci.yml)

A Language Server Protocol implementation for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files across multiple editors.

> **📚 Contributors / future maintainers — start at [`wiki/README.md`](wiki/README.md).**
> The wiki has the full handoff documentation: architecture, dev setup, all four publishing pipelines (npm / VS Code / Zed / Neovim), CI automation, the AI-collab review protocol, and known gotchas.

## Features

- **Diagnostics** - Real-time error and warning detection via the Umple compiler
- **Go-to-definition** - Jump to classes, interfaces, traits, enums, attributes, methods, state machines, states, associations, mixsets, and requirements. Container-scoped resolution prevents false cross-class jumps. Includes reused standalone statemachine fallback.
- **Find references** - Semantic reference search with state-path disambiguation, inheritance chain walking, and shared-state equivalence for reused standalone statemachines
- **Find implementations** - Jump from traits, interfaces, and classes to their `isA` implementers, extensions, and subclasses
- **Rename** - Safe rename across all references (same pipeline as find-references)
- **Hover** - Contextual information for symbols with markdown formatting
- **Code completion** - Context-aware keyword and symbol suggestions
- **Document symbols** - Hierarchical outline of classes, state machines, states, attributes, methods
- **Workspace symbols** - Search across indexed files for classes, traits, requirements, state machines, states, methods, named associations, and query-matched members
- **Formatting** - AST-driven indent correction, arrow spacing, blank-line normalization, compact state expansion
- **Syntax highlighting** - Tree-sitter grammar for accurate highlighting
- **Semantic tokens** - LSP semantic highlighting for editors that do not load tree-sitter queries directly
- **Cross-file support** - Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** - Errors in imported files shown on the `use` statement line
- **Diagram navigation** - Custom LSP requests (`umple/resolveStateLocation`, `umple/resolveTransitionLocation`) for click-to-select in UML diagrams

### Parser vs compiler diagnostics

The LSP has two independent layers. Tree-sitter powers parsing, symbols,
completion, formatting, and editor highlighting; `umplesync.jar` remains the
authoritative compiler check for diagnostics. A construct can parse well enough
for LSP features and still receive an `umple compiler` diagnostic if the official
compiler rejects it.

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
| transitions (event/guard/action) | ** | ✅ | All forms: event, guard, pre-arrow action, post-arrow action; guard-before-event ordering; timed events `after(N)`/`afterEvery(N)` |
| guard semantics | ** | ✅ | Structured constraint expressions; go-to-def and completion on attributes/constants inside guards (own + inherited); event params and method calls deferred |
| entry / exit / do | ** | ✅ | Optional guard and language-tagged code blocks |
| referencedStateMachine | ** | ✅ | `sm as baseSM { ... }` reuse; shared-state equivalence for refs/rename; diagram click navigation with alias-local-first / base-fallback |
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
| codeInjection (wildcard) | * | ✅ | `before/after` with wildcard event patterns: `e*`, `ev*eee`, etc. |
| templateDefinition (top-level) | * | ✅ | Excluded for project scope: official grammar defines it, but non-empty top-level templates crash the current compiler and no manual examples exist |

**Summary**: ✅ 45 supported, ❌ 0 not supported, ⚠️ 1 partial

## Editor Plugins

| Editor | Repo | Auto-installs server? |
|--------|------|-----------------------|
| VS Code | [umple.vscode](https://github.com/umple/umple.vscode) ([Marketplace](https://marketplace.visualstudio.com/items?itemName=digized.umple)) | Bundled in `.vsix` at packaging time (not auto-pulled at runtime) |
| Zed | [umple.zed](https://github.com/umple/umple.zed) ([Zed Extensions](https://zed.dev/extensions?query=umple)) | Yes — downloaded from npm at extension load |
| Neovim | [umple.nvim](https://github.com/umple/umple.nvim) | Yes — `npm install umple-lsp-server` during plugin build |
| IntelliJ / JetBrains | [Setup guide](editors/intellij/) (LSP4IJ + npm) | No (`npm install -g`) |
| BBEdit | [Setup guide](editors/bbedit/) (plist + npm) | No (`npm install -g`) |
| Sublime Text | [Setup guide](editors/sublime/) (config only) | No (manual build) |

The LSP server is also available as an npm package: [`umple-lsp-server`](https://www.npmjs.com/package/umple-lsp-server)

## Prerequisites

- **Node.js 20+** (tested on 20 and 23)
- **Java 11+** (for the Umple compiler — only needed if you want diagnostics)

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
│   │   │   ├── semanticTokens.ts      # LSP semantic-token legend and highlight-query mapping
│   │   │   ├── formatter.ts           # Document formatting (indent, spacing, expansion)
│   │   │   ├── formatRules.ts         # Formatting node classification
│   │   │   ├── formatSafetyNet.ts     # Pre/post symbol-set check; aborts unsafe formats
│   │   │   ├── diagramNavigation.ts   # Diagram click-to-select resolution
│   │   │   ├── diagramRequests.ts     # Custom LSP request handlers for diagrams
│   │   │   ├── importGraph.ts         # Forward/reverse import edge management
│   │   │   ├── traitSmEventResolver.ts # Trait-side SM operation event lookup
│   │   │   ├── renameValidation.ts    # RENAMEABLE_KINDS + kind-aware new-name regex
│   │   │   ├── tokenTypes.ts          # Shared token/symbol type definitions
│   │   │   ├── symbolTypes.ts         # Shared symbol entry types
│   │   │   ├── treeUtils.ts           # Shared tree-walking utilities
│   │   │   └── keywords.ts            # Built-in type names
│   │   ├── bin/umple-lsp-server       # 2-line shell shebang requiring out/server.js
│   │   └── test/                      # Semantic regression tests
│   │       ├── semantic.test.ts       # Test runner (682 assertions)
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
                     ├── semanticTokens.ts (LSP semantic highlighting)
                     ├── formatter.ts (formatting)
                     ├── diagramNavigation.ts + diagramRequests.ts (diagram clicks)
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
| `umpleSyncJarPath` | string | auto-discovered at `<server>/../umplesync.jar` since v0.2.6 | Path to umplesync.jar. Diagnostics are silently disabled if the jar can't be found. |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync per-request process (ms) |

Environment variables: `UMPLESYNC_JAR_PATH`, `UMPLESYNC_TIMEOUT_MS`, `UMPLE_TREE_SITTER_WASM_PATH`

## Development

> **In-depth docs:** [`wiki/03-development.md`](wiki/03-development.md) covers first-time setup, dev symlink mode, programmatic test probes, and editor-specific reload tips. The summary below is just the most-used commands.

```bash
npm run compile        # Build server (also copies WASM)
npm run build-grammar  # Full rebuild after grammar.js changes
npm run watch          # Watch mode
npm test               # Run semantic regression tests plus the corpus parser self-test
```

### Testing

The project includes a semantic regression test harness that exercises go-to-definition, find-references, completion, hover, document symbols, and formatting. Tests use real `.ump` fixture files with `/*@marker*/` annotations for position-independent assertions.

```bash
npm test    # Compile + run the semantic suite and parser-report self-test
```

To stress-test grammar permissiveness against a local checkout of the upstream Umple compiler corpus, point the read-only report tool at `cruise.umple/test`:

```bash
UMPLE_CORPUS_DIR=/path/to/cruise.umple/test npm run parse:corpus
```

The corpus report does not download anything, and it is report-only by default. A missing corpus path skips cleanly; an explicitly invalid path fails so typos are visible. Use `UMPLE_CORPUS_FAIL_ON_ERROR=1` or `--fail-on-error` only after choosing a baseline that should gate CI.

### Manual Testing

Run the server directly for JSON-RPC testing:

```bash
node packages/server/out/server.js --stdio
```

## For Contributors

See [`wiki/`](wiki/) for the full project handoff:

| Topic | Page |
|-------|------|
| What this project is + architecture | [01-overview](wiki/01-overview.md), [02-architecture](wiki/02-architecture.md) |
| Setup, build, test | [03-development](wiki/03-development.md) |
| Editing the grammar | [04-grammar](wiki/04-grammar.md) |
| Releasing — npm | [05-publishing-npm](wiki/05-publishing-npm.md) |
| Releasing — VS Code | [06-publishing-vscode](wiki/06-publishing-vscode.md) |
| Releasing — Zed | [07-publishing-zed](wiki/07-publishing-zed.md) |
| Releasing — Neovim | [08-publishing-nvim](wiki/08-publishing-nvim.md) |
| BBEdit / IntelliJ / Sublime | [09-other-editors](wiki/09-other-editors.md) |
| CI automation | [10-ci-automation](wiki/10-ci-automation.md) |
| Review process (collab w/ Codex) | [11-collab-protocol](wiki/11-collab-protocol.md) |
| Common pitfalls | [12-gotchas](wiki/12-gotchas.md) |
| Roadmap + known gaps | [13-roadmap](wiki/13-roadmap.md) |
