/**
 * Shared pure tree-walking utilities.
 *
 * Used by tokenAnalysis, symbolIndex (indexing + completion), and tests.
 * No dependency on SymbolIndex class or any index state.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;

/**
 * Walk tree ancestors to find the enclosing class and state machine at a position.
 *
 * For state machines: keeps overwriting to find the ROOT (outermost) SM.
 * For class: stops at first (innermost).
 * SM name is qualified with class name: "ClassName.smName".
 */
export function resolveEnclosingScope(
  tree: Tree,
  line: number,
  column: number,
): { enclosingClass?: string; enclosingStateMachine?: string } {
  let node: SyntaxNode | null = tree.rootNode.descendantForPosition({
    row: line,
    column,
  });
  let enclosingClass: string | undefined;
  let enclosingStateMachine: string | undefined;

  while (node) {
    if (node.type === "state_machine" || node.type === "referenced_statemachine") {
      enclosingStateMachine =
        node.childForFieldName("name")?.text ?? enclosingStateMachine;
    }
    if (node.type === "statemachine_definition") {
      enclosingStateMachine =
        node.childForFieldName("name")?.text ?? enclosingStateMachine;
    }
    if (
      !enclosingClass &&
      [
        "class_definition",
        "trait_definition",
        "interface_definition",
        "association_class_definition",
      ].includes(node.type)
    ) {
      enclosingClass = node.childForFieldName("name")?.text;
    }
    node = node.parent;
  }

  if (enclosingStateMachine && enclosingClass) {
    enclosingStateMachine = `${enclosingClass}.${enclosingStateMachine}`;
  }

  return { enclosingClass, enclosingStateMachine };
}

/**
 * Walk state ancestors to build the full path from SM root to the given state name node.
 * E.g., for `Inner` inside `Open` inside `EEE`, returns `["EEE", "Open", "Inner"]`.
 */
export function resolveStatePath(nameNode: SyntaxNode): string[] {
  const segments: string[] = [nameNode.text];
  let current = nameNode.parent; // The state node itself
  if (current) current = current.parent; // Go above it

  while (current) {
    if (current.type === "state") {
      const name = current.childForFieldName("name");
      if (name) segments.unshift(name.text);
    }
    if (
      current.type === "state_machine" ||
      current.type === "statemachine_definition" ||
      current.type === "referenced_statemachine"
    ) {
      break;
    }
    current = current.parent;
  }
  return segments;
}

/**
 * Strip a leading state-machine name from a dotted path if it matches
 * the bare SM name of the container. E.g., path ["bulb","EEE"] with
 * container "TrafficLight.bulb" → ["EEE"].
 */
export function stripSmPrefix(pathSegments: string[], smContainer: string): string[] {
  const dotIdx = smContainer.lastIndexOf(".");
  const bareSmName =
    dotIdx >= 0 ? smContainer.substring(dotIdx + 1) : smContainer;
  if (pathSegments[0] === bareSmName) {
    return pathSegments.slice(1);
  }
  return pathSegments;
}
