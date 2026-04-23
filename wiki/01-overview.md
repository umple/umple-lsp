# 01 — Overview

## What is this project?

`umple-lsp` is a Language Server Protocol (LSP) implementation for the **Umple** modeling language (https://cruise.umple.org/umple). Until this project existed Umple files (`.ump`) had no LSP, so editors couldn't offer go-to-definition, find-references, completion, hover, rename, or modern diagnostics.

We provide three layers, plus several editor-side packages that consume them:

```
┌─────────────────────────────────────────────────────────────┐
│ Editor extensions (separate repos)                          │
│   umple.vscode      → VS Code Marketplace                   │
│   umple.zed         → Zed Extensions Marketplace            │
│   umple.nvim        → Neovim plugin                         │
│   editors/bbedit    → BBEdit codeless module (in this repo) │
│   editors/intellij  → IntelliJ via LSP4IJ (in this repo)    │
└─────────────────────────────────────────────────────────────┘
                            │
                  uses both ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: umple-lsp-server (npm package)                     │
│   packages/server/                                          │
│   - LSP wire protocol handlers                              │
│   - Symbol indexing, resolver, completion, hover, rename    │
│   - Diagnostics via umplesync.jar subprocess                │
│   - Bundles tree-sitter-umple.wasm                          │
└─────────────────────────────────────────────────────────────┘
                            │
                     uses ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: tree-sitter-umple (grammar)                        │
│   packages/tree-sitter-umple/                               │
│   - grammar.js (manual)                                     │
│   - queries/*.scm — definitions, references, completions,   │
│     highlights, locals                                      │
│   - Generates parser.c and tree-sitter-umple.wasm           │
└─────────────────────────────────────────────────────────────┘
                            │
                  validated against ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Umple compiler (external — github.com/umple/umple) │
│   - umplesync.jar — used at runtime for diagnostics         │
│   - Official grammar reference                              │
│   - try.umple.org — verify any new syntax                   │
└─────────────────────────────────────────────────────────────┘
```

The LSP server runs as a Node.js process spawned by each editor. It speaks the LSP protocol over stdin/stdout. It **does not** require the Umple compiler to be installed for parsing/completion/refs/rename — those use the bundled tree-sitter WASM grammar. It DOES need `umplesync.jar` for diagnostics (auto-discovered next to the server module).

## Repo map

The work spans five separate Git repositories:

| Repo | Purpose | URL |
|------|---------|-----|
| **umple-lsp** | This repo. Monorepo housing the LSP server (`packages/server/`) and tree-sitter grammar (`packages/tree-sitter-umple/`). Single source of truth for grammar + server behavior. | github.com/umple/umple-lsp |
| **umple.vscode** | VS Code extension. Thin wrapper that **bundles** a specific build of `umple-lsp-server` inside the .vsix at packaging time. Published to marketplace as `digized.umple`. Users get a new server only when the extension is re-packaged + republished. | github.com/umple/umple.vscode |
| **umple.zed** | Zed extension. Has its own `extension.toml` pinning a `rev` of umple-lsp's grammar + a copy of `highlights.scm`. Published to `zed-industries/extensions` marketplace. | github.com/umple/umple.zed |
| **umple.nvim** | Neovim plugin. Bundles a build script that npm-installs `umple-lsp-server` and clones the tree-sitter grammar from this repo. | github.com/umple/umple.nvim |
| **umple/umple** | The Umple compiler itself. We don't own it but consume `umplesync.jar` from it for diagnostics. | github.com/umple/umple |

On a typical dev machine all four lsp-side repos sit side-by-side under one workspace folder so cross-repo paths like `../umple-lsp/packages/server` resolve cleanly.

## Editor support matrix

| Editor | Status | Notes |
|--------|--------|-------|
| VS Code | shipping | `digized.umple` on marketplace; the .vsix bundles `umple-lsp-server` at packaging time. New server features reach users only when the extension is repackaged + republished. |
| Zed | shipping | umple.zed extension; downloads server from npm at extension load via its `lib.rs` (`npm_package_latest_version` + `download_file`). New npm versions reach users automatically. |
| Neovim | shipping | umple.nvim plugin; build step does `npm install umple-lsp-server` |
| BBEdit | shipping | Codeless language module — see `editors/bbedit/` |
| IntelliJ | shipping | LSP4IJ plugin (Red Hat) plus a TextMate grammar — see `editors/intellij/` |
| Sublime | partial | Static config in `editors/sublime/` |

## Features supported

The LSP server implements:

- **Diagnostics** — via `umplesync.jar` subprocess per validation (with shadow-workspace import resolution)
- **Go-to-definition** — context-aware via `references.scm` query
- **Find references** — semantic, with state-path disambiguation and shared-state expansion for reused state machines
- **Rename** — kind-aware new-name validators (req ids accept digits + hyphens; identifiers don't)
- **Hover** — markdown hover for class / interface / trait / state machine / state / attribute / method / requirement / use case step / etc.
- **Completion** — context-aware via `completions.scm` + many narrow fallback scopes (association multiplicity / arrow / type, structured req body starters, implementsReq, ...)
- **Document symbols** — outline with proper nesting (states under SMs, use-case steps under reqs, etc.)
- **Formatting** — AST-driven: indent, transition spacing, association spacing, top-level blank lines, embedded code reindentation, compact-state expansion
- **Custom diagram navigation** — click-to-select state/transition resolution for the VS Code diagram view

The tree-sitter grammar covers most real Umple syntax: classes / inheritance / interfaces / traits / associations / state machines (including `||` concurrent regions) / mixsets / requirements (with structured `userStory` / `useCase` bodies) / `implementsReq` across all entity types / trait SM bindings / template parameters / Java annotations / multi-language code blocks / etc.

## Why all this complexity

Umple is unusual:

- It compiles to multiple target languages (Java / C++ / Python / SQL / many more)
- Its diagrams (state machines, class diagrams) are first-class output
- It has many cross-cutting features (mixsets, traits with templates, requirements traceability) that depend on each other

So the LSP needs deep semantic understanding (a custom symbol index with container-scoped lookups, isA-graph traversal, state-path disambiguation, etc.) — not just textual tools. See [02-architecture.md](02-architecture.md) for the design.

## Where to go next

- New to this codebase? → [03-development.md](03-development.md) for setup
- Want to understand the design? → [02-architecture.md](02-architecture.md)
- Need to add or fix grammar? → [04-grammar.md](04-grammar.md)
- Need to ship a new version? → [05-publishing-npm.md](05-publishing-npm.md) (then [06](06-publishing-vscode.md) / [07](07-publishing-zed.md) / [08](08-publishing-nvim.md))
