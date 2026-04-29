/**
 * Syntax-aware document formatter.
 *
 * Uses tree-sitter AST to compute structural indentation instead of
 * naive brace counting. Preserves embedded code regions (code_content,
 * template_body) as verbatim islands.
 */

import {
  TextEdit,
  Range,
  Position,
} from "vscode-languageserver/node";
import { isVerbatimLine, computeStructuralDepth, TOP_LEVEL_DECL_NODES } from "./formatRules";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Tree = InstanceType<typeof TreeSitter.Tree>;

// ── Phase 0: Compact block expansion ────────────────────────────────────────

/** Allowed child types inside a state body for expansion eligibility. */
const EXPANSION_ALLOWED_CHILDREN = new Set([
  "transition", "standalone_transition", "state_to_state_transition",
  "{", "}", ";", "identifier",
]);

/** Node types that disqualify a state from expansion if found as descendants. */
const EXPANSION_REJECT_DESCENDANTS = new Set([
  "code_content", "template_body", "action_code", "more_code",
  "line_comment", "block_comment",
]);

/**
 * Check if a subtree contains any descendant of the given types.
 */
function hasDescendantOfType(node: any, types: Set<string>): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (types.has(child.type)) return true;
    if (hasDescendantOfType(child, types)) return true;
  }
  return false;
}

/**
 * Check if a single-line state node is eligible for compact block expansion.
 */
function isEligibleForExpansion(stateNode: any): boolean {
  // Must be single-line
  if (stateNode.startPosition.row !== stateNode.endPosition.row) return false;

  // Walk ALL children (including anonymous tokens)
  let hasTransition = false;
  for (let i = 0; i < stateNode.childCount; i++) {
    const child = stateNode.child(i);
    const type = child.type;

    if (EXPANSION_ALLOWED_CHILDREN.has(type)) {
      if (type === "transition" || type === "standalone_transition" || type === "state_to_state_transition") {
        hasTransition = true;
      }
      continue;
    }

    // Any other child (||, entry_exit_action, state, method, etc.) → reject
    return false;
  }

  if (!hasTransition) return false;

  // Check for embedded-code or comment descendants anywhere in subtree
  if (hasDescendantOfType(stateNode, EXPANSION_REJECT_DESCENDANTS)) {
    return false;
  }

  // Check for ERROR nodes
  if (stateNode.hasError) return false;

  return true;
}

/**
 * Expand eligible single-line compact state blocks into multi-line format.
 * Returns the modified text (or the original if nothing changed).
 */
export function expandCompactStates(text: string, tree: Tree): string {
  const lines = text.split("\n");

  // Collect eligible state nodes (process in reverse to preserve positions)
  const eligible: any[] = [];
  const visit = (node: any) => {
    if (node.type === "state" && isEligibleForExpansion(node)) {
      eligible.push(node);
      return; // Don't descend — this is single-line
    }
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };
  visit(tree.rootNode);

  if (eligible.length === 0) return text;

  // Sort in reverse document order (process from bottom to top)
  eligible.sort((a, b) => b.startPosition.row - a.startPosition.row ||
    b.startPosition.column - a.startPosition.column);

  let result = text;
  for (const stateNode of eligible) {
    const row = stateNode.startPosition.row;
    const startCol = stateNode.startPosition.column;
    const endCol = stateNode.endPosition.column;
    const line = result.split("\n")[row];

    // Only expand states that occupy a standalone line:
    // 1. State starts at the first non-whitespace position (no code before)
    // 2. Only whitespace follows the state on the same line (no trailing code)
    // Inline states (e.g., "sm { on { ... } off { ... } }") are left compact.
    const lineLeadingWs = line.length - line.trimStart().length;
    if (startCol !== lineLeadingWs) continue;
    if (line.substring(endCol).trim().length > 0) continue;

    // Find the state name
    const nameNode = stateNode.childForFieldName("name");
    if (!nameNode) continue;
    const stateName = nameNode.text;

    // Collect transition child texts
    const transitionTexts: string[] = [];
    for (let i = 0; i < stateNode.childCount; i++) {
      const child = stateNode.child(i);
      if (child.type === "transition" || child.type === "standalone_transition" || child.type === "state_to_state_transition") {
        transitionTexts.push(child.text);
      }
    }

    // Compute the indent from leading whitespace only (safe — verified above)
    const stateIndent = line.substring(0, startCol);
    const childIndent = stateIndent + "  "; // +1 level

    // Build expanded text
    const expandedLines = [`${stateName} {`];
    for (const t of transitionTexts) {
      expandedLines.push(`${childIndent}${t}`);
    }
    expandedLines.push(`${stateIndent}}`);
    const expanded = expandedLines.join("\n");

    // Replace in the result
    const allLines = result.split("\n");
    allLines[row] = line.substring(0, startCol) + expanded + line.substring(endCol);
    result = allLines.join("\n");
  }

  return result;
}

