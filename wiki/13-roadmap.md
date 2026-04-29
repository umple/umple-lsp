# 13 — Roadmap & open work

A snapshot of what's shipping, what's known to be gappy, and where future students could focus next. Take this as a starting point — the project moves; check `git log` and `.collab/archive/` for the latest state.

## Currently shipping

- LSP server: go-to-def, find-refs, find-implementations, rename, hover, inlay hints, completion, diagnostics, document symbols, workspace symbols, formatting, diagram navigation, code actions (`Add missing semicolon` quick-fix for W1006/W1007/E1502 — see "Code actions" below)
- Tree-sitter grammar: most real Umple syntax including structured req bodies (userStory / useCase) and implementsReq across all entity types
- Editor extensions: VS Code (digized.umple), Zed (umple.zed), Neovim (umple.nvim), BBEdit (codeless module), IntelliJ (LSP4IJ + TextMate)
- CI: build/test workflow for umple-lsp plus auto-PR for grammar/highlights changes from umple-lsp into umple.zed

## Known grammar gaps

These must be compiler-verified before the tree-sitter grammar is widened. The old short list here was rechecked against a current local Umple compiler and should not be treated as confirmed parser work:

- Sorted association keys stay intentionally narrow: `sorted {attrName}` is valid and supported; `sorted {method().attr}`, `sorted {method()}`, and `sorted {method(arg)}` currently fall back to compiler W1006/W1007 extra-code handling, so the parser should not silently model them as associations.
- Trait SM operation support covers the compiler-shaped include/exclude forms already under test. A trailing state path after a guarded event, such as `isA T<-sm.s1.e1()[guard].s2>`, is rejected by the compiler and should not be added to the grammar without upstream compiler evidence.
- `--redefine` is a namespace option in the current Umple grammar, not a mixset option. Do not add `mixset name --redefine` parsing unless the compiler grammar changes.
- Top-level/multi-language extra code is already covered by `top Name [Lang] { ... }` and normal `codeLangs`/`moreCode` parsing. There is no current `extracode` keyword syntax to model.
- Full-corpus parse errors that still end with compiler `Success!` are not automatically grammar gaps. Several current examples are malformed-state-machine tests, invalid identifier tests, missing semicolon/no-line-ending edge cases, and extra-code fallback cases. Keep those as parser errors unless the official grammar or a clean corpus example proves a real language construct.

## Known LSP gaps

### Recently completed

The known array-fallback completion leaks have all been closed:

- blank `isA |` slot — topic 052 (`isa_typed_prefix` scalar)
- `before |` / `after |` method-name slot — topic 052 (`code_injection_method` scalar)
- `filter { include | }` class target slot — topic 052 (`filter_include_target` scalar)
- `key { | }` attribute slot — verified clean (lookahead empty; no leak)
- `template_list` / trait template parameter positions — verified clean (analyzer returns null)
- `... as |` statemachine slot — topic 055 split into two scalar scopes:
  - `referenced_sm_target` for `class C { sm name as |...`
  - `trait_sm_binding_target` for `class C { isA T<sm as |...`
