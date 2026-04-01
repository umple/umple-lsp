/**
 * Dedicated resolver for trait SM event goto-def.
 * Shared by server.ts and test helpers — single source of truth.
 */

import * as path from "path";
import type { SymbolIndex } from "./symbolIndex";
import type { SymbolKind } from "./tokenTypes";

export interface EventLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Resolve goto-def locations for an event segment in a trait SM operation.
 * Matches by exact signature (name + param types).
 *
 * @returns Array of event identifier locations, or empty if no match.
 */
export function resolveTraitSmEventLocations(
  si: SymbolIndex,
  traitName: string,
  smName: string,
  eventName: string,
  eventParams: string[],
  pathSegments: string[],
  reachableFiles: Set<string>,
): EventLocation[] {
  const traitSyms = si
    .getSymbols({ name: traitName, kind: ["trait"] as SymbolKind[] })
    .filter((s) => reachableFiles.has(path.normalize(s.file)));
  if (traitSyms.length === 0) return [];

  const traitFile = traitSyms[0].file;
  const statePath = pathSegments.length > 2 ? pathSegments.slice(1, -1) : undefined;
  const occurrences = si.getEventOccurrences(traitFile, traitName, smName, statePath);

  const eventLabel = `${eventName}(${eventParams.join(", ")})`;
  const matching = occurrences.filter((o) => o.label === eventLabel);

  return matching.map((o) => ({
    file: traitFile,
    line: o.line,
    column: o.column,
    endLine: o.endLine,
    endColumn: o.endColumn,
  }));
}