/**
 * Compute indent edits for an Umple document using syntax-aware indentation.
 *
 * @param text    Document text
 * @param options Formatting options (tabSize, insertSpaces)
 * @param tree    Pre-parsed tree-sitter tree
 * @returns Array of TextEdits to apply for correct indentation
 */
export function computeIndentEdits(
  text: string,
  options: { tabSize: number; insertSpaces: boolean },
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  const multilineListIndents = computeMultilineListIndentMap(lines, options, tree);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Skip lines inside verbatim regions (embedded code)
    if (isVerbatimLine(tree, i)) continue;

    // Find first non-whitespace column for AST lookup
    const firstNonWs = line.length - line.trimStart().length;

    // Compute structural depth from AST ancestors
    let depth = computeStructuralDepth(tree, i, firstNonWs);

    // Handle leading closing braces: outdent before indenting this line
    let leadingCloses = 0;
    for (const ch of trimmed) {
      if (ch === "}") leadingCloses++;
      else break;
    }
    depth = Math.max(0, depth - leadingCloses);

    // Compute expected indent
    const expected = multilineListIndents.get(i) ?? unit.repeat(depth);
    const currentIndent = line.substring(0, firstNonWs);

    // Only emit edit if indent differs
    if (currentIndent !== expected) {
      edits.push(
        TextEdit.replace(
          Range.create(
            Position.create(i, 0),
            Position.create(i, currentIndent.length),
          ),
          expected,
        ),
      );
    }
  }

  return edits;
}

function computeMultilineListIndentMap(
  lines: string[],
  options: { tabSize: number; insertSpaces: boolean },
  tree: Tree,
): Map<number, string> {
  const overrides = new Map<number, { indent: string; spanRows: number; priority: number }>();

  const setOverride = (row: number, indent: string, node: any, priority: number) => {
    if (row < 0 || row >= lines.length) return;
    if (lines[row].trim().length === 0) return;

    const spanRows = node.endPosition.row - node.startPosition.row;
    const existing = overrides.get(row);
    if (
      !existing ||
      spanRows < existing.spanRows ||
      (spanRows === existing.spanRows && priority > existing.priority)
    ) {
      overrides.set(row, { indent, spanRows, priority });
    }
  };
  const getBaseIndentColumns = (row: number): number => {
    const existing = overrides.get(row);
    if (existing) {
      return measureIndentColumns(existing.indent, options.tabSize);
    }
    return computeExpectedStructuralIndentColumns(lines, options, tree, row);
  };

  const visit = (node: any) => {
    if (MULTILINE_LIST_NODES.has(node.type)) {
      addMultilineListIndentOverrides(node, lines, options, getBaseIndentColumns, setOverride);
    }
    addParamListClosingIndentOverride(node, lines, options, getBaseIndentColumns, setOverride);

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };

  visit(tree.rootNode);
  return new Map(Array.from(overrides, ([row, value]) => [row, value.indent]));
}

