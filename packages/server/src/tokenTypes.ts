/**
 * Shared token and symbol types.
 *
 * Lives in a neutral module to avoid dependency cycles between
 * tokenAnalysis, symbolIndex, resolver, and tests.
 */

export type SymbolKind =
  | "class"
  | "interface"
  | "trait"
  | "enum"
  | "enum_value"
  | "const"
  | "attribute"
  | "state"
  | "statemachine"
  | "method"
  | "association"
  | "mixset"
  | "requirement"
  | "template"
  | "tracecase";

/** All SymbolKind values sorted longest-first for greedy capture name parsing. */
export const SYMBOL_KINDS_LONGEST_FIRST: SymbolKind[] = (
  [
    "class",
    "interface",
    "trait",
    "enum",
    "enum_value",
    "const",
    "attribute",
    "state",
    "statemachine",
    "method",
    "association",
    "mixset",
    "requirement",
    "template",
    "tracecase",
  ] as SymbolKind[]
).sort((a, b) => b.length - a.length);

/** Primary lookup strategy — exactly one per token. */
export type LookupContext =
  | { type: "normal" }
  | { type: "trait_sm_param"; traitName: string }
  | { type: "trait_sm_value"; pathSegments: string[]; segmentIndex: number }
  | { type: "referenced_sm" }
  | { type: "toplevel_injection"; targetClass: string }
  | { type: "default_value_qualifier" }
  | { type: "sorted_key"; ownerClass: string }
  | { type: "trait_sm_op"; traitName: string; pathSegments: string[]; segmentIndex: number; isEventSegment: boolean; eventParams?: string[] };

/** Post-lookup disambiguation for dotted state references in transitions. */
export interface DottedStateRef {
  qualifiedPath: string[];
  pathIndex: number;
}

/** Post-lookup disambiguation for state definition sites. */
export interface StateDefinitionRef {
  definitionPath: string[];
}

/**
 * Strip the UmpleOnline layout tail (position metadata) that follows the
 * `//$?[End_of_model]$?` delimiter. The editor only shows the model portion;
 * returning LSP positions from the tail causes out-of-range errors in clients.
 */
const END_OF_MODEL_DELIMITER = "//$?[End_of_model]$?";
export function stripLayoutTail(text: string): string {
  const idx = text.indexOf(END_OF_MODEL_DELIMITER);
  return idx === -1 ? text : text.substring(0, idx);
}

/** Full token result from getTokenAtPosition. */
export interface TokenResult {
  word: string;
  kinds: SymbolKind[] | null;
  enclosingClass?: string;
  enclosingStateMachine?: string;
  context: LookupContext;
  dottedStateRef?: DottedStateRef;
  stateDefinitionRef?: StateDefinitionRef;
}
