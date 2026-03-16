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
import { isVerbatimLine, computeStructuralDepth } from "./formatRules";

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
