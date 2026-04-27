import {
  Position,
  Range,
  SymbolInformation,
} from "vscode-languageserver/node";
import { pathToFileURL } from "url";
import type { SymbolEntry } from "./symbolTypes";
import type { SymbolKind as UmpleSymbolKind } from "./tokenTypes";
import { umpleKindToLspSymbolKind } from "./symbolPresentation";

const WORKSPACE_SYMBOL_KINDS: ReadonlySet<UmpleSymbolKind> = new Set([
  "class",
  "interface",
  "trait",
  "enum",
  "mixset",
  "statemachine",
  "state",
  "method",
  "requirement",
]);

export function buildWorkspaceSymbols(
  symbols: readonly SymbolEntry[],
  query: string,
): SymbolInformation[] {
  const normalizedQuery = query.trim().toLowerCase();

  return symbols
    .filter((symbol) => WORKSPACE_SYMBOL_KINDS.has(symbol.kind))
    .filter((symbol) => matchesWorkspaceSymbolQuery(symbol, normalizedQuery))
    .sort((a, b) => compareWorkspaceSymbols(a, b, normalizedQuery))
    .map(symbolToInformation);
}

function matchesWorkspaceSymbolQuery(
  symbol: SymbolEntry,
  query: string,
): boolean {
  if (query.length === 0) return true;
  return searchableText(symbol).some((text) => text.includes(query));
}

function searchableText(symbol: SymbolEntry): string[] {
  const parts = new Set<string>([
    symbol.name.toLowerCase(),
    workspaceSymbolName(symbol).toLowerCase(),
  ]);
  const container = displayContainerName(symbol);
  if (container) {
    parts.add(container.toLowerCase());
    parts.add(`${container}.${symbol.name}`.toLowerCase());
  }
  if (symbol.kind === "state" && symbol.statePath && symbol.container) {
    parts.add(`${symbol.container}.${symbol.statePath.join(".")}`.toLowerCase());
  }
  return [...parts];
}

function compareWorkspaceSymbols(
  a: SymbolEntry,
  b: SymbolEntry,
  query: string,
): number {
  const scoreDiff = workspaceSymbolScore(a, query) - workspaceSymbolScore(b, query);
  if (scoreDiff !== 0) return scoreDiff;

  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;

  const kindDiff = a.kind.localeCompare(b.kind);
  if (kindDiff !== 0) return kindDiff;

  const containerDiff = (displayContainerName(a) ?? "").localeCompare(
    displayContainerName(b) ?? "",
  );
  if (containerDiff !== 0) return containerDiff;

  const fileDiff = a.file.localeCompare(b.file);
  if (fileDiff !== 0) return fileDiff;

  return a.line - b.line || a.column - b.column;
}

function workspaceSymbolScore(symbol: SymbolEntry, query: string): number {
  if (query.length === 0) return 0;
  const texts = searchableText(symbol);
  if (texts.some((text) => text === query)) return 0;
  if (texts.some((text) => text.startsWith(query))) return 1;
  return 2;
}

function symbolToInformation(symbol: SymbolEntry): SymbolInformation {
  return SymbolInformation.create(
    workspaceSymbolName(symbol),
    umpleKindToLspSymbolKind(symbol.kind),
    Range.create(
      Position.create(symbol.line, symbol.column),
      Position.create(symbol.endLine, symbol.endColumn),
    ),
    pathToFileURL(symbol.file).toString(),
  );
}

function workspaceSymbolName(symbol: SymbolEntry): string {
  if (!symbol.container || symbol.container === symbol.name) return symbol.name;
  if (symbol.kind === "statemachine" && symbol.container.endsWith(`.${symbol.name}`)) {
    return symbol.container;
  }
  if (symbol.kind === "state" && symbol.statePath && symbol.container) {
    return `${symbol.container}.${symbol.statePath.join(".")}`;
  }
  return `${symbol.container}.${symbol.name}`;
}

function displayContainerName(symbol: SymbolEntry): string | undefined {
  if (!symbol.container || symbol.container === symbol.name) return undefined;
  if (
    symbol.kind === "state" &&
    symbol.statePath &&
    symbol.statePath.length > 1
  ) {
    return `${symbol.container}.${symbol.statePath.slice(0, -1).join(".")}`;
  }
  return symbol.container;
}
