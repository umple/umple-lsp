/**
 * Semantic regression test suite.
 *
 * Exercises all known LSP semantic behaviors using real fixtures.
 * Run with: npm test (from repo root or packages/server)
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { SemanticTestHelper, MarkerPosition, DeclSpec } from "./helpers";
import { resolveTraitSmEventLocations } from "../src/traitSmEventResolver";
import { stripLayoutTail } from "../src/tokenTypes";
import {
  CompletionItemKind,
  InsertTextFormat,
  SymbolKind as LspSymbolKind,
} from "vscode-languageserver/node";
import { ALL_SNIPPETS } from "../src/snippets";
import {
  COMPLETION_TRIGGER_CHARACTERS,
  shouldServeWhitespaceTriggeredCompletion,
} from "../src/completionTriggers";
import {
  buildSemanticTokenEntries,
  buildSemanticTokens,
  SemanticTokenEntry,
  UmpleSemanticTokenModifier,
  UmpleSemanticTokenType,
} from "../src/semanticTokens";
import {
  LEGACY_UMPLE_DIAGNOSTIC_SOURCE,
  UMPLE_DIAGNOSTIC_SOURCE,
} from "../src/diagnosticSources";

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

interface ImplementationsAssertion {
  type: "implementations";
  at: string; // marker name where the cursor sits (trait decl or isA use)
  // Topic 059 — exact set of expected implementer markers (declaration sites).
  expectAt: string[];
  // Optional list of markers that must NOT appear (e.g., interfaces and
  // classes that only inherit through interfaces).
  excludeAt?: string[];
  // Cross-file fixtures may need implementer markers in a different file.
  // Default is the cursor's fixture; override by passing the fixture name.
  expectFixture?: string;
}

interface ImplementationsEmptyAssertion {
  type: "implementations_empty";
  at: string;
}

interface UseGraphImplementationsAssertion {
  // Topic 059 — production-shaped cross-file find-implementations test.
  // The trait file is fully indexed (added to `reachable`); the importer
  // file is loaded WITHOUT indexing, only its use-graph edges are
  // injected. The runner mirrors the server handler: resolve cursor,
  // compute reverse importers, lazy-index them from a `fileContents`
  // map, then call `findTraitImplementers`. This pins the
  // reverse-importer discovery path that `onImplementation` relies on.
  type: "use_graph_implementations";
  targetFixture: string;
  importerFixture: string;
  at: string; // cursor marker — must live in `targetFixture`
  expectAt: string[]; // exact set of implementer markers
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
  | HoverExcludesAssertion
  | RenameEditsAssertion
  | WorkspaceRenameEditsAssertion
  | RenameRejectedAssertion
  | DocumentSymbolsAssertion
  | WorkspaceSymbolsAssertion
  | InlayHintsAssertion
  | FormatOutputAssertion
  | FormatOutputWithOptionsAssertion
  | FormatIdempotentAssertion
  | UseGraphRefsAssertion
  | ParseCleanAssertion
  | ParseHasErrorAssertion
  | SymbolCountAssertion
  | RecoveredSymbolAssertion
  | ImplementationsAssertion
  | ImplementationsEmptyAssertion
  | UseGraphImplementationsAssertion;

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

interface HoverExcludesAssertion {
  type: "hover_excludes";
  at: string;
  expect: string[];
}

interface RenameEditsAssertion {
  type: "rename_edits";
  at: string;
  newName: string;
  // Marker names whose positions must appear in the rename edit set.
  expectAt: string[];
  // Optional count check — total edits must equal this number.
  expectCount?: number;
}

interface WorkspaceRenameEditsAssertion {
  type: "rename_edits_workspace";
  at: string;
  newName: string;
  expectAt: string[];
  expectCount?: number;
}

interface RenameRejectedAssertion {
  type: "rename_rejected";
  at: string;
  newName: string;
  // Reason the rename pipeline must reject: most often "invalid-name" for
  // kind-aware validator regressions, but any rename helper status works.
  reason: "no-symbol" | "not-renameable" | "ambiguous" | "invalid-name";
}

interface DocumentSymbolsAssertion {
  type: "document_symbols";
  fixture: string;
  expectRoots: string[];
  expectChild: { parent: string; child: string };
}

interface WorkspaceSymbolsAssertion {
  type: "workspace_symbols";
  query: string;
  expect: { name: string; kind?: string; containerName?: string; fixture?: string }[];
  exclude?: { name: string; kind?: string; containerName?: string; fixture?: string }[];
}

interface InlayHintsAssertion {
  type: "inlay_hints";
  fixture: string;
  expect: { at: string; label: string }[];
  excludeAt?: string[];
  range?: { startAt: string; endAt: string };
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

  // 140: workspace/symbol across indexed files
  {
    name: "140 workspace_symbols: searchable declarations across files",
    fixtures: ["140_workspace_symbols_a.ump", "140_workspace_symbols_b.ump"],
    assertions: [
      {
        type: "workspace_symbols",
        query: "",
        expect: [
          { name: "Order", kind: "Class", fixture: "140_workspace_symbols_a.ump" },
          { name: "Auditable", kind: "Interface", fixture: "140_workspace_symbols_a.ump" },
          { name: "REQ_LOGIN", kind: "String", fixture: "140_workspace_symbols_a.ump" },
          { name: "Order.status.Pending", kind: "EnumMember", fixture: "140_workspace_symbols_a.ump" },
          { name: "Order.approve", kind: "Method", fixture: "140_workspace_symbols_a.ump" },
          { name: "C1.sm", kind: "Struct", fixture: "140_workspace_symbols_a.ump" },
          { name: "C1.sm.s1", kind: "EnumMember", fixture: "140_workspace_symbols_a.ump" },
          { name: "BillingLink", kind: "Property", fixture: "140_workspace_symbols_a.ump" },
          { name: "Invoice", kind: "Class", fixture: "140_workspace_symbols_b.ump" },
          { name: "Payable", kind: "Interface", fixture: "140_workspace_symbols_b.ump" },
          { name: "PaymentState", kind: "Enum", fixture: "140_workspace_symbols_b.ump" },
          { name: "Invoice.approveInvoice", kind: "Method", fixture: "140_workspace_symbols_b.ump" },
        ],
        exclude: [
          { name: "email" },
          { name: "orderNumber" },
          { name: "Paid" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "order.status",
        expect: [
          { name: "Order.status", kind: "Struct" },
          { name: "Order.status.Pending", kind: "EnumMember" },
          { name: "Order.status.Approved", kind: "EnumMember" },
        ],
        exclude: [
          { name: "Invoice.review.Draft" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "c1.sm",
        expect: [
          { name: "C1.sm", kind: "Struct" },
          { name: "C1.sm.s1", kind: "EnumMember" },
        ],
        exclude: [
          { name: "Order.status" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "invoice.email",
        expect: [
          { name: "Invoice.email", kind: "Field", containerName: "Invoice", fixture: "140_workspace_symbols_b.ump" },
        ],
        exclude: [
          { name: "Invoice" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "paymentstate.unpaid",
        expect: [
          { name: "PaymentState.Unpaid", kind: "EnumMember", containerName: "PaymentState", fixture: "140_workspace_symbols_b.ump" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "billing",
        expect: [
          { name: "BillingLink", kind: "Property", fixture: "140_workspace_symbols_a.ump" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "req",
        expect: [
          { name: "REQ_LOGIN", kind: "String" },
        ],
        exclude: [
          { name: "Order" },
        ],
      },
    ],
  },

  // 141: Corpus gap — standalone associations can be written as one
  // association end per line, without an explicit arrow between the ends.
  {
    name: "141 corpus: standalone association end declarations parse clean",
    fixtures: ["141_corpus_standalone_association_ends.ump"],
    assertions: [
      { type: "parse_clean", fixture: "141_corpus_standalone_association_ends.ump" },
      {
        type: "goto_def_exact",
        at: "role_type",
        expect: ["def_role"],
      },
      {
        type: "goto_def_exact",
        at: "person_type",
        expect: ["def_person"],
      },
    ],
  },

  // 142: Corpus gap — Test generator syntax includes test sequences and
  // prefixed test cases. Test cases are method symbols; test sequence steps
  // reference those test methods in the enclosing class scope.
  {
    name: "142 corpus: testSequence and prefixed test cases parse clean",
    fixtures: ["142_corpus_test_sequence.ump"],
    assertions: [
      { type: "parse_clean", fixture: "142_corpus_test_sequence.ump" },
      { type: "symbol_count", fixture: "142_corpus_test_sequence.ump", name: "Person", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "142_corpus_test_sequence.ump", name: "Student", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "142_corpus_test_sequence.ump", name: "checkName", kind: "method", expect: 2 },
      { type: "symbol_count", fixture: "142_corpus_test_sequence.ump", name: "checkStatus", kind: "method", expect: 1 },
      { type: "goto_def_exact", at: "seq_check_name", expect: ["test_check_name"] },
      { type: "goto_def_exact", at: "seq_check_status", expect: ["test_check_status"] },
      {
        type: "hover_output",
        at: "seq_check_status",
        expectContains: ["JUnit concrete test checkStatus", "in class Person"],
      },
    ],
  },

  // 143: Corpus gap — nested states can be declared with a dotted prefix
  // repeating their parent state name, e.g. `Cooling.On { ... }`.
  {
    name: "143 corpus: dotted nested state declarations parse and resolve",
    fixtures: ["143_corpus_dotted_state_declarations.ump"],
    assertions: [
      { type: "parse_clean", fixture: "143_corpus_dotted_state_declarations.ump" },
      {
        type: "token_context",
        at: "def_cooling_on",
        expect: { contextType: "normal", stateDefinitionRef: { definitionPath: ["Cooling", "On"] } },
      },
      {
        type: "goto_def_exact",
        at: "target_cooling_on",
        expect: ["def_cooling_on"],
      },
      {
        type: "goto_def_exact",
        at: "target_heating_on",
        expect: ["def_heating_on"],
      },
    ],
  },

  // 144: Corpus gap — displayColor/displayColour directives accept an
  // optional equals sign before either a string literal or named color.
  {
    name: "144 corpus: display color assignments parse clean",
    fixtures: ["144_corpus_display_color_assignment.ump"],
    assertions: [
      { type: "parse_clean", fixture: "144_corpus_display_color_assignment.ump" },
      { type: "symbol_count", fixture: "144_corpus_display_color_assignment.ump", name: "TrafficLight", kind: "class", expect: 1 },
    ],
  },

  // 145: Corpus gap — class and trait bodies can apply an inline mixset to
  // a named element or keyword target.
  {
    name: "145 corpus: inline mixset applications parse clean",
    fixtures: ["145_corpus_inline_mixset_application.ump"],
    assertions: [
      { type: "parse_clean", fixture: "145_corpus_inline_mixset_application.ump" },
      { type: "symbol_count", fixture: "145_corpus_inline_mixset_application.ump", name: "X", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "145_corpus_inline_mixset_application.ump", name: "Y", kind: "trait", expect: 1 },
      { type: "symbol_count", fixture: "145_corpus_inline_mixset_application.ump", name: "InlineMixset", kind: "mixset", expect: 0 },
    ],
  },

  // 146: Corpus gap — repeated `isA` tokens may appear after commas in a
  // single inheritance declaration.
  {
    name: "146 corpus: repeated isA tokens in inheritance list parse and resolve",
    fixtures: ["146_corpus_repeated_isa_list.ump"],
    assertions: [
      { type: "parse_clean", fixture: "146_corpus_repeated_isa_list.ump" },
      { type: "goto_def_exact", at: "ref_human", expect: ["def_human"] },
      { type: "goto_def_exact", at: "ref_student", expect: ["def_student"] },
      { type: "goto_def_exact", at: "ref_person", expect: ["def_person"] },
      { type: "goto_def_exact", at: "ref_man", expect: ["def_man"] },
    ],
  },

  // 147: Corpus gap — tracer execute blocks, unbracketed where clauses, and
  // semicolon-separated trace entities parse clean.
  {
    name: "147 corpus: trace execute and multi-entity forms parse clean",
    fixtures: ["147_corpus_trace_execute_forms.ump"],
    assertions: [
      { type: "parse_clean", fixture: "147_corpus_trace_execute_forms.ump" },
      { type: "symbol_count", fixture: "147_corpus_trace_execute_forms.ump", name: "LightFixture", kind: "class", expect: 1 },
    ],
  },

  // 148: Corpus gap — entry/exit actions can invoke a named action directly
  // after `/`, optionally followed by a code block.
  {
    name: "148 corpus: direct entry/exit action calls parse clean",
    fixtures: ["148_corpus_direct_entry_exit_actions.ump"],
    assertions: [
      { type: "parse_clean", fixture: "148_corpus_direct_entry_exit_actions.ump" },
      { type: "symbol_count", fixture: "148_corpus_direct_entry_exit_actions.ump", name: "LightFixture", kind: "class", expect: 1 },
    ],
  },

  // 149: Corpus gap — legacy state machines may include an attribute type,
  // and states may be introduced with the `state` keyword.
  {
    name: "149 corpus: typed state machines and state keyword parse clean",
    fixtures: ["149_corpus_typed_state_machine_keyword_states.ump"],
    assertions: [
      { type: "parse_clean", fixture: "149_corpus_typed_state_machine_keyword_states.ump" },
      { type: "symbol_count", fixture: "149_corpus_typed_state_machine_keyword_states.ump", name: "Garage", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "149_corpus_typed_state_machine_keyword_states.ump", name: "door", kind: "statemachine", expect: 1 },
      { type: "goto_def_exact", at: "target_open", expect: ["def_open"] },
      { type: "goto_def_exact", at: "target_closed", expect: ["def_closed"] },
    ],
  },

  // 150: Corpus gap — association blocks can contain mixset blocks, and
  // those mixsets can contain standalone association members.
  {
    name: "150 corpus: association-contained mixset associations parse and resolve",
    fixtures: ["150_corpus_association_mixset.ump"],
    assertions: [
      { type: "parse_clean", fixture: "150_corpus_association_mixset.ump" },
      { type: "symbol_count", fixture: "150_corpus_association_mixset.ump", name: "M1", kind: "mixset", expect: 1 },
      { type: "goto_def_exact", at: "use_m1", expect: ["def_m1"] },
    ],
  },

  // 151: Corpus gap — NuSMV input variables use the `ivar` attribute modifier.
  {
    name: "151 corpus: ivar attributes parse and resolve in constraints",
    fixtures: ["151_corpus_ivar_attributes.ump"],
    assertions: [
      { type: "parse_clean", fixture: "151_corpus_ivar_attributes.ump" },
      { type: "symbol_count", fixture: "151_corpus_ivar_attributes.ump", name: "ayo", kind: "attribute", expect: 1 },
      { type: "goto_def_exact", at: "ref_ayo", expect: ["def_ayo"] },
    ],
  },

  // 166: Corpus gap — true inner classes use `inner class Name { ... }`.
  {
    name: "166 corpus: inner class declarations parse clean",
    fixtures: ["166_corpus_inner_class.ump"],
    assertions: [
      { type: "parse_clean", fixture: "166_corpus_inner_class.ump" },
      { type: "symbol_count", fixture: "166_corpus_inner_class.ump", name: "Outer", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "166_corpus_inner_class.ump", name: "Inner", kind: "class", expect: 1 },
      {
        type: "goto_def_exact",
        at: "impl_a",
        expect: ["req_a"],
      },
      {
        type: "document_symbols",
        fixture: "166_corpus_inner_class.ump",
        expectRoots: ["A", "Outer"],
        expectChild: { parent: "Outer", child: "Inner" },
      },
    ],
  },

  // 167-169: Compiler-verified non-gaps — keep the grammar conservative for
  // shapes that current Umple treats as invalid or extra-code fallback.
  {
    name: "167 invalid: sorted key expressions remain unmodeled",
    fixtures: ["167_invalid_sorted_key_expression.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "167_invalid_sorted_key_expression.ump" },
    ],
  },
  {
    name: "168 invalid: trait SM guarded cascades remain unmodeled",
    fixtures: ["168_invalid_trait_sm_guard_cascade.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "168_invalid_trait_sm_guard_cascade.ump" },
    ],
  },
  {
    name: "169 invalid: mixset --redefine is not a mixset grammar option",
    fixtures: ["169_invalid_mixset_redefine_option.ump"],
    assertions: [
      { type: "parse_has_error", fixture: "169_invalid_mixset_redefine_option.ump" },
    ],
  },

  // 170: Corpus gaps — compiler-accepted glossary, distributable variants,
  // and interface layout metadata parse without indexing extra symbols.
  {
    name: "170 corpus: glossary, distributable variants, and interface position parse clean",
    fixtures: ["170_corpus_directives_distributable_glossary.ump"],
    assertions: [
      { type: "parse_clean", fixture: "170_corpus_directives_distributable_glossary.ump" },
      { type: "symbol_count", fixture: "170_corpus_directives_distributable_glossary.ump", name: "Service", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "170_corpus_directives_distributable_glossary.ump", name: "RemoteService", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "170_corpus_directives_distributable_glossary.ump", name: "entity", kind: "class", expect: 0 },
    ],
  },

  // 171: Corpus gap — trace period values use unit-suffixed durations.
  {
    name: "171 corpus: trace period postfix durations parse clean",
    fixtures: ["171_corpus_trace_period.ump"],
    assertions: [
      { type: "parse_clean", fixture: "171_corpus_trace_period.ump" },
      { type: "symbol_count", fixture: "171_corpus_trace_period.ump", name: "TracePeriod", kind: "class", expect: 1 },
      { type: "goto_def_exact", at: "trace_name_ref", expect: ["trace_name_def"] },
    ],
  },

  // 172: Corpus gaps — static inner classes, class-local strictness, and
  // interface test/extra-code lines parse clean without extra symbols.
  {
    name: "172 corpus: static inner class, strictness in class, and interface test parse clean",
    fixtures: ["172_corpus_static_inner_strictness_interface_test.ump"],
    assertions: [
      { type: "parse_clean", fixture: "172_corpus_static_inner_strictness_interface_test.ump" },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "OuterClass", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "InnerStaticClass", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "StrictnessClassNoDelete", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "RegisterCapable", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "id", kind: "attribute", expect: 0 },
      { type: "symbol_count", fixture: "172_corpus_static_inner_strictness_interface_test.ump", name: "checkCourseRegistration", kind: "method", expect: 0 },
    ],
  },

  // 173: Corpus gaps — fixml attribute modifier and method named `test`.
  {
    name: "173 corpus: fixml attributes and test-named method parse clean",
    fixtures: ["173_corpus_fixml_test_method.ump"],
    assertions: [
      { type: "parse_clean", fixture: "173_corpus_fixml_test_method.ump" },
      { type: "symbol_count", fixture: "173_corpus_fixml_test_method.ump", name: "Student", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "173_corpus_fixml_test_method.ump", name: "id", kind: "attribute", expect: 1 },
      { type: "symbol_count", fixture: "173_corpus_fixml_test_method.ump", name: "capacity", kind: "attribute", expect: 1 },
      { type: "symbol_count", fixture: "173_corpus_fixml_test_method.ump", name: "test", kind: "method", expect: 1 },
    ],
  },

  // 174: Corpus gap — emit template lists can reference ClassName.templateName.
  {
    name: "174 corpus: qualified emit template references parse clean",
    fixtures: ["174_corpus_qualified_template_refs.ump"],
    assertions: [
      { type: "parse_clean", fixture: "174_corpus_qualified_template_refs.ump" },
      { type: "symbol_count", fixture: "174_corpus_qualified_template_refs.ump", name: "copyright", kind: "template", expect: 1 },
      { type: "symbol_count", fixture: "174_corpus_qualified_template_refs.ump", name: "test1", kind: "template", expect: 1 },
      { type: "symbol_count", fixture: "174_corpus_qualified_template_refs.ump", name: "end", kind: "template", expect: 1 },
      { type: "symbol_count", fixture: "174_corpus_qualified_template_refs.ump", name: "generate1", kind: "method", expect: 1 },
    ],
  },

  // 175: Corpus gap — `test` can be a state-machine event name even though it
  // is also a keyword for test-case declarations in other contexts.
  {
    name: "175 corpus: test-named state-machine events parse clean",
    fixtures: ["175_corpus_test_event_transition.ump"],
    assertions: [
      { type: "parse_clean", fixture: "175_corpus_test_event_transition.ump" },
      { type: "symbol_count", fixture: "175_corpus_test_event_transition.ump", name: "TestEventTransition", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "175_corpus_test_event_transition.ump", name: "test", kind: "method", expect: 0 },
    ],
  },

  // 176: Corpus trace variants — wildcard targets, onlyGet/transition prefixes,
  // comma-separated record/logLevel payloads, dotted states, and timed deactivate.
  {
    name: "176 corpus: trace variants parse clean",
    fixtures: ["176_corpus_trace_variants.ump"],
    assertions: [
      { type: "parse_clean", fixture: "176_corpus_trace_variants.ump" },
      { type: "symbol_count", fixture: "176_corpus_trace_variants.ump", name: "TraceVariants", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "176_corpus_trace_variants.ump", name: "tc1", kind: "method", expect: 0 },
      { type: "goto_def_exact", at: "onlyget_id_ref", expect: ["def_id"] },
      { type: "goto_def_exact", at: "onlyget_name_ref", expect: ["def_name"] },
      { type: "goto_def_exact", at: "trace_sm_ref", expect: ["def_status"] },
      { type: "goto_def_exact", at: "trace_closed_ref", expect: ["def_closed"] },
      { type: "goto_def_exact", at: "trace_name_ref", expect: ["def_name"] },
      { type: "goto_def_exact", at: "record_id_ref", expect: ["def_id"] },
      { type: "goto_def_exact", at: "record_contact_ref", expect: ["def_contact"] },
      { type: "goto_def_exact", at: "record_only_id_ref", expect: ["def_id"] },
      { type: "goto_def_exact", at: "transition_record_contact_ref", expect: ["def_contact"] },
      { type: "goto_def_empty", at: "transition_event_ref" },
      { type: "goto_def_exact", at: "deact_tc1_ref", expect: ["tc1_def"] },
      { type: "refs", decl: { name: "id", kind: "attribute", container: "TraceVariants" }, expectAt: ["def_id", "onlyget_id_ref", "record_id_ref", "record_only_id_ref"] },
      { type: "refs", decl: { name: "contact", kind: "attribute", container: "TraceVariants" }, expectAt: ["def_contact", "record_contact_ref", "transition_record_contact_ref"] },
      { type: "refs", decl: { name: "status", kind: "statemachine", container: "TraceVariants.status" }, expectAt: ["def_status", "trace_sm_ref"] },
      { type: "refs", decl: { name: "Closed", kind: "state", container: "TraceVariants.status" }, expectAt: ["def_closed", "trace_closed_ref"] },
      {
        type: "token_context",
        at: "trace_sm_ref",
        expect: { contextType: "trace_state_path", pathSegments: ["status", "Closed"], segmentIndex: 0 },
      },
      {
        type: "token_context",
        at: "trace_closed_ref",
        expect: { contextType: "trace_state_path", pathSegments: ["status", "Closed"], segmentIndex: 1 },
      },
    ],
  },

  // 177: Corpus transition variants — top-level debug directive, transition
  // change marker `*`, and standalone state-to-state transitions without events.
  {
    name: "177 corpus: transition change markers and debug directive parse clean",
    fixtures: ["177_corpus_transition_change_debug.ump"],
    assertions: [
      { type: "parse_clean", fixture: "177_corpus_transition_change_debug.ump" },
      { type: "symbol_count", fixture: "177_corpus_transition_change_debug.ump", name: "OnOffSwitch", kind: "statemachine", expect: 1 },
      { type: "symbol_count", fixture: "177_corpus_transition_change_debug.ump", name: "Lightbulb", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "177_corpus_transition_change_debug.ump", name: "StandaloneNoEvent", kind: "class", expect: 1 },
      { type: "goto_def_exact", at: "s1_from_ref", expect: ["s1_def"] },
      { type: "goto_def_exact", at: "s2_to_ref", expect: ["s2_def"] },
      { type: "goto_def_exact", at: "s2_from_ref", expect: ["s2_def"] },
      { type: "goto_def_exact", at: "s1_to_ref", expect: ["s1_def"] },
      { type: "refs", decl: { name: "S1", kind: "state", container: "StandaloneNoEvent.sm" }, expectAt: ["s1_def", "s1_from_ref", "s1_to_ref"] },
      { type: "refs", decl: { name: "S2", kind: "state", container: "StandaloneNoEvent.sm" }, expectAt: ["s2_def", "s2_to_ref", "s2_from_ref"] },
    ],
  },

  {
    name: "152 inlay hints: conservative inferred attribute types",
    fixtures: ["152_inlay_hints.ump"],
    assertions: [
      { type: "parse_clean", fixture: "152_inlay_hints.ump" },
      {
        type: "inlay_hints",
        fixture: "152_inlay_hints.ump",
        expect: [
          { at: "plain", label: ": String" },
          { at: "string", label: ": String" },
          { at: "integer", label: ": Integer" },
          { at: "negative", label: ": Integer" },
          { at: "double", label: ": Double" },
          { at: "boolean", label: ": Boolean" },
          { at: "auto", label: ": Integer" },
        ],
        excludeAt: ["explicit", "suffix", "call", "derived"],
      },
      {
        type: "inlay_hints",
        fixture: "152_inlay_hints.ump",
        range: { startAt: "integer", endAt: "double" },
        expect: [
          { at: "integer", label: ": Integer" },
          { at: "negative", label: ": Integer" },
          { at: "double", label: ": Double" },
        ],
        excludeAt: ["plain", "string", "boolean", "auto"],
      },
    ],
  },

  {
    name: "153 format_declaration_assignment_spacing: attributes and constants",
    fixtures: ["153_format_declaration_assignment_spacing.ump"],
    assertions: [
      { type: "parse_clean", fixture: "153_format_declaration_assignment_spacing.ump" },
      {
        type: "format_output",
        fixture: "153_format_declaration_assignment_spacing.ump",
        expectLines: [
          { line: 1, text: "  Integer count = 5;" },
          { line: 2, text: "  label = \"Bob\";" },
          { line: 3, text: "  Boolean flag = true;" },
          { line: 4, text: "  score = 1.5;" },
          { line: 5, text: "  derived = {count + 1}" },
          { line: 8, text: "    if (value==5) {" },
          { line: 9, text: "    count=10;" },
          { line: 15, text: "  const Integer MAX = 10;" },
          { line: 16, text: "  const NAME = \"x\";" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "153_format_declaration_assignment_spacing.ump",
      },
    ],
  },

  {
    name: "154 format_same_line_top_level: do not grow packed declarations",
    fixtures: ["154_format_same_line_top_level.ump"],
    assertions: [
      { type: "parse_clean", fixture: "154_format_same_line_top_level.ump" },
      {
        type: "format_output",
        fixture: "154_format_same_line_top_level.ump",
        expectLines: [
          { line: 0, text: "class A {}" },
          { line: 1, text: "" },
          { line: 2, text: "use f1; use f2; use f3;" },
          { line: 3, text: "" },
          { line: 4, text: "class B {}" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "154_format_same_line_top_level.ump",
      },
    ],
  },

  {
    name: "155 format_tabbed_structural_spacing: normalize tabs around structural tokens",
    fixtures: ["155_format_tabbed_structural_spacing.ump"],
    assertions: [
      { type: "parse_clean", fixture: "155_format_tabbed_structural_spacing.ump" },
      {
        type: "format_output",
        fixture: "155_format_tabbed_structural_spacing.ump",
        expectLines: [
          { line: 1, text: "  status {" },
          { line: 2, text: "    Open {" },
          { line: 3, text: "      go -> Closed;" },
          { line: 5, text: "  }" },
          { line: 6, text: "  value = 1;" },
          { line: 10, text: "  1 TabSpacing -- * TabSpacing;" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "155_format_tabbed_structural_spacing.ump",
      },
    ],
  },

  {
    name: "156 format_structural_commas: use and isA only",
    fixtures: ["156_format_structural_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "156_format_structural_commas.ump" },
      {
        type: "format_output",
        fixture: "156_format_structural_commas.ump",
        expectLines: [
          { line: 0, text: "use model/a.ump, model/b.ump, \"model/c.ump\";" },
          { line: 7, text: "  isA I, T, isA model.Base;" },
          { line: 9, text: "    call(a,b);" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "156_format_structural_commas.ump",
      },
    ],
  },

  {
    name: "157 format_filter_commas: include/includeFilter/namespace lists",
    fixtures: ["157_format_filter_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "157_format_filter_commas.ump" },
      {
        type: "format_output",
        fixture: "157_format_filter_commas.ump",
        expectLines: [
          { line: 1, text: "  include A, B, ~C*, ?Name;" },
          { line: 2, text: "  includeFilter f1, f2, 7;" },
          { line: 3, text: "  namespace alpha.beta, gamma.delta;" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "157_format_filter_commas.ump",
      },
    ],
  },

  {
    name: "158 format_signature_type_commas: params, generics, trait params",
    fixtures: ["158_format_signature_type_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "158_format_signature_type_commas.ump" },
      {
        type: "format_output",
        fixture: "158_format_signature_type_commas.ump",
        expectLines: [
          { line: 1, text: "  void g(String a, Integer b);" },
          { line: 4, text: "trait T<TP isA I = Default, TP2> {}" },
          { line: 7, text: "  List<String, Integer> names;" },
          { line: 8, text: "  void f(String a, Integer b, List<String, Integer> c) {" },
          { line: 9, text: "    call(a,b);" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "158_format_signature_type_commas.ump",
      },
    ],
  },

  {
    name: "159 format_enum_commas: top-level and nested enum values",
    fixtures: ["159_format_enum_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "159_format_enum_commas.ump" },
      {
        type: "format_output",
        fixture: "159_format_enum_commas.ump",
        expectLines: [
          { line: 0, text: "enum Color { Red, Blue, Green, Yellow }" },
          { line: 3, text: "  enum Size { Small, Medium, Large }" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "159_format_enum_commas.ump",
      },
    ],
  },

  {
    name: "160 format_throws_commas: signatures and method declarations",
    fixtures: ["160_format_throws_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "160_format_throws_commas.ump" },
      {
        type: "format_output",
        fixture: "160_format_throws_commas.ump",
        expectLines: [
          { line: 1, text: "  void read() throws IOException, RuntimeException;" },
          { line: 5, text: "  public abstract void load() throws ParseException, ValidationException;" },
          { line: 6, text: "  void save(String name, Integer count) throws IOException, RuntimeException {" },
          { line: 7, text: "    call(a,b);" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "160_format_throws_commas.ump",
      },
    ],
  },

  {
    name: "161 format_before_after_commas: hook operation and target lists",
    fixtures: ["161_format_before_after_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "161_format_before_after_commas.ump" },
      {
        type: "format_output",
        fixture: "161_format_before_after_commas.ump",
        expectLines: [
          { line: 4, text: "  before setName, setAge { audit(name,age); }" },
          { line: 5, text: "  after get*, !getAge { trace(name,age); }" },
          { line: 8, text: "before {Person, Address} setName, setAge { log(\"x,y\"); }" },
          { line: 10, text: "after {Person, Address} generated get*, !getAge { log(a,b); }" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "161_format_before_after_commas.ump",
      },
    ],
  },

  {
    name: "162 format_more_structural_commas: parser-visible remaining lists",
    fixtures: ["162_format_more_structural_commas.ump"],
    assertions: [
      { type: "parse_clean", fixture: "162_format_more_structural_commas.ump" },
      {
        type: "format_output",
        fixture: "162_format_more_structural_commas.ump",
        expectLines: [
          { line: 3, text: "  key {id, name}" },
          { line: 4, text: "  status {Open, Closed, Paused}" },
          { line: 5, text: "  implementsReq R1, R2;" },
          { line: 6, text: "  trace set, get name, age;" },
          { line: 8, text: "    trace entry, exit Open, Closed;" },
          { line: 9, text: "  }" },
          { line: 10, text: "  active Java, Php Worker { run(a,b); }" },
          { line: 11, text: "  before setName Java, Php { log(a,b); }" },
          { line: 12, text: "  emit genReport()(before, after);" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "162_format_more_structural_commas.ump",
      },
    ],
  },

  {
    name: "163 format_multiline_lists: continuation and closing delimiter indentation",
    fixtures: ["163_format_multiline_lists.ump"],
    assertions: [
      { type: "parse_clean", fixture: "163_format_multiline_lists.ump" },
      {
        type: "format_output",
        fixture: "163_format_multiline_lists.ump",
        expectLines: [
          { line: 2, text: "    Integer x," },
          { line: 3, text: "    String y" },
          { line: 4, text: "  ) {" },
          { line: 8, text: "    String," },
          { line: 9, text: "    Integer" },
          { line: 10, text: "  > values;" },
          { line: 12, text: "    Open," },
          { line: 13, text: "    Closed" },
          { line: 14, text: "  }" },
          { line: 16, text: "    id," },
          { line: 17, text: "    name" },
          { line: 18, text: "  }" },
          { line: 20, text: "    R1," },
          { line: 21, text: "    R2;" },
          { line: 26, text: "    A," },
          { line: 27, text: "    B;" },
          { line: 31, text: "  foo.ump," },
          { line: 32, text: "  bar.ump;" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "163_format_multiline_lists.ump",
      },
    ],
  },

  {
    name: "164 format_tracer_spacing: config commas and equals",
    fixtures: ["164_format_tracer_spacing.ump"],
    assertions: [
      { type: "parse_clean", fixture: "164_format_tracer_spacing.ump" },
      {
        type: "format_output",
        fixture: "164_format_tracer_spacing.ump",
        expectLines: [
          { line: 0, text: "tracer log4j debug, error = console, file on:Time, Object;" },
          { line: 1, text: "tracer log4j root = all debug = console monitorInterval = 30;" },
          { line: 4, text: "  name;" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "164_format_tracer_spacing.ump",
      },
    ],
  },

  {
    name: "165 format_compact_declarations_boundary: keep compact declarations compact",
    fixtures: ["165_format_compact_declarations_boundary.ump"],
    assertions: [
      { type: "parse_clean", fixture: "165_format_compact_declarations_boundary.ump" },
      {
        type: "format_output",
        fixture: "165_format_compact_declarations_boundary.ump",
        expectLines: [
          { line: 0, text: "class Empty {}" },
          { line: 2, text: "interface CompactInterface { void ping(); }" },
          { line: 4, text: "trait CompactTrait { name; }" },
          { line: 7, text: "  class Nested {}" },
          { line: 8, text: "  enum Mode {On, Off}" },
        ],
      },
      {
        type: "format_idempotent",
        fixture: "165_format_compact_declarations_boundary.ump",
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

  // 24c: Workspace-wide rename safety. A file can refer to a symbol even when
  // it is not in the current import chain. Normal reference scope stays narrow,
  // but rename uses the full workspace search scope to avoid partial edits.
  {
    name: "24c rename_scope: workspace-wide rename includes non-import-chain refs",
    fixtures: ["24c_rename_workspace_main.ump"],
    unreachable: ["24c_rename_workspace_other.ump"],
    assertions: [
      { type: "parse_clean", fixture: "24c_rename_workspace_main.ump" },
      { type: "parse_clean", fixture: "24c_rename_workspace_other.ump" },
      {
        type: "rename_edits",
        at: "ws_def_Target",
        newName: "RenamedTarget",
        expectAt: ["ws_def_Target", "ws_main_ref"],
        expectCount: 2,
      },
      {
        type: "rename_edits_workspace",
        at: "ws_def_Target",
        newName: "RenamedTarget",
        expectAt: ["ws_def_Target", "ws_main_ref", "ws_other_ref"],
        expectCount: 3,
      },
    ],
  },

  // 12A: Completion fallback — zero-identifier positions
  {
    name: "12A completion_fallback: zero-identifier scope detection",
    fixtures: ["12_completion_fallback.ump"],
    assertions: [
      // Topic 052 item 1 — blank `isA |` now routes to the same scalar
      // scope as typed-prefix and comma continuation (was the array form,
      // which leaked built-ins + `void` through the fallback path).
      {
        type: "completion_kinds",
        at: "isA_empty",
        expect: "isa_typed_prefix",
      },
      // Topic 052 item 2 — `before |` / `after |` route through the
      // scalar `code_injection_method` scope (was the array form, which
      // leaked ~177 LookaheadIterator keywords through the fallback path).
      // Final completion list must be method-symbols-only — no ERROR /
      // namespace / Java / built-ins / `void`.
      {
        type: "completion_kinds",
        at: "before_empty",
        expect: "code_injection_method",
      },
      {
        type: "completion_includes",
        at: "before_empty",
        expect: ["ping", "pong"],
      },
      {
        type: "completion_excludes",
        at: "before_empty",
        expect: ["ERROR", "namespace", "Java", "Integer", "void", "isA"],
      },
      // Typed-prefix `before p|` shares the same scalar scope.
      {
        type: "completion_kinds",
        at: "before_typed",
        expect: "code_injection_method",
      },
      {
        type: "completion_includes",
        at: "before_typed",
        expect: ["ping", "pong"],
      },
      // `after |` parity.
      {
        type: "completion_kinds",
        at: "after_empty",
        expect: "code_injection_method",
      },
      {
        type: "completion_includes",
        at: "after_empty",
        expect: ["ping", "pong"],
      },
      // `after p|` typed-prefix parity.
      {
        type: "completion_kinds",
        at: "after_typed",
        expect: "code_injection_method",
      },
      {
        type: "completion_includes",
        at: "after_typed",
        expect: ["ping", "pong"],
      },
      {
        type: "completion_excludes",
        at: "after_typed",
        expect: ["ERROR", "namespace", "Java", "Integer", "void"],
      },
      {
        type: "completion_kinds",
        at: "arrow_empty",
        expect: "transition_target",
      },
      // Topic 055 — `as |` for referenced_statemachine target now routes
      // through the scalar `referenced_sm_target` scope (was the
      // `["statemachine"]` array, which fell through to the raw-lookahead
      // fallback and leaked builtin types). Builder offers class-local SMs
      // plus top-level standalone statemachines, no keywords/operators/types.
      {
        type: "completion_kinds",
        at: "refsm_empty",
        expect: "referenced_sm_target",
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
      // Classes, active methods, and class-local port declarations are indexed.
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
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "increment",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "init",
        kind: "method",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "pIn1",
        kind: "port",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "pOut1",
        kind: "port",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "speed",
        kind: "port",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "pIn2",
        kind: "port",
        expect: 1,
      },
      {
        type: "symbol_count",
        fixture: "38_ports_reactive.ump",
        name: "pOut2",
        kind: "port",
        expect: 1,
      },
      {
        type: "goto_def_exact",
        at: "port_in1_ref",
        expect: ["port_in1"],
      },
      {
        type: "goto_def_exact",
        at: "port_out1_ref",
        expect: ["port_out1"],
      },
      {
        type: "goto_def_exact",
        at: "cmp1_ref",
        expect: ["component_cmp1"],
      },
      {
        type: "goto_def_exact",
        at: "cmp2_ref",
        expect: ["component_cmp2"],
      },
      {
        type: "goto_def_exact",
        at: "cmp1_pout1_ref",
        expect: ["port_out1"],
      },
      {
        type: "goto_def_exact",
        at: "cmp2_pin2_ref",
        expect: ["port_in2"],
      },
      {
        type: "goto_def_exact",
        at: "cmp2_pout2_ref",
        expect: ["port_out2"],
      },
      {
        type: "goto_def_exact",
        at: "cmp1_pin1_ref",
        expect: ["port_in1"],
      },
      {
        type: "goto_def_empty",
        at: "sensor_data_ref",
      },
      {
        type: "goto_def_empty",
        at: "client_sensor_data_ref",
      },
      {
        type: "refs",
        decl: { name: "pIn1", kind: "port", container: "Component1" },
        expectAt: ["port_in1", "port_in1_ref", "cmp1_pin1_ref"],
      },
      {
        type: "refs",
        decl: { name: "pOut1", kind: "port", container: "Component1" },
        expectAt: ["port_out1", "port_out1_ref", "cmp1_pout1_ref"],
      },
      {
        type: "refs",
        decl: { name: "pIn2", kind: "port", container: "Component2" },
        expectAt: ["port_in2", "port_in2_ref", "cmp2_pin2_ref"],
      },
      {
        type: "refs",
        decl: { name: "pOut2", kind: "port", container: "Component2" },
        expectAt: ["port_out2", "port_out2_ref", "cmp2_pout2_ref"],
      },
      {
        type: "refs",
        decl: { name: "cmp1", kind: "attribute", container: "Composite" },
        expectAt: ["component_cmp1", "cmp1_ref", "cmp1_ref_2"],
      },
      {
        type: "refs",
        decl: { name: "cmp2", kind: "attribute", container: "Composite" },
        expectAt: ["component_cmp2", "cmp2_ref", "cmp2_ref_2"],
      },
      {
        type: "hover_output",
        at: "port_in1",
        expectContains: ["public in Integer pIn1", "in class Component1"],
      },
      {
        type: "hover_output",
        at: "port_out1",
        expectContains: ["public out Integer pOut1", "in class Component1"],
      },
      {
        type: "hover_output",
        at: "port_speed",
        expectContains: ["public out int speed", "in class Sensor"],
      },
      {
        type: "hover_output",
        at: "component_cmp1",
        expectContains: ["Component1 cmp1", "in class Composite"],
      },
      {
        type: "hover_output",
        at: "cmp1_pout1_ref",
        expectContains: ["public out Integer pOut1", "in class Component1"],
      },
      {
        type: "hover_output",
        at: "cmp2_pin2_ref",
        expectContains: ["public in Integer pIn2", "in class Component2"],
      },
      {
        type: "document_symbols",
        fixture: "38_ports_reactive.ump",
        expectRoots: ["Component1", "Component2", "Composite", "Sensor"],
        expectChild: { parent: "Component1", child: "pIn1" },
      },
      {
        type: "workspace_symbols",
        query: "",
        expect: [],
        exclude: [
          { name: "Component1.pIn1" },
        ],
      },
      {
        type: "workspace_symbols",
        query: "component1.pin1",
        expect: [
          { name: "Component1.pIn1", kind: "Property", containerName: "Component1", fixture: "38_ports_reactive.ump" },
        ],
      },
      {
        type: "hover_output",
        at: "active_increment",
        expectContains: ["active increment", "in class Component1"],
      },
      {
        type: "hover_output",
        at: "active_init",
        expectContains: ["void active init()", "in class Sensor"],
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
      // Left-side sorted completion excludes non-attribute symbols. Topic
      // 049 phase 2 narrowed this scope to symbol-only; raw parser keyword
      // leaks that previously slipped through the CONSTRAINT_BLOCKLIST
      // filter must NOT appear in the final completion list either.
      {
        type: "completion_excludes",
        at: "comp_left",
        expect: [
          "Student", "Course", "Integer",
          "ERROR", "namespace", "class", "isA", "trace", "generate",
          "abstract", "mixset",
        ],
      },
      // Right-side sorted completion includes target class attrs (Student)
      {
        type: "completion_includes",
        at: "comp_right",
        expect: ["id", "name"],
      },
      // Right-side sorted completion excludes enclosing class attrs AND
      // the same raw-parser junk that was silently leaking pre-phase-2.
      {
        type: "completion_excludes",
        at: "comp_right",
        expect: [
          "score", "label",
          "ERROR", "namespace", "class", "isA", "trace", "generate",
          "abstract", "mixset",
        ],
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
      // onlyGet shares the same attribute-only completion path as set/get
      {
        type: "completion_kinds",
        at: "tpc_comp_onlyget_later",
        expect: "trace_attribute",
      },
      {
        type: "completion_includes",
        at: "tpc_comp_onlyget_later",
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
      // transition events are not symbol-indexed, so avoid wrong attr/method suggestions
      {
        type: "completion_kinds",
        at: "tpc_comp_transition",
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
      { type: "symbol_count", fixture: "76_test_case.ump", name: "checkSetId", kind: "method", expect: 1 },
      { type: "symbol_count", fixture: "76_test_case.ump", name: "checkSetName", kind: "method", expect: 1 },
      {
        type: "hover_output",
        at: "test_check_id",
        expectContains: ["test checkSetId", "in class Student"],
      },
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
        expect: "filter_body",
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
        expect: "state_body",
      },
    ],
  },

  // 117: State-body completion — curated keywords + state symbols
  {
    name: "117 state_body_completion: blank state-body returns curated keywords",
    fixtures: ["117_state_body_completion.ump"],
    assertions: [
      // Scope must be state_body
      {
        type: "completion_kinds",
        at: "state_blank",
        expect: "state_body",
      },
      // Must include state-body keyword starters
      {
        type: "completion_includes",
        at: "state_blank",
        expect: ["entry", "exit", "do", "final", "mixset", "trace"],
      },
      // Must include display/activate keywords
      {
        type: "completion_includes",
        at: "state_blank",
        expect: ["displayColor", "displayColour", "activate", "deactivate"],
      },
      // Must include built-in types (for method declarations)
      {
        type: "completion_includes",
        at: "state_blank",
        expect: ["Integer", "String"],
      },
      // Must include state names from enclosing SM
      {
        type: "completion_includes",
        at: "state_blank",
        expect: ["Open", "Closed"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "state_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level starters
      {
        type: "completion_excludes",
        at: "state_blank",
        expect: ["class", "interface", "namespace", "use", "generate"],
      },
      // Must NOT include generator targets or sub-keywords
      {
        type: "completion_excludes",
        at: "state_blank",
        expect: ["Java", "Php", "forced", "on", "off"],
      },
      // Boundary: SM-body must still be statemachine_body
      {
        type: "completion_kinds",
        at: "sm_boundary",
        expect: "statemachine_body",
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 118: Requirement-body completion — suppressed (opaque content)
  {
    name: "118 requirement_body_completion: blank req body is suppressed",
    fixtures: ["118_requirement_body_completion.ump"],
    assertions: [
      // Scope must be suppress (requirement body is opaque)
      {
        type: "completion_kinds",
        at: "req_blank",
        expect: "suppress",
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 119: Filter-body completion — suppressed, but include targets still work
  {
    name: "119 filter_body_completion: blank filter body returns curated starters, include targets preserved",
    fixtures: ["119_filter_body_completion.ump"],
    assertions: [
      // Scope must be filter_body
      {
        type: "completion_kinds",
        at: "filter_blank",
        expect: "filter_body",
      },
      // Must include filter-statement starters
      {
        type: "completion_includes",
        at: "filter_blank",
        expect: ["include", "includeFilter", "namespace", "hops"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "filter_blank",
        expect: ["ERROR"],
      },
      // Must NOT include top-level junk
      {
        type: "completion_excludes",
        at: "filter_blank",
        expect: ["class", "use", "generate", "Java"],
      },
      // Topic 052 item 3 — include target now routes through the scalar
      // `filter_include_target` (was the array form, which leaked
      // built-ins + `void` through the fallback path).
      {
        type: "completion_kinds",
        at: "filter_include",
        expect: "filter_include_target",
      },
      // Includes user classes, excludes built-ins / void / raw keywords.
      {
        type: "completion_includes",
        at: "filter_include",
        expect: ["Student", "Course", "Staff"],
      },
      {
        type: "completion_excludes",
        at: "filter_include",
        expect: ["String", "Integer", "Boolean", "void", "ERROR", "namespace"],
      },
      // Blank `include |` shape (broken ERROR recovery, no following
      // identifier). Same scope.
      {
        type: "completion_kinds",
        at: "filter_include_blank",
        expect: "filter_include_target",
      },
      {
        type: "completion_includes",
        at: "filter_include_blank",
        expect: ["Student", "Course", "Staff"],
      },
      // Typed-prefix `include S|`.
      {
        type: "completion_kinds",
        at: "filter_include_typed",
        expect: "filter_include_target",
      },
      {
        type: "completion_includes",
        at: "filter_include_typed",
        expect: ["Student", "Course", "Staff"],
      },
      {
        type: "completion_excludes",
        at: "filter_include_typed",
        expect: ["String", "Integer", "void"],
      },
      // Negative — `includeFilter |` must NOT be reclassified. Stays on
      // the existing filter_body keyword starters.
      {
        type: "completion_kinds",
        at: "filter_include_filter",
        expect: "filter_body",
      },
      // Negative — `namespace |` keeps its existing null route.
      {
        type: "completion_kinds",
        at: "filter_namespace",
        expect: null,
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 120: Enum-body completion — already quiet, pin with regression
  {
    name: "120 enum_body_completion: blank enum body is quiet (no raw keywords)",
    fixtures: ["120_enum_body_completion.ump"],
    assertions: [
      // Enum body is already quiet (null scope, 0 keywords)
      {
        type: "completion_kinds",
        at: "enum_blank",
        expect: null,
      },
      // Boundary: top-level must still be top_level
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 121: Transition-target completion — state symbols only, no raw lookahead
  {
    name: "121 transition_target_completion: after -> returns state symbols only",
    fixtures: ["121_transition_target_completion.ump"],
    assertions: [
      // Scope must be transition_target
      {
        type: "completion_kinds",
        at: "arrow_target",
        expect: "transition_target",
      },
      // Must include state names from enclosing SM
      {
        type: "completion_includes",
        at: "arrow_target",
        expect: ["Open", "Closed"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "arrow_target",
        expect: ["ERROR"],
      },
      // Must NOT include top-level/generator junk
      {
        type: "completion_excludes",
        at: "arrow_target",
        expect: ["namespace", "use", "generate", "Java", "Php", "class"],
      },
      // Boundary: SM-body blank must still be statemachine_body
      {
        type: "completion_kinds",
        at: "sm_boundary",
        expect: "statemachine_body",
      },
    ],
  },

  // 122: Guard completion — attrs/methods + true/false only, no raw keywords
  {
    name: "122 guard_completion: guard returns attrs/methods + boolean literals only",
    fixtures: ["122_guard_completion.ump"],
    assertions: [
      // Guard start scope
      {
        type: "completion_kinds",
        at: "guard_start",
        expect: "guard_attribute_method",
      },
      // After operator scope
      {
        type: "completion_kinds",
        at: "guard_after_op",
        expect: "guard_attribute_method",
      },
      // Must include scoped attrs/methods
      {
        type: "completion_includes",
        at: "guard_start",
        expect: ["x", "flag", "check"],
      },
      // Must include boolean literals
      {
        type: "completion_includes",
        at: "guard_start",
        expect: ["true", "false"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "guard_start",
        expect: ["ERROR"],
      },
      // Must NOT include junk keywords
      {
        type: "completion_excludes",
        at: "guard_start",
        expect: ["default", "test", "generic", "suboption", "distributable", "forced", "on", "off"],
      },
      // Boundary: transition target must still be transition_target
      {
        type: "completion_kinds",
        at: "transition_boundary",
        expect: "transition_target",
      },
    ],
  },

  // 123: Trace entity completion — attrs/methods only, no raw keywords
  {
    name: "123 trace_entity_completion: trace entity returns attrs/methods only",
    fixtures: ["123_trace_entity_completion.ump"],
    assertions: [
      // Primary trace entity scope
      {
        type: "completion_kinds",
        at: "trace_primary",
        expect: "trace_attribute_method",
      },
      // Record entity scope
      {
        type: "completion_kinds",
        at: "trace_record",
        expect: "trace_attribute_method",
      },
      // Must include scoped attrs/methods
      {
        type: "completion_includes",
        at: "trace_primary",
        expect: ["x", "name", "doWork"],
      },
      // Must NOT include ERROR
      {
        type: "completion_excludes",
        at: "trace_primary",
        expect: ["ERROR"],
      },
      // Must NOT include junk keywords
      {
        type: "completion_excludes",
        at: "trace_primary",
        expect: ["default", "test", "generic", "suboption", "distributable", "forced", "on", "off"],
      },
      // Boundary: guard must still be guard_attribute_method
      {
        type: "completion_kinds",
        at: "guard_boundary",
        expect: "guard_attribute_method",
      },
    ],
  },

  // 124: Structured requirement bodies — userStory/useCase metadata + steps indexing
  {
    name: "124 requirement_structured: userStory/useCase metadata + step symbols",
    fixtures: ["124_requirement_structured.ump"],
    assertions: [
      // Parse must be clean across all structured and plain forms (including negatives)
      {
        type: "parse_clean",
        fixture: "124_requirement_structured.ump",
      },
      // All eight requirements are indexed, including the useCase whose
      // userStep/systemResponse bodies omit numeric step ids.
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "US1", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "US2", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "UC1", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "UC2", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "UC_IDLESS", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "R1",  kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "US_BARE",    kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "UC_PARTIAL", kind: "requirement", expect: 1 },
      // Use-case steps: ids "1" and "2" are indexed twice each (userStep + systemResponse pair)
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "1", kind: "use_case_step", expect: 2 },
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "2", kind: "use_case_step", expect: 2 },
      // NEGATIVE: step id 99 from `userStep 99` / `systemResponse 99` (no body) must NOT index
      { type: "symbol_count", fixture: "124_requirement_structured.ump", name: "99", kind: "use_case_step", expect: 0 },
      // Hover on structured userStory shows who/when/what/why summary
      {
        type: "hover_output",
        at: "def_us1",
        expectContains: ["US1", "userStory", "customer", "password is forgotten", "reset my password", "regain access"],
      },
      // Hover on lowercase `userstory` alias normalizes to `userStory` (Phase D)
      {
        type: "hover_output",
        at: "def_us2",
        expectContains: ["US2", "userStory", "admin"],
      },
      {
        type: "hover_excludes",
        at: "def_us2",
        expect: ["userstory"], // raw alias must not leak through
      },
      // Hover on useCase with steps shows who but steps are separate symbols
      {
        type: "hover_output",
        at: "def_uc1",
        expectContains: ["UC1", "useCase", "salesPerson"],
      },
      // Hover on lowercase `usecase` alias normalizes to `useCase` (Phase D)
      {
        type: "hover_output",
        at: "def_uc2",
        expectContains: ["UC2", "useCase"],
      },
      // ID-less userStep/systemResponse bodies are valid narrative steps.
      // They should not index bogus step symbols or drop the parent requirement.
      {
        type: "goto_def",
        at: "use_uc_idless",
        expect: [{ at: "def_uc_idless" }],
      },
      {
        type: "completion_includes",
        at: "complete_idless",
        expect: ["UC_IDLESS"],
      },
      {
        type: "hover_excludes",
        at: "def_uc2",
        expect: ["usecase"],
      },
      // Hover on plain req (no language) shows just the id
      {
        type: "hover_output",
        at: "def_plain",
        expectContains: ["R1"],
      },
      // Hover on a userStep shows the step kind, id, and enclosing req container
      {
        type: "hover_output",
        at: "def_step1",
        expectContains: ["userStep", "UC1"],
      },
      // Hover on a systemResponse shows the step kind, id, and container
      {
        type: "hover_output",
        at: "def_step2",
        expectContains: ["systemResponse", "UC1"],
      },
      // NEGATIVE: bare who/when/what/why in US_BARE must NOT contribute hover metadata
      {
        type: "hover_output",
        at: "def_us_bare",
        expectContains: ["US_BARE", "userStory"],
      },
      {
        type: "hover_excludes",
        at: "def_us_bare",
        expect: ["**Who:**", "**When:**", "**What:**", "**Why:**"],
      },
      // NEGATIVE: bare userStep / systemResponse / who in UC_PARTIAL → no metadata
      {
        type: "hover_output",
        at: "def_uc_partial",
        expectContains: ["UC_PARTIAL", "useCase"],
      },
      {
        type: "hover_excludes",
        at: "def_uc_partial",
        expect: ["**Who:**"],
      },
      // Document outline: positive reqs are roots, steps nest under UC1.
      // UC_PARTIAL is also a root but has no indexed step children.
      {
        type: "document_symbols",
        fixture: "124_requirement_structured.ump",
        expectRoots: ["US1", "US2", "UC1", "UC2", "UC_IDLESS", "R1", "US_BARE", "UC_PARTIAL", "Account"],
        expectChild: { parent: "UC1", child: "1" },
      },
    ],
  },

  // 125: Phase C1 + C2 — implementsReq grammar coverage across all issue-2098
  // contexts, plus traceability (goto-def, find-refs, completion) assertions
  // that prove the grammar expansion wired through to existing LSP features.
  {
    name: "125 implementsreq_contexts: grammar + traceability for implementsReq in every compiler-permitted context",
    fixtures: ["125_implementsreq_contexts.ump"],
    assertions: [
      // ── Grammar / parse ────────────────────────────────────────────────────
      { type: "parse_clean", fixture: "125_implementsreq_contexts.ump" },

      // ── Indexing: requirements (R1..R5, Detailed) all present ─────────────
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "R1", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "R2", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "R3", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "R4", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "R5", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "Detailed", kind: "requirement", expect: 1 },

      // ── Indexing: neighbors unchanged (no regression from grammar work) ───
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "T",     kind: "trait",        expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "IX",    kind: "interface",    expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "Color", kind: "enum",         expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "TopSM", kind: "statemachine", expect: 1 },
      { type: "symbol_count", fixture: "125_implementsreq_contexts.ump", name: "X",     kind: "class",        expect: 1 },

      // ── Goto-def: every new context resolves implementsReq → req ──────────
      // Top-level (pre-existing, pinned here for completeness)
      { type: "goto_def", at: "use_r1_trait", expect: [{ at: "def_r1" }] },
      { type: "goto_def", at: "use_r1_iface", expect: [{ at: "def_r1" }] },
      { type: "goto_def", at: "use_r1_enum",  expect: [{ at: "def_r1" }] },
      { type: "goto_def", at: "use_r1_assoc", expect: [{ at: "def_r1" }] },
      { type: "goto_def", at: "use_r1_sm",    expect: [{ at: "def_r1" }] },
      { type: "goto_def", at: "use_r1_req",   expect: [{ at: "def_r1" }] },
      // Phase C1's new contexts
      { type: "goto_def", at: "use_r5_sm",       expect: [{ at: "def_r5" }] }, // inside statemachine_definition body
      { type: "goto_def", at: "use_r2_assocblk", expect: [{ at: "def_r2" }] }, // inside association { } block
      { type: "goto_def", at: "use_r3_smbody",   expect: [{ at: "def_r3" }] }, // inside class-local SM body
      { type: "goto_def", at: "use_r4_state",    expect: [{ at: "def_r4" }] }, // inside state body

      // ── Find-refs: req → every implementsReq site across all contexts ─────
      {
        type: "refs",
        decl: { name: "R1", kind: "requirement", container: "R1" },
        expectAt: ["def_r1", "use_r1_trait", "use_r1_iface", "use_r1_enum",
                   "use_r1_assoc", "use_r1_sm", "use_r1_req", "complete_top"],
      },
      {
        type: "refs",
        decl: { name: "R2", kind: "requirement", container: "R2" },
        expectAt: ["def_r2", "use_r2_assocblk"],
      },
      {
        type: "refs",
        decl: { name: "R3", kind: "requirement", container: "R3" },
        expectAt: ["def_r3", "use_r3_smbody"],
      },
      {
        type: "refs",
        decl: { name: "R4", kind: "requirement", container: "R4" },
        expectAt: ["def_r4", "use_r4_state"],
      },
      {
        type: "refs",
        decl: { name: "R5", kind: "requirement", container: "R5" },
        expectAt: ["def_r5", "use_r5_sm"],
      },

      // ── Completion: implementsReq position surfaces requirement-kind scope ─
      { type: "completion_kinds", at: "complete_top", expect: ["requirement"] },
      { type: "completion_includes", at: "complete_top", expect: ["R1", "R2", "R3", "R4", "R5", "Detailed"] },
      { type: "completion_excludes", at: "complete_top", expect: ["class", "trait", "interface", "association", "statemachine", "enum"] },
    ],
  },

  // 126: Phase C2 — empty-slot completion after `implementsReq` and after a
  // trailing comma. These positions don't form a valid req_implementation, so
  // tree-sitter's scope query misses them. A `prevLeaf`-based fallback in
  // completionAnalysis.ts detects the slot and forces the requirement scope.
  //
  // No parse_clean — fixture deliberately contains incomplete req_implementation
  // statements to exercise the zero-identifier recovery path.
  {
    name: "126 implementsreq_empty_slot: bare slot after implementsReq or comma offers requirement-kind scope",
    fixtures: ["126_implementsreq_empty_slot.ump", "126_reqs.ump"],
    assertions: [
      // Bare first slot at top level
      { type: "completion_kinds",    at: "bare_top", expect: ["requirement"] },
      { type: "completion_includes", at: "bare_top", expect: ["R1", "R2", "R3"] },
      { type: "completion_excludes", at: "bare_top", expect: ["class", "trait", "interface", "namespace", "use", "generate"] },

      // Bare second slot after a comma at top level
      { type: "completion_kinds",    at: "bare_top_comma", expect: ["requirement"] },
      { type: "completion_includes", at: "bare_top_comma", expect: ["R1", "R2", "R3"] },
      { type: "completion_excludes", at: "bare_top_comma", expect: ["class", "trait", "interface", "namespace"] },

      // Bare slot inside a state body (C1 new context)
      { type: "completion_kinds",    at: "bare_state", expect: ["requirement"] },
      { type: "completion_includes", at: "bare_state", expect: ["R1", "R2", "R3"] },
      { type: "completion_excludes", at: "bare_state", expect: ["class", "trait", "entry", "exit", "do"] },

      // Bare slot inside an association block (C1 new context)
      { type: "completion_kinds",    at: "bare_assocblk", expect: ["requirement"] },
      { type: "completion_includes", at: "bare_assocblk", expect: ["R1", "R2", "R3"] },
      { type: "completion_excludes", at: "bare_assocblk", expect: ["class", "trait", "namespace"] },
    ],
  },

  // 127: Phase D — requirement decomposition + negative boundaries. Closes out
  // the issue-2098 LSP catchup. Alias normalization is exercised in test 124.
  {
    name: "127 req_decomposition: implementsReq before a following req attaches correctly and does not leak",
    fixtures: ["127_req_decomposition.ump"],
    assertions: [
      // Parse must remain clean with decomposition patterns intermixed with neighbors.
      { type: "parse_clean", fixture: "127_req_decomposition.ump" },

      // Both reqs and the unrelated neighbors are indexed.
      { type: "symbol_count", fixture: "127_req_decomposition.ump", name: "HighLevel", kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "127_req_decomposition.ump", name: "Detailed",  kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "127_req_decomposition.ump", name: "OtherReq",  kind: "requirement", expect: 1 },
      { type: "symbol_count", fixture: "127_req_decomposition.ump", name: "Pin",       kind: "class",       expect: 1 },
      { type: "symbol_count", fixture: "127_req_decomposition.ump", name: "State",     kind: "enum",        expect: 1 },

      // Goto-def from each implementsReq HighLevel — must resolve to the
      // single HighLevel declaration, not be confused by neighboring reqs.
      { type: "goto_def", at: "ref_high_decomp", expect: [{ at: "def_high" }] },
      { type: "goto_def", at: "ref_high_class",  expect: [{ at: "def_high" }] },

      // find-refs on HighLevel: declaration + both implementsReq uses.
      // OtherReq / Detailed / Pin / State must NOT appear as HighLevel refs.
      {
        type: "refs",
        decl: { name: "HighLevel", kind: "requirement", container: "HighLevel" },
        expectAt: ["def_high", "ref_high_decomp", "ref_high_class"],
      },
      {
        type: "refs_exclude",
        decl: { name: "HighLevel", kind: "requirement", container: "HighLevel" },
        excludeAt: ["def_detailed", "def_other", "def_enum_state"],
      },

      // find-refs on Detailed: declaration only. No implementsReq references
      // Detailed, so the result is just the definition.
      {
        type: "refs",
        decl: { name: "Detailed", kind: "requirement", container: "Detailed" },
        expectAt: ["def_detailed"],
      },
      // find-refs on OtherReq: declaration only — proves no spurious pick-up
      // of neighboring implementsReq HighLevel that precedes it.
      {
        type: "refs",
        decl: { name: "OtherReq", kind: "requirement", container: "OtherReq" },
        expectAt: ["def_other"],
      },

      // Hover on HighLevel declaration identifies the requirement.
      { type: "hover_output", at: "def_high",     expectContains: ["HighLevel"] },
      { type: "hover_output", at: "def_detailed", expectContains: ["Detailed"] },
      { type: "hover_output", at: "def_other",    expectContains: ["OtherReq"] },
    ],
  },

  // 128: Topic 039 / item 1 — structured req body keyword completion.
  // userStory body offers who/when/what/why; useCase body adds
  // userStep/systemResponse. Free-text content, tag bodies, step bodies,
  // and plain req bodies stay quiet.
  {
    name: "128 req_body_keyword_completion: structured req body starters + quiet boundaries",
    fixtures: ["128_req_body_keyword_completion.ump"],
    assertions: [
      { type: "parse_clean", fixture: "128_req_body_keyword_completion.ump" },

      // Empty userStory body → exactly 4 starters, no junk.
      { type: "completion_kinds",   at: "us_blank", expect: "userstory_body" },
      { type: "completion_includes", at: "us_blank", expect: ["who", "when", "what", "why"] },
      { type: "completion_excludes", at: "us_blank", expect: [
        "userStep", "systemResponse",
        "class", "trait", "namespace", "ERROR",
      ]},

      // Empty useCase body → all 6 starters.
      { type: "completion_kinds",   at: "uc_blank", expect: "usecase_body" },
      { type: "completion_includes", at: "uc_blank", expect: [
        "who", "when", "what", "why", "userStep", "systemResponse",
      ]},
      { type: "completion_excludes", at: "uc_blank", expect: [
        "class", "trait", "namespace", "ERROR",
      ]},

      // Cursor AFTER an existing tag still offers starters.
      { type: "completion_kinds",    at: "us_after_tag", expect: "userstory_body" },
      { type: "completion_includes", at: "us_after_tag", expect: ["who", "when", "what", "why"] },

      // Cursor AFTER an existing step still offers starters.
      { type: "completion_kinds",    at: "uc_after_step", expect: "usecase_body" },
      { type: "completion_includes", at: "uc_after_step", expect: [
        "who", "when", "what", "why", "userStep", "systemResponse",
      ]},

      // Plain req body remains suppressed (legacy behavior, no regression).
      { type: "completion_kinds", at: "plain_blank", expect: "suppress" },

      // Inside a tag body → suppressed (free-text content).
      { type: "completion_kinds", at: "tag_inner", expect: "suppress" },

      // Inside a step body → suppressed.
      { type: "completion_kinds", at: "step_inner", expect: "suppress" },

      // NEGATIVE: cursor in the middle of free-text prose must NOT offer starters.
      // Between two words mid-sentence in a useCase body.
      { type: "completion_kinds", at: "uc_prose_mid", expect: "suppress" },
      // End of a prose sentence in a useCase body.
      { type: "completion_kinds", at: "uc_prose_end", expect: "suppress" },
      // Middle of prose in a userStory body.
      { type: "completion_kinds", at: "us_prose_mid", expect: "suppress" },
      // Immediately after `{` when content on the same line is prose.
      { type: "completion_kinds", at: "uc_prose_start", expect: "suppress" },

      // Boundary: top-level immediately after the last req closes.
      { type: "completion_kinds", at: "top_boundary", expect: "top_level" },
    ],
  },

  // 129: Phase 039 / item 2 — rename for requirement kind.
  // Exercises rename on normal / numeric-leading / hyphenated req ids,
  // decomposition, and updates across every C1 implementsReq context.
  // Also pins the kind-aware new-name validator that rejects identifier-only
  // characters for requirement renames.
  {
    name: "129 req_rename: requirement kind renameable with req-id validator; updates every implementsReq context",
    fixtures: ["129_req_rename.ump"],
    assertions: [
      { type: "parse_clean", fixture: "129_req_rename.ump" },

      // Normal req id: R01 renamed; updates class-body and top-level uses.
      {
        type: "rename_edits",
        at: "def_r01",
        newName: "R01x",
        expectAt: ["def_r01", "use_r01_top", "use_r01_class"],
        expectCount: 3,
      },

      // Numeric-leading id: 001dealing renamed to 002dealing.
      {
        type: "rename_edits",
        at: "def_numeric",
        newName: "002dealing",
        expectAt: ["def_numeric", "use_numeric"],
        expectCount: 2,
      },

      // Hyphenated id: L01-LicenseTypes renamed to L02-LicenseTypes.
      {
        type: "rename_edits",
        at: "def_hyphen",
        newName: "L02-LicenseTypes",
        expectAt: ["def_hyphen", "use_hyphen"],
        expectCount: 2,
      },

      // implementsReq use sites can seed the rename too (same resolution).
      {
        type: "rename_edits",
        at: "use_r01_class",
        newName: "RAlpha",
        expectAt: ["def_r01", "use_r01_top", "use_r01_class"],
        expectCount: 3,
      },

      // C1 context: rename from a state-machine-body implementsReq site.
      {
        type: "rename_edits",
        at: "use_smr",
        newName: "R_SM2",
        expectAt: ["def_smr", "use_smr"],
        expectCount: 2,
      },

      // C1 context: rename from a state-body implementsReq site.
      {
        type: "rename_edits",
        at: "use_stater",
        newName: "R_STATE2",
        expectAt: ["def_stater", "use_stater"],
        expectCount: 2,
      },

      // C1 context: rename from an association-block implementsReq site.
      {
        type: "rename_edits",
        at: "use_assocr",
        newName: "R_ASSOC2",
        expectAt: ["def_assocr", "use_assocr"],
        expectCount: 2,
      },

      // Decomposition: implementsReq before a following `req` updates correctly.
      {
        type: "rename_edits",
        at: "def_high",
        newName: "HighLevel2",
        expectAt: ["def_high", "use_high_decomp"],
        expectCount: 2,
      },
      {
        type: "rename_edits",
        at: "use_high_decomp",
        newName: "HighRenamed",
        expectAt: ["def_high", "use_high_decomp"],
        expectCount: 2,
      },

      // C1 context: rename from an implementsReq inside a top-level
      // `statemachine_definition` body (statemachine TopSM { implementsReq ...; ... }).
      {
        type: "rename_edits",
        at: "use_topsm",
        newName: "R_TOPSM2",
        expectAt: ["def_topsm", "use_topsm"],
        expectCount: 2,
      },

      // Invalid new names rejected by the req-specific validator.
      // Hyphens + digit-leading are LEGAL for req ids, so the usual
      // identifier rejections don't apply — instead probe rules that even
      // the req-id regex disallows.
      { type: "rename_rejected", at: "def_r01", newName: "",              reason: "invalid-name" }, // empty
      { type: "rename_rejected", at: "def_r01", newName: "-leadingHyphen", reason: "invalid-name" }, // leading hyphen
      { type: "rename_rejected", at: "def_r01", newName: "has space",      reason: "invalid-name" }, // whitespace
      { type: "rename_rejected", at: "def_r01", newName: "bad@char",       reason: "invalid-name" }, // @ not allowed
      { type: "rename_rejected", at: "def_r01", newName: "dot.inside",     reason: "invalid-name" }, // . not allowed
    ],
  },

  // 130: Phase 042 — partial association completion.
  // Probes the two slot-specific scopes the completionAnalysis fallback
  // surfaces while the parser is still inside an ERROR for a mid-typed
  // association. Also pins standalone association blocks, where the slot
  // after left multiplicity is left_type rather than arrow. Negative
  // boundaries: class-body stays class_body when no association is being
  // typed; state-body `e ->` still routes to transition_target.
  {
    name: "130 assoc_partial_completion: inline and standalone partial association slots",
    fixtures: [
      "130_assoc_partial_completion.ump",
      "130b_assoc_partial_slots.ump",
    ],
    assertions: [
      // Completed fixture must still parse clean — proves completed
      // `association_inline` and standalone `association_member` paths are
      // unaffected.
      { type: "parse_clean", fixture: "130_assoc_partial_completion.ump" },

      // Neighbors in the completed fixture — class symbols must be indexed
      // so the association_type slot has class names to offer.
      { type: "symbol_count", fixture: "130_assoc_partial_completion.ump", name: "Other", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "130_assoc_partial_completion.ump", name: "Thing", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "130_assoc_partial_completion.ump", name: "C",     kind: "class", expect: 1 },

      // Slot 1: right-multiplicity after the arrow.
      {
        type: "completion_kinds",
        at: "class_body_after_arrow",
        expect: "association_multiplicity",
      },
      {
        type: "completion_includes",
        at: "class_body_after_arrow",
        expect: ["1", "*", "0..1", "1..*", "0..*"],
      },
      {
        type: "completion_excludes",
        at: "class_body_after_arrow",
        expect: [
          "isA", "before", "trace", "class", "trait", "mixset", "ERROR",
          "namespace", "abstract", "singleton",
        ],
      },
      {
        type: "completion_kinds",
        at: "class_body_after_arrow_no_space",
        expect: null,
      },

      // Slot 2: right-type after the right multiplicity plus a separating space.
      {
        type: "completion_kinds",
        at: "class_body_after_right_mult",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "class_body_after_right_mult",
        expect: ["Other", "Thing", "C"],
      },
      {
        type: "completion_excludes",
        at: "class_body_after_right_mult",
        expect: [
          "isA", "before", "trace", "abstract", "class", "trait", "ERROR",
        ],
      },
      {
        type: "completion_kinds",
        at: "class_body_after_right_mult_no_space",
        expect: null,
      },

      // Ranged multiplicity plus a boundary (`0..1 -> 1..* `) still routes to slot 2.
      {
        type: "completion_kinds",
        at: "class_body_after_range_mult",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "class_body_after_range_mult",
        expect: ["Other", "Thing"],
      },

      // `--` arrow variant behaves the same as `->` for slot 2.
      {
        type: "completion_kinds",
        at: "class_body_dash_variant",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "class_body_dash_variant",
        expect: ["Other", "Thing"],
      },

      // Negative: a state-body `e -> ` must still route to transition_target,
      // proving the association fallback doesn't leak into state machines.
      {
        type: "completion_kinds",
        at: "state_body_arrow",
        expect: "transition_target",
      },
      {
        type: "completion_kinds",
        at: "state_body_arrow_no_space",
        expect: null,
      },

      // Cascade — top-level `association { }` block with three standalone
      // partial associations collapsed into one ERROR. All three slots must
      // still classify correctly despite the sprawling child list.
      {
        type: "completion_kinds",
        at: "assoc_block_after_arrow",
        expect: "association_multiplicity",
      },
      {
        type: "completion_includes",
        at: "assoc_block_after_arrow",
        expect: ["1", "*", "0..1"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_after_arrow",
        expect: ["isA", "namespace", "class", "Java", "ERROR"],
      },
      {
        type: "completion_kinds",
        at: "assoc_block_after_arrow_no_space",
        expect: null,
      },
      {
        type: "completion_kinds",
        at: "assoc_block_after_right_mult",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "assoc_block_after_right_mult",
        expect: ["Other", "Thing"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_after_right_mult",
        expect: ["isA", "namespace", "class", "Java", "ERROR"],
      },
      {
        type: "completion_kinds",
        at: "assoc_block_after_right_mult_no_space",
        expect: null,
      },
      {
        type: "completion_kinds",
        at: "assoc_block_after_range_mult",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "assoc_block_after_range_mult",
        expect: ["Other", "Thing"],
      },

      // Topic 043: typed-prefix on the right_type identifier.
      // Class-body case: cursor inside the partial identifier "O" —
      // (association_inline right_type: identifier) capture wins via
      // smallest-scope rule.
      {
        type: "completion_kinds",
        at: "class_body_typed_prefix",
        expect: "association_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "class_body_typed_prefix",
        expect: ["Other", "Thing"],
      },
      {
        type: "completion_excludes",
        at: "class_body_typed_prefix",
        expect: [
          "isA", "before", "trace", "abstract", "namespace", "Java",
          "ERROR", "class", "trait", "mixset",
        ],
      },

      // Assoc-block right_type case: parser produces ERROR; nodeAtCursor-based
      // fallback inside completionAnalysis classifies the typed prefix.
      {
        type: "completion_kinds",
        at: "assoc_block_typed_prefix",
        expect: "association_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "assoc_block_typed_prefix",
        expect: ["Other", "Thing"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_typed_prefix",
        expect: [
          "namespace", "Java", "ERROR", "class", "trait", "isA",
        ],
      },
      // Assoc-block left_type case: after the left multiplicity, class names
      // are valid; arrows are not yet valid.
      {
        type: "completion_kinds",
        at: "assoc_block_left_type_typed",
        expect: "association_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "assoc_block_left_type_typed",
        expect: ["Other", "Thing"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_left_type_typed",
        expect: [
          "namespace", "Java", "ERROR", "class", "trait", "isA", "->",
        ],
      },

      // Topic 044: arrow slot. Cursor sits between the left multiplicity and
      // the arrow operator. Must offer only the curated arrow set; no
      // class-body junk, no `ERROR`.
      {
        type: "completion_kinds",
        at: "class_body_arrow_blank",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "class_body_arrow_blank",
        expect: ["--", "->", "<-", "<@>-", "-<@>", ">->", "<-<"],
      },
      {
        type: "completion_excludes",
        at: "class_body_arrow_blank",
        expect: [
          "isA", "before", "trace", "abstract", "namespace", "Java",
          "ERROR", "class", "trait", "mixset",
        ],
      },

      // Partial-arrow typed (`1 -|`) — same scope, prefix-filtered by editor.
      {
        type: "completion_kinds",
        at: "class_body_arrow_dash",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "class_body_arrow_dash",
        expect: ["--", "->"],
      },

      // Aggregation partial (`1 <@|`) lands in the same scope.
      {
        type: "completion_kinds",
        at: "class_body_arrow_aggregation",
        expect: "association_arrow",
      },

      // Top-level association block — after only the left multiplicity, offer
      // the missing left type. This is the standalone association shape:
      // `association { 1 | }`.
      {
        type: "completion_kinds",
        at: "assoc_block_left_type_blank",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "assoc_block_left_type_blank",
        expect: ["Other", "Thing", "C"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_left_type_blank",
        expect: ["--", "->", "<@>-", "trait", "class", "ERROR"],
      },
      // Malformed standalone recovery: `association { 1 -> | }` is missing
      // the left type, so keep offering class names instead of accepting the
      // arrow as a valid slot advance.
      {
        type: "completion_kinds",
        at: "assoc_block_missing_left_type",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "assoc_block_missing_left_type",
        expect: ["Other", "Thing", "C"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_missing_left_type",
        expect: ["--", "->", "<@>-", "trait", "class", "ERROR"],
      },

      // Top-level association block — after the left type, offer arrows.
      {
        type: "completion_kinds",
        at: "assoc_block_arrow_blank",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "assoc_block_arrow_blank",
        expect: ["--", "->", "<@>-"],
      },
      {
        type: "completion_kinds",
        at: "assoc_block_arrow_dash",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "assoc_block_arrow_dash",
        expect: ["--", "->"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_arrow_dash",
        expect: ["Other", "Thing", "class", "ERROR"],
      },

      // Standalone cascade after a complete member — no prior arrow/right
      // type bleed into the next association member.
      {
        type: "completion_kinds",
        at: "assoc_block_cascade_left_type",
        expect: "association_type",
      },
      {
        type: "completion_includes",
        at: "assoc_block_cascade_left_type",
        expect: ["Other", "Thing", "C"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_cascade_left_type",
        expect: ["--", "->", "<@>-", "class", "ERROR"],
      },
      {
        type: "completion_kinds",
        at: "assoc_block_cascade_arrow_slot",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "assoc_block_cascade_arrow_slot",
        expect: ["->", "--"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_cascade_arrow_slot",
        expect: ["Other", "Thing", "class", "ERROR"],
      },
      {
        type: "completion_kinds",
        at: "assoc_block_cascade_mult_slot",
        expect: "association_multiplicity",
      },
      {
        type: "completion_includes",
        at: "assoc_block_cascade_mult_slot",
        expect: ["1", "*", "0..1"],
      },
      {
        type: "completion_excludes",
        at: "assoc_block_cascade_mult_slot",
        expect: ["Other", "Thing", "class", "ERROR"],
      },

      // Cascade — second association's left mult after a complete first one
      // (delimited by `;`). Must still classify as arrow slot, not pick up
      // the prior association's arrow.
      {
        type: "completion_kinds",
        at: "cascade_arrow_slot",
        expect: "association_arrow",
      },
      {
        type: "completion_includes",
        at: "cascade_arrow_slot",
        expect: ["->", "--"],
      },
      {
        type: "completion_excludes",
        at: "cascade_arrow_slot",
        expect: [
          "isA", "namespace", "Java", "ERROR", "class", "trait",
          "Other",  // prior right_type must NOT bleed in
        ],
      },

      // Negative: plain class-body cursor (no association being typed) keeps
      // the existing class_body scope — proves we didn't widen the generic
      // fallback path.
      {
        type: "completion_kinds",
        at: "class_body_empty",
        expect: "class_body",
      },

      // Boundary: top-level unchanged past the last class.
      {
        type: "completion_kinds",
        at: "top_boundary",
        expect: "top_level",
      },
    ],
  },

  // 131: Topic 047 item 1 — typed-prefix narrowing on the isA type identifier.
  // Mirrors topic 043's association_typed_prefix pattern. Before the fix,
  // `isA P|` in certain parse contexts leaked 175 LookaheadIterator keywords
  // (ERROR, namespace, Java, generate, ...) via the array symbolKinds path.
  // The scalar `isa_typed_prefix` scope takes a symbol-only early-return
  // branch in completionBuilder.
  {
    name: "131 isa_typed_prefix: narrow isA type identifier completion; drop keyword leak",
    fixtures: ["131_isa_typed_prefix.ump"],
    assertions: [
      // Neighbors exist.
      { type: "symbol_count", fixture: "131_isa_typed_prefix.ump", name: "Person", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "131_isa_typed_prefix.ump", name: "Parent", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "131_isa_typed_prefix.ump", name: "Printable", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "131_isa_typed_prefix.ump", name: "Plantable", kind: "trait", expect: 1 },

      // Parsed leak case — isa_declaration forms, but array-form path would
      // leak 175 keywords. Scalar scope narrows the final output.
      {
        type: "completion_kinds",
        at: "isa_typed_prefix_parsed",
        expect: "isa_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "isa_typed_prefix_parsed",
        expect: ["Person", "Parent", "Printable", "Plantable"],
      },
      {
        type: "completion_excludes",
        at: "isa_typed_prefix_parsed",
        expect: [
          "isA", "before", "trace", "abstract", "namespace", "Java",
          "ERROR", "class", "trait", "mixset", "generate", "Color",
        ],
      },

      // Comma case — second name in type_list.
      {
        type: "completion_kinds",
        at: "isa_typed_prefix_comma",
        expect: "isa_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "isa_typed_prefix_comma",
        expect: ["Person", "Parent", "Printable", "Plantable"],
      },
      {
        type: "completion_excludes",
        at: "isa_typed_prefix_comma",
        expect: ["ERROR", "namespace", "Java", "Color"],
      },

      // Mid-identifier cursor — clean parse, nodeAtCursor is on the inner
      // identifier text.
      {
        type: "completion_kinds",
        at: "isa_typed_prefix_midid",
        expect: "isa_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "isa_typed_prefix_midid",
        expect: ["Person", "Parent", "Printable", "Plantable"],
      },

      // Topic 052 item 1 — blank `isA |` now uses the same scalar scope
      // as typed-prefix / comma continuation. The old array form leaked
      // built-ins and `void` through the fallback path; the scalar takes
      // the symbol-only builder branch.
      {
        type: "completion_kinds",
        at: "isa_blank",
        expect: "isa_typed_prefix",
      },
      // Blank `isA |` final completion list must include user-defined
      // class-like symbols and exclude built-ins / `void` / enum names.
      {
        type: "completion_includes",
        at: "isa_blank",
        expect: ["Person", "Parent", "Printable", "Plantable"],
      },
      {
        type: "completion_excludes",
        at: "isa_blank",
        expect: ["String", "Integer", "Boolean", "void", "Color"],
      },

      // Negative regressions — trait SM angle-bracket positions must NOT
      // become isa_typed_prefix. The prevLeaf gate (`<` / `as`) rules them
      // out. Topic 053 narrows the `isA T<sm|` mid-typing position from
      // `class_body` (47-keyword leak) to `suppress` via the new
      // `recoverTraitSmOpFromIsAError` helper. Topic 055 routes
      // `isA T<sm as S|` from the previous `class_body` leak to the new
      // scalar `trait_sm_binding_target` scope (statemachine symbols only).
      {
        type: "completion_kinds",
        at: "trait_sm_inner_typed",
        expect: "suppress",
      },
      {
        type: "completion_kinds",
        at: "trait_sm_binding_typed",
        expect: "trait_sm_binding_target",
      },
    ],
  },

  // 132: Topic 047 item 2 — typed-prefix narrowing on attribute / const
  // declaration type names. Default class_body scope leaks 54+ keywords
  // (test, generic, class, isA, trace, ...) and surfaces no type symbols
  // when the user is typing inside a declaration type slot. Scalar
  // decl_type_typed_prefix replaces that with symbol-only output: built-in
  // types + class / interface / trait / enum. `void` stays excluded
  // (method-return only, item 3).
  {
    name: "132 decl_type_typed_prefix: narrow attribute/const declaration type slots; drop keyword leak",
    fixtures: ["132_decl_type_typed_prefix.ump"],
    assertions: [
      { type: "symbol_count", fixture: "132_decl_type_typed_prefix.ump", name: "Person", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "132_decl_type_typed_prefix.ump", name: "Printable", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "132_decl_type_typed_prefix.ump", name: "Plantable", kind: "trait", expect: 1 },
      { type: "symbol_count", fixture: "132_decl_type_typed_prefix.ump", name: "Color", kind: "enum", expect: 1 },

      // Built-in type prefix inside attribute_declaration.
      {
        type: "completion_kinds",
        at: "attr_type_builtin_prefix",
        expect: "decl_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "attr_type_builtin_prefix",
        expect: ["Integer", "String", "Boolean", "Person", "Printable", "Plantable", "Color"],
      },
      {
        type: "completion_excludes",
        at: "attr_type_builtin_prefix",
        expect: [
          "ERROR", "namespace", "Java", "generate", "test", "generic",
          "isA", "trace", "class", "trait", "mixset", "void",
        ],
      },

      // User-defined class type prefix.
      {
        type: "completion_kinds",
        at: "attr_type_class_prefix",
        expect: "decl_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "attr_type_class_prefix",
        expect: ["Person", "Parent", "Integer", "Color"],
      },

      // const as attribute_modifier in a class.
      {
        type: "completion_kinds",
        at: "attr_type_const_modifier",
        expect: "decl_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "attr_type_const_modifier",
        expect: ["Integer", "Person"],
      },
      {
        type: "completion_excludes",
        at: "attr_type_const_modifier",
        expect: ["ERROR", "immutable", "settable", "void"],
      },

      // Second attribute slot after a completed first attribute.
      {
        type: "completion_kinds",
        at: "attr_type_second_slot",
        expect: "decl_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "attr_type_second_slot",
        expect: ["Integer", "Person"],
      },

      // const_declaration inside interface (dedicated grammar rule).
      {
        type: "completion_kinds",
        at: "const_decl_type_prefix",
        expect: "decl_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "const_decl_type_prefix",
        expect: ["Integer", "Person"],
      },

      // Negatives — must NOT be reclassified.
      // Name slot after the type is suppressed (isAtAttributeNamePosition).
      {
        type: "completion_kinds",
        at: "attr_name_slot",
        expect: null,
      },
      {
        type: "completion_kinds",
        at: "blank_class_body",
        expect: "class_body",
      },
      {
        type: "completion_kinds",
        at: "lone_identifier",
        expect: "class_body",
      },
      {
        type: "completion_kinds",
        at: "after_name_prefix",
        expect: "class_body",
      },
    ],
  },

  // 133: Topic 047 item 3 — typed-prefix narrowing on method return-type
  // names. Same pattern as items 1/2 / topic 043, applied to the four
  // grammar rules that use a `return_type` field on type_name. Unlike item
  // 2, the builder keeps `void` here (valid only as a method return type).
  // Parameter types are cleanly excluded because type_name's parent is
  // `param`, not a method rule.
  {
    name: "133 return_type_typed_prefix: narrow method return-type slots; drop keyword leak",
    fixtures: ["133_return_type_typed_prefix.ump"],
    assertions: [
      { type: "symbol_count", fixture: "133_return_type_typed_prefix.ump", name: "Person", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "133_return_type_typed_prefix.ump", name: "Printable", kind: "interface", expect: 1 },
      { type: "symbol_count", fixture: "133_return_type_typed_prefix.ump", name: "Plantable", kind: "trait", expect: 1 },
      { type: "symbol_count", fixture: "133_return_type_typed_prefix.ump", name: "Color", kind: "enum", expect: 1 },

      // Built-in return type prefix in method_declaration.
      {
        type: "completion_kinds",
        at: "ret_builtin_prefix",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_builtin_prefix",
        expect: ["Integer", "String", "Boolean", "void", "Person", "Printable", "Plantable", "Color"],
      },
      {
        type: "completion_excludes",
        at: "ret_builtin_prefix",
        expect: [
          "ERROR", "namespace", "Java", "generate", "test", "generic",
          "isA", "trace", "class", "mixset",
        ],
      },

      // void return type — the case reserved from item 2.
      {
        type: "completion_kinds",
        at: "ret_void_prefix",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_void_prefix",
        expect: ["void", "Integer", "Person"],
      },

      // User-defined class return type prefix.
      {
        type: "completion_kinds",
        at: "ret_class_prefix",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_class_prefix",
        expect: ["Person", "void", "Integer"],
      },

      // abstract_method_declaration — class body with `abstract` keyword.
      {
        type: "completion_kinds",
        at: "ret_abstract_prefix",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_abstract_prefix",
        expect: ["void", "Integer", "Person"],
      },

      // method_signature — interface body.
      {
        type: "completion_kinds",
        at: "ret_iface_signature",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_iface_signature",
        expect: ["void", "Integer", "Person"],
      },

      // trait_method_signature — implicit-abstract branch.
      {
        type: "completion_kinds",
        at: "ret_trait_implicit",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_trait_implicit",
        expect: ["void", "Integer", "Person"],
      },

      // trait_method_signature — explicit-abstract branch.
      {
        type: "completion_kinds",
        at: "ret_trait_explicit",
        expect: "return_type_typed_prefix",
      },
      {
        type: "completion_includes",
        at: "ret_trait_explicit",
        expect: ["void", "Integer", "Person"],
      },

      // Negatives — must NOT be reclassified.
      // Method-name slot: isAtAttributeNamePosition already suppresses
      // completion here (prevLeaf sits under a type_name with fieldName
      // "return_type"). Confirms the stronger invariant: nothing useful
      // surfaces at the name slot, return_type_typed_prefix or otherwise.
      {
        type: "completion_kinds",
        at: "method_name_slot",
        expect: null,
      },
      // Parameter type: type_name's parent is `param`, not a method rule —
      // so the return-type field check excludes it. Topic 050 then routes
      // any cursor inside a `param_list` to the suppression path, so the
      // popup is empty rather than the wider class_body fallback.
      // Param-type typed-prefix narrowing is the future positive scope.
      {
        type: "completion_kinds",
        at: "param_type_slot",
        expect: null,
      },
    ],
  },

  // 134: Topic 049 phase 2 — constraint `[...]` own_attribute narrowing.
  // Scope classifies as `own_attribute`; emits only the enclosing class's
  // own attributes (Umple E28 — no inherited). Used to also surface every
  // parser keyword that wasn't in CONSTRAINT_BLOCKLIST; after the phase,
  // symbol-only.
  {
    name: "134 own_attribute_completion: constraint scope emits own attrs only, no raw keyword junk",
    fixtures: ["134_own_attribute_completion.ump"],
    assertions: [
      { type: "symbol_count", fixture: "134_own_attribute_completion.ump", name: "Person", kind: "class", expect: 1 },
      { type: "symbol_count", fixture: "134_own_attribute_completion.ump", name: "age", kind: "attribute", expect: 1 },

      // Scope classification.
      {
        type: "completion_kinds",
        at: "constraint_cursor",
        expect: "own_attribute",
      },

      // Own attrs present.
      {
        type: "completion_includes",
        at: "constraint_cursor",
        expect: ["name", "age"],
      },

      // Inherited attrs from `isA Base` must NOT be offered — Umple E28.
      {
        type: "completion_excludes",
        at: "constraint_cursor",
        expect: ["inheritedAttr", "basePriority"],
      },

      // No raw LookaheadIterator junk in the final completion list.
      {
        type: "completion_excludes",
        at: "constraint_cursor",
        expect: [
          "ERROR", "namespace", "class", "interface", "trait", "isA",
          "trace", "generate", "abstract", "mixset", "Java", "enum",
        ],
      },
    ],
  },

  // 135: Topic 050 — completion suppression in non-completion contexts.
  // Six positions that previously surfaced wrong popups now suppress (null)
  // or route to a more specific positive scope (transition_target). Six
  // negative regressions confirm adjacent legitimate scopes are unchanged.
  {
    name: "135 completion_suppression: wrong-popup positions now suppress or route correctly",
    fixtures: ["135_completion_suppression.ump"],
    assertions: [
      // Case 1 — attribute initializer broken expression
      { type: "completion_kinds", at: "attr_init_dash", expect: null },
      // Case 2 — bare complete multiplicity. The partial-association
      // refinement prevents `association_arrow`, and the dedicated bare-
      // multiplicity suppressor prevents the class_body fallback that
      // would otherwise surface 47 keywords on `*` trigger expansion.
      { type: "completion_kinds", at: "bare_mult_end", expect: null },
      // Case 3 — enumerated_attribute transition arrow → positive recovery
      { type: "completion_kinds", at: "enum_attr_transition", expect: "transition_target" },
      // Case 4 — broken method param-list start. Topic 052 item 4 turned
      // this from a topic-050 suppress into a positive parameter-type
      // completion scope.
      { type: "completion_kinds", at: "paren_open", expect: "param_type_typed_prefix" },
      // Case 5 — Java annotation
      { type: "completion_kinds", at: "annotation_at", expect: null },
      // Case 6 — malformed dash-identifier (three cursor positions)
      { type: "completion_kinds", at: "dash_after",  expect: null },
      { type: "completion_kinds", at: "dash_before", expect: null },
      { type: "completion_kinds", at: "dash_end",    expect: null },

      // Hyphenated req-id positions — `req_id` grammar allows hyphens, so
      // the dash-identifier suppressor must NOT fire here. Codex caught
      // this during topic 050 review. With a real req declared in the
      // fixture, all three positions correctly route to the requirement
      // completion scope.
      { type: "completion_kinds", at: "neg_hyphen_req_mid",     expect: ["requirement"] },
      { type: "completion_kinds", at: "neg_hyphen_req_partial", expect: ["requirement"] },
      { type: "completion_kinds", at: "neg_hyphen_req_full",    expect: ["requirement"] },

      // Negative regressions — these MUST stay on their existing positive
      // scopes. They share a code path with the new guards via the analyzer
      // ladder, so it's important to lock them in.
      { type: "completion_kinds", at: "neg_isa_typed_prefix",   expect: "isa_typed_prefix" },
      { type: "completion_kinds", at: "neg_decl_type_prefix",   expect: "decl_type_typed_prefix" },
      { type: "completion_kinds", at: "neg_assoc_typed_prefix", expect: "association_typed_prefix" },
      { type: "completion_kinds", at: "neg_arrow_slot",         expect: "association_arrow" },
      { type: "completion_kinds", at: "neg_mult_slot",          expect: "association_multiplicity" },
      { type: "completion_kinds", at: "neg_class_body",         expect: "class_body" },

      // Topic 051 stage-1 trigger expansion — comma continuation slots.
      // Positive: `isA X,|` routes to the typed-prefix scope (type-only),
      // not class_body's 50 raw keywords.
      { type: "completion_kinds", at: "stage1_isa_comma",   expect: "isa_typed_prefix" },
      // Topic 052 item 4 — param-decl comma is now a positive parameter-
      // type completion scope (was null/suppressed via topic 050).
      { type: "completion_kinds", at: "stage1_param_comma", expect: "param_type_typed_prefix" },
      // Negative: association sibling-slot comma must NOT become
      // isa_typed_prefix — it's a separate slot with its own scope.
      { type: "completion_kinds", at: "stage1_assoc_comma", expect: "association_type" },

      // ─── Topic 052 item 4 — parameter-type completion ─────────────────
      // Five positive shapes route to the new scalar; param-name slot
      // remains suppressed.
      { type: "completion_kinds", at: "param_blank_first",   expect: "param_type_typed_prefix" },
      { type: "completion_kinds", at: "param_typed_first",   expect: "param_type_typed_prefix" },
      { type: "completion_kinds", at: "param_builtin_first", expect: "param_type_typed_prefix" },
      { type: "completion_kinds", at: "param_blank_cont",    expect: "param_type_typed_prefix" },
      { type: "completion_kinds", at: "param_typed_cont",    expect: "param_type_typed_prefix" },
      { type: "completion_kinds", at: "param_name_slot",     expect: null },
      // Includes built-ins (excluding void) and class-likes; excludes raw
      // keyword junk and `void`.
      {
        type: "completion_includes",
        at: "param_blank_first",
        expect: ["Integer", "String", "Boolean", "Person", "Other"],
      },
      {
        type: "completion_excludes",
        at: "param_blank_first",
        expect: ["void", "ERROR", "namespace", "class", "isA"],
      },
      {
        type: "completion_includes",
        at: "param_blank_cont",
        expect: ["Person", "Integer"],
      },
      {
        type: "completion_excludes",
        at: "param_blank_cont",
        expect: ["void", "ERROR"],
      },

      // ─── Topic 053 — deferred trigger expansion (<, @, () support ───
      // Bare `isA T<|` → suppress (the helper detects ERROR shape with
      // [isA, qualified_name, <] and no -/+ marker).
      { type: "completion_kinds", at: "topic053_isa_lt_bare", expect: "suppress" },
      // `isA T<-|` / `isA T<+|` → trait_sm_op_sm via the new ERROR
      // recovery helper (the existing isInsideTraitAngleBrackets walk
      // misses because there's no isa_declaration ancestor in the broken
      // parse).
      { type: "completion_kinds", at: "topic053_isa_minus", expect: "trait_sm_op_sm" },
      { type: "completion_kinds", at: "topic053_isa_plus",  expect: "trait_sm_op_sm" },
      // Broken `void method|()` (no body) → null via the new
      // isInsideBrokenMethodNameSlot guard.
      { type: "completion_kinds", at: "topic053_broken_method_name", expect: null },
    ],
  },

  // 136: Topic 055 — closed `as |` slot completion. All trait bindings end
  // in `>;` so the parser stays clean and cold-open V2b state-recovery is
  // never triggered (V2b drops nested states beyond depth 1, which would
  // hide HostH/HostI's `Inner` from the index). Recovery shapes for
  // unclosed `as` / `<sm as ` live in fixture 137.
  {
    name: "136 referenced_sm_and_trait_binding: closed as-slot completion + nested states",
    fixtures: ["136_referenced_sm_and_trait_binding.ump"],
    assertions: [
      // Class-local SM dotted continuation — typed + bare dot.
      { type: "completion_kinds", at: "tsb_dotted_typed", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_dotted_typed", expect: ["S", "T2"] },
      { type: "completion_excludes", at: "tsb_dotted_typed", expect: ["isA", "before", "Integer", "void", "ERROR"] },

      { type: "completion_kinds", at: "tsb_dotted_blank", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_dotted_blank", expect: ["S"] },
      { type: "completion_excludes", at: "tsb_dotted_blank", expect: ["isA", "before", "Integer", "void", "ERROR"] },

      // Top-level SM dotted continuation — `isA T<sm as Global.|` and
      // `…Global.G|` must descend into the top-level standalone SM's
      // depth-1 states (codex follow-up: pre-fix the builder only checked
      // class-local containers and returned 0 items).
      { type: "completion_kinds", at: "tsb_top_dotted_blank", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_top_dotted_blank", expect: ["G1", "G2"] },
      { type: "completion_excludes", at: "tsb_top_dotted_blank", expect: ["isA", "before", "Integer", "void", "ERROR"] },

      { type: "completion_kinds", at: "tsb_top_dotted_typed", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_top_dotted_typed", expect: ["G1", "G2"] },

      // Nested-state continuation — `…status.S1.|` and `…status.S1.I|`
      // must descend into S1's child states. Pre-fix the analyzer only
      // carried the SM name; now `traitSmBindingStatePrefix` carries the
      // remainder of the path so the builder can call `getChildStateNames`.
      { type: "completion_kinds", at: "tsb_nested_dotted_blank", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_nested_dotted_blank", expect: ["Inner"] },
      { type: "completion_excludes", at: "tsb_nested_dotted_blank", expect: ["S2", "isA", "before", "Integer", "void"] },

      { type: "completion_kinds", at: "tsb_nested_dotted_typed", expect: "trait_sm_binding_state_target" },
      { type: "completion_includes", at: "tsb_nested_dotted_typed", expect: ["Inner"] },
      { type: "completion_excludes", at: "tsb_nested_dotted_typed", expect: ["S2", "isA", "before", "Integer", "void"] },
    ],
  },

  // 137: Topic 055 — unclosed `as` recovery shapes. Pre-055 the unclosed
  // `door as |`, `motorStatus as dev|`, and `isA T<sm as |…` shapes either
  // fell through to the raw-lookahead array fallback (175 keywords leaked)
  // or to class_body (curated keywords leaked). Post-055 they each route
  // to a dedicated scalar scope. This fixture deliberately keeps the
  // bindings unclosed so the analyzer's prevLeaf=`as` + ERROR-parent path
  // gets covered.
  {
    name: "137 as_slot_recovery_shapes: unclosed-typing recovery for as-slot",
    fixtures: ["137_as_slot_recovery_shapes.ump"],
    assertions: [
      // Class-local referenced_statemachine — offers HostA's own status SM.
      { type: "completion_kinds", at: "refsm_class_local", expect: "referenced_sm_target" },
      { type: "completion_includes", at: "refsm_class_local", expect: ["status"] },
      { type: "completion_excludes", at: "refsm_class_local", expect: ["isA", "before", "Integer", "void", "ERROR", "namespace"] },

      // Top-level standalone SM reuse — blank cursor, then mid-typed.
      { type: "completion_kinds", at: "refsm_top_blank", expect: "referenced_sm_target" },
      { type: "completion_includes", at: "refsm_top_blank", expect: ["deviceStatus"] },
      { type: "completion_excludes", at: "refsm_top_blank", expect: ["isA", "before", "Integer", "void", "ERROR"] },

      { type: "completion_kinds", at: "refsm_top_typed", expect: "referenced_sm_target" },
      { type: "completion_includes", at: "refsm_top_typed", expect: ["deviceStatus"] },

      // trait_sm_binding first segment — HostC's own `status` SM is the
      // class-local candidate, plus top-level `deviceStatus`.
      { type: "completion_kinds", at: "tsb_blank", expect: "trait_sm_binding_target" },
      { type: "completion_includes", at: "tsb_blank", expect: ["status", "deviceStatus"] },
      { type: "completion_excludes", at: "tsb_blank", expect: ["isA", "before", "Integer", "void", "ERROR", "namespace"] },

      { type: "completion_kinds", at: "tsb_typed", expect: "trait_sm_binding_target" },
      { type: "completion_includes", at: "tsb_typed", expect: ["status"] },
    ],
  },

  // 138: Topic 059 — Find Implementations on traits. Cursor on a trait
  // declaration name OR an `isA T` reference identifier should return
  // every class/trait declaration that implements the trait via `isA`,
  // both directly and transitively. Interfaces are excluded as
  // implementers AND the traversal does NOT descend through them.
  {
    name: "138 trait_implementations: find implementations of a trait via isA",
    fixtures: ["138_trait_implementations.ump"],
    assertions: [
      // Cursor on the trait declaration name → full implementer set.
      {
        type: "implementations",
        at: "trait_decl_Stringable",
        expectAt: [
          "trait_decl_Loggable",          // direct trait isA
          "class_decl_Person",            // direct class isA
          "class_decl_Logger",            // transitive: Logger → Loggable → Stringable
          "ac_decl_Membership",           // direct assoc-class isA (kind=class internally)
        ],
        excludeAt: [
          "iface_decl_Renderable",          // interface — excluded
          "class_decl_ViaIgnoredInterface", // not traversed through interface
          "class_decl_Plain",               // no isA at all
        ],
      },

      // Same set when cursor is on an `isA Stringable` reference inside
      // a class body (use-site).
      {
        type: "implementations",
        at: "isa_use_Person_in_Stringable",
        expectAt: [
          "trait_decl_Loggable",
          "class_decl_Person",
          "class_decl_Logger",
          "ac_decl_Membership",
        ],
        excludeAt: [
          "iface_decl_Renderable",
          "class_decl_ViaIgnoredInterface",
          "class_decl_Plain",
        ],
      },

      // Same set when cursor is on `isA Stringable` inside another trait.
      {
        type: "implementations",
        at: "isa_use_Loggable_in_Stringable",
        expectAt: [
          "trait_decl_Loggable",
          "class_decl_Person",
          "class_decl_Logger",
          "ac_decl_Membership",
        ],
      },

      // Negative: class with no subclasses returns [].
      { type: "implementations_empty", at: "class_decl_Person" },
      // Negative: cursor on a class with no isA at all returns [].
      { type: "implementations_empty", at: "class_decl_Plain" },
    ],
  },

  // 152: Find implementations beyond traits. Classes return subclasses
  // (including associationClass, stored as kind=class), while interfaces
  // return interface extensions plus class/trait implementers.
  {
    name: "152 implementation_targets: class subclasses and interface implementers",
    fixtures: ["152_implementation_targets.ump"],
    assertions: [
      {
        type: "implementations",
        at: "impl_class_base",
        expectAt: [
          "impl_class_direct",
          "impl_class_grand",
          "impl_class_assoc",
        ],
        excludeAt: [
          "impl_interface_noise",
          "impl_trait_noise",
          "impl_unrelated",
        ],
      },
      {
        type: "implementations",
        at: "impl_class_use_base",
        expectAt: [
          "impl_class_direct",
          "impl_class_grand",
          "impl_class_assoc",
        ],
      },
      {
        type: "implementations",
        at: "impl_iface_api",
        expectAt: [
          "impl_iface_extended",
          "impl_iface_direct_class",
          "impl_iface_transitive_class",
          "impl_iface_trait",
          "impl_iface_trait_user",
        ],
        excludeAt: ["impl_unrelated"],
      },
      {
        type: "implementations",
        at: "impl_iface_use_api",
        expectAt: [
          "impl_iface_extended",
          "impl_iface_direct_class",
          "impl_iface_transitive_class",
          "impl_iface_trait",
          "impl_iface_trait_user",
        ],
      },
    ],
  },

  // 139: Topic 059 — cross-file trait implementations via reverse-
  // importer discovery. Production-shaped test (mirrors the topic-25
  // `use_graph_refs` pattern): only the trait-decl fixture is fully
  // indexed; the importer fixture is loaded with `loadWithoutIndexing`,
  // its use-graph edges are injected, and the production-shaped helper
  // then computes reverse importers, lazy-indexes them, and runs
  // `findTraitImplementers`. This pins the server-handler scoping path,
  // not just the lower-level `findTraitImplementers` call with both
  // files already reachable.
  {
    name: "139 trait_impl_xfile: cross-file implementations via reverse importers + lazy indexing",
    fixtures: ["139_trait_impl_xfile.ump"],
    assertions: [
      {
        type: "use_graph_implementations",
        targetFixture: "139_trait_impl_xfile.ump",
        importerFixture: "139b_trait_impl_xfile_user.ump",
        at: "xfile_trait_decl",
        expectAt: ["xfile_impl_Shape"],
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

  function workspaceSymbolMatches(
    item: ReturnType<SemanticTestHelper["workspaceSymbols"]>[number],
    expected: { name: string; kind?: string; containerName?: string; fixture?: string },
  ): boolean {
    if (item.name !== expected.name) return false;
    if (expected.kind && lspSymbolKindName(item.kind) !== expected.kind) return false;
    if (
      expected.containerName !== undefined &&
      item.containerName !== expected.containerName
    ) return false;
    if (expected.fixture) {
      const fileInfo = files.get(expected.fixture);
      if (!fileInfo) return false;
      if (path.normalize(fileURLToPath(item.location.uri)) !== fileInfo.path) {
        return false;
      }
    }
    return true;
  }

  function workspaceSymbolLabel(
    item: ReturnType<SemanticTestHelper["workspaceSymbols"]>[number],
  ): string {
    const kind = lspSymbolKindName(item.kind);
    const container = item.containerName ? ` in ${item.containerName}` : "";
    return `${item.name}(${kind}${container})`;
  }

  function lspSymbolKindName(kind: LspSymbolKind): string {
    switch (kind) {
      case LspSymbolKind.Class:
        return "Class";
      case LspSymbolKind.Interface:
        return "Interface";
      case LspSymbolKind.Enum:
        return "Enum";
      case LspSymbolKind.EnumMember:
        return "EnumMember";
      case LspSymbolKind.Method:
        return "Method";
      case LspSymbolKind.Field:
        return "Field";
      case LspSymbolKind.Property:
        return "Property";
      case LspSymbolKind.Constant:
        return "Constant";
      case LspSymbolKind.String:
        return "String";
      case LspSymbolKind.Struct:
        return "Struct";
      case LspSymbolKind.Module:
        return "Module";
      default:
        return `SymbolKind(${kind})`;
    }
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

  if (assertion.type === "implementations") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };
    const impls = helper.implementationsAt(
      src.filePath, src.content, src.pos.line, src.pos.col, reachable,
    );

    // No-duplicates: every (file,line,column) appears at most once.
    const seen = new Set<string>();
    for (const r of impls) {
      const key = `${r.file}:${r.line}:${r.column}`;
      if (seen.has(key)) {
        return { ok: false, message: `implementations @${assertion.at}: duplicate location ${key}` };
      }
      seen.add(key);
    }

    // Exact-set check: the set of (file,line) keys returned by
    // findTraitImplementers must equal the set produced by resolving
    // expectAt markers. Off-by-one extras (e.g., an unintended `class A`)
    // are caught here even if they are not listed in `excludeAt`.
    const expectedKeys = new Set<string>();
    const expectedDescriptions: string[] = [];
    for (const markerName of assertion.expectAt) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `expected marker @${markerName} not found` };
      const key = `${target.filePath}:${target.pos.line}`;
      expectedKeys.add(key);
      expectedDescriptions.push(`@${markerName} (${path.basename(target.filePath)}:${target.pos.line})`);
    }
    const gotKeys = new Set(impls.map((r) => `${r.file}:${r.line}`));
    const gotDescriptions = impls.map((r) => `${path.basename(r.file)}:${r.line}`);

    const missing = [...expectedKeys].filter((k) => !gotKeys.has(k));
    const extra = [...gotKeys].filter((k) => !expectedKeys.has(k));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        message: `implementations @${assertion.at}: expected exact set {${expectedDescriptions.join(", ")}}, got {${gotDescriptions.join(", ")}}; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
      };
    }

    // Optional explicit-negative excludes (kept for clearer failure messages
    // on semantically-meaningful absences like interface filtering).
    for (const markerName of assertion.excludeAt ?? []) {
      const target = findMarker(markerName);
      if (!target) return { ok: false, message: `excluded marker @${markerName} not found` };
      const key = `${target.filePath}:${target.pos.line}`;
      if (gotKeys.has(key)) {
        return {
          ok: false,
          message: `implementations @${assertion.at}: @${markerName} (line ${target.pos.line}) should NOT appear in implementations`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "implementations_empty") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };
    const impls = helper.implementationsAt(
      src.filePath, src.content, src.pos.line, src.pos.col, reachable,
    );
    if (impls.length !== 0) {
      return {
        ok: false,
        message: `implementations_empty @${assertion.at}: expected 0, got ${impls.length}`,
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

  if (assertion.type === "use_graph_implementations") {
    const targetInfo = files.get(assertion.targetFixture);
    if (!targetInfo) return { ok: false, message: `target fixture ${assertion.targetFixture} not found` };

    const importerFiles = helper.loadWithoutIndexing(assertion.importerFixture);
    const importerInfo = importerFiles.get(assertion.importerFixture);
    if (!importerInfo) return { ok: false, message: `importer fixture ${assertion.importerFixture} not found` };

    files.set(assertion.importerFixture, importerInfo);
    helper.injectUseGraphEdges(importerInfo.path, importerInfo.content);

    const fileContents = new Map<string, string>();
    for (const [, f] of files) fileContents.set(f.path, f.content);

    const cursorMarker = targetInfo.markers.get(assertion.at);
    if (!cursorMarker) return { ok: false, message: `marker @${assertion.at} not found in target fixture` };

    const impls = helper.implementationsAtWithReverseImporters(
      targetInfo.path,
      targetInfo.content,
      cursorMarker.line,
      cursorMarker.col,
      reachable,
      fileContents,
    );

    // Exact-set check by (file,line).
    const expectedKeys = new Set<string>();
    const expectedDescriptions: string[] = [];
    for (const markerName of assertion.expectAt) {
      let target: { filePath: string; pos: MarkerPosition } | null = null;
      for (const f of files.values()) {
        const pos = f.markers.get(markerName);
        if (pos) { target = { filePath: f.path, pos }; break; }
      }
      if (!target) return { ok: false, message: `marker @${markerName} not found` };
      expectedKeys.add(`${target.filePath}:${target.pos.line}`);
      expectedDescriptions.push(`@${markerName} (${path.basename(target.filePath)}:${target.pos.line})`);
    }
    const gotKeys = new Set(impls.map((r) => `${r.file}:${r.line}`));
    const gotDescriptions = impls.map((r) => `${path.basename(r.file)}:${r.line}`);

    const missing = [...expectedKeys].filter((k) => !gotKeys.has(k));
    const extra = [...gotKeys].filter((k) => !expectedKeys.has(k));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        message: `use_graph_implementations: expected exact set {${expectedDescriptions.join(", ")}}, got {${gotDescriptions.join(", ")}}; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
      };
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

  if (assertion.type === "workspace_symbols") {
    const items = helper.workspaceSymbols(assertion.query);
    for (const expected of assertion.expect) {
      if (!items.some((item) => workspaceSymbolMatches(item, expected))) {
        return {
          ok: false,
          message: `workspace_symbols query=${JSON.stringify(assertion.query)} missing ${JSON.stringify(expected)} in [${items.map(workspaceSymbolLabel).join(", ")}]`,
        };
      }
    }
    for (const unexpected of assertion.exclude ?? []) {
      if (items.some((item) => workspaceSymbolMatches(item, unexpected))) {
        return {
          ok: false,
          message: `workspace_symbols query=${JSON.stringify(assertion.query)} unexpectedly included ${JSON.stringify(unexpected)} in [${items.map(workspaceSymbolLabel).join(", ")}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "inlay_hints") {
    const fileInfo = files.get(assertion.fixture);
    if (!fileInfo) return { ok: false, message: `fixture ${assertion.fixture} not found` };

    let range;
    if (assertion.range) {
      const start = fileInfo.markers.get(assertion.range.startAt);
      const end = fileInfo.markers.get(assertion.range.endAt);
      if (!start) return { ok: false, message: `range start marker @${assertion.range.startAt} not found` };
      if (!end) return { ok: false, message: `range end marker @${assertion.range.endAt} not found` };
      range = {
        start: { line: start.line, character: 0 },
        end: { line: end.line, character: Number.MAX_SAFE_INTEGER },
      };
    }

    const hints = helper.inlayHints(fileInfo.path, range);
    for (const expected of assertion.expect) {
      const marker = fileInfo.markers.get(expected.at);
      if (!marker) return { ok: false, message: `marker @${expected.at} not found` };
      const found = hints.some(
        (hint) =>
          hint.position.line === marker.line &&
          hint.position.character >= marker.col &&
          hint.label === expected.label,
      );
      if (!found) {
        return {
          ok: false,
          message: `inlay_hints @${expected.at}: expected ${JSON.stringify(expected.label)}, got [${hints.map((hint) => `${hint.position.line}:${hint.position.character} ${JSON.stringify(hint.label)}`).join(", ")}]`,
        };
      }
    }

    for (const markerName of assertion.excludeAt ?? []) {
      const marker = fileInfo.markers.get(markerName);
      if (!marker) return { ok: false, message: `excluded marker @${markerName} not found` };
      const found = hints.some(
        (hint) =>
          hint.position.line === marker.line &&
          hint.position.character >= marker.col,
      );
      if (found) {
        return {
          ok: false,
          message: `inlay_hints @${markerName}: expected no hint on marker line, got [${hints.map((hint) => `${hint.position.line}:${hint.position.character} ${JSON.stringify(hint.label)}`).join(", ")}]`,
        };
      }
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

  if (assertion.type === "hover_excludes") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };

    const markdown = helper.hoverAt(src.filePath, src.content, src.pos.line, src.pos.col, reachable);
    if (!markdown) {
      return {
        ok: false,
        message: `hover_excludes @${assertion.at}: hover returned null`,
      };
    }

    for (const unexpected of assertion.expect) {
      if (markdown.includes(unexpected)) {
        return {
          ok: false,
          message: `hover_excludes @${assertion.at}: did not expect "${unexpected}" in hover, got: ${markdown.substring(0, 200)}`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "rename_edits") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };
    const result = helper.renameAt(
      src.filePath, src.content, src.pos.line, src.pos.col,
      assertion.newName, reachable,
    );
    if (result.status !== "ok") {
      return {
        ok: false,
        message: `rename_edits @${assertion.at} newName="${assertion.newName}": expected status=ok, got ${result.status}`,
      };
    }
    if (assertion.expectCount !== undefined && result.edits.length !== assertion.expectCount) {
      return {
        ok: false,
        message: `rename_edits @${assertion.at}: expected ${assertion.expectCount} edits, got ${result.edits.length}`,
      };
    }
    for (const markerName of assertion.expectAt) {
      const target = findMarker(markerName);
      if (!target) {
        return { ok: false, message: `rename_edits @${assertion.at}: expected marker @${markerName} not found in fixture` };
      }
      const hit = result.edits.some((e) =>
        path.normalize(e.file) === target.filePath &&
        e.line === target.pos.line &&
        e.column === target.pos.col,
      );
      if (!hit) {
        return {
          ok: false,
          message: `rename_edits @${assertion.at}: expected edit at @${markerName} (${target.pos.line}:${target.pos.col}), got [${result.edits.map(e => e.line + ':' + e.column).join(', ')}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "rename_edits_workspace") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };
    const workspaceScope = new Set<string>();
    for (const f of files.values()) {
      workspaceScope.add(f.path);
    }
    const result = helper.renameAt(
      src.filePath, src.content, src.pos.line, src.pos.col,
      assertion.newName, reachable, workspaceScope,
    );
    if (result.status !== "ok") {
      return {
        ok: false,
        message: `rename_edits_workspace @${assertion.at} newName="${assertion.newName}": expected status=ok, got ${result.status}`,
      };
    }
    if (assertion.expectCount !== undefined && result.edits.length !== assertion.expectCount) {
      return {
        ok: false,
        message: `rename_edits_workspace @${assertion.at}: expected ${assertion.expectCount} edits, got ${result.edits.length}`,
      };
    }
    for (const markerName of assertion.expectAt) {
      const target = findMarker(markerName);
      if (!target) {
        return { ok: false, message: `rename_edits_workspace @${assertion.at}: expected marker @${markerName} not found in fixture` };
      }
      const hit = result.edits.some((e) =>
        path.normalize(e.file) === target.filePath &&
        e.line === target.pos.line &&
        e.column === target.pos.col,
      );
      if (!hit) {
        return {
          ok: false,
          message: `rename_edits_workspace @${assertion.at}: expected edit at @${markerName} (${target.pos.line}:${target.pos.col}), got [${result.edits.map(e => e.line + ':' + e.column).join(', ')}]`,
        };
      }
    }
    return { ok: true, message: "" };
  }

  if (assertion.type === "rename_rejected") {
    const src = findMarker(assertion.at);
    if (!src) return { ok: false, message: `marker @${assertion.at} not found` };
    const result = helper.renameAt(
      src.filePath, src.content, src.pos.line, src.pos.col,
      assertion.newName, reachable,
    );
    if (result.status !== assertion.reason) {
      return {
        ok: false,
        message: `rename_rejected @${assertion.at} newName="${assertion.newName}": expected status=${assertion.reason}, got ${result.status}`,
      };
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

  // ── Semantic tokens ─────────────────────────────────────────────────────
  // Real tree-sitter highlight-query captures, mapped into the LSP semantic
  // token legend. This pins the server-side highlighting path used by editors
  // that do not load highlights.scm directly.
  {
    const testName = "semantic_tokens: highlight query maps core Umple tokens";
    try {
      const filePath = "/tmp/semantic_tokens_probe.ump";
      const content = [
        "class Person {",
        "  Integer age;",
        "  void setAge(Integer value) { }",
        "  conjugated port String outbox;",
        "  outbox -> other.inbox;",
        "  atomic active run() { }",
        "  override test setup { }",
        "  testSequence ts { check -> done; }",
        "  position 1 2.5 3 4.75;",
        "  position.association A__B:p1 -1.2,3 4,-5.6;",
        "  status {",
        "    Open { close -> Closed; }",
        "    Closed {}",
        "  }",
        "}",
        "tracer log4j root = all, warning on : status \"audit\";",
        "strictness allow 30;",
        "distributable 1 forced;",
        "// comment",
      ].join("\n");
      helper.si.indexFile(filePath, content);

      const captures = helper.si.getHighlightCaptures(filePath);
      const entries = buildSemanticTokenEntries(captures);
      const encoded = buildSemanticTokens(captures);
      if (entries.length === 0) {
        throw new Error("expected semantic token entries, got none");
      }
      if (encoded.data.length !== entries.length * 5) {
        throw new Error(
          `encoded data length ${encoded.data.length} does not match entry count ${entries.length}`,
        );
      }

      const lines = content.split("\n");
      function tokenText(entry: SemanticTokenEntry): string {
        return lines[entry.line].slice(
          entry.character,
          entry.character + entry.length,
        );
      }
      function hasToken(
        text: string,
        type: UmpleSemanticTokenType,
        modifier?: UmpleSemanticTokenModifier,
      ): boolean {
        return entries.some(
          (entry) =>
            tokenText(entry) === text &&
            entry.tokenType === type &&
            (!modifier || entry.tokenModifiers.includes(modifier)),
        );
      }

      const expected: Array<[
        string,
        UmpleSemanticTokenType,
        UmpleSemanticTokenModifier?,
      ]> = [
        ["class", "keyword"],
        ["Person", "class", "definition"],
        ["Integer", "type", "defaultLibrary"],
        ["age", "property"],
        ["setAge", "method"],
        ["value", "parameter"],
        ["conjugated", "modifier"],
        ["port", "keyword"],
        ["outbox", "property"],
        ["other", "property"],
        ["inbox", "property"],
        ["atomic", "modifier"],
        ["active", "keyword"],
        ["run", "method"],
        ["override", "modifier"],
        ["test", "keyword"],
        ["setup", "method"],
        ["testSequence", "keyword"],
        ["ts", "method"],
        ["check", "method"],
        ["done", "method"],
        ["2.5", "number"],
        ["A__B:p1", "property"],
        ["-1.2,3", "number"],
        ["Open", "variable", "readonly"],
        ["close", "event"],
        ["tracer", "keyword"],
        ["log4j", "type"],
        ["root", "property"],
        ["all", "property"],
        ["warning", "property"],
        ["on", "modifier"],
        ["status", "property"],
        ["\"audit\"", "string"],
        ["strictness", "keyword"],
        ["allow", "modifier"],
        ["30", "number"],
        ["distributable", "keyword"],
        ["forced", "modifier"],
        ["position", "keyword"],
        ["// comment", "comment"],
      ];
      for (const [text, type, modifier] of expected) {
        if (!hasToken(text, type, modifier)) {
          throw new Error(
            `missing semantic token ${text}:${type}${modifier ? `:${modifier}` : ""}; got ${entries.map((entry) => `${tokenText(entry)}:${entry.tokenType}:${entry.tokenModifiers.join("+")}`).join(", ")}`,
          );
        }
      }

      for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1];
        const curr = entries[i];
        if (
          curr.line < prev.line ||
          (curr.line === prev.line && curr.character < prev.character)
        ) {
          throw new Error(`semantic token entries are not sorted at index ${i}`);
        }
        if (
          curr.line === prev.line &&
          curr.character < prev.character + prev.length
        ) {
          throw new Error(`semantic token entries overlap at index ${i}`);
        }
      }

      console.log(`  PASS  ${testName}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  ${testName}: ${e.message}`);
      failed++;
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

  // ── Direct test: generated clean formatter inputs ───────────────────────
  //
  // This is intentionally deterministic: it gives us property-style coverage
  // without adding a test dependency. Each generated model starts parse-clean,
  // runs through the full formatter, and must remain parse-clean,
  // symbol-preserving, and idempotent.
  {
    const testName = "format_generated_models: clean, symbol-preserving, idempotent";
    try {
      let seed = 0x5eed1234;
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
      };
      const pick = <T>(values: T[]): T => values[next() % values.length];
      const indent = () => pick(["", " ", "  ", "    ", "\t"]);

      const symbolKeys = (filePath: string): string[] =>
        helper.si.getFileSymbols(filePath)
          .map((s: any) => `${s.kind}:${s.name}:${s.container ?? ""}:${s.statePath?.join(".") ?? ""}`)
          .sort();

      const generatedModels: string[] = [];
      for (let i = 0; i < 36; i++) {
        const classA = `C${i}A`;
        const classB = `C${i}B`;
        const event = `go${i}`;
        const reset = `reset${i}`;
        generatedModels.push([
          `${indent()}class ${classA} {`,
          `${indent()}name${i};`,
          `${indent()}Integer count${i}=5;`,
          `${indent()}Boolean flag${i} = true;`,
          `${indent()}status${pick(["", " "])}{`,
          `${indent()}Open { ${event}->Closed; }`,
          `${indent()}Closed { ${reset} -> Open; }`,
          `${indent()}}`,
          `${indent()}void bump${i}(Integer value) {`,
          `${indent()}int local = value;`,
          `${indent()}local = local + 1;`,
          `${indent()}}`,
          `${indent()}}`,
          pick(["", "\n"]),
          `${indent()}class ${classB} {`,
          `${indent()}label${i} = "x";`,
          `${indent()}}`,
          "",
          `${indent()}association {`,
          `${indent()}1 ${classA}${pick(["--", " -- ", "  --"])}* ${classB};`,
          `${indent()}}`,
        ].join("\n"));
      }

      for (let i = 0; i < 12; i++) {
        const iface = `I${i}`;
        const parentIface = `J${i}`;
        const trait = `T${i}`;
        const classA = `GeneratedA${i}`;
        const classB = `GeneratedB${i}`;
        const mixset = `Feature${i}`;
        const filter = `Filter${i}`;
        generatedModels.push([
          `${indent()}interface ${parentIface} {`,
          `${indent()}void marker${i}();`,
          `${indent()}}`,
          "",
          `${indent()}interface ${iface} {`,
          `${indent()}isA ${parentIface};`,
          `${indent()}const Integer MAX${i}=10;`,
          `${indent()}void op${i}(String name,Integer count);`,
          `${indent()}}`,
          "",
          `${indent()}trait ${trait}<TP isA ${iface} = ${classA}, TP2> {`,
          `${indent()}isA ${iface};`,
          `${indent()}flag${i}=true;`,
          `${indent()}abstract void needed${i}();`,
          `${indent()}}`,
          "",
          `${indent()}class ${classA} {`,
          `${indent()}isA ${iface},${trait};`,
          `${indent()}name${i};`,
          `${indent()}}`,
          "",
          `${indent()}class ${classB} {`,
          `${indent()}Integer count${i}=1;`,
          `${indent()}}`,
          "",
          `${indent()}filter ${filter} {`,
          `${indent()}include ${classA},${classB};`,
          `${indent()}namespace generated.ns${i},other.ns${i};`,
          `${indent()}hops { super 1; sub 1; association 1; }`,
          `${indent()}}`,
          "",
          `${indent()}req R${i} userStory {`,
          `${indent()}who { user${i} }`,
          `${indent()}what { thing${i} }`,
          `${indent()}why { reason${i} }`,
          `${indent()}}`,
          "",
          `${indent()}mixset ${mixset} {`,
          `${indent()}class Mixed${i} {`,
          `${indent()}label${i}=\"x\";`,
          `${indent()}}`,
          `${indent()}}`,
        ].join("\n"));
      }

      for (let i = 0; i < 8; i++) {
        const left = `GeneratedLeft${i}`;
        const right = `GeneratedRight${i}`;
        const assoc = `GeneratedLink${i}`;
        const inject = `Injected${i}`;
        const globalSm = `GlobalSm${i}`;
        const reuser = `ReuseHolder${i}`;
        const mixset = `RichFeature${i}`;
        generatedModels.push([
          `${indent()}enum GeneratedColor${i} { Red${i},Blue${i},Green${i} }`,
          "",
          `${indent()}class ${left} {`,
          `${indent()}name${i};`,
          `${indent()}}`,
          "",
          `${indent()}class ${right} {`,
          `${indent()}Integer value${i}=1;`,
          `${indent()}}`,
          "",
          `${indent()}associationClass ${assoc} {`,
          `${indent()}1 ${left};`,
          `${indent()}* ${right};`,
          `${indent()}String note${i};`,
          `${indent()}}`,
          "",
          `${indent()}statemachine ${globalSm} {`,
          `${indent()}Off { start${i}->On; }`,
          `${indent()}On { stop${i}->Off; }`,
          `${indent()}}`,
          "",
          `${indent()}class ${reuser} {`,
          `${indent()}machine${i} as ${globalSm} {`,
          `${indent()}Off { localStart${i}->On; }`,
          `${indent()}}`,
          `${indent()}}`,
          "",
          `${indent()}class ${inject} {`,
          `${indent()}name${i};`,
          `${indent()}Integer count${i}=0;`,
          `${indent()}void setName${i}(String value) {`,
          `${indent()}name${i} = value;`,
          `${indent()}}`,
          `${indent()}void setCount${i}(Integer value) {`,
          `${indent()}count${i} = value;`,
          `${indent()}}`,
          `${indent()}trace set,get name${i},count${i};`,
          `${indent()}}`,
          "",
          `${indent()}before { ${inject},* } setName${i}(String value),setCount${i}(Integer value) {`,
          `${indent()}System.out.println(value);`,
          `${indent()}}`,
          "",
          `${indent()}mixset ${mixset} {`,
          `${indent()}class MixedGenerated${i} {`,
          `${indent()}Integer size${i}=1;`,
          `${indent()}status${i} { Active${i} { done${i}->Inactive${i}; } Inactive${i} {} }`,
          `${indent()}}`,
          `${indent()}trait MixedTrait${i} {`,
          `${indent()}abstract void run${i}();`,
          `${indent()}}`,
          `${indent()}}`,
        ].join("\n"));
      }

      for (let i = 0; i < generatedModels.length; i++) {
        const filePath = `/tmp/format_generated_${i}.ump`;
        const content = generatedModels[i];

        helper.si.indexFile(filePath, content);
        const originalTree = helper.si.getTree(filePath);
        if (!originalTree || originalTree.rootNode.hasError) {
          throw new Error(`generated model ${i} did not start parse-clean:\n${content}`);
        }
        const originalSymbols = symbolKeys(filePath);

        const pass1Text = helper.formatFile(filePath, content).join("\n");
        helper.si.indexFile(filePath, pass1Text);
        const formattedTree = helper.si.getTree(filePath);
        if (!formattedTree || formattedTree.rootNode.hasError) {
          throw new Error(`generated model ${i} formatted to parse errors:\n${pass1Text}`);
        }
        const formattedSymbols = symbolKeys(filePath);
        if (JSON.stringify(originalSymbols) !== JSON.stringify(formattedSymbols)) {
          throw new Error(
            `generated model ${i} changed symbols: before=${originalSymbols.join(", ")} after=${formattedSymbols.join(", ")}`,
          );
        }

        const pass2Text = helper.formatFile(filePath, pass1Text).join("\n");
        if (pass1Text !== pass2Text) {
          throw new Error(`generated model ${i} was not idempotent:\n--- pass1 ---\n${pass1Text}\n--- pass2 ---\n${pass2Text}`);
        }
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

  // ── LSP completion trigger-character contract ──────────────────────────
  // These are advertised during initialize. The server can compute the right
  // items at these slots, but editors only auto-popup if they ask after the
  // character was typed.
  {
    const testName = "completion_triggers: advertise structural retriggers";
    try {
      const expected = ["/", ".", "-", ",", "<", "@", "(", " "];
      const actual: string[] = [...COMPLETION_TRIGGER_CHARACTERS];
      for (const ch of expected) {
        if (!actual.includes(ch)) {
          throw new Error(`Missing trigger character ${JSON.stringify(ch)} in [${actual.join(", ")}]`);
        }
      }
      if (new Set(actual).size !== actual.length) {
        throw new Error(`Trigger characters contain duplicates: [${actual.join(", ")}]`);
      }
      if (actual.includes("*")) {
        throw new Error("Star should not be advertised as a trigger; class names need a whitespace boundary");
      }
      if (actual.includes(">")) {
        throw new Error("Greater-than should not be advertised as a trigger; next slots need a whitespace boundary");
      }
      if (!shouldServeWhitespaceTriggeredCompletion("association_type")) {
        throw new Error("Whitespace trigger should be served for association_type");
      }
      if (!shouldServeWhitespaceTriggeredCompletion("association_multiplicity")) {
        throw new Error("Whitespace trigger should be served for association_multiplicity");
      }
      const requirementSlot = ["requirement"] as ["requirement"];
      if (!shouldServeWhitespaceTriggeredCompletion(requirementSlot)) {
        throw new Error("Whitespace trigger should be served for requirement slots");
      }
      if (shouldServeWhitespaceTriggeredCompletion("class_body")) {
        throw new Error("Whitespace trigger should not serve broad class_body completions");
      }
      if (shouldServeWhitespaceTriggeredCompletion("top_level")) {
        throw new Error("Whitespace trigger should not serve broad top_level completions");
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

  // ── Snippet regression block (topic 054) ───────────────────────────────────
  // Verifies per-scope emission, capability gating, shape (kind / format /
  // insertText / filterText), and the negative scopes that must stay snippet-free.
  {
    const snippetCases: Array<{
      scope: string;
      src: string;
      line: number;
      col: number;
      expectedLabels: string[];
    }> = [
      {
        scope: "top_level",
        src: "\n",
        line: 0,
        col: 0,
        expectedLabels: [
          "class block",
          "interface block",
          "trait block",
          "association block",
          "statemachine (top-level)",
          "filter block",
          "req userStory",
          "req useCase",
          "use file",
        ],
      },
      {
        scope: "class_body",
        src: "class C {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: [
          "attribute (typed)",
          "method",
          "isA inheritance",
          "inline association",
          "state machine",
          "enum attribute",
          "implementsReq link",
          "before method",
          "after method",
        ],
      },
      {
        scope: "trait_body",
        src: "trait T {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: [
          "attribute (typed)",
          "method",
          "isA inheritance",
          "inline association",
          "state machine",
          "enum attribute",
          "implementsReq link",
          "before method",
          "after method",
        ],
      },
      {
        scope: "assoc_class_body",
        src: "associationClass A {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: [
          "attribute (typed)",
          "isA inheritance",
          "inline association",
          "enum attribute",
          "implementsReq link",
        ],
      },
      {
        scope: "interface_body",
        src: "interface I {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: ["const declaration", "method signature"],
      },
      {
        scope: "statemachine_body",
        src: "statemachine SM {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: ["state", "final state"],
      },
      {
        scope: "state_body",
        src: "class C {\n  status {\n    S {\n      \n    }\n  }\n}\n",
        line: 3,
        col: 6,
        expectedLabels: [
          "state",
          "final state",
          "transition",
          "guarded transition",
          "entry activity",
          "exit activity",
          "do activity",
        ],
      },
      {
        scope: "filter_body",
        src: "filter F {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: [
          "include statement",
          "includeFilter statement",
          "namespace statement",
          "hops block",
        ],
      },
      {
        scope: "userstory_body",
        src: "req R userStory {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: ["who tag", "when tag", "what tag", "why tag"],
      },
      {
        scope: "usecase_body",
        src: "req UC useCase {\n  \n}\n",
        line: 1,
        col: 2,
        expectedLabels: [
          "who tag",
          "when tag",
          "what tag",
          "why tag",
          "userStep block",
          "systemResponse block",
        ],
      },
    ];

    const snippetByLabel = new Map(ALL_SNIPPETS.map((s) => [s.label, s]));
    const snippetTmp = "/tmp/snippet_regression.ump";
    const snippetReach = new Set<string>([snippetTmp]);

    // Positive: every expected label is present, with correct shape.
    for (const c of snippetCases) {
      const testName = `snippets.positive: scope=${c.scope}`;
      try {
        helper.si.indexFile(snippetTmp, c.src);
        const items = helper.completionItemsWithSnippets(
          c.src,
          c.line,
          c.col,
          snippetReach,
        );
        const snippetItems = items.filter(
          (i) => i.kind === CompletionItemKind.Snippet,
        );
        // Exact-set equality on label set
        const got = new Set(snippetItems.map((i) => i.label));
        const want = new Set(c.expectedLabels);
        if (got.size !== want.size || ![...want].every((l) => got.has(l))) {
          throw new Error(
            `expected snippet labels ${JSON.stringify([...want].sort())}, got ${JSON.stringify([...got].sort())}`,
          );
        }
        // Shape: kind, format, insertText, filterText match the registry entry.
        for (const item of snippetItems) {
          const entry = snippetByLabel.get(item.label as string);
          if (!entry) {
            throw new Error(`unexpected label ${item.label} not in registry`);
          }
          if (item.kind !== CompletionItemKind.Snippet) {
            throw new Error(`label ${item.label} kind ${item.kind} not Snippet`);
          }
          if (item.insertTextFormat !== InsertTextFormat.Snippet) {
            throw new Error(
              `label ${item.label} insertTextFormat ${item.insertTextFormat} not Snippet`,
            );
          }
          if (item.insertText !== entry.insertText) {
            throw new Error(
              `label ${item.label} insertText mismatch:\n  want: ${entry.insertText}\n  got:  ${item.insertText}`,
            );
          }
          if (item.filterText !== entry.filterText) {
            throw new Error(
              `label ${item.label} filterText ${item.filterText} != ${entry.filterText}`,
            );
          }
          if (
            typeof item.sortText !== "string" ||
            !item.sortText.startsWith("z9_snippet_")
          ) {
            throw new Error(
              `label ${item.label} sortText ${item.sortText} missing z9_snippet_ prefix`,
            );
          }
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Capability disabled: every positive scope must yield zero snippet items.
    for (const c of snippetCases) {
      const testName = `snippets.capability_disabled: scope=${c.scope}`;
      try {
        helper.si.indexFile(snippetTmp, c.src);
        const items = helper.completionItems(
          c.src,
          c.line,
          c.col,
          snippetReach,
        );
        const snippetItems = items.filter(
          (i) => i.kind === CompletionItemKind.Snippet,
        );
        if (snippetItems.length !== 0) {
          throw new Error(
            `expected 0 snippet items with snippetSupport=false, got ${snippetItems.length}: ${snippetItems.map((i) => i.label).join(", ")}`,
          );
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Negative: scopes where no snippet should ever appear.
    const negativeCases: Array<{ name: string; src: string; line: number; col: number }> = [
      { name: "method body (suppress)", src: "class C {\n  void m() { \n  }\n}\n", line: 1, col: 14 },
      { name: "isa typed prefix", src: "class C {\n  isA P\n}\n", line: 1, col: 7 },
      { name: "comment", src: "// blah\n", line: 0, col: 5 },
      { name: "attribute typed name slot", src: "class C {\n  Integer x\n}\n", line: 1, col: 11 },
      { name: "method param-list", src: "class C {\n  void m(\n  ) {}\n}\n", line: 1, col: 9 },
      { name: "definition name (class C|)", src: "class C\n", line: 0, col: 7 },
      { name: "java annotation (@|)", src: "class C {\n  @\n  void m() {}\n}\n", line: 1, col: 3 },
    ];
    for (const c of negativeCases) {
      const testName = `snippets.negative: ${c.name}`;
      try {
        helper.si.indexFile(snippetTmp, c.src);
        const items = helper.completionItemsWithSnippets(
          c.src,
          c.line,
          c.col,
          snippetReach,
        );
        const snippetItems = items.filter(
          (i) => i.kind === CompletionItemKind.Snippet,
        );
        if (snippetItems.length !== 0) {
          throw new Error(
            `expected 0 snippet items, got ${snippetItems.length}: ${snippetItems.map((i) => i.label).join(", ")}`,
          );
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Registry sanity: no two snippet entries share both label + scope.
    {
      const testName = "snippets.registry: unique label per scope";
      try {
        const seen = new Map<string, string>();
        for (const entry of ALL_SNIPPETS) {
          for (const scope of entry.scopes) {
            const key = `${scope}::${entry.label}`;
            if (seen.has(key)) {
              throw new Error(
                `duplicate label "${entry.label}" in scope "${scope}"`,
              );
            }
            seen.set(key, entry.label);
          }
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // ── Compiler validation: every default expansion must compile clean. ────
    // Each snippet's $N placeholders are replaced with their default text,
    // wrapped in a per-scope scaffold that pre-declares any referenced
    // identifiers (parent class / association target / req / filter target),
    // and fed to `umplesync.jar -generate nothing`. Any diagnostic line
    // (errorCode / severity / Error / Warning) fails the assertion.
    {
      const fs = require("fs");
      const os = require("os");
      const { spawnSync } = require("child_process");
      const jarPath = path.resolve(
        __dirname,
        "../../umplesync.jar",
      );
      const haveJar = fs.existsSync(jarPath);
      const javaProbe = spawnSync("java", ["-version"], { stdio: "ignore" });
      const haveJava = javaProbe.status === 0;
      if (!haveJar || !haveJava) {
        console.log(
          `  SKIP  snippets.compiler_validation: ${haveJar ? "" : "umplesync.jar missing"}${!haveJar && !haveJava ? "; " : ""}${haveJava ? "" : "java not on PATH"}`,
        );
      } else {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snippet-validate-"));
        // Pre-create a sibling .ump file referenced by the "use file" snippet.
        fs.writeFileSync(path.join(tmpDir, "file.ump"), "// stub\n", "utf8");

        const expandDefaults = (insertText: string): string => {
          // Replace ${N:default} → default ; ${N} → empty ; $N (no braces) → empty
          let s = insertText.replace(/\$\{\d+:([^{}]*)\}/g, "$1");
          s = s.replace(/\$\{\d+\}/g, "");
          s = s.replace(/\$\d+/g, "");
          return s;
        };

        // Per-snippet scaffold extras keyed by snippet label. These satisfy
        // references that the snippet's default expansion makes to identifiers
        // outside the snippet body itself (e.g., `before methodName` requires
        // `methodName` to be a real method on the wrapper class).
        const classBodyExtras = (label: string): string => {
          if (label === "before method" || label === "after method") {
            return "  void methodName() { }\n";
          }
          return "";
        };
        const stateBodyExtras = (label: string): string => {
          if (label === "transition" || label === "guarded transition") {
            return "    NextState { }\n";
          }
          return "";
        };
        const buildScaffold = (
          scope: string,
          body: string,
          label: string,
        ): string => {
          switch (scope) {
            case "top_level":
              return [
                "class LeftClass {}",
                "class RightClass {}",
                "class ClassName {}",
                "class OtherClass {}",
                "class ParentClass {}",
                "filter OtherFilter { include ClassName; }",
                "req R1 userStory { what { x } }",
                body,
                "",
              ].join("\n");
            case "class_body":
            case "assoc_class_body": {
              const extras = classBodyExtras(label);
              const wrapper = scope === "assoc_class_body"
                ? `class LeftEnd {}\nclass RightEnd {}\nassociationClass Wrap {\n  * LeftEnd l;\n  * RightEnd r;\n${extras}${body}\n}\n`
                : `class Wrap {\n${extras}${body}\n}\n`;
              return [
                "class ParentClass {}",
                "class OtherClass {}",
                "req R1 userStory { what { x } }",
                wrapper,
              ].join("\n");
            }
            case "trait_body":
              return [
                "trait ParentClass {}",
                "class OtherClass {}",
                "req R1 userStory { what { x } }",
                `trait Wrap {\n${classBodyExtras(label)}${body}\n}\n`,
              ].join("\n");
            case "interface_body":
              return `interface IfaceWrap {\n${body}\n}\n`;
            case "statemachine_body":
              return `class Wrap {\n  status {\n${body}\n  }\n}\n`;
            case "state_body":
              return `class Wrap {\n  status {\n    S {\n${body}\n    }\n${stateBodyExtras(label)}  }\n}\n`;
            case "filter_body":
              return [
                "class ClassName {}",
                "filter OtherFilter { include ClassName; }",
                `filter FilterWrap {\n${body}\n}\n`,
              ].join("\n");
            case "userstory_body":
              return `req ReqWrap userStory {\n${body}\n}\n`;
            case "usecase_body":
              return `req UcWrap useCase {\n${body}\n}\n`;
            default:
              throw new Error(`unknown scope: ${scope}`);
          }
        };

        const diagnosticRegex = /"errorCode"|"severity"|^Error|^Warning/m;

        // Captures stdout AND stderr regardless of exit status — umplesync.jar
        // exits 0 even when it writes parser diagnostics to stderr. Returns the
        // diagnostic blob if any line matches the regex; null otherwise.
        const runUmpleSync = (filePath: string): string | null => {
          const result = spawnSync(
            "java",
            ["-jar", jarPath, "-generate", "nothing", filePath],
            {
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
            },
          );
          const stdout = result.stdout ? String(result.stdout) : "";
          const stderr = result.stderr ? String(result.stderr) : "";
          const combined = `${stdout}\n${stderr}`;
          if (result.error) {
            return `compile failed to spawn: ${result.error.message}`;
          }
          if (diagnosticRegex.test(combined)) {
            return combined.trim();
          }
          // Non-zero exit with no diagnostic line still counts as failure.
          if (result.status !== 0) {
            return combined.trim() || `non-zero exit: ${result.status}`;
          }
          return null;
        };

        // ── Self-check: prove the validator catches stderr-only diagnostics ──
        // Known invalid input: `filter F { hops 2; }` triggers errorCode 1502
        // and the JSON is written to stderr while the process exits 0.
        // If this self-check fails, the validator is missing diagnostics —
        // skip the per-snippet pass to avoid silent green.
        let validatorSelfCheckOk = true;
        {
          const testName = "snippets.compiler_validation: self-check (stderr capture)";
          try {
            const probeFile = path.join(tmpDir, "_self_check.ump");
            fs.writeFileSync(probeFile, "filter F { hops 2; }\n", "utf8");
            const diag = runUmpleSync(probeFile);
            if (!diag) {
              throw new Error(
                "validator did not detect known-invalid `filter F { hops 2; }` " +
                  "(stderr likely missed)",
              );
            }
            console.log(`  PASS  ${testName}`);
            passed++;
          } catch (e: any) {
            validatorSelfCheckOk = false;
            console.log(`  FAIL  ${testName}: ${e.message}`);
            failed++;
          }
        }

        let snippetIndex = 0;
        for (const entry of ALL_SNIPPETS) {
          if (!validatorSelfCheckOk) break;
          for (const scope of entry.scopes) {
            const testName = `snippets.compiler_validation: ${scope} :: ${entry.label}`;
            try {
              const expanded = expandDefaults(entry.insertText);
              const wrapped = buildScaffold(scope, expanded, entry.label);
              const tmpFile = path.join(
                tmpDir,
                `snip_${snippetIndex++}.ump`,
              );
              fs.writeFileSync(tmpFile, wrapped, "utf8");
              const diag = runUmpleSync(tmpFile);
              if (diag) {
                throw new Error(
                  `compiler diagnostic on default expansion:\n--- file ---\n${wrapped}\n--- diag ---\n${diag}`,
                );
              }
              console.log(`  PASS  ${testName}`);
              passed++;
            } catch (e: any) {
              console.log(`  FAIL  ${testName}: ${e.message}`);
              failed++;
            }
          }
        }

        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Topic 056 — quick-fix code actions ───────────────────────────────────
  // Pure tests against `buildQuickFixActions()` from `src/codeActions.ts`.
  // No LSP transport, no compiler invocation; we hand-craft Diagnostics that
  // mirror what `parseUmpleJsonDiagnostics()` produces.
  {
    const { buildQuickFixActions } = require("../src/codeActions");
    const { TextDocument } = require("vscode-languageserver-textdocument");
    const {
      DiagnosticSeverity,
      Range,
      Position,
    } = require("vscode-languageserver/node");

    const URI = "file:///tmp/code_actions_probe.ump";
    const SOURCE = UMPLE_DIAGNOSTIC_SOURCE;

    function makeDoc(text: string): any {
      return TextDocument.create(URI, "umple", 1, text);
    }
    function makeDiag(line: number, lineText: string, code: string, severity = DiagnosticSeverity.Warning, message?: string, source: string = SOURCE) {
      const startCol = lineText.search(/\S/);
      return {
        severity,
        range: Range.create(
          Position.create(line, startCol === -1 ? 0 : startCol),
          Position.create(line, lineText.length),
        ),
        message: message ?? `${code}: Attribute or Association syntax could not be processed`,
        source,
        code,
      };
    }

    type Case = {
      name: string;
      text: string;
      diagLine: number;
      code: string;
      message?: string;
      severity?: any;
      source?: string;
      expectActions: number;
      expectInsertCol?: number;
    };

    const cases: Case[] = [
      // Positive — five W1007 shapes that need `;`.
      { name: "attribute (Integer x)", text: "class A {\n  Integer x\n  String y;\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertCol: 11 },
      { name: "attribute (hello world)", text: "class A {\n  hello world\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertCol: 13 },
      { name: "isA list", text: "class P {}\nclass A {\n  isA P\n}\n", diagLine: 2, code: "W1007", expectActions: 1, expectInsertCol: 7 },
      { name: "implementsReq list", text: "req R1 userStory {}\nclass A {\n  implementsReq R1\n}\n", diagLine: 2, code: "W1007", expectActions: 1, expectInsertCol: 18 },
      { name: "inline association", text: "class B {}\nclass A {\n  1 -- * B b\n}\n", diagLine: 2, code: "W1007", expectActions: 1, expectInsertCol: 12 },
      { name: "interface method signature", text: "interface I {\n  void m()\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertCol: 10 },

      // Trailing line comment — insert before the `//`, after trimming
      // trailing whitespace.
      { name: "trailing line comment", text: "class A {\n  Integer x  // note\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertCol: 11 },

      // Negative — class-body method signature: `void m();` is still W1007.
      { name: "class-body method signature (codex edge)", text: "class A {\n  void m()\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Negative — expression line.
      { name: "expression operator (foo + bar)", text: "class A {\n  foo + bar\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Negative — already terminated (defensive).
      { name: "already terminated", text: "class A {\n  Integer x;\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Negative — comment-only line.
      { name: "comment-only line", text: "class A {\n  // not a statement\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Negative — unrelated diagnostic codes.
      { name: "W50 unrelated", text: "class A {\n  status { S { e -> Missing; } }\n}\n", diagLine: 1, code: "W50", expectActions: 0 },
      { name: "E1503 unrelated", text: "class A {\n  } extra\n}\n", diagLine: 1, code: "E1503", severity: DiagnosticSeverity.Error, expectActions: 0 },
      // Topic 057 lifted the E1502 defer — block-scan now identifies the
      // `include C` line and emits an action targeting it. Even when the
      // diagnostic line is the include line itself (rather than the filter
      // header), the block-scan still locates a single candidate.
      { name: "E1502 filter include (now supported)", text: "class C {}\nfilter F {\n  include C\n}\n", diagLine: 2, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertCol: 11 },

      // Negative — imported-file message.
      { name: "imported-file diagnostic", text: 'use "Other.ump";\nclass A {}\n', diagLine: 0, code: "W1007", message: "In imported file (Other.ump:3): W1007: Attribute or Association syntax could not be processed", expectActions: 0 },

      // Negative — non-umple source.
      { name: "non-umple source", text: "class A {\n  Integer x\n}\n", diagLine: 1, code: "W1007", source: "other-linter", expectActions: 0 },

      // Negative — association-end rewrites are too semantic for a quick fix.
      { name: "association block two standalone ends E1502", text: "class Person {}\nclass PersonRole {}\nassociation {\n  0..2 PersonRole;\n  1 Person;\n}\n", diagLine: 2, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },
      { name: "association block two standalone ends E1505", text: "association {\n  0..2 PersonRole;\n  1 Person;\n}\nclass PersonRole {}\nclass Person {}\n", diagLine: 0, code: "E1505", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Negative — diagnostic line out of range.
      { name: "diag line out of range", text: "class A {}\n", diagLine: 99, code: "W1007", expectActions: 0 },

      // Negative — codex follow-up: structural keyword as first token. The
      // attribute classifier used to accept these because they're "two
      // bare identifiers", but `class B;` / `state S;` becomes a W131
      // attribute warning rather than recovering the user's intent.
      { name: "structural keyword `class B` (codex edge)", text: "class A {\n  class B\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
      { name: "structural keyword `state S` (codex edge)", text: "class A {\n  state S\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
      { name: "structural keyword `interface I`", text: "class A {\n  interface I\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
      { name: "structural keyword `trait T`", text: "class A {\n  trait T\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Negative — codex follow-up: arrow without multiplicity. `foo -> bar;`
      // fires E3607 (port-name resolution), so the semicolon doesn't fix
      // the diagnostic. Real associations always include a multiplicity.
      { name: "arrow without multiplicity `foo -> bar` (codex edge)", text: "class A {\n  foo -> bar\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },

      // Positive — a second association shape (codex confirmed clean).
      { name: "association `1 -> * B`", text: "class B {}\nclass A {\n  1 -> * B\n}\n", diagLine: 2, code: "W1007", expectActions: 1, expectInsertCol: 10 },

      // Positive — diagnostics from older server builds used source `umple`.
      { name: "legacy umple diagnostic source", text: "class A {\n  Integer x\n}\n", diagLine: 1, code: "W1007", source: LEGACY_UMPLE_DIAGNOSTIC_SOURCE, expectActions: 1, expectInsertCol: 11 },
    ];

    for (const c of cases) {
      const testName = `code_action.semicolon: ${c.name}`;
      try {
        const doc = makeDoc(c.text);
        const lineText = c.text.split("\n")[c.diagLine] ?? "";
        const diag = makeDiag(
          c.diagLine,
          lineText,
          c.code,
          c.severity ?? DiagnosticSeverity.Warning,
          c.message,
          c.source ?? SOURCE,
        );
        const actions = buildQuickFixActions(doc, [diag]);
        if (actions.length !== c.expectActions) {
          throw new Error(
            `expected ${c.expectActions} action(s), got ${actions.length}: ${actions.map((a: any) => a.title).join(", ")}`,
          );
        }
        if (c.expectActions === 1) {
          const action = actions[0];
          if (action.title !== "Add missing semicolon") {
            throw new Error(`unexpected title: ${action.title}`);
          }
          if (action.kind !== "quickfix") {
            throw new Error(`unexpected kind: ${action.kind}`);
          }
          const edits = action.edit?.changes?.[URI];
          if (!edits || edits.length !== 1) {
            throw new Error(`expected 1 edit, got ${edits?.length ?? 0}`);
          }
          const e = edits[0];
          if (e.newText !== ";") {
            throw new Error(`unexpected newText: ${JSON.stringify(e.newText)}`);
          }
          if (c.expectInsertCol !== undefined) {
            if (
              e.range.start.line !== c.diagLine ||
              e.range.start.character !== c.expectInsertCol ||
              e.range.end.line !== c.diagLine ||
              e.range.end.character !== c.expectInsertCol
            ) {
              throw new Error(
                `expected insert at (${c.diagLine},${c.expectInsertCol}), got (${e.range.start.line},${e.range.start.character})-(${e.range.end.line},${e.range.end.character})`,
              );
            }
          }
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Brace-nearby context: ensure interface detection doesn't accidentally
    // treat method signatures inside non-interface blocks as positive.
    {
      const testName = "code_action.semicolon: brace-nearby class wraps interface (negative)";
      try {
        const text = "class Outer {\n  // Outer's method\n  void m()\n}\ninterface I {}\n";
        const doc = makeDoc(text);
        const lineText = text.split("\n")[2];
        const diag = makeDiag(2, lineText, "W1007");
        const actions = buildQuickFixActions(doc, [diag]);
        if (actions.length !== 0) {
          throw new Error(`expected 0 actions, got ${actions.length}: ${actions.map((a: any) => a.title).join(", ")}`);
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Positive smoke: interface body across surrounding class still wins.
    {
      const testName = "code_action.semicolon: interface inside file with class (positive)";
      try {
        const text = "class Outer {\n  Integer x;\n}\ninterface I {\n  void m()\n}\n";
        const doc = makeDoc(text);
        const lineText = text.split("\n")[4];
        const diag = makeDiag(4, lineText, "W1007");
        const actions = buildQuickFixActions(doc, [diag]);
        if (actions.length !== 1) {
          throw new Error(`expected 1 action, got ${actions.length}`);
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // Code-field discrimination: `buildQuickFixActions` must dispatch on
    // `Diagnostic.code` (set by parseUmpleJsonDiagnostics in server.ts).
    // Verify by feeding two diagnostics with the SAME range/source/message
    // shape but different codes — only the W1007 one should produce an
    // action, even though their text content is otherwise identical.
    {
      const testName = "code_action.code_dispatch: buildQuickFixActions dispatches on Diagnostic.code";
      try {
        const text = "class A {\n  Integer x\n}\n";
        const doc = makeDoc(text);
        const lineText = text.split("\n")[1];
        const diagW1007 = makeDiag(1, lineText, "W1007");
        const diagW50 = { ...makeDiag(1, lineText, "W50"), severity: DiagnosticSeverity.Warning };
        const both = buildQuickFixActions(doc, [diagW1007, diagW50]);
        if (both.length !== 1) {
          throw new Error(`expected 1 action, got ${both.length}`);
        }
        if (both[0].diagnostics?.[0].code !== "W1007") {
          throw new Error(`action attached to wrong diag: ${both[0].diagnostics?.[0].code}`);
        }
        // Same diagnostic but with code stripped → no action.
        const stripped = { ...diagW1007 };
        delete (stripped as any).code;
        const noCode = buildQuickFixActions(doc, [stripped]);
        if (noCode.length !== 0) {
          throw new Error(`expected 0 actions when code is missing, got ${noCode.length}`);
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }
  }

  // ── Topic 057 — code-action follow-ups ──────────────────────────────────
  // Item 1: W1006 transition shapes; Item 2: E1502 filter block-scan;
  // Item 3: default-value attribute extension. Same pure-test harness as
  // topic 056 but with new code dispatch and the new classifier paths.
  {
    const { buildQuickFixActions } = require("../src/codeActions");
    const { TextDocument } = require("vscode-languageserver-textdocument");
    const {
      DiagnosticSeverity,
      Range,
      Position,
    } = require("vscode-languageserver/node");

    const URI = "file:///tmp/code_actions_057.ump";
    const SOURCE = UMPLE_DIAGNOSTIC_SOURCE;

    function makeDoc(text: string): any {
      return TextDocument.create(URI, "umple", 1, text);
    }
    function makeDiag(line: number, lineText: string, code: string, severity = DiagnosticSeverity.Warning, source: string = SOURCE) {
      const startCol = lineText.search(/\S/);
      return {
        severity,
        range: Range.create(
          Position.create(line, startCol === -1 ? 0 : startCol),
          Position.create(line, lineText.length),
        ),
        message: `${code}: probe`,
        source,
        code,
      };
    }

    type Case = {
      name: string;
      text: string;
      diagLine: number;
      code: string;
      severity?: any;
      expectActions: number;
      expectInsertLine?: number;
      expectInsertCol?: number;
    };

    // ── Item 1: W1006 state-machine transitions ─────────────────────────
    const w1006Cases: Case[] = [
      // Positive
      { name: "W1006 simple transition `e -> s2`", text: "class A {\n  sm {\n    s1 {\n      e -> s2\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 1, expectInsertLine: 3, expectInsertCol: 13 },
      { name: "W1006 guarded `e [x>0] -> s2`", text: "class A {\n  Integer x;\n  sm {\n    s1 {\n      e [x>0] -> s2\n    }\n  }\n}\n", diagLine: 4, code: "W1006", expectActions: 1, expectInsertLine: 4, expectInsertCol: 19 },
      { name: "W1006 action `e / { x = 1; } -> s2`", text: "class A {\n  Integer x;\n  sm {\n    s1 {\n      e / { x = 1; } -> s2\n    }\n  }\n}\n", diagLine: 4, code: "W1006", expectActions: 1, expectInsertLine: 4, expectInsertCol: 26 },
      { name: "W1006 dotted RHS `e -> Outer.Inner`", text: "class A {\n  sm {\n    s1 {\n      e -> Outer.Inner\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 1, expectInsertLine: 3, expectInsertCol: 22 },

      // Negative
      { name: "W1006 incomplete `e ->`", text: "class A {\n  sm {\n    s1 {\n      e ->\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 0 },
      { name: "W1006 random content", text: "class A {\n  sm {\n    s1 {\n      unrecognized stuff here\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 0 },
      { name: "W1006 already terminated", text: "class A {\n  sm {\n    s1 {\n      e -> s2;\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 0 },
      { name: "W1006 trailing comma", text: "class A {\n  sm {\n    s1 {\n      e -> s2,\n    }\n  }\n}\n", diagLine: 3, code: "W1006", expectActions: 0 },
    ];

    // ── Item 3: W1007 default-value attribute ───────────────────────────
    const w1007DefaultCases: Case[] = [
      // Positive
      { name: "default-value Integer = number", text: "class A {\n  Integer x = 5\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertLine: 1, expectInsertCol: 15 },
      { name: 'default-value String = "Bob"', text: 'class A {\n  String name = "Bob"\n}\n', diagLine: 1, code: "W1007", expectActions: 1, expectInsertLine: 1, expectInsertCol: 21 },
      { name: "default-value Boolean = true", text: "class A {\n  Boolean active = true\n}\n", diagLine: 1, code: "W1007", expectActions: 1, expectInsertLine: 1, expectInsertCol: 23 },
      { name: "default-value Integer = otherAttr", text: "class A {\n  Integer y;\n  Integer x = y\n}\n", diagLine: 2, code: "W1007", expectActions: 1, expectInsertLine: 2, expectInsertCol: 15 },
      { name: "default-value String = string with space", text: 'class A {\n  String name = "Bob Smith"\n}\n', diagLine: 1, code: "W1007", expectActions: 1, expectInsertLine: 1, expectInsertCol: 27 },

      // Negative
      { name: "default-value expression RHS `a + b`", text: "class A {\n  Integer x = a + b\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
      { name: "default-value generic type `List<String> names`", text: "class A {\n  List<String> names\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
      { name: "default-value paren RHS `f()`", text: "class A {\n  Integer x = f()\n}\n", diagLine: 1, code: "W1007", expectActions: 0 },
    ];

    for (const c of [...w1006Cases, ...w1007DefaultCases]) {
      const testName = `code_action.057: ${c.name}`;
      try {
        const doc = makeDoc(c.text);
        const lineText = c.text.split("\n")[c.diagLine] ?? "";
        const diag = makeDiag(c.diagLine, lineText, c.code, c.severity ?? DiagnosticSeverity.Warning);
        const actions = buildQuickFixActions(doc, [diag]);
        if (actions.length !== c.expectActions) {
          throw new Error(`expected ${c.expectActions} actions, got ${actions.length}: ${actions.map((a: any) => a.title).join(", ")}`);
        }
        if (c.expectActions === 1) {
          const e = actions[0].edit?.changes?.[URI]?.[0];
          if (!e) throw new Error("no edit attached");
          if (
            (c.expectInsertLine !== undefined && e.range.start.line !== c.expectInsertLine) ||
            (c.expectInsertCol !== undefined && e.range.start.character !== c.expectInsertCol)
          ) {
            throw new Error(`expected insert at (${c.expectInsertLine},${c.expectInsertCol}), got (${e.range.start.line},${e.range.start.character})`);
          }
          if (e.newText !== ";") throw new Error(`unexpected newText: ${JSON.stringify(e.newText)}`);
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }

    // ── Item 2: E1502 filter block-scan ─────────────────────────────────
    // The diagnostic's reported line is the filter HEADER. The action must
    // edit the unterminated statement INSIDE the block, and only when
    // exactly one candidate exists.
    const e1502Cases: Case[] = [
      // Positive — diag at filter header, edit at inner statement.
      { name: "E1502 single `include C` (diag at header)", text: "class C {}\nfilter F {\n  include C\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertLine: 2, expectInsertCol: 11 },
      { name: "E1502 single `includeFilter G`", text: "filter G {}\nfilter F {\n  includeFilter G\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertLine: 2, expectInsertCol: 17 },
      { name: "E1502 single `namespace x.y`", text: "filter F {\n  namespace x.y\n}\n", diagLine: 0, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertLine: 1, expectInsertCol: 15 },
      { name: "E1502 dotted namespace `foo.bar.baz`", text: "filter F {\n  namespace foo.bar.baz\n}\n", diagLine: 0, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertLine: 1, expectInsertCol: 23 },

      // Negative — multiple unterminated candidates → ambiguous.
      { name: "E1502 multiple unterminated candidates", text: "class C {}\nfilter F {\n  include C\n  namespace x.y\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Negative — the bad shape isn't a missing-semicolon issue.
      { name: "E1502 unrelated `bogus X`", text: "filter F {\n  bogus X\n}\n", diagLine: 0, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Negative — already terminated; classifier rejects.
      { name: "E1502 already terminated", text: "class C {}\nfilter F {\n  include C;\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Negative — `hops { … }` is a clean construct; even if a stale
      // E1502 arrived, no semicolon-fix candidate is found.
      { name: "E1502 hops block (defensive)", text: "filter F {\n  hops { super 1; sub 1; association 1; }\n}\n", diagLine: 0, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Codex follow-up: nested `hops { include C }` must not trigger.
      // Compiler still raises E1502 even after appending `;` to the inner
      // `include C`, so the action is unsafe.
      { name: "E1502 nested hops with include (codex edge)", text: "class C {}\nfilter F {\n  hops {\n    include C\n  }\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 0 },

      // Codex optional follow-up: legitimate top-level `include C` still
      // gets the action even when a sibling `hops { … }` block lives in
      // the same filter body. Proves the depth tracker doesn't over-block.
      { name: "E1502 top-level include alongside hops", text: "class C {}\nfilter F {\n  hops { super 1; sub 1; association 1; }\n  include C\n}\n", diagLine: 1, code: "E1502", severity: DiagnosticSeverity.Error, expectActions: 1, expectInsertLine: 3, expectInsertCol: 11 },
    ];

    for (const c of e1502Cases) {
      const testName = `code_action.057: ${c.name}`;
      try {
        const doc = makeDoc(c.text);
        const lineText = c.text.split("\n")[c.diagLine] ?? "";
        const diag = makeDiag(c.diagLine, lineText, c.code, c.severity ?? DiagnosticSeverity.Warning);
        const actions = buildQuickFixActions(doc, [diag]);
        if (actions.length !== c.expectActions) {
          throw new Error(`expected ${c.expectActions} actions, got ${actions.length}: ${actions.map((a: any) => a.title).join(", ")}`);
        }
        if (c.expectActions === 1) {
          const e = actions[0].edit?.changes?.[URI]?.[0];
          if (!e) throw new Error("no edit attached");
          if (e.range.start.line !== c.expectInsertLine || e.range.start.character !== c.expectInsertCol) {
            throw new Error(`expected insert at (${c.expectInsertLine},${c.expectInsertCol}), got (${e.range.start.line},${e.range.start.character})`);
          }
          if (e.newText !== ";") throw new Error(`unexpected newText: ${JSON.stringify(e.newText)}`);
        }
        console.log(`  PASS  ${testName}`);
        passed++;
      } catch (e: any) {
        console.log(`  FAIL  ${testName}: ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test harness error:", err);
  process.exit(2);
});
