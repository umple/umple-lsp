# 14 — Feature work playbook

This page is the **overall workflow** for grammar- and LSP-feature work.

Do not treat it as the only page you need. Use it to decide which more specific page to read next.

## Start here: classify the change

Before editing code, decide what kind of change you are making.

### 1. Syntax-only change

Examples:

- a new keyword parses
- a statement becomes less strict
- highlighting for a newly parsed keyword

Read:

- [04-grammar.md](04-grammar.md)
- [12-gotchas.md](12-gotchas.md)

### 2. Definition / reference / rename / hover / outline change

Examples:

- a new construct defines a symbol
- a new identifier position should support goto-def
- rename should start working for a new symbol kind

Read:

- [15-symbol-features-playbook.md](15-symbol-features-playbook.md)
- [04-grammar.md](04-grammar.md) if syntax also changes

### 3. Completion change

Examples:

- new curated body starters
- new typed-prefix narrowing
- symbol-only slot completion
- removal of raw keyword leakage

Read:

- [16-completion-playbook.md](16-completion-playbook.md)
- [04-grammar.md](04-grammar.md) if syntax also changes

### 4. Mixed feature

Examples:

- structured req bodies
- `implementsReq` support in new contexts
- a new declaration that also needs completion and rename

Use this order:

1. parser / grammar
2. definitions / references / indexing
3. completion
4. rename / hover / outline polish

That split is slower, but it is safer and easier to review.

## Safe workflow

Use this order unless there is a strong reason not to.

1. verify the syntax against the compiler / official grammar
2. decide which layer is actually wrong:
   - grammar
   - queries
   - symbol indexing
   - completion routing
   - rename / refs / hover
3. change the smallest layer that can fix the problem
4. add focused fixtures and assertions
5. run:

```bash
npm run compile
npm test -w packages/server
```

6. only after that, smoke-test in an editor

## The key architectural rule

Do not solve every problem in one file.

This repo has separate layers for a reason:

- `grammar.js` decides syntax
- `definitions.scm` and `references.scm` decide semantic positions
- `completions.scm` + `completionAnalysis.ts` + `completionBuilder.ts` decide completion
- `symbolIndex.ts` decides extracted semantic data

If the bug is really a completion bug, do not widen the grammar.

If the bug is really a reference-position bug, do not add completion hacks.

## How to split work safely

Split into multiple topics if a patch is doing more than one of these:

- grammar expansion
- new symbol extraction
- new reference support
- completion redesign
- rename / hover / outline changes
- highlighting changes

Good split:

1. grammar parses
2. symbol extraction / refs work
3. completion becomes good
4. rename / hover polish lands after that

## Minimum test bar

Every feature topic should answer the relevant items below.

### Parse

- happy path parses cleanly
- incomplete path recovers acceptably

### Semantic features

- symbol extracted exactly once
- goto-def works
- refs stay bounded
- rename works or is intentionally not supported

### Completion

- correct slot kind
- correct includes
- correct excludes
- no `ERROR`
- no raw junk from unrelated scopes
- negative boundary cases pinned

## Current page map

- grammar mechanics: [04-grammar.md](04-grammar.md)
- defs / refs / rename / hover / outline: [15-symbol-features-playbook.md](15-symbol-features-playbook.md)
- completion design and troubleshooting: [16-completion-playbook.md](16-completion-playbook.md)
- compact agent checklists: [17-agent-implementation-checklists.md](17-agent-implementation-checklists.md)
- copyable example patterns: [18-examples.md](18-examples.md)
- common pitfalls: [12-gotchas.md](12-gotchas.md)
- remaining backlog: [13-roadmap.md](13-roadmap.md)

## If you are inheriting the project cold

Read in this order:

1. [03-development.md](03-development.md)
2. [04-grammar.md](04-grammar.md)
3. this page
4. [15-symbol-features-playbook.md](15-symbol-features-playbook.md)
5. [16-completion-playbook.md](16-completion-playbook.md)
6. [17-agent-implementation-checklists.md](17-agent-implementation-checklists.md)
7. [18-examples.md](18-examples.md)
8. [12-gotchas.md](12-gotchas.md)
9. [13-roadmap.md](13-roadmap.md)
