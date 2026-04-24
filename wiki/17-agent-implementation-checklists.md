# 17 — Agent implementation checklists

This page is for AI agents and future contributors who need a compact, operational view of the repo.

Use it together with:

- [14-feature-work-playbook.md](14-feature-work-playbook.md)
- [15-symbol-features-playbook.md](15-symbol-features-playbook.md)
- [16-completion-playbook.md](16-completion-playbook.md)

The goal is simple:

- decide the feature type quickly
- touch the right files
- avoid widening the wrong layer
- ship with enough tests

## 1. Fast decision table

| If the problem is mainly… | Primary files | Read next |
|---|---|---|
| syntax does not parse | `packages/tree-sitter-umple/grammar.js` | [04-grammar.md](04-grammar.md) |
| new symbol definition | `definitions.scm`, `tokenTypes.ts`, maybe `symbolIndex.ts` | [15-symbol-features-playbook.md](15-symbol-features-playbook.md) |
| new reference position | `references.scm`, maybe `resolver.ts` / `symbolIndex.ts` | [15-symbol-features-playbook.md](15-symbol-features-playbook.md) |
| goto-def / refs / rename wrong | `references.scm`, `symbolIndex.ts`, `renameValidation.ts`, `server.ts` | [15-symbol-features-playbook.md](15-symbol-features-playbook.md) |
| hover / outline missing metadata | `symbolIndex.ts`, `hoverBuilder.ts`, `documentSymbolBuilder.ts` | [15-symbol-features-playbook.md](15-symbol-features-playbook.md) |
| blank-slot completion wrong | `completions.scm` or `completionAnalysis.ts`, then `completionBuilder.ts` | [16-completion-playbook.md](16-completion-playbook.md) |
| typed-prefix completion wrong | `completionAnalysis.ts`, then `completionBuilder.ts` | [16-completion-playbook.md](16-completion-playbook.md) |
| raw keyword junk leaking into completion | `completionBuilder.ts`, maybe `completionAnalysis.ts` | [16-completion-playbook.md](16-completion-playbook.md) |
| syntax highlighting only | `highlights.scm` | [04-grammar.md](04-grammar.md) |

## 2. File-touch matrix

Use this to avoid over-editing.

| Feature shape | Usually touch | Usually do **not** touch |
|---|---|---|
| new keyword parses | `grammar.js`, maybe `highlights.scm`, tests | `completionBuilder.ts` unless completion behavior changes |
| new symbol kind | `tokenTypes.ts`, `definitions.scm`, maybe `symbolIndex.ts`, tests | `completionAnalysis.ts` unless completion behavior changes |
| new reference kind | `references.scm`, maybe `resolver.ts` or `symbolIndex.ts`, tests | `grammar.js` unless syntax is missing |
| rename for existing symbol kind | `renameValidation.ts`, `server.ts`, tests | `grammar.js` |
| typed-prefix completion narrowing | `completionAnalysis.ts`, `completionBuilder.ts`, tests | `grammar.js` unless syntax is actually missing |
| curated body completion | `completions.scm` and/or `completionAnalysis.ts`, `completionBuilder.ts`, tests | `definitions.scm` unless symbols also change |
| hover metadata polish | `symbolIndex.ts`, `hoverBuilder.ts`, tests | `completionBuilder.ts` |
| document outline nesting | `documentSymbolBuilder.ts`, maybe `symbolIndex.ts`, tests | `completionAnalysis.ts` |

## 3. Do / don’t rules

### Do

- change the smallest layer that can actually fix the bug
- add focused fixtures and assertions before manual editor testing
- add negative boundary tests for completion work
- keep parser tolerance and semantic indexing as separate decisions
- reuse existing helpers before inventing a new pattern

### Don’t

- do not widen `grammar.js` to fix a completion-only bug
- do not put indexing hacks into query files if the real issue is semantic extraction
- do not let user-facing scalar completion scopes fall through generic raw-lookahead fallback
- do not enable rename for a kind before refs are stable
- do not rely on “somewhere earlier in this big `ERROR` region I saw token X” as your only completion heuristic

## 4. Named patterns already proven in this repo

Use these names in design notes and topics. They are already established by shipped work.

### Pattern A — Query-driven typed prefix

