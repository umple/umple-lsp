/**
 * Completion context analysis.
 *
 * Pure analysis of a parsed tree + cursor position to produce CompletionInfo.
 * No dependency on SymbolIndex class or any index state.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Language = InstanceType<typeof TreeSitter.Language>;
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;
type Query = InstanceType<typeof TreeSitter.Query>;

import type { SymbolKind } from "./tokenTypes";
import { resolveEnclosingScope } from "./treeUtils";

// ── Completion-specific constants ───────────────────────────────────────────

/**
 * Keywords after which the next token is always a new name (definition).
 * Completions are suppressed when the cursor immediately follows one of these.
 */
const DEFINITION_KEYWORDS = new Set([
  "class",
  "interface",
  "trait",
  "enum",
  "mixset",
  "req",
  "associationClass",
  "statemachine",
  "namespace",
  "queued",
  "pooled",
  "emit",
]);

/** Structural tokens that should NOT appear in completions. */
const STRUCTURAL_TOKENS = new Set([
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  ".",
  "<",
  ">",
  "=",
  "/",
  "[]",
  "*",
  "||",
]);

function isOperatorToken(name: string): boolean {
  return /^[<>-]/.test(name) && name.length > 1;
}

// ── Typed-prefix detection helpers (topic 048 phase 1) ──────────────────────

/**
 * The standard gate for typed-prefix detection: letter-leading identifier
 * nodes. Shared by every typed-prefix classification block. Letter-leading
 * ensures we don't misclassify digit-leading tokens (multiplicity bits, etc.)
 * that the parser occasionally recovers as `identifier`.
 */
function isLetterLeadingIdentifier(node: SyntaxNode): boolean {
  return node.type === "identifier" && /^[A-Za-z_]/.test(node.text);
}

/**
 * Walk up from `start` looking for a `type_name` node. On hit, return true
 * iff type_name's parent rule is in `parentTypes` AND the child field name
 * equals `fieldName`. Bails at any node in `boundaryTypes`. Used by the
 * declaration-type and return-type typed-prefix detections, whose shapes are
 * `identifier < qualified_name < type_name < <parent-rule>` with a specific
 * grammar-level field binding the type_name into its parent.
 */
function isInsideTypeNameFieldSlot(
  start: SyntaxNode,
  parentTypes: ReadonlySet<string>,
  fieldName: string,
  boundaryTypes: ReadonlySet<string>,
): boolean {
  let n: SyntaxNode | null = start.parent;
  while (n) {
    if (n.type === "type_name") {
      const p = n.parent;
      if (p && parentTypes.has(p.type)) {
        for (let i = 0; i < p.childCount; i++) {
          if (p.child(i)?.id === n.id) {
            return p.fieldNameForChild(i) === fieldName;
          }
        }
      }
      return false;
    }
    if (boundaryTypes.has(n.type)) return false;
    n = n.parent;
  }
  return false;
}

const TYPE_SLOT_BOUNDARIES: ReadonlySet<string> = new Set([
  "class_definition",
  "trait_definition",
  "interface_definition",
  "association_class_definition",
  "source_file",
]);

const DECL_TYPE_PARENTS: ReadonlySet<string> = new Set([
  "attribute_declaration",
  "const_declaration",
]);

const RETURN_TYPE_PARENTS: ReadonlySet<string> = new Set([
  "method_declaration",
  "abstract_method_declaration",
  "method_signature",
  "trait_method_signature",
]);

// ── CompletionInfo type ─────────────────────────────────────────────────────

/** Information needed by the completion handler. */
export interface CompletionInfo {
  /** Keywords the parser expects at this position. */
  keywords: string[];
  /** Operators the parser expects at this position. */
  operators: string[];
  /** Which symbol kinds to offer, or null for none. */
  symbolKinds: SymbolKind[] | "suppress" | "use_path" | "own_attribute" | "guard_attribute_method" | "trace_attribute_method" | "trace_state" | "trace_method" | "trace_state_method" | "trace_attribute" | "sorted_attribute" | "trait_sm_op_sm" | "trait_sm_op_state" | "trait_sm_op_state_event" | "trait_sm_op_event" | "top_level" | "class_body" | "trait_body" | "interface_body" | "assoc_class_body" | "mixset_body" | "statemachine_body" | "state_body" | "filter_body" | "transition_target" | "userstory_body" | "usecase_body" | "association_multiplicity" | "association_type" | "association_typed_prefix" | "association_arrow" | "isa_typed_prefix" | "decl_type_typed_prefix" | "return_type_typed_prefix" | "code_injection_method" | "filter_include_target" | "param_type_typed_prefix" | "referenced_sm_target" | "trait_sm_binding_target" | "trait_sm_binding_state_target" | null;
  /** True if cursor is at a definition-name position (suppress all). */
  isDefinitionName: boolean;
  /** True if cursor is inside a comment. */
  isComment: boolean;
  /** Text of the token at the cursor (identifier or use_path), empty if none. */
  prefix: string;
  /** Name of enclosing class (for scoped attribute lookups). */
  enclosingClass?: string;
  /** Name of enclosing root state machine (for scoped state lookups). */
  enclosingStateMachine?: string;
  /** Dotted path prefix for state completions (e.g., ["EEE", "Open"] when typing "EEE.Open."). */
  dottedStatePrefix?: string[];
  /** Owner class for sorted key completion (resolved from association AST). */
  sortedKeyOwner?: string;
  /** Trait SM operation completion context. */
  traitSmContext?: { traitName: string; smName?: string; statePath?: string[] };
  /** Topic 055 — SM name when scope is `trait_sm_binding_state_target`. */
  traitSmBindingSmName?: string;
  /**
   * Topic 055 — Path segments AFTER the SM name when scope is
   * `trait_sm_binding_state_target`. Empty for `Sm.|`, `["S1"]` for
   * `Sm.S1.|` / `Sm.S1.I|`, etc.
   */
  traitSmBindingStatePrefix?: string[];
}

// ── Main analysis function ──────────────────────────────────────────────────

/**
 * Analyze the completion context at a given position in a parsed tree.
 *
 * @param tree             Pre-parsed tree for the document
 * @param language         Tree-sitter language (for LookaheadIterator)
 * @param completionsQuery Loaded completions.scm query
 * @param content          Document text
 * @param line             0-based line
 * @param column           0-based column
 */
