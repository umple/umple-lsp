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
  | ChildStatesAssertion
  | CompletionKindsAssertion
  | CompletionIncludesAssertion
  | CompletionExcludesAssertion
  | TokenContextAssertion;

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test harness error:", err);
  process.exit(2);
});
