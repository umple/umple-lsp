# umple-lsp-server

Language Server Protocol implementation for the [Umple](https://www.umple.org/) modeling language.

This package provides the editor-agnostic server used by VS Code, Zed, Neovim, and any generic LSP client that can launch a Node-based language server.

## Install

```bash
npm install -g umple-lsp-server
umple-lsp-server --stdio
```

## What Ships

- LSP server JavaScript compiled to `out/`
- `umple-lsp-server` command wrapper in `bin/`
- Bundled Tree-sitter Umple WASM parser
- Bundled Tree-sitter query files for definitions, references, completions, and highlighting

`umplesync.jar` is not bundled in the npm package. Editor clients either download it separately or pass a local path through server initialization options.

## Release Notes

Current release: `1.0.0`

Highlights:

- Broader completion coverage for associations, requirements, traces, ports, states, and class-scoped symbols.
- Safer go-to-definition, references, rename, workspace symbols, hover, semantic tokens, inlay hints, and code actions across more Umple constructs.
- Formatter safety checks and focused formatting improvements for parser-visible structural syntax.
- Expanded Tree-sitter grammar and query coverage backed by corpus checks.
- Trace transition event symbols: `trace transition flip;` now resolves, references, hovers, and completes class-scoped transition events.

See `CHANGELOG.md` in this package and the upstream repository wiki for the full release history and publishing notes.
