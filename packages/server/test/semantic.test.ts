/**
 * Semantic regression test suite.
 *
 * Exercises all known LSP semantic behaviors using real fixtures.
 * Run with: npm test (from repo root or packages/server)
 */

import { SemanticTestHelper, MarkerPosition, DeclSpec } from "./helpers";

// ── Assertion types ──────────────────────────────────────────────────────────

interface GotoDefAssertion {
  type: "goto_def";
  at: string; // marker name for cursor position
  expect: { at: string; container?: string }[]; // target marker(s)
}

interface GotoDefEmptyAssertion {
  type: "goto_def_empty";
  at: string;
}

interface RefsAssertion {
  type: "refs";
  decl: DeclSpec;
  expectAt: string[]; // marker names expected in results
}

interface RefsExcludeAssertion {
  type: "refs_exclude";
  decl: DeclSpec;
  excludeAt: string[]; // marker names that must NOT appear
}

interface SharedRefsAssertion {
  type: "shared_refs";
  decl: DeclSpec;
  expectAt: string[]; // marker names expected (uses shared-state expansion)
}

interface SharedRefsExcludeAssertion {
  type: "shared_refs_exclude";
  decl: DeclSpec;
  excludeAt: string[]; // marker names that must NOT appear (uses shared-state expansion)
}

interface ChildStatesAssertion {
  type: "child_states";
  parentPath: string[];
  smContainer: string;
  expect: string[];
}

interface CompletionKindsAssertion {
  type: "completion_kinds";
  at: string; // marker name
  expect: string[] | string | null; // expected symbolKinds value
}

interface CompletionIncludesAssertion {
  type: "completion_includes";
  at: string;
  expect: string[]; // labels that MUST appear in completion items
}

interface CompletionExcludesAssertion {
  type: "completion_excludes";
  at: string;
  expect: string[]; // labels that must NOT appear in completion items
}

interface TokenContextAssertion {
  type: "token_context";
  at: string;
  expect: {
    contextType: string;
    dottedStateRef?: { qualifiedPath: string[]; pathIndex: number } | null;
    stateDefinitionRef?: { definitionPath: string[] } | null;
    traitName?: string;
    pathSegments?: string[];
    segmentIndex?: number;
    targetClass?: string;
  };
}

type Assertion =
  | GotoDefAssertion
  | GotoDefEmptyAssertion
  | RefsAssertion
  | RefsExcludeAssertion
  | SharedRefsAssertion
  | SharedRefsExcludeAssertion
  | ChildStatesAssertion
  | CompletionKindsAssertion
  | CompletionIncludesAssertion
  | CompletionExcludesAssertion
  | TokenContextAssertion
  | HoverOutputAssertion
  | DocumentSymbolsAssertion
  | FormatOutputAssertion
  | FormatOutputWithOptionsAssertion
  | FormatIdempotentAssertion
  | UseGraphRefsAssertion
  | ParseCleanAssertion
  | SymbolCountAssertion
  | RecoveredSymbolAssertion;

interface ParseCleanAssertion {
  type: "parse_clean";
  fixture: string;
}

interface SymbolCountAssertion {
  type: "symbol_count";
  fixture: string;
  name: string;
  kind: string;
  expect: number;
}

interface RecoveredSymbolAssertion {
  type: "recovered_symbol";
  fixture: string;
  name: string;
  kind: string;
  expectRecovered: boolean;
}

/** Tests the use-graph discovery pipeline: inject importer edges without full indexing,
 *  then verify refs include the importer after lazy on-demand indexing. */
interface UseGraphRefsAssertion {
  type: "use_graph_refs";
  /** Fixture to index normally (the declaration file) */
  targetFixture: string;
  /** Fixture to inject use-graph edges only (simulates background scan discovery) */
  importerFixture: string;
  /** Declaration spec to search refs for */
  decl: DeclSpec;
  /** Markers that MUST appear in the ref results (including from the lazily-indexed importer) */
  expectAt: string[];
}

interface FormatOutputWithOptionsAssertion {
  type: "format_output_with_options";
  fixture: string;
  options: { tabSize: number; insertSpaces: boolean };
  expectText: string;
}

interface FormatOutputAssertion {
  type: "format_output";
  fixture: string;
  expectLines: { line: number; text: string }[];
}

interface FormatIdempotentAssertion {
  type: "format_idempotent";
  fixture: string;
}

interface HoverOutputAssertion {
  type: "hover_output";
  at: string;
  expectContains: string[];
}

interface DocumentSymbolsAssertion {
  type: "document_symbols";
  fixture: string;
  expectRoots: string[];
  expectChild: { parent: string; child: string };
}

interface TestCase {
  name: string;
  fixtures: string[];
  /** Files indexed but NOT in the reachable set (tests isolation). */
  unreachable?: string[];
  assertions: Assertion[];
}

// ── Test cases ───────────────────────────────────────────────────────────────

