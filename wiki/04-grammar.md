# 04 — Grammar

The tree-sitter grammar (`packages/tree-sitter-umple/`) is the foundation. The LSP server can't see anything the grammar doesn't parse correctly. This page covers the workflow for editing the grammar and the four query files that drive the server's semantic features.

If you are changing grammar **and** another LSP behavior together, read the overall playbook too: [14-feature-work-playbook.md](14-feature-work-playbook.md). Then branch to the focused page you need:

- defs / refs / rename / hover / outline: [15-symbol-features-playbook.md](15-symbol-features-playbook.md)
- completion: [16-completion-playbook.md](16-completion-playbook.md)

## Files

```
packages/tree-sitter-umple/
├── grammar.js                    ← The only file you usually edit
├── queries/
│   ├── highlights.scm            ← Editor syntax highlighting (Zed/Neovim load this)
│   ├── locals.scm                ← Scope tracking (currently unused by server)
│   ├── definitions.scm           ← Maps AST nodes to @definition.<kind> captures (server reads)
│   ├── references.scm            ← Maps identifiers to @reference.<kind> contexts (server reads)
│   └── completions.scm           ← Maps AST nodes to @scope.<kind> captures (server reads)
├── src/
│   ├── parser.c                  ← GENERATED. tracked in git (so consumers don't need tree-sitter CLI)
│   ├── grammar.json              ← GENERATED. gitignored
│   └── node-types.json           ← GENERATED. gitignored. Useful for writing queries.
├── tree-sitter-umple.wasm        ← GENERATED. gitignored. Built by `tree-sitter build --wasm`.
└── package.json
```

## Build pipeline

```
grammar.js
    │
    ▼ tree-sitter generate
src/parser.c (+ src/grammar.json + src/node-types.json)
    │
    ▼ tree-sitter build --wasm
tree-sitter-umple.wasm
    │
    ▼ npm run copy-wasm
packages/server/tree-sitter-umple.wasm
packages/server/{definitions,references,completions,highlights}.scm
    │
    ▼ tsc -b
packages/server/out/*.js (consumes the WASM at runtime)
```

`npm run compile` from repo root runs all of the above in order. After grammar edits, this is the only command you need.

## Editing grammar.js

Tree-sitter uses a JavaScript DSL — see https://tree-sitter.github.io/tree-sitter/creating-parsers. The file is annotated with `// @ts-check` and `/// <reference types="tree-sitter-cli/dsl" />` so VS Code gives autocomplete on `seq`, `choice`, `prec`, `repeat`, `optional`, `field`, `alias`, `token`.

### Adding a new construct

