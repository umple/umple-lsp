/**
 * Hover content builder.
 *
 * Produces markdown hover strings from SymbolEntry data + tree access.
 * No dependency on LSP connection, documents, or SymbolIndex class.
 */

import type { SymbolEntry } from "./symbolTypes";

/** Callbacks for accessing index data without depending on SymbolIndex class. */
export interface HoverContext {
  getTree: (filePath: string) => /* Tree */ any | null;
  getIsAParents: (className: string) => string[];
}

// Module-level context set by the entry point
let ctx: HoverContext;

function findDefNode(sym: SymbolEntry): /* SyntaxNode */ any | null {
  if (sym.defLine == null || sym.defEndLine == null) return null;
  const tree = ctx.getTree(sym.file);
  if (!tree) return null;
  return tree.rootNode.descendantForPosition(
    { row: sym.defLine, column: sym.defColumn ?? 0 },
    { row: sym.defEndLine, column: sym.defEndColumn ?? 0 },
  );
}

function buildClassLikeHover(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
): string {
  const keyword = sym.kind;
  const parts: string[] = [];

  const sameNameSyms = allSymbols.filter(
    (s) => s.kind === sym.kind && s.name === sym.name,
  );
  let isAbstract = false;
  for (const s of sameNameSyms) {
    const node = findDefNode(s);
    if (
      node &&
      node.children.some((c: any) => c.type === "abstract_declaration")
    ) {
      isAbstract = true;
      break;
    }
  }

  let header = "";
  if (isAbstract) header += "abstract ";
  header += `${keyword} ${sym.name}`;
  parts.push(header);

  const parents = ctx.getIsAParents(sym.name);
  if (parents.length > 0) {
    parts.push(`isA ${parents.join(", ")}`);
  }

  if (keyword === "enum") {
    const defNode = findDefNode(sym);
    if (defNode) {
      const values: string[] = [];
      for (const child of defNode.children) {
        if (child.type === "enum_value") {
          const name = child.childForFieldName("name");
          if (name) values.push(name.text);
        }
      }
      if (values.length > 0) {
        parts.push(`{ ${values.join(", ")} }`);
      }
    }
  }

  return "```umple\n" + parts.join("\n") + "\n```";
}

function buildAttributeHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const parts: string[] = [];

  const modifier = defNode.children.find(
    (c: any) => c.type === "attribute_modifier",
  );
  if (modifier) parts.push(modifier.text);

  const typeNode = defNode.childForFieldName("type");
  if (typeNode) {
    parts.push(typeNode.text);
  } else if (!modifier || modifier.text !== "autounique") {
    parts.push("String");
  }

  parts.push(sym.name);

  let extra = "";
  if (sym.container) {
    extra = `\n\n*in class ${sym.container}*`;
  }

  return "```umple\n" + parts.join(" ") + "\n```" + extra;
}

function buildPortHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const parts: string[] = [];

  const visibility = defNode.children.find((c: any) => c.type === "visibility");
  if (visibility) parts.push(visibility.text);

  const conjugated = defNode.children.find((c: any) => c.text === "conjugated");
  if (conjugated) parts.push("conjugated");

  const direction = defNode.children.find((c: any) =>
    c.text === "in" || c.text === "out" || c.text === "port"
  );
  if (direction) parts.push(direction.text);

  const typeNode = defNode.children.find((c: any) => c.type === "type_name");
  if (typeNode) parts.push(typeNode.text);

  parts.push(sym.name);

  let result = "```umple\n" + parts.join(" ") + "\n```";
  if (sym.container) {
    result += `\n\n*in class ${sym.container}*`;
  }
  return result;
}

function buildConstHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const typeNode = defNode.childForFieldName("type");
  const typeName = typeNode ? typeNode.text : "String";

  let value = "";
  let seenEquals = false;
  for (const child of defNode.children) {
    if ((child as any).type === "=" || (child as any).text === "=") {
      seenEquals = true;
      continue;
    }
    if (seenEquals && (child as any).text !== ";") {
      value = (child as any).text;
      break;
    }
  }

  let result = "```umple\nconst " + typeName + " " + sym.name;
  if (value) result += " = " + value;
  result += "\n```";

  if (sym.container) {
    result += `\n\n*in class ${sym.container}*`;
  }
  return result;
}

