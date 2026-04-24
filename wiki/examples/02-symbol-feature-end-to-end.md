# Example 02 — Symbol feature end-to-end

Use this pattern when a construct must support:

- definitions
- references
- goto-def
- find-refs
- rename
- hover
- outline / document symbols

This example mirrors the shipped `requirement` / `implementsReq` behavior.

## Goal

Given:

```umple
req HighLevel userStory {
  who { salesPerson }
}

class Order {
  implementsReq HighLevel;
}
```

We want all of these to work:

- `HighLevel` defines a requirement symbol
- `implementsReq HighLevel` resolves to it
- goto-def works from the use site
- refs include declaration + use sites
- rename updates declaration and uses
- hover shows requirement metadata
- outline shows the requirement as a document symbol

## Files to touch

Touch:

- `packages/tree-sitter-umple/queries/definitions.scm`
- `packages/tree-sitter-umple/queries/references.scm`
- `packages/server/src/tokenTypes.ts`
- `packages/server/src/symbolTypes.ts` if metadata is needed
- `packages/server/src/symbolIndex.ts`
- `packages/server/src/hoverBuilder.ts`
- `packages/server/src/documentSymbolBuilder.ts`
- `packages/server/src/renameValidation.ts` if rename rules differ by kind
- tests / fixtures in `packages/server/test/`

Usually do **not** touch for this kind of work:

- `completionAnalysis.ts`
- `completionBuilder.ts`

unless completion is also part of the topic.

## Step 1 — Add the definition capture

File:

- `packages/tree-sitter-umple/queries/definitions.scm`

Existing requirement pattern:

```scm
(requirement_definition name: (identifier) @definition.requirement)
(requirement_definition name: (req_id) @definition.requirement)
```

Rule:

- capture the real name node
- not the whole parent construct

## Step 2 — Add the reference captures

File:

- `packages/tree-sitter-umple/queries/references.scm`

Existing requirement pattern:

```scm
(requirement_definition name: (identifier) @reference.requirement)
(requirement_definition name: (req_id) @reference.requirement)
(req_implementation (identifier) @reference.requirement)
(req_implementation (req_id) @reference.requirement)
```

This gives the resolver a narrow allowed kind set.

## Step 3 — Ensure the symbol kind exists

File:

- `packages/server/src/tokenTypes.ts`

Requirement already exists there as:

- `requirement`

For a new kind, add it once to `SymbolKind` and only then wire the rest.

## Step 4 — Index the symbol and metadata

File:

- `packages/server/src/symbolIndex.ts`

For requirements, the index stores metadata like:

- `reqLanguage`
- `reqWho`
- `reqWhen`
- `reqWhat`
- `reqWhy`

Rule:

- index one symbol entry per real definition
- store only metadata you actually need for hover/outline
- ignore incomplete constructs if they are parser-tolerant but not semantically complete

## Step 5 — Hover

File:

- `packages/server/src/hoverBuilder.ts`

Requirement hover already follows the right pattern:

- short header
- only semantically complete metadata
- no fake data from incomplete syntax

Typical assertion:

```ts
{ type: "hover_output", at: "def_high", expectContains: ["req HighLevel userStory", "**Who:** salesPerson"] }
```

## Step 6 — Outline / document symbols

File:

- `packages/server/src/documentSymbolBuilder.ts`

Requirement outline support depends on:

- correct `SymbolKind` mapping
- real definition ranges on the indexed symbol

Typical assertion:

```ts
{ type: "document_symbols", fixture: "NN_feature.ump", expectRoots: ["HighLevel"], expectChild: { parent: "HighLevel", child: "1" } }
```

## Step 7 — Rename

Files:

- `packages/server/src/renameValidation.ts`
- `packages/server/src/server.ts`

Requirement rename needed kind-aware validation because req ids are broader than plain identifiers.

Existing pattern:

- `requirement` is in `RENAMEABLE_KINDS`
- `isValidNewName(...)` uses the req-id regex for requirements

Typical assertions:

```ts
{ type: "rename_edits", at: "def_high", newName: "HigherLevel", expectAt: ["def_high", "use_high"], expectCount: 2 }
{ type: "rename_rejected", at: "def_high", newName: "-bad-name", reason: "invalid-name" }
```

## Step 8 — Goto-def and refs

Typical assertions:

```ts
{ type: "goto_def", at: "use_high", expect: [{ at: "def_high" }] }
{ type: "refs", at: "def_high", expect: ["def_high", "use_high"] }
```

The important thing is not just that refs work, but that they stay bounded and do not leak to neighboring names.

## Minimum complete test set

For this kind of topic, include all of:

- `parse_clean`
- `symbol_count`
- `goto_def`
- `refs`
- `hover_output`
- `document_symbols`
- `rename_edits`
- `rename_rejected`

## Copyable checklist

- add exact definition capture
- add exact reference capture
- add/update symbol kind
- index symbol and any needed metadata
- add hover support if the symbol should display metadata
- add outline support if it should appear in document symbols
- enable rename only after refs are trustworthy
- add full semantic assertions
