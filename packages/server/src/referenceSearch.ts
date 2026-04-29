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
  smReuseBindings?: Map<string, string>,
  allSymbols: SymbolEntry[] = [],
): ReferenceLocation[] {
  if (declarations.length === 0) return [];

  const sym = declarations[0];
  const symName = sym.name;
  const symKind = sym.kind;
  const symContainer = sym.container;
  // For shared state declarations, build the set of all valid containers
  const validContainers = new Set(declarations.map((d) => d.container).filter(Boolean) as string[]);

  // Collect definition positions for deduplication and includeDeclaration
  const defPositions = new Set<string>();
  for (const d of declarations) {
    defPositions.add(`${d.file}:${d.line}:${d.column}:${d.endLine}:${d.endColumn}`);
  }

  // Container-scoped kinds need enclosing scope verification
  const containerScopedKinds = new Set<SymbolKind>([
    "attribute", "port", "const", "method", "template", "state", "statemachine", "tracecase",
    "event",
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

      let skipContainerScopeCheck = false;
      const componentPort = getPortConnectorSegmentInfo(node);
      if (componentPort) {
        if (componentPort.segments.length === 1) {
          if (symKind !== "port") continue;
        } else if (componentPort.segments.length === 2) {
          if (componentPort.segmentIndex === 0) {
            if (symKind !== "attribute") continue;
          } else {
            if (symKind !== "port") continue;
            const componentType = resolveComponentTypeFromSymbols(
              allSymbols,
              componentPort.segments[0],
              resolveEnclosingScopeFromNode(node, "attribute"),
              isAGraph,
            );
            if (!componentType) continue;
            if (
              !validContainers.has(componentType) &&
              !Array.from(validContainers).some((c) =>
                isInheritanceChain(componentType, c, isAGraph),
              )
            ) {
              continue;
            }
            skipContainerScopeCheck = true;
          }
        } else {
          continue;
        }
      }

      // Dotted trace state paths: trace status.Closed;
      // First segment is a class-local state machine, later segments are states
      // under that state machine. Plain trace entities remain handled by the
      // normal reference captures.
      const traceStatePath = getTraceStatePathSegmentInfo(node);
      if (traceStatePath) {
        if (traceStatePath.segmentIndex === 0 && symKind !== "statemachine") continue;
        if (traceStatePath.segmentIndex > 0 && symKind !== "state") continue;

        const enclosingClass = resolveEnclosingScopeFromNode(node, "attribute");
        if (!enclosingClass) continue;
        const expectedContainer = `${enclosingClass}.${traceStatePath.pathSegments[0]}`;
        if (!validContainers.has(expectedContainer)) continue;
        if (
          symKind === "state" &&
          sym.statePath
        ) {
          const expectedStatePath = traceStatePath.pathSegments.slice(
            1,
            traceStatePath.segmentIndex + 1,
          );
          if (!pathMatches(sym.statePath, expectedStatePath, false)) {
            continue;
          }
        }
        skipContainerScopeCheck = true;
      }

      // For sorted keys, resolve the owner class from the association and check
      // it matches the declaration container (with inheritance).
      if (node.parent?.type === "sorted_modifier" && symKind === "attribute") {
        const ownerClass = resolveSortedKeyOwner(node);
        if (ownerClass) {
          // Owner class must match declaration container or be in its inheritance chain
          if (!validContainers.has(ownerClass) &&
              !Array.from(validContainers).some((c) => isInheritanceChain(ownerClass, c, isAGraph))) {
            continue;
          }
        }
        // Skip the normal container scope check — sorted key uses cross-class resolution
      }

      // For container-scoped kinds, verify enclosing scope matches any valid container
      else if (isContainerScoped && symContainer && !skipContainerScopeCheck) {
        const enclosing = resolveEnclosingScopeFromNode(node, symKind);
        if (enclosing && !validContainers.has(enclosing)) {
          // Check expanded matches: standalone SM, reuse bindings, inheritance
          const isStandaloneSm = symKind === "statemachine" &&
            Array.from(validContainers).some((c) => enclosing.endsWith(`.${c}`));
          const isReusedSm = (symKind === "state" || symKind === "statemachine") &&
            smReuseBindings &&
            Array.from(validContainers).some((c) => smReuseBindings.get(enclosing) === c);
          if (!isStandaloneSm && !isReusedSm) {
            if (symKind === "state" || symKind === "statemachine") {
              continue;
            }
            if (!isInheritanceChain(enclosing, symContainer, isAGraph)) {
              continue;
            }
          }
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

      // For trait_sm_binding param paths (deep: sm.s0.s0.s11 as state11)
      const paramSegIdx = getTraitSmBindingParamSegmentIndex(node);
      if (paramSegIdx !== undefined) {
        if (paramSegIdx === 0 && symKind !== "statemachine") continue;
        if (paramSegIdx > 0 && symKind !== "state") continue;
        if (symKind === "state" && sym.statePath &&
            paramSegIdx !== sym.statePath.length) continue;
      }

      // For trait_sm_operation paths, filter by segment position and trait scope.
      // getTraitSmOpSegmentInfo() returns undefined for excluded segments (events,
      // guard content, "as newName") — those are silently skipped.
      const traitSmOp = getTraitSmOpSegmentInfo(node);
      if (traitSmOp !== undefined) {
        // Kind must match segment position
        if (traitSmOp.segmentIndex === 0 && symKind !== "statemachine") continue;
        if (traitSmOp.segmentIndex > 0 && symKind !== "state") continue;
        // Trait-side container check: declaration must belong to this trait's SM
        const expectedContainer = `${traitSmOp.traitName}.${traitSmOp.pathSegments[0]}`;
        if (!validContainers.has(expectedContainer)) continue;
        // State depth check
        if (symKind === "state" && sym.statePath &&
            traitSmOp.segmentIndex !== sym.statePath.length) continue;
      } else if (
        // If getTraitSmOpSegmentInfo returned undefined but node IS inside trait_sm_operation,
        // it's an excluded segment (event, guard, "as") — skip it
        node.parent?.type === "trait_sm_operation" ||
        (node.parent?.type === "qualified_name" && node.parent?.parent?.type === "trait_sm_operation")
      ) {
        continue;
      }

      // Exclude trace entities under parse-only prefixes (add/remove/cardinality).
      // `transition` is event-backed and is handled through @reference.event.
      if (
        (node.parent?.type === "trace_entity" || node.parent?.type === "trace_entity_call") &&
        node.parent?.parent?.type === "trace_statement"
      ) {
        const ASSOC_PREFIXES = new Set(["add", "remove", "cardinality"]);
        const traceStmt = node.parent.parent;
        let isAssocPrefix = false;
        for (let i = 0; i < traceStmt.childCount; i++) {
          const child = traceStmt.child(i);
          if (!child) continue;
          if (child.type === "trace_entity" || child.type === "trace_entity_call") break;
          if (ASSOC_PREFIXES.has(child.type)) { isAssocPrefix = true; break; }
        }
        if (isAssocPrefix) continue;
      }

      // For nested states, disambiguate by path context
      if (symKind === "state" && sym.statePath && sym.statePath.length >= 1 && !traceStatePath) {
        const pathCtx = extractPathContextFromNode(node);
        if (pathCtx) {
          let preceding = pathCtx.preceding;
          if (
            node.parent?.parent?.type === "trait_sm_binding" &&
            (node.parent?.parent?.childForFieldName("value")?.id === node.parent?.id ||
             node.parent?.parent?.childForFieldName("param")?.id === node.parent?.id)
          ) {
            preceding = preceding.slice(1);
          }
          // trait_sm_operation: first segment is SM name, strip it for state path matching
          if (
            node.parent?.parent?.type === "trait_sm_operation" ||
            node.parent?.type === "trait_sm_operation"
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

function getPortConnectorSegmentInfo(
  node: SyntaxNode,
): { segments: string[]; segmentIndex: number } | undefined {
  const parent = node.parent;
  if (parent?.type !== "qualified_name") return undefined;
  if (parent.parent?.type !== "port_connector") return undefined;

  const segments: string[] = [];
  let segmentIndex = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type !== "identifier") continue;
    if (child.id === node.id) segmentIndex = segments.length;
    segments.push(child.text);
  }
  return segmentIndex >= 0 ? { segments, segmentIndex } : undefined;
}

function resolveComponentTypeFromSymbols(
  allSymbols: SymbolEntry[],
  componentName: string,
  enclosingClass: string | undefined,
  isAGraph: Map<string, string[]>,
): string | undefined {
  if (!enclosingClass) return undefined;
  const attr = findAttributeInContainerChain(
    allSymbols,
    componentName,
    enclosingClass,
    isAGraph,
    new Set(),
  );
  return normalizeTypeName(attr?.declaredType);
}

function findAttributeInContainerChain(
  allSymbols: SymbolEntry[],
  name: string,
  container: string,
  isAGraph: Map<string, string[]>,
  visited: Set<string>,
): SymbolEntry | undefined {
  if (visited.has(container)) return undefined;
  visited.add(container);

  const direct = allSymbols.filter(
    (s) => s.kind === "attribute" && s.name === name && s.container === container,
  );
  const directTypes = new Set(
    direct
      .map((s) => normalizeTypeName(s.declaredType))
      .filter((typeName): typeName is string => !!typeName),
  );
  if (directTypes.size === 1) return direct[0];
  if (directTypes.size > 1) return undefined;

  const parents = isAGraph.get(container) ?? [];
  for (const parent of parents) {
    const inherited = findAttributeInContainerChain(
      allSymbols,
      name,
      parent,
      isAGraph,
      visited,
    );
    if (inherited) return inherited;
  }
  return undefined;
}

function normalizeTypeName(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined;
  const parts = typeName.split(".").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
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
    // referenced_statemachine is an SM scope only for nodes inside its body
    // (states, transitions), not for its name/definition fields.
    // Check: is the original node inside a state/transition descendant of this node?
    if (current.type === "referenced_statemachine") {
      let isInBody = false;
      let walk: SyntaxNode | null = node;
      while (walk && walk.id !== current.id) {
        if (walk.type === "state" || walk.type === "transition" || walk.type === "standalone_transition" || walk.type === "state_to_state_transition") {
          isInBody = true;
          break;
        }
        walk = walk.parent;
      }
      if (isInBody) {
        enclosingSM = current.childForFieldName("name")?.text ?? enclosingSM;
      }
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

  if (targetKind === "event") {
    return enclosingClass ?? enclosingSM;
  }

  if (!enclosingClass && targetKind === "method") {
    const parent = node.parent;
    if (parent?.type === "toplevel_code_injection") {
      const ops = parent.childrenForFieldName?.("operation") ?? [];
      if (ops.some((op: { id: number }) => op.id === node.id)) {
        const targetNode = parent.childForFieldName("target");
        if (targetNode) return targetNode.text;
      }
    }
  }

  return enclosingClass;
}

/**
 * Resolve the owner class for a sorted key from the association AST.
 * Returns the class name that owns the sorted collection, or undefined.
 */
function resolveSortedKeyOwner(node: SyntaxNode): string | undefined {
  const sortedMod = node.parent;
  if (sortedMod?.type !== "sorted_modifier") return undefined;
  const assocNode = sortedMod.parent;
  if (!assocNode) return undefined;

  // Find arrow position to determine left vs right side
  let arrowPos = -1;
  for (let i = 0; i < assocNode.childCount; i++) {
    if (assocNode.child(i).type === "arrow") {
      arrowPos = assocNode.child(i).startIndex;
      break;
    }
  }
  if (arrowPos < 0) return undefined;

  const isLeftSide = sortedMod.startIndex < arrowPos;

  if (assocNode.type === "association_inline") {
    if (isLeftSide) {
      // Left-side sorted → enclosing class
      let current: SyntaxNode | null = assocNode.parent;
      while (current) {
        if (["class_definition", "trait_definition", "interface_definition",
             "association_class_definition"].includes(current.type)) {
          return current.childForFieldName("name")?.text;
        }
        current = current.parent;
      }
    } else {
      // Right-side sorted → right_type
      return assocNode.childForFieldName("right_type")?.text;
    }
  } else if (assocNode.type === "association_member") {
    if (isLeftSide) {
      return assocNode.childForFieldName("left_type")?.text;
    } else {
      return assocNode.childForFieldName("right_type")?.text;
    }
  }
  return undefined;
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

function getTraitSmBindingParamSegmentIndex(node: SyntaxNode): number | undefined {
  const parent = node.parent;
  if (parent?.type !== "qualified_name") return undefined;
  const grandparent = parent.parent;
  if (grandparent?.type !== "trait_sm_binding") return undefined;
  if (grandparent.childForFieldName("param")?.id !== parent.id) return undefined;
  // Single-segment params don't need index-based filtering
  if (parent.namedChildCount <= 1) return undefined;
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

interface TraceStatePathInfo {
  segmentIndex: number;
  pathSegments: string[];
}

function getTraceStatePathSegmentInfo(node: SyntaxNode): TraceStatePathInfo | undefined {
  const parent = node.parent;
  if (parent?.type !== "trace_qualified_name") return undefined;
  if (parent.parent?.type !== "trace_entity") return undefined;

  const pathSegments: string[] = [];
  let segmentIndex = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type !== "identifier") continue;
    if (child.id === node.id) segmentIndex = pathSegments.length;
    pathSegments.push(child.text);
  }

  return segmentIndex >= 0 ? { segmentIndex, pathSegments } : undefined;
}

interface TraitSmOpInfo {
  segmentIndex: number;
  isEventSegment: boolean;
  traitName: string;
  pathSegments: string[];
}

/**
 * Determine if a node inside trait_sm_operation is a safe SM/state path segment.
 * Returns undefined for guard content, event segments, and "as newName" targets.
 */
function getTraitSmOpSegmentInfo(node: SyntaxNode): TraitSmOpInfo | undefined {
  const parent = node.parent;
  if (!parent) return undefined;

  let opNode: SyntaxNode;

  // Shape 1: identifier inside qualified_name under trait_sm_operation
  if (parent.type === "qualified_name" && parent.parent?.type === "trait_sm_operation") {
    opNode = parent.parent;
    const segments: string[] = [];
    let idx = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child?.type === "identifier") {
        if (child.id === node.id) idx = segments.length;
        segments.push(child.text);
      }
    }
    if (idx < 0) return undefined;

    const hasEventParams = opNode.children.some((c: SyntaxNode) => c.type === "(");
    const isLastSegment = idx === segments.length - 1;
    const isEventSegment = isLastSegment && hasEventParams;
    if (isEventSegment) return undefined; // event — excluded

    const traitName = resolveTraitNameFromOp(opNode);
    if (!traitName) return undefined;

    return { segmentIndex: idx, isEventSegment: false, traitName, pathSegments: segments };
  }

  // Shape 2: direct-child identifier of trait_sm_operation
  if (parent.type === "trait_sm_operation") {
    opNode = parent;

    // If operation has a qualified_name child, this identifier is guard content
    if (opNode.namedChildren.some((c: SyntaxNode) => c.type === "qualified_name")) {
      return undefined;
    }

    // Phase 2 unprefixed form: collect identifiers before "as"
    const identifiers: { id: number; text: string }[] = [];
    let afterAs = false;
    for (let i = 0; i < opNode.childCount; i++) {
      const child = opNode.child(i);
      if (!child) continue;
      if (child.type === "as") { afterAs = true; continue; }
      if (child.type === "identifier") {
        if (afterAs) {
          // After "as" — excluded (new name)
          if (child.id === node.id) return undefined;
          continue;
        }
        identifiers.push({ id: child.id, text: child.text });
      }
    }

    const idx = identifiers.findIndex((id) => id.id === node.id);
    if (idx < 0) return undefined;

    const segments = identifiers.map((id) => id.text);
    const hasEventParams = opNode.children.some((c: SyntaxNode) => c.type === "(");
    const isLastSegment = idx === segments.length - 1;
    if (isLastSegment && hasEventParams) return undefined; // event — excluded

    const traitName = resolveTraitNameFromOp(opNode);
    if (!traitName) return undefined;

    return { segmentIndex: idx, isEventSegment: false, traitName, pathSegments: segments };
  }

  return undefined;
}

/** Extract the trait name from trait_sm_operation's enclosing type_name. */
function resolveTraitNameFromOp(opNode: SyntaxNode): string | undefined {
  const typeName = opNode.parent; // type_name
  if (typeName?.type !== "type_name") return undefined;
  const qn = typeName.childForFieldName("name") ?? typeName.namedChild(0);
  if (qn?.type !== "qualified_name") return undefined;
  const lastId = qn.namedChild(qn.namedChildCount - 1);
  return lastId?.type === "identifier" ? lastId.text : undefined;
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
  if (!parent || (parent.type !== "qualified_name" && parent.type !== "trace_qualified_name")) return null;

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
