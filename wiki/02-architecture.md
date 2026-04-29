# 02 — Architecture

How the LSP server is organized inside `packages/server/src/`, how it talks to its dependencies, and the key abstractions you'll be reading and editing.

## Module layout

```
packages/server/src/
├── server.ts                  ← LSP wire orchestration; hooks for init / hover / def / refs / rename / completion / diagnostics / format
├── symbolIndex.ts             ← Symbol storage + queries; tree-sitter parser host
├── resolver.ts                ← resolveSymbolAtPosition() — used by goto-def, hover, rename
├── completionAnalysis.ts      ← analyzeCompletion() — context detection (scopes, fallbacks)
├── completionBuilder.ts       ← buildSemanticCompletionItems() — turn scope into items
├── tokenAnalysis.ts           ← analyzeToken() — what the cursor is on
├── referenceSearch.ts         ← findReferences() with semantic disambiguation
├── hoverBuilder.ts            ← Markdown hover assembly per SymbolKind
├── documentSymbolBuilder.ts   ← Flat SymbolEntry[] → nested DocumentSymbol[]
├── semanticTokens.ts           ← LSP semantic-token legend + highlights.scm capture mapping
├── formatter.ts               ← Indent/spacing/blank-line/embedded-code passes
├── formatRules.ts             ← Node classification used by the formatter
├── formatSafetyNet.ts         ← Pre/post symbol-set comparison; aborts if format breaks semantics
├── diagramNavigation.ts       ← state/transition click-to-select for VS Code diagrams
├── diagramRequests.ts         ← Custom LSP request handlers
├── importGraph.ts             ← Forward/reverse import edges
├── traitSmEventResolver.ts    ← trait-side SM operation event lookup
├── tokenTypes.ts              ← Shared types: SymbolKind, LookupContext, TokenResult
├── symbolTypes.ts             ← Shared types: SymbolEntry, ReferenceLocation
├── treeUtils.ts               ← Shared tree walkers
├── renameValidation.ts        ← RENAMEABLE_KINDS + isValidNewName(kind, newName)
└── keywords.ts                ← Built-in type names (Integer, String, ...)
```

The CLI binary is a 2-line shell shebang at `packages/server/bin/umple-lsp-server` that just `require()`s `out/server.js`. The CLI flag handling (`--version` / `--help` / `--stdio`) is a small preamble at the top of `server.ts` — runs before `createConnection` so the process can exit cleanly without ever opening an LSP connection.

## Request lifecycle

### initialize → connection.onInitialize

Server startup sequence (`server.ts`):

1. Read `params.initializationOptions` for `umpleSyncJarPath` and `umpleSyncTimeoutMs`
2. Resolve the umplesync.jar path (init option → env `UMPLESYNC_JAR_PATH` → `__dirname/../umplesync.jar` auto-discovery)
3. Resolve workspace roots
4. Initialize `SymbolIndex` (loads tree-sitter WASM, all `.scm` queries)
5. Return `serverInfo` (name + version) and capabilities

### Document open / change

`onDidOpen` and `onDidChangeContent`:

1. Strip the UmpleOnline layout tail (the `//$?[End_of_model]$?` delimiter and everything after) — see `tokenTypes.stripLayoutTail`
2. `symbolIndex.indexFile(path, content)` — parses with tree-sitter, runs the `definitions.scm` query, stores a `SymbolEntry[]`
3. Eagerly index all files reachable via `use` statements (transitive imports)
4. Schedule diagnostics with debounce + abort

### Diagnostics

`runDiagnostics()` in `server.ts`:

1. Build a **shadow workspace** — temp directory with the current file + every `use`-reachable file. Open editor content overlays disk content.
2. Spawn `java -jar umplesync.jar -generate nothing <file>` with timeout
3. Parse JSON output → LSP diagnostics
4. Map filenames: errors in directly imported files appear on the `use` statement line; transitively imported errors also surface on the direct `use` line

Diagnostics are compiler-authoritative and editor-independent. Tree-sitter parse
success does not suppress `umplesync.jar` errors: the parser can recover enough
structure for symbols, completion, and highlighting while the compiler still
rejects the model. New diagnostics are published with source `umple compiler`;
the server still accepts the legacy source `umple` for code-action
compatibility.

Debounced (500ms default). Re-runs when any file in a chain changes (forward + reverse importer set).

### Symbol resolution

`resolveSymbolAtPosition(docPath, content, line, col, reachableFiles)` — the workhorse used by goto-def, hover, and rename.

1. `getTokenAtPosition` returns a `TokenResult` (word + valid `SymbolKind[]` from `references.scm` + enclosingClass / enclosingStateMachine + dotted-path info)
2. Discriminated `LookupContext` — handles trait_sm_param, trait_sm_value, trait_sm_op, referenced_sm, etc.
3. For class-/SM-scoped kinds (`attribute`, `method`, `state`, ...): try enclosing container first (with isA inheritance), fall back to global
4. Post-lookup disambiguation: dotted state paths, state definition sites, use_case_step exact-position matching

