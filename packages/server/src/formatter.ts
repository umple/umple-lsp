/**
 * Document formatting logic.
 *
 * Pure text manipulation + tree walking for skip-range detection.
 * No dependency on LSP connection, documents, or SymbolIndex class.
 */

import {
  TextEdit,
  Range,
  Position,
} from "vscode-languageserver/node";

/**
 * Collect line ranges of code_content and template_body nodes (embedded code
 * that the formatter should not re-indent).
 *
 * @param tree Pre-parsed tree (caller handles tree acquisition)
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

function isInSkipRange(
  line: number,
  ranges: { startLine: number; endLine: number }[],
): boolean {
  return ranges.some((r) => line > r.startLine && line < r.endLine);
}

/**
 * Compute indent edits for an Umple document.
 *
 * @param text Document text
 * @param options Formatting options (tabSize, insertSpaces)
 * @param skipRanges Ranges to skip (embedded code content)
 */
export function computeIndentEdits(
  text: string,
  options: { tabSize: number; insertSpaces: boolean },
  skipRanges: { startLine: number; endLine: number }[],
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || isInSkipRange(i, skipRanges)) continue;

    let leadingCloses = 0;
    for (const ch of trimmed) {
      if (ch === "}") leadingCloses++;
      else break;
    }
    depth = Math.max(0, depth - leadingCloses);

    const expected = unit.repeat(depth);
    const currentIndent = line.substring(
      0,
      line.length - line.trimStart().length,
    );

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

    let opens = 0;
    let closes = 0;
    for (const ch of trimmed) {
      if (ch === "{") opens++;
      else if (ch === "}") closes++;
    }
    depth = Math.max(0, depth + opens - (closes - leadingCloses));
  }

  return edits;
}