1. **Verify the syntax** at https://try.umple.org first. Don't invent rules — Umple has a precise grammar at https://cruise.umple.org/umple/UmpleGrammar.html. The compiler grammar lives at `cruise.umple/src/umple_core.grammar` in the umple/umple repo.
2. **Translate the BNF to JS DSL** — see CLAUDE.md or the existing `requirement_definition` / `req_implementation` for example.
3. **Wire into the right parent rule.** Top-level constructs go into `_definition`; class members go into `_class_content`; trait additions go into `_trait_content`; SM-body items into `state_machine` and `statemachine_definition`; state-body items into `state`; etc.
4. **Add a `@definition.<kind>` capture** in `definitions.scm` if it introduces a symbol.
5. **Add a `@reference.<kinds>` capture** in `references.scm` if it can reference existing symbols.
6. **Add a `@scope.<kind>` capture** in `completions.scm` if it should change completion behavior inside its body.
7. **Add a highlight pattern** in `highlights.scm` for any new keywords.
8. **Run `npm run compile`** — fails loudly if there's a parser conflict.
9. **Run `npm test`** — the semantic suite and parser-report self-test should still pass if you didn't change semantics.
10. **Add a fixture + assertions** for the new construct (see [03-development.md § Add a test](03-development.md#testing)).

### Key gotchas

#### Empty rules are forbidden

Tree-sitter rejects a rule that can match the empty string (unless it's the start rule). If you write:

```js
my_body: ($) => repeat(choice($.tag1, $.tag2, $.free_text)),
```

and the rule is referenced with `optional(field("body", $.my_body))`, you'll get:

```
Error: The rule `my_body` matches the empty string
```

Use `repeat1` instead, or restructure so `my_body` always has at least one fixed token. We hit this trying to make structured req bodies always produce a body node — see [12-gotchas.md](12-gotchas.md).

#### Keyword extraction

We declare `word: $.identifier`. Tree-sitter then auto-promotes any string literal in a rule that exactly matches the identifier regex (e.g. `"who"`, `"userStep"`) to a "keyword token" that wins over generic identifier matching at lex time. This is why structured req tag keywords don't get swallowed by free-text rules.

But: if you also have a separate `token(/.../)` rule that ALSO matches the same string, the keyword extraction may not win. Token rules with explicit `prec()` need careful balancing. See `req_free_text_word` / `req_free_text_punct` for the pattern we settled on.

#### Conflict declarations

When two rules can match the same input prefix, tree-sitter needs an explicit conflict declaration in the `conflicts:` array at the top of the grammar. Adding a conflict is OK but they aren't free — too many slows the parser. After grammar changes, `tree-sitter generate` PRINTS warnings about unnecessary conflicts you've declared but no longer need. Periodically clean those up — commit `b0604a3` removed 14 of them in one pass.

#### Grammar-time text-matching is limited

Tree-sitter's `#match?` predicate works in queries but not in grammar rules. So you CAN'T write a grammar rule that says "if the previous identifier was `X`, parse Y differently." Decision points have to be expressible structurally (different rules for `userStory` vs `useCase` body via separate `_req_user_story_tail` / `_req_use_case_tail` productions).

#### Test against the official compiler

If a syntax change is non-trivial, paste examples into try.umple.org to confirm the official compiler accepts them. Our grammar should not be **stricter** than the compiler (else valid Umple gets rejected) and should be **as close as possible** to its acceptance set without over-permitting (over-permitting just creates parse trees nobody can interpret).

Parser acceptance is not the same as compiler acceptance. Some recovery-oriented
grammar support is useful so LSP features keep working while users type, but it
must not be treated as proof that the model is valid Umple. Diagnostics come from
`umplesync.jar`, so an `umple compiler` diagnostic is expected whenever the
official compiler rejects syntax that tree-sitter can still parse.

## The four query files

All `.scm` files use [tree-sitter's S-expression query syntax](https://tree-sitter.github.io/tree-sitter/using-parsers#pattern-matching-with-queries).

### definitions.scm

Tells the LSP what to extract as symbols. Each capture is `@definition.<SymbolKind>`:

```scm
(class_definition name: (identifier) @definition.class)
(req_user_step id: (req_step_id (identifier) @definition.use_case_step))
```

`SymbolKind` is the union in `tokenTypes.ts`. The LSP server walks all captures into `SymbolEntry[]` records via `extractSymbols()`. Container resolution (which class an attribute belongs to, etc.) is automatic via parent-chain walking — you usually don't need to encode it in the query.

### references.scm

Tells the LSP what kinds an identifier can reference, by position. Capture name is `@reference.<kind1>_<kind2>_...`:

```scm
(req_implementation (identifier) @reference.requirement)
(isa_declaration (type_list (type_name (qualified_name (identifier) @reference.class_interface_trait))))
```

When the cursor is on a captured identifier, the resolver narrows its symbol search to those kinds. Identifiers NOT matched by any pattern get null kinds → no go-to-def / hover / rename.

### completions.scm

Tells the LSP what symbol kinds to offer at a given cursor position. Capture is `@scope.<kind>`:

```scm
(class_definition) @scope.class_body
(req_implementation) @scope.requirement
(association_inline right_type: (identifier) @scope.association_typed_prefix)
```

When the cursor lands inside multiple captured nodes, the **smallest containing scope wins** — that's why `@scope.association_typed_prefix` on the inner identifier overrides the broader `@scope.class_interface_trait` on the enclosing `association_inline`.

A few special scope strings have hard-coded meaning in `completionAnalysis.resolveCompletionScope`:

- `@scope.suppress` → no completion at all
- `@scope.use_path` → trigger file-path completion
- `@scope.top_level` / `@scope.class_body` / etc. → curated keyword scopes built by `completionBuilder.ts`

Other capture names are parsed by underscore-splitting into `SymbolKind[]` and used directly to filter `getSymbols()`.

### highlights.scm

Syntax highlighting query. Loaded by Zed (from its own `languages/umple/highlights.scm` copy synced from this file), Neovim (via the symlinked queries directory in `umple.nvim`), and the LSP server for `textDocument/semanticTokens/full`.

Capture names are tree-sitter convention: `@keyword`, `@type`, `@variable`, `@string`, `@comment`, `@punctuation.bracket`, etc. Each editor maps these to its theme.

## Adding new keywords

When you add a grammar rule that introduces a new keyword (e.g. `userStep` in topic 038), don't forget to also add it to `highlights.scm` so editors color it. Easy to miss — we shipped commit 6df8e03 specifically for the structured-req body keywords because they were highlighted as plain identifiers.

## Verifying parser changes

Quick sanity check on a single file:

```bash
cd packages/tree-sitter-umple
npx tree-sitter parse ../../test/Person.ump
```

Look for `(ERROR ...)` nodes — those mean the parser couldn't handle a section. The expected count after a clean compile is **17 fixtures with errors** in `packages/server/test/fixtures/semantic/*.ump` — all intentional error-recovery fixtures named `*_negative`, `*_recovery`, `*_fallback`, `*_malformed`, plus `126_implementsreq_empty_slot.ump` (intentional empty slots).

Any new ERROR in a previously-clean fixture is a regression. The full sweep:

```bash
cd packages/tree-sitter-umple
for f in ../../packages/server/test/fixtures/semantic/*.ump; do
  result=$(npx tree-sitter parse "$f" 2>&1 | grep -E 'ERROR' | head -1)
  [ -n "$result" ] && echo "ERR: $(basename "$f")"
done | wc -l
```

Should print 18 (17 + 126_*). Anything higher is a regression — figure out which file is new and inspect it.

For a broader read-only stress report against the upstream compiler corpus:

```bash
UMPLE_CORPUS_DIR=/path/to/cruise.umple/test npm run parse:corpus
```

The command strips UmpleOnline layout tails before parsing, reports the percentage of `.ump` files whose tree contains ERROR nodes, and exits successfully by default so existing corpus gaps do not break CI unexpectedly. To turn it into a gate after setting a baseline, add `UMPLE_CORPUS_FAIL_ON_ERROR=1` or pass `--fail-on-error`.

## When the grammar changes vs when the server changes

Both updates ship via npm package `umple-lsp-server` because the WASM is bundled. So:

- **Grammar-only change** (rare in isolation) — bump server patch + npm publish. Editor extensions that auto-pull from npm get it; Zed needs an `extension.toml` rev bump (which the auto-sync workflow does for you, see [10-ci-automation.md](10-ci-automation.md)).
- **Server-only change** (most common) — bump server patch + npm publish. No grammar action.
- **Combined** — bump once, publish once. The auto-sync PR opens on umple.zed, you merge it after npm has the matching server.

## Where to go next

- Add a real test → [03-development.md § Testing](03-development.md#testing)
- Common grammar pitfalls → [12-gotchas.md](12-gotchas.md)
- Ship after a grammar change → [05-publishing-npm.md](05-publishing-npm.md)