- `... as Sm.|` dotted-state continuation in trait binding — topic 055 (`trait_sm_binding_state_target` scalar)
- parameter-type typed-prefix (`void f(P|)`) — topic 052 (`param_type_typed_prefix` scalar)
- LSP snippet completion — topic 054 (`packages/server/src/snippets.ts` registry, capability-gated)
- Find-implementations on traits — topic 059 (`textDocument/implementation` returns direct/transitive class/trait implementers for trait targets)
- CI build/test workflow — topic 060 (`.github/workflows/ci.yml` runs `npm install`, downloads `umplesync.jar`, and executes root `npm test`)
- Workspace symbol search — topic 061 (`workspace/symbol` returns qualified classes, traits, requirements, state machines, states, methods, attributes, associations, and enums across indexed workspace files)
- LSP semantic tokens — topic 064 (`textDocument/semanticTokens/full` maps `highlights.scm` captures into an LSP legend for editors that do not load tree-sitter queries directly)
- VS Code live diagram refresh — topic 065 (`umple.vscode` refreshes diagrams when the root file or any reachable imported `.ump` file changes, including unsaved in-memory edits)
- Workspace-wide rename safety — topic 066 (`textDocument/rename` synchronously indexes workspace roots for explicit rename requests, then searches every indexed `.ump` file instead of only the import graph)
- Find-implementations beyond traits — topic 067 (`textDocument/implementation` now returns class subclasses and interface extensions/implementers in addition to the existing trait implementers)
- LSP inlay hints — topic 068 (`textDocument/inlayHint` shows editor-only inferred types for compiler-verified untyped attributes; association/default multiplicity and trait-template hints are intentionally deferred)
- Active/test/port symbol polish — active methods and Umple `test` blocks are indexed as method symbols, `testSequence` steps resolve/hover to the matching test methods in class scope, and port declarations are indexed as class-scoped `port` symbols. Bare same-class connector endpoints resolve to those ports; one-hop dotted component endpoints such as `cmp1.pOut1` resolve through the component attribute's declared type.
- Inner class parser support — `inner class Name { ... }` inside a class body parses as a true nested class declaration, stays visible in document symbols, and no longer breaks nearby `implementsReq` parsing.
- Corpus grammar triage — compiler-verified grammar support now covers glossary blocks, distributable variants, interface `position` / `test` / extra-code lines, trace `period` / `during` durations, trace wildcards and `onlyGet` / `transition` prefixes, comma-separated `record` and `logLevel` payloads, timed `deactivate`, dotted trace state targets, `fixml` attributes, `test` as a method or state-machine event name, static inner classes, class-local `strictness`, qualified emit template references, top-level `debug;`, `*` transition change markers, and state-to-state standalone transitions (`S1 -> S2;`). Current local corpus report: `1965 / 2092` parse-clean files.
- Semantic coverage for new grammar nodes — trace `set/get/onlyGet/onlySet` targets and trace `record` payloads now resolve as attributes, dotted trace state targets (`trace status.Closed;`) resolve to the class-local state machine and child state, and no-event standalone transitions (`S1 -> S2;`) resolve both endpoints as state references. `trace transition eventName` completion is deliberately suppressed because events are not currently indexed as normal symbols.

### Semantic coverage notes for new grammar nodes

Use this checklist after a grammar-only parse improvement. Do not add hover,
go-to-definition, references, rename, or completion just because a node parses;
only wire semantics where the target has a clear existing symbol model.

Done:

- Trace attribute variants: `set`, `get`, `onlyGet`, and `onlySet` route trace entity references and completions to class-scoped attributes.
- Trace `record` payloads: `record id,contact` and `record only id` resolve as attribute references.
- Dotted trace state targets: `trace status.Closed;` resolves `status` to the enclosing class's state machine and `Closed` to a state inside that machine.
- No-event state transitions: `S1 -> S2;` resolves both endpoints to states, participates in semantic highlighting/local references, and is handled by formatter arrow spacing plus diagram transition lookup.

Intentionally parse/highlight-only for now:

- Trace wildcards such as `*attribute`, `*attributes`, `*`, and wildcard variants have no stable declaration target.
- Trace `logLevel` values, `period` / `during` durations, timed `deactivate ... for 1s`, and similar payload keywords are configuration literals rather than model-symbol references.
- `trace transition eventName` does not resolve `eventName` yet because transition events are not indexed as first-class symbols. Completion after `trace transition` is suppressed to avoid suggesting unrelated class-body keywords or attributes.
- Non-trace parse-only nodes such as `glossary`, `distributable`, `debug`, `strictness`, and `fixml` should stay highlighting/document-symbol level unless a user-facing resolver use case appears.

### How to add new completion slots

The pattern future fixes should follow:

