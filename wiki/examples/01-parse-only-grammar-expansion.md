# Example 01 — Parse-only grammar expansion

Use this pattern when the syntax itself is missing, but you do **not** want to mix in semantic or completion work yet.

This example mirrors the shipped `implementsReq` grammar expansion into new contexts.

## Goal

Before the change, `implementsReq` parsed in some places but not others.

We wanted to allow it in additional bodies such as:

- top-level `statemachine_definition`
- state bodies
- `association { ... }` blocks
- class-local statemachine bodies

But this phase was intentionally **parse-only**:

- no new indexing
- no new refs logic
- no new completion changes

## Files to touch

Touch:

- `packages/tree-sitter-umple/grammar.js`
- tests / fixtures in `packages/server/test/`

Usually do **not** touch in this phase:

- `definitions.scm`
- `references.scm`
- `completionAnalysis.ts`
- `completionBuilder.ts`
- `symbolIndex.ts`

## Step 1 — Confirm compiler acceptance

Before editing the grammar, confirm the compiler accepts the syntax.

For this kind of change, that means verifying the target construct is valid Umple and identifying the exact parent rules where it belongs.

## Step 2 — Change only the local grammar parents

Do **not** widen large parent rules casually.

For `implementsReq`, the safe shape was:

- add it only to the specific target body rules
- keep the change local
- avoid broad “allow this almost everywhere” edits

That keeps regressions narrow and reviewable.

## Step 3 — Rebuild

Run:

```bash
npm run compile
```

This regenerates the parser and copies the wasm/query files into the server package.

## Step 4 — Add parse-focused tests only

For a parse-only phase, the tests should prove:

- the new placements parse cleanly
- older valid placements still parse cleanly
- no unrelated semantic behavior was changed in the same patch

Typical assertions:

- `parse_clean`
- maybe targeted semantic assertions only to prove nothing regressed accidentally

## Step 5 — Stop here if semantics are a separate topic

If the feature still needs:

- goto-def
- refs
- rename
- completion

open the next topic **after** the grammar patch lands.

That split was the right decision for `implementsReq`.

## Why this split is good

Because parser work and semantic work fail in different ways:

- grammar bugs create parse-tree shape problems
- semantic bugs create wrong definitions/refs/hover/rename/completion

Separating them makes review much safer.

## Copyable checklist

- confirm compiler syntax
- update only the exact grammar parent rules
- run `npm run compile`
- add parse-focused fixtures/assertions
- do not mix in semantic or completion work unless truly necessary
