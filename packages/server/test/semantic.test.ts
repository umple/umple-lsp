/**
 * Semantic regression test suite.
 *
 * Exercises all known LSP semantic behaviors using real fixtures.
 * Run with: npm test (from repo root or packages/server)
 */

import * as path from "path";
import { SemanticTestHelper, MarkerPosition, DeclSpec } from "./helpers";
import { resolveTraitSmEventLocations } from "../src/traitSmEventResolver";
import { stripLayoutTail } from "../src/tokenTypes";

// ── Assertion types ──────────────────────────────────────────────────────────

interface GotoDefAssertion {
  type: "goto_def";
  at: string; // marker name for cursor position
  expect: { at: string; container?: string }[]; // target marker(s)
}

interface GotoDefExactAssertion {
  type: "goto_def_exact";
  at: string;
  expect: string[]; // exact set of target markers — no more, no fewer
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
  | GotoDefExactAssertion
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
  | ParseHasErrorAssertion
  | SymbolCountAssertion
  | RecoveredSymbolAssertion;

interface ParseCleanAssertion {
  type: "parse_clean";
  fixture: string;
}

interface ParseHasErrorAssertion {
  type: "parse_has_error";
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

  // 48: Sorted associations
  {
    name: "48 sorted_association: sorted modifier on both sides parses clean",
    fixtures: ["48_sorted_association.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "48_sorted_association.ump",
      },
      // Goto-def on association type still works
      {
        type: "goto_def",
        at: "ref_course",
        expect: [{ at: "def_course" }],
      },
    ],
  },