function buildParamString(defNode: any): string {
  const paramList = defNode.children.find((c: any) => c.type === "param_list");
  if (!paramList) return "";

  const params: string[] = [];
  for (const p of paramList.children) {
    if (p.type !== "param") continue;
    const pName = p.childForFieldName("name");
    const pType = p.children.find((c: any) => c.type === "type_name");
    if (pType && pName) {
      params.push(`${pType.text} ${pName.text}`);
    } else if (pName) {
      params.push(pName.text);
    }
  }
  return params.join(", ");
}

function buildEventHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const paramStr = buildParamString(defNode);
  let result = "```umple\n" + `${sym.name}(${paramStr})` + "\n```";
  if (sym.container) {
    result += `\n\n*event in ${sym.container}*`;
  }
  return result;
}

function methodContainerSuffix(sym: SymbolEntry): string {
  return sym.container ? `\n\n*in class ${sym.container}*` : "";
}

function buildActiveMethodHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const parts: string[] = [];

  const vis = defNode.children.find((c: any) => c.type === "visibility");
  if (vis) parts.push(vis.text);

  const returnType = defNode.childForFieldName("return_type");
  if (returnType) parts.push(returnType.text);

  const activeModifier = defNode.children.find((c: any) =>
    c.text === "atomic" || c.text === "synchronous" || c.text === "intercept"
  );
  if (activeModifier) parts.push(activeModifier.text);

  parts.push("active");

  const hasParens = defNode.children.some((c: any) => c.text === "(");
  const paramStr = buildParamString(defNode);
  parts.push(hasParens ? `${sym.name}(${paramStr})` : sym.name);

  return "```umple\n" + parts.join(" ") + "\n```" + methodContainerSuffix(sym);
}

function buildTestCaseHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const prefix = defNode.children.find((c: any) => c.type === "test_case_prefix");
  const parts: string[] = [];
  if (prefix) parts.push(prefix.text);
  parts.push("test", sym.name);
  return "```umple\n" + parts.join(" ") + "\n```" + methodContainerSuffix(sym);
}

function buildMethodHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  if (defNode.type === "active_method") {
    return buildActiveMethodHover(sym, defNode);
  }
  if (defNode.type === "test_case") {
    return buildTestCaseHover(sym, defNode);
  }

  const parts: string[] = [];

  const vis = defNode.children.find((c: any) => c.type === "visibility");
  if (vis) parts.push(vis.text);

  for (const child of defNode.children) {
    if (child.type === "static") {
      parts.push("static");
      break;
    }
  }

  const returnType = defNode.childForFieldName("return_type");
  if (returnType) {
    parts.push(returnType.text);
  } else {
    parts.push("void");
  }

  const paramStr = buildParamString(defNode);
  parts.push(`${sym.name}(${paramStr})`);

  return "```umple\n" + parts.join(" ") + "\n```" + methodContainerSuffix(sym);
}

function buildStateMachineHover(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
): string {
  const stateNames: string[] = [];
  const sameNameSyms = allSymbols.filter(
    (s) => s.kind === "statemachine" && s.name === sym.name,
  );
  for (const s of sameNameSyms) {
    const node = findDefNode(s);
    if (!node) continue;
    for (const child of node.children) {
      if (child.type === "state") {
        const name = child.childForFieldName("name");
        if (name && !stateNames.includes(name.text)) {
          stateNames.push(name.text);
        }
      }
    }
  }

  let result = "```umple\n" + sym.name + " (state machine)\n```";
  if (stateNames.length > 0) {
    result += `\n\nStates: ${stateNames.join(", ")}`;
  }

  if (sym.container) {
    result += `\n\n*in class ${sym.container}*`;
  }

  return result;
}

