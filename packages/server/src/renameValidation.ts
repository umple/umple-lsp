/**
 * Rename validation — kind-aware name rules.
 *
 * Most Umple symbols use the standard identifier pattern, but requirement ids
 * follow a broader rule (digit-leading, hyphens allowed) to match the
 * compiler grammar's `reqIdentifier` token. Lives in its own module so both
 * the LSP server and the semantic test harness can share the rules.
 */

import type { SymbolKind } from "./tokenTypes";

export const RENAMEABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "class",
  "interface",
  "trait",
  "enum",
  "mixset",
  "attribute",
  "const",
  "state",
  "statemachine",
  "tracecase",
  "requirement",
]);

/** Standard Umple identifier: `[a-zA-Z_][a-zA-Z0-9_]*`. */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Requirement id pattern, mirrors grammar.js `req_id`:
 *   [a-zA-Z0-9][a-zA-Z0-9_-]*
 * Accepts normal ids (`R01`), digit-leading ids (`001dealing`), and
 * hyphenated ids (`L01-LicenseTypes`). Leading/trailing hyphens rejected.
 */
const REQ_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** True iff `kind` can be renamed through the LSP rename pipeline. */
export function isRenameableKind(kind: SymbolKind): boolean {
  return RENAMEABLE_KINDS.has(kind);
}

/**
 * Validate a new name for a rename target.
 * - `requirement` uses the req-id rule (digit start + hyphens allowed).
 * - Everything else uses the standard identifier rule.
 */
export function isValidNewName(kind: SymbolKind, newName: string): boolean {
  if (kind === "requirement") return REQ_ID_RE.test(newName);
  return IDENTIFIER_RE.test(newName);
}