Use when the query can identify the exact identifier slot.

Example:

- `association_typed_prefix`

Shape:

1. narrow `@scope.*` capture in `completions.scm`
2. scalar scope in `completionAnalysis.ts`
3. symbol-only early return in `completionBuilder.ts`

### Pattern B — Analyzer-driven mixed mode

Use when the same broad AST region contains:

- real structural starter slots
- and arbitrary prose / opaque text

Example:

- structured req-body starters

Shape:

1. broad query remains suppressed
2. analyzer opts in only at safe local positions
3. builder returns curated starters

### Pattern C — Parser-tolerant, semantically opaque

Use when incomplete syntax should parse without making the semantic layer lie.

Examples:

- incomplete req tags / steps
- partial association typing

Shape:

1. grammar accepts the incomplete form
2. symbol indexing ignores it until semantically complete
3. hover / outline / rename do not pretend it is real data

### Pattern D — Symbol-only scalar early return

Use when a completion slot should show only known symbols.

Examples:

- `transition_target`
- `own_attribute`
- `sorted_attribute`
- `isa_typed_prefix`

Shape:

1. analyzer routes to scalar scope
2. builder returns only symbols
3. raw lookahead never reaches the user

## 5. Per-topic checklists

### Grammar-only topic

- confirm compiler accepts the syntax
- update `grammar.js`
- update `highlights.scm` if new keywords were introduced
- run `npm run compile`
- add `parse_clean` or parser-regression tests

### Symbol-feature topic

- add exact `@definition.*` capture if needed
- add exact `@reference.*` capture if needed
- add/update `SymbolKind` if needed
- update `symbolIndex.ts` if metadata or ownership changes
- test:
  - parse
  - symbol count
  - goto-def
  - refs
  - rename if supported
  - hover / outline if expected

### Completion topic

- decide: curated blank slot, symbol-only slot, or fallback
- prefer exact query capture when possible
- otherwise refine in `completionAnalysis.ts`
- add scalar early return in `completionBuilder.ts` when user-visible
- test:
  - slot kind
  - includes
  - excludes
  - no `ERROR`
  - nearby negative boundary

### Mixed topic

Split into phases unless the work is truly tiny:

1. grammar parses
2. defs/refs/indexing work
3. completion becomes good
4. rename / hover / outline polish

## 6. Quick source map

| File | Purpose |
|---|---|
| `packages/tree-sitter-umple/grammar.js` | syntax acceptance and recovery |
| `packages/tree-sitter-umple/queries/definitions.scm` | definition positions |
| `packages/tree-sitter-umple/queries/references.scm` | reference positions |
| `packages/tree-sitter-umple/queries/completions.scm` | broad and exact completion scopes |
| `packages/tree-sitter-umple/queries/highlights.scm` | syntax highlighting |
| `packages/server/src/completionAnalysis.ts` | completion slot detection and recovery-aware routing |
| `packages/server/src/completionBuilder.ts` | actual visible completion items |
| `packages/server/src/symbolIndex.ts` | symbol extraction, indexing, metadata |
| `packages/server/src/hoverBuilder.ts` | hover rendering |
| `packages/server/src/documentSymbolBuilder.ts` | outline / document symbols |
| `packages/server/src/renameValidation.ts` | renameable kinds and name validation |
| `packages/server/src/server.ts` | LSP handlers and final wiring |
| `packages/server/test/semantic.test.ts` | semantic regression harness |

## 7. Current reusable helpers worth checking first

### Completion analysis

- `packages/server/src/completionAnalysis.ts`
  - `isLetterLeadingIdentifier(...)`
  - `isInsideTypeNameFieldSlot(...)`

### Completion building

- `packages/server/src/completionBuilder.ts`
  - `appendSymbolsOfKinds(...)`
  - `buildTypeCompletionItems(...)`
  - `buildLookaheadFallbackItems(...)`

If a new change looks like one of these patterns, reuse them instead of cloning logic.

## 8. Minimum quality bar before asking for review

Before handing work off for review, make sure:

1. scope is explicit
2. there is at least one negative boundary test
3. `npm run compile` passes if grammar/query files changed
4. `npm test -w packages/server` passes
5. the change is in the right layer

If you cannot explain why a file was touched, it probably should not have been touched.
