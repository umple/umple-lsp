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
    const expected = unit.repeat(depth);
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

// ── Phase 2: Targeted fixups ────────────────────────────────────────────────

/** Node types that contain a `->` arrow whose surrounding whitespace should be normalized. */
const ARROW_NODES = new Set(["transition", "standalone_transition"]);

/**
 * Normalize whitespace around `->` in transition and standalone_transition nodes.
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

      // Find whitespace region around the structural arrow
      let wsStart = arrowCol;
      while (wsStart > 0 && line[wsStart - 1] === " ") {
        wsStart--;
      }
      let wsEnd = arrowEndCol;
      while (wsEnd < line.length && line[wsEnd] === " ") {
        wsEnd++;
      }

      const currentRegion = line.substring(wsStart, wsEnd);
      const expectedRegion = " -> ";
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
      while (wsStart > 0 && line[wsStart - 1] === " ") {
        wsStart--;
      }
      let wsEnd = arrowEndCol;
      while (wsEnd < line.length && line[wsEnd] === " ") {
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
