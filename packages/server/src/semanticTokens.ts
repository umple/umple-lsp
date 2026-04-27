import {
  SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
} from "vscode-languageserver/node";

export const UMPLE_SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "method",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "operator",
] as const;

export const UMPLE_SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "abstract",
  "defaultLibrary",
] as const;

export const UMPLE_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...UMPLE_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...UMPLE_SEMANTIC_TOKEN_MODIFIERS],
};

export type UmpleSemanticTokenType = typeof UMPLE_SEMANTIC_TOKEN_TYPES[number];
export type UmpleSemanticTokenModifier =
  typeof UMPLE_SEMANTIC_TOKEN_MODIFIERS[number];

export interface SemanticTokenNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent?: SemanticTokenNode | null;
}

export interface HighlightCapture {
  name: string;
  node: SemanticTokenNode;
}

export interface SemanticTokenEntry {
  line: number;
  character: number;
  length: number;
  tokenType: UmpleSemanticTokenType;
  tokenModifiers: UmpleSemanticTokenModifier[];
}

interface PrioritizedTokenEntry extends SemanticTokenEntry {
  priority: number;
}

const TOKEN_TYPE_INDEX = new Map(
  UMPLE_SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index]),
);
const TOKEN_MODIFIER_MASK = new Map(
  UMPLE_SEMANTIC_TOKEN_MODIFIERS.map((modifier, index) => [
    modifier,
    1 << index,
  ]),
);

export function buildSemanticTokens(
  captures: readonly HighlightCapture[],
): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  for (const token of buildSemanticTokenEntries(captures)) {
    builder.push(
      token.line,
      token.character,
      token.length,
      tokenTypeIndex(token.tokenType),
      tokenModifierMask(token.tokenModifiers),
    );
  }
  return builder.build();
}

export function buildSemanticTokenEntries(
  captures: readonly HighlightCapture[],
): SemanticTokenEntry[] {
  const exactRangeBest = new Map<string, PrioritizedTokenEntry>();

  for (const capture of captures) {
    const mapped = mapCapture(capture);
    if (!mapped) continue;

    const node = capture.node;
    const line = node.startPosition.row;
    const character = node.startPosition.column;
    const endLine = node.endPosition.row;
    const endCharacter = node.endPosition.column;
    if (line !== endLine) continue;
    const length = endCharacter - character;
    if (length <= 0) continue;
    if (node.text.includes("\n") || node.text.includes("\r")) continue;

    const entry: PrioritizedTokenEntry = {
      line,
      character,
      length,
      tokenType: mapped.tokenType,
      tokenModifiers: mapped.tokenModifiers,
      priority: mapped.priority,
    };

    const key = `${line}:${character}:${endCharacter}`;
    const existing = exactRangeBest.get(key);
    if (!existing || entry.priority > existing.priority) {
      exactRangeBest.set(key, entry);
    }
  }

  const sorted = [...exactRangeBest.values()].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.character !== b.character) return a.character - b.character;
    if (a.length !== b.length) return a.length - b.length;
    return b.priority - a.priority;
  });

  const result: SemanticTokenEntry[] = [];
  let lastLine = -1;
  let lastEnd = -1;
  for (const entry of sorted) {
    if (entry.line === lastLine && entry.character < lastEnd) continue;
    result.push(stripPriority(entry));
    lastLine = entry.line;
    lastEnd = entry.character + entry.length;
  }
  return result;
}

function mapCapture(capture: HighlightCapture): {
  tokenType: UmpleSemanticTokenType;
  tokenModifiers: UmpleSemanticTokenModifier[];
  priority: number;
} | null {
  const name = capture.name;
  const node = capture.node;

  if (name.startsWith("punctuation")) return null;

  if (name === "type.definition") {
    const type = definitionTokenType(node);
    return {
      tokenType: type,
      tokenModifiers: ["definition"],
      priority: 95,
    };
  }
  if (name === "type.builtin") {
    return {
      tokenType: "type",
      tokenModifiers: ["defaultLibrary"],
      priority: 100,
    };
  }
  if (name === "type") {
    return { tokenType: "type", tokenModifiers: [], priority: 65 };
  }

  if (name === "function.method") {
    return {
      tokenType: hasAncestor(node, "event_spec") ? "event" : "method",
      tokenModifiers: [],
      priority: 85,
    };
  }
  if (name === "function") {
    return { tokenType: "method", tokenModifiers: [], priority: 85 };
  }

  if (name === "variable.parameter") {
    return { tokenType: "parameter", tokenModifiers: [], priority: 80 };
  }
  if (name === "variable.member" || name === "property") {
    return { tokenType: "property", tokenModifiers: [], priority: 75 };
  }
  if (name === "variable") {
    return { tokenType: "variable", tokenModifiers: [], priority: 60 };
  }

  if (name === "constant") {
    if (hasAncestor(node, "enum_value")) {
      return { tokenType: "enumMember", tokenModifiers: ["readonly"], priority: 75 };
    }
    return { tokenType: "variable", tokenModifiers: ["readonly"], priority: 70 };
  }
  if (name === "constant.builtin") {
    return {
      tokenType: "variable",
      tokenModifiers: ["readonly", "defaultLibrary"],
      priority: 70,
    };
  }

  if (name === "module") {
    return { tokenType: "namespace", tokenModifiers: [], priority: 60 };
  }
  if (name === "comment") {
    return { tokenType: "comment", tokenModifiers: [], priority: 50 };
  }
  if (name === "string" || name.startsWith("string.")) {
    return { tokenType: "string", tokenModifiers: [], priority: 50 };
  }
  if (name === "number") {
    return { tokenType: "number", tokenModifiers: [], priority: 50 };
  }
  if (name === "operator" || name === "keyword.operator") {
    return { tokenType: "operator", tokenModifiers: [], priority: 55 };
  }
  if (name === "keyword.modifier") {
    return { tokenType: "modifier", tokenModifiers: [], priority: 55 };
  }
  if (name === "keyword" || name.startsWith("keyword.")) {
    return { tokenType: "keyword", tokenModifiers: [], priority: 55 };
  }
  if (name === "boolean") {
    return { tokenType: "keyword", tokenModifiers: [], priority: 55 };
  }

  return null;
}

function definitionTokenType(node: SemanticTokenNode): UmpleSemanticTokenType {
  if (hasAncestor(node, "class_definition")) return "class";
  if (hasAncestor(node, "association_class_definition")) return "class";
  if (hasAncestor(node, "external_definition")) return "class";
  if (hasAncestor(node, "interface_definition")) return "interface";
  if (hasAncestor(node, "enum_definition")) return "enum";
  return "type";
}

function hasAncestor(node: SemanticTokenNode, type: string): boolean {
  let walk = node.parent ?? null;
  while (walk) {
    if (walk.type === type) return true;
    walk = walk.parent ?? null;
  }
  return false;
}

function tokenTypeIndex(type: UmpleSemanticTokenType): number {
  const index = TOKEN_TYPE_INDEX.get(type);
  if (index === undefined) throw new Error(`Unknown semantic token type: ${type}`);
  return index;
}

function tokenModifierMask(modifiers: readonly UmpleSemanticTokenModifier[]): number {
  let mask = 0;
  for (const modifier of modifiers) {
    mask |= TOKEN_MODIFIER_MASK.get(modifier) ?? 0;
  }
  return mask;
}

function stripPriority(entry: PrioritizedTokenEntry): SemanticTokenEntry {
  return {
    line: entry.line,
    character: entry.character,
    length: entry.length,
    tokenType: entry.tokenType,
    tokenModifiers: entry.tokenModifiers,
  };
}
