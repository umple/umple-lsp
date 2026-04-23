# Umple LSP — Project Wiki

Welcome. This wiki is the handoff document for future contributors to the Umple Language Server Protocol implementation. If you're picking this project up cold, start with [01-overview.md](01-overview.md) and read in order — each page assumes you've read the ones before it.

## Pages

| # | Page | What's in it |
|---|------|--------------|
| 01 | [overview.md](01-overview.md) | What this project is, what it ships, the three-layer architecture, supported editors |
| 02 | [architecture.md](02-architecture.md) | LSP server module decomposition, symbol indexing, diagnostics flow, tree-sitter integration |
| 03 | [development.md](03-development.md) | Local setup: clone, install, build, run, test. Symlink-vs-npm dev flow. |
| 04 | [grammar.md](04-grammar.md) | Tree-sitter grammar work — adding rules, query files, build pipeline, gotchas |
| 05 | [publishing-npm.md](05-publishing-npm.md) | Releasing `umple-lsp-server` to npm |
| 06 | [publishing-vscode.md](06-publishing-vscode.md) | Releasing the VS Code extension via `digized` publisher |
| 07 | [publishing-zed.md](07-publishing-zed.md) | Releasing the Zed extension — auto-sync CI + manual marketplace PR |
| 08 | [publishing-nvim.md](08-publishing-nvim.md) | The Neovim plugin (`umple.nvim`) — build script, tree-sitter integration |
| 09 | [other-editors.md](09-other-editors.md) | BBEdit codeless module + IntelliJ via LSP4IJ |
| 10 | [ci-automation.md](10-ci-automation.md) | The `sync-umple-zed.yml` workflow + secrets + scope decisions |
| 11 | [collab-protocol.md](11-collab-protocol.md) | The Codex reviewer agent + `.collab/` channel + strict iterative cycle |
| 12 | [gotchas.md](12-gotchas.md) | Lessons learned, common pitfalls, debugging tips |
| 13 | [roadmap.md](13-roadmap.md) | Backlog, known gaps, suggested next features |

## Quick links

- **Repo layout & sibling repos:** [01-overview.md § Repo map](01-overview.md#repo-map)
- **First-time setup:** [03-development.md § First-time setup](03-development.md#first-time-setup)
- **Run tests:** [03-development.md § Testing](03-development.md#testing)
- **Ship a new release of everything:** [05-publishing-npm.md](05-publishing-npm.md) → [06-publishing-vscode.md](06-publishing-vscode.md) → [07-publishing-zed.md](07-publishing-zed.md)
- **CI / secrets:** [10-ci-automation.md](10-ci-automation.md)

## Maintenance note

This wiki lives in `wiki/` inside the `umple/umple-lsp` repo. If you'd rather sync it to GitHub's hosted wiki feature (separate repo at `github.com/umple/umple-lsp.wiki.git`), each `.md` file here maps 1:1 — just `git push` them to the wiki remote.
