/**
 * Token/context analysis.
 *
 * Pure analysis of a parsed tree + cursor position to produce a TokenResult.
 * No dependency on SymbolIndex class or any index state.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;
type Query = InstanceType<typeof TreeSitter.Query>;
import type { SymbolKind, LookupContext, TokenResult } from "./tokenTypes";
import { SYMBOL_KINDS_LONGEST_FIRST } from "./tokenTypes";
import { resolveEnclosingScope, resolveStatePath } from "./treeUtils";

/**
 * Analyze the token at a given position in a parsed tree.
 *
 * Returns the token word, kind filter from references.scm, enclosing scope,
 * lookup context, and optional disambiguation metadata — or null if no
 * identifier is found at the position.
 *
 * @param tree            Pre-parsed tree for the document
 * @param referencesQuery Loaded references.scm query
 * @param line            0-based line
 * @param column          0-based column
 */
export function analyzeToken(
  tree: Tree,
  referencesQuery: Query,
  line: number,
  column: number,
): TokenResult | null {
  let node = tree.rootNode.descendantForPosition({ row: line, column });

  // Fallback: if cursor lands on an ERROR node, search its children for an
  // identifier at the exact position. ERROR nodes contain parsed-but-unmatched
  // tokens as children, so the identifier is still accessible.
  if (node?.type === "ERROR" || node?.isError) {
    let found: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (
        child.type === "identifier" &&
        child.startPosition.row === line &&
        child.startPosition.column <= column &&
        child.endPosition.column > column
      ) {
        found = child;
        break;
      }
    }
    if (found) {
      node = found;
    }
  }

  if (
    !node ||
    (node.type !== "identifier" &&
      node.type !== "use_path" &&
      node.type !== "filter_pattern" &&
      node.type !== "req_id")
  ) {
    return null;
  }

  // For filter_pattern: skip wildcards and exclusion patterns
  let word = node.text;
  if (node.type === "filter_pattern") {
    if (/[*?]/.test(word) || word.startsWith("~")) {
      return null;
    }
  }

  let kinds = resolveDefinitionKinds(tree, node, referencesQuery);

  // Fallback: if the identifier is inside an ERROR node, references.scm won't
  // capture it. Use top-level-only kind candidates to avoid scoped-preference
  // guessing. Container-scoped kinds (attribute, method) are excluded because
  // they introduce ambiguity with local symbols of the same name.
  if (
    (!kinds || kinds.length === 0) &&
    node.type === "identifier" &&
    (node.parent?.type === "ERROR" || node.parent?.isError)
  ) {
    kinds = ["class", "interface", "trait", "enum"] as SymbolKind[];
  }

  const { enclosingClass, enclosingStateMachine } =
    resolveEnclosingScope(tree, line, column);

  // ── Detect orthogonal metadata ──────────────────────────────────────────

  // Dotted state path in transition targets
  let dottedStateRef: TokenResult["dottedStateRef"];
  const parent = node.parent;
  if (node.type === "identifier" && parent?.type === "qualified_name") {
    const grandparent = parent.parent;
    if (grandparent?.type === "transition") {
      const targetNode = grandparent.childForFieldName("target");
      if (targetNode?.id === parent.id) {
        const ids: string[] = [];
        let idx = -1;
        for (let i = 0; i < parent.namedChildCount; i++) {
          const child = parent.namedChild(i);
          if (child?.type === "identifier") {
            if (child.id === node.id) idx = ids.length;
            ids.push(child.text);
          }
        }
        if (ids.length > 1 && idx >= 0) {
          dottedStateRef = { qualifiedPath: ids, pathIndex: idx };
        }
      }
    }
  }

  // State definition names
  let stateDefinitionRef: TokenResult["stateDefinitionRef"];
  if (
    node.type === "identifier" &&
    parent?.type === "state" &&
    parent.childForFieldName("name")?.id === node.id
  ) {
    stateDefinitionRef = { definitionPath: resolveStatePath(node) };
  }

  // ── Detect primary lookup context ────────────────────────────────────────

  let context: LookupContext = { type: "normal" };

  // trait_sm_binding param: isA T1<sm1 as sm.s2>
  if (
    node.type === "identifier" &&
    parent?.type === "trait_sm_binding" &&
    parent.childForFieldName("param")?.id === node.id
  ) {
    const typeName = parent.parent;
    if (typeName?.type === "type_name") {
      const qn = typeName.childForFieldName("name") ?? typeName.namedChild(0);
      if (qn?.type === "qualified_name") {
        const lastId = qn.namedChild(qn.namedChildCount - 1);
        if (lastId?.type === "identifier") {
          context = { type: "trait_sm_param", traitName: lastId.text };
        }
      }
    }
  }

  // trait_sm_binding value: isA T1<sm1 as sm.s2>
  if (
    node.type === "identifier" &&
    parent?.type === "qualified_name" &&
    parent.parent?.type === "trait_sm_binding" &&
    parent.parent.childForFieldName("value")?.id === parent.id
  ) {
    const segments: string[] = [];
    let idx = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child?.type === "identifier") {
        if (child.id === node.id) idx = segments.length;
        segments.push(child.text);
      }
    }
    if (idx >= 0 && segments.length >= 1) {
      context = { type: "trait_sm_value", pathSegments: segments, segmentIndex: idx };
      kinds = idx === 0 ? ["statemachine"] : ["state"];
    }
  }

  // referenced_statemachine: "door as status"
  if (
    node.type === "identifier" &&
    parent?.type === "referenced_statemachine" &&
    parent.childForFieldName("definition")?.id === node.id &&
    enclosingClass
  ) {
    context = { type: "referenced_sm" };
  }

  // toplevel_code_injection operation: "before { Counter } increment()"
  if (
    node.type === "identifier" &&
    parent?.type === "toplevel_code_injection" &&
    parent.childForFieldName("operation")?.id === node.id
  ) {
    const targetNode = parent.childForFieldName("target");
    if (targetNode) {
      context = { type: "toplevel_injection", targetClass: targetNode.text };
    }
  }

  // Default-value qualifier in "Status.ACTIVE"
  if (
    node.type === "identifier" &&
    parent?.type === "qualified_name" &&
    parent.namedChildCount > 1
  ) {
    const gp = parent.parent;
    if (gp?.type === "attribute_declaration" || gp?.type === "const_declaration") {
      const isLastSegment = parent.namedChild(parent.namedChildCount - 1)?.id === node.id;
      if (!isLastSegment) {
        kinds = ["enum"];
        context = { type: "default_value_qualifier" };
      }
    }
  }

  return {
    word,
    kinds,
    enclosingClass,
    enclosingStateMachine,
    context,
    dottedStateRef,
    stateDefinitionRef,
  };
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Use references.scm query to determine which symbol kinds are valid
 * for a node's context.
 */
