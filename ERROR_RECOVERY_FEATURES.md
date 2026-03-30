# Error Recovery Features

What the LSP server provides when `.ump` files have parse errors.

## Cold-Open Recovery (V1)

When a file with parse errors is opened for the first time (no prior clean snapshot), the server extracts high-confidence symbols instead of giving nothing.

### What's recovered

| Symbol kind | Recovered? | Notes |
|-------------|:----------:|-------|
| Class | Yes | Always reliable |
| Interface | Yes | Always reliable |
| Trait | Yes | Always reliable |
| Enum | Yes | Always reliable |
| Attribute | Yes | Skipped if definition node has errors |
| Const | Yes | Skipped if definition node has errors |
| Method | Yes | Must have valid name + params; ERROR allowed before name (modifiers/return type) but not after name |
| Statemachine | Yes (V2a) | Must have at least one state in body; empty-body SMs rejected |
| State | Not yet | Planned for V2b |
| Association | No | — |

### What works with recovered symbols

| Feature | Status | Notes |
|---------|--------|-------|
| Document outline | Works | Shows recovered classes, methods, SMs |
| Hover | Works | Shows symbol info + warning: "This file has parse errors — symbol info may be incomplete." |
| Go-to-definition | Works | Resolves recovered class/trait/interface names |
| Code completion | Unchanged | Already has its own error-context fallbacks |
| Find references | Works | Best-effort with recovered symbols |
| Formatting | Unchanged | Formats what it can |
| Rename | Blocked | Shows warning: "Cannot rename: this file has parse errors." |

### Recovery warning

A once-per-document notification is shown when a file with errors is opened:

> "Some IDE features may be limited — this file has syntax errors. Diagnostics are still available."

The warning clears when the file parses clean and re-shows if errors return.

## ERROR-Node Token Fallback

When the cursor is on an identifier inside an ERROR node (tree-sitter couldn't match the surrounding syntax), goto-def and hover still work for top-level symbols.

**Example:** In `class Panel { GARBAGE Widget STUFF }`, hovering on `Widget` resolves to `class Widget` even though it's inside an ERROR node.

Only resolves top-level kinds (class, interface, trait, enum) to avoid false positives with local attribute/method names.

## Method Recovery Detail

Methods are recovered when their declaration header is structurally valid:

```umple
class Calculator {
  void add(Integer a, Integer b) { return a + b; }     // Recovered
  BROKEN GARBAGE HERE                                    // Ignored
  void multiply(Integer x, Integer y) { return x * y; } // Recovered (ERROR in return-type area tolerated)
}
```

The confidence check:
1. Node type is `method_declaration`
2. Name field exists and is an identifier
3. Node itself is not an ERROR node
4. No ERROR child between the name and the body opener `{`
5. ERROR before the name (modifiers/return type) is allowed

## Statemachine Recovery Detail (V2a)

State machines are recovered when structurally intact:

```umple
class GarageDoor {
  status {                    // Recovered — has states in body
    Open { close -> Closed; }
    Closed { open -> Open; }
  }
  BROKEN GARBAGE HERE
}
```

The confidence check:
1. Node type is `state_machine` or `statemachine_definition`
2. Name field exists and is an identifier
3. Not an ERROR node
4. For class-local SMs: enclosing class must be resolvable
5. Body must contain at least one SM-content child (state, standalone_transition, etc.)

Empty-body SMs are rejected — these are often misparsed class definitions (e.g., `class B {}` becoming `state_machine [B]` inside a broken class).

## Live-Edit Behavior

When a file that previously parsed clean gets broken during editing:
- Symbols from the clean snapshot are preserved (not marked as recovered)
- States and state machines from the clean snapshot are kept
- The recovery path only applies on cold-open (no prior snapshot)

## What's Not Recovered Yet

- **States** — planned for V2b (depth-1 only)
- **Nested states** — path ambiguity too high under errors
- **Associations** — identity depends on both endpoints
- **Referenced statemachine bindings** — depends on correct class context

## Version History

| Version | What was added |
|---------|----------------|
| V1 | Cold-open recovery for class, interface, trait, enum, attribute, const. Rename blocked on recovered. Recovery warning. |
| V1 + method | Method recovery with header confidence check |
| V1.5 | Hover note on recovered symbols. Recovery lifecycle test. |
| V1.5 + ERROR fallback | Goto-def/hover on identifiers inside ERROR nodes (top-level kinds only) |
| V1.5 + method refinement | Relaxed method check — ERROR before name allowed |
| V2a | Statemachine recovery with non-empty-body gate |