Active methods and Umple `test` blocks are represented as `method` symbols.
`testSequence` step identifiers are method references, so go-to-definition and
hover reuse the normal scoped method resolver. Port declarations are
class-scoped `port` symbols, so document/workspace symbols, hover,
go-to-definition, and find-references work on declaration names, bare same-class
connector endpoints such as `pIn -> pOut`, and one-hop component endpoints such
as `cmp1.pOut1` when `cmp1` is a typed attribute. The resolver intentionally
does not guess for unresolved components or deeper component chains.

Trace variants are semantic only where the target is a normal model symbol.
`trace set/get/onlyGet/onlySet ...` and trace `record ...` payloads resolve as
attributes. Dotted trace state targets such as `trace status.Closed;` resolve
the first segment to the class-local state machine and later segments to states
inside it. `trace transition eventName` resolves to class-scoped transition
event symbols. Timed events such as `after(...)` and `afterEvery(...)` are not
indexed as user event symbols. Trace wildcards, log-level values, and timing
payloads remain parse/highlight-only. No-event state transitions (`S1 -> S2;`)
reuse the normal state resolver for both endpoints.

### Completion

`analyzeCompletion(tree, lang, completionsQuery, content, line, col)` returns a `CompletionInfo` with:

- `keywords` — from tree-sitter's `LookaheadIterator` at the current parse state
- `operators` — operator-shaped keywords (separated for filtering)
- `symbolKinds` — discriminated scope type (`top_level`, `class_body`, `association_multiplicity`, `userstory_body`, `requirement`, ...)
- `prefix` — what the user has already typed
- `isComment`, `isDefinitionName` — guards

Then `buildSemanticCompletionItems(info, symbolKinds, ...)` turns the scope into `CompletionItem[]`. Each scope has its own branch — narrow scopes (e.g. `association_arrow`) return only curated keywords, no LookaheadIterator dump.

The scope detection uses two complementary mechanisms:

- **`completions.scm` query captures** — for normal grammar shapes (e.g. `(req_implementation) @scope.requirement`)
- **`prevLeaf`-based fallbacks** in `completionAnalysis.ts` — for cursor positions the parser hasn't yet committed to a real node (empty bodies, partial associations, slots between tokens)

The `prevLeaf` pattern handles tree-sitter's LR(1) limitations gracefully without grammar contortions. Search `completionAnalysis.ts` for `prevLeaf?.type ===` to see all the recovery branches.

### Semantic tokens

`textDocument/semanticTokens/full` uses the same `highlights.scm` query that
tree-sitter-based editors consume. `SymbolIndex` loads that query beside
`definitions.scm`, `references.scm`, and `completions.scm`; `semanticTokens.ts`
maps captures such as `@type.definition`, `@variable.member`, and `@keyword` to
an LSP semantic-token legend. This gives editors that rely on LSP tokens a
server-side highlighting path without duplicating grammar rules.

### Inlay hints

`textDocument/inlayHint` is implemented in `inlayHints.ts`. It currently emits
only editor-only type hints for untyped `attribute_declaration` nodes in clean
parse trees. The supported cases mirror compiler-verified behavior:

- no explicit type and no value → `String`
- string literal / string concatenation → `String`
- boolean literal → `Boolean`
- plain integer literal → `Integer`
- plain decimal literal → `Double`
- `autounique` attribute → `Integer`

The handler deliberately skips explicit types, derived attributes, method calls,
qualified names, numeric suffixes, broken parse trees, and association
multiplicity/default guesses. Inlay hints never edit source text.

### Find references

`findReferences(declarations, reachableFiles, includeDecl)` in `symbolIndex.ts`:

1. For each file in scope, walk the AST
2. For each identifier matching the declaration name, check via `references.scm` whether it can reference the declaration's kind
3. Apply state-path disambiguation, container check, shared-state equivalence

For reused state machines (`as` aliasing), `getSharedStateDeclarations()` builds the equivalence class first.

Dotted trace state paths have extra filtering in `referenceSearch.ts`: the
first segment must match a state-machine declaration in the enclosing class, and
later segments must match state declarations under that state machine. This
keeps `status` and `Closed` references in `trace status.Closed;` from matching
unrelated attributes, classes, or states with the same names.

Transition event symbols are class- or trait-scoped because Umple events behave
like generated trigger methods on the owning entity. `event_spec` identifiers in
normal transitions are indexed as `event`; timed-event keywords are skipped.
`trace transition flip` can therefore go to all `flip` event occurrences in the
class, find references includes both transition occurrences and trace uses, and
completion after `trace transition` offers event names only.

### Rename

`onPrepareRename` checks: kind ∈ `RENAMEABLE_KINDS`, identity unambiguous, file not recovered.
`onRenameRequest` validates new name with `isValidNewName(kind, newName)` (kind-aware), then runs the same search as find-references and returns a `WorkspaceEdit`.

`renameValidation.ts` is the single source of truth for both rules. Used by both `server.ts` and the test harness.

## Symbol index design

`SymbolEntry` (`symbolTypes.ts`) is the universal record:

