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

// ── CompletionInfo type ─────────────────────────────────────────────────────

/** Information needed by the completion handler. */
export interface CompletionInfo {
  /** Keywords the parser expects at this position. */
  keywords: string[];
  /** Operators the parser expects at this position. */
  operators: string[];
  /** Which symbol kinds to offer, or null for none. */
  symbolKinds: SymbolKind[] | "suppress" | "use_path" | "own_attribute" | "guard_attribute_method" | "trace_attribute_method" | "trace_state" | "trace_method" | "trace_state_method" | "trace_attribute" | "sorted_attribute" | "trait_sm_op_sm" | "trait_sm_op_state" | "trait_sm_op_state_event" | "trait_sm_op_event" | "top_level" | null;
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
        symbolKinds = ["state"];
        break;
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
