# 16 — Completion playbook

Use this page when the work is about:

- curated completion lists
- symbol-only slot completion
- typed-prefix narrowing
- raw keyword leakage
- `ERROR`-recovery completion routing

If syntax also changes, read [04-grammar.md](04-grammar.md) first.

If you want a compact copyable example first, read:

- [18-examples.md](18-examples.md)
- [examples/03-completion-feature-end-to-end.md](examples/03-completion-feature-end-to-end.md)

## Why completion is the hardest part

Definitions, refs, and rename usually operate on stable identifier positions.

Completion has to work in **unfinished code**:

- `isA P|`
- `1 -> |`
- `1 -> * O|`
- `req UC1 useCase { | }`
- `Customer checks out|`

So completion often needs to infer intent from:

- `nodeAtCursor`
- `prevLeaf`
- local parent walks
- bounded `ERROR` fallback

That is why completion work needs tighter boundaries and better negative tests.

## The three completion models

### 1. Curated construct scope

Use when the user is at a blank structural position.

Examples:

- `top_level`
- `class_body`
- `state_body`
- `filter_body`
- `userstory_body`
- `usecase_body`

Implementation shape:

- analyzer decides the scope
- builder returns curated starters
- no raw lookahead shown

### 2. Symbol-only scope

Use when the user is filling a reference/type/name slot.

Examples:

- `association_typed_prefix`
- `isa_typed_prefix`
- `transition_target`
- `own_attribute`
- `sorted_attribute`

Implementation shape:

- analyzer decides a narrow scope
- builder early-returns symbol-only output
- no raw lookahead shown

### 3. Fallback array scope

Use only when the position is still generic and not yet modeled precisely.

Current implementation:

- `packages/server/src/completionBuilder.ts:838`
- `buildLookaheadFallbackItems(...)`

This is a shrinking fallback, not the preferred end state.

## Which file to touch

### `completions.scm`

Use it when containment alone is enough to identify the slot.

Good examples:

```scm
(class_definition) @scope.class_body
(association_inline right_type: (identifier) @scope.association_typed_prefix)
(code_block) @scope.suppress
```

Bad use:

- trying to distinguish prose from structure when both are inside the same broad node

### `completionAnalysis.ts`

Use it when the query cannot safely tell the difference.

Use it for:

- typed-prefix detection
- `ERROR` fallbacks
- prev-leaf slot detection
- scope upgrades / downgrades

Prefer reusing existing helpers:

- `isLetterLeadingIdentifier(...)`
- `isInsideTypeNameFieldSlot(...)`

### `completionBuilder.ts`

Use it to control what the user actually sees.

Prefer:

- early-return specialized scopes
- curated construct lists
- symbol-only helpers

Reuse existing helpers:

- `appendSymbolsOfKinds(...)`
- `buildTypeCompletionItems(...)`
- `buildLookaheadFallbackItems(...)` only as last resort

## Detailed worked example A: query-driven typed-prefix completion

This is the exact pattern already used for association right-side type prefixes.

Goal:

- while typing `1 -> * O|`
- offer only matching type symbols
- do not show raw junk like `ERROR`, `namespace`, `Java`

### 1. Add the narrow query capture

File:

- `packages/tree-sitter-umple/queries/completions.scm`

Existing pattern:

```scm
(association_inline right_type: (identifier) @scope.association_typed_prefix)
(association_member right_type: (identifier) @scope.association_typed_prefix)
```

Why this works:

- the cursor is on a specific named child
- the narrow identifier capture beats the broader enclosing association capture

### 2. Normalize the scope in the analyzer

File:

- `packages/server/src/completionAnalysis.ts`

The analyzer maps the capture name to the scalar scope:

```ts
if (kindStr === "association_typed_prefix") return "association_typed_prefix";
```

For this case, no extra fallback logic is needed because the query can already identify the slot exactly.

### 3. Add the symbol-only early return