export function analyzeCompletion(
  tree: Tree,
  language: Language,
  completionsQuery: Query,
  content: string,
  line: number,
  column: number,
): CompletionInfo {
  const empty: CompletionInfo = {
    keywords: [],
    operators: [],
    symbolKinds: null,
    isDefinitionName: false,
    isComment: false,
    prefix: "",
  };

  // --- Comment check ---
  const nodeAtCursor = tree.rootNode.descendantForPosition({
    row: line,
    column: Math.max(0, column - 1),
  });
  if (nodeAtCursor && isInsideComment(nodeAtCursor)) {
    return { ...empty, isComment: true };
  }

  // Pre-compute prevLeaf — needed by both the suppression ladder
  // (`isInsideMethodParamListStart` distinguishes param-type slots from
  // suppress positions using prevLeaf) and the rest of the analyzer.
  const earlyPrevLeaf = findPreviousLeaf(tree, content, line, column);
  const cursorOffset = offsetAt(content, line, column);
  if (earlyPrevLeaf?.type === "->" && earlyPrevLeaf.endIndex === cursorOffset) {
    return empty;
  }

  // --- Topic 050: contexts where any popup would be wrong ────────────────
  // Each guard returns `empty` (symbolKinds=null, keywords=[], operators=[])
  // so completionBuilder shows nothing. Order matters: java_annotation
  // first because it can wrap content that resembles other contexts; the
  // structural ones (param-list, attribute initializer) before the textual
  // identifier-fragment guard.
  if (nodeAtCursor && isInsideJavaAnnotation(nodeAtCursor)) return empty;
  if (nodeAtCursor && isInsideMethodParamListStart(nodeAtCursor, earlyPrevLeaf)) return empty;
  if (nodeAtCursor && isInsideAttributeInitializer(nodeAtCursor)) return empty;
  if (isInsideMalformedDashIdentifier(content, line, column, nodeAtCursor)) return empty;
  if (nodeAtCursor && isBareCompleteMultiplicityAtEnd(nodeAtCursor, content, line, column)) return empty;
  if (nodeAtCursor && isInsideBrokenMethodNameSlot(nodeAtCursor)) return empty;

  // --- Extract prefix from the token at cursor ---
  let prefix = "";
  if (
    column > 0 &&
    nodeAtCursor &&
    (nodeAtCursor.type === "identifier" || nodeAtCursor.type === "use_path")
  ) {
    const nodeStartCol =
      nodeAtCursor.startPosition.row === line
        ? nodeAtCursor.startPosition.column
        : 0;
    prefix = nodeAtCursor.text.substring(0, column - nodeStartCol);
  }

  // --- Definition name check ---
  const lastToken = lastTokenBeforeCursor(content, line, column);
  if (
    (lastToken && DEFINITION_KEYWORDS.has(lastToken)) ||
    isAtAttributeNamePosition(tree, content, line, column)
  ) {
    return { ...empty, isDefinitionName: true };
  }

  // --- LookaheadIterator for keywords ---
  const prevLeaf = earlyPrevLeaf;
  const stateId = prevLeaf
    ? prevLeaf.nextParseState
    : (nodeAtCursor?.parseState ?? 0);
  const keywords: string[] = [];
  const operators: string[] = [];

  const iter = language.lookaheadIterator(stateId);
  if (iter) {
    try {
      for (const symbolName of iter) {
        const typeId = iter.currentTypeId;
        if (language.nodeTypeIsNamed(typeId)) continue;
        if (STRUCTURAL_TOKENS.has(symbolName)) continue;

        if (isOperatorToken(symbolName)) {
          operators.push(symbolName);
        } else if (/^[a-zA-Z]/.test(symbolName)) {
          keywords.push(symbolName);
        }
      }
    } finally {
      iter.delete();
    }
  }

  // --- Scope query for symbol kinds ---
  let symbolKinds = resolveCompletionScope(completionsQuery, tree, line, column);

  // top_level scope guard: only valid when cursor lands directly on source_file
  // (between top-level constructs or in an empty file).  If the cursor is inside
  // a child node (ERROR from partial require, filter body, etc.), the source_file
  // capture is too broad — downgrade to null so we don't leak curated keywords
  // into non-top-level positions.
  if (nodeAtCursor?.type === "source_file") {
    symbolKinds = "top_level";
  } else if (symbolKinds === "top_level") {
    symbolKinds = null;
  }

  // --- before/after method-name completion (position-aware) ---
  const baNode = nodeAtCursor?.type === "identifier" && nodeAtCursor.parent?.type === "before_after"
    ? nodeAtCursor : (prevLeaf?.type === "identifier" && prevLeaf.parent?.type === "before_after" ? prevLeaf : null);
  if (baNode && line === baNode.startPosition.row && column <= baNode.endPosition.column) {
    const firstId = baNode.parent!.namedChildren.find((c: SyntaxNode) => c.type === "identifier");
    if (firstId && firstId.id === baNode.id) {
      symbolKinds = ["method"];
    }
  }

  // --- Trace completion fallback for zero-identifier case ("trace |") ---
  // Trace entity fallbacks for zero-identifier recovery
  const TRACE_PREFIX_KEYWORDS = new Set(["trace", "set", "get", "in", "out", "entry", "exit", "cardinality", "add", "remove"]);
  if (prevLeaf && TRACE_PREFIX_KEYWORDS.has(prevLeaf.type)) {
    // Check if inside a trace_statement or ERROR under class body
    let inTrace = prevLeaf.parent?.type === "trace_statement";
    if (!inTrace && prevLeaf.parent?.type === "ERROR") {
      let n = prevLeaf.parent.parent;
      while (n) {
        if (n.type === "trace_statement") { inTrace = true; break; }
        if (n.type === "class_definition") {
          // "trace" directly in ERROR under class → trace context
          if (prevLeaf.type === "trace") inTrace = true;
          break;
        }
        if (n.type === "source_file") break;
        n = n.parent;
      }
    }
    if (inTrace) symbolKinds = "trace_attribute_method";
  }

  // --- Trace comma fallback: later entity in trace list gets same scope ---
  if (
    prevLeaf?.type === "," &&
    prevLeaf.parent?.type === "trace_statement"
  ) {
    symbolKinds = "trace_attribute_method";
  }
  // Also handle comma inside ERROR within trace_statement
  if (
    prevLeaf?.type === "," &&
    prevLeaf.parent?.type === "ERROR"
  ) {
    let n = prevLeaf.parent.parent;
    while (n) {
      if (n.type === "trace_statement") { symbolKinds = "trace_attribute_method"; break; }
      if (n.type === "class_definition" || n.type === "source_file") break;
      n = n.parent;
    }
  }

  // --- Zero-identifier completion fallbacks ---
  const CLASS_LIKE_TYPES = new Set([
    "class_definition", "trait_definition",
    "interface_definition", "association_class_definition",
  ]);

  if (prevLeaf?.type === "isA" && prevLeaf.parent?.type === "ERROR") {
    const errorParent = prevLeaf.parent.parent;
    if (errorParent && CLASS_LIKE_TYPES.has(errorParent.type)) {
      // Topic 052 item 1 — route blank `isA |` through the same scalar
      // scope used by `isA P|` (typed prefix) and `isA T,|` (comma
      // continuation). The array form fell through to the fallback path
      // and emitted built-ins + `void`, none of which are valid `isA`
      // parents. The scalar takes the symbol-only builder branch that
      // returns class / interface / trait symbols only.
      symbolKinds = "isa_typed_prefix";
    }
  }

  // --- Typed-prefix on isa_declaration type identifier (topic 047 item 1) ---
  // Once the user types a prefix inside the type_list, the existing
  // (isa_declaration) @scope.class_interface_trait scope query still matches,
  // but the array form lets LookaheadIterator append class-body / top-level
  // starters (ERROR, namespace, Java, generate, ...). Force the scalar
  // `isa_typed_prefix` so completionBuilder takes the symbol-only early-return
  // branch — mirrors topic 043's association_typed_prefix pattern.
  //
  // Walk shape is specialized (direct-ancestor match + trait_sm_binding hard-
  // stop + ERROR-recovery fallback), so only the identifier gate is shared
  // with items 2 / 3 via isLetterLeadingIdentifier.
  if (nodeAtCursor && isLetterLeadingIdentifier(nodeAtCursor)) {
    // Primary: identifier is inside an isa_declaration's type_list.
    // Hard-stop at trait_sm_binding so `isA T<sm as S|` is never misclassified.
    let n: SyntaxNode | null = nodeAtCursor.parent;
    let insideIsaDecl = false;
    while (n) {
      if (n.type === "trait_sm_binding") break;
      if (n.type === "isa_declaration") { insideIsaDecl = true; break; }
      if (TYPE_SLOT_BOUNDARIES.has(n.type)) break;
      n = n.parent;
    }
    // Fallback: ERROR recovery where isa_declaration didn't form at all
    // (e.g. `class S { isA P` with no closing brace). findPreviousLeaf backs
    // up over the current identifier, so prevLeaf for `isA P|` is `isA` and
    // for `isA Person, P|` is `,`. For trait-SM angle-bracket positions
    // (`isA T<sm|`, `isA T<sm as S|`) prevLeaf is `<` / `as`, so the gate
    // excludes them even when they share an ERROR region with `isA`.
    if (
      !insideIsaDecl &&
      (prevLeaf?.type === "isA" || prevLeaf?.type === ",")
    ) {
      let err: SyntaxNode | null = nodeAtCursor.parent;
      while (err && err.type !== "ERROR") err = err.parent;
      if (err) {
        // For the comma case, additionally confirm the enclosing ERROR has
        // `isA` as an earlier child — rules out stray commas in unrelated
        // broken constructs.
        for (let i = 0; i < err.childCount; i++) {
          const c = err.child(i);
          if (!c) continue;
          if (c.startIndex >= nodeAtCursor.startIndex) break;
          if (c.type === "isA") { insideIsaDecl = true; break; }
        }
      }
    }
    if (insideIsaDecl) symbolKinds = "isa_typed_prefix";
  }

  // --- Typed-prefix on declaration-type identifier (topic 047 item 2) ---
  // Same class of bug as isa_typed_prefix: when the user types a prefix
  // inside an attribute_declaration or const_declaration's type_name, the
  // scope query has no dedicated capture so completion falls through to
  // generic class_body (54+ LookaheadIterator keywords, zero type symbols).
  // Force scalar `decl_type_typed_prefix` to take a symbol-only builder
  // branch that offers built-in types + class / interface / trait / enum.
  //
  // ERROR-recovery where type_name sits under ERROR (e.g. class body without
  // closing brace) is deliberately NOT matched — too ambiguous with isA /
  // modifier prefixes.
  if (
    nodeAtCursor &&
    isLetterLeadingIdentifier(nodeAtCursor) &&
    isInsideTypeNameFieldSlot(
      nodeAtCursor, DECL_TYPE_PARENTS, "type", TYPE_SLOT_BOUNDARIES,
    )
  ) {
    symbolKinds = "decl_type_typed_prefix";
  }

  // --- Typed-prefix on method return-type identifier (topic 047 item 3) ---
  // Same pattern as decl_type_typed_prefix, but for method return-type slots
  // across method_declaration, abstract_method_declaration, method_signature,
  // and trait_method_signature. All four rules use a `return_type` field.
  // Parameter types sit under `param`, not a method rule, so the field/slot
  // check excludes them cleanly without extra logic. Void IS valid here
  // (unlike decl_type_typed_prefix, where it is reserved for this item).
  if (
    nodeAtCursor &&
    isLetterLeadingIdentifier(nodeAtCursor) &&
    isInsideTypeNameFieldSlot(
      nodeAtCursor, RETURN_TYPE_PARENTS, "return_type", TYPE_SLOT_BOUNDARIES,
    )
  ) {
    symbolKinds = "return_type_typed_prefix";
  }

  // Topic 052 item 4 — parameter-type completion. Three positive shapes
  // covered by isInsideMethodParamTypeSlot (blank `(`, single-id param,
  // blank continuation after `,`). The matching topic-050 suppressors
  // already step aside via the same predicate, so this assignment is the
  // sole authority for those positions.
  if (nodeAtCursor && isInsideMethodParamTypeSlot(nodeAtCursor, prevLeaf)) {
    symbolKinds = "param_type_typed_prefix";
  }

  if (
    (prevLeaf?.type === "before" || prevLeaf?.type === "after") &&
    prevLeaf.parent?.type === "ERROR"
  ) {
    const errorParent = prevLeaf.parent.parent;
    if (errorParent && CLASS_LIKE_TYPES.has(errorParent.type)) {
      // Topic 052 item 2 — route blank `before |` / `after |` and the
      // typed-prefix `before p|` cases through a method-symbol-only scalar
      // scope. The array form fell through to the fallback path and
      // emitted ~177 LookaheadIterator keywords (ERROR, namespace, Java,
      // ...) ahead of the actual method symbols.
      symbolKinds = "code_injection_method";
    }
  }

  // Topic 052 item 3 — `filter { include ... }` target completion.
  //
  // Two recovery shapes:
  //   1. Blank `include |`: parses as `filter_definition < ERROR(include)`
  //      and the scope query falls through to `filter_body` (the keyword-
  //      starters list). Detection: prevLeaf is the `include` keyword
  //      whose parent is ERROR whose parent is filter_definition.
  //   2. Typed `include S|`: parses cleanly as
  //      `filter_definition < filter_statement < filter_value <
  //       (include, filter_pattern "S", ;)`. The existing
  //      `(filter_value) @scope.class` capture in completions.scm produces
  //      `["class"]`, which leaks built-ins via the fallback path. Detection:
  //      walk up from nodeAtCursor; if ancestor is `filter_value` and its
  //      first child is the `include` keyword, override the scope.
  //
  // Both routes set `filter_include_target` — class-symbol-only, no
  // built-ins, no `void`. Negative scopes stay untouched: blank filter
  // body keeps `filter_body`, `includeFilter |` keeps `filter_body`,
  // `namespace |` keeps `null`.
  if (
    prevLeaf?.type === "include" &&
    prevLeaf.parent?.type === "ERROR" &&
    prevLeaf.parent.parent?.type === "filter_definition"
  ) {
    symbolKinds = "filter_include_target";
  } else if (nodeAtCursor) {
    let n: SyntaxNode | null = nodeAtCursor;
    while (n) {
      if (n.type === "filter_value") {
        // First non-extra child decides — the `include` literal opens
        // the filter_value variant we want.
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (!c || c.isExtra) continue;
          if (c.type === "include") symbolKinds = "filter_include_target";
          break;
        }
        break;
      }
      if (n.type === "filter_definition" || n.type === "source_file") break;
      n = n.parent;
    }
  }

  // Topic 055 — `as |` blank slot inside an ERROR, recovered for two distinct
  // syntaxes:
  //
  //   1. `class C { sm name as |`     → referenced_statemachine target
  //   2. `class C { isA T<sm as |`    → trait_sm_binding target
  //
  // Disambiguation: the trait binding ERROR carries a `<` token sibling
  // because the parser consumed `isA T<` but couldn't close it. The
  // referenced_statemachine ERROR doesn't. Both routes are scalar so the
  // builder never falls through to the raw-lookahead path that historically
  // emitted ~175 keyword junk items.
  if (prevLeaf?.type === "as" && prevLeaf.parent?.type === "ERROR") {
    const errorNode = prevLeaf.parent;
    const errorParent = errorNode.parent;
    if (
      errorParent &&
      (CLASS_LIKE_TYPES.has(errorParent.type) || errorParent.type === "attribute_declaration")
    ) {
      let isTraitBinding = false;
      for (let i = 0; i < errorNode.childCount; i++) {
        const c = errorNode.child(i);
        if (c && c.type === "<") {
          isTraitBinding = true;
          break;
        }
      }
      symbolKinds = isTraitBinding
        ? "trait_sm_binding_target"
        : "referenced_sm_target";
    }
  }

  // Topic 055 — `... as Sm.|` dotted-state continuation inside an ERROR.
  // Cursor lands on the `.` token; tree-sitter typically wraps the bare dot
  // in its own ERROR node, separated from the preceding trait_sm_binding
  // ERROR. Detection: walk previous siblings of the dot's container looking
  // for an enclosing `trait_sm_binding` (preferred) or an ERROR that
  // contains the `<` and `as` tokens of an in-progress trait binding.
  // Capture the SM name segment so the builder can resolve states.
  // Topic 055 — capture SM name + remaining state-path prefix for the
  // trait_sm_binding_state_target builder.
  let traitSmBindingSmName: string | undefined;
  let traitSmBindingStatePrefix: string[] | undefined;
  if (prevLeaf?.type === "." && prevLeaf.parent) {
    const dotContainer = prevLeaf.parent;
    let sawAngle = false;
    let sawAs = false;
    let valuePathSegments: string[] | undefined;
    // Helper: extract all identifier names from a qualified_name in document
    // order. The first becomes the SM name, the rest the state prefix.
    const collectSegments = (qn: SyntaxNode): string[] => {
      const out: string[] = [];
      for (let i = 0; i < qn.childCount; i++) {
        const c = qn.child(i);
        if (c && c.type === "identifier") out.push(c.text);
      }
      return out;
    };
    let sib: SyntaxNode | null = dotContainer.previousSibling;
    let hops = 0;
    while (sib && hops < 6) {
      hops++;
      if (sib.type === "trait_sm_binding") {
        for (let i = 0; i < sib.childCount; i++) {
          const c = sib.child(i);
          if (!c) continue;
          const fieldName = sib.fieldNameForChild(i);
          if (fieldName === "value" && c.type === "qualified_name") {
            valuePathSegments = collectSegments(c);
          }
        }
        sawAngle = sawAs = true;
        break;
      }
      if (sib.type === "ERROR") {
        for (let i = 0; i < sib.childCount; i++) {
          const c = sib.child(i);
          if (!c) continue;
          if (c.type === "<") sawAngle = true;
          if (c.type === "as") sawAs = true;
          if (c.type === "trait_sm_binding") {
            for (let j = 0; j < c.childCount; j++) {
              const cc = c.child(j);
              if (!cc) continue;
              const fieldName = c.fieldNameForChild(j);
              if (fieldName === "value" && cc.type === "qualified_name") {
                valuePathSegments = collectSegments(cc);
              }
            }
            sawAngle = sawAs = true;
          }
        }
        if (sawAngle && sawAs && valuePathSegments && valuePathSegments.length > 0)
          break;
      }
      sib = sib.previousSibling;
    }
    if (
      sawAngle &&
      sawAs &&
      valuePathSegments &&
      valuePathSegments.length > 0
    ) {
      symbolKinds = "trait_sm_binding_state_target";
      traitSmBindingSmName = valuePathSegments[0];
      traitSmBindingStatePrefix = valuePathSegments.slice(1);
    }
  }

  // Topic 055 — bare dot inside an already-formed `trait_sm_binding > value
  // (qualified_name)`. This fires when the user types `<sm as Sm.|>;` (or
  // when the parser otherwise reformed the qualified_name despite the dot
  // being mid-edit). Detection: prevLeaf is `.`, prevLeaf.parent is
  // qualified_name, qualified_name.parent is trait_sm_binding (value path).
  // Capture the SM name and any preceding state-prefix segments so the
  // builder can resolve `Sm` → top-level / class-local SM and descend.
  if (
    prevLeaf?.type === "." &&
    prevLeaf.parent?.type === "qualified_name" &&
    prevLeaf.parent.parent?.type === "trait_sm_binding"
  ) {
    const tsb = prevLeaf.parent.parent;
    let isValuePath = false;
    for (let i = 0; i < tsb.childCount; i++) {
      const c = tsb.child(i);
      if (!c) continue;
      const fieldName = tsb.fieldNameForChild(i);
      if (fieldName === "value" && c.id === prevLeaf.parent.id) {
        isValuePath = true;
        break;
      }
    }
    if (isValuePath) {
      const qn = prevLeaf.parent;
      const precedingIdentifiers: string[] = [];
      for (let i = 0; i < qn.childCount; i++) {
        const c = qn.child(i);
        if (!c) continue;
        if (c.id === prevLeaf.id) break;
        if (c.type === "identifier") precedingIdentifiers.push(c.text);
      }
      if (precedingIdentifiers.length > 0) {
        symbolKinds = "trait_sm_binding_state_target";
        traitSmBindingSmName = precedingIdentifiers[0];
        traitSmBindingStatePrefix = precedingIdentifiers.slice(1);
      }
    }
  }

  // Topic 055 — typed dotted continuation: cursor on identifier inside
  // `trait_sm_binding > qualified_name`. The query-based scope already routes
  // first-identifier captures to `trait_sm_binding_target`; here we promote
  // non-first identifiers (i.e., the dotted-state segment) to the dedicated
  // state target. Detection: walk siblings of the cursor identifier inside
  // the qualified_name; if any preceding sibling is a `.` token we're past
  // the SM-name segment.
  if (
    nodeAtCursor &&
    nodeAtCursor.type === "identifier" &&
    nodeAtCursor.parent?.type === "qualified_name" &&
    nodeAtCursor.parent.parent?.type === "trait_sm_binding"
  ) {
    const tsb = nodeAtCursor.parent.parent;
    // Only consider the value path, not the param path.
    let isValuePath = false;
    for (let i = 0; i < tsb.childCount; i++) {
      const c = tsb.child(i);
      if (!c) continue;
      const fieldName = tsb.fieldNameForChild(i);
      if (fieldName === "value" && c.id === nodeAtCursor.parent.id) {
        isValuePath = true;
        break;
      }
    }
    if (isValuePath) {
      const qn = nodeAtCursor.parent;
      const precedingIdentifiers: string[] = [];
      let pastDot = false;
      for (let i = 0; i < qn.childCount; i++) {
        const c = qn.child(i);
        if (!c) continue;
        if (c.id === nodeAtCursor.id) break;
        if (c.type === ".") pastDot = true;
        else if (c.type === "identifier") precedingIdentifiers.push(c.text);
      }
      if (pastDot) {
        symbolKinds = "trait_sm_binding_state_target";
        // First identifier is the SM name; subsequent are state-path segments
        // BEFORE the cursor (state-prefix). The cursor identifier itself is
        // the typed prefix the client filters on.
        if (precedingIdentifiers.length > 0) {
          traitSmBindingSmName = precedingIdentifiers[0];
          traitSmBindingStatePrefix = precedingIdentifiers.slice(1);
        }
      } else {
        symbolKinds = "trait_sm_binding_target";
      }
    }
  }

  if (
    prevLeaf?.type === "->" &&
    prevLeaf.parent?.type === "ERROR" &&
    prevLeaf.endIndex < cursorOffset
  ) {
    let n: SyntaxNode | null = prevLeaf.parent;
    while (n) {
      if (n.type === "state_machine" || n.type === "statemachine_definition") {
        symbolKinds = "transition_target";
        break;
      }
      if (n.type === "class_definition" || n.type === "source_file") break;
      n = n.parent;
    }
    // Topic 050 case 3 — `status { s1 -> }` parses as `enumerated_attribute
    // < ERROR(->)` rather than reaching state_machine recovery, so the walk
    // above bails at class_definition. Detect the `enumerated_attribute`
    // ancestor and treat the position as transition_target. The completion
    // builder's transition_target branch returns an empty list when no
    // enclosingStateMachine is present — better empty than 48 wrong items.
    if (symbolKinds !== "transition_target") {
      let walk: SyntaxNode | null = prevLeaf.parent;
      while (walk) {
        if (walk.type === "enumerated_attribute") {
          // Confirm class-like outer container.
          let outer: SyntaxNode | null = walk.parent;
          while (outer) {
            if (CLASS_LIKE_DEF_TYPES.has(outer.type)) {
              symbolKinds = "transition_target";
              break;
            }
            if (outer.type === "source_file") break;
            outer = outer.parent;
          }
          break;
        }
        if (walk.type === "class_definition" || walk.type === "source_file") break;
        walk = walk.parent;
      }
    }
  }

  // --- Partial association completion ---
  // While the user is mid-typing an inline association inside a class-like body:
  //   `1 -> |`       -> ERROR wraps (multiplicity)(arrow); offer right-
  //                    multiplicities (1 / * / 0..1 / 1..* / 0..*).
  //   `1 -> * |`     -> ERROR wraps (multiplicity)(arrow)(multiplicity); offer
  //                    class symbols for the right_type slot.
  // Standalone association blocks have a left_type slot after the left
  // multiplicity:
  //   `association { 1 | }` -> offer class names, not arrows.
  //   `association { 1 Other | }` -> offer arrows.
  // Once the user starts typing the type identifier the parser forms a full
  // `association_inline`, and the existing (association_inline) @scope.* in
  // completions.scm takes over. This fallback only fires while the partial is
  // still an ERROR node.
  //
  // Detection inspects the ERROR's child shape rather than pattern-matching
  // on prevLeaf.parent — the arrow may or may not be wrapped in a named
  // `arrow` node depending on the enclosing rule (class_definition uses
  // $.arrow, association_definition doesn't), and prevLeaf can land inside a
  // multiplicity token or on the multiplicity node itself depending on width.
  {
    const INLINE_ASSOC_CONTAINERS = new Set<string>([
      "class_definition", "trait_definition", "interface_definition",
      "association_class_definition", "mixset_definition",
    ]);
    const ASSOC_SM_STOPS = new Set<string>([
      "state_machine", "statemachine_definition", "state", "transition",
    ]);

    const associationCompletionMode = (node: SyntaxNode | null): "inline" | "standalone" | null => {
      let n = node;
      while (n) {
        if (ASSOC_SM_STOPS.has(n.type)) return null;
        if (n.type === "association_definition") return "standalone";
        if (INLINE_ASSOC_CONTAINERS.has(n.type)) return "inline";
        if (n.type === "source_file") return null;
        n = n.parent;
      }
      return null;
    };

    const findEnclosingError = (n: SyntaxNode | null): SyntaxNode | null => {
      let found: SyntaxNode | null = null;
      while (n) {
        if (n.type === "ERROR") found = n;
        n = n.parent;
      }
      return found;
    };

    const pushErrorFlattenedChildren = (node: SyntaxNode, out: SyntaxNode[]): void => {
      if (node.type !== "ERROR") {
        if (!node.isExtra) out.push(node);
        return;
      }
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && (!c.isExtra || c.type === "ERROR")) {
          pushErrorFlattenedChildren(c, out);
        }
      }
    };

    const errorNode = prevLeaf ? findEnclosingError(prevLeaf) : null;
    const assocMode = errorNode ? associationCompletionMode(errorNode) : null;
    if (prevLeaf && errorNode && assocMode) {
      // Anchor classification on prevLeaf's position within the ERROR's non-
      // extras children. Multiple in-progress associations in the same block
      // (`association { 1 ->\n 1 -> *\n 0..1 -> 1..* }`) collapse into one
      // sprawling ERROR; we cannot rely on "the ERROR has shape X". Instead:
      //
      //   1. Find the child that contains prevLeaf.
      //   2. If that child IS an arrow → slot 1 (right-multiplicity), as long
      //      as any mult-like token appears before it in the same ERROR.
      //   3. Otherwise, walk backward from prevLeaf's child to find the
      //      nearest arrow. If one exists AND a mult-like appears before it,
      //      we're in slot 2 (right-type).
      //
      // `mightBeMult` is intentionally lenient: the cascade parse surfaces
      // multiplicity-shaped content as `multiplicity`, `*`, `..`, digit-
      // leading `identifier`, or `req_free_text_punct` (leaked from the req
      // grammar). All count as evidence a user is typing an association.
      // Letter-leading identifiers DON'T count, so `e ->` in class body
      // (attribute-shaped, no multiplicity) stays on class_body.
      const isArrow = (c: SyntaxNode) => c.type === "arrow" || c.type === "->";
      const isLetterLeadingId = (c: SyntaxNode) =>
        c.type === "identifier" && /^[A-Za-z_]/.test(c.text);
      const mightBeMult = (c: SyntaxNode) =>
        c.type === "multiplicity" ||
        c.type === "*" ||
        c.type === ".." ||
        c.type === "req_free_text_punct" ||
        /^[0-9]/.test(c.text);

      const children: SyntaxNode[] = [];
      for (let i = 0; i < errorNode.childCount; i++) {
        const c = errorNode.child(i);
        if (c && (!c.isExtra || c.type === "ERROR")) {
          pushErrorFlattenedChildren(c, children);
        }
      }

      let prevIdx = -1;
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (c.startIndex <= prevLeaf.startIndex && prevLeaf.endIndex <= c.endIndex) {
          prevIdx = i;
          break;
        }
      }

      if (prevIdx >= 0) {
        // All slot detection is segment-bounded. The segment is the range of
        // children since the last `;` boundary up to and including prevIdx —
        // i.e. the current association attempt only. Without this, cascades
        // in `association { 1 -> * Other; 1 |}` would inherit the prior
        // association's arrow and misclassify the new left-mult as slot 2.
        let segStart = 0;
        for (let i = prevIdx - 1; i >= 0; i--) {
          if (children[i].type === ";") { segStart = i + 1; break; }
          if (children[i].endPosition.row < prevLeaf.startPosition.row) {
            segStart = i + 1;
            break;
          }
        }
        const segment = children.slice(segStart, prevIdx + 1);
        const segArrowIdxInSeg = segment.findIndex(isArrow);
        const prevInSeg = segment.length - 1; // prevIdx in segment terms

        const last = segment[prevInSeg];
        const onlyOneCompleteMultAtCursor =
          segment.length === 1 &&
          last.type === "multiplicity" &&
          last.endIndex === cursorOffset;
        // `1 -> *|` is still the multiplicity token. The right-type slot starts
        // after whitespace (`1 -> * |`) or after a typed identifier (`1 -> * O|`).
        const isRightMultiplicityWithoutTypeBoundary = (node: SyntaxNode): boolean =>
          !isLetterLeadingId(node) && mightBeMult(node) && node.endIndex === cursorOffset;

        if (assocMode === "standalone") {
          const leftSide =
            segArrowIdxInSeg >= 0
              ? segment.slice(0, segArrowIdxInSeg)
              : segment;
          const hasLeftMult = leftSide.some(mightBeMult);
          const hasLeftType = leftSide.some(isLetterLeadingId);

          if (isArrow(last)) {
            // Standalone slot 2: `1 Other -> |` needs right multiplicity.
            if (last.endIndex === cursorOffset) {
              symbolKinds = null;
            } else if (hasLeftMult && hasLeftType) {
              symbolKinds = "association_multiplicity";
            } else if (hasLeftMult) {
              // Recovery for malformed `association { 1 -> | }`: the left
              // type is still the missing piece.
              symbolKinds = "association_type";
            }
          } else if (segArrowIdxInSeg >= 0 && hasLeftMult && hasLeftType) {
            // Standalone slot 3: `1 Other -> * |` needs right type.
            const child = segment[prevInSeg];
            if (isRightMultiplicityWithoutTypeBoundary(child)) {
              symbolKinds = null;
            } else {
              symbolKinds = isLetterLeadingId(child)
                ? "association_typed_prefix"
                : "association_type";
            }
          } else if (hasLeftMult && hasLeftType) {
            // Standalone slot 1b: `1 Other |` or `1 Other -|` needs arrow.
            symbolKinds = "association_arrow";
          } else {
            // Standalone slot 1a: `1 |` needs a left type, not an arrow.
            const PARTIAL_ARROW_TYPES = new Set(["-", "<", ">", "@"]);
            const partial =
              mightBeMult(last) ||
              PARTIAL_ARROW_TYPES.has(last.type) ||
              last.type === "req_free_text_punct";
            if (partial && hasLeftMult && !onlyOneCompleteMultAtCursor) {
              symbolKinds = "association_type";
            }
          }
        } else if (isArrow(segment[prevInSeg])) {
          // Inline slot 1: cursor IS an arrow -> right-multiplicity slot.
          if (segment[prevInSeg].endIndex === cursorOffset) {
            symbolKinds = null;
          } else if (segment.slice(0, prevInSeg).some(mightBeMult)) {
            symbolKinds = "association_multiplicity";
          }
        } else if (segArrowIdxInSeg >= 0
                   && segment.slice(0, segArrowIdxInSeg).some(mightBeMult)) {
          // Inline slot 2: arrow appears before prevLeaf in the segment -> right-type
          // slot. typed-prefix vs blank-multiplicity disambiguation matches
          // topic 043's heuristic.
          const child = segment[prevInSeg];
          if (isRightMultiplicityWithoutTypeBoundary(child)) {
            symbolKinds = null;
          } else {
            symbolKinds = isLetterLeadingId(child)
              ? "association_typed_prefix"
              : "association_type";
          }
        } else {
          // Inline slot 0: no arrow in this segment yet. If prevLeaf is
          // mult-like OR a partial-arrow character (`-`, `<`, `>`, `@`,
          // `req_free_text_punct` for things like `<@`), AND the segment has
          // a mult-like -> arrow slot.
          const PARTIAL_ARROW_TYPES = new Set(["-", "<", ">", "@"]);
          const partial =
            mightBeMult(last) ||
            PARTIAL_ARROW_TYPES.has(last.type) ||
            last.type === "req_free_text_punct";
          // Topic 050 case 2 — bare `0..*` (a single complete multiplicity
          // node with cursor exactly at its end) is not yet starting an
          // association. Without intervening whitespace there's no arrow
          // intent. `1 |` (cursor after a space) still fires because the
          // cursor offset is past the digit token's end.
          if (partial && segment.some(mightBeMult) && !onlyOneCompleteMultAtCursor) {
            symbolKinds = "association_arrow";
          }
        }
      }
    }

    // --- Typed-prefix on the right-type identifier (cursor INSIDE the
    // identifier, no trailing whitespace before it) ---
    // findPreviousLeaf backs up over identifier chars, so the prevLeaf-based
    // detection above misses this case — cursor on `Fo|` lands on `*` instead.
    // Anchor on nodeAtCursor instead: if the cursor sits inside a letter-
    // leading identifier under an association ERROR, classify as typed prefix.
    if (
      nodeAtCursor &&
      nodeAtCursor.type === "identifier" &&
      /^[A-Za-z_]/.test(nodeAtCursor.text)
    ) {
      const errAnc = findEnclosingError(nodeAtCursor);
      const typedAssocMode = errAnc ? associationCompletionMode(errAnc) : null;
      if (errAnc && typedAssocMode) {
        // Sanity: ERROR contains an arrow with a mult-like before it (i.e.
        // we're really in an association type identifier slot, not some
        // unrelated identifier under a recovery ERROR).
        const isArrow2 = (c: SyntaxNode) => c.type === "arrow" || c.type === "->";
        const isLetterLeadingId2 = (c: SyntaxNode) =>
          c.type === "identifier" && /^[A-Za-z_]/.test(c.text);
        const mightBeMult2 = (c: SyntaxNode) =>
          c.type === "multiplicity" ||
          c.type === "*" ||
          c.type === ".." ||
          c.type === "req_free_text_punct" ||
          /^[0-9]/.test(c.text);
        const errChildren: SyntaxNode[] = [];
        for (let i = 0; i < errAnc.childCount; i++) {
          const c = errAnc.child(i);
          if (c && (!c.isExtra || c.type === "ERROR")) {
            pushErrorFlattenedChildren(c, errChildren);
          }
        }

        let typedIdx = -1;
        for (let i = 0; i < errChildren.length; i++) {
          const c = errChildren[i];
          if (
            c.id === nodeAtCursor.id ||
            (c.startIndex <= nodeAtCursor.startIndex && nodeAtCursor.endIndex <= c.endIndex)
          ) {
            typedIdx = i;
            break;
          }
        }
        if (typedIdx >= 0) {
          let segStart = 0;
          for (let i = typedIdx - 1; i >= 0; i--) {
            if (errChildren[i].type === ";") { segStart = i + 1; break; }
            if (errChildren[i].endPosition.row < nodeAtCursor.startPosition.row) {
              segStart = i + 1;
              break;
            }
          }
          const typedSegment = errChildren.slice(segStart, typedIdx + 1);
          const arrowIdx = typedSegment.findIndex(isArrow2);

          if (typedAssocMode === "standalone" && arrowIdx < 0) {
            // Left_type typed prefix: `association { 1 O| }`.
            if (typedSegment.slice(0, -1).some(mightBeMult2)) {
              symbolKinds = "association_typed_prefix";
            }
          } else if (arrowIdx >= 0) {
            const beforeArrow = typedSegment.slice(0, arrowIdx);
            const hasLeftMult = beforeArrow.some(mightBeMult2);
            const hasLeftType =
              typedAssocMode === "inline" ||
              beforeArrow.some(isLetterLeadingId2);
            if (hasLeftMult && hasLeftType) {
              symbolKinds = "association_typed_prefix";
            }
          }
        }
      }
    }

    // Corpus association syntax also permits standalone association ends:
    //   association { 1 Person;  * Employee role; }
    // That clean parse means `association { 1 O| }` and `1 Other |` are no
    // longer wrapped in ERROR, so preserve the pre-existing completion
    // behavior explicitly: typed identifiers complete class-like symbols,
    // and whitespace after the left type still offers arrows for users who
    // are building the arrow-form association member.
    const isSingleEndInAssociationDefinition = (node: SyntaxNode | null): boolean =>
      node?.type === "single_association_end" && node.parent?.type === "association_definition";

    if (nodeAtCursor && isLetterLeadingIdentifier(nodeAtCursor)) {
      let n: SyntaxNode | null = nodeAtCursor.parent;
      while (n) {
        if (isSingleEndInAssociationDefinition(n)) {
          symbolKinds = "association_typed_prefix";
          break;
        }
        if (n.type === "association_definition" || n.type === "source_file") break;
        n = n.parent;
      }
    }

    if (
      prevLeaf?.type === "identifier" &&
      isSingleEndInAssociationDefinition(prevLeaf.parent) &&
      cursorOffset > prevLeaf.endIndex
    ) {
      symbolKinds = "association_arrow";
    }
  }

  // --- Structured req body: slot-ready starter completion ---
  // The completions.scm query can't distinguish "cursor between tags" (slot-
  // ready for a new tag/step) from "cursor in the middle of free-text prose"
  // — both are inside req_user_story_body / req_use_case_body. Default is
  // suppress; opt in positively only when prevLeaf tells us we're at a true
  // slot boundary:
  //   1. prevLeaf is `{` whose parent is the requirement_definition itself —
  //      empty body, ready for the first tag/step.
  //   2. prevLeaf is `}` that closed a complete tag or step — ready for the
  //      next sibling tag/step inside the same structured body.
  // Prose positions (preceded by free-text word/punct or the opening `{` of a
  // tag body) stay suppressed.
  const STRUCTURED_SLOT_CLOSERS = new Set([
    "req_who_tag", "req_when_tag", "req_what_tag", "req_why_tag",
    "req_user_step", "req_system_response",
  ]);
  const structuredLanguageToScope = (lang: string | undefined) => {
    if (lang === "userStory" || lang === "userstory") return "userstory_body" as const;
    if (lang === "useCase"  || lang === "usecase")    return "usecase_body"  as const;
    return undefined;
  };
  if (prevLeaf?.type === "{" && prevLeaf.parent?.type === "requirement_definition") {
    // Only fire if the body is empty or starts with a tag/step — if it leads
    // with free text (prose starting after the brace), stay suppressed.
    const bodyNode = prevLeaf.parent.childForFieldName("body");
    const firstChild = bodyNode?.namedChild(0);
    const bodyStartsWithProse =
      firstChild?.type === "req_free_text_word" ||
      firstChild?.type === "req_free_text_punct";
    if (!bodyStartsWithProse) {
      const langNode = prevLeaf.parent.childForFieldName("language");
      const scope = structuredLanguageToScope(langNode?.text);
      if (scope) symbolKinds = scope;
    }
  } else if (prevLeaf?.type === "}" && prevLeaf.parent && STRUCTURED_SLOT_CLOSERS.has(prevLeaf.parent.type)) {
    // Walk up to the enclosing requirement_definition to read the language.
    let walk: SyntaxNode | null = prevLeaf.parent.parent ?? null;
    while (walk && walk.type !== "requirement_definition") walk = walk.parent;
    if (walk) {
      const langNode = walk.childForFieldName("language");
      const scope = structuredLanguageToScope(langNode?.text);
      if (scope) symbolKinds = scope;
    }
  }

  // --- implementsReq empty-slot completion ---
  // Tree-sitter can't form a `req_implementation` until it sees the identifier,
  // so the completions.scm scope query misses these positions:
  //   `implementsReq |`            (bare first slot)
  //   `implementsReq R1, |`        (bare second slot after comma)
  // Use the previous leaf to detect them. `implementsReq` itself is a direct
  // match; for the comma case we require the comma to be inside a partial
  // req_implementation (either parsed or in ERROR recovery).
  if (prevLeaf?.type === "implementsReq") {
    symbolKinds = ["requirement"];
  } else if (prevLeaf?.type === ",") {
    let n: SyntaxNode | null = prevLeaf.parent;
    while (n) {
      if (n.type === "req_implementation") { symbolKinds = ["requirement"]; break; }
      // Topic 051 item 1 — isA comma continuation. After `isA Person,|` the
      // user is starting another type name. Route to the same scalar
      // typed-prefix scope as `isa_typed_prefix` so completionBuilder
      // returns class/interface/trait symbols only (no class_body junk).
      if (n.type === "isa_declaration") { symbolKinds = "isa_typed_prefix"; break; }
      if (n.type === "ERROR") {
        // Look for a sibling `implementsReq` keyword anywhere in this ERROR
        // recovery region — that's the signature of a partial req_implementation.
        // Same scan also catches partial isa_declaration recovery.
        let foundReq = false;
        let foundIsA = false;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c?.type === "implementsReq") foundReq = true;
          if (c?.type === "isA") foundIsA = true;
        }
        if (foundReq) { symbolKinds = ["requirement"]; break; }
        if (foundIsA) { symbolKinds = "isa_typed_prefix"; break; }
      }
      if (n.type === "class_definition" || n.type === "source_file") break;
      n = n.parent;
    }
  }

  // --- Trait SM operation suppression: "as" and guard positions ---
  // After "as" inside trait-SM context → suppress (new name position, not a reference)
  if (prevLeaf?.type === "as" && isInsideTraitSmOpContext(prevLeaf)) {
    symbolKinds = "suppress";
  }

  // Inside "[" in trait-SM guard position → suppress
  if (prevLeaf?.type === "[" && isInsideTraitSmOpContext(prevLeaf)) {
    symbolKinds = "suppress";
  }

  // --- Trait SM operation completion: after -/+ or after sm. in prefixed path ---
  let traitSmContext: CompletionInfo["traitSmContext"];
  if (
    (prevLeaf?.type === "-" || prevLeaf?.type === "+") &&
    isInsideTraitAngleBrackets(prevLeaf)
  ) {
    const traitName = extractTraitNameFromAngleBrackets(prevLeaf);
    if (traitName) {
      symbolKinds = "trait_sm_op_sm";
      traitSmContext = { traitName };
    }
  }
  // Topic 053 — `isA T<-|` / `isA T<+|` recovery shape parses as a flat
  // ERROR under class_definition (no isa_declaration / type_list ancestor),
  // so the helpers above don't reach the trait name. Recover from the
  // ERROR's child sequence directly. Bare `isA T<|` (no -/+ marker yet)
  // suppresses to avoid the class_body keyword leak.
  if (!traitSmContext && nodeAtCursor) {
    const recovered = recoverTraitSmOpFromIsAError(nodeAtCursor);
    if (recovered) {
      if (recovered.mode === "op") {
        symbolKinds = "trait_sm_op_sm";
        traitSmContext = { traitName: recovered.traitName };
      } else {
        symbolKinds = "suppress";
      }
    }
  }
  if (!traitSmContext && prevLeaf?.type === ".") {
    // After dot in trait SM operation paths. The dot is inside ERROR,
    // with the preceding path in a sibling node.
    const errorNode = prevLeaf.parent?.type === "ERROR" ? prevLeaf.parent : null;
    const typeName = errorNode?.parent?.type === "type_name" ? errorNode.parent : null;
    if (typeName) {
      // Case 1: prefixed form — trait_sm_operation sibling with qualified_name
      for (let i = 0; i < typeName.namedChildCount; i++) {
        const child = typeName.namedChild(i);
        if (child?.type === "trait_sm_operation") {
          const qn = child.namedChildren.find((c: { type: string }) => c.type === "qualified_name");
          if (qn && qn.namedChildCount >= 1) {
            const segments: string[] = [];
            for (let j = 0; j < qn.namedChildCount; j++) {
              const id = qn.namedChild(j);
              if (id?.type === "identifier") segments.push(id.text);
            }
            if (segments.length >= 1) {
              const traitName = extractTraitNameFromAngleBrackets(typeName);
              if (traitName) {
                const hasStatePath = segments.length > 1;
                // After -sm. → states only; after -sm.s1. → states + events
                symbolKinds = hasStatePath ? "trait_sm_op_state_event" : "trait_sm_op_state";
                traitSmContext = {
                  traitName,
                  smName: segments[0],
                  statePath: hasStatePath ? segments.slice(1) : undefined,
                };
              }
            }
          }
          // Also check for direct-child identifier (Phase 2 prefixed, single SM name)
          if (!traitSmContext) {
            const directId = child.namedChildren.find(
              (c: { type: string }) => c.type === "identifier",
            );
            if (directId) {
              const traitName = extractTraitNameFromAngleBrackets(typeName);
              if (traitName) {
                symbolKinds = "trait_sm_op_state";
                traitSmContext = { traitName, smName: directId.text };
              }
            }
          }
          break;
        }
      }

      // Case 2: unprefixed form — type_name sibling containing SM name as qualified_name
      if (!traitSmContext) {
        for (let i = 0; i < typeName.namedChildCount; i++) {
          const child = typeName.namedChild(i);
          if (
            child?.type === "type_name" &&
            child.id !== typeName.id &&
            child.namedChildCount >= 1
          ) {
            const qn = child.namedChild(0);
            if (qn?.type === "qualified_name" && qn.namedChildCount === 1) {
              const id = qn.namedChild(0);
              if (id?.type === "identifier") {
                const traitName = extractTraitNameFromAngleBrackets(typeName);
                if (traitName) {
                  // Unprefixed sm. is event-position per Phase 2 grammar
                  symbolKinds = "trait_sm_op_event";
                  traitSmContext = { traitName, smName: id.text };
                }
              }
            }
          }
        }
      }
    }
  }

  // --- Enclosing scope for scoped lookups ---
  const { enclosingClass, enclosingStateMachine } =
    resolveEnclosingScope(tree, line, column);

  // --- Dotted state prefix for path-scoped completions ---
  let dottedStatePrefix: string[] | undefined;
  if (
    enclosingStateMachine &&
    isInTransitionTarget(tree, line, column, content)
  ) {
    const lineText = content.split("\n")[line] ?? "";
    let pos = column;
    while (pos > 0 && /[a-zA-Z_0-9]/.test(lineText[pos - 1])) {
      pos--;
    }
    if (pos > 0 && lineText[pos - 1] === ".") {
      dottedStatePrefix = extractDottedPrefix(lineText, pos - 1);
    }
  }

  // --- Sorted key owner resolution ---
  let sortedKeyOwner: string | undefined;
  if (symbolKinds === "sorted_attribute") {
    const cursorNode = tree.rootNode.descendantForPosition({ row: line, column });
    const sortedMod = findAncestorOfType(cursorNode, "sorted_modifier");
    if (sortedMod) {
      const assocNode = sortedMod.parent;
      if (assocNode) {
        let arrowPos = -1;
        for (let i = 0; i < assocNode.childCount; i++) {
          if (assocNode.child(i).type === "arrow") {
            arrowPos = assocNode.child(i).startIndex;
            break;
          }
        }
        if (arrowPos >= 0) {
          const isLeftSide = sortedMod.startIndex < arrowPos;
          if (assocNode.type === "association_inline") {
            sortedKeyOwner = isLeftSide
              ? enclosingClass
              : assocNode.childForFieldName("right_type")?.text;
          } else if (assocNode.type === "association_member") {
            sortedKeyOwner = isLeftSide
              ? assocNode.childForFieldName("left_type")?.text
              : assocNode.childForFieldName("right_type")?.text;
          }
        }
      }
    }
    if (!sortedKeyOwner) sortedKeyOwner = enclosingClass;
  }

  // --- Trace prefix override for completion ---
  if (symbolKinds === "trace_attribute_method") {
    const cursorNode = tree.rootNode.descendantForPosition({ row: line, column });
    const traceStmt = findAncestorOfType(cursorNode, "trace_statement");
    if (traceStmt) {
      const STATE_PREFIXES = new Set(["entry", "exit"]);
      const ATTR_PREFIXES = new Set(["set", "get"]);
      const ASSOC_PREFIXES = new Set(["add", "remove", "cardinality"]);
      let prefixType: "state" | "attribute" | "suppress" | null = null;
      for (let i = 0; i < traceStmt.childCount; i++) {
        const child = traceStmt.child(i);
        if (!child) continue;
        if (child.type === "trace_entity" || child.type === "trace_entity_call") break;
        if (STATE_PREFIXES.has(child.type)) { prefixType = "state"; break; }
        if (ATTR_PREFIXES.has(child.type)) { prefixType = "attribute"; break; }
        if (ASSOC_PREFIXES.has(child.type)) { prefixType = "suppress"; break; }
      }
      if (prefixType === "state") {
        // Concrete node: trace_entity → state, trace_entity_call → method
        // Blank slot (no entity node): union of state + method
        const isInCallForm = findAncestorOfType(cursorNode, "trace_entity_call") !== null;
        const isInBareForm = findAncestorOfType(cursorNode, "trace_entity") !== null;
        if (isInCallForm) {
          symbolKinds = "trace_method";
        } else if (isInBareForm) {
          symbolKinds = "trace_state";
        } else {
          symbolKinds = "trace_state_method"; // blank slot — ambiguous
        }
      } else if (prefixType === "attribute") {
        symbolKinds = "trace_attribute";
      } else if (prefixType === "suppress") {
        symbolKinds = "suppress";
      }
    }
  }

  return {
    keywords,
    operators,
    symbolKinds,
    isDefinitionName: false,
    isComment: false,
    prefix,
    enclosingClass,
    enclosingStateMachine,
    dottedStatePrefix,
    sortedKeyOwner,
    traitSmContext,
    traitSmBindingSmName,
    traitSmBindingStatePrefix,
  };
}

