/**
 * Document symbol (outline) builder.
 *
 * Converts flat SymbolEntry[] into hierarchical DocumentSymbol[] tree
 * using definition range containment. No LSP connection dependency.
 */

import {
  DocumentSymbol,
  Range,
  Position,
} from "vscode-languageserver/node";
import type { SymbolEntry } from "./symbolTypes";
import { umpleKindToLspSymbolKind } from "./symbolPresentation";

/** Check if outer's definition range strictly contains inner's. */
function defRangeContains(outer: SymbolEntry, inner: SymbolEntry): boolean {
  const os = outer.defLine! * 1e6 + outer.defColumn!;
  const oe = outer.defEndLine! * 1e6 + outer.defEndColumn!;
  const is_ = inner.defLine! * 1e6 + inner.defColumn!;
  const ie = inner.defEndLine! * 1e6 + inner.defEndColumn!;
  return os <= is_ && oe >= ie && (os < is_ || oe > ie);
}

/**
 * Convert a flat list of SymbolEntry[] (single file) into a hierarchical
 * DocumentSymbol[] tree using range containment.
 */
export function buildDocumentSymbolTree(
  symbols: SymbolEntry[],
): DocumentSymbol[] {
  const entries = symbols.filter(
    (s) => s.defLine !== undefined && s.defEndLine !== undefined,
  );

  // Sort by body range start, then largest first (parents before children)
  entries.sort((a, b) => {
    const lineDiff = a.defLine! - b.defLine!;
    if (lineDiff !== 0) return lineDiff;
    const colDiff = a.defColumn! - b.defColumn!;
    if (colDiff !== 0) return colDiff;
    // Same start: larger range first
    const aEnd = a.defEndLine! * 1e6 + a.defEndColumn!;
    const bEnd = b.defEndLine! * 1e6 + b.defEndColumn!;
    return bEnd - aEnd;
  });

  const roots: DocumentSymbol[] = [];
  const stack: { sym: DocumentSymbol; entry: SymbolEntry }[] = [];

  for (const entry of entries) {
    const docSym = DocumentSymbol.create(
      entry.name,
      entry.kind,
      umpleKindToLspSymbolKind(entry.kind),
      Range.create(
        Position.create(entry.defLine!, entry.defColumn!),
        Position.create(entry.defEndLine!, entry.defEndColumn!),
      ),
      Range.create(
        Position.create(entry.line, entry.column),
        Position.create(entry.endLine, entry.endColumn),
      ),
    );

    // Pop stack until we find a parent that contains this entry
    while (stack.length > 0) {
      if (defRangeContains(stack[stack.length - 1].entry, entry)) break;
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(docSym);
    } else {
      const parent = stack[stack.length - 1].sym;
      if (!parent.children) parent.children = [];
      parent.children.push(docSym);
    }

    stack.push({ sym: docSym, entry });
  }

  return roots;
}