```ts
{
  name, kind, file, line, column, endLine, endColumn,
  container?,        // class.name for attributes; classname.smName for states
  defLine?, defColumn?, defEndLine?, defEndColumn?,
  statePath?,        // ["EEE","Open","Inner"] for nested states
  recovered?,        // extracted from a tree with parse errors
  // Structured req metadata:
  reqLanguage?, reqWho?, reqWhen?, reqWhat?, reqWhy?,
  reqStepKind?, reqStepId?,
}
```

Storage: a flat `SymbolEntry[]` per file plus three indexes:

- `symbolsByContainer: Map<string, SymbolEntry[]>` — O(1) container-scoped lookups
- `isAGraph: Map<string, string[]>` — for `inherited: true` walks
- `forward/reverseImportGraph` — for diagnostics + rename scope

Public API is a single unified function:

```ts
getSymbols({ name?, kind?, container?, inherited? }) → SymbolEntry[]
```

There's no `getSymbolsByName` / `getSymbolsByContainer` etc. — one query interface.

## Tree-sitter integration

Server loads `tree-sitter-umple.wasm` (copied from the grammar package at build time) via `web-tree-sitter`. The four `.scm` query files (`definitions.scm`, `references.scm`, `completions.scm`, and `highlights.scm`) are also copied into the server package.

Parser is instantiated once per `SymbolIndex`. Per-file: parse → store `Tree` → run query → extract `SymbolEntry[]`. Content-hash caching skips re-parse when content hasn't changed.

For details on the grammar itself: [04-grammar.md](04-grammar.md).

## Cold-open recovery

When opening a file with parse errors, the indexer applies a **kind-sensitive** filter (`symbolIndex.ts` ~line 194):

- `RECOVERY_SAFE_KINDS` (`class`, `interface`, `trait`, `enum`, `mixset`, `attribute`, `const`, `method`, `statemachine`, `state`) are extracted from the broken tree
- Other kinds are preserved from the last clean snapshot
- Recovered symbols are tagged `recovered: true`; rename is blocked on them

This lets users get partial autocomplete / hover / goto-def even mid-edit, while preventing rename from making changes based on a guess.

## Diagnostics + import resolution

For accurate cross-file diagnostics the server creates a **shadow workspace** per validation:

1. Identify the file being validated + every file reachable via `use` statements (lazy, only follows what's in scope)
2. Materialize all of them in a temp directory; overlay open-editor content for unsaved buffers
3. Run `umplesync.jar` against the shadow root
4. Map errors back to the real files; errors in transitively imported files surface on the direct `use` line, prefixed with `In imported file (X:line):`

Concurrent validations are aborted via `AbortController` so only the latest request's results win.

The diagnostics pipeline intentionally does not consult tree-sitter ERROR nodes
when deciding whether to report a model error. Parser coverage and compiler
validity are related but separate signals; fixing a parser gap should improve LSP
features without hiding compiler diagnostics.

## Formatter

Multi-pass, AST-driven (`formatter.ts`):

- **Phase 0** — `expandCompactStates`: rewrites compact `S1 { e -> S2; }` blocks onto multiple lines so subsequent passes see consistent shape
- **Phase 1** — `computeIndentEdits`: indent based on `INDENT_NODES` (class/interface/trait/state/req/...) and align already split parser-visible list continuations/closing delimiters
- **Phase 2** — `fixTransitionSpacing`, `fixAssociationSpacing`, `fixDeclarationAssignmentSpacing`, `fixStructuralCommaSpacing`, `normalizeTopLevelBlankLines`; structural spacing passes normalize spaces or tabs around parser-visible operators only
- **Phase 3** — `reindentEmbeddedCode`: re-indent code inside `{...}` method/template bodies relative to the surrounding Umple indent

Safety net (`formatSafetyNet.ts`): before returning edits, the formatter re-parses the result, re-runs symbol extraction, and compares symbol sets. If the formatted version has materially fewer symbols (or the parse goes from clean to broken), the format is **discarded** and a warning is logged.

Formatter regression coverage includes fixed fixtures plus deterministic
generated clean models that must remain parse-clean, preserve symbols, and be
idempotent after formatting.

Intentional limits:

- The formatter skips files whose tree already has parser errors.
- Embedded target-language code is treated as a verbatim island, apart from
  shifting whole code blocks to match surrounding Umple indentation.
- Structural spacing rules only use parser-visible tokens in known node types;
  they must not scan arbitrary text for punctuation.
- Multi-line list indentation only changes existing line indents; it does not
  split single-line lists or join already split lists.
- Broad rewrites such as splitting all compact declarations or Java-formatting
  method bodies should remain separate topics with corpus proof before landing.

For local corpus checks, run
`UMPLE_FORMAT_CORPUS_DIR=/path/to/cruise.umple/test npm run format:corpus`.
The report skips files that already have parser errors, formats parse-clean
files only, reparses the output, and verifies a second format pass is
idempotent.

## Where to go next

- Adding grammar features → [04-grammar.md](04-grammar.md)
- Running it locally → [03-development.md](03-development.md)
- Common gotchas while editing the server → [12-gotchas.md](12-gotchas.md)