1. detect the exact slot in `completionAnalysis.ts` (prevLeaf / AST ancestors / completions.scm capture)
2. route to a dedicated scalar scope or a symbol-only early return — never let new slots ride the raw-lookahead array fallback
3. add focused regression fixtures + assertions in `packages/server/test/fixtures/semantic/` and `semantic.test.ts`

If you find a new array-fallback leak, treat it the same way: convert to a scalar scope rather than expanding the fallback's filtering logic.

### Code actions

`Add missing semicolon` quick-fix shipped in topics 056 and 057. Coverage:

- W1007 (class-content): `isA …`, `implementsReq …`, inline association (multiplicity + arrow + identifier), interface method signature (only when the cursor is inside an `interface` body), attribute declaration including simple default-value forms (`Integer x = 5`, `String name = "Bob"`).
- W1006 (state-machine): single-line transitions (`e -> s2`), guarded transitions (`e [g] -> s2`), action transitions (`e / { … } -> s2`), dotted-state RHS (`e -> Outer.Inner`).
- E1502 (filter-body): `include`, `includeFilter`, `namespace` statements. The diagnostic line points at the filter header, so the action scans the filter block and emits an edit only when exactly one unterminated candidate exists.

Deliberate defers (documented for future contributors):

- Generic-type collection attributes (`List<String> names`) — appending `;` clears W1007 but introduces W46 (collection-template-type style warning), so the quick-fix isn't a clean win.
- Random W1006 / E1502 lines that don't match a known statement shape (`unrecognized stuff here`, filter `bogus X`, incomplete `e ->`).
- `hops { … }` filter blocks — already clean syntax; appending `;` would BREAK them.
- Multiple unterminated filter statements in the same block — E1502 doesn't tell us which one to fix, so we emit no action rather than guess.
- Association blocks with two standalone ends (`0..2 PersonRole;` + `1 Person;`) — converting that to `0..2 PersonRole -- 1 Person;` is a semantic rewrite, not a likely typo fix.
- Java action bodies with nested `{ … { … } … }` braces inside a transition — single-line classifier rejects nested braces; rare in practice.

Future code-action ideas (not yet implemented):

- "Rename to camelCase / PascalCase to match convention"
- "Convert this attribute to an `enum`"
- "Extract this state's body to a substate"
- "Inline this `use file.ump` (paste contents inline)"

Pattern for new actions: extend `packages/server/src/codeActions.ts` with a new `Diagnostic.code` branch + shape classifier. Keep the module pure — no compiler invocation, no LSP transport.

### Inlay hints

Initial inlay hints now ship for conservative inferred attribute types only:

- no explicit type and no value → `String`
- string literal / string concatenation → `String`
- boolean literal → `Boolean`
- plain integer literal → `Integer`
- plain decimal literal → `Double`
- `autounique` attribute → `Integer`

Deliberate defers:

- association multiplicity/default hints — compiler validation showed omitted-end association forms are not safe to hint as defaults
- trait template substitutions — useful, but needs stronger semantic confidence than the first inlay-hint pass
- complex initializers (`System.lineSeparator()`, qualified names, derived attributes, numeric suffixes) — skipped rather than guessed

## Known tooling gaps

### CI follow-ups

The LSP has PR/push/manual build-test CI now. Remaining optional follow-ups:

- Add dependency caching once a root lockfile policy is settled.
- Decide whether corpus parse stress should become a scheduled/manual CI report once a runner-accessible `cruise.umple/test` source is available. The local reporter exists now (`npm run parse:corpus`) and is report-only by default.
- Keep the README badge current if workflow filenames change.

### No automated npm publish

Publishing is manual. Tag-triggered `npm publish` workflow (push `server-v0.5.0` → CI publishes) was discussed in topic 040 and deferred. Could add when shipping cadence picks up.

### No automated marketplace PR

zed-industries marketplace PR is manual. Probably should stay manual for governance reasons (their maintainers review every PR), but a script that automates the "fork + submodule bump + branch + push + gh pr create" mechanical steps would be nice.

### No auto-update for `umplesync.jar`

