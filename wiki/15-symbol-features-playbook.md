# 15 — Symbol features playbook

Use this page when the work is about:

- definitions
- references
- goto-def
- find-refs
- rename
- hover
- outline / document symbols

If syntax also changes, read [04-grammar.md](04-grammar.md) first.

If you want a compact copyable example first, read:

- [18-examples.md](18-examples.md)
- [examples/02-symbol-feature-end-to-end.md](examples/02-symbol-feature-end-to-end.md)

## What makes this easier than completion

These features mostly operate on **stable identifier positions**.

That means the normal flow is:

1. identify the definition position
2. identify the reference position
3. make sure the symbol is indexed
4. test goto-def / refs / rename

This is usually much more mechanical than completion work.

## Files to touch

### `definitions.scm`

Touch this when a construct defines a symbol.

Examples:

- class
- attribute
- requirement
- use-case step

Rule:

- capture the exact definition node, not a broad parent

Good:

```scm
(req_user_step id: (req_step_id (identifier) @definition.use_case_step))
```

Bad:

```scm
(req_user_step) @definition.use_case_step
```

### `references.scm`

Touch this when an identifier should resolve to an existing symbol.

Rule:

- capture the exact identifier node
- keep the allowed kinds narrow

Good:

```scm
(req_implementation (identifier) @reference.requirement)
```

### `symbolIndex.ts`

Touch this when the new symbol needs extra metadata or container handling.

Examples:

- requirement metadata
- use-case step indexing
- nested symbol ownership

Do not put semantic hacks in the query if the real issue is indexing.

## End-to-end recipe

Use this sequence.

1. Make sure the parser can produce the node shape you need
2. Add `@definition.<kind>` if the construct defines a symbol
3. Add `@reference.<kind...>` if the construct references symbols
4. Check whether `symbolIndex.ts` needs:
   - a new symbol kind
   - extra metadata
   - container / ownership logic
5. Add tests for:
   - parse
   - symbol extraction
   - goto-def
   - refs
   - rename if supported
   - hover / outline if the feature should surface there

## Detailed worked example: requirement-style symbol support

This is the exact pattern already used in the repo for `requirement`.

Goal:

- a symbol is defined by `req HighLevel`
- references like `implementsReq HighLevel` should support goto-def / refs / rename
- hover should show requirement metadata
- outline should show the requirement as a document symbol

Minimal fixture shape:

```umple
req /*@def_high*/HighLevel userStory {
  who { salesPerson }
}

class Order {
  implementsReq /*@use_high*/HighLevel;
}
```

### 1. Definition capture

File:

- `packages/tree-sitter-umple/queries/definitions.scm`

Pattern already used:

```scm
(requirement_definition name: (identifier) @definition.requirement)
(requirement_definition name: (req_id) @definition.requirement)
```

Why both?

- requirement ids can be ordinary identifiers
- or broader `req_id` shapes such as digit-leading / hyphenated forms

### 2. Reference captures

File:

- `packages/tree-sitter-umple/queries/references.scm`

Patterns already used:

```scm
(requirement_definition name: (identifier) @reference.requirement)
(requirement_definition name: (req_id) @reference.requirement)
(req_implementation (identifier) @reference.requirement)
(req_implementation (req_id) @reference.requirement)
```

Why include the definition name too?

- so operations starting on the declaration token itself still resolve through the same reference pipeline
- that helps keep goto-def / refs / rename behavior uniform at declaration and use sites

### 3. Symbol kind and indexing

Files:

- `packages/server/src/tokenTypes.ts`
- `packages/server/src/symbolIndex.ts`
- `packages/server/src/symbolTypes.ts`

What exists for requirements:

- `requirement` is part of `SymbolKind` in `tokenTypes.ts`
- structured req metadata is stored on `SymbolEntry` in `symbolTypes.ts`
- `symbolIndex.ts` populates those metadata fields when indexing a requirement definition

What to do for a new symbol kind following this pattern:

1. add the new kind to `SymbolKind`
2. add any metadata fields only if hover/outline actually need them
3. index exactly one symbol entry per real definition

Do not add rename or hover logic before indexing is trustworthy.

### 4. Goto-def and find-refs

Once the definition and reference captures are correct, goto-def and refs usually work through the normal resolver path.

For requirements, the important tests live in:

- `packages/server/test/fixtures/semantic/125_implementsreq_contexts.ump`
- `packages/server/test/fixtures/semantic/127_req_decomposition.ump`

Typical assertions:

```ts
{ type: "goto_def", at: "use_high", expect: [{ at: "def_high" }] }
{ type: "refs", at: "def_high", expect: ["def_high", "use_high"] }
```

What to check:

- goto-def from each use reaches the intended declaration
- refs do not leak to neighboring names

### 5. Rename

