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
  symbolKinds: SymbolKind[] | "suppress" | "use_path" | "own_attribute" | "guard_attribute_method" | "trace_attribute_method" | "trace_state" | "trace_method" | "trace_state_method" | "trace_attribute" | "sorted_attribute" | "trait_sm_op_sm" | "trait_sm_op_state" | "trait_sm_op_state_event" | "trait_sm_op_event" | "top_level" | "class_body" | "trait_body" | "interface_body" | "assoc_class_body" | "mixset_body" | "statemachine_body" | "state_body" | "filter_body" | "transition_target" | "userstory_body" | "usecase_body" | "association_multiplicity" | "association_type" | "association_typed_prefix" | "association_arrow" | "isa_typed_prefix" | "decl_type_typed_prefix" | "return_type_typed_prefix" | null;
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
  const prevLeaf = findPreviousLeaf(tree, content, line, column);
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
      symbolKinds = ["class", "interface", "trait"];
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

  if (
    (prevLeaf?.type === "before" || prevLeaf?.type === "after") &&
    prevLeaf.parent?.type === "ERROR"
  ) {
    const errorParent = prevLeaf.parent.parent;
    if (errorParent && CLASS_LIKE_TYPES.has(errorParent.type)) {
      symbolKinds = ["method"];
    }
  }

  if (prevLeaf?.type === "as" && prevLeaf.parent?.type === "ERROR") {
    const errorParent = prevLeaf.parent.parent;
    if (
      errorParent &&
      (CLASS_LIKE_TYPES.has(errorParent.type) || errorParent.type === "attribute_declaration")
    ) {
      symbolKinds = ["statemachine"];
    }
  }

  if (prevLeaf?.type === "->" && prevLeaf.parent?.type === "ERROR") {
    let n: SyntaxNode | null = prevLeaf.parent;
    while (n) {
      if (n.type === "state_machine" || n.type === "statemachine_definition") {
        symbolKinds = "transition_target";
        break;
      }
      if (n.type === "class_definition" || n.type === "source_file") break;
      n = n.parent;
    }
  }

  // --- Partial inline association completion ---
  // While the user is mid-typing an association inside a class-like body:
  //   `1 -> |`       → ERROR wraps (multiplicity)(arrow) — offer a right-
  //                    multiplicity curated list (1 / * / 0..1 / 1..* / 0..*).
  //   `1 -> * |`     → ERROR wraps (multiplicity)(arrow)(multiplicity) — offer
  //                    class symbols for the right_type slot.
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
    const CLASS_LIKE_ASSOC_CONTAINERS = new Set<string>([
      "class_definition", "trait_definition", "interface_definition",
      "association_class_definition", "mixset_definition",
      "association_definition",
    ]);
    const ASSOC_SM_STOPS = new Set<string>([
      "state_machine", "statemachine_definition", "state", "transition",
    ]);

    const enclosingIsClassLike = (node: SyntaxNode | null): boolean => {
      let n = node;
      while (n) {
        if (ASSOC_SM_STOPS.has(n.type)) return false;
        if (CLASS_LIKE_ASSOC_CONTAINERS.has(n.type)) return true;
        if (n.type === "source_file") return false;
        n = n.parent;
      }
      return false;
    };

    const findEnclosingError = (n: SyntaxNode | null): SyntaxNode | null => {
      while (n) {
        if (n.type === "ERROR") return n;
        n = n.parent;
      }
      return null;
    };

    const errorNode = prevLeaf ? findEnclosingError(prevLeaf) : null;
    if (prevLeaf && errorNode && enclosingIsClassLike(errorNode)) {
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
      const mightBeMult = (c: SyntaxNode) =>
        c.type === "multiplicity" ||
        c.type === "*" ||
        c.type === ".." ||
        c.type === "req_free_text_punct" ||
        /^[0-9]/.test(c.text);

      const children: SyntaxNode[] = [];
      for (let i = 0; i < errorNode.childCount; i++) {
        const c = errorNode.child(i);
        if (c && !c.isExtra) children.push(c);
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
        }
        const segment = children.slice(segStart, prevIdx + 1);
        const segArrowIdxInSeg = segment.findIndex(isArrow);
        const prevInSeg = segment.length - 1; // prevIdx in segment terms

        if (isArrow(segment[prevInSeg])) {
          // Slot 1: cursor IS an arrow → right-multiplicity slot.
          if (segment.slice(0, prevInSeg).some(mightBeMult)) {
            symbolKinds = "association_multiplicity";
          }
        } else if (segArrowIdxInSeg >= 0
                   && segment.slice(0, segArrowIdxInSeg).some(mightBeMult)) {
          // Slot 2: arrow appears before prevLeaf in the segment → right-type
          // slot. typed-prefix vs blank-multiplicity disambiguation matches
          // topic 043's heuristic.
          const child = segment[prevInSeg];
          const isLetterLeadingId =
            child.type === "identifier" && /^[A-Za-z_]/.test(child.text);
          symbolKinds = isLetterLeadingId
            ? "association_typed_prefix"
            : "association_type";
        } else {
          // Slot 0: no arrow in this segment yet. If prevLeaf is mult-like
          // OR a partial-arrow character (`-`, `<`, `>`, `@`,
          // `req_free_text_punct` for things like `<@`), AND the segment has
          // a mult-like → arrow slot.
          const PARTIAL_ARROW_TYPES = new Set(["-", "<", ">", "@"]);
          const last = segment[prevInSeg];
          const partial =
            mightBeMult(last) ||
            PARTIAL_ARROW_TYPES.has(last.type) ||
            last.type === "req_free_text_punct";
          if (partial && segment.some(mightBeMult)) {
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
      if (errAnc && enclosingIsClassLike(errAnc)) {
        // Sanity: ERROR contains an arrow with a mult-like before it (i.e.
        // we're really in an association right-side identifier slot, not
        // some unrelated identifier under a recovery ERROR).
        const isArrow2 = (c: SyntaxNode) => c.type === "arrow" || c.type === "->";
        const mightBeMult2 = (c: SyntaxNode) =>
          c.type === "multiplicity" ||
          c.type === "*" ||
          c.type === ".." ||
          c.type === "req_free_text_punct" ||
          /^[0-9]/.test(c.text);
        const errChildren: SyntaxNode[] = [];
        for (let i = 0; i < errAnc.childCount; i++) {
          const c = errAnc.child(i);
          if (c && !c.isExtra) errChildren.push(c);
        }
        let arrowSeen = false;
        let multSeen = false;
        for (const c of errChildren) {
          if (c.id === nodeAtCursor.id) break;
          if (isArrow2(c)) arrowSeen = true;
          if (!arrowSeen && mightBeMult2(c)) multSeen = true;
        }
        if (arrowSeen && multSeen) {
          symbolKinds = "association_typed_prefix";
        }
      }
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
      if (n.type === "ERROR") {
        // Look for a sibling `implementsReq` keyword anywhere in this ERROR
        // recovery region — that's the signature of a partial req_implementation.
        for (let i = 0; i < n.childCount; i++) {
          if (n.child(i)?.type === "implementsReq") {
            symbolKinds = ["requirement"];
            break;
          }
        }
        if (symbolKinds && Array.isArray(symbolKinds) && symbolKinds[0] === "requirement") break;
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
  if (kindStr === "association_arrow") return "association_arrow";
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
