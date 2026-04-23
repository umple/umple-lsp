# 12 — Gotchas, lessons learned, and debugging tips

A grab bag of non-obvious things you'll wish you knew earlier.

## Tree-sitter

### Empty rules are forbidden

```js
my_body: ($) => repeat(choice($.x, $.y))
```

Fails generation with `The rule 'my_body' matches the empty string`. Tree-sitter only allows empty matches in the start rule. If you need a body that can be empty, either:

- Use `repeat1` so the body has at least one child, and accept that empty bodies have no body node (handle via prevLeaf-based detection)
- Add a fixed token: `seq("body", repeat(...))` — the leading literal makes the rule non-empty

### Keyword extraction beats most things at lex time

Declaring `word: $.identifier` and then writing `"who"` as a literal in a rule auto-promotes `who` to a "keyword token" that wins at lex time over the generic `identifier` rule. But: it loses to explicit `token()` rules that ALSO match the same string. Be careful when adding `token(...)` rules whose regex overlaps a keyword.

### `prec.dynamic()` doesn't help with lexer ambiguity

`prec.dynamic()` resolves at parse time after the lexer has already chosen a token. If two rules want different tokens at the same position, `prec.dynamic` won't unstick you. Solutions: rework the grammar so only one valid token exists per position, OR use `conflicts: [...]` declarations + GLR.

### Conflict declarations rot

`tree-sitter generate` warns about "unnecessary conflicts" when a declared conflict is no longer needed. Periodically review and prune (commit `b0604a3` removed 14 in one pass).

### Anonymous tokens in ERROR children

When the parser fails inside a structured rule and falls into ERROR recovery, child node types come from where the token CAME FROM in some still-active grammar path. So `*` inside `class_definition`'s ERROR might be a `multiplicity` node (because `_class_content → association_inline` was being attempted), but inside `association_definition`'s ERROR might be the bare anonymous `*` literal. Code that walks ERROR children should be defensive about both shapes.

### `findPreviousLeaf` skips over identifier characters

The completion analysis helper backs the cursor up over `[a-zA-Z_0-9]+` then over whitespace before locating prevLeaf. Means: cursor at end of `Foo|` lands on whatever was BEFORE `Foo`. For typed-prefix detection, you need to use `nodeAtCursor` (the node CONTAINING the cursor), not prevLeaf. See topic 043.

## Server / TS

### Node doesn't hot-reload

`npm run compile` regenerates `out/*.js`, but a running LSP server holds the OLD `.js` in memory. **Always restart your editor's LSP after a compile.** Symptoms of forgetting: "I just fixed it but it still misbehaves." → `:LspRestart` (nvim) / "Developer: Reload Window" (VS Code).

### Symlink installs don't pull transitive deps

`npm install ../some-local-package` copies the package but doesn't install ITS dependencies. The `vsce package` step then fails with "missing peer X". Workaround: use `npm pack` first to produce a `.tgz`, then `npm install <path-to-tgz>` which DOES install transitive deps:

```bash
cd packages/server && npm pack
cd ~/.../umple.vscode && npm install ../umple-lsp/packages/server/umple-lsp-server-X.Y.Z.tgz
```

### iCloud Drive breaks cargo

The standard dev setup keeps repos under `~/Library/Mobile Documents/com~apple~CloudDocs/workspace/`. Cargo (used for the Zed extension build) HANGS for hours when it tries to write `target/` inside iCloud — file I/O syncs become a deadlock. Workaround:

```bash
CARGO_TARGET_DIR=/tmp/umple-zed-target cargo build --release --target wasm32-wasip2
```

Use `/tmp` or any local-only path. Same trick for `cargo test`, `cargo run`, etc.

### Container-scoped vs global symbols

`SymbolEntry.container` matters. Top-level symbols (class, interface, trait, enum, mixset, requirement) are SELF-containers — `container === name`. Member symbols use the enclosing class/SM. Always pass `container` to `getSymbols()` when looking up scoped kinds; otherwise you cross-class-pollute.

### State machine container qualification

States and inner state machines use **dotted** containers like `"ClassName.smName"` — preventing collisions when two classes both have a state machine called `status`. State paths are stored separately as `statePath: ["EEE","Open","Inner"]`.

### Cold-open recovery is opinionated

When `tree.rootNode.hasError`, the indexer applies `RECOVERY_SAFE_KINDS` filter — only some kinds get extracted. If you add a new SymbolKind, decide whether it should be in that set. Default is "no" (safer), and you can add it later if you have evidence the kind is robust to ERROR recovery.

## Workflow / process

### Don't `git push` from CI

Our CI workflow auto-PRs to umple.zed but never pushes to umple-lsp itself. Pushing from CI invites surprise force-pushes from rebase logic, lock-file conflicts, etc. Keep "what gets to master" a human action.