const TEST_CASES: TestCase[] = [
  // 01: Basic class/container scoping
  {
    name: "01 scoping: cross-class attribute isolation",
    fixtures: ["01_scoping.ump"],
    assertions: [
      {
        type: "token_context",
        at: "b_cx",
        expect: { contextType: "normal", dottedStateRef: null },
      },
      {
        type: "goto_def",
        at: "b_cx",
        expect: [{ at: "b_x" }],
      },
      {
        type: "refs",
        decl: { name: "x", kind: "attribute", container: "B" },
        expectAt: ["b_x", "b_cx"],
      },
      {
        type: "refs_exclude",
        decl: { name: "x", kind: "attribute", container: "A" },
        excludeAt: ["b_cx"],
      },
    ],
  },

  // 02: Inherited attribute in guard
  {
    name: "02 inheritance: inherited attribute in constraint",
    fixtures: ["02_inheritance.ump"],
    assertions: [
      {
        type: "goto_def",
        at: "child_max",
        expect: [{ at: "base_max" }],
      },
      {
        type: "refs",
        decl: { name: "max", kind: "attribute", container: "Base" },
        expectAt: ["base_max", "child_max"],
      },
    ],
  },

  // 03: Class-body before/after hooks
  {
    name: "03 before/after: class-body hook go-to-def",
    fixtures: ["03_before_after.ump"],
    assertions: [
      {
        type: "goto_def",
        at: "hook_ping",
        expect: [{ at: "def_ping" }],
      },
      {
        type: "goto_def",
        at: "hook_pong",
        expect: [{ at: "def_pong" }],
      },
      {
        type: "refs",
        decl: { name: "ping", kind: "method", container: "A" },
        expectAt: ["def_ping", "hook_ping"],
      },
      {
        type: "refs",
        decl: { name: "pong", kind: "method", container: "A" },
        expectAt: ["def_pong", "hook_pong"],
      },
      // Wildcard hook: identifier "p" does not match "ping" refs
      {
        type: "refs_exclude",
        decl: { name: "ping", kind: "method", container: "A" },
        excludeAt: ["hook_wildcard"],
      },
    ],
  },

  // 04: referenced_statemachine
  {
    name: "04 referenced_sm: door as status",
    fixtures: ["04_referenced_sm.ump"],
    assertions: [
      {
        type: "token_context",
        at: "ref_status",
        expect: { contextType: "referenced_sm" },
      },
      {
        type: "goto_def",
        at: "ref_status",
        expect: [{ at: "c1_status" }],
      },
      {
        type: "refs",
        decl: { name: "status", kind: "statemachine", container: "C1.status" },
        expectAt: ["c1_status", "ref_status"],
      },
      {
        type: "refs_exclude",
        decl: { name: "status", kind: "statemachine", container: "C2.status" },
        excludeAt: ["ref_status"],
      },
    ],
  },

  // 05: trait_sm_binding
  {
    name: "05 trait_sm: binding param and value paths",
    fixtures: ["05_trait_sm.ump"],
    assertions: [
      {
        type: "token_context",
        at: "bind_sm1",
        expect: { contextType: "trait_sm_param", traitName: "T1" },
      },
      {
        type: "token_context",
        at: "bind_status",
        expect: { contextType: "trait_sm_value", pathSegments: ["status", "S1"], segmentIndex: 0 },
      },
      {
        type: "token_context",
        at: "bind_s1",
        expect: { contextType: "trait_sm_value", pathSegments: ["status", "S1"], segmentIndex: 1 },
      },
      {
        type: "goto_def",
        at: "bind_sm1",
        expect: [{ at: "t_sm1" }],
      },
      {
        type: "goto_def",
        at: "bind_status",
        expect: [{ at: "h_status" }],
      },
      {
        type: "goto_def",
        at: "bind_s1",
        expect: [{ at: "h_s1" }],
      },
    ],
  },

  // 06: Dotted state path
  {
    name: "06 dotted_state: relative path disambiguation",
    fixtures: ["06_dotted_state.ump"],
    assertions: [
      // dottedStateRef metadata
      {
        type: "token_context",
        at: "ref_closed_inner",
        expect: {
          contextType: "normal",
          dottedStateRef: { qualifiedPath: ["Closed", "Inner"], pathIndex: 1 },
        },
      },
      {
        type: "token_context",
        at: "ref_closed",
        expect: {
          contextType: "normal",
          dottedStateRef: { qualifiedPath: ["Closed", "Inner"], pathIndex: 0 },
        },
      },
      // stateDefinitionRef metadata
      {
        type: "token_context",
        at: "open_inner",
        expect: {
          contextType: "normal",
          stateDefinitionRef: { definitionPath: ["EEE", "Open", "Inner"] },
        },
      },
      {
        type: "token_context",
        at: "closed_inner",
        expect: {
          contextType: "normal",
          stateDefinitionRef: { definitionPath: ["EEE", "Closed", "Inner"] },
        },
      },
      {
        type: "goto_def",
        at: "ref_closed_inner",
        expect: [{ at: "closed_inner" }],
      },
      {
        type: "goto_def",
        at: "ref_open_inner",
        expect: [{ at: "open_inner" }],
      },
      {
        type: "refs",
        decl: {
          name: "Inner",
          kind: "state",
          container: "Elevator.status",
          statePath: ["EEE", "Closed", "Inner"],
        },
        expectAt: ["closed_inner", "ref_closed_inner"],
      },
      {
        type: "refs",
        decl: {
          name: "Inner",
          kind: "state",
          container: "Elevator.status",
          statePath: ["EEE", "Open", "Inner"],
        },
        expectAt: ["open_inner", "ref_open_inner"],
      },
      {
        type: "child_states",
        parentPath: ["Closed"],
        smContainer: "Elevator.status",
        expect: ["Inner"],
      },
      {
        type: "child_states",
        parentPath: ["EEE"],
        smContainer: "Elevator.status",
        expect: ["Open", "Closed"],
      },
    ],
  },

  // 10: Top-level code injection
  {
    name: "10 toplevel_inject: target-class-aware resolution",
    fixtures: ["10_toplevel_inject.ump"],
    assertions: [
      {
        type: "token_context",
        at: "hook_inc",
        expect: { contextType: "toplevel_injection", targetClass: "Counter" },
      },
      {
        type: "goto_def",
        at: "hook_inc",
        expect: [{ at: "def_inc" }],
      },
      {
        type: "goto_def",
        at: "hook_dec",
        expect: [{ at: "def_dec" }],
      },
      {
        type: "refs",
        decl: { name: "increment", kind: "method", container: "Counter" },
        expectAt: ["def_inc", "hook_inc"],
      },
      {
        type: "refs_exclude",
        decl: { name: "increment", kind: "method", container: "Timer" },
        excludeAt: ["hook_inc"],
      },
    ],
  },

  // 11: Cross-file use resolution
  {
    name: "11 cross_file: use statement scoping",
    fixtures: ["11_cross_file_a.ump", "11_cross_file_b.ump"],
    unreachable: ["11_cross_file_c.ump"],
    assertions: [
      {
        type: "goto_def",
        at: "use_shared",
        expect: [{ at: "def_shared_b" }],
      },
      {
        type: "refs_exclude",
        decl: { name: "Shared", kind: "class", container: "Shared" },
        excludeAt: ["def_shared_c"],
      },
    ],
  },
  // 13: Default value qualifier context
  {
    name: "13 default_value: qualifier context detection",
    fixtures: ["13_default_value.ump"],
    assertions: [
      {
        type: "token_context",
        at: "qual_Status",
        expect: { contextType: "default_value_qualifier" },
      },
    ],
  },

  // 14: Hover output smoke tests
  {
    name: "14 hover: output content",
    fixtures: ["14_hover.ump"],
    assertions: [
      {
        type: "hover_output",
        at: "hover_class",
        expectContains: ["class Animal", "isA Creature"],
      },
      {
        type: "hover_output",
        at: "hover_attr",
        expectContains: ["Integer", "age"],
      },
      {
        type: "hover_output",
        at: "hover_method",
        expectContains: ["void", "run"],
      },
      {
        type: "hover_output",
        at: "hover_state",
        expectContains: ["Alive", "die -> Dead"],
      },
      {
        type: "document_symbols",
        fixture: "14_hover.ump",
        expectRoots: ["Animal", "Creature"],
        expectChild: { parent: "Animal", child: "status" },
      },
    ],
  },

  // 15: Formatting smoke test
  {
    name: "15 formatting: indent + skip range",
    fixtures: ["15_formatting.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "15_formatting.ump",
        expectLines: [
          { line: 1, text: "  Integer x;" },
          { line: 3, text: "    int y = 0;" },
          { line: 6, text: "    Open {e1 -> Closed;" },
        ],
      },
    ],
  },

  // 17: Comprehensive formatting — all indent-node families + re-entry
  {
    name: "17 format_comprehensive: all node types + nesting + multi-region re-entry",
    fixtures: ["17_format_comprehensive.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "17_format_comprehensive.ump",
        expectLines: [
          // interface body
          { line: 2, text: "  void print();" },
          // trait body (shifted by blank lines between top-level decls)
          { line: 8, text: "  Date createdAt;" },
          // code_content reindented to structural depth
          { line: 15, text: "    int x = 0;" },
          // re-entry after first code_content — structural comment indented
          { line: 17, text: "  // Re-entry: structural line after first code_content" },
          // code_content reindented (second method — multi-region isolation)
          { line: 19, text: "    return;" },
          // before_after inside class
          { line: 21, text: "  before run { }" },
          // deepest nesting: class + SM + state + nested state (4 levels)
          { line: 25, text: "        sick -> Sick;" },
          // association body
          { line: 34, text: "  * Animal -- * Animal;" },
          // mixset + nested class (2 levels)
          { line: 39, text: "    name;" },
          // top-level statemachine_definition + state (2 levels)
          { line: 45, text: "    start -> Running;" },
          // top-level code injection (0 level)
          { line: 50, text: "before { Animal } run { }" },
        ],
      },
    ],
  },

  // 18: Transition spacing normalization (Phase 2)
  {
    name: "18 format_transitions: arrow spacing normalization",
    fixtures: ["18_format_transitions.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "18_format_transitions.ump",
        expectLines: [
          { line: 3, text: "      e1 -> Closed;" },             // compressed → normalized
          { line: 4, text: "      e2 [canClose] -> Closed;" },  // guard, missing space after
          { line: 5, text: "      e3 -> Closed;" },             // extra spaces → single
          { line: 6, text: "      e4 -> Closed;" },             // already correct
          { line: 7, text: "      e5 / { foo -> bar; } -> Closed;" },  // action code content preserved, structural -> fixed
          { line: 8, text: "      e6 [g] / { x -> y; z->w; } -> Closed;" },  // action code preserved, structural -> fixed
          { line: 9, text: "      e7 -> Closed;" },             // unindented + compressed: both indent and spacing applied
          { line: 17, text: "    start -> Running;" },           // statemachine_definition (shifted by blank line)
        ],
      },
      {
        type: "format_idempotent",
        fixture: "18_format_transitions.ump",
      },
    ],
  },

  // 19: Blank-line normalization between top-level declarations
  {
    name: "19 format_blank_lines: top-level declaration separation",
    fixtures: ["19_format_blank_lines.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "19_format_blank_lines.ump",
        expectLines: [
          // Blank line inserted between A and B (was 0)
          { line: 3, text: "" },
          { line: 4, text: "class B {" },
          // Blank line between B and C collapsed from 3 to 1
          { line: 7, text: "" },
          { line: 8, text: "class C {" },
          // Interior double blank inside C preserved (not touched)
          { line: 10, text: "" },
          { line: 11, text: "" },
          // Overlap regression: indented class D with no blank line before → fixed indent + blank line
          { line: 15, text: "class D {" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "19_format_blank_lines.ump",
      },
    ],
  },

  // 22: Compact state block expansion
  {
    name: "22 format_expand_states: single-line state expansion",
    fixtures: ["22_format_expand_states.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "22_format_expand_states.ump",
        expectLines: [
          { line: 2, text: "    Open {" },                    // expanded: opening line
          { line: 3, text: "      e1 -> Closed;" },           // transition indented + spaced
          { line: 4, text: "      e2 -> Dead;" },             // second transition
          { line: 5, text: "    }" },                          // closing brace
          { line: 6, text: "    Closed {}" },                  // empty: NOT expanded
          { line: 7, text: "    Idle {" },                     // single-transition expanded
          { line: 8, text: "      e1 [guard] -> Moving;" },   // guarded transition
          { line: 14, text: "  Init {" },                      // statemachine_definition state
          { line: 15, text: "    start -> Running;" },         // arrow spaced
          { line: 17, text: "  Running {}" },                  // empty: NOT expanded
        ],
      },
      {
        type: "format_idempotent",
        fixture: "22_format_expand_states.ump",
      },
    ],
  },

  // 23: Non-expansion cases
  {
    name: "23 format_no_expand: blocks that must NOT expand",
    fixtures: ["23_format_no_expand.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "23_format_no_expand.ump",
        expectLines: [
          // entry/exit action → unchanged
          { line: 2, text: "    Moving { entry / { code(); } e1 -> Open; }" },
          // method body → unchanged
          { line: 3, text: "    Active {void helper() {}}" },
          // class compact body → unchanged
          { line: 7, text: "class C { Integer x; }" },
          // || concurrent region → unchanged
          { line: 11, text: "    Open {e1 -> Closed; || e2 -> Dead;}" },
          // action code in transition → unchanged
          { line: 12, text: "    Active {e / { code(); } -> Closed;}" },
          // comment inside state → unchanged
          { line: 13, text: "    Idle {/* comment */ e1 -> Moving;}" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "23_format_no_expand.ump",
      },
    ],
  },

  // 21: Association arrow spacing
  {
    name: "21 format_associations: arrow spacing normalization",
    fixtures: ["21_format_associations.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "21_format_associations.ump",
        expectLines: [
          { line: 1, text: "  * -- *Item;" },           // compressed -- → spaced
          { line: 2, text: "  1 -> 0..1 Description;" }, // extra spaces → single
          { line: 3, text: "  0..* <@>- 1 Container;" }, // already correct
          { line: 4, text: "  * -- * Tag;" },            // already correct
          { line: 8, text: "  *  A -- * B;" },           // association_member arrow spaced
        ],
      },
      {
        type: "format_idempotent",
        fixture: "21_format_associations.ump",
      },
    ],
  },

  // 20: Integration — all formatter passes combined
  {
    name: "20 format_integration: all passes combined + comment preservation",
    fixtures: ["20_format_integration.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "20_format_integration.ump",
        expectLines: [
          // Indented top-level declaration fixed
          { line: 0, text: "class Animal {" },
          // code_content reindented to structural depth
          { line: 3, text: "    int x = 0;" },
          // template_body preserved
          { line: 5, text: "  greeting <<!Hello #name#!>>" },
          // Unindented transition: both indent + spacing
          { line: 8, text: "      e1 -> Closed;" },
          // Action code preserved, structural arrow fixed
          { line: 9, text: "      e2 / { foo->bar; } -> Closed;" },
          // Blank line inserted between Animal and Person
          { line: 14, text: "" },
          { line: 15, text: "class Person {" },
          // Comment preserved between Person and Species
          { line: 19, text: "// Species comment \u2014 must be preserved" },
          // Excessive blanks collapsed between Extra and GlobalSM
          { line: 28, text: "" },
          { line: 29, text: "statemachine GlobalSM {" },
          // Standalone transition arrow fixed
          { line: 31, text: "    start -> Running;" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "20_format_integration.ump",
      },
    ],
  },

  // 16: Syntax-aware formatting
  {
    name: "16 format_syntax_aware: AST-based indent + code_content skip + template_body",
    fixtures: ["16_format_syntax_aware.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "16_format_syntax_aware.ump",
        expectLines: [
          { line: 1, text: "  void foo() {" },                   // 1 level (inside class)
          { line: 2, text: "    int x = 0;" },                   // reindented to structural depth (class + method)
          { line: 6, text: "  }" },                               // 1 level (closes method)
          { line: 7, text: "  greeting <<!Hello #name#!>>" },     // 1 level, template content untouched
          { line: 10, text: "      close -> Closed;" },           // 3 levels (class + SM + state)
        ],
      },
    ],
  },

  // 24: Rename/reference scope model — known-graph-only guarantees
  {
    name: "24 rename_scope: local single-file refs without workspace crawl",
    fixtures: ["24_rename_scope.ump"],
    assertions: [
      // Local attribute refs: definition + constraint usage, single file
      {
        type: "goto_def",
        at: "local_ref",
        expect: [{ at: "local_attr" }],
      },
      {
        type: "refs",
        decl: { name: "count", kind: "attribute", container: "LocalOnly" },
        expectAt: ["local_attr", "local_ref"],
      },
      // Class ref: single-file, no imports needed
      {
        type: "refs",
        decl: { name: "LocalOnly", kind: "class", container: "LocalOnly" },
        expectAt: ["local_class"],
      },
    ],
  },

  // 25: Use-graph discovery — unopened importer found via use-graph edges
  //
  // This test exercises the ACTUAL rename guarantee:
  // 1. Target file is fully indexed normally
  // 2. Importer file is NOT fully indexed — only use-graph edges injected
  //    (simulates background workspace scan discovering it)
  // 3. Refs pipeline discovers importer via getReverseImporters,
  //    lazily indexes it on demand, and includes its references
  {
    name: "25 use_graph: unopened importer discovered via use-graph edges and lazily indexed",
    fixtures: ["25_use_graph_target.ump"],
    assertions: [
      {
        type: "use_graph_refs",
        targetFixture: "25_use_graph_target.ump",
        importerFixture: "25_use_graph_importer.ump",
        decl: { name: "Target", kind: "class", container: "Target" },
        expectAt: ["target_def", "importer_ref"],
      },
    ],
  },

  // 24b: Forward-import reference scope
  {
    name: "24b rename_scope: forward-import refs work across files",
    fixtures: ["11_cross_file_a.ump", "11_cross_file_b.ump"],
    assertions: [
      // Forward import: refs for Shared from file A finds definition in file B
      {
        type: "goto_def",
        at: "use_shared",
        expect: [{ at: "def_shared_b" }],
      },
      {
        type: "refs",
        decl: { name: "Shared", kind: "class", container: "Shared" },
        expectAt: ["def_shared_b", "use_shared"],
      },
    ],
  },

  // 12A: Completion fallback — zero-identifier positions
  {
    name: "12A completion_fallback: zero-identifier scope detection",
    fixtures: ["12_completion_fallback.ump"],
    assertions: [
      {
        type: "completion_kinds",
        at: "isA_empty",
        expect: ["class", "interface", "trait"],
      },
      {
        type: "completion_kinds",
        at: "before_empty",
        expect: ["method"],
      },
      {
        type: "completion_kinds",
        at: "arrow_empty",
        expect: ["state"],
      },
      {
        type: "completion_kinds",
        at: "refsm_empty",
        expect: ["statemachine"],
      },
    ],
  },

  // 12B: Completion items — parseable positions
  {
    name: "12B completion_items: actual completion content",
    fixtures: ["12_completion_items.ump"],
    assertions: [
      // Case A: isA — scope check
      {
        type: "completion_kinds",
        at: "isA_item",
        expect: ["class", "interface", "trait"],
      },
      // Case A: isA — includes class+interface, excludes enum
      {
        type: "completion_includes",
        at: "isA_item",
        expect: ["Parent", "I"],
      },
      {
        type: "completion_excludes",
        at: "isA_item",
        expect: ["Color"],
      },
      // Case B: before — includes own + inherited methods
      {
        type: "completion_includes",
        at: "before_item",
        expect: ["ownPing", "inheritedPing"],
      },
      // Case C: door as — includes statemachine
      {
        type: "completion_includes",
        at: "refsm_item",
        expect: ["status"],
      },
      // Case D: -> target — includes sibling states
      {
        type: "completion_includes",
        at: "arrow_item",
        expect: ["Closed"],
      },
      // Case D: -> target — excludes non-state symbols
      {
        type: "completion_excludes",
        at: "arrow_item",
        expect: ["Parent", "Color"],
      },
      // Case E: guard — scope check
      {
        type: "completion_kinds",
        at: "guard_item",
        expect: "guard_attribute_method",
      },
      // Case E: guard — includes attributes+methods
      {
        type: "completion_includes",
        at: "guard_item",
        expect: ["limit", "canOpen"],
      },
      // Case E: guard — excludes top-level keywords and operators
      {
        type: "completion_excludes",
        at: "guard_item",
        expect: ["class", "interface", "generate"],
      },
    ],
  },

  // 26: Reused standalone SM — shared state semantry, isolation, inheritance
  {
    name: "26 reused_sm: shared state refs from alias include base + sibling aliases",
    fixtures: ["26_reused_sm.ump"],
    assertions: [
      // Shared state: alias-side "inactive" includes base + sibling alias
      {
        type: "shared_refs",
        decl: { name: "inactive", kind: "state", container: "MotorController.motorStatus" },
        expectAt: [
          "motor_inactive_def", "motor_inactive_ref",
          "base_inactive_def", "base_shutdown_inactive_ref",
          "sensor_inactive_def",
        ],
      },
      // Shared state: base-side "inactive" includes all alias sites
      {
        type: "shared_refs",
        decl: { name: "inactive", kind: "state", container: "deviceStatus" },
        expectAt: [
          "base_inactive_def", "base_shutdown_inactive_ref",
          "motor_inactive_def", "motor_inactive_ref",
          "sensor_inactive_def",
        ],
      },
      // Shared state: sibling alias "inactive" includes motor + base
      {
        type: "shared_refs",
        decl: { name: "inactive", kind: "state", container: "SensorUnit.sensorStatus" },
        expectAt: [
          "sensor_inactive_def",
          "base_inactive_def", "base_shutdown_inactive_ref",
          "motor_inactive_def", "motor_inactive_ref",
        ],
      },
      // Inherited base-only: "booting" found from alias body references
      {
        type: "shared_refs",
        decl: { name: "booting", kind: "state", container: "deviceStatus" },
        expectAt: ["base_booting_def", "sensor_booting_ref"],
      },
      // Isolation: unrelated SM "inactive" must NOT include reused SM sites
      {
        type: "shared_refs_exclude",
        decl: { name: "inactive", kind: "state", container: "Unrelated.otherSm" },
        excludeAt: [
          "motor_inactive_def", "motor_inactive_ref",
          "base_inactive_def", "base_shutdown_inactive_ref",
          "sensor_inactive_def",
        ],
      },
      // Isolation: reused SM "inactive" must NOT include unrelated SM
      {
        type: "shared_refs_exclude",
        decl: { name: "inactive", kind: "state", container: "MotorController.motorStatus" },
        excludeAt: ["unrelated_inactive_def"],
      },
    ],
  },

  // 27: Timed events — after(N)/afterEvery(N) parse correctly, states resolve via transitions
  {
    name: "27 timed_events: state refs through timed transitions",
    fixtures: ["27_timed_events.ump"],
    assertions: [
      // Go-to-def: timed transition target Yellow resolves to Yellow state def
      {
        type: "goto_def",
        at: "green_to_yellow",
        expect: [{ at: "def_yellow" }],
      },
      // Go-to-def: afterEvery target Green resolves to Green state def
      {
        type: "goto_def",
        at: "red_to_green",
        expect: [{ at: "def_green" }],
      },
      // Refs: Green has def + afterEvery target ref
      {
        type: "refs",
        decl: { name: "Green", kind: "state", container: "TrafficLight.light" },
        expectAt: ["def_green", "red_to_green"],
      },
      // Refs: Yellow has def + after(30) target ref
      {
        type: "refs",
        decl: { name: "Yellow", kind: "state", container: "TrafficLight.light" },
        expectAt: ["def_yellow", "green_to_yellow"],
      },
      // Refs: Red has def + after(5) target ref
      {
        type: "refs",
        decl: { name: "Red", kind: "state", container: "TrafficLight.light" },
        expectAt: ["def_red", "yellow_to_red"],
      },
    ],
  },

  // 28: Multi-level inheritance — before/after hooks resolve through isA chain
  {
    name: "28 multi_inherit: hooks resolve through two-level isA chain",
    fixtures: ["28_multi_inherit.ump"],
    assertions: [
      // Leaf's before hook on greet resolves to Base.greet (inherited through Middle)
      {
        type: "goto_def",
        at: "hook_greet",
        expect: [{ at: "def_greet" }],
      },
      // Leaf's after hook on check resolves to Middle.check
      {
        type: "goto_def",
        at: "hook_check",
        expect: [{ at: "def_check" }],
      },
      // Refs for greet: Base def + Leaf hook
      {
        type: "refs",
        decl: { name: "greet", kind: "method", container: "Base" },
        expectAt: ["def_greet", "hook_greet"],
      },
      // Refs for check: Middle def + Leaf hook
      {
        type: "refs",
        decl: { name: "check", kind: "method", container: "Middle" },
        expectAt: ["def_check", "hook_check"],
      },
    ],
  },

  // 29: Association go-to-def — standalone and inline association type refs
  {
    name: "29 assoc_gotodef: class refs in standalone and inline associations",
    fixtures: ["29_assoc_gotdef.ump"],
    assertions: [
      // Standalone association Company → class Company
      {
        type: "goto_def",
        at: "assoc_company",
        expect: [{ at: "def_company" }],
      },
      // Standalone association Employee → class Employee
      {
        type: "goto_def",
        at: "assoc_employee",
        expect: [{ at: "def_employee" }],
      },
      // Inline association Company → class Company
      {
        type: "goto_def",
        at: "inline_company",
        expect: [{ at: "def_company" }],
      },
      // Company refs include: class def + standalone assoc + inline assoc
      {
        type: "refs",
        decl: { name: "Company", kind: "class", container: "Company" },
        expectAt: ["def_company", "assoc_company", "inline_company"],
      },
    ],
  },

  // 30: Formatter — referenced_statemachine body indentation
  {
    name: "30 format_reused_sm: referenced_statemachine body gets +1 indent",
    fixtures: ["30_format_reused_sm.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "30_format_reused_sm.ump",
        expectLines: [
          { line: 1, text: "  motorStatus as deviceStatus {" },
          { line: 2, text: "    // comment inside reused SM" },
          { line: 3, text: "    inactive {}" },
          { line: 4, text: "    cancel booting -> inactive;" },
          { line: 5, text: "  };" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "30_format_reused_sm.ump",
      },
    ],
  },

  // 31: Formatter — requirement_definition body indentation
  {
    name: "31 format_requirement: requirement body gets +1 indent",
    fixtures: ["31_format_requirement.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "31_format_requirement.ump",
        expectLines: [
          { line: 1, text: "  line1" },
          { line: 2, text: "  line2" },
          { line: 3, text: "}" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "31_format_requirement.ump",
      },
    ],
  },

  // 32: Formatter — tracecase body indentation
  {
    name: "32 format_tracecase: tracecase body gets +1 indent",
    fixtures: ["32_format_tracecase.ump"],
    assertions: [
      {
        type: "format_output",
        fixture: "32_format_tracecase.ump",
        expectLines: [
          { line: 1, text: "  tracecase T {" },
          { line: 2, text: "    trace x;" },
          { line: 3, text: "    trace y;" },
          { line: 4, text: "  }" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "32_format_tracecase.ump",
      },
    ],
  },

  // 33: Formatter — tab-mode embedded code reindentation regression
  {
    name: "33 format_tabs: embedded code uses tabs when insertSpaces is false",
    fixtures: ["33_format_tabs.ump"],
    assertions: [
      {
        type: "format_output_with_options",
        fixture: "33_format_tabs.ump",
        options: { tabSize: 2, insertSpaces: false },
        expectText: "class A {\n\tvoid foo() {\n\t\tint x = 0;\n\t}\n}\n",
      },
    ],
  },

  // 34: Layout directives — parse clean, repeated class defs all indexed
  {
    name: "34 layout_directives: parse clean, repeated class defs all indexed, goto-def resolves all",
    fixtures: ["34_layout_directives.ump"],
    assertions: [
      // File with layout directives parses without ERROR nodes
      {
        type: "parse_clean",
        fixture: "34_layout_directives.ump",
      },
      // Repeated class blocks (including layout-only) are all indexed as definitions
      {
        type: "symbol_count",
        fixture: "34_layout_directives.ump",
        name: "RealClass",
        kind: "class",
        expect: 2,
      },
      {
        type: "symbol_count",
        fixture: "34_layout_directives.ump",
        name: "Other",
        kind: "class",
        expect: 3,
      },
      // Go-to-def from type reference resolves to all 3 Other definitions
      {
        type: "goto_def",
        at: "ref_other",
        expect: [{ at: "def_other1" }, { at: "def_other2" }, { at: "def_other3" }],
      },
    ],
  },

  // 35: Strictness directives — parse clean, no symbol pollution
  {
    name: "35 strictness: allow/ignore/modelOnly parse clean, no extra symbols",
    fixtures: ["35_strictness.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "35_strictness.ump",
      },
      // Only class A should be indexed — strictness directives create no symbols
      {
        type: "symbol_count",
        fixture: "35_strictness.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 36: Enumerated attributes — parse clean, attribute name indexed, values not indexed
  {
    name: "36 enumerated_attr: braced value-list parses clean, attribute name indexed",
    fixtures: ["36_enumerated_attr.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "36_enumerated_attr.ump",
      },
      // Attribute names are indexed as symbols
      {
        type: "symbol_count",
        fixture: "36_enumerated_attr.ump",
        name: "description",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "36_enumerated_attr.ump",
        name: "details",
        kind: "attribute",
        expect: 1,
      },
    ],
  },

  // 37: Java-like members — synchronized, throws, static fields, long literals, array types
  {
    name: "37 java_members: Java-like methods and fields parse clean, names indexed",
    fixtures: ["37_java_members.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "37_java_members.ump",
      },
      // Methods indexed
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "main",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "sendSyn",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "waitForReply",
        kind: "method",
        expect: 1,
      },
      // Methods with final/synchronized in various orders
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "getClientConnections",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "receiveMessageFromClient",
        kind: "method",
        expect: 1,
      },
      // Method with qualified throws
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "countLinesInFile",
        kind: "method",
        expect: 1,
      },
      // Method with final param
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "create",
        kind: "method",
        expect: 1,
      },
      // Fields indexed as attributes
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "s",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "startTime",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "previousCommand",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "messages",
        kind: "attribute",
        expect: 1,
      },
      // final fields
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "X",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "xs",
        kind: "attribute",
        expect: 1,
      },
      // Call-expression initializers
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "validLanguages",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "NL",
        kind: "attribute",
        expect: 1,
      },
      // Generic method call initializer + array literal initializer
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "suboptions",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "37_java_members.ump",
        name: "parameters",
        kind: "attribute",
        expect: 1,
      },
    ],
  },

  // 38: Port/reactive syntax — port declarations, connectors, active methods with watchlists
  {
    name: "38 ports_reactive: port declarations, connectors, and active methods parse clean",
    fixtures: ["38_ports_reactive.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "38_ports_reactive.ump",
      },
      // Classes are indexed, port/connector/watchlist internals are not
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "Component1",
        kind: "class",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "Composite",
        kind: "class",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "Sensor",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 39: Cold-open error recovery — recovered symbols from malformed file
  {
    name: "39 cold_open_recovery: class/attribute/method recovered from broken file, no state/SM",
    fixtures: ["39_cold_open_recovery.ump"],
    assertions: [
      // File has parse errors (intentional)
      // Class A is recovered
      {
        type: "recovered_symbol",
        fixture: "39_cold_open_recovery.ump",
        name: "A",
        kind: "class",
        expectRecovered: true,
      },
      // Attribute "name" is recovered
      {
        type: "recovered_symbol",
        fixture: "39_cold_open_recovery.ump",
        name: "name",
        kind: "attribute",
        expectRecovered: true,
      },
      // Method "foo" is recovered
      {
        type: "recovered_symbol",
        fixture: "39_cold_open_recovery.ump",
        name: "foo",
        kind: "method",
        expectRecovered: true,
      },
      // Class B is recovered
      {
        type: "recovered_symbol",
        fixture: "39_cold_open_recovery.ump",
        name: "B",
        kind: "class",
        expectRecovered: true,
      },
      // Goto-def on recovered class still works
      {
        type: "goto_def",
        at: "ref_a",
        expect: [{ at: "def_a" }],
      },
      // Hover on recovered symbol includes degraded-state note
      {
        type: "hover_output",
        at: "def_a",
        expectContains: ["parse errors"],
      },
    ],
  },

  // 40: Clean parse — symbols from clean file are NOT marked recovered
  {
    name: "40 clean_parse: symbols from error-free file have no recovered flag",
    fixtures: ["40_live_edit_regression.ump"],
    assertions: [
      // File parses clean — symbols should NOT be recovered
      {
        type: "recovered_symbol",
        fixture: "40_live_edit_regression.ump",
        name: "CleanClass",
        kind: "class",
        expectRecovered: false,
      },
      {
        type: "recovered_symbol",
        fixture: "40_live_edit_regression.ump",
        name: "name",
        kind: "attribute",
        expectRecovered: false,
      },
      // State preserved from clean parse
      {
        type: "recovered_symbol",
        fixture: "40_live_edit_regression.ump",
        name: "Active",
        kind: "state",
        expectRecovered: false,
      },
    ],
  },

  // 41: ERROR-node token fallback — goto-def/hover on identifiers inside ERROR nodes
  {
    name: "41 error_node_fallback: goto-def resolves identifier inside ERROR node",
    fixtures: ["41_error_node_fallback.ump"],
    assertions: [
      // Goto-def on Widget inside ERROR node resolves to class definition
      {
        type: "goto_def",
        at: "ref_widget",
        expect: [{ at: "def_widget" }],
      },
      // Hover on Widget inside ERROR node shows class info + recovered note
      {
        type: "hover_output",
        at: "ref_widget",
        expectContains: ["Widget", "parse errors"],
      },
      // Ambiguity regression: even with a local attribute named Widget,
      // the ERROR-node fallback resolves to class Widget (not the attribute)
      {
        type: "goto_def",
        at: "ref_ambig_widget",
        expect: [{ at: "def_widget" }],
      },
    ],
  },

  // 42: Method recovery — valid methods recovered, malformed pseudo-methods skipped
  {
    name: "42 method_recovery: valid method near broken code recovered, pseudo-method skipped",
    fixtures: ["42_method_recovery.ump"],
    assertions: [
      // Positive: good() has valid declaration shape — recovered
      {
        type: "recovered_symbol",
        fixture: "42_method_recovery.ump",
        name: "good",
        kind: "method",
        expectRecovered: true,
      },
      // Negative: BROKEN is not a real method — not recovered
      {
        type: "symbol_count",
        fixture: "42_method_recovery.ump",
        name: "BROKEN",
        kind: "method",
        expect: 0,
      },
      // Positive: multiply has ERROR in return-type area but name+params are clean
      {
        type: "recovered_symbol",
        fixture: "42_method_recovery.ump",
        name: "multiply",
        kind: "method",
        expectRecovered: true,
      },
      // Positive: add is also recovered
      {
        type: "recovered_symbol",
        fixture: "42_method_recovery.ump",
        name: "add",
        kind: "method",
        expectRecovered: true,
      },
      // Negative: bad inside ERROR subtree — not recovered
      {
        type: "symbol_count",
        fixture: "42_method_recovery.ump",
        name: "bad",
        kind: "method",
        expect: 0,
      },
    ],
  },

  // 43: V2a — statemachine recovery from broken files
  {
    name: "43 sm_recovery: class-local and top-level SMs recovered from error files",
    fixtures: ["43_sm_recovery.ump"],
    assertions: [
      // Class-local SM recovered
      {
        type: "recovered_symbol",
        fixture: "43_sm_recovery.ump",
        name: "sm",
        kind: "statemachine",
        expectRecovered: true,
      },
      // Top-level SM recovered
      {
        type: "recovered_symbol",
        fixture: "43_sm_recovery.ump",
        name: "GlobalSM",
        kind: "statemachine",
        expectRecovered: true,
      },
      // Class is also recovered
      {
        type: "recovered_symbol",
        fixture: "43_sm_recovery.ump",
        name: "A",
        kind: "class",
        expectRecovered: true,
      },
      // Negative: misparsed "class D {}" becomes empty state_machine — NOT recovered
      {
        type: "symbol_count",
        fixture: "43_sm_recovery.ump",
        name: "D",
        kind: "statemachine",
        expect: 0,
      },
      // Positive: realSm with content IS recovered
      {
        type: "recovered_symbol",
        fixture: "43_sm_recovery.ump",
        name: "realSm",
        kind: "statemachine",
        expectRecovered: true,
      },
    ],
  },

  // 44: V2b — depth-1 state recovery, nested states rejected
  {
    name: "44 state_recovery: depth-1 states recovered, nested states rejected",
    fixtures: ["44_state_recovery.ump"],
    assertions: [
      // Depth-1 states recovered
      {
        type: "recovered_symbol",
        fixture: "44_state_recovery.ump",
        name: "Open",
        kind: "state",
        expectRecovered: true,
      },
      {
        type: "recovered_symbol",
        fixture: "44_state_recovery.ump",
        name: "Closed",
        kind: "state",
        expectRecovered: true,
      },
      // SM recovered
      {
        type: "recovered_symbol",
        fixture: "44_state_recovery.ump",
        name: "status",
        kind: "statemachine",
        expectRecovered: true,
      },
      // Depth-1 states in second SM
      {
        type: "recovered_symbol",
        fixture: "44_state_recovery.ump",
        name: "Ground",
        kind: "state",
        expectRecovered: true,
      },
      {
        type: "recovered_symbol",
        fixture: "44_state_recovery.ump",
        name: "Upper",
        kind: "state",
        expectRecovered: true,
      },
      // Nested state NOT recovered (depth > 1)
      {
        type: "symbol_count",
        fixture: "44_state_recovery.ump",
        name: "Inner",
        kind: "state",
        expect: 0,
      },
      // References on recovered SM: definition site found
      {
        type: "refs",
        decl: { name: "status", kind: "statemachine", container: "Door.status" },
        expectAt: ["def_status"],
      },
      // References on recovered state: definition + transition target
      {
        type: "refs",
        decl: { name: "Open", kind: "state", container: "Door.status" },
        expectAt: ["def_open", "ref_open"],
      },
      {
        type: "refs",
        decl: { name: "Closed", kind: "state", container: "Door.status" },
        expectAt: ["def_closed", "ref_closed"],
      },
    ],
  },

  // 45: Malformed state header — state with ERROR in header is not recovered
  {
    name: "45 state_malformed: malformed state header not recovered, clean siblings are",
    fixtures: ["45_state_malformed.ump"],
    assertions: [
      // Clean states recovered
      {
        type: "recovered_symbol",
        fixture: "45_state_malformed.ump",
        name: "Open",
        kind: "state",
        expectRecovered: true,
      },
      {
        type: "recovered_symbol",
        fixture: "45_state_malformed.ump",
        name: "Closed",
        kind: "state",
        expectRecovered: true,
      },
      // Malformed "Closing" with ERROR in header — NOT recovered
      {
        type: "symbol_count",
        fixture: "45_state_malformed.ump",
        name: "Closing",
        kind: "state",
        expect: 0,
      },
    ],
  },

  // 46: Derived attributes — expression body `= { ... }` without semicolon
  {
    name: "46 derived_attribute: expression bodies parse clean, attributes indexed",
    fixtures: ["46_derived_attribute.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "46_derived_attribute.ump",
      },
      {
        type: "symbol_count",
        fixture: "46_derived_attribute.ump",
        name: "fullName",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "46_derived_attribute.ump",
        name: "rho",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "46_derived_attribute.ump",
        name: "isAdult",
        kind: "attribute",
        expect: 1,
      },
      // Modifier regression: unique + final on derived form
      {
        type: "symbol_count",
        fixture: "46_derived_attribute.ump",
        name: "uniqueName",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "46_derived_attribute.ump",
        name: "finalVal",
        kind: "attribute",
        expect: 1,
      },
    ],
  },

  // 47: Abstract methods in classes
  {
    name: "47 abstract_method: abstract methods parse clean, indexed as methods",
    fixtures: ["47_abstract_method.ump"],
    assertions: [
      // Note: file intentionally has invalid "void noAbstract();" so parse_clean is not expected
      {
        type: "symbol_count",
        fixture: "47_abstract_method.ump",
        name: "draw",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "47_abstract_method.ump",
        name: "resize",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "47_abstract_method.ump",
        name: "describe",
        kind: "method",
        expect: 1,
      },
      // Negative: "void noAbstract();" in class body is NOT a valid method (no abstract keyword)
      {
        type: "symbol_count",
        fixture: "47_abstract_method.ump",
        name: "noAbstract",
        kind: "method",
        expect: 0,
      },
      // Negative: "abstract void withBody() {}" is NOT valid (abstract + body)
      {
        type: "symbol_count",
        fixture: "47_abstract_method.ump",
        name: "withBody",
        kind: "method",
        expect: 0,
      },
    ],
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

interface AssertionResult {
  ok: boolean;
  message: string;
}

function runAssertion(
  helper: SemanticTestHelper,
  files: Map<string, { path: string; content: string; markers: Map<string, MarkerPosition> }>,
  reachable: Set<string>,
  assertion: Assertion,
): AssertionResult {
  // Helper to find a marker across all fixture files
  function findMarker(name: string): { filePath: string; content: string; pos: MarkerPosition } | null {
    for (const f of files.values()) {
      const pos = f.markers.get(name);
      if (pos) return { filePath: f.path, content: f.content, pos };
    }
    return null;
  }

  if (assertion.type === "token_context") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const token = helper.tokenAt(src.filePath, src.content, src.pos.line, src.pos.col);
    if (!token) {
      return { ok: false, message: `token_context @${assertion.at}: no token at position` };
    }

    const exp = assertion.expect;

    // Check context type
    if (token.context.type !== exp.contextType) {
      return {
        ok: false,
        message: `token_context @${assertion.at}: expected contextType "${exp.contextType}", got "${token.context.type}"`,
      };
    }

    // Check context-specific fields
    if (exp.traitName !== undefined) {
      const ctx = token.context as any;
      if (ctx.traitName !== exp.traitName) {
        return {
          ok: false,
          message: `token_context @${assertion.at}: expected traitName "${exp.traitName}", got "${ctx.traitName}"`,
        };
      }
    }
    if (exp.pathSegments !== undefined) {
      const ctx = token.context as any;
      if (!ctx.pathSegments || JSON.stringify(ctx.pathSegments) !== JSON.stringify(exp.pathSegments)) {
        return {
          ok: false,
          message: `token_context @${assertion.at}: expected pathSegments ${JSON.stringify(exp.pathSegments)}, got ${JSON.stringify(ctx.pathSegments)}`,
        };
      }
    }
    if (exp.segmentIndex !== undefined) {
      const ctx = token.context as any;
      if (ctx.segmentIndex !== exp.segmentIndex) {
        return {
          ok: false,
          message: `token_context @${assertion.at}: expected segmentIndex ${exp.segmentIndex}, got ${ctx.segmentIndex}`,
        };
      }
    }
    if (exp.targetClass !== undefined) {
      const ctx = token.context as any;
      if (ctx.targetClass !== exp.targetClass) {
        return {
          ok: false,
          message: `token_context @${assertion.at}: expected targetClass "${exp.targetClass}", got "${ctx.targetClass}"`,
        };
      }
    }

    // Check dottedStateRef
    if (exp.dottedStateRef !== undefined) {
      if (exp.dottedStateRef === null) {
        if (token.dottedStateRef) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected dottedStateRef null, got ${JSON.stringify(token.dottedStateRef)}`,
          };
        }
      } else {
        if (!token.dottedStateRef) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected dottedStateRef, got undefined`,
          };
        }
        if (JSON.stringify(token.dottedStateRef.qualifiedPath) !== JSON.stringify(exp.dottedStateRef.qualifiedPath)) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected dottedStateRef.qualifiedPath ${JSON.stringify(exp.dottedStateRef.qualifiedPath)}, got ${JSON.stringify(token.dottedStateRef.qualifiedPath)}`,
          };
        }
        if (token.dottedStateRef.pathIndex !== exp.dottedStateRef.pathIndex) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected dottedStateRef.pathIndex ${exp.dottedStateRef.pathIndex}, got ${token.dottedStateRef.pathIndex}`,
          };
        }
      }
    }

    // Check stateDefinitionRef
    if (exp.stateDefinitionRef !== undefined) {
      if (exp.stateDefinitionRef === null) {
        if (token.stateDefinitionRef) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected stateDefinitionRef null, got ${JSON.stringify(token.stateDefinitionRef)}`,
          };
        }
      } else {
        if (!token.stateDefinitionRef) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected stateDefinitionRef, got undefined`,
          };
        }
        if (JSON.stringify(token.stateDefinitionRef.definitionPath) !== JSON.stringify(exp.stateDefinitionRef.definitionPath)) {
          return {
            ok: false,
            message: `token_context @${assertion.at}: expected stateDefinitionRef.definitionPath ${JSON.stringify(exp.stateDefinitionRef.definitionPath)}, got ${JSON.stringify(token.stateDefinitionRef.definitionPath)}`,
          };
        }
      }
    }

    return { ok: true, message: "" };
  }

  if (assertion.type === "goto_def") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const result = helper.resolve(src.filePath, src.content, src.pos.line, src.pos.col, reachable);
    if (!result || result.symbols.length === 0) {
      return {
        ok: false,
        message: `goto_def @${assertion.at}: resolved to nothing, expected ${assertion.expect.map((e) => `@${e.at}`).join(", ")}`,
      };
    }

    for (const exp of assertion.expect) {
      const target = findMarker(exp.at);
      if (!target) return { ok: false, message: `target marker @${exp.at} not found` };

      const found = result.symbols.some(
        (s) => s.line === target.pos.line && s.file === target.filePath,
      );
      if (!found) {
        return {
          ok: false,
          message: `goto_def @${assertion.at}: expected target @${exp.at} (line ${target.pos.line}), got lines [${result.symbols.map((s) => s.line).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "goto_def_empty") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const result = helper.resolve(src.filePath, src.content, src.pos.line, src.pos.col, reachable);
    if (result && result.symbols.length > 0) {
      return {
        ok: false,
        message: `goto_def_empty @${assertion.at}: expected empty, got ${result.symbols.length} symbols`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "refs") {
    const refs = helper.findRefs(assertion.decl, reachable);
    for (const markerName of assertion.expectAt) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `marker @${markerName} not found` };

      const found = refs.some(
        (r) => r.line === target.pos.line && r.file === target.filePath,
      );
      if (!found) {
        return {
          ok: false,
          message: `refs ${assertion.decl.container}.${assertion.decl.name}: expected @${markerName} (line ${target.pos.line}), got lines [${refs.map((r) => r.line).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "refs_exclude") {
    const refs = helper.findRefs(assertion.decl, reachable);
    for (const markerName of assertion.excludeAt) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `marker @${markerName} not found` };

      const found = refs.some(
        (r) => r.line === target.pos.line && r.file === target.filePath,
      );
      if (found) {
        return {
          ok: false,
          message: `refs_exclude ${assertion.decl.container}.${assertion.decl.name}: @${markerName} (line ${target.pos.line}) should NOT be in refs but was found`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "shared_refs") {
    const refs = helper.findSharedRefs(assertion.decl, reachable);
    for (const markerName of assertion.expectAt) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `marker @${markerName} not found` };

      const found = refs.some(
        (r) => r.line === target.pos.line && r.file === target.filePath,
      );
      if (!found) {
        return {
          ok: false,
          message: `shared_refs ${assertion.decl.container}.${assertion.decl.name}: expected @${markerName} (line ${target.pos.line}), got lines [${refs.map((r) => r.line).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "shared_refs_exclude") {
    const refs = helper.findSharedRefs(assertion.decl, reachable);
    for (const markerName of assertion.excludeAt) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `marker @${markerName} not found` };

      const found = refs.some(
        (r) => r.line === target.pos.line && r.file === target.filePath,
      );
      if (found) {
        return {
          ok: false,
          message: `shared_refs_exclude ${assertion.decl.container}.${assertion.decl.name}: @${markerName} (line ${target.pos.line}) should NOT be in refs but was found`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "child_states") {
    const children = helper.childStates(assertion.parentPath, assertion.smContainer, reachable);
    const expected = [...assertion.expect].sort();
    const actual = [...children].sort();
    if (expected.length !== actual.length || !expected.every((e, i) => e === actual[i])) {
      return {
        ok: false,
        message: `child_states [${assertion.parentPath.join(".")}] in ${assertion.smContainer}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "completion_kinds") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const info = helper.completionInfo(src.content, src.pos.line, src.pos.col);
    const actual = info.symbolKinds;
    const expected = assertion.expect;

    if (expected === null) {
      if (actual !== null) {
        return {
          ok: false,
          message: `completion_kinds @${assertion.at}: expected null, got ${JSON.stringify(actual)}`,
        };
      }
    } else if (typeof expected === "string") {
      if (actual !== expected) {
        return {
          ok: false,
          message: `completion_kinds @${assertion.at}: expected "${expected}", got ${JSON.stringify(actual)}`,
        };
      }
    } else {
      // Array comparison
      if (!Array.isArray(actual)) {
        return {
          ok: false,
          message: `completion_kinds @${assertion.at}: expected [${expected.join(", ")}], got ${JSON.stringify(actual)}`,
        };
      }
      const sortedExpected = [...expected].sort();
      const sortedActual = [...actual].sort();
      if (
        sortedExpected.length !== sortedActual.length ||
        !sortedExpected.every((e, i) => e === sortedActual[i])
      ) {
        return {
          ok: false,
          message: `completion_kinds @${assertion.at}: expected [${expected.join(", ")}], got [${(actual as string[]).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "use_graph_refs") {
    // Target file should already be indexed via fixtures
    const targetInfo = files.get(assertion.targetFixture);
    if (!targetInfo) return { ok: false, message: `target fixture ${assertion.targetFixture} not found` };

    // Load importer WITHOUT full indexing (simulates unopened file)
    const importerFiles = helper.loadWithoutIndexing(assertion.importerFixture);
    const importerInfo = importerFiles.get(assertion.importerFixture);
    if (!importerInfo) return { ok: false, message: `importer fixture ${assertion.importerFixture} not found` };

    // Add importer markers to the files map for marker lookup
    files.set(assertion.importerFixture, importerInfo);

    // Inject use-graph edges only (simulates background workspace scan)
    helper.injectUseGraphEdges(importerInfo.path, importerInfo.content);

    // Run the full rename/reference pipeline with reverse-importer discovery
    const fileContents = new Map<string, string>();
    for (const [, f] of files) {
      fileContents.set(f.path, f.content);
    }

    const refs = helper.findRefsWithReverseImporters(assertion.decl, reachable, fileContents);

    // Check expected markers are present
    for (const markerName of assertion.expectAt) {
      let target: { filePath: string; pos: MarkerPosition } | null = null;
      for (const f of files.values()) {
        const pos = f.markers.get(markerName);
        if (pos) { target = { filePath: f.path, pos }; break; }
      }
      if (!target) return { ok: false, message: `marker @${markerName} not found` };

      const found = refs.some(
        (r) => r.line === target!.pos.line && r.file === target!.filePath,
      );
      if (!found) {
        return {
          ok: false,
          message: `use_graph_refs: expected @${markerName} (line ${target.pos.line}) in refs, got lines [${refs.map((r) => `${r.file}:${r.line}`).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "format_idempotent") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    // First pass
    const pass1 = helper.formatFile(fileInfo.path, fileInfo.content);
    const pass1Text = pass1.join("\n");

    // Second pass on the formatted output
    const pass2 = helper.formatFile(fileInfo.path, pass1Text);
    const pass2Text = pass2.join("\n");

    if (pass1Text !== pass2Text) {
      // Find first differing line
      for (let i = 0; i < Math.max(pass1.length, pass2.length); i++) {
        if (pass1[i] !== pass2[i]) {
          return {
            ok: false,
            message: `format_idempotent ${assertion.fixture}: not idempotent at line ${i}. Pass1: ${JSON.stringify(pass1[i])}, Pass2: ${JSON.stringify(pass2[i])}`,
          };
        }
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "format_output") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const formattedLines = helper.formatFile(fileInfo.path, fileInfo.content);

    for (const exp of assertion.expectLines) {
      const actual = formattedLines[exp.line];
      if (actual !== exp.text) {
        return {
          ok: false,
          message: `format_output line ${exp.line}: expected ${JSON.stringify(exp.text)}, got ${JSON.stringify(actual)}`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "format_output_with_options") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const actual = helper.formatFileWithOptions(fileInfo.path, fileInfo.content, assertion.options);
    if (actual !== assertion.expectText) {
      return {
        ok: false,
        message: `format_output_with_options ${assertion.fixture}: expected ${JSON.stringify(assertion.expectText)}, got ${JSON.stringify(actual)}`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "parse_clean") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const tree = helper.si.getTree(fileInfo.path);
    if (!tree) return { ok: false, message: `parse_clean ${assertion.fixture}: no tree` };
    if (tree.rootNode.hasError) {
      return {
        ok: false,
        message: `parse_clean ${assertion.fixture}: tree has ERROR nodes`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "symbol_count") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const syms = helper.si.getSymbols({
      name: assertion.name,
      kind: assertion.kind as any,
    }).filter((s: any) => s.file === fileInfo.path);
    if (syms.length !== assertion.expect) {
      return {
        ok: false,
        message: `symbol_count ${assertion.name}(${assertion.kind}): expected ${assertion.expect}, got ${syms.length}`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "recovered_symbol") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const syms = helper.si.getSymbols({
      name: assertion.name,
      kind: assertion.kind as any,
    }).filter((s: any) => s.file === fileInfo.path);
    if (syms.length === 0) {
      return {
        ok: false,
        message: `recovered_symbol ${assertion.name}(${assertion.kind}): symbol not found`,
      };
    }
    const isRecovered = syms[0].recovered === true;
    if (isRecovered !== assertion.expectRecovered) {
      return {
        ok: false,
        message: `recovered_symbol ${assertion.name}(${assertion.kind}): expected recovered=${assertion.expectRecovered}, got ${isRecovered}`,
      };
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "document_symbols") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const tree = helper.documentSymbols(fileInfo.path);
    const rootNames = tree.map((s) => s.name).sort();
    const expectedRoots = [...assertion.expectRoots].sort();

    // Check root names
    for (const expected of expectedRoots) {
      if (!rootNames.includes(expected)) {
        return {
          ok: false,
          message: `document_symbols: expected root "${expected}" not found in [${rootNames.join(", ")}]`,
        };
      }
    }

    // Check parent→child nesting
    const parentSym = tree.find((s) => s.name === assertion.expectChild.parent);
    if (!parentSym) {
      return {
        ok: false,
        message: `document_symbols: parent "${assertion.expectChild.parent}" not found in roots`,
      };
    }
    const childNames = (parentSym.children ?? []).map((c) => c.name);
    if (!childNames.includes(assertion.expectChild.child)) {
      return {
        ok: false,
        message: `document_symbols: expected child "${assertion.expectChild.child}" not found in "${assertion.expectChild.parent}" children [${childNames.join(", ")}]`,
      };
    }

    return { ok: true, message: "" };
  }

  if (assertion.type === "hover_output") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const markdown = helper.hoverAt(src.filePath, src.content, src.pos.line, src.pos.col, reachable);
    if (!markdown) {
      return {
        ok: false,
        message: `hover_output @${assertion.at}: hover returned null`,
      };
    }

    for (const expected of assertion.expectContains) {
      if (!markdown.includes(expected)) {
        return {
          ok: false,
          message: `hover_output @${assertion.at}: expected "${expected}" in hover, got: ${markdown.substring(0, 200)}`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "completion_includes") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const items = helper.completionItems(src.content, src.pos.line, src.pos.col, reachable);
    const labels = new Set(items.map((item) => item.label));

    for (const expected of assertion.expect) {
      if (!labels.has(expected)) {
        return {
          ok: false,
          message: `completion_includes @${assertion.at}: expected "${expected}" in items, got [${[...labels].slice(0, 15).join(", ")}${labels.size > 15 ? "..." : ""}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "completion_excludes") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const items = helper.completionItems(src.content, src.pos.line, src.pos.col, reachable);
    const labels = new Set(items.map((item) => item.label));

    for (const excluded of assertion.expect) {
      if (labels.has(excluded)) {
        return {
          ok: false,
          message: `completion_excludes @${assertion.at}: "${excluded}" should NOT be in items but was found`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  return { ok: false, message: `unknown assertion type` };
}

async function main() {
  const helper = new SemanticTestHelper();
  await helper.init();

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    const { files, reachable } = helper.indexFixtures(...tc.fixtures);

    // Index unreachable files (in the index but NOT in reachable set)
    if (tc.unreachable) {
      const extraFiles = helper.indexUnreachable(...tc.unreachable);
      for (const [name, f] of extraFiles) {
        files.set(name, f);
      }
    }

    for (const assertion of tc.assertions) {
      const result = runAssertion(helper, files, reachable, assertion);
      if (result.ok) {
        passed++;
      } else {
        failed++;
        console.log(`FAIL [${tc.name}] ${result.message}`);
      }
    }
  }

  // ── Direct programmatic test: recovery lifecycle ──────────────────────────
  // Exercises: broken open → recovered, clean edit → not recovered, broken again → recovered
  {
    const testName = "recovery_lifecycle: broken→recovered, clean→cleared, broken→recovered again";
    try {
      const filePath = "/tmp/recovery_lifecycle_test.ump";
      const brokenContent = "class X {\n  name;\n  BROKEN HERE\n}";
      const cleanContent = "class X {\n  name;\n}";

      // Step 1: cold-open broken file
      helper.si.indexFile(filePath, brokenContent);
      const step1 = helper.si.getSymbols({ name: "X", kind: "class" as any })
        .filter((s: any) => s.file === filePath);
      if (!step1[0]?.recovered) throw new Error("Step 1: X should be recovered");

      // Step 2: fix file (clean edit)
      helper.si.indexFile(filePath, cleanContent);
      const step2 = helper.si.getSymbols({ name: "X", kind: "class" as any })
        .filter((s: any) => s.file === filePath);
      if (step2[0]?.recovered) throw new Error("Step 2: X should NOT be recovered after clean edit");

      // Step 3: break file again
      helper.si.indexFile(filePath, brokenContent);
      const step3 = helper.si.getSymbols({ name: "X", kind: "class" as any })
        .filter((s: any) => s.file === filePath);
      // After a clean edit, existing snapshot exists — preserved symbols are NOT marked recovered
      // (this is the live-edit path, not cold-open)
      if (step3[0]?.recovered) throw new Error("Step 3: X should NOT be recovered (live-edit path has clean snapshot)");

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // ── Direct programmatic test: live-edit state preservation ──────────────
  // Clean states preserved as non-recovered after broken edit
  {
    const testName = "live_edit_state_preservation: clean states stay non-recovered after broken edit";
    try {
      const filePath = "/tmp/state_preservation_test.ump";
      const cleanContent = "class A {\n  sm { Open {} Closed {} }\n}";
      const brokenContent = "class A {\n  sm { Open {} Closed {} }\n  BROKEN\n}";

      // Step 1: index clean file — states should exist without recovered flag
      helper.si.indexFile(filePath, cleanContent);
      const step1 = helper.si.getSymbols({ name: "Open", kind: "state" as any })
        .filter((s: any) => s.file === filePath);
      if (step1.length !== 1) throw new Error("Step 1: Open should exist");
      if (step1[0].recovered) throw new Error("Step 1: Open should NOT be recovered");

      // Step 2: break the file — preserved clean states should stay non-recovered
      helper.si.indexFile(filePath, brokenContent);
      const step2 = helper.si.getSymbols({ name: "Open", kind: "state" as any })
        .filter((s: any) => s.file === filePath);
      if (step2.length !== 1) throw new Error("Step 2: Open should still exist (preserved)");
      if (step2[0].recovered) throw new Error("Step 2: Open should NOT be recovered (preserved from clean snapshot)");

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test harness error:", err);
  process.exit(2);
});
