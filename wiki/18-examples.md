# 18 — Example patterns

This page is the index for small, copyable end-to-end examples.

Use these when the playbooks are too abstract and you want to see a concrete feature shape from this repo.

## Examples

1. [Parse-only grammar expansion](examples/01-parse-only-grammar-expansion.md)
   - based on `implementsReq` grammar expansion into new bodies
   - shows how to change grammar without mixing in semantic work

2. [Symbol feature end-to-end](examples/02-symbol-feature-end-to-end.md)
   - based on `requirement` / `implementsReq`
   - covers definitions, references, goto-def, refs, rename, hover, and outline

3. [Completion feature end-to-end](examples/03-completion-feature-end-to-end.md)
   - based on `association_typed_prefix`
   - shows query capture, analyzer routing, builder early-return, and tests

## How to use these

- Start with [14-feature-work-playbook.md](14-feature-work-playbook.md) to classify the work.
- Then use the matching example here as a template.
- Prefer copying the shape of the change, not the exact names.

## What these examples are for

They are meant to answer:

- which files should I touch?
- which files should I leave alone?
- what is the minimum safe test set?
- what does a good small topic look like?