### `npm publish` lag

After publish, `npm view umple-lsp-server version` may briefly show the old version due to CDN caching. Usually under a minute. To bypass: `npm view --registry https://registry.npmjs.org/ umple-lsp-server version`.

### PAT expiration

Both PATs we use (UMPLE_ZED_BOT_PAT for CI, the `digized` Azure DevOps PAT for vsce publish) expire annually. Calendar reminders help. Symptom: `401 Unauthorized` from the workflow / vsce.

### Symlinks don't pack into vsix

If `umple.vscode/node_modules/umple-lsp-server` is a symlink (dev mode), `vsce package` may produce a vsix that's broken on end-user installs (the symlink resolves to a path that doesn't exist on their machine). Always use a real install (`npm install` from registry, or `npm install <tarball>`) before packaging.

## Testing

### `npm test` numbers

The exact pass count grows as features land. As of the most recent ship: **682 passing**. If your local suite shows fewer, you're probably out of date — `npm install` again. If MORE without your changes, someone added tests since you branched.

### Fixture parse errors are sometimes intentional

The full-fixture parse sweep reports **18 fixtures with errors** as the baseline. They're all named `*_negative`, `*_recovery`, `*_fallback`, `*_malformed`, plus `126_implementsreq_empty_slot.ump`. NEW errors mean a regression. Always check the diff list, not just the count.

### Programmatic probes scale to dozens of cases

Don't iterate slowly through manual editor restarts when verifying many cases. Drop a `node - <<NODE` probe that loops through 10–20 inputs; output appears in seconds. See [03-development.md § Programmatic probes](03-development.md#programmatic-probes-no-test-harness).

### Tests use real parser + real queries

There's no mocking. The test harness loads the same WASM and same `.scm` files the production server uses. So tests cover real behavior, not stubbed behavior. Side effect: a test fail might be in the grammar / query, not in the TS. Read failure messages carefully.

## Editor-specific

### nvim symlink dev install

If you've replaced `umple.nvim/node_modules/umple-lsp-server` with a symlink to your local server (recommended dev setup), don't run `:Lazy build umple.nvim` — it'll `npm install` on top of your symlink and clobber it.

### VS Code extension auto-update

VS Code auto-updates installed extensions in the background. So end users get new vsixes within hours of marketplace publish. They don't need to do anything. **Note**: unlike Zed, VS Code does NOT pull a fresh server from npm at runtime — the .vsix bundles a fixed server build. To deliver server fixes to VS Code users you have to repackage + republish (see [06-publishing-vscode.md](06-publishing-vscode.md)).

### BBEdit `$PATH`

If `umple-lsp-server` isn't found at runtime, BBEdit isn't seeing your shell's `$PATH`. Fix is `~/.zshenv`, NOT `~/.zshrc` — BBEdit launches subprocesses from a non-interactive non-login shell.

### Zed grammar lag

When you bump the umple.zed `extension.toml.rev`, existing Zed users don't recompile until they update their extension version. So a grammar change isolated in umple.zed without a marketplace bump only reaches users who reinstall manually.

## Debugging tips

### "Goto-def doesn't work on this token"

Walk through:

1. `getTokenAtPosition` — does it return non-null?
2. Check `token.kinds` — is it `null`? If yes, no `references.scm` pattern matched at that cursor position. Add one.
3. Check resolver — what symbols does it find? `symbolIndex.getSymbols({ name: token.word, kind: token.kinds, container: token.enclosingClass })`. Empty? Symbol isn't indexed; check `definitions.scm`.

### "Hover returns wrong thing for a name with multiple symbols"

`resolved.symbols[0]` is what hover uses. If multiple match, the resolver picked one. Check the post-lookup disambiguation block in `resolver.ts` — for use-case steps, dotted state paths, and shared-state references we have explicit position-based disambiguation. For new SymbolKinds with this issue, follow the `use_case_step` pattern.

### "Completion shows wrong items"

1. Run the programmatic probe pattern (see development.md). What does `analyzeCompletion()` return for `info.symbolKinds`?
2. If wrong scope: trace through `resolveCompletionScope` (the `.scm`-driven path) AND every `prevLeaf?.type ===` block in `analyzeCompletion`. Some prevLeaf branch is probably setting the wrong scope.
3. If right scope but wrong items: check the corresponding builder branch in `completionBuilder.ts`.

### "Tests fail on someone else's machine but not mine"

Usually one of:

- Different Node version (we test on 20+; use `nvm use 20`)
- Stale `out/` — they didn't run `npm run compile` after pulling
- They have an iCloud-synced `.test-out/` — happens occasionally; `rm -rf .test-out && npm test`

## Where to go next

- Roadmap of known gaps → [13-roadmap.md](13-roadmap.md)
- Process docs → [11-collab-protocol.md](11-collab-protocol.md)