function findAncestorOfType(node: any, type: string): any | null {
  let current = node;
  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

// ── Private helpers ─────────────────────────────────────────────────────────

function isInsideComment(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === "line_comment" || current.type === "block_comment") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// ── Topic 050 suppression guards ────────────────────────────────────────────

const CLASS_LIKE_DEF_TYPES: ReadonlySet<string> = new Set([
  "class_definition",
  "trait_definition",
  "interface_definition",
  "association_class_definition",
  "mixset_definition",
]);

/** Cursor sits inside a `java_annotation` subtree (e.g. `@Override`). */
function isInsideJavaAnnotation(node: SyntaxNode): boolean {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "java_annotation") return true;
    n = n.parent;
  }
  return false;
}

/**
 * Cursor sits inside a method param list at a NON-completable position
 * (param-name slot, or whitespace after a complete param). Topic 052
 * item 4 narrowed this from "any position inside param list" to "only
 * positions that are NOT a parameter-type slot" — type slots route to
 * `param_type_typed_prefix` via `isInsideMethodParamTypeSlot` instead.
 *
 * Now suppresses ONLY:
 *   - cursor on a param's NAME identifier (param has both type_name and
 *     identifier; cursor is on the second one)
 *   - cursor in `param_list` whitespace (no param ancestor)
 *
 * The two old broken-recovery shapes (`void f(|` no-closing-paren / `,`
 * in ERROR sibling of param_list) are now handled positively by
 * `isInsideMethodParamTypeSlot` and pre-empt this suppressor.
 */