File:

- `packages/server/src/completionBuilder.ts`

Pattern:

```ts
if (symbolKinds === "association_typed_prefix") {
  return buildTypeCompletionItems(
    ["class", "interface", "trait"],
    symbolIndex,
    reachableFiles,
    { includeBuiltins: false, includeVoid: false, includeEnums: false },
  );
}
```

Why this matters:

- it bypasses `buildLookaheadFallbackItems(...)`
- only type symbols are shown
- raw parser-lookahead keywords never reach the user

### 4. Add focused tests

Relevant fixtures from this repo:

- `packages/server/test/fixtures/semantic/130b_assoc_partial_slots.ump`

What to pin:

- correct scope kind
- expected type symbols included
- junk excluded
- nearby blank-slot association behavior unchanged
- state-machine `->` behavior unchanged

This is the cleanest pattern: exact query capture + scalar builder early return.

## How to decide query vs analyzer

### Query can identify it exactly

Example:

```scm
(association_inline right_type: (identifier) @scope.association_typed_prefix)
```

That works because the cursor is on a specific named child.

### Query cannot identify it exactly

Req-body structured starters are the counterexample.

These two positions are both inside the same broad req-body region:

```umple
req UC1 useCase {
  Customer checks out|
}
```

```umple
req UC1 useCase {
  |userStep 1 { confirm }
}
```

The query alone cannot safely distinguish prose from a true starter slot. So the repo keeps the broad req body suppressed and uses `completionAnalysis.ts` to opt in only at actual starter positions.

Another example:

- `isA P|` under broken syntax

The analyzer has to decide whether that typed prefix is a real type-list slot or just text inside a wider `ERROR`.

## Detailed worked example B: analyzer-driven mixed-mode completion

This is the exact pattern already used for structured req-body starters.

Goal:

- in a structured req body, offer starters only at real starter slots
- keep prose positions quiet

Examples:

Offer starters here:

```umple
req UC1 useCase {
  |userStep 1 { confirm }
}
```

Stay quiet here:

```umple
req UC1 useCase {
  Customer checks out|
}
```

### 1. Keep the broad query suppressed

File:

- `packages/tree-sitter-umple/queries/completions.scm`

Existing shape:

```scm
(requirement_definition) @scope.suppress
(req_tag_content) @scope.suppress
```

Why:

- the query cannot safely distinguish prose from a true starter slot just from containment

### 2. Opt in only at safe positions in the analyzer

File:

- `packages/server/src/completionAnalysis.ts`

Pattern:

- inspect `prevLeaf`
- detect whether the cursor is:
  - right after `{`
  - or after a complete structured tag/step
- read the enclosing requirement language
- route to:
  - `userstory_body`
  - or `usecase_body`
- otherwise keep it suppressed

This is where the real correctness lives.

### 3. Add curated starter lists in the builder

File:

- `packages/server/src/completionBuilder.ts`

Pattern:

- `userstory_body` returns:
  - `who`, `when`, `what`, `why`
- `usecase_body` returns:
  - `who`, `when`, `what`, `why`, `userStep`, `systemResponse`

No raw lookahead is used here.

### 4. Add negative tests first-class, not as an afterthought

Relevant tests should pin:

- empty structured body -> starter list appears
- after a complete tag/step -> starter list appears
- inside prose -> suppressed
- inside tag body -> suppressed
- inside step body -> suppressed
- plain req body -> suppressed

This is the pattern to use whenever the same AST region contains both:

- structured starter positions
- and arbitrary free text

## Concrete design patterns

### Typed-prefix narrowing

Pattern:

1. detect typed identifier in `completionAnalysis.ts`
2. route to a dedicated scalar scope
3. early-return symbol-only items in `completionBuilder.ts`

Examples already implemented:

- `association_typed_prefix`
- `isa_typed_prefix`
- `decl_type_typed_prefix`
- `return_type_typed_prefix`

