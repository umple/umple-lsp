/**
 * Reference search logic.
 *
 * Finds all references to a symbol across indexed files using
 * references.scm query captures and semantic filtering.
 * No dependency on SymbolIndex class.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;
type Query = InstanceType<typeof TreeSitter.Query>;

import type { SymbolKind } from "./tokenTypes";
import { SYMBOL_KINDS_LONGEST_FIRST } from "./tokenTypes";
import type { SymbolEntry, ReferenceLocation } from "./symbolTypes";
import { resolveStatePath } from "./treeUtils";

/**
 * Find all references to a symbol across the given files.
 *
 * @param declarations      Target symbol declaration(s)
 * @param includeDeclaration Whether to include declaration sites in results
 * @param referencesQuery   Loaded references.scm query
 * @param fileTreeMap       filePath → cached parse tree (only files to search)
 * @param isAGraph          className → parent class names (for inheritance checks)
 */
export function searchReferences(
  declarations: SymbolEntry[],
  includeDeclaration: boolean,
  referencesQuery: Query,
  fileTreeMap: Map<string, Tree>,
  isAGraph: Map<string, string[]>,
): ReferenceLocation[] {
  if (declarations.length === 0) return [];

  const sym = declarations[0];
  const symName = sym.name;
  const symKind = sym.kind;
  const symContainer = sym.container;

  // Collect definition positions for deduplication and includeDeclaration
  const defPositions = new Set<string>();
  for (const d of declarations) {
    defPositions.add(`${d.file}:${d.line}:${d.column}:${d.endLine}:${d.endColumn}`);
  }

  // Container-scoped kinds need enclosing scope verification
  const containerScopedKinds = new Set<SymbolKind>([
    "attribute", "const", "method", "template", "state", "statemachine", "tracecase",
  ]);
  const isContainerScoped = containerScopedKinds.has(symKind);

  const results: ReferenceLocation[] = [];
  const seen = new Set<string>();

  const addResult = (file: string, line: number, column: number, endLine: number, endColumn: number) => {
    const key = `${file}:${line}:${column}:${endLine}:${endColumn}`;
    if (seen.has(key)) return;
    if (!includeDeclaration && defPositions.has(key)) return;
    seen.add(key);
    results.push({ file, line, column, endLine, endColumn });
  };

  // If includeDeclaration, add all definition sites first
  if (includeDeclaration) {
    for (const d of declarations) {
      addResult(d.file, d.line, d.column, d.endLine, d.endColumn);
    }
  }

  // Scan each file
  for (const [filePath, tree] of fileTreeMap) {
    const captures = referencesQuery.captures(tree.rootNode);

    for (const capture of captures) {
      const node = capture.node;
      if (node.text !== symName) continue;

      // Parse capture name to get reference kinds
      const refKinds = parseCaptureKinds(capture.name);
      if (!refKinds || !refKinds.includes(symKind)) continue;

      // For container-scoped kinds, verify enclosing scope matches
      if (isContainerScoped && symContainer) {
        const enclosing = resolveEnclosingScopeFromNode(node, symKind);
        if (enclosing && enclosing !== symContainer) {
          // Case 1: standalone statemachine referenced from a class
          // e.g., enclosing="MotorController.deviceStatus" matches standalone container="deviceStatus"
          const isStandaloneSm = symKind === "statemachine" && enclosing.endsWith(`.${symContainer}`);
          if (!isStandaloneSm) {
            // Case 2: state/statemachine container mismatch — reject
            if (symKind === "state" || symKind === "statemachine") {
              continue;
            }
            // Case 3: other kinds — check inheritance chain
            if (!isInheritanceChain(enclosing, symContainer, isAGraph)) {
              continue;
            }
          }
          // isStandaloneSm === true → accept without further checks
        }
      }

      // For trait_sm_binding value paths, filter by segment position and depth
      const valSegIdx = getTraitSmBindingValueSegmentIndex(node);
      if (valSegIdx !== undefined) {
        if (valSegIdx === 0 && symKind !== "statemachine") continue;
        if (valSegIdx > 0 && symKind !== "state") continue;
        if (symKind === "state" && sym.statePath &&
            valSegIdx !== sym.statePath.length) continue;
      }

      // For nested states, disambiguate by path context
      if (symKind === "state" && sym.statePath && sym.statePath.length >= 1) {
        const pathCtx = extractPathContextFromNode(node);
        if (pathCtx) {
          let preceding = pathCtx.preceding;
          if (
            node.parent?.parent?.type === "trait_sm_binding" &&
            node.parent?.parent?.childForFieldName("value")?.id ===
              node.parent?.id
          ) {
            preceding = preceding.slice(1);
          }
          const targetPrecedingPath = sym.statePath.slice(0, sym.statePath.length - 1);
          if (!pathMatches(preceding, targetPrecedingPath, true)) {
            continue;
          }
        } else if (node.parent?.type === "state") {
          const candidatePath = resolveStatePath(node);
          if (!pathMatches(candidatePath, sym.statePath, false)) {
            continue;
          }
        }
      }

      addResult(
        filePath,
        node.startPosition.row,
        node.startPosition.column,
        node.endPosition.row,
        node.endPosition.column,
      );
    }
  }

  return results;
}