function isInsideMethodParamListStart(
  node: SyntaxNode,
  prevLeaf: SyntaxNode | null = null,
): boolean {
  // If this is a param-type slot, the positive scope handles it; do NOT
  // suppress.
  if (isInsideMethodParamTypeSlot(node, prevLeaf)) return false;

  // Otherwise, only suppress when cursor is genuinely inside a param ancestor
  // at a non-type-slot position (the param-name slot after a full
  // type_name + identifier pair) or inside param_list whitespace.
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "param") {
      let hasTypeName = false;
      let hasIdentifier = false;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c) continue;
        if (c.type === "type_name") hasTypeName = true;
        if (c.type === "identifier") hasIdentifier = true;
      }
      // Suppress only when the param has both type_name and identifier
      // (cursor on the name slot). Single-identifier params are type-slots
      // and have already returned false above via isInsideMethodParamTypeSlot.
      return hasTypeName && hasIdentifier;
    }
    if (n.type === "param_list") {
      // Cursor in param_list whitespace after a complete param — suppress.
      return true;
    }
    if (n.type === "method_declaration" || n.type === "class_definition" ||
        n.type === "source_file") break;
    n = n.parent;
  }
  return false;
}

/**
 * Topic 052 item 4 — cursor sits at a parameter-type slot inside a method
 * declaration. Three recovery shapes:
 *
 *   1. Blank first slot `void f(|)` — cursor at `(` whose parent is
 *      `method_declaration`. No `param_list` formed yet.
 *   2. Typed inside single-identifier param `void f(P|)` /
 *      `void f(int a, P|)` — cursor on an `identifier` whose parent is
 *      `param`, and the param has only one identifier child (no separate
 *      type_name yet). The single identifier is the type-being-typed.
 *   3. Blank continuation `void f(int a, |)` — cursor sits between `,`
 *      (in ERROR sibling of param_list) and `)`. Detection: prevLeaf is
 *      `,` whose parent ERROR is a sibling of param_list under
 *      method_declaration.
 *
 * Returns true if any of these match. Caller sets
 * `symbolKinds = "param_type_typed_prefix"`.
 */
