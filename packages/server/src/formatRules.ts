/**
 * Formatting rule definitions for the syntax-aware formatter.
 *
 * Node-type classification for indentation and skip regions.
 * All node names are verified against the actual tree-sitter grammar.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;

/** Node types whose body content gets +1 indent level. */
export const INDENT_NODES = new Set([
  "class_definition",
  "interface_definition",
  "trait_definition",
  "association_class_definition",
  "enum_definition",
  "association_definition",
  "mixset_definition",
  "state_machine",
  "statemachine_definition",
  "state",
  "before_after",
  "toplevel_code_injection",
  "filter_definition",
  "method_declaration",
]);

/** Top-level declaration node types that should be separated by blank lines. */
export const TOP_LEVEL_DECL_NODES = new Set([
  "class_definition",
  "interface_definition",
  "trait_definition",
  "association_class_definition",
  "enum_definition",
  "association_definition",
  "statemachine_definition",
  "mixset_definition",
  "toplevel_code_injection",
  "namespace_declaration",
  "use_statement",
  "generate_statement",
  "requirement_definition",
  "external_definition",
]);

/** Node types whose content is verbatim (embedded code — do not reindent). */
export const SKIP_NODES = new Set([
  "code_content",
  "template_body",
]);

/**
 * Check if a line falls strictly inside a verbatim/skip node.
 * Boundary lines (the line with opening `{` and closing `}`) are NOT skipped —
 * they're Umple-structural and should be formatted normally.
 */
export function isVerbatimLine(tree: Tree, line: number): boolean {
  // Walk the tree to find skip nodes that contain this line
  const cursor = tree.rootNode.walk();
  let reachedEnd = false;

  while (!reachedEnd) {
    const node = cursor.currentNode;
    if (SKIP_NODES.has(node.type)) {
      // Strictly between start and end rows (boundary lines are formatted)
      if (node.startPosition.row < line && line < node.endPosition.row) {
        return true;
      }
      // Don't descend into skip nodes
      if (!cursor.gotoNextSibling()) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            reachedEnd = true;
            break;
          }
        }
      }
    } else if (!cursor.gotoFirstChild()) {
      if (!cursor.gotoNextSibling()) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            reachedEnd = true;
            break;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Compute the structural indent depth for a line from its AST ancestors.
 * Only counts indent-contributing ancestors whose body starts ABOVE this line
 * (so the opening line of `class A {` doesn't get +1 from its own node).
 */
export function computeStructuralDepth(tree: Tree, line: number, column: number): number {
  const node = tree.rootNode.descendantForPosition({ row: line, column });
  if (!node) return 0;

  let depth = 0;
  let current: SyntaxNode | null = node;

  while (current) {
    if (INDENT_NODES.has(current.type)) {
      // Only count if this line is INSIDE the body (not the header line)
      if (current.startPosition.row < line) {
        depth++;
      }
    }
    current = current.parent;
  }

  return depth;
}
