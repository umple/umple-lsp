# Example 03 — Completion feature end-to-end

Use this pattern when a completion slot should stop leaking raw parser tokens and instead show the right user-facing items.

This example mirrors the shipped `association_typed_prefix` fix.

## Goal

Given:

```umple
class Other {}
class Order {
  1 -> * O|
}
```

We want completion at `O|` to show only type symbols like:

- `Other`

And we do **not** want junk like:

- `ERROR`
- `namespace`
- `Java`
- `class`

## Files to touch

Touch:

- `packages/tree-sitter-umple/queries/completions.scm`
- `packages/server/src/completionAnalysis.ts`
- `packages/server/src/completionBuilder.ts`
- tests / fixtures in `packages/server/test/`

Usually do **not** touch for this type of fix:

- `grammar.js`
- `definitions.scm`
- `references.scm`
- `symbolIndex.ts`

unless syntax or symbol extraction is also broken.

## Step 1 — Decide whether query or analyzer should own it

For `association_typed_prefix`, the query can identify the slot exactly, because the cursor is on a named child:

- `right_type: (identifier)`

So this is a **query-driven typed-prefix** case, not an analyzer-only recovery case.

## Step 2 — Add the narrow query capture

File:

- `packages/tree-sitter-umple/queries/completions.scm`

Pattern:

```scm
(association_inline right_type: (identifier) @scope.association_typed_prefix)
(association_member right_type: (identifier) @scope.association_typed_prefix)
```

Why this matters:

- the narrow identifier capture beats the broader enclosing association capture
- the slot gets its own user-facing meaning

## Step 3 — Normalize the scalar scope in the analyzer

File:

- `packages/server/src/completionAnalysis.ts`

Pattern:

```ts
if (kindStr === "association_typed_prefix") return "association_typed_prefix";
```

This keeps the builder on a dedicated scalar path instead of the generic array fallback.

## Step 4 — Add the symbol-only builder early return

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

Why this is the real fix:

- it bypasses `buildLookaheadFallbackItems(...)`
- only symbols are shown
- raw parser lookahead never reaches the user in this slot

## Step 5 — Add focused tests

Relevant fixture in this repo:

- `packages/server/test/fixtures/semantic/130b_assoc_partial_slots.ump`

What to pin:

1. correct slot kind
2. expected symbols included
3. junk excluded
4. nearby association slots still behave correctly
5. unrelated syntax stays unaffected

Typical assertions:

```ts
{ type: "completion_kinds", at: "assoc_typed_prefix", expect: "association_typed_prefix" }
{ type: "completion_includes", at: "assoc_typed_prefix", expect: ["Other"] }
{ type: "completion_excludes", at: "assoc_typed_prefix", expect: ["ERROR", "namespace", "Java", "class"] }
```

## Step 6 — Add a negative boundary

Completion regressions in this repo usually come from scope bleed.

So add at least one nearby negative proving you did **not** break a neighboring slot.

Examples for this family:

- blank right-type slot still behaves correctly
- state-machine `e -> |` must not become association completion

## When this pattern is not enough

If the query cannot distinguish the slot safely, do **not** force it.

Use the analyzer instead.

The shipped req-body starter logic is the counterexample:

- broad req body stays suppressed in `completions.scm`
- `completionAnalysis.ts` opts in only at real starter slots using local context like `prevLeaf`

## Copyable checklist

- decide query-driven vs analyzer-driven
- add the narrowest possible scope
- normalize the scalar scope in the analyzer
- early-return curated or symbol-only items in the builder
- add includes, excludes, and at least one negative boundary test
- keep raw lookahead out of the user-facing slot