function resolveDefinitionKinds(
  tree: Tree,
  node: SyntaxNode,
  referencesQuery: Query,
): SymbolKind[] | null {
  const captures = referencesQuery.captures(tree.rootNode, {
    startPosition: node.startPosition,
    endPosition: node.endPosition,
  });

  let bestCapture: { name: string; node: SyntaxNode } | null = null;
  let bestSize = Infinity;
  let bestKindCount = Infinity;
  for (const capture of captures) {
    if (
      capture.node.startIndex <= node.startIndex &&
      capture.node.endIndex >= node.endIndex
    ) {
      const size = capture.node.endIndex - capture.node.startIndex;
      const kindCount = capture.name.split("_").length;
      if (
        size < bestSize ||
        (size === bestSize && kindCount < bestKindCount)
      ) {
        bestSize = size;
        bestKindCount = kindCount;
        bestCapture = capture;
      }
    }
  }

  if (!bestCapture) return null;

  const prefix = "reference.";
  if (!bestCapture.name.startsWith(prefix)) return null;
  let rest = bestCapture.name.substring(prefix.length);
  const kinds: SymbolKind[] = [];
  while (rest.length > 0) {
    const match = SYMBOL_KINDS_LONGEST_FIRST.find((k) => rest.startsWith(k));
    if (!match) break;
    kinds.push(match);
    rest = rest.substring(match.length);
    if (rest.startsWith("_")) rest = rest.substring(1);
  }
  return kinds.length > 0 ? kinds : null;
}