The jar consumed for diagnostics is downloaded once via `npm run download-jar` (from `try.umple.org`). If the upstream Umple compiler ships a fix that affects diagnostics, we don't notice until someone re-runs the download. A periodic CI check + auto-PR to refresh the jar would help — but the jar file itself is gitignored, so the implementation is non-trivial.

### Wiki not synced to GitHub Wiki

This wiki lives in `wiki/` in the repo. GitHub also has a separate "Wiki" feature backed by a separate repo at `<repo>.wiki.git`. Could sync these via a workflow on every push. For now, the in-repo wiki is the source of truth; the GitHub Wiki feature is empty.

## Formatter Backlog

Recent safe formatter slices landed:

- Declaration assignment spacing for attributes/constants.
- Structural comma spacing for `use`, `isA`, filter lists, method parameters,
  type arguments, type lists, trait parameter lists, enum values, `throws`
  lists, before/after hook target or operation lists, code-language tags, keys,
  enumerated attributes, requirement links, trace lists, tracer directive
  configurations, and template lists.
- Multi-line list continuation indentation for already split parser-visible
  lists, including params, type args, filters, `use`, keys, enumerated attrs,
  requirement links, trace lists, and template lists.
- Formatter corpus reporter (`npm run format:corpus`) that checks parse-clean
  files stay parse-clean and idempotent.
- Formatter scope docs in the LSP and editor wrapper READMEs.
- Deterministic generated-model coverage for broader formatter families.

Remaining formatter topics, ordered by safety:

1. **Additional parser-visible spacing rules** — only add new punctuation rules
   when they use explicit tree-sitter child tokens and have exact fixtures plus
   corpus proof. Avoid string-scanning inside target-language code.
2. **Compact declaration expansion** — decide whether one-line `class A {}`
   or `interface I { void f(); }` should expand. High risk because compact
   forms are common in tests and examples. Fixture
   `165_format_compact_declarations_boundary.ump` pins the current safe
   boundary: compact declarations remain compact unless a later topic explicitly
   designs and tests expansion.
3. **Embedded target-language formatting** — out of scope for this LSP
   formatter. Java/PHP/C++/Python bodies should remain verbatim unless a
   separate language-aware formatter integration is designed.
4. **Corpus automation in CI** — possible only after deciding how CI obtains a
   stable upstream Umple corpus. Until then, corpus reports remain local/manual.

## Suggested next features (user-facing)

Pulled from the conversation history + general LSP best practice:

1. **Semantic highlighting polish** — continue with small `highlights.scm`
   slices when supported grammar constructs still render as plain text. Recent
   coverage pins strictness/distributable/layout directives, tracer directive
   config names/values, port declarations/connectors, active methods,
   test/test-sequence constructs, and layout numeric payloads through both
   tree-sitter highlighting and LSP semantic tokens. VS Code also has matching
   TextMate fallback scopes for these constructs.
2. **Richer inlay hints** — trait template substitutions or other proven semantic annotations, but only after compiler-backed examples define the exact behavior.

Each of these is a focused topic: spec the scope, get codex review, implement, test, commit. The ~5 day cadence we hit during topics 038–044 is comfortable for one of these per cycle.

## Testing roadmap

- **Formatter generated-model and corpus tests** — the suite now has deterministic generated clean models that assert formatting stays parse-clean, symbol-preserving, and idempotent. The manual corpus reporter (`UMPLE_FORMAT_CORPUS_DIR=/path/to/cruise.umple/test npm run format:corpus`) checks the same invariants against parse-clean upstream files. Future work could broaden generation into a larger `fast-check` generator with more grammar families.
- **Stress tests against the umple compiler corpus** — `cruise.umple/test/` has thousands of `.ump` files. The repo now has a read-only reporter (`UMPLE_CORPUS_DIR=/path/to/cruise.umple/test npm run parse:corpus`) and a generated self-test in root `npm test`. Remaining work is choosing a baseline/threshold and deciding whether a runner-accessible corpus source should feed a scheduled or manual CI report.
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