function isInsideMethodParamTypeSlot(
  node: SyntaxNode,
  prevLeaf: SyntaxNode | null = null,
): boolean {
  // Shape 1 — cursor at `(` of method_declaration. Two parse states:
  //   1a. clean: `void f() {}` — `(` directly under method_declaration.
  //   1b. broken: `void f(` (no closing) — the entire method shape lives
  //       under an ERROR. The ERROR contains a `type_name` (return type),
  //       identifier (method name), and `(`. This is the topic-050
  //       broken-`(` shape, now redirected from suppress to positive.
  if (node.type === "(") {
    if (node.parent?.type === "method_declaration") return true;
    if (node.parent?.type === "ERROR") {
      const err = node.parent;
      let hasTypeName = false;
      let hasNameAfterTypeName = false;
      for (let i = 0; i < err.childCount; i++) {
        const c = err.child(i);
        if (!c) continue;
        if (c.id === node.id) break;
        if (c.type === "type_name") hasTypeName = true;
        if (c.type === "identifier" && hasTypeName) hasNameAfterTypeName = true;
      }
      if (hasTypeName && hasNameAfterTypeName) {
        // Confirm class-like ancestor.
        let p: SyntaxNode | null = err.parent;
        while (p) {
          if (CLASS_LIKE_DEF_TYPES.has(p.type)) return true;
          if (p.type === "source_file") return false;
          p = p.parent;
        }
      }
    }
  }
  // Shape 2 — cursor on an identifier inside a single-identifier param.
  if (node.type === "identifier") {
    const param = node.parent;
    if (param?.type === "param") {
      let typeNameCount = 0;
      let idCount = 0;
      for (let i = 0; i < param.childCount; i++) {
        const c = param.child(i);
        if (!c) continue;
        if (c.type === "type_name") typeNameCount++;
        if (c.type === "identifier") idCount++;
      }
      // Single identifier, no type_name → cursor is on the in-progress
      // type token.
      return typeNameCount === 0 && idCount === 1;
    }
  }
  // Shape 3 — cursor after a comma in the ERROR-sibling-of-param_list shape.
  if (prevLeaf?.type === "," && prevLeaf.parent?.type === "ERROR") {
    const err = prevLeaf.parent;
    if (err.parent?.type === "method_declaration") return true;
  }
  return false;
}