function addMultilineListIndentOverrides(
  node: any,
  lines: string[],
  options: { tabSize: number; insertSpaces: boolean },
  getBaseIndentColumns: (row: number) => number,
  setOverride: (row: number, indent: string, node: any, priority: number) => void,
): void {
  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  if (startRow === endRow) return;
  if (!hasDirectCommaChild(node)) return;

  const baseRow = getMultilineListBaseRow(node);
  if (baseRow === null) return;

  const baseColumns = getBaseIndentColumns(baseRow);
  const baseIndent = buildIndent(baseColumns, options);
  const itemIndent = buildIndent(baseColumns + options.tabSize, options);
  const closingDelimiter = getMultilineListClosingDelimiter(node.type);

  for (let row = Math.max(startRow, baseRow + 1); row <= endRow; row++) {
    const trimmed = lines[row]?.trimStart() ?? "";
    if (!trimmed) continue;

    if (closingDelimiter && trimmed.startsWith(closingDelimiter)) {
      setOverride(row, baseIndent, node, 40);
    } else {
      setOverride(row, itemIndent, node, 20);
    }
  }
}

function addParamListClosingIndentOverride(
  node: any,
  lines: string[],
  options: { tabSize: number; insertSpaces: boolean },
  getBaseIndentColumns: (row: number) => number,
  setOverride: (row: number, indent: string, node: any, priority: number) => void,
): void {
  if (!hasDirectChildOfType(node, "param_list")) return;

  const openParen = firstDirectChildOfType(node, "(");
  const closeParen = lastDirectChildOfType(node, ")");
  if (!openParen || !closeParen) return;
  if (openParen.startPosition.row === closeParen.startPosition.row) return;

  const closeRow = closeParen.startPosition.row;
  const trimmed = lines[closeRow]?.trimStart() ?? "";
  if (!trimmed.startsWith(")")) return;

  const baseColumns = getBaseIndentColumns(openParen.startPosition.row);
  setOverride(closeRow, buildIndent(baseColumns, options), node, 50);
}

function computeExpectedStructuralIndentColumns(
  lines: string[],
  options: { tabSize: number; insertSpaces: boolean },
  tree: Tree,
  row: number,
): number {
  const line = lines[row] ?? "";
  if (!line.trim()) return getLineIndentColumns(line, options.tabSize);

  const firstNonWs = line.length - line.trimStart().length;
  let depth = computeStructuralDepth(tree, row, firstNonWs);
  const trimmed = line.trim();
  let leadingCloses = 0;
  for (const ch of trimmed) {
    if (ch === "}") leadingCloses++;
    else break;
  }
  depth = Math.max(0, depth - leadingCloses);
  return depth * options.tabSize;
}

function hasDirectCommaChild(node: any): boolean {
  return hasDirectChildOfType(node, ",");
}

function hasDirectChildOfType(node: any, type: string): boolean {
  return firstDirectChildOfType(node, type) !== null;
}

function firstDirectChildOfType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

