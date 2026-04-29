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

  // Try each candidate container in order (alias-local first, then base fallback)
  const containers = si.getSmContainerCandidates(smContainer);

  for (const container of containers) {
    let symbol: SymbolEntry | undefined;
    if (preceding.length > 0) {
      symbol = si.resolveStateInPath(
        preceding,
        targetName,
        container,
        reachableFiles,
      );
    }
    if (!symbol) {
      const candidates = si
        .getSymbols({
          name: targetName,
          kind: "state",
          container,
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
    if (symbol) return symbol;
  }
  return undefined;
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
    if (child.type === "class_definition" || child.type === "source_file" || child.type === "statemachine_definition") {
      const found = findNamedChild(child, types, name);
      if (found) return found;
    }
  }
  return null;
}

/** SM node types: inline, reused, and standalone definitions. */
const SM_NODE_TYPES = ["state_machine", "referenced_statemachine", "statemachine_definition"];

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
  let classScope = tree.rootNode;
  if (className) {
    const classNode = findNamedChild(classScope, ["class_definition"], className);
    if (!classNode) return undefined;
    classScope = classNode;
  }

  // Step 2: Find the state machine node (state_machine or referenced_statemachine)
  const smNode = findNamedChild(classScope, SM_NODE_TYPES, stateMachine);
  if (!smNode) return undefined;

  // Try to find the transition in the alias SM first, then fall back to base
  const result = findTransitionInSm(smNode, sourcePath, event, targetName, guard);
  if (result) return result;

  // Fallback: if this is a referenced_statemachine, try the base standalone SM
  if (smNode.type === "referenced_statemachine") {
    const baseName = smNode.childForFieldName("definition")?.text;
    if (baseName) {
      // Search at file root for standalone statemachine_definition
      const baseSmNode = findNamedChild(
        tree.rootNode,
        ["statemachine_definition"],
        baseName,
      );
      if (baseSmNode) {
        return findTransitionInSm(baseSmNode, sourcePath, event, targetName, guard);
      }
    }
  }

  return undefined;
}

/**
 * Walk the source state path within an SM node and find a matching transition.
 */
function findTransitionInSm(
  smNode: any,
  sourcePath: string[],
  event: string,
  targetName: string,
  guard?: string,
): LocationRange | undefined {
  // First: check standalone_transition children at SM scope.
  // These live directly under the SM node (not inside a state body) and encode
  // source state as from_state field: "event fromState -> toState;"
  const fromState = sourcePath.length > 0 ? sourcePath[sourcePath.length - 1] : undefined;
  for (let i = 0; i < smNode.childCount; i++) {
    const child = smNode.child(i);
    if (child.type === "standalone_transition" || child.type === "state_to_state_transition") {
      const eventNode = child.childForFieldName("event");
      const fromNode = child.childForFieldName("from_state");
      const toNode = child.childForFieldName("to_state");
      const eventMatch = eventNode ? eventNode.text === event : !event;
      const fromMatch = fromNode ? fromNode.text === fromState : !fromState;
      const targetMatch = toNode ? toNode.text === targetName : !targetName;
      if (eventMatch && fromMatch && targetMatch) {
        return {
          line: child.startPosition.row,
          column: child.startPosition.column,
          endLine: child.endPosition.row,
          endColumn: child.endPosition.column,
        };
      }
    }
  }

  // Then: walk down the source state path for regular nested transitions
  let scope = smNode;
  for (const seg of sourcePath) {
    const stateNode = findNamedChild(scope, ["state"], seg);
    if (!stateNode) return undefined;
    scope = stateNode;
  }

  // Find the matching transition (regular or standalone within state)
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
    // standalone_transition/state_to_state_transition: "event fromState -> toState;" or "fromState -> toState;"
    if (child.type === "standalone_transition" || child.type === "state_to_state_transition") {
      const eventNode = child.childForFieldName("event");
      const toNode = child.childForFieldName("to_state");
      const eventMatch = eventNode ? eventNode.text === event : !event;
      const targetMatch = toNode ? toNode.text === targetName : !targetName;
      if (eventMatch && targetMatch) {
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