/**
 * Cursor sits inside an attribute-initializer expression after `=` and
 * before the terminating `;`. The grammar's `_attribute_value` is hidden,
 * and broken/incomplete expressions live entirely under an ERROR. Codex's
 * invariant: in a class-like container, enclosing ERROR has `=` before
 * cursor with no association arrow before cursor → suppress.
 */
function isInsideAttributeInitializer(node: SyntaxNode): boolean {
  let err: SyntaxNode | null = node;
  while (err && err.type !== "ERROR") err = err.parent;
  if (!err) return false;
  // ERROR must sit inside a class-like container.
  let p: SyntaxNode | null = err.parent;
  let inClassLike = false;
  while (p) {
    if (CLASS_LIKE_DEF_TYPES.has(p.type)) { inClassLike = true; break; }
    if (p.type === "source_file") return false;
    p = p.parent;
  }
  if (!inClassLike) return false;
  // Walk ERROR children before the cursor: must contain `=` and no arrow.
  let sawEquals = false;
  let sawArrow = false;
  for (let i = 0; i < err.childCount; i++) {
    const c = err.child(i);
    if (!c) continue;
    if (c.startIndex >= node.startIndex) break;
    if (c.type === "=") sawEquals = true;
    if (c.type === "->" || c.type === "arrow") sawArrow = true;
  }
  return sawEquals && !sawArrow;
}