function collectStateInfo(defNode: any): {
  transitions: string[];
  actions: string[];
  nestedStates: string[];
} {
  const transitions: string[] = [];
  const actions: string[] = [];
  const nestedStates: string[] = [];

  for (const child of defNode.children) {
    if (child.type === "transition") {
      const event = child.childForFieldName("event");
      const target = child.childForFieldName("target");
      const guard = child.children.find((c: any) => c.type === "guard");

      let transStr = "  ";
      if (event) transStr += event.text;
      else transStr += "(auto)";
      if (guard) transStr += ` ${guard.text}`;
      if (target) transStr += ` -> ${target.text}`;
      if (!transitions.includes(transStr)) transitions.push(transStr);
    }

    if (child.type === "entry_exit_action") {
      const keyword =
        child.children.find((c: any) => c.text === "entry" || c.text === "exit")
          ?.text ?? "action";
      const line = `  ${keyword} / { ... }`;
      if (!actions.includes(line)) actions.push(line);
    }

    if (child.type === "state") {
      const name = child.childForFieldName("name");
      if (name && !nestedStates.includes(name.text)) {
        nestedStates.push(name.text);
      }
    }
  }

  return { transitions, actions, nestedStates };
}

function buildStateHover(sym: SymbolEntry, allSymbols: SymbolEntry[]): string {
  const lines: string[] = [`${sym.name} (state)`];

  const sameNameStates = allSymbols.filter(
    (s) => s.kind === "state" && s.name === sym.name,
  );
  for (const s of sameNameStates) {
    const node = findDefNode(s);
    if (!node) continue;
    const info = collectStateInfo(node);
    for (const t of info.transitions) {
      if (!lines.includes(t)) lines.push(t);
    }
    for (const a of info.actions) {
      if (!lines.includes(a)) lines.push(a);
    }
    if (info.nestedStates.length > 0) {
      const nested = `  nested: ${info.nestedStates.join(", ")}`;
      if (!lines.includes(nested)) lines.push(nested);
    }
  }

  let result = "```umple\n" + lines.join("\n") + "\n```";

  if (sym.container) {
    const smDisplay = sym.container.includes(".")
      ? sym.container.substring(sym.container.indexOf(".") + 1)
      : sym.container;
    result += `\n\n*in state machine ${smDisplay}*`;
  }

  return result;
}

function buildAssociationHover(
  sym: SymbolEntry,
  defNode: any,
): string {
  const nodeType = defNode.type;

  if (nodeType === "association_definition") {
    const members = defNode.children.filter(
      (c: any) => c.type === "association_member",
    );
    if (members.length > 0) {
      const lines: string[] = [];
      for (const member of members) {
        lines.push(member.text.trim());
      }
      let result = "```umple\nassociation";
      if (sym.name) result += ` ${sym.name}`;
      result += `\n  ${lines.join("\n  ")}\n\`\`\``;
      return result;
    }
  }

  if (nodeType === "inline_association" || nodeType === "association_inline") {
    return "```umple\n" + defNode.text.trim() + "\n```";
  }

  return "```umple\nassociation " + sym.name + "\n```";
}

/**
 * Build markdown hover content for a resolved symbol.
 *
 * @param sym        The primary resolved symbol
 * @param allSymbols Full match list (for merging split definitions)
 * @param hoverCtx   Callbacks for tree access and isA parents
 * @returns Markdown string, or null if no definition node found
 */
