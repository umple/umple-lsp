# 13 — Roadmap & open work

A snapshot of what's shipping, what's known to be gappy, and where future students could focus next. Take this as a starting point — the project moves; check `git log` and `.collab/archive/` for the latest state.

## Currently shipping

- LSP server: go-to-def, find-refs, rename, hover, completion, diagnostics, document symbols, formatting, diagram navigation
- Tree-sitter grammar: most real Umple syntax including structured req bodies (userStory / useCase) and implementsReq across all entity types
- Editor extensions: VS Code (digized.umple), Zed (umple.zed), Neovim (umple.nvim), BBEdit (codeless module), IntelliJ (LSP4IJ + TextMate)
- CI: auto-PR for grammar/highlights changes from umple-lsp into umple.zed

## Known grammar gaps

These are real Umple constructs the grammar doesn't yet parse cleanly. Each one needs a grammar.js rule + corresponding query updates + tests.

### `inner class` keyword

`451_ReqInnerClass.ump` from the compiler test corpus uses `inner class Name { ... }` to declare a true inner class (semantically distinct from the bare `class Name { ... }` inside another class, which means `isA`). Parser currently fails on the `inner` keyword. Fix: add to `_class_content` choice.

Tracked in topic 038 / archive — was deferred when phase A–D landed.

### Sorted association keys with method calls

We support `sorted {attrName}` but not `sorted {method().attr}` chains. Compiler accepts the latter; parser would need a deeper `sort_key` expression rule.

### Mixset --redefine semantics

We parse `mixset name --redefine` but don't verify it actually points at an existing mixset. Compiler does. Could be a diagnostic (use compiler diagnostics) or a semantic check at indexing time.

### Trait SM operations in cascading shape

`isA T<-sm.s1.e1()[guard].s2>` chains parse but rename / refs across the chain segments has rough edges. See `referenceSearch.ts` post-filter logic — it works for known shapes but new compiler-grammar additions to trait_sm_operation could break it.

### Multi-language extra code

`extracode lang { ... }` syntax for per-target-language helper code. Currently parsed leniently as opaque content; could be more structured for hover / outline.

## Known LSP gaps

### Completion doesn't account for partial type prefixes everywhere

Topic 043 fixed it for association right_type. Same pattern (typed prefix → narrow scope) probably applies to:

- `isA |` then typing — should narrow to class/interface/trait
- Type position in attribute declarations: `Integer x;` — typing letters should narrow to types
- Method return types

Each one is a focused topic — see topic 043's pattern (query capture for the inner identifier + nodeAtCursor fallback for ERROR).

### Code actions

We don't expose any. Common LSP code actions worth adding:

- "Add `;` after this statement"
- "Rename to camelCase / PascalCase to match convention"
- "Convert this attribute to an `enum`"
- "Extract this state's body to a substate"
- "Inline this `use file.ump` (paste contents inline)"

Each is a `textDocument/codeAction` handler in `server.ts` with logic to compute the edit.

### Inlay hints

LSP supports inlay hints — small annotations rendered between tokens. Could show:

- Inferred attribute type for `x = 5;` → `Integer`
- Multiplicity defaults: `1 -> Foo;` → `1 -> 1 Foo`
- Trait template parameter substitutions

### Semantic tokens

We rely on tree-sitter for syntax highlighting in editors that load `highlights.scm`. For editors that use LSP semantic tokens (most JetBrains via LSP4IJ), we don't emit any. Adding semantic token support would unify highlighting across editors.

### Workspace-wide rename safety

Rename currently scopes to forward-imports + reverse-importers. If your workspace has files NOT in any import chain that reference a symbol, rename misses them. Workspace-wide search would be slower but more correct. Tradeoff to discuss.

## Known tooling gaps

### No CI test runner for umple-lsp

Tests run locally, not on PR. A `.github/workflows/test.yml` running `npm install && npm test` on every PR + master push would catch regressions before merge. ~10 lines of YAML; we just haven't added it.

### No automated npm publish

Publishing is manual. Tag-triggered `npm publish` workflow (push `server-v0.5.0` → CI publishes) was discussed in topic 040 and deferred. Could add when shipping cadence picks up.

### No automated marketplace PR

zed-industries marketplace PR is manual. Probably should stay manual for governance reasons (their maintainers review every PR), but a script that automates the "fork + submodule bump + branch + push + gh pr create" mechanical steps would be nice.

### No auto-update for `umplesync.jar`

The jar consumed for diagnostics is downloaded once via `npm run download-jar` (from `try.umple.org`). If the upstream Umple compiler ships a fix that affects diagnostics, we don't notice until someone re-runs the download. A periodic CI check + auto-PR to refresh the jar would help — but the jar file itself is gitignored, so the implementation is non-trivial.

### Wiki not synced to GitHub Wiki

This wiki lives in `wiki/` in the repo. GitHub also has a separate "Wiki" feature backed by a separate repo at `<repo>.wiki.git`. Could sync these via a workflow on every push. For now, the in-repo wiki is the source of truth; the GitHub Wiki feature is empty.

## Suggested next features (user-facing)

Pulled from the conversation history + general LSP best practice:

1. **Snippet completion for full association declarations** — typing `assoc` triggers a snippet that scaffolds `1 -> * Foo;` with tab stops. VS Code supports server-provided snippets natively.
2. **Find-implementations on traits** — distinct from find-refs; specifically traits' isA chain.
3. **Quick-fix for missing `;`** — already have W-1502 detection via diagnostics; offer the fix as a code action.
4. **Live diagram refresh on save** — currently the VS Code diagram updates on file save; could update on debounced edit.
5. **Symbol search across workspace** — `workspace/symbol` LSP request not currently implemented.

Each of these is a focused topic: spec the scope, get codex review, implement, test, commit. The ~5 day cadence we hit during topics 038–044 is comfortable for one of these per cycle.

## Testing roadmap

- **Property-based tests for the formatter** — currently we have many fixture-based examples but no "format any clean parse and assert it stays clean + idempotent." A fast-check generator over small Umple programs would catch formatter bugs we don't know we have.
- **Stress tests against the umple compiler corpus** — `cruise.umple/test/` has thousands of `.ump` files. A CI job that parses all of them and reports the % with ERROR nodes would catch regressions in grammar permissiveness. We did this manually during phase 038 work; never automated.
- **End-to-end editor tests** — open a real editor, send LSP messages, assert responses. Heavy infra; haven't tried.

## How to pick what to work on

If you're inheriting this project cold:

1. Read all 13 wiki pages once
2. Read `.collab/archive/038_*.md` and `040_*.md` for the most context-dense topic histories
3. Spend a day on dev setup ([03-development.md](03-development.md))
4. Ship one tiny fix end-to-end (find a typo in a wiki page; fix; commit; push) to verify the loop
5. Pick one "Known gap" above and propose a topic following the [collab protocol](11-collab-protocol.md)

Don't try to fix everything at once. The pattern is: small, well-scoped topic → review → commit → ship → next topic.

## Where to go next

- Set up your dev env → [03-development.md](03-development.md)
- Understand the codebase → [02-architecture.md](02-architecture.md)
- Pick your first topic → above
- Run the collab process → [11-collab-protocol.md](11-collab-protocol.md)