/**
 * Cursor sits inside or at the end of a contiguous identifier-character run
 * (`[A-Za-z0-9_-]+`) that contains both a `-` and a letter — i.e. a
 * malformed identifier the parser couldn't classify. Examples: `req-|foo`,
 * `req|-foo`, `req-foo|`. Negatives: `Int|`, `isA P|`, `1 -> * O|`,
 * `1 -|` (no letter in the run).
 *
 * Mostly textual; the recovery AST is not stable enough at these positions
 * to drive the decision off node types alone. We do, however, exempt two
 * legitimate dash-bearing contexts:
 *
 *   1. AST: cursor inside a `req_id`, `req_implementation`, or
 *      `requirement_definition` subtree — `req_id` allows hyphens, so
 *      `implementsReq L01-|License` is a valid completion target.
 *
 *   2. Textual fallback (when the AST doesn't form because of a missing
 *      `;`): scan the current line backward from the cursor; if we encounter
 *      `implementsReq` or `req` keyword before any `;`, `}`, or line start,
 *      the user is editing a requirement-id position — don't suppress.
 *
 * Codex-approved narrow form — does NOT suppress legitimate typed-prefix
 * completions because those scopes have their own positive entries above
 * this guard.
 */
function isInsideMalformedDashIdentifier(
  content: string,
  line: number,
  column: number,
  nodeAtCursor: SyntaxNode | null,
): boolean {
  const lines = content.split("\n");
  const lineText = lines[line] ?? "";
  const isRunChar = (c: string) => /[A-Za-z0-9_-]/.test(c);
  const isLetter = (c: string) => /[A-Za-z_]/.test(c);

  // Scan the contiguous run that contains (or is adjacent to) the cursor.
  let start = column;
  while (start > 0 && isRunChar(lineText[start - 1])) start--;
  let end = column;
  while (end < lineText.length && isRunChar(lineText[end])) end++;
  if (start === end) return false; // empty run on either side
  const run = lineText.slice(start, end);
  if (!run.includes("-") || ![...run].some(isLetter)) return false;

  // Exempt #1 — AST shows the cursor is in a real requirement context.
  if (nodeAtCursor) {
    let n: SyntaxNode | null = nodeAtCursor;
    while (n) {
      if (
        n.type === "req_id" ||
        n.type === "req_implementation" ||
        n.type === "requirement_definition"
      ) return false;
      n = n.parent;
    }
  }

  // Exempt #2 — same-line back-scan for `implementsReq` / `req` keyword
  // before any statement boundary. Covers the AST-didn't-form case (no `;`
  // closing the partial req_implementation).
  const before = lineText.slice(0, start);
  // If before contains `;` or `}`, that closes any prior context — bail.
  if (/[;}]/.test(before)) return true;
  if (/\b(?:implementsReq|req)\b/.test(before)) return false;

  return true;
}

/**
 * Topic 050 case 2 — bare complete multiplicity sitting alone in a class
 * body or association block, with cursor at the exact end of the
 * multiplicity token. Examples: `0..*|`, `1|`, `0..1|` placed alone in a
 * class-body line. Without further context (arrow, type) this isn't a real
 * completion target — the partial-association refinement keeps it from
 * classifying as `association_arrow`, but the analyzer would still fall
 * through to `class_body` and surface 47 wrong keywords. Suppress.
 *
 * Negatives this guard does NOT match:
 *   `0..* |` (cursor past whitespace) — segments differ; partial-association
 *      logic upstream picks it up as a real arrow slot.
 *   `1 -> *|` (after the right multiplicity of an in-progress association)
 *      — segment has an arrow; this guard requires no arrow before cursor.
 */
function isBareCompleteMultiplicityAtEnd(
  node: SyntaxNode,
  content: string,
  line: number,
  column: number,
): boolean {
  if (node.type !== "multiplicity") return false;
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  offset += column;
  if (node.endIndex !== offset) return false;
  const err = node.parent;
  if (!err || err.type !== "ERROR") return false;
  // No arrow or `;` before this multiplicity in the ERROR
  for (let i = 0; i < err.childCount; i++) {
    const c = err.child(i);
    if (!c) continue;
    if (c.id === node.id) break;
    if (c.type === "arrow" || c.type === "->") return false;
    if (c.type === ";") return false;
  }
  // ERROR must sit in a class-like or association container
  let p: SyntaxNode | null = err.parent;
  while (p) {
    if (CLASS_LIKE_DEF_TYPES.has(p.type) || p.type === "association_definition") {
      return true;
    }
    if (p.type === "source_file") return false;
    p = p.parent;
  }
  return false;
}

function offsetAt(content: string, line: number, column: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + Math.min(column, lines[line]?.length ?? 0);
}

function findPreviousLeaf(
  tree: Tree,
  content: string,
  line: number,
  column: number,
): SyntaxNode | null {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  offset += Math.min(column, lines[line]?.length ?? 0);

  let pos = offset;
  while (pos > 0 && /[a-zA-Z_0-9]/.test(content[pos - 1])) {
    pos--;
  }
  while (pos > 0 && /\s/.test(content[pos - 1])) {
    pos--;
  }

  if (pos === 0) return null;

  let node = tree.rootNode.descendantForIndex(pos - 1, pos - 1);
  if (!node) return null;

  while (node && node.isExtra) {
    const prev = node.previousSibling;
    if (prev) {
      node = prev;
      while (node.childCount > 0) {
        node = node.lastChild!;
      }
    } else if (node.parent) {
      node = node.parent;
    } else {
      return null;
    }
  }

  while (node && node.childCount > 0) {
    node = node.lastChild!;
  }

  return node;
}

function resolveCompletionScope(
  completionsQuery: Query,
  tree: Tree,
  line: number,
  column: number,
): CompletionInfo["symbolKinds"] {
  const captures = completionsQuery.captures(tree.rootNode);

  let best: { name: string; size: number } | null = null;
  for (const capture of captures) {
    const node = capture.node;
    const startOk =
      node.startPosition.row < line ||
      (node.startPosition.row === line &&
        node.startPosition.column <= column);
    const endOk =
      node.endPosition.row > line ||
      (node.endPosition.row === line && node.endPosition.column >= column);

    if (startOk && endOk) {
      const size = node.endIndex - node.startIndex;
      if (!best || size <= best.size) {
        best = { name: capture.name, size };
      }
    }
  }

  if (!best) return null;

  const prefix = "scope.";
  if (!best.name.startsWith(prefix)) return null;
  const kindStr = best.name.substring(prefix.length);

  if (kindStr === "suppress") return "suppress";
  if (kindStr === "use_path") return "use_path";
  if (kindStr === "own_attribute") return "own_attribute";
  if (kindStr === "guard_attribute_method") return "guard_attribute_method";
  if (kindStr === "trace_attribute_method") return "trace_attribute_method";
  if (kindStr === "sorted_attribute") return "sorted_attribute";
  if (kindStr === "top_level") return "top_level";
  if (kindStr === "class_body") return "class_body";
  if (kindStr === "trait_body") return "trait_body";
  if (kindStr === "interface_body") return "interface_body";
  if (kindStr === "assoc_class_body") return "assoc_class_body";
  if (kindStr === "mixset_body") return "mixset_body";
  if (kindStr === "statemachine_body") return "statemachine_body";
  if (kindStr === "state_body") return "state_body";
  if (kindStr === "filter_body") return "filter_body";
  if (kindStr === "transition_target") return "transition_target";
  if (kindStr === "userstory_body") return "userstory_body";
  if (kindStr === "usecase_body") return "usecase_body";
  if (kindStr === "association_multiplicity") return "association_multiplicity";
  if (kindStr === "association_type") return "association_type";
  if (kindStr === "association_typed_prefix") return "association_typed_prefix";
  if (kindStr === "isa_typed_prefix") return "isa_typed_prefix";
  if (kindStr === "decl_type_typed_prefix") return "decl_type_typed_prefix";
  if (kindStr === "return_type_typed_prefix") return "return_type_typed_prefix";
  if (kindStr === "code_injection_method") return "code_injection_method";
  if (kindStr === "filter_include_target") return "filter_include_target";
  if (kindStr === "param_type_typed_prefix") return "param_type_typed_prefix";
  if (kindStr === "association_arrow") return "association_arrow";
  if (kindStr === "referenced_sm_target") return "referenced_sm_target";
  if (kindStr === "trait_sm_binding_target") return "trait_sm_binding_target";
  if (kindStr === "trait_sm_binding_state_target") return "trait_sm_binding_state_target";
  if (kindStr === "none") return null;

  return kindStr.split("_") as SymbolKind[];
}

