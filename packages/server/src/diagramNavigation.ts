/**
 * Diagram-specific navigation: resolve click targets from SVG diagram payloads.
 * Owns the AST walking and symbol lookup logic for diagram click-to-select.
 * Depends on SymbolIndex for symbol queries and tree parsing.
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

// ── Transition AST walking ───────────────────────────────────────────────────

/**
 * Find a named child node of specific types within a parent node.
 * Recurses into class_definition and source_file nodes.
 */
function findNamedChild(parent: any, types: string[], name: string): any {
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (types.includes(child.type)) {
      const nameNode = child.childForFieldName("name");
      if (nameNode && nameNode.text === name) return child;
    }
  }
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child.type === "class_definition" || child.type === "source_file") {
      const found = findNamedChild(child, types, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve a transition location from a diagram click payload.
 * Path-aware: navigates class → SM → source state path before searching transitions.
 * Uses tree-sitter tree walk (transitions are not in the symbol index).
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
  const tree = si.parse(content);
  if (!tree) return undefined;

  const targetName = targetPath.join(".");

  // Step 1: Find the class node (if className provided)
  let scope = tree.rootNode;
  if (className) {
    const classNode = findNamedChild(scope, ["class_definition"], className);
    if (!classNode) return undefined;
    scope = classNode;
  }

  // Step 2: Find the state machine node
  const smNode = findNamedChild(scope, ["state_machine"], stateMachine);
  if (!smNode) return undefined;
  scope = smNode;

  // Step 3: Walk down the source state path
  for (const seg of sourcePath) {
    const stateNode = findNamedChild(scope, ["state"], seg);
    if (!stateNode) return undefined;
    scope = stateNode;
  }

  // Step 4: Find the matching transition in the resolved source state
  for (let i = 0; i < scope.childCount; i++) {
    const child = scope.child(i);
    if (child.type === "transition") {
      const eventNode = child.childForFieldName("event");
      const targetNode = child.childForFieldName("target");
      const eventMatch = eventNode ? eventNode.text === event : !event;
      const targetMatch = targetNode ? targetNode.text === targetName : !targetName;
      let guardMatch = true;
      if (guard) {
        const guardNode = child.children.find((c: any) => c.type === "guard");
        guardMatch = guardNode ? guardNode.text.includes(guard) : false;
      }
      if (eventMatch && targetMatch && guardMatch) {
        return {
          line: child.startPosition.row,
          column: child.startPosition.column,
          endLine: child.endPosition.row,
          endColumn: child.endPosition.column,
        };
      }
    }
  }

  return undefined;
}