export function buildHoverMarkdown(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
  hoverCtx: HoverContext,
): string | null {
  ctx = hoverCtx;

  const defNode = findDefNode(sym);
  if (!defNode) return null;

  let result: string | null;
  switch (sym.kind) {
    case "class":
    case "interface":
    case "trait":
    case "enum":
      result = buildClassLikeHover(sym, allSymbols);
      break;
    case "attribute":
      result = buildAttributeHover(sym, defNode);
      break;
    case "port":
      result = buildPortHover(sym, defNode);
      break;
    case "const":
      result = buildConstHover(sym, defNode);
      break;
    case "method":
      result = buildMethodHover(sym, defNode);
      break;
    case "event":
      result = buildEventHover(sym, defNode);
      break;
    case "statemachine":
      result = buildStateMachineHover(sym, allSymbols);
      break;
    case "state":
      result = buildStateHover(sym, allSymbols);
      break;
    case "association":
      result = buildAssociationHover(sym, defNode);
      break;
    case "enum_value": {
      result = "```umple\n" + sym.name + "\n```";
      if (sym.container) {
        result += `\n\n*in enum ${sym.container}*`;
      }
      break;
    }
    case "mixset":
      result = "```umple\nmixset " + sym.name + "\n```";
      break;
    case "requirement": {
      const header = sym.reqLanguage
        ? `req ${sym.name} ${sym.reqLanguage}`
        : `req ${sym.name}`;
      result = "```umple\n" + header + "\n```";
      const details: string[] = [];
      if (sym.reqWho)  details.push(`**Who:** ${sym.reqWho}`);
      if (sym.reqWhen) details.push(`**When:** ${sym.reqWhen}`);
      if (sym.reqWhat) details.push(`**What:** ${sym.reqWhat}`);
      if (sym.reqWhy)  details.push(`**Why:** ${sym.reqWhy}`);
      if (details.length > 0) result += "\n\n" + details.join("  \n");
      break;
    }
    case "use_case_step": {
      const kindLabel = sym.reqStepKind === "systemResponse"
        ? "systemResponse"
        : "userStep";
      result = "```umple\n" + `${kindLabel} ${sym.name}` + "\n```";
      if (sym.container) result += `\n\n*in req ${sym.container}*`;
      break;
    }
    case "template":
      result = "```umple\ntemplate " + sym.name + "\n```";
      break;
    default:
      result = "```umple\n" + sym.kind + " " + sym.name + "\n```";
  }

  // Append recovered-symbol note
  if (result && sym.recovered) {
    result += "\n\n---\n*⚠ This file has parse errors — symbol info may be incomplete.*";
  }

  return result;
}

/**
 * Build hover markdown for trait SM operation positions.
 * Shared between server.ts and test helpers.
 */
export function buildTraitSmOpHover(
  symbols: SymbolEntry[],
  token: { word: string; context: { type: "trait_sm_op"; traitName: string; isEventSegment: boolean; pathSegments: string[] } },
  getEventSignatures: (traitFile: string, traitName: string, smName: string, statePath?: string[]) => { name: string; label: string; statePaths: string[][] }[],
  findTraitFile: () => string | undefined,
): string | null {
  const ctx = token.context;

  if (symbols.length > 0) {
    const sym = symbols[0];
    const kind = sym.kind === "statemachine" ? "statemachine" : "state";
    const smName = ctx.pathSegments[0];
    const location = sym.kind === "statemachine"
      ? `in trait ${ctx.traitName}`
      : `in state machine ${smName} of trait ${ctx.traitName}`;
    return `\`\`\`umple\n${sym.name} (${kind})\n\`\`\`\n\n*${location}*`;
  }

  if (ctx.isEventSegment && ctx.traitName) {
    const traitFile = findTraitFile();
    if (traitFile && ctx.pathSegments.length >= 1) {
      const smName = ctx.pathSegments[0];
      const statePath = ctx.pathSegments.length > 2 ? ctx.pathSegments.slice(1, -1) : undefined;
      const events = getEventSignatures(traitFile, ctx.traitName, smName, statePath);
      const matching = events.filter((e) => e.name === token.word);
      if (matching.length > 0) {
        const evt = matching[0];
        const paths = evt.statePaths.map((p) => p.join("."));
        const stateStr = paths.length === 1
          ? `state ${paths[0]}`
          : `states ${paths.join(", ")}`;
        return `\`\`\`umple\n${evt.label}\n\`\`\`\n\n*event in ${stateStr} of trait ${ctx.traitName}.${smName}*`;
      }
    }
  }

  return null;
}