// ── Private helpers ─────────────────────────────────────────────────────────

function parseCaptureKinds(captureName: string): SymbolKind[] | null {
  const prefix = "reference.";
  if (!captureName.startsWith(prefix)) return null;
  let rest = captureName.substring(prefix.length);
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

function resolveEnclosingScopeFromNode(
  node: SyntaxNode,
  targetKind: SymbolKind,
): string | undefined {
  let current: SyntaxNode | null = node.parent;
  let enclosingClass: string | undefined;
  let enclosingSM: string | undefined;

  while (current) {
    if (current.type === "state_machine" || current.type === "statemachine_definition") {
      enclosingSM = current.childForFieldName("name")?.text ?? enclosingSM;
    }
    if (
      !enclosingClass &&
      ["class_definition", "trait_definition", "interface_definition", "association_class_definition"].includes(current.type)
    ) {
      enclosingClass = current.childForFieldName("name")?.text;
    }
    current = current.parent;
  }

  if (targetKind === "state" || targetKind === "statemachine") {
    if (enclosingClass && enclosingSM) return `${enclosingClass}.${enclosingSM}`;
    if (enclosingSM) return enclosingSM;
    if (enclosingClass) {
      const smName = resolveTraitSmBindingValueSM(node);
      if (smName) return `${enclosingClass}.${smName}`;
      const refSmName = resolveReferencedSmDefinition(node);
      if (refSmName) return `${enclosingClass}.${refSmName}`;
    }
    return undefined;
  }

  if (!enclosingClass && targetKind === "method") {
    const parent = node.parent;
    if (
      parent?.type === "toplevel_code_injection" &&
      parent.childForFieldName("operation")?.id === node.id
    ) {
      const targetNode = parent.childForFieldName("target");
      if (targetNode) return targetNode.text;
    }
  }

  return enclosingClass;
}

function resolveTraitSmBindingValueSM(node: SyntaxNode): string | undefined {
  const parent = node.parent;
  if (parent?.type !== "qualified_name") return undefined;
  const grandparent = parent.parent;
  if (grandparent?.type !== "trait_sm_binding") return undefined;
  if (grandparent.childForFieldName("value")?.id !== parent.id) return undefined;
  const firstId = parent.namedChild(0);
  return firstId?.type === "identifier" ? firstId.text : undefined;
}

function resolveReferencedSmDefinition(node: SyntaxNode): string | undefined {
  const parent = node.parent;
  if (parent?.type !== "referenced_statemachine") return undefined;
  if (parent.childForFieldName("definition")?.id !== node.id) return undefined;
  return node.text;
}

function getTraitSmBindingValueSegmentIndex(node: SyntaxNode): number | undefined {
  const parent = node.parent;
  if (parent?.type !== "qualified_name") return undefined;
  const grandparent = parent.parent;
  if (grandparent?.type !== "trait_sm_binding") return undefined;
  if (grandparent.childForFieldName("value")?.id !== parent.id) return undefined;
  let idx = 0;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type === "identifier") {
      if (child.id === node.id) return idx;
      idx++;
    }
  }
  return undefined;
}

function isInheritanceChain(
  childClass: string,
  parentClass: string,
  isAGraph: Map<string, string[]>,
): boolean {
  const visited = new Set<string>();
  const queue = [childClass];
  while (queue.length > 0) {
    const cls = queue.pop()!;
    if (cls === parentClass) return true;
    if (visited.has(cls)) continue;
    visited.add(cls);
    const parents = isAGraph.get(cls);
    if (parents) queue.push(...parents);
  }
  return false;
}

function extractPathContextFromNode(
  node: SyntaxNode,
): { preceding: string[] } | null {
  const parent = node.parent;
  if (!parent || parent.type !== "qualified_name") return null;

  const segments: string[] = [];
  let nodeIndex = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type === "identifier") {
      if (child.id === node.id) nodeIndex = segments.length;
      segments.push(child.text);
    }
  }
  if (nodeIndex <= 0) return null;
  return { preceding: segments.slice(0, nodeIndex) };
}

function pathMatches(actual: string[], target: string[], suffix: boolean): boolean {
  if (suffix) {
    if (actual.length > target.length) return false;
    const offset = target.length - actual.length;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== target[offset + i]) return false;
    }
    return true;
  }
  if (actual.length !== target.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== target[i]) return false;
  }
  return true;
}