### Partial association completion

Association completion has multiple different slots:

1. left-multiplicity -> arrow operator slot
2. after arrow -> right multiplicity slot
3. after right multiplicity -> type slot
4. typed right-type prefix -> filtered type slot

Do not collapse those into one generic association scope.

### Structured req body completion

Req bodies are mixed-mode:

- some positions are structured starters
- some positions are arbitrary prose
- tag bodies are opaque text

So the correct model is:

- broad req-body query stays suppressed
- analyzer opts in only at safe starter positions

## Raw lookahead rule

Usually raw `LookaheadIterator` output is not what the user should see.

It is acceptable only if:

- the slot is still generic
- there is no clean scoped model yet
- and silence would be worse

Bad examples from bugs we already fixed:

- `1 -> * O|` showing `ERROR`, `namespace`, `Java`
- `isA P|` showing class-body junk
- `sorted { | }` showing raw keywords instead of attributes

## Testing checklist

Every completion topic should answer these.

### Slot behavior

- correct scope kind?
- correct includes?
- correct excludes?
- no `ERROR`?
- no raw junk from unrelated scopes?

### Boundary behavior

- negative nearby slots pinned?
- no scope bleed into unrelated syntax?

Examples of good negative boundaries:

- `isA T<sm|` must not become `isa_typed_prefix`
- prose inside req bodies must stay suppressed
- state-machine `e -> |` must not become association completion
- method-name slot must not become return-type completion

## Typical assertions

Use the existing helpers in `packages/server/test/semantic.test.ts`.

Common ones:

- `parse_clean`
- `completion_kinds`
- `completion_includes`
- `completion_excludes`
- `hover_output` when the feature also affects hover

Minimal example:

```ts
{
  name: "NN feature_name",
  fixtures: ["NN_feature_name.ump"],
  assertions: [
    { type: "parse_clean", fixture: "NN_feature_name.ump" },
    { type: "completion_kinds", at: "main_slot", expect: "association_typed_prefix" },
    { type: "completion_includes", at: "main_slot", expect: ["Order", "OtherClass"] },
    { type: "completion_excludes", at: "main_slot", expect: ["ERROR", "namespace", "class"] },
  ],
}
```

Then add a real negative assertion for a nearby marker.

## Common mistakes

### Letting broad query captures win

Example:

- broad:
  - `(association_inline) @scope.class_interface_trait`
- needed narrower capture:
  - `(association_inline right_type: (identifier) @scope.association_typed_prefix)`

### Overusing `ERROR` fallback

Bad:

- "there is an `isA` token somewhere earlier in this giant `ERROR`, so this must be an isa typed-prefix slot"

Better:

- gate on immediate `prevLeaf`
- gate on field name or local parent type
- add explicit negative regressions nearby

### Sending scalar user-facing scopes through the generic fallback

If a new scalar scope is supposed to be symbol-only or curated, it probably should early-return above `buildLookaheadFallbackItems(...)`.

## Current reusable helpers

- `packages/server/src/completionAnalysis.ts:71`
  - `isLetterLeadingIdentifier(...)`
- `packages/server/src/completionAnalysis.ts:83`
  - `isInsideTypeNameFieldSlot(...)`
- `packages/server/src/completionBuilder.ts:289`
  - `appendSymbolsOfKinds(...)`
- `packages/server/src/completionBuilder.ts:340`
  - `buildTypeCompletionItems(...)`
- `packages/server/src/completionBuilder.ts:838`
  - `buildLookaheadFallbackItems(...)`

Use them before adding another one-off branch.

## When to stop and split the topic

Split if a patch is trying to do more than one of:

- new grammar
- new symbol extraction
- completion redesign
- hover / rename / refs changes
- highlighting

Good sequence:

1. grammar parses
2. symbols / refs work
3. completion becomes good

That keeps the review surface small and the failures understandable.