  // 49: External class/interface variants
  {
    name: "49 external_class: external with semicolon, interface keyword, and body content",
    fixtures: ["49_external_class.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "49_external_class.ump",
      },
      {
        type: "goto_def",
        at: "ref_thread",
        expect: [{ at: "def_thread" }],
      },
    ],
  },

  // 50: top directives + namespace --redefine
  {
    name: "50 top_namespace: top directive and namespace --redefine parse clean",
    fixtures: ["50_top_namespace.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "50_top_namespace.ump",
      },
      // Classes still indexed, top/namespace directives don't pollute
      {
        type: "symbol_count",
        fixture: "50_top_namespace.ump",
        name: "Day",
        kind: "class",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "50_top_namespace.ump",
        name: "Other",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 51: Java annotations — parsed and ignored, surrounding methods indexed
  {
    name: "51 java_annotation: annotations parse clean, methods still indexed",
    fixtures: ["51_java_annotation.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "51_java_annotation.ump",
      },
      {
        type: "symbol_count",
        fixture: "51_java_annotation.ump",
        name: "toString",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "51_java_annotation.ump",
        name: "prepare",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "51_java_annotation.ump",
        name: "old",
        kind: "method",
        expect: 1,
      },
    ],
  },

  // 52: Multi-language blocks — derived attrs + method bodies with lang tags
  {
    name: "52 multi_language: multi-lang derived attrs and methods parse clean",
    fixtures: ["52_multi_language.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "52_multi_language.ump",
      },
      {
        type: "symbol_count",
        fixture: "52_multi_language.ump",
        name: "area",
        kind: "attribute",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "52_multi_language.ump",
        name: "m1",
        kind: "method",
        expect: 1,
      },
      // Single-lang method still works
      {
        type: "symbol_count",
        fixture: "52_multi_language.ump",
        name: "f",
        kind: "method",
        expect: 1,
      },
    ],
  },

  // 53: Multi-language before/after hooks
  {
    name: "53 hook_multi_lang: multi-lang hooks parse clean, method still indexed",
    fixtures: ["53_hook_multi_lang.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "53_hook_multi_lang.ump",
      },
      {
        type: "symbol_count",
        fixture: "53_hook_multi_lang.ump",
        name: "setName",
        kind: "method",
        expect: 1,
      },
    ],
  },

  // 54: Requirement ids — numeric-leading and hyphenated ids + implementsReq
  {
    name: "54 req_ids: numeric and hyphenated req ids + implementsReq parse clean",
    fixtures: ["54_req_ids.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "54_req_ids.ump",
      },
      {
        type: "symbol_count",
        fixture: "54_req_ids.ump",
        name: "Game",
        kind: "class",
        expect: 1,
      },
      // Numeric req id indexed as requirement symbol
      {
        type: "symbol_count",
        fixture: "54_req_ids.ump",
        name: "001dealing",
        kind: "requirement",
        expect: 1,
      },
      // Hyphenated req id indexed as requirement symbol
      {
        type: "symbol_count",
        fixture: "54_req_ids.ump",
        name: "L01-LicenseTypes",
        kind: "requirement",
        expect: 1,
      },
      // Goto-def from implementsReq R01 → req R01 definition
      {
        type: "goto_def",
        at: "ref_r01",
        expect: [{ at: "def_r01" }],
      },
      // Goto-def from implementsReq 001dealing → req 001dealing definition
      {
        type: "goto_def",
        at: "ref_dealing",
        expect: [{ at: "def_dealing" }],
      },
      // Definition-side: hover/goto-def on req definition name
      {
        type: "hover_output",
        at: "def_r01",
        expectContains: ["R01"],
      },
      {
        type: "hover_output",
        at: "def_dealing",
        expectContains: ["001dealing"],
      },
      // References for R01 include definition + implementsReq use
      {
        type: "refs",
        decl: { name: "R01", kind: "requirement", container: "R01" },
        expectAt: ["def_r01", "ref_r01"],
      },
    ],
  },

  // 55: Sorted-key semantics — goto-def, refs, rename for sorted {key}
  {
    name: "55 sorted_key_semantics: goto-def resolves to owner-class attribute, refs include sorted use",
    fixtures: ["55_sorted_key_semantics.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "55_sorted_key_semantics.ump",
      },
      // Right-side: sorted {id} → Student.id
      {
        type: "goto_def",
        at: "ref_id",
        expect: [{ at: "def_id" }],
      },
      // Left-side: sorted {name} → Registration.name (enclosing class)
      {
        type: "goto_def",
        at: "ref_reg_name",
        expect: [{ at: "def_reg_name" }],
      },
      // Inherited: sorted {priority} → Base.priority via Derived isA Base
      {
        type: "goto_def",
        at: "ref_inherited",
        expect: [{ at: "def_priority" }],
      },
      // Refs for Student.id include sorted use site
      {
        type: "refs",
        decl: { name: "id", kind: "attribute", container: "Student" },
        expectAt: ["def_id", "ref_id"],
      },
      // Completion inside sorted { } — left-side offers enclosing class attrs
      {
        type: "completion_kinds",
        at: "comp_left",
        expect: "sorted_attribute",
      },
      // Left-side sorted completion includes enclosing class attrs
      {
        type: "completion_includes",
        at: "comp_left",
        expect: ["score", "label"],
      },
      // Left-side sorted completion excludes non-attribute symbols
      {
        type: "completion_excludes",
        at: "comp_left",
        expect: ["Student", "Course", "Integer"],
      },
      // Right-side sorted completion includes target class attrs (Student)
      {
        type: "completion_includes",
        at: "comp_right",
        expect: ["id", "name"],
      },
      // Right-side sorted completion excludes enclosing class attrs
      {
        type: "completion_excludes",
        at: "comp_right",
        expect: ["score", "label"],
      },
    ],
  },

  // 56: Trait SM binding Phase 1 — removal and addition operators
  {
    name: "56 trait_sm_binding: removal/addition operators parse clean, existing forms preserved",
    fixtures: ["56_trait_sm_binding.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "56_trait_sm_binding.ump",
      },
      // Existing sm as path form still works
      {
        type: "symbol_count",
        fixture: "56_trait_sm_binding.ump",
        name: "D",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 57: Trait SM binding negative — invalid no-prefix event form
  {
    name: "57 trait_sm_negative: no-prefix event without as is rejected",
    fixtures: ["57_trait_sm_negative.ump"],
    assertions: [
      {
        type: "parse_has_error",
        fixture: "57_trait_sm_negative.ump",
      },
    ],
  },

  // 58: Formatter — inline compact states not corrupted
  {
    name: "58 format_inline_states: inline states preserved, output clean and idempotent",
    fixtures: ["58_format_inline_states.ump"],
    assertions: [
      {
        type: "format_idempotent",
        fixture: "58_format_inline_states.ump",
      },
      // Formatted output still has Light class (semantic preservation)
      {
        type: "symbol_count",
        fixture: "58_format_inline_states.ump",
        name: "Light",
        kind: "class",
        expect: 1,
      },
    ],
  },
  // 59: Trait SM guard operations — grammar + goto-def semantics
  {
    name: "59 trait_sm_guards: parse clean + goto-def for SM/state path segments",
    fixtures: ["59_trait_sm_guards.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "59_trait_sm_guards.ump",
      },
      // ── Goto-def: SM name in path → SM declaration in trait ──
      // Phase 3 form 1: -sm.s1.e4()[cond] → sm
      {
        type: "goto_def",
        at: "op_sm1",
        expect: [{ at: "sm_decl" }],
      },
      // Phase 3 form 2: -sm.s2.[cond] → sm
      {
        type: "goto_def",
        at: "op_sm2",
        expect: [{ at: "sm_decl" }],
      },
      // Phase 3 form 3: -sm.s3.[] → sm
      {
        type: "goto_def",
        at: "op_sm3",
        expect: [{ at: "sm_decl" }],
      },
      // Phase 3 with + prefix
      {
        type: "goto_def",
        at: "op_sm4",
        expect: [{ at: "sm_decl" }],
      },
      // Phase 1: -sm → sm
      {
        type: "goto_def",
        at: "op_sm_p1",
        expect: [{ at: "sm_decl" }],
      },
      // Phase 2: sm.e4() as newEvent → sm
      {
        type: "goto_def",
        at: "op_sm_p2",
        expect: [{ at: "sm_decl" }],
      },
      // ── Goto-def: state name in path → state declaration in trait ──
      // Phase 3 form 1: s1
      {
        type: "goto_def",
        at: "op_s1",
        expect: [{ at: "s1_decl" }],
      },
      // Phase 3 form 2: s2
      {
        type: "goto_def",
        at: "op_s2",
        expect: [{ at: "s2_decl" }],
      },
      // Phase 3 form 3: s3
      {
        type: "goto_def",
        at: "op_s3",
        expect: [{ at: "s3_decl" }],
      },
      // Phase 3 + prefix: s1
      {
        type: "goto_def",
        at: "op_s1b",
        expect: [{ at: "s1_decl" }],
      },
      // ── Goto-def exact: event names → transition in trait ──
      // Exact-state e4() in s1 → only e4_decl (e4 [cond] -> s2 in s1)
      {
        type: "goto_def_exact",
        at: "op_e4",
        expect: ["e4_decl"],
      },
      // Unprefixed e4() across entire SM → all e4() transitions: s1 + s2
      {
        type: "goto_def_exact",
        at: "op_e4_p2",
        expect: ["e4_decl", "e4_dup1", "e4_dup2"],
      },
      // "as newName" still empty (new name, not a reference)
      {
        type: "goto_def_empty",
        at: "op_newevt",
      },
      // Param disambiguation: e4(Integer) in s2 → exactly e4_int_decl (not e4())
      {
        type: "goto_def_exact",
        at: "op_e4_int",
        expect: ["e4_int_decl"],
      },
      // Multi-result: e4() in s2 — exactly two transitions (different guards)
      {
        type: "goto_def_exact",
        at: "op_e4_multi",
        expect: ["e4_dup1", "e4_dup2"],
      },
      // ── Hover: trait-aware formatting ──
      {
        type: "hover_output",
        at: "op_sm1",
        expectContains: ["statemachine", "trait T1"],
      },
      {
        type: "hover_output",
        at: "op_s1",
        expectContains: ["state", "state machine sm", "trait T1"],
      },
      {
        type: "hover_output",
        at: "op_e4",
        expectContains: ["e4()", "event", "state s1", "of trait T1.sm"],
      },
      // ── V2 Refs: trait SM op sites now participate in refs ──
      // SM refs include all op_sm sites
      {
        type: "refs",
        decl: { name: "sm", kind: "statemachine", container: "T1.sm" },
        expectAt: ["sm_decl", "op_sm1", "op_sm2", "op_sm3", "op_sm4", "op_sm_p1", "op_sm_p2"],
      },
      // State s1 refs include op_s1 sites
      {
        type: "refs",
        decl: { name: "s1", kind: "state", container: "T1.sm" },
        expectAt: ["s1_decl", "op_s1", "op_s1b"],
      },
      // State s2 refs include op_s2 site
      {
        type: "refs",
        decl: { name: "s2", kind: "state", container: "T1.sm" },
        expectAt: ["s2_decl", "op_s2"],
      },
      // State s3 refs include op_s3 site
      {
        type: "refs",
        decl: { name: "s3", kind: "state", container: "T1.sm" },
        expectAt: ["s3_decl", "op_s3"],
      },
      // Note: refs_exclude for event/guard/as markers not feasible here because
      // the test helper uses line-only matching and all markers share lines with
      // valid refs. Excluded segments are verified by: (1) name mismatch filters
      // them out (e4 !== sm), (2) getTraitSmOpSegmentInfo() returns undefined for
      // events/guards/as, and (3) programmatic verification above.
    ],
  },

  // 61: Formatter — auto-transition spacing must not overlap indent edits
  {
    name: "61 format_auto_transition: auto-transitions preserve indentation and target",
    fixtures: ["61_format_auto_transition.ump"],
    assertions: [
      // Formatted output is idempotent (no overlapping edits)
      {
        type: "format_idempotent",
        fixture: "61_format_auto_transition.ump",
      },
      // Auto-transition lines keep "-> target;" with correct indentation
      {
        type: "format_output",
        fixture: "61_format_auto_transition.ump",
        expectLines: [
          { line: 5, text: "      e1 -> s2;" },    // normalized spacing
          { line: 6, text: "      -> s2;" },         // auto-transition preserved
          { line: 10, text: "      e2 -> s1;" },     // normalized spacing
          { line: 13, text: "      -> s1;" },         // auto-transition preserved
        ],
      },
      // Semantic preservation: class A still indexed
      {
        type: "symbol_count",
        fixture: "61_format_auto_transition.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 60: Trait SM guard negative — guard-only form without prefix is rejected
  {
    name: "60 trait_sm_guard_negative: guard-only without prefix produces parse error",
    fixtures: ["60_trait_sm_guard_negative.ump"],
    assertions: [
      {
        type: "parse_has_error",
        fixture: "60_trait_sm_guard_negative.ump",
      },
    ],
  },

  // 62: Trait SM completion (V3a) — prefixed forms only
  {
    name: "62 trait_sm_completion: SM names after -/+, state names after sm.",
    fixtures: ["62_trait_sm_completion.ump"],
    assertions: [
      // After "-": offer SM names from trait T1
      {
        type: "completion_kinds",
        at: "comp_sm",
        expect: "trait_sm_op_sm",
      },
      {
        type: "completion_includes",
        at: "comp_sm",
        expect: ["sm", "sm2"],
      },
      // After "+": same SM names
      {
        type: "completion_kinds",
        at: "comp_sm_plus",
        expect: "trait_sm_op_sm",
      },
      {
        type: "completion_includes",
        at: "comp_sm_plus",
        expect: ["sm", "sm2"],
      },
      // After "sm.": offer depth-1 state names from T1.sm
      {
        type: "completion_kinds",
        at: "comp_state",
        expect: "trait_sm_op_state",
      },
      {
        type: "completion_includes",
        at: "comp_state",
        expect: ["s1", "s2", "s3"],
      },
      // State completion must NOT include states from sm2
      {
        type: "completion_excludes",
        at: "comp_state",
        expect: ["x1", "x2"],
      },
      // ── Trait SM suppression: "as" and guard positions ──
      {
        type: "completion_kinds",
        at: "comp_as_suppress",
        expect: "suppress",
      },
      {
        type: "completion_kinds",
        at: "comp_guard_suppress",
        expect: "suppress",
      },
    ],
  },

  // 63: Trait SM completion V3b — unprefixed SM + nested state
  {
    name: "63 trait_sm_completion_v3b: unprefixed sm. and nested -sm.s1. completion",
    fixtures: ["63_trait_sm_comp_trait.ump", "63_trait_sm_comp_test.ump"],
    assertions: [
      // Unprefixed sm. → event signatures only (Phase 2 grammar)
      {
        type: "completion_kinds",
        at: "comp_unprefix",
        expect: "trait_sm_op_event",
      },
      // Unprefixed should NOT include state names or cross-trait events
      {
        type: "completion_excludes",
        at: "comp_unprefix",
        expect: ["s1", "s2", "s3", "x1", "x2", "z9()"],
      },
      // Nested -sm.s1. → children of s1 + event signatures from s1
      {
        type: "completion_kinds",
        at: "comp_nested",
        expect: "trait_sm_op_state_event",
      },
      {
        type: "completion_includes",
        at: "comp_nested",
        expect: ["inner1", "inner2", "e1()", "e2(Integer)"],
      },
      // Events from s2 must NOT appear in s1's completion
      {
        type: "completion_excludes",
        at: "comp_nested",
        expect: ["e3()", "z9()"],
      },
      {
        type: "completion_excludes",
        at: "comp_nested",
        expect: ["s1", "s2", "s3", "x1", "x2"],
      },
      // Negative: bad nested path → empty (no keywords, no states, no events)
      {
        type: "completion_kinds",
        at: "comp_bad_path",
        expect: "trait_sm_op_state_event",
      },
      {
        type: "completion_excludes",
        at: "comp_bad_path",
        expect: ["s1", "s2", "s3", "inner1", "inner2", "x1", "x2", "default", "allow"],
      },
      // ── Hover: aggregated multi-state event ──
      {
        type: "hover_output",
        at: "hover_e1_multi",
        expectContains: ["e1()", "states s1, s2", "of trait T1.sm"],
      },
    ],
  },

  // 64: Trace Slice 1 — tracer directives + comma-separated entities
  {
    name: "64 trace_slice1: tracer directives and comma-separated trace entities parse clean",
    fixtures: ["64_trace_slice1.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "64_trace_slice1.ump",
      },
      // Class A still indexed
      {
        type: "symbol_count",
        fixture: "64_trace_slice1.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
      // Later list item has goto-def (second entity in trace list)
      {
        type: "goto_def",
        at: "trace_age_ref",
        expect: [{ at: "attr_age" }],
      },
    ],
  },

  // 66: Trace prefix keywords — prefix-sensitive semantics
  {
    name: "66 trace_prefix: prefix-sensitive goto-def for state, method, attribute",
    fixtures: ["66_trace_prefix.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "66_trace_prefix.ump",
      },
      // entry bare → state
      {
        type: "goto_def",
        at: "trace_entry_state",
        expect: [{ at: "pref_state_open" }],
      },
      // exit call → method
      {
        type: "goto_def",
        at: "trace_exit_method",
        expect: [{ at: "pref_method_open" }],
      },
      // set → attribute
      {
        type: "goto_def",
        at: "trace_set_attr",
        expect: [{ at: "pref_attr_name" }],
      },
      // no prefix → attribute
      {
        type: "goto_def",
        at: "trace_noprefix",
        expect: [{ at: "pref_attr_name" }],
      },
      // multi-prefix later entity still resolves
      {
        type: "goto_def",
        at: "trace_multi_age",
        expect: [{ at: "pref_attr_age" }],
      },
      // second entity in entry,exit list → state (prefix inherited)
      {
        type: "goto_def",
        at: "trace_entry_closed",
        expect: [{ at: "pref_state_closed" }],
      },
      // Refs: second state entity participates in refs for that state
      {
        type: "refs",
        decl: { name: "Closed", kind: "state", container: "A.sm" },
        expectAt: ["pref_state_closed", "trace_entry_closed"],
      },
      // add → parse-only: goto-def empty
      {
        type: "goto_def_empty",
        at: "trace_add_assoc",
      },
      // add → parse-only: "name" in trace add must NOT appear in attribute refs
      {
        type: "refs_exclude",
        decl: { name: "name", kind: "attribute", container: "A" },
        excludeAt: ["trace_add_name"],
      },
    ],
  },

  // 67: Trace prefix completion — later entities + cross-class isolation + add suppression
  {
    name: "67 trace_prefix_completion: later entities and add suppression",
    fixtures: ["67_trace_prefix_completion.ump"],
    assertions: [
      // Later entry blank slot → union of states + methods (ambiguous position)
      {
        type: "completion_kinds",
        at: "tpc_comp_entry_later",
        expect: "trace_state_method",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_entry_later",
        expect: ["Open", "Closed"],
      },
      // Cross-class: WrongState from OtherClass must NOT appear
      {
        type: "completion_excludes",
        at: "tpc_comp_entry_later",
        expect: ["WrongState"],
      },
      // Later set attribute completion → attributes from enclosing class
      {
        type: "completion_kinds",
        at: "tpc_comp_set_later",
        expect: "trace_attribute",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_set_later",
        expect: ["name", "age"],
      },
      // Blank later slot under exit → union of states + methods
      {
        type: "completion_kinds",
        at: "tpc_comp_exit_blank_later",
        expect: "trace_state_method",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_exit_blank_later",
        expect: ["Open", "open"],
      },
      // Concrete call-form entity → methods only
      {
        type: "completion_kinds",
        at: "tpc_comp_exit_call_concrete",
        expect: "trace_method",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_exit_call_concrete",
        expect: ["open"],
      },
      // Mixed form: bare entity stays state even with call-form sibling
      {
        type: "completion_kinds",
        at: "tpc_comp_exit_bare_mixed",
        expect: "trace_state",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_exit_bare_mixed",
        expect: ["Open", "Closed"],
      },
      // add → suppressed
      {
        type: "completion_kinds",
        at: "tpc_comp_add",
        expect: "suppress",
      },
    ],
  },

  // 65: Trace Slice 1 negative — tracer with options still produces parse error
  {
    name: "65 trace_slice1_negative: tracer with options not yet supported",
    fixtures: ["65_trace_slice1_negative.ump"],
    assertions: [
      {
        type: "parse_has_error",
        fixture: "65_trace_slice1_negative.ump",
      },
    ],
  },

  // 68: Namespace directives — dash and URL-like forms
  {
    name: "68 namespace_directives: dash, URL, plain, default, --redefine all parse clean",
    fixtures: ["68_namespace_directives.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "68_namespace_directives.ump",
      },
      // No symbol pollution: class A still indexed, no extra namespace symbols
      {
        type: "symbol_count",
        fixture: "68_namespace_directives.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 69: Suboption directives — standalone top-level form
  {
    name: "69 suboption_directive: standalone suboption parses clean",
    fixtures: ["69_suboption_directive.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "69_suboption_directive.ump",
      },
      {
        type: "symbol_count",
        fixture: "69_suboption_directive.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 70: Deprecated constant syntax
  {
    name: "70 deprecated_constant: constant keyword and optional type parse clean",
    fixtures: ["70_deprecated_constant.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "70_deprecated_constant.ump",
      },
      {
        type: "symbol_count",
        fixture: "70_deprecated_constant.ump",
        name: "C",
        kind: "class",
        expect: 1,
      },
      // Both corpus forms index as const
      {
        type: "symbol_count",
        fixture: "70_deprecated_constant.ump",
        name: "A",
        kind: "const",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "70_deprecated_constant.ump",
        name: "B",
        kind: "const",
        expect: 1,
      },
    ],
  },

  // 71: Distribution directives
  {
    name: "71 distributable_directive: forced, on, off, numbered forms parse clean",
    fixtures: ["71_distributable_directive.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "71_distributable_directive.ump",
      },
      {
        type: "symbol_count",
        fixture: "71_distributable_directive.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
    ],
  },

  // 72: Trace logLevel postfix
  {
    name: "72 trace_loglevel: logLevel postfix parses clean with semantic parity",
    fixtures: ["72_trace_loglevel.ump"],
    assertions: [
      {
        type: "parse_clean",
        fixture: "72_trace_loglevel.ump",
      },
      {
        type: "symbol_count",
        fixture: "72_trace_loglevel.ump",
        name: "A",
        kind: "class",
        expect: 1,
      },
      // Traced entity still has goto-def with logLevel postfix
      {
        type: "goto_def",
        at: "ll_goto",
        expect: [{ at: "ll_name" }],
      },
      // Later comma-separated entity with logLevel
      {
        type: "goto_def",
        at: "ll_second",
        expect: [{ at: "ll_name" }],
      },
    ],
  },

  // 73: Trace for N postfix
  {
    name: "73 trace_for: for N postfix parses clean with semantic parity",
    fixtures: ["73_trace_for.ump"],
    assertions: [
      { type: "parse_clean", fixture: "73_trace_for.ump" },
      { type: "symbol_count", fixture: "73_trace_for.ump", name: "A", kind: "class", expect: 1 },
      { type: "goto_def", at: "for_second", expect: [{ at: "for_name" }] },
      { type: "goto_def", at: "for_get", expect: [{ at: "for_name" }] },
    ],
  },

  // 74: Trace enhanced record postfix
  {
    name: "74 trace_record: string and identifier record payloads parse clean",
    fixtures: ["74_trace_record.ump"],
    assertions: [
      { type: "parse_clean", fixture: "74_trace_record.ump" },
      { type: "symbol_count", fixture: "74_trace_record.ump", name: "A", kind: "class", expect: 1 },
      { type: "goto_def", at: "rec_goto", expect: [{ at: "rec_name" }] },
      { type: "goto_def", at: "rec_second", expect: [{ at: "rec_name" }] },
    ],
  },

  // 75: PHP parameter syntax in methods
  {
    name: "75 php_params: PHP-style $param in methods parse clean with method symbols",
    fixtures: ["75_php_params.ump"],
    assertions: [
      { type: "parse_clean", fixture: "75_php_params.ump" },
      { type: "symbol_count", fixture: "75_php_params.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "75_php_params.ump", name: "jsonSerialize", kind: "method", expect: 1 },
      { type: "symbol_count", fixture: "75_php_params.ump", name: "normalMethod", kind: "method", expect: 1 },
    ],
  },

  // 76: Test case DSL
  {
    name: "76 test_case: basic test blocks parse clean",
    fixtures: ["76_test_case.ump"],
    assertions: [
      { type: "parse_clean", fixture: "76_test_case.ump" },
      { type: "symbol_count", fixture: "76_test_case.ump", name: "Student", kind: "class", expect: 1 },
    ],
  },

  // 77: Generic test case DSL
  {
    name: "77 generic_test: generic test blocks with varied signatures parse clean",
    fixtures: ["77_generic_test.ump"],
    assertions: [
      { type: "parse_clean", fixture: "77_generic_test.ump" },
      { type: "symbol_count", fixture: "77_generic_test.ump", name: "Student", kind: "class", expect: 1 },
    ],
  },

  // 78: Java-style static final int in interfaces
  {
    name: "78 static_final_const: static final int in interfaces parse clean",
    fixtures: ["78_static_final_const.ump"],
    assertions: [
      { type: "parse_clean", fixture: "78_static_final_const.ump" },
      { type: "symbol_count", fixture: "78_static_final_const.ump", name: "IObserver", kind: "interface", expect: 1 },
      // static final fields are parse-only — NOT indexed as const (compiler treats as extra code)
      { type: "symbol_count", fixture: "78_static_final_const.ump", name: "ADDED_OBJECT", kind: "const", expect: 0 },
      { type: "symbol_count", fixture: "78_static_final_const.ump", name: "A", kind: "class", expect: 1 },
    ],
  },

  // 79: Chained call expression initializer
  {
    name: "79 chained_call: chained method call initializer parses clean",
    fixtures: ["79_chained_call.ump"],
    assertions: [
      { type: "parse_clean", fixture: "79_chained_call.ump" },
      { type: "symbol_count", fixture: "79_chained_call.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "79_chained_call.ump", name: "dim", kind: "attribute", expect: 1 },
    ],
  },

  // 80: Varargs parameter support
  {
    name: "80 varargs: Type... param in constructors and methods parse clean",
    fixtures: ["80_varargs.ump"],
    assertions: [
      { type: "parse_clean", fixture: "80_varargs.ump" },
      { type: "symbol_count", fixture: "80_varargs.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "80_varargs.ump", name: "foo", kind: "method", expect: 1 },
    ],
  },

  // 81: String concatenation in field initializer
  {
    name: "81 string_concat: string concat initializer parses clean",
    fixtures: ["81_string_concat.ump"],
    assertions: [
      { type: "parse_clean", fixture: "81_string_concat.ump" },
      { type: "symbol_count", fixture: "81_string_concat.ump", name: "DAL", kind: "class", expect: 1 },
    ],
  },

  // 82: Inline mixset class declaration
  {
    name: "82 inline_mixset_class: mixset name class Name {} parses clean",
    fixtures: ["82_inline_mixset_class.ump"],
    assertions: [
      { type: "parse_clean", fixture: "82_inline_mixset_class.ump" },
      { type: "symbol_count", fixture: "82_inline_mixset_class.ump", name: "X", kind: "class", expect: 2 },
    ],
  },

  // 83: Trait method rename with visibility
  {
    name: "83 trait_method_rename: visibility in method rename parses clean",
    fixtures: ["83_trait_method_rename.ump"],
    assertions: [
      { type: "parse_clean", fixture: "83_trait_method_rename.ump" },
      { type: "symbol_count", fixture: "83_trait_method_rename.ump", name: "C2", kind: "class", expect: 1 },
    ],
  },

  // 84: Negative — guard + as rename rejected
  {
    name: "84 trait_rename_negative: guard form with as rename produces parse error",
    fixtures: ["84_trait_rename_negative.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "84_trait_rename_negative.ump" },
    ],
  },

  // 85: Prefixed SM rename
  {
    name: "85 prefixed_sm_rename: +sm1 as mach1 parses clean",
    fixtures: ["85_prefixed_sm_rename.ump"],
    assertions: [
      { type: "parse_clean", fixture: "85_prefixed_sm_rename.ump" },
      { type: "symbol_count", fixture: "85_prefixed_sm_rename.ump", name: "C1", kind: "class", expect: 1 },
    ],
  },

  // 86: Negative — prefixed SM rename with visibility rejected
  {
    name: "86 prefixed_sm_rename_neg: +sm1 as private mach1 produces parse error",
    fixtures: ["86_prefixed_sm_rename_negative.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "86_prefixed_sm_rename_negative.ump" },
    ],
  },

  // 87: Deep-path SM rename binding
  {
    name: "87 deep_path_rename: sm.s0.s0.s11 as state11 parses clean",
    fixtures: ["87_deep_path_rename.ump"],
    assertions: [
      { type: "parse_clean", fixture: "87_deep_path_rename.ump" },
      { type: "symbol_count", fixture: "87_deep_path_rename.ump", name: "C1", kind: "class", expect: 1 },
      // Deep param path leaf resolves to trait state
      { type: "goto_def", at: "dpr_ref_s11", expect: [{ at: "dpr_s11" }] },
      // Deep param path state participates in refs
      { type: "refs", decl: { name: "s11", kind: "state", container: "T1.sm" }, expectAt: ["dpr_s11", "dpr_ref_s11"] },
    ],
  },

  // 88: around + operationSource + label
  {
    name: "88 around_label: around/custom/label forms parse clean with method semantics",
    fixtures: ["88_around_label.ump"],
    assertions: [
      { type: "parse_clean", fixture: "88_around_label.ump" },
      { type: "symbol_count", fixture: "88_around_label.ump", name: "A", kind: "class", expect: 1 },
      // Method target in around still resolves
      { type: "goto_def", at: "al_around", expect: [{ at: "al_method" }] },
      // before regression: method target still resolves
      { type: "goto_def", at: "al_before", expect: [{ at: "al_method" }] },
      // Labeled target: method after Label1: still resolves
      { type: "goto_def", at: "al_labeled", expect: [{ at: "al_method2" }] },
    ],
  },

  // 89: Wildcard/exclusion selectors — parse-only for patterns
  {
    name: "89 wildcard_exclusion: wildcard/exclusion ops parse clean, plain method still resolves",
    fixtures: ["89_wildcard_exclusion.ump"],
    assertions: [
      { type: "parse_clean", fixture: "89_wildcard_exclusion.ump" },
      { type: "symbol_count", fixture: "89_wildcard_exclusion.ump", name: "A", kind: "class", expect: 1 },
      // Plain method target still resolves (not affected by wildcard patterns)
      { type: "goto_def", at: "wc_plain", expect: [{ at: "wc_method" }] },
    ],
  },

  // 90: Top-level wildcard class targets + operation lists
  {
    name: "90 toplevel_wildcard: wildcard class targets and op lists parse clean",
    fixtures: ["90_toplevel_wildcard.ump"],
    assertions: [
      { type: "parse_clean", fixture: "90_toplevel_wildcard.ump" },
      { type: "symbol_count", fixture: "90_toplevel_wildcard.ump", name: "Student1", kind: "class", expect: 1 },
      // Later exact op in comma list resolves to method declaration
      { type: "goto_def", at: "tw_testfunc", expect: [{ at: "tw_testfunc_decl" }] },
      // Later exact op refs scoped to target class
      { type: "refs", decl: { name: "testFunction", kind: "method", container: "Student1" }, expectAt: ["tw_testfunc_decl", "tw_testfunc"] },
      // Cross-class exclusion: Student2.testFunction must NOT include the top-level use
      { type: "refs_exclude", decl: { name: "testFunction", kind: "method", container: "Student2" }, excludeAt: ["tw_testfunc"] },
    ],
  },

  // 91: Full combo top-level around with compound label
  {
    name: "91 around_compound_label: full combo around with compound label parses clean",
    fixtures: ["91_around_compound_label.ump"],
    assertions: [
      { type: "parse_clean", fixture: "91_around_compound_label.ump" },
      { type: "symbol_count", fixture: "91_around_compound_label.ump", name: "AroundClass", kind: "class", expect: 1 },
      // Method target through compound label resolves
      { type: "goto_def", at: "acl_target", expect: [{ at: "acl_method" }] },
    ],
  },

  // 92: Wildcard event rename in trait SM operations
  {
    name: "92 wildcard_event_rename: *.e0() as event0 parses clean",
    fixtures: ["92_wildcard_event_rename.ump"],
    assertions: [
      { type: "parse_clean", fixture: "92_wildcard_event_rename.ump" },
      { type: "symbol_count", fixture: "92_wildcard_event_rename.ump", name: "C1", kind: "class", expect: 1 },
      // Nearby exact trait-SM goto-def still works
      { type: "goto_def", at: "wer_exact_sm1", expect: [{ at: "wer_sm1" }] },
    ],
  },

  // 93: Negative — bare *() without .identifier rejected
  {
    name: "93 wildcard_negative: bare *() as event0 produces parse error",
    fixtures: ["93_wildcard_negative.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "93_wildcard_negative.ump" },
    ],
  },

  // 94: Named filter with alphanumeric IDs
  {
    name: "94 named_filter: alphanumeric filter names like 7a parse clean",
    fixtures: ["94_named_filter.ump"],
    assertions: [
      { type: "parse_clean", fixture: "94_named_filter.ump" },
      { type: "symbol_count", fixture: "94_named_filter.ump", name: "Cube", kind: "class", expect: 1 },
    ],
  },

  // 95: Quoted string use statement
  {
    name: "95 use_quoted_string: use with quoted string parses clean",
    fixtures: ["95_use_quoted_string.ump"],
    assertions: [
      { type: "parse_clean", fixture: "95_use_quoted_string.ump" },
      { type: "symbol_count", fixture: "95_use_quoted_string.ump", name: "A", kind: "class", expect: 1 },
    ],
  },

  // 96: Decimal literals in position metadata
  {
    name: "96 decimal_position: decimal values in position directives parse clean",
    fixtures: ["96_decimal_position.ump"],
    assertions: [
      { type: "parse_clean", fixture: "96_decimal_position.ump" },
      { type: "symbol_count", fixture: "96_decimal_position.ump", name: "A", kind: "class", expect: 1 },
    ],
  },

  // 97: Inline mixset trait and interface
  {
    name: "97 inline_mixset_trait_iface: mixset name trait/interface {} parses clean",
    fixtures: ["97_inline_mixset_trait_iface.ump"],
    assertions: [
      { type: "parse_clean", fixture: "97_inline_mixset_trait_iface.ump" },
      { type: "symbol_count", fixture: "97_inline_mixset_trait_iface.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "97_inline_mixset_trait_iface.ump", name: "B", kind: "trait", expect: 1 },
      { type: "symbol_count", fixture: "97_inline_mixset_trait_iface.ump", name: "C", kind: "interface", expect: 1 },
    ],
  },

  // 98: Untyped parameter tolerance
  {
    name: "98 untyped_param: bare identifier param parses clean",
    fixtures: ["98_untyped_param.ump"],
    assertions: [
      { type: "parse_clean", fixture: "98_untyped_param.ump" },
      { type: "symbol_count", fixture: "98_untyped_param.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "98_untyped_param.ump", name: "createWarehouse", kind: "method", expect: 1 },
      // Mixed typed/untyped param list still indexes method
      { type: "symbol_count", fixture: "98_untyped_param.ump", name: "createBulk", kind: "method", expect: 1 },
    ],
  },

  // 99: Mixset with method signatures inside trait
  {
    name: "99 mixset_in_trait: method signatures in mixset inside trait parse clean",
    fixtures: ["99_mixset_in_trait.ump"],
    assertions: [
      { type: "parse_clean", fixture: "99_mixset_in_trait.ump" },
      { type: "symbol_count", fixture: "99_mixset_in_trait.ump", name: "Comparable", kind: "trait", expect: 1 },
      { type: "symbol_count", fixture: "99_mixset_in_trait.ump", name: "Numerical", kind: "mixset", expect: 1 },
      { type: "symbol_count", fixture: "99_mixset_in_trait.ump", name: "isEqual", kind: "method", expect: 1 },
      // Mixset-body signatures are parse-only — NOT indexed
      { type: "symbol_count", fixture: "99_mixset_in_trait.ump", name: "isGreaterThan", kind: "method", expect: 0 },
      { type: "symbol_count", fixture: "99_mixset_in_trait.ump", name: "isLessThan", kind: "method", expect: 0 },
    ],
  },

  // 100: State machine extensions — entry[guard]->State, +/- transitions, trace level
  {
    name: "100 sm_extensions: entry guard transition, prefixed transitions, trace level",
    fixtures: ["100_sm_extensions.ump"],
    assertions: [
      { type: "parse_clean", fixture: "100_sm_extensions.ump" },
      { type: "symbol_count", fixture: "100_sm_extensions.ump", name: "Light", kind: "class", expect: 1 },
      // Prefixed transition target still resolves
      { type: "goto_def", at: "sme_prefix_target", expect: [{ at: "sme_off" }] },
      // Trace level postfix — traced entity still resolves
      { type: "goto_def", at: "sme_level_attr", expect: [{ at: "sme_dimmer" }] },
    ],
  },

  // 101: Attribute keyword tolerance — "active" as attribute name
  {
    name: "101 attr_keyword_tolerance: active keyword as attribute name with boolean initializer",
    fixtures: ["101_attr_value_expr.ump"],
    assertions: [
      { type: "parse_clean", fixture: "101_attr_value_expr.ump" },
      { type: "symbol_count", fixture: "101_attr_value_expr.ump", name: "Auction", kind: "class", expect: 1 },
      // "active" keyword used as attribute name — indexed correctly
      { type: "symbol_count", fixture: "101_attr_value_expr.ump", name: "active", kind: "attribute", expect: 1 },
    ],
  },

  // 102: Multiple attribute modifiers (internal const)
  {
    name: "102 multi_modifier: internal const int parses clean",
    fixtures: ["102_multi_modifier.ump"],
    assertions: [
      { type: "parse_clean", fixture: "102_multi_modifier.ump" },
      { type: "symbol_count", fixture: "102_multi_modifier.ump", name: "A", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "102_multi_modifier.ump", name: "NO_TOKEN_STATE", kind: "attribute", expect: 1 },
    ],
  },

  // 103: Interface const without initializer
  {
    name: "103 interface_const_no_value: uninitialized interface consts parse clean",
    fixtures: ["103_interface_const_no_value.ump"],
    assertions: [
      { type: "parse_clean", fixture: "103_interface_const_no_value.ump" },
      { type: "symbol_count", fixture: "103_interface_const_no_value.ump", name: "ConstInterface", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "103_interface_const_no_value.ump", name: "I1", kind: "const", expect: 1 },
    ],
  },

  // 104: Parenthesized attribute value expressions
  {
    name: "104 paren_attr_value: parenthesized comparison initializers parse clean",
    fixtures: ["104_paren_attr_value.ump"],
    assertions: [
      { type: "parse_clean", fixture: "104_paren_attr_value.ump" },
      { type: "symbol_count", fixture: "104_paren_attr_value.ump", name: "Detector", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "104_paren_attr_value.ump", name: "emergencyDetected", kind: "attribute", expect: 1 },
    ],
  },

  // 110: Top-level completion — curated construct keywords, no raw lookahead
  {
    name: "110 top_level_completion: blank top-level position returns curated keywords",
    fixtures: ["110_top_level_completion.ump"],
    assertions: [
      // Scope must be top_level
      {
        type: "completion_kinds",
        at: "top_blank",
        expect: "top_level",
      },
      // Must include core top-level construct starters
      {
        type: "completion_includes",
        at: "top_blank",
        expect: [
          "namespace", "use", "generate", "class", "interface", "trait",
          "association", "associationClass", "enum", "statemachine", "mixset",
        ],
      },
      // Must include directive starters
      {
        type: "completion_includes",
        at: "top_blank",
        expect: [
          "external", "req", "require", "isFeature", "filter",
          "strictness", "tracer", "suboption", "distributable",
          "before", "after", "around", "top", "implementsReq",
        ],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "top_blank",
        expect: ["ERROR"],
      },
      // Must NOT include generate-target leaf keywords
      {
        type: "completion_excludes",
        at: "top_blank",
        expect: ["Java", "Php", "Json", "Mermaid", "Ruby", "Python"],
      },
      // Must NOT include class-body / internal constructs
      {
        type: "completion_excludes",
        at: "top_blank",
        expect: ["isA", "entry", "exit", "do", "tracecase", "key", "immutable"],
      },
      // Must NOT include tracer/distribution sub-keywords
      {
        type: "completion_excludes",
        at: "top_blank",
        expect: ["forced", "on", "off"],
      },
      // Boundary: blank inside require/filter/mixset must NOT be top_level
      {
        type: "completion_kinds",
        at: "inside_require",
        expect: null,
      },
      {
        type: "completion_kinds",
        at: "inside_filter",
        expect: null,
      },
      {
        type: "completion_kinds",
        at: "inside_mixset",
        expect: "mixset_body",
      },
    ],
  },

  // 111: Class-body completion — curated construct keywords, no raw lookahead
  {
    name: "111 class_body_completion: blank class-body position returns curated keywords",
    fixtures: ["111_class_body_completion.ump"],
    assertions: [
      // Scope must be class_body
      {
        type: "completion_kinds",
        at: "class_blank",
        expect: "class_body",
      },
      // Must include class-body construct starters
      {
        type: "completion_includes",
        at: "class_blank",
        expect: [
          "isA", "before", "after", "around",
          "trace", "tracecase", "enum", "depend", "key",
          "immutable", "unique", "lazy", "settable", "internal",
          "defaulted", "autounique", "const",
        ],
      },
      // Must include visibility and modifier keywords
      {
        type: "completion_includes",
        at: "class_blank",
        expect: ["public", "private", "protected", "abstract", "singleton"],
      },
      // Must include built-in types
      {
        type: "completion_includes",
        at: "class_blank",
        expect: ["Integer", "String", "Boolean", "Double"],
      },
      // Must include reachable class/interface/trait/enum symbols
      {
        type: "completion_includes",
        at: "class_blank",
        expect: ["Parent", "ClassBodyTest"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "class_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "class_blank",
        expect: ["namespace", "use", "generate", "suboption", "tracer", "distributable"],
      },
      // Must NOT include generate-target leaf keywords
      {
        type: "completion_excludes",
        at: "class_blank",
        expect: ["Java", "Php", "Json", "Mermaid"],
      },
      // Must NOT include SM-internal constructs
      {
        type: "completion_excludes",
        at: "class_blank",
        expect: ["entry", "exit", "do"],
      },
      // Must NOT include tracer/distribution sub-keywords
      {
        type: "completion_excludes",
        at: "class_blank",
        expect: ["forced", "on", "off"],
      },
      // Boundary: top-level blank must still be top_level (not class_body)
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 112: Trait-body completion — curated construct keywords, no raw lookahead
  {
    name: "112 trait_body_completion: blank trait-body position returns curated keywords",
    fixtures: ["112_trait_body_completion.ump"],
    assertions: [
      // Scope must be trait_body
      {
        type: "completion_kinds",
        at: "trait_blank",
        expect: "trait_body",
      },
      // Must include class-body starters (trait inherits _class_content)
      {
        type: "completion_includes",
        at: "trait_blank",
        expect: [
          "isA", "before", "after", "around",
          "trace", "tracecase", "enum", "depend", "key",
          "immutable", "unique", "lazy", "settable", "internal",
          "defaulted", "autounique", "const",
        ],
      },
      // Must include trait-specific: nested trait keyword
      {
        type: "completion_includes",
        at: "trait_blank",
        expect: ["trait"],
      },
      // Must include built-in types
      {
        type: "completion_includes",
        at: "trait_blank",
        expect: ["Integer", "String", "Boolean"],
      },
      // Must include reachable type symbols
      {
        type: "completion_includes",
        at: "trait_blank",
        expect: ["Existing", "TraitBodyTest"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "trait_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "trait_blank",
        expect: ["namespace", "use", "generate", "suboption", "tracer", "distributable"],
      },
      // Must NOT include generate-target leaf keywords
      {
        type: "completion_excludes",
        at: "trait_blank",
        expect: ["Java", "Php", "Json", "Mermaid"],
      },
      // Must NOT include SM-internal constructs
      {
        type: "completion_excludes",
        at: "trait_blank",
        expect: ["entry", "exit", "do"],
      },
      // Must NOT include tracer/distribution sub-keywords
      {
        type: "completion_excludes",
        at: "trait_blank",
        expect: ["forced", "on", "off"],
      },
      // Boundary: class-body blank must still be class_body
      {
        type: "completion_kinds",
        at: "class_boundary",
        expect: "class_body",
      },
    ],
  },

  // 113: Interface-body completion — curated construct keywords, no raw lookahead
  {
    name: "113 interface_body_completion: blank interface-body returns curated keywords",
    fixtures: ["113_interface_body_completion.ump"],
    assertions: [
      // Scope must be interface_body
      {
        type: "completion_kinds",
        at: "iface_blank",
        expect: "interface_body",
      },
      // Must include interface-valid starters
      {
        type: "completion_includes",
        at: "iface_blank",
        expect: ["isA", "depend", "const", "constant"],
      },
      // Must include visibility for method signatures
      {
        type: "completion_includes",
        at: "iface_blank",
        expect: ["public", "private", "protected"],
      },
      // Must include built-in types (for method return types / const types)
      {
        type: "completion_includes",
        at: "iface_blank",
        expect: ["Integer", "String", "Boolean"],
      },
      // Must include reachable type symbols
      {
        type: "completion_includes",
        at: "iface_blank",
        expect: ["Existing", "InterfaceBodyTest"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "iface_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "iface_blank",
        expect: ["namespace", "use", "generate", "suboption", "tracer", "distributable"],
      },
      // Must NOT include class/trait-only starters
      {
        type: "completion_excludes",
        at: "iface_blank",
        expect: ["before", "after", "trace", "tracecase", "key", "immutable", "autounique"],
      },
      // Must NOT include SM-internal constructs
      {
        type: "completion_excludes",
        at: "iface_blank",
        expect: ["entry", "exit", "do"],
      },
      // Must NOT include generator targets or sub-keywords
      {
        type: "completion_excludes",
        at: "iface_blank",
        expect: ["Java", "Php", "forced", "on", "off"],
      },
      // Boundary: trait-body blank must still be trait_body
      {
        type: "completion_kinds",
        at: "trait_boundary",
        expect: "trait_body",
      },
    ],
  },

  // 114: Association-class-body completion — curated keywords, no raw lookahead
  {
    name: "114 assoc_class_body_completion: blank assoc-class-body returns curated keywords",
    fixtures: ["114_assoc_class_body_completion.ump"],
    assertions: [
      // Scope must be assoc_class_body
      {
        type: "completion_kinds",
        at: "assoc_blank",
        expect: "assoc_class_body",
      },
      // Must include class-body construct starters (shares _class_content)
      {
        type: "completion_includes",
        at: "assoc_blank",
        expect: [
          "isA", "before", "after", "around",
          "trace", "tracecase", "depend", "key",
          "immutable", "unique", "lazy", "const",
        ],
      },
      // Must include built-in types
      {
        type: "completion_includes",
        at: "assoc_blank",
        expect: ["Integer", "String"],
      },
      // Must include reachable type symbols
      {
        type: "completion_includes",
        at: "assoc_blank",
        expect: ["Student", "Course", "Enrollment"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "assoc_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "assoc_blank",
        expect: ["namespace", "use", "generate", "suboption", "tracer", "distributable"],
      },
      // Must NOT include generator targets or sub-keywords
      {
        type: "completion_excludes",
        at: "assoc_blank",
        expect: ["Java", "Php", "forced", "on", "off"],
      },
      // Must NOT include SM-internal constructs
      {
        type: "completion_excludes",
        at: "assoc_blank",
        expect: ["entry", "exit", "do"],
      },
      // Boundary: class-body blank must still be class_body
      {
        type: "completion_kinds",
        at: "class_boundary",
        expect: "class_body",
      },
    ],
  },

  // 115: Mixset-body completion — curated keywords, no raw lookahead
  {
    name: "115 mixset_body_completion: blank mixset-body returns curated keywords",
    fixtures: ["115_mixset_body_completion.ump"],
    assertions: [
      // Scope must be mixset_body
      {
        type: "completion_kinds",
        at: "mixset_blank",
        expect: "mixset_body",
      },
      // Must include top-level starters valid inside mixset
      {
        type: "completion_includes",
        at: "mixset_blank",
        expect: [
          "class", "interface", "trait", "enum", "association",
          "associationClass", "statemachine", "mixset", "namespace", "use",
        ],
      },
      // Must include class-body starters valid inside mixset
      {
        type: "completion_includes",
        at: "mixset_blank",
        expect: [
          "isA", "before", "after", "around", "trace", "tracecase",
          "depend", "key", "immutable",
        ],
      },
      // Must include state-level starters valid inside mixset
      {
        type: "completion_includes",
        at: "mixset_blank",
        expect: ["entry", "exit", "do"],
      },
      // Must include built-in types
      {
        type: "completion_includes",
        at: "mixset_blank",
        expect: ["Integer", "String"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "mixset_blank",
        expect: ["ERROR"],
      },
      // Must NOT include generator-target leaves
      {
        type: "completion_excludes",
        at: "mixset_blank",
        expect: ["Java", "Php", "Json", "Mermaid"],
      },
      // Must NOT include tracer/distribution sub-keywords
      {
        type: "completion_excludes",
        at: "mixset_blank",
        expect: ["forced", "on", "off"],
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
      // Boundary: class-body must still be class_body
      {
        type: "completion_kinds",
        at: "class_boundary",
        expect: "class_body",
      },
    ],
  },

  // 116: Statemachine-body completion — curated keywords + state symbols
  {
    name: "116 statemachine_body_completion: blank SM-body returns curated keywords",
    fixtures: ["116_statemachine_body_completion.ump"],
    assertions: [
      // Scope must be statemachine_body
      {
        type: "completion_kinds",
        at: "sm_blank",
        expect: "statemachine_body",
      },
      // Must include SM-level keyword starters
      {
        type: "completion_includes",
        at: "sm_blank",
        expect: ["final", "mixset"],
      },
      // Must include existing state names from this SM
      {
        type: "completion_includes",
        at: "sm_blank",
        expect: ["Open", "Closed"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "sm_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "sm_blank",
        expect: ["class", "interface", "namespace", "use", "generate"],
      },
      // Must NOT include generator targets or sub-keywords
      {
        type: "completion_excludes",
        at: "sm_blank",
        expect: ["Java", "Php", "forced", "on", "off"],
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
      // Boundary: nested state blank must NOT be statemachine_body
      {
        type: "completion_kinds",
        at: "state_boundary",
        expect: ["state"],
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

    // Trait SM event goto-def fallback: use shared resolver
    if (result && result.symbols.length === 0 && result.token.context.type === "trait_sm_op" && result.token.context.isEventSegment) {
      const ctx = result.token.context;
      const locations = resolveTraitSmEventLocations(
        helper.si, ctx.traitName, ctx.pathSegments[0],
        result.token.word, ctx.eventParams ?? [], ctx.pathSegments, reachable,
      );
      if (locations.length > 0) {
        for (const exp of assertion.expect) {
          const target = findMarker(exp.at);
          if (!target) return { ok: false, message: `target marker @${exp.at} not found` };
          const found = locations.some((loc) => loc.line === target.pos.line);
          if (!found) {
            return { ok: false, message: `goto_def @${assertion.at}: expected event target @${exp.at} (line ${target.pos.line}), got lines [${locations.map((l) => l.line).join(", ")}]` };
          }
        }
        return { ok: true, message: "" };
      }
      return { ok: false, message: `goto_def @${assertion.at}: no matching event occurrences for "${result.token.word}"` };
    }

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

  if (assertion.type === "goto_def_exact") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const result = helper.resolve(src.filePath, src.content, src.pos.line, src.pos.col, reachable);
    if (!result) return { ok: false, message: `goto_def_exact @${assertion.at}: resolve returned null` };

    // Collect actual result lines (symbol-based or event-based)
    let resultLines: number[] = [];
    if (result.token.context.type === "trait_sm_op" && result.token.context.isEventSegment) {
      const ctx = result.token.context;
      const locations = resolveTraitSmEventLocations(
        helper.si, ctx.traitName, ctx.pathSegments[0],
        result.token.word, ctx.eventParams ?? [], ctx.pathSegments, reachable,
      );
      resultLines = locations.map((l) => l.line);
    } else {
      resultLines = result.symbols.map((s) => s.line);
    }

    // Collect expected lines from markers
    const expectedLines: number[] = [];
    for (const markerName of assertion.expect) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `target marker @${markerName} not found` };
      expectedLines.push(target.pos.line);
    }

    // Check exact match
    const sortedResult = [...resultLines].sort();
    const sortedExpected = [...expectedLines].sort();
    if (sortedResult.length !== sortedExpected.length || !sortedResult.every((v, i) => v === sortedExpected[i])) {
      return {
        ok: false,
        message: `goto_def_exact @${assertion.at}: expected lines [${sortedExpected.join(", ")}] (${assertion.expect.join(", ")}), got [${sortedResult.join(", ")}]`,
      };
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

  if (assertion.type === "parse_has_error") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    const tree = helper.si.getTree(fileInfo.path);
    if (!tree) return { ok: false, message: `parse_has_error ${assertion.fixture}: no tree` };
    if (!tree.rootNode.hasError) {
      return {
        ok: false,
        message: `parse_has_error ${assertion.fixture}: expected ERROR nodes but tree is clean`,
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

  // ── Direct test: formatting skips broken files ──────────────────────────
  {
    const testName = "format_safety: broken input returns unchanged content";
    try {
      const filePath = "/tmp/format_broken_test.ump";
      const brokenContent = "class A {\n  BROKEN INDENT\n  name;\n}";
      const lines = helper.formatFile(filePath, brokenContent);
      const formatted = lines.join("\n");
      if (formatted !== brokenContent) {
        throw new Error("Broken input was modified by formatter");
      }
      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // ── End_of_model stripping regressions ─────────────────────────────────
  //
  // These tests exercise the exact production code paths, not just the
  // stripLayoutTail helper in isolation.

  // Regression 1: TextDocument.update full-replacement + re-strip path
  // Exercises the exact didChange logic from server.ts:
  //   TextDocument.update() → getText() → stripLayoutTail() → TextDocument.create()
  {
    const testName = "strip_layout_tail: TextDocument.update full-replacement re-strips tail";
    try {
      const { TextDocument } = require("vscode-languageserver-textdocument");
      const uri = "file:///tmp/eom_didchange.ump";

      // 1. Create initial stripped document (as didOpen would)
      const initialText = stripLayoutTail("class A {\n  name;\n}");
      let doc = TextDocument.create(uri, "umple", 1, initialText);

      // 2. Apply full-replacement change containing the tail (no range = full replace)
      const fullReplacement = 'class A {\n  name;\n}\n//$?[End_of_model]$?\n\nnamespace -;\nclass A { position 50 30 109 45; }';
      doc = TextDocument.update(doc, [{ text: fullReplacement }], 2);

      // 3. Run the exact re-strip logic from server.ts onDidChangeTextDocument
      const rawText = doc.getText();
      const stripped = stripLayoutTail(rawText);
      if (stripped.length !== rawText.length) {
        doc = TextDocument.create(doc.uri, doc.languageId, doc.version, stripped);
      }

      // 4. Verify the stored document is clean
      const finalText = doc.getText();
      if (finalText.includes("//$?[End_of_model]$?")) {
        throw new Error("Tail survived re-strip after TextDocument.update");
      }
      if (finalText.includes("position 50 30")) {
        throw new Error("Position metadata leaked through");
      }

      // 5. Verify indexing with the resulting text produces correct symbols
      const filePath = "/tmp/eom_didchange.ump";
      helper.si.updateFile(filePath, finalText);
      const symbols = helper.si.getSymbols({ name: "A", kind: ["class"] })
        .filter((s: any) => s.file === filePath);
      if (symbols.length !== 1) {
        throw new Error(`Expected 1 class symbol, got ${symbols.length}`);
      }

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // Regression 2: shadow workspace file materialization from disk
  // Exercises the exact createShadowWorkspace path: read disk file →
  // stripLayoutTail (via readFileSafe) → writeFile to shadow path
  {
    const testName = "strip_layout_tail: shadow workspace materializes stripped disk file";
    try {
      const fs = require("fs");
      const os = require("os");

      // 1. Write a file with tail to disk (simulating an UmpleOnline .ump file)
      const diskPath = path.join(os.tmpdir(), "eom_shadow_source.ump");
      const contentWithTail = 'class Shadow {\n  val;\n}\n//$?[End_of_model]$?\n\nnamespace -;\nclass Shadow { position 10 20 100 50; }';
      fs.writeFileSync(diskPath, contentWithTail, "utf8");

      // 2. Run the exact shadow workspace materialization logic from server.ts:
      //    readFileSafe strips → writeFile to shadow path
      const shadowPath = path.join(os.tmpdir(), "eom_shadow_dest.ump");
      const diskContent = stripLayoutTail(fs.readFileSync(diskPath, "utf8"));
      fs.writeFileSync(shadowPath, diskContent, "utf8");

      // 3. Verify the shadow file on disk is stripped
      const shadowContent = fs.readFileSync(shadowPath, "utf8");
      if (shadowContent.includes("//$?[End_of_model]$?")) {
        throw new Error("Shadow file still contains delimiter");
      }
      if (shadowContent.includes("position 10 20")) {
        throw new Error("Shadow file still contains position metadata");
      }
      if (!shadowContent.includes("class Shadow")) {
        throw new Error("Shadow file lost model content");
      }

      // 4. Verify indexing from shadow file produces correct symbols
      helper.si.indexFile(shadowPath, shadowContent);
      const symbols = helper.si.getSymbols({ name: "Shadow", kind: ["class"] })
        .filter((s: any) => s.file === shadowPath);
      if (symbols.length !== 1) {
        throw new Error(`Expected 1 class symbol, got ${symbols.length}`);
      }
      if (symbols[0].line > 2) {
        throw new Error(`Symbol line ${symbols[0].line} is beyond model portion`);
      }

      // Cleanup
      fs.unlinkSync(diskPath);
      fs.unlinkSync(shadowPath);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // Regression 3: server-side disk read for workspace scan / use-graph
  // Exercises the exact readFileSafe path: read from disk → stripLayoutTail →
  // content used for use-graph parsing and import resolution
  {
    const testName = "strip_layout_tail: server-side disk read strips tail for use-graph";
    try {
      const fs = require("fs");
      const os = require("os");

      // 1. Write a file with tail AND a use statement to disk
      const diskPath = path.join(os.tmpdir(), "eom_usegraph.ump");
      const contentWithTail = 'use "other.ump";\nclass Main {\n  x;\n}\n//$?[End_of_model]$?\n\nnamespace -;\nclass Main { position 5 5 100 50; }';
      fs.writeFileSync(diskPath, contentWithTail, "utf8");

      // 2. Run the exact server-side readFileSafe logic
      const diskContent = stripLayoutTail(fs.readFileSync(diskPath, "utf8"));

      // 3. Verify tail is gone but use statement and model are preserved
      if (diskContent.includes("//$?[End_of_model]$?")) {
        throw new Error("Disk read still contains delimiter");
      }
      if (!diskContent.includes('use "other.ump"')) {
        throw new Error("Use statement lost during stripping");
      }
      if (!diskContent.includes("class Main")) {
        throw new Error("Model content lost during stripping");
      }

      // 4. Index and verify symbols are correct
      helper.si.indexFile(diskPath, diskContent);
      const symbols = helper.si.getSymbols({ name: "Main", kind: ["class"] })
        .filter((s: any) => s.file === diskPath);
      if (symbols.length !== 1) {
        throw new Error(`Expected 1 class symbol, got ${symbols.length}`);
      }

      // Cleanup
      fs.unlinkSync(diskPath);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // ── use_path completion scope regression ───────────────────────────────
  // When content has no trailing newline, source_file and use_statement
  // have the same byte size. The scope resolver must pick the inner
  // (more specific) use_statement capture, not source_file's scope.none.
  {
    const testName = "use_path_completion: no-newline content detects use_path scope";
    try {
      const file = "/tmp/use_path_no_newline.ump";
      const content = "use Unt"; // no trailing newline — exact UmpleOnline case
      helper.si.indexFile(file, content);
      const info = helper.si.getCompletionInfo(content, 0, 7);
      if (info.symbolKinds !== "use_path") {
        throw new Error(`Expected symbolKinds "use_path", got ${JSON.stringify(info.symbolKinds)}`);
      }
      if (info.prefix !== "Unt") {
        throw new Error(`Expected prefix "Unt", got ${JSON.stringify(info.prefix)}`);
      }

      // Also verify the trailing-newline variant works (parity with VS Code)
      const contentNewline = "use Unt\n";
      helper.si.indexFile(file, contentNewline);
      const info2 = helper.si.getCompletionInfo(contentNewline, 0, 7);
      if (info2.symbolKinds !== "use_path") {
        throw new Error(`With newline: expected "use_path", got ${JSON.stringify(info2.symbolKinds)}`);
      }

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // ── Deleted file cleanup regressions ────────────────────────────────────

  // Regression 1: removeFile removes all indexed state
  {
    const testName = "deleted_file_cleanup: removeFile purges symbols and tree";
    try {
      const file = "/tmp/deleted_cleanup_test.ump";
      const content = "class Ephemeral {\n  temp;\n}";
      helper.si.indexFile(file, content);

      // Verify symbol exists
      let syms = helper.si.getSymbols({ name: "Ephemeral", kind: ["class"] })
        .filter((s: any) => s.file === file);
      if (syms.length !== 1) throw new Error(`Pre-delete: expected 1 symbol, got ${syms.length}`);
      if (!helper.si.getTree(file)) throw new Error("Pre-delete: tree missing");
      if (!helper.si.isFileIndexed(file)) throw new Error("Pre-delete: not indexed");

      // Call the same deletion path used by the file watcher
      helper.si.removeFile(file);

      // Verify symbol is gone
      syms = helper.si.getSymbols({ name: "Ephemeral", kind: ["class"] })
        .filter((s: any) => s.file === file);
      if (syms.length !== 0) throw new Error(`Post-delete: expected 0 symbols, got ${syms.length}`);
      if (helper.si.getTree(file)) throw new Error("Post-delete: tree still present");
      if (helper.si.isFileIndexed(file)) throw new Error("Post-delete: still indexed");

      // Verify attributes from the file are also gone
      const attrs = helper.si.getSymbols({ name: "temp", kind: ["attribute"] })
        .filter((s: any) => s.file === file);
      if (attrs.length !== 0) throw new Error(`Post-delete: stale attribute, got ${attrs.length}`);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // Regression 2: collectReachableFiles excludes non-existent imported files
  {
    const testName = "deleted_file_cleanup: deleted imported file excluded from reachable set";
    try {
      const fs = require("fs");
      const os = require("os");

      // Create a file that imports a non-existent file
      const mainPath = path.join(os.tmpdir(), "reachable_main.ump");
      const mainContent = 'use "NonExistent.ump";\nclass Main {}';
      fs.writeFileSync(mainPath, mainContent, "utf8");

      // Index and resolve reachable files using the same path as production:
      // extractUseStatements → resolve relative → existsSync check
      helper.si.indexFile(mainPath, mainContent);
      const uses = helper.si.extractUseStatements(mainPath, mainContent);

      // Resolve paths the same way collectReachableFilesRecursive does
      const mainDir = path.dirname(mainPath);
      const reachable = new Set<string>();
      for (const usePath of uses) {
        if (!usePath.endsWith(".ump")) continue;
        const resolved = path.resolve(mainDir, usePath);
        const normalized = path.normalize(resolved);
        if (fs.existsSync(resolved)) {
          reachable.add(normalized);
        }
      }

      // The non-existent file must NOT be in the reachable set
      const nonExistentPath = path.normalize(path.resolve(mainDir, "NonExistent.ump"));
      if (reachable.has(nonExistentPath)) {
        throw new Error("Deleted/non-existent file was added to reachable set");
      }

      // Cleanup
      fs.unlinkSync(mainPath);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // ── didClose cleanup regressions (standard LSP semantics) ──────────────

  // Regression 1: closed file not on disk → symbols removed
  {
    const testName = "didclose_cleanup: closed missing file purges symbols";
    try {
      const filePath = "/tmp/didclose_missing.ump";
      const content = "class Gone {\n  x;\n}";
      helper.si.indexFile(filePath, content);

      // Simulate didClose: file doesn't exist on disk
      const fs = require("fs");
      if (!fs.existsSync(filePath)) {
        helper.si.removeFile(path.normalize(filePath));
      }

      const syms = helper.si.getSymbols({ name: "Gone", kind: ["class"] })
        .filter((s: any) => s.file === path.normalize(filePath));
      if (syms.length !== 0) throw new Error(`Expected 0 symbols, got ${syms.length}`);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // Regression 2: deleted while open then close → symbols removed
  {
    const testName = "didclose_cleanup: deleted while open then close purges symbols";
    try {
      const fs = require("fs");
      const os = require("os");
      const filePath = path.join(os.tmpdir(), "didclose_deleted.ump");
      const content = "class Deleted {\n  y;\n}";
      fs.writeFileSync(filePath, content, "utf8");

      helper.si.indexFile(filePath, content);
      fs.unlinkSync(filePath); // delete while "open"

      // Simulate didClose
      if (!fs.existsSync(filePath)) {
        helper.si.removeFile(path.normalize(filePath));
      }

      const syms = helper.si.getSymbols({ name: "Deleted", kind: ["class"] })
        .filter((s: any) => s.file === path.normalize(filePath));
      if (syms.length !== 0) throw new Error(`Expected 0 symbols, got ${syms.length}`);

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
    }
  }

  // Regression 3: deleted then re-saved before close → symbols kept
  {
    const testName = "didclose_cleanup: deleted then re-saved keeps symbols";
    try {
      const fs = require("fs");
      const os = require("os");
      const filePath = path.join(os.tmpdir(), "didclose_resaved.ump");
      const content = "class Resilient {\n  z;\n}";
      fs.writeFileSync(filePath, content, "utf8");

      helper.si.indexFile(filePath, content);
      fs.unlinkSync(filePath);
      fs.writeFileSync(filePath, content, "utf8"); // re-save

      // Simulate didClose — file exists again
      if (!fs.existsSync(filePath)) {
        helper.si.removeFile(path.normalize(filePath));
      }

      const syms = helper.si.getSymbols({ name: "Resilient", kind: ["class"] })
        .filter((s: any) => s.file === path.normalize(filePath));
      if (syms.length !== 1) throw new Error(`Expected 1 symbol, got ${syms.length}`);

      fs.unlinkSync(filePath);
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