function isAtAttributeNamePosition(
  tree: Tree,
  content: string,
  line: number,
  column: number,
): boolean {
  const prevLeaf = findPreviousLeaf(tree, content, line, column);
  if (!prevLeaf) return false;

  let node: SyntaxNode | null = prevLeaf;
  while (node) {
    if (node.type === "type_name") {
      const parent = node.parent;
      if (parent) {
        for (let i = 0; i < parent.childCount; i++) {
          if (parent.child(i)?.id === node.id) {
            const fieldName = parent.fieldNameForChild(i);
            if (fieldName === "type" || fieldName === "return_type") {
              return true;
            }
          }
        }
      }
      break;
    }
    node = node.parent;
  }
  return false;
}

function lastTokenBeforeCursor(
  content: string,
  line: number,
  column: number,
): string | null {
  const lines = content.split("\n");

  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  offset += Math.min(column, lines[line]?.length ?? 0);

  let pos = offset;
  while (pos > 0 && /[a-zA-Z_0-9]/.test(content[pos - 1])) {
    pos--;
  }
  while (pos > 0 && /\s/.test(content[pos - 1])) {
    pos--;
  }

  if (pos === 0) return null;

  let start = pos;
  while (start > 0 && /[a-zA-Z_]/.test(content[start - 1])) {
    start--;
  }

  if (start === pos) return null;

  return content.substring(start, pos);
}

function isInTransitionTarget(
  tree: Tree,
  line: number,
  column: number,
  content: string,
): boolean {
  let node: SyntaxNode | null = tree.rootNode.descendantForPosition({
    row: line,
    column: Math.max(0, column - 1),
  });

  while (node) {
    if (node.type === "qualified_name") {
      const parent = node.parent;
      if (parent?.type === "transition") {
        const targetNode = parent.childForFieldName("target");
        if (targetNode?.id === node.id) return true;
      }
      break;
    }
    if (
      node.type === "transition" ||
      node.type === "state" ||
      node.type === "state_machine" ||
      node.type === "statemachine_definition"
    ) {
      break;
    }
    node = node.parent;
  }

  const lineText = content.split("\n")[line] ?? "";
  const beforeCursor = lineText.substring(0, column);
  if (beforeCursor.includes("->")) {
    return true;
  }

  return false;
}

function extractDottedPrefix(
  lineText: string,
  dotPos: number,
): string[] | undefined {
  const segments: string[] = [];
  let pos = dotPos;

  while (pos >= 0 && lineText[pos] === ".") {
    const identEnd = pos;
    let identStart = pos;
    while (identStart > 0 && /[a-zA-Z_0-9]/.test(lineText[identStart - 1])) {
      identStart--;
    }
    if (identStart === identEnd) break;

    segments.unshift(lineText.substring(identStart, identEnd));

    if (identStart > 0 && lineText[identStart - 1] === ".") {
      pos = identStart - 1;
    } else {
      break;
    }
  }

  return segments.length > 0 ? segments : undefined;
}

/** Check if a node is inside a trait_sm_operation context (within <> of isA). */
function isInsideTraitSmOpContext(node: SyntaxNode): boolean {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "trait_sm_operation") return true;
    // In ERROR recovery, check if a sibling is trait_sm_operation
    if (n.type === "ERROR" && n.parent?.type === "type_name") {
      for (let i = 0; i < n.parent.namedChildCount; i++) {
        if (n.parent.namedChild(i)?.type === "trait_sm_operation") return true;
      }
    }
    // Check if parent is type_name inside isa_declaration with trait_sm_operation sibling
    if (n.type === "type_name") {
      for (let i = 0; i < n.namedChildCount; i++) {
        if (n.namedChild(i)?.type === "trait_sm_operation") return true;
      }
    }
    if (n.type === "class_definition" || n.type === "source_file") return false;
    n = n.parent;
  }
  return false;
}

/**
 * Topic 053 — `isA T<` recovery shapes parse as a flat ERROR under
 * class_definition (no `isa_declaration` / `type_list` / `type_name`
 * ancestor). Returns the matched recovery info if the ERROR shape is
 * `[isA, qualified_name(trait), <, ...rest]` AND cursor sits at/after
 * the `<`. The `mode` field tells the caller whether we have a
 * trait-SM operation marker (`-` / `+`) or just the bare `<`.
 */
function recoverTraitSmOpFromIsAError(
  nodeAtCursor: SyntaxNode,
): { traitName: string; mode: "op" | "bare" } | null {
  // Bail when cursor is already inside a formed `trait_sm_binding` —
  // the parse has progressed past the `T<` recovery shape and the user
  // is editing a deeper position (e.g. `isA T<sm as S|`). Existing
  // logic for those positions should run.
  let walk: SyntaxNode | null = nodeAtCursor;
  while (walk) {
    if (walk.type === "trait_sm_binding") return null;
    if (walk.type === "ERROR") break;
    walk = walk.parent;
  }
  // Find the enclosing ERROR.
  let err: SyntaxNode | null = nodeAtCursor;
  while (err && err.type !== "ERROR") err = err.parent;
  if (!err) return null;
  // Must sit directly under a class-like container.
  let p: SyntaxNode | null = err.parent;
  let inClassLike = false;
  while (p) {
    if (CLASS_LIKE_DEF_TYPES.has(p.type)) { inClassLike = true; break; }
    if (p.type === "source_file") break;
    p = p.parent;
  }
  if (!inClassLike) return null;
  // Walk children: find the [isA, qualified_name, <] prefix BEFORE cursor.
  let sawIsA = false;
  let traitName: string | undefined;
  let sawAngle = false;
  let sawOpMarker = false;
  for (let i = 0; i < err.childCount; i++) {
    const c = err.child(i);
    if (!c || c.isExtra) continue;
    if (c.startIndex >= nodeAtCursor.startIndex && c.id !== nodeAtCursor.id) break;
    if (c.type === "isA") { sawIsA = true; continue; }
    if (sawIsA && !traitName && c.type === "qualified_name") {
      const lastId = c.namedChild(c.namedChildCount - 1);
      if (lastId?.type === "identifier") traitName = lastId.text;
      continue;
    }
    if (sawIsA && traitName && c.type === "<") { sawAngle = true; continue; }
    if (sawAngle && (c.type === "-" || c.type === "+")) { sawOpMarker = true; continue; }
  }
  if (!sawIsA || !traitName || !sawAngle) return null;
  return { traitName, mode: sawOpMarker ? "op" : "bare" };
}

/**
 * Topic 053 — broken method-name slot in a class body when the method has
 * no `{}` body. Parses as `class_definition < ERROR < [type_name,
 * identifier(name), (, )]`. Cursor on the name identifier is the broken
 * equivalent of `void method|() {}` which is normally caught by
 * isAtAttributeNamePosition. Suppress.
 */
function isInsideBrokenMethodNameSlot(node: SyntaxNode): boolean {
  if (node.type !== "identifier") return false;
  const err = node.parent;
  if (err?.type !== "ERROR") return false;
  // ERROR's children must include type_name BEFORE this identifier, and
  // `(` after — confirms the method-shape recovery.
  let sawTypeName = false;
  let sawNameAfterTypeName = false;
  let sawOpenParenAfterName = false;
  for (let i = 0; i < err.childCount; i++) {
    const c = err.child(i);
    if (!c || c.isExtra) continue;
    if (c.type === "type_name") sawTypeName = true;
    else if (c.id === node.id) {
      if (sawTypeName) sawNameAfterTypeName = true;
    } else if (c.type === "(") {
      if (sawNameAfterTypeName) sawOpenParenAfterName = true;
    }
  }
  if (!sawNameAfterTypeName || !sawOpenParenAfterName) return false;
  // Confirm class-like container.
  let p: SyntaxNode | null = err.parent;
  while (p) {
    if (CLASS_LIKE_DEF_TYPES.has(p.type)) return true;
    if (p.type === "source_file") return false;
    p = p.parent;
  }
  return false;
}

/** Check if a node is inside angle brackets of a type_name (trait type arguments). */
function isInsideTraitAngleBrackets(node: SyntaxNode): boolean {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "type_name" || n.type === "type_list") return true;
    // ERROR nodes inside isA declarations with angle brackets
    if (n.type === "isa_declaration") return true;
    if (n.type === "class_definition" || n.type === "source_file") return false;
    n = n.parent;
  }
  return false;
}

/** Extract the trait name from the enclosing isA type_name's qualified_name. */
function extractTraitNameFromAngleBrackets(node: SyntaxNode): string | undefined {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "type_name") {
      const qn = n.childForFieldName("name") ?? n.namedChild(0);
      if (qn?.type === "qualified_name") {
        const lastId = qn.namedChild(qn.namedChildCount - 1);
        return lastId?.type === "identifier" ? lastId.text : undefined;
      }
      return undefined;
    }
    // In ERROR recovery, look for qualified_name siblings (trait name before <)
    if (n.type === "ERROR" && n.parent?.type === "isa_declaration") {
      // Walk children to find the qualified_name before the error
      const isa = n.parent;
      for (let i = 0; i < isa.namedChildCount; i++) {
        const child = isa.namedChild(i);
        if (child?.type === "type_list") {
          // type_list > type_name > qualified_name
          const typeName = child.namedChild(0);
          if (typeName?.type === "type_name") {
            const qn = typeName.childForFieldName("name") ?? typeName.namedChild(0);
            if (qn?.type === "qualified_name") {
              const lastId = qn.namedChild(qn.namedChildCount - 1);
              return lastId?.type === "identifier" ? lastId.text : undefined;
            }
          }
        }
      }
    }
    n = n.parent;
  }
  return undefined;
}
