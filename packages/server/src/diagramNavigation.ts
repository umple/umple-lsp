/**
 * Diagram-specific navigation: resolve click targets from SVG diagram payloads.
 * Owns the AST walking and symbol lookup logic for diagram click-to-select.
 * Depends on SymbolIndex for symbol queries and tree-sitter for transition search.
 */

import * as path from "path";
import { SymbolIndex, SymbolEntry } from "./symbolIndex";

type LocationRange = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

/**
 * Resolve a state location from a diagram click payload.
 * Uses the symbol index for path-aware state lookup.
 * Scoped to the clicked file.
 */
export function resolveStateLocation(
  si: SymbolIndex,
  filePath: string,
  className: string | undefined,
  stateMachine: string,
  statePath: string[],
): SymbolEntry | undefined {
  const smContainer = className
    ? `${className}.${stateMachine}`
    : stateMachine;
  const targetName = statePath[statePath.length - 1];
  const preceding = statePath.slice(0, -1);
  const reachableFiles = new Set([path.normalize(filePath)]);

  let symbol: SymbolEntry | undefined;
  if (preceding.length > 0) {
    symbol = si.resolveStateInPath(
      preceding,
      targetName,
      smContainer,
      reachableFiles,
    );
  }
  // Fallback: direct lookup scoped to the clicked file
  if (!symbol) {
    const candidates = si
      .getSymbols({
        name: targetName,
        kind: "state",
        container: smContainer,
      })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    if (preceding.length === 0) {
      symbol = candidates[0];
    } else {
      const targetPath = [...preceding, targetName];
      symbol = candidates.find(
        (s) =>
          s.statePath &&
          s.statePath.length >= targetPath.length &&
          targetPath.every(
            (seg, i) =>
              s.statePath![s.statePath!.length - targetPath.length + i] === seg,
          ),
      );
    }
  }
  return symbol;
}

/**
 * Resolve a transition location from a diagram click payload.
 * Uses tree-sitter tree walk (transitions are not in the symbol index).
 * Path-aware: navigates class → SM → source state before searching.
 */
export function resolveTransitionLocation(
  si: SymbolIndex,
  filePath: string,
  content: string,
  className: string | undefined,
  stateMachine: string,
  sourcePath: string[],
  event: string,
  targetPath: string[],
  guard?: string,
): LocationRange | undefined {
  const targetName = targetPath.join(".");
  return si.findTransition(
    filePath,
    content,
    className,
    stateMachine,
    sourcePath,
    event,
    targetName,
    guard,
  );
}