function lastDirectChildOfType(node: any, type: string): any | null {
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

function getMultilineListBaseRow(node: any): number | null {
  if (node.type === "param_list") {
    const openParen = node.parent ? firstDirectChildOfType(node.parent, "(") : null;
    return openParen?.startPosition.row ?? node.startPosition.row;
  }

  const opener =
    node.type === "template_list"
      ? firstDirectChildOfType(node, "(")
      : node.type === "type_name" || node.type === "trait_parameters"
        ? firstDirectChildOfType(node, "<")
        : node.type === "key_definition" || node.type === "enumerated_attribute"
          ? firstDirectChildOfType(node, "{")
          : null;

  return opener?.startPosition.row ?? node.startPosition.row;
}

function getMultilineListClosingDelimiter(nodeType: string): string | null {
  if (nodeType === "type_name" || nodeType === "trait_parameters") return ">";
  if (nodeType === "template_list") return ")";
  if (nodeType === "key_definition" || nodeType === "enumerated_attribute") return "}";
  if (nodeType === "trace_statement") return "}";
  return null;
}

function getLineIndentColumns(line: string, tabSize: number): number {
  const indentChars = line.length - line.trimStart().length;
  return measureIndentColumns(line.substring(0, indentChars), tabSize);
}

// ── Phase 2: Targeted fixups ────────────────────────────────────────────────

/** Node types that contain a `->` arrow whose surrounding whitespace should be normalized. */
const ARROW_NODES = new Set(["transition", "standalone_transition", "state_to_state_transition"]);

/**
 * Normalize whitespace around `->` in transition and standalone/state-to-state transition nodes.
 * Only handles single-line nodes. Leaves event, guard, action, and target text verbatim.
 */
export function fixTransitionSpacing(
  text: string,
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];

  const visit = (node: any) => {
    if (ARROW_NODES.has(node.type)) {
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;
      // Only single-line transitions
      if (startRow !== endRow) return;

      // Find the structural "->" token by walking children (not substring search,
      // which would match "->" inside action_code like "foo->bar")
      let arrowChild: any = null;
      for (let c = 0; c < node.childCount; c++) {
        const child = node.child(c);
        if (child && child.type === "->") {
          arrowChild = child;
          break;
        }
      }
      if (!arrowChild) return;

      const arrowCol = arrowChild.startPosition.column;
      const arrowEndCol = arrowChild.endPosition.column;
      const line = lines[startRow];

      // Find whitespace region around the structural arrow.
      // Don't walk past line indentation — that belongs to computeIndentEdits().
      const indentEnd = line.search(/\S/);
      let wsStart = arrowCol;
      while (wsStart > 0 && wsStart > indentEnd && isHorizontalWhitespace(line[wsStart - 1])) {
        wsStart--;
      }
      let wsEnd = arrowEndCol;
      while (wsEnd < line.length && isHorizontalWhitespace(line[wsEnd])) {
        wsEnd++;
      }

      const currentRegion = line.substring(wsStart, wsEnd);
      // Auto-transitions start with "->"; no leading space if arrow is at indent boundary
      const expectedRegion = wsStart <= indentEnd ? "-> " : " -> ";
      if (currentRegion === expectedRegion) return;

      edits.push(
        TextEdit.replace(
          Range.create(
            Position.create(startRow, wsStart),
            Position.create(startRow, wsEnd),
          ),
          expectedRegion,
        ),
      );
      return; // Don't descend into transition children
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };

  visit(tree.rootNode);
  return edits;
}

/** Node types that contain an `arrow` child whose surrounding whitespace should be normalized. */
const ASSOC_NODES = new Set(["association_inline", "association_member"]);
const DECLARATION_ASSIGNMENT_NODES = new Set([
  "attribute_declaration",
  "const_declaration",
]);
const STRUCTURAL_EQUALS_NODES = new Set([
  "tracer_directive",
]);
const STRUCTURAL_COMMA_NODES = new Set([
  "use_statement",
  "isa_type_list",
  "filter_value",
  "filter_combined_value",
  "filter_namespace_stmt",
  "param_list",
  "type_name",
  "type_list",
  "trait_parameters",
  "enum_definition",
  "method_signature",
  "method_declaration",
  "abstract_method_declaration",
  "before_after",
  "toplevel_code_injection",
  "code_langs",
  "key_definition",
  "enumerated_attribute",
  "req_implementation",
  "trace_statement",
  "template_list",
  "tracer_directive",
]);
const MULTILINE_LIST_NODES = new Set([
  "use_statement",
  "isa_type_list",
  "filter_value",
  "filter_combined_value",
  "filter_namespace_stmt",
  "param_list",
  "type_name",
  "type_list",
  "trait_parameters",
  "code_langs",
  "key_definition",
  "enumerated_attribute",
  "req_implementation",
  "trace_statement",
  "template_list",
]);

function isHorizontalWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/**
 * Normalize commas in selected structural lists.
 * This deliberately excludes method bodies and expression-like text; code commas
 * are inside code_content and are not parser-visible children here.
 */
export function fixStructuralCommaSpacing(
  text: string,
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];

  const visit = (node: any) => {
    if (STRUCTURAL_COMMA_NODES.has(node.type)) {
      for (let c = 0; c < node.childCount; c++) {
        const child = node.child(c);
        if (!child || child.type !== ",") continue;
        const row = child.startPosition.row;
        if (row !== child.endPosition.row) continue;

        const commaCol = child.startPosition.column;
        const commaEndCol = child.endPosition.column;
        const line = lines[row];
        if (line.substring(commaEndCol).trim().length === 0) continue;

        let wsStart = commaCol;
        while (wsStart > 0 && isHorizontalWhitespace(line[wsStart - 1])) {
          wsStart--;
        }
        let wsEnd = commaEndCol;
        while (wsEnd < line.length && isHorizontalWhitespace(line[wsEnd])) {
          wsEnd++;
        }

        const currentRegion = line.substring(wsStart, wsEnd);
        const expectedRegion = ", ";
        if (currentRegion !== expectedRegion) {
          edits.push(
            TextEdit.replace(
              Range.create(
                Position.create(row, wsStart),
                Position.create(row, wsEnd),
              ),
              expectedRegion,
            ),
          );
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };

  visit(tree.rootNode);
  return edits;
}

/**
 * Normalize whitespace around the arrow in association_inline and association_member nodes.
 * Only handles single-line nodes. Same child-walking approach as fixTransitionSpacing.
 */
export function fixAssociationSpacing(
  text: string,
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];

  const visit = (node: any) => {
    if (ASSOC_NODES.has(node.type)) {
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;
      if (startRow !== endRow) return;

      // Find the "arrow" child node
      let arrowChild: any = null;
      for (let c = 0; c < node.childCount; c++) {
        const child = node.child(c);
        if (child && child.type === "arrow") {
          arrowChild = child;
          break;
        }
      }
      if (!arrowChild) return;

      const arrowCol = arrowChild.startPosition.column;
      const arrowEndCol = arrowChild.endPosition.column;
      const line = lines[startRow];

      // Find whitespace region around the arrow
      let wsStart = arrowCol;
      while (wsStart > 0 && isHorizontalWhitespace(line[wsStart - 1])) {
        wsStart--;
      }
      let wsEnd = arrowEndCol;
      while (wsEnd < line.length && isHorizontalWhitespace(line[wsEnd])) {
        wsEnd++;
      }

      const currentRegion = line.substring(wsStart, wsEnd);
      const arrowText = arrowChild.text;
      const expectedRegion = " " + arrowText + " ";
      if (currentRegion === expectedRegion) return;

      edits.push(
        TextEdit.replace(
          Range.create(
            Position.create(startRow, wsStart),
            Position.create(startRow, wsEnd),
          ),
          expectedRegion,
        ),
      );
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };

  visit(tree.rootNode);
  return edits;
}

/**
 * Normalize whitespace around structural declaration assignment (`=`) tokens.
 * Only touches parser-visible assignment children in attributes and constants;
 * embedded code bodies and expression operators are intentionally ignored.
 */
export function fixDeclarationAssignmentSpacing(
  text: string,
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];

  const visit = (node: any) => {
    if (DECLARATION_ASSIGNMENT_NODES.has(node.type) || STRUCTURAL_EQUALS_NODES.has(node.type)) {
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;
      if (startRow !== endRow) return;

      for (let c = 0; c < node.childCount; c++) {
        const child = node.child(c);
        if (!child || child.type !== "=") continue;

        const equalsCol = child.startPosition.column;
        const equalsEndCol = child.endPosition.column;
        const line = lines[startRow];

        let wsStart = equalsCol;
        while (wsStart > 0 && isHorizontalWhitespace(line[wsStart - 1])) {
          wsStart--;
        }
        let wsEnd = equalsEndCol;
        while (wsEnd < line.length && isHorizontalWhitespace(line[wsEnd])) {
          wsEnd++;
        }

        const currentRegion = line.substring(wsStart, wsEnd);
        const expectedRegion = " = ";
        if (currentRegion !== expectedRegion) {
          edits.push(
            TextEdit.replace(
              Range.create(
                Position.create(startRow, wsStart),
                Position.create(startRow, wsEnd),
              ),
              expectedRegion,
            ),
          );
        }

        if (DECLARATION_ASSIGNMENT_NODES.has(node.type)) break;
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  };

  visit(tree.rootNode);
  return edits;
}

/**
 * Normalize blank lines between top-level declarations in source_file.
 * Ensures exactly 1 blank line between consecutive top-level named children.
 * Does NOT touch interior body spacing.
 */
export function normalizeTopLevelBlankLines(
  text: string,
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  const root = tree.rootNode;

  // Collect top-level named declaration children (skip comments and anonymous nodes)
  const topDecls: { startRow: number; endRow: number }[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child && TOP_LEVEL_DECL_NODES.has(child.type)) {
      topDecls.push({
        startRow: child.startPosition.row,
        endRow: child.endPosition.row,
      });
    }
  }

  // For each consecutive pair, ensure exactly 1 blank line between them
  for (let i = 0; i < topDecls.length - 1; i++) {
    const prevEnd = topDecls[i].endRow;
    const nextStart = topDecls[i + 1].startRow;

    // Multiple top-level declarations can legally appear on one physical line
    // (`use f1; use f2;`). This pass only normalizes inter-line gaps; splitting
    // same-line declarations is a separate, higher-risk rewrite.
    if (nextStart <= prevEnd) continue;

    const gap = nextStart - prevEnd - 1; // number of lines between them

    if (gap === 1) continue; // Already correct: exactly 1 blank line

    // Safety: if any non-blank line exists in the gap (e.g., comments),
    // skip this gap entirely to avoid deleting user content
    if (gap > 1) {
      let hasNonBlank = false;
      for (let row = prevEnd + 1; row < nextStart; row++) {
        if (lines[row].trim().length > 0) {
          hasNonBlank = true;
          break;
        }
      }
      if (hasNonBlank) continue;
    }

    if (gap < 1) {
      // No blank line — insert at the END of the previous declaration's last line.
      // This avoids conflicting with indent edits that target [nextStart, 0].
      edits.push(
        TextEdit.insert(
          Position.create(prevEnd, lines[prevEnd].length),
          "\n",
        ),
      );
    } else {
      // Too many blank lines (all blank) — remove extras (keep exactly 1)
      const deleteStart = prevEnd + 2;
      const deleteEnd = nextStart;
      edits.push(
        TextEdit.del(
          Range.create(
            Position.create(deleteStart, 0),
            Position.create(deleteEnd, 0),
          ),
        ),
      );
    }
  }

  return edits;
}

// ── Phase 3: Embedded code reindentation ────────────────────────────────────

/**
 * Reindent embedded code_content blocks to match their structural context.
 *
 * Preserves internal relative indentation but shifts the whole block so that
 * the least-indented line aligns with the expected base indent (parent depth + 1).
 * Only handles code_content (not template_body, which is truly opaque).
 */
export function reindentEmbeddedCode(
  text: string,
  options: { tabSize: number; insertSpaces: boolean },
  tree: Tree,
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";

  // Collect all code_content nodes
  const codeNodes: any[] = [];
  function walk(node: any) {
    if (node.type === "code_content") {
      codeNodes.push(node);
      return; // don't recurse into code_content children
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }
  walk(tree.rootNode);

  for (const codeNode of codeNodes) {
    const startRow = codeNode.startPosition.row;
    const endRow = codeNode.endPosition.row;

    // Only process lines strictly inside the code_content (not boundary lines)
    // Boundary lines (with `{` and `}`) are handled by computeIndentEdits
    const firstInterior = startRow + 1;
    const lastInterior = endRow - 1;
    if (firstInterior > lastInterior) continue; // single-line code_content

    // Compute expected base indent: the structural depth at the opening `{` line + 1
    const parentNode = codeNode.parent;
    if (!parentNode) continue;
    const parentRow = parentNode.startPosition.row;
    const baseDepth = computeStructuralDepth(tree, parentRow, 0);
    // code_content is inside the block, so it gets baseDepth (which already includes the parent)
    // But computeStructuralDepth at parentRow doesn't count the parent itself, so add 1
    // Actually: the parent IS in INDENT_NODES, and computeStructuralDepth counts ancestors whose
    // startRow < line. At parentRow, the parent's own node is NOT counted (startRow === line).
    // So we need: depth at a line strictly inside the parent = baseDepth + 1 for the parent block.
    // But we're computing depth at parentRow, so we get the depth ABOVE the parent.
    // The expected indent for code inside the block = depth_above_parent + 1.
    const expectedDepth = baseDepth + 1;
    const expectedIndentCols = expectedDepth * options.tabSize;

    // Find minimum indent of non-empty lines in the interior
    let minIndent = Infinity;
    const interiorLines: { row: number; indentCols: number; indentChars: number; empty: boolean }[] = [];
    for (let row = firstInterior; row <= lastInterior; row++) {
      const line = lines[row];
      if (!line || !line.trim()) {
        interiorLines.push({ row, indentCols: 0, indentChars: 0, empty: true });
        continue;
      }
      const indentChars = line.length - line.trimStart().length;
      const indentText = line.substring(0, indentChars);
      const indentCols = measureIndentColumns(indentText, options.tabSize);
      interiorLines.push({ row, indentCols, indentChars, empty: false });
      if (indentCols < minIndent) minIndent = indentCols;
    }

    if (minIndent === Infinity) continue; // all empty

    // Compute shift needed
    if (minIndent === expectedIndentCols) continue; // already correct

    // Apply shift to each non-empty line
    for (const entry of interiorLines) {
      if (entry.empty) continue;
      const line = lines[entry.row];
      const relativeIndentCols = entry.indentCols - minIndent;
      const newIndent = buildIndent(expectedIndentCols + relativeIndentCols, options);
      const oldIndent = line.substring(0, entry.indentChars);

      if (oldIndent !== newIndent) {
        edits.push(
          TextEdit.replace(
            Range.create(
              Position.create(entry.row, 0),
              Position.create(entry.row, entry.indentChars),
            ),
            newIndent,
          ),
        );
      }
    }
  }

  return edits;
}

function measureIndentColumns(indent: string, tabSize: number): number {
  let cols = 0;
  for (const ch of indent) {
    cols += ch === "\t" ? tabSize : 1;
  }
  return cols;
}

function buildIndent(
  columns: number,
  options: { tabSize: number; insertSpaces: boolean },
): string {
  if (columns <= 0) return "";
  if (options.insertSpaces) return " ".repeat(columns);

  const tabs = Math.floor(columns / options.tabSize);
  const spaces = columns % options.tabSize;
  return "\t".repeat(tabs) + " ".repeat(spaces);
}

/**
 * Collect line ranges of code_content and template_body nodes.
 * Kept for backward compatibility with existing callers; the new
 * formatter uses isVerbatimLine() from formatRules instead.
 */
export function getCodeContentRanges(
  tree: /* Tree */ any,
): { startLine: number; endLine: number }[] {
  const ranges: { startLine: number; endLine: number }[] = [];
  const cursor = tree.rootNode.walk();

  let reachedEnd = false;
  while (!reachedEnd) {
    const node = cursor.currentNode;
    if (node.type === "code_content" || node.type === "template_body") {
      ranges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      });
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

  return ranges;
}
