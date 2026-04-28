import {
  InlayHint,
  InlayHintKind,
  Range,
} from "vscode-languageserver/node";

interface Point {
  row: number;
  column: number;
}

interface SyntaxNodeLike {
  type: string;
  text: string;
  id?: number;
  startPosition: Point;
  endPosition: Point;
  hasError?: boolean;
  children: SyntaxNodeLike[];
  namedChildren: SyntaxNodeLike[];
  childForFieldName(name: string): SyntaxNodeLike | null;
}

interface TreeLike {
  rootNode: SyntaxNodeLike;
}

export function buildInlayHints(
  tree: TreeLike | null,
  range?: Range,
): InlayHint[] {
  if (!tree || tree.rootNode.hasError) return [];

  const hints: InlayHint[] = [];
  walk(tree.rootNode, (node) => {
    if (node.type !== "attribute_declaration") return;

    const hint = buildAttributeTypeHint(node);
    if (hint && positionInRange(hint.position, range)) {
      hints.push(hint);
    }
  });

  return hints;
}

function buildAttributeTypeHint(node: SyntaxNodeLike): InlayHint | null {
  if (node.childForFieldName("type")) return null;

  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const inferredType = inferAttributeType(node);
  if (!inferredType) return null;

  return {
    position: {
      line: nameNode.endPosition.row,
      character: nameNode.endPosition.column,
    },
    label: `: ${inferredType}`,
    kind: InlayHintKind.Type,
    tooltip: "Inferred Umple attribute type. This hint does not edit the model.",
    paddingRight: true,
  };
}

function inferAttributeType(node: SyntaxNodeLike): string | null {
  if (hasModifier(node, "autounique")) {
    return "Integer";
  }

  const equals = node.children.find((child) => child.text === "=");
  if (!equals) {
    return "String";
  }

  const valueNode = node.namedChildren.find((child) =>
    startsAtOrAfter(child.startPosition, equals.endPosition) &&
    child.type !== "more_code"
  );
  if (!valueNode) return null;

  switch (valueNode.type) {
    case "string_literal":
    case "string_concat":
      return "String";
    case "boolean":
      return "Boolean";
    case "number":
      return inferNumberType(valueNode.text);
    default:
      return null;
  }
}

function inferNumberType(text: string): string | null {
  if (/^-?\d+$/.test(text)) return "Integer";
  if (/^-?\d+\.\d+$/.test(text)) return "Double";
  return null;
}

function hasModifier(node: SyntaxNodeLike, modifier: string): boolean {
  return node.children.some(
    (child) => child.type === "attribute_modifier" && child.text === modifier,
  );
}

function walk(node: SyntaxNodeLike, visit: (node: SyntaxNodeLike) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function startsAtOrAfter(point: Point, boundary: Point): boolean {
  return (
    point.row > boundary.row ||
    (point.row === boundary.row && point.column >= boundary.column)
  );
}

function positionInRange(
  position: { line: number; character: number },
  range?: Range,
): boolean {
  if (!range) return true;
  if (
    position.line < range.start.line ||
    (position.line === range.start.line &&
      position.character < range.start.character)
  ) {
    return false;
  }
  if (
    position.line > range.end.line ||
    (position.line === range.end.line &&
      position.character > range.end.character)
  ) {
    return false;
  }
  return true;
}