Files:

- `packages/server/src/renameValidation.ts`
- `packages/server/src/server.ts`

What exists for requirements:

- `requirement` is in `RENAMEABLE_KINDS`
- `isValidNewName(...)` applies the broader req-id regex instead of the normal identifier regex

Why this mattered:

- requirement ids allow forms like `001dealing` and `L01-LicenseTypes`
- the default identifier regex would have rejected valid requirement names

Tests to copy when adding a new renameable kind:

- rename from declaration site
- rename from use site
- valid-name acceptance
- invalid-name rejection
- all important use contexts updated together

Typical assertions:

```ts
{ type: "rename_edits", at: "def_high", newName: "HigherLevel", expectAt: ["def_high", "use_high"], expectCount: 2 }
{ type: "rename_rejected", at: "def_high", newName: "-bad-name", reason: "invalid-name" }
```

### 6. Hover

File:

- `packages/server/src/hoverBuilder.ts`

Existing requirement case:

- builds a header like `req HighLevel userStory`
- appends structured metadata such as `Who`, `When`, `What`, `Why`

Pattern to follow for a new symbol kind:

1. keep the header short and unambiguous
2. only show metadata that is semantically complete
3. never let partially parsed/incomplete syntax leak fake data into hover

Typical assertion:

```ts
{ type: "hover_output", at: "def_high", expectContains: ["req HighLevel userStory", "**Who:** salesPerson"] }
```

### 7. Outline / document symbols

File:

- `packages/server/src/documentSymbolBuilder.ts`

Existing requirement case:

- `requirement` maps to an LSP symbol kind
- the symbol appears in the document outline as long as its definition range is indexed

Pattern to follow:

1. decide the appropriate LSP `SymbolKind`
2. make sure the indexed symbol has real definition ranges
3. if children should nest under it, ensure their ranges are strictly contained

Typical assertion:

```ts
{ type: "document_symbols", fixture: "NN_feature.ump", expectRoots: ["HighLevel"], expectChild: { parent: "HighLevel", child: "1" } }
```

### 8. Minimum complete test set

For a new requirement-like symbol feature, the test block should cover all of:

- `parse_clean`
- `symbol_count`
- `goto_def`
- `refs`
- `hover_output`
- `document_symbols`
- `rename_edits`
- `rename_rejected`

If one of those is intentionally unsupported, say so explicitly in the topic scope instead of leaving it ambiguous.

## Worked examples from this repo

### `use_case_step`

Shape:

- structured req grammar adds `userStep` / `systemResponse`
- `definitions.scm` captures the step id
- `symbolIndex.ts` creates `use_case_step` symbols
- tests verify:
  - symbol count
  - hover
  - outline nesting

### `implementsReq`

Shape:

- `references.scm` captures identifiers in `req_implementation`
- resolution narrows to `requirement`
- tests verify:
  - goto-def
  - refs
  - rename
  - decomposition boundaries

## Rename support checklist

Rename is usually the last step, not the first.

Before enabling rename for a new kind, confirm:

1. definition capture is correct
2. reference capture is correct
3. refs are stable and bounded
4. name validation matches the language syntax for that symbol kind

Example from requirements:

- requirement ids are **not** plain identifiers
- they allow forms like numeric-leading or hyphenated ids
- rename validation had to be made kind-aware

## Hover and outline checklist

If a symbol should show useful hover or document-symbol output, verify:

1. symbol metadata is present in `symbolIndex.ts`
2. hover output includes only complete/real data
3. incomplete syntax does not leak fake metadata
4. outline nesting is correct

Example:

- incomplete req tags / steps should parse
- but must not populate requirement metadata or step symbols unless semantically complete

## Typical assertions

Use the existing helpers in `packages/server/test/semantic.test.ts`.

Most symbol-feature topics should use some of:

- `parse_clean`
- `symbol_count`
- `goto_def`
- `refs`
- `shared_refs`
- `hover_output`
- `hover_excludes`
- `document_symbols`
- `rename_edits`
- `rename_rejected`

## Common mistakes

### Broad definition captures

If you capture too much, the server has to guess which child is the real name.

Prefer exact identifier captures.

### Broad reference captures

If you allow too many kinds at the query layer, resolution becomes noisy and hard to reason about.

### Enabling rename before refs are trustworthy

If refs are wrong, rename will be wrong too. Fix refs first.

### Mixing parser tolerance with semantic indexing

Sometimes the parser should accept an incomplete construct that the semantic layer must ignore.

That is fine.

Examples already in this repo:

- incomplete req tags
- incomplete req steps

## When this page is not enough

If the main problem is not a stable identifier position, stop and read:

- [16-completion-playbook.md](16-completion-playbook.md)

That usually means the real problem is completion or editor-time recovery, not defs/refs/rename.
