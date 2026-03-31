/**
 * Post-format semantic preservation check.
 *
 * Verifies that formatting did not corrupt the file's semantic content:
 * 1. Symbol set comparison: name, kind, container, statePath must be unchanged
 * 2. Directional parse-health: clean original → clean formatted required
 *
 * Only enforced when the original input is parse-clean. For broken inputs,
 * the check is skipped (recovery indexing is already degraded).
 */

import type { SymbolEntry } from "./symbolTypes";

/**
 * Compare two symbol sets for semantic equivalence.
 * Returns true if they're equivalent (ignoring line/column positions).
 */
function symbolSetsEqual(a: SymbolEntry[], b: SymbolEntry[]): boolean {
  if (a.length !== b.length) return false;

  // Build canonical key sets
  const keyOf = (s: SymbolEntry) =>
    `${s.kind}:${s.name}:${s.container ?? ""}:${s.statePath?.join(".") ?? ""}`;

  const aKeys = new Map<string, number>();
  for (const s of a) {
    const k = keyOf(s);
    aKeys.set(k, (aKeys.get(k) ?? 0) + 1);
  }

  const bKeys = new Map<string, number>();
  for (const s of b) {
    const k = keyOf(s);
    bKeys.set(k, (bKeys.get(k) ?? 0) + 1);
  }

  if (aKeys.size !== bKeys.size) return false;
  for (const [k, count] of aKeys) {
    if (bKeys.get(k) !== count) return false;
  }
  return true;
}

export interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check if formatted output preserves the semantic content of the original.
 *
 * @param originalSymbols  Symbols from the original text
 * @param formattedSymbols Symbols from the formatted text
 * @param originalClean    Whether the original tree had no errors
 * @param formattedClean   Whether the formatted tree has no errors
 */
export function checkFormatSafety(
  originalSymbols: SymbolEntry[],
  formattedSymbols: SymbolEntry[],
  originalClean: boolean,
  formattedClean: boolean,
): SafetyCheckResult {
  // Only enforce when original is parse-clean
  if (!originalClean) {
    return { safe: true };
  }

  // Parse-health: clean original must produce clean formatted
  if (!formattedClean) {
    return {
      safe: false,
      reason: "Formatting introduced parse errors into a previously clean file",
    };
  }

  // Symbol preservation: all symbols must survive formatting
  if (!symbolSetsEqual(originalSymbols, formattedSymbols)) {
    return {
      safe: false,
      reason: "Formatting changed the symbol set (symbols lost, added, or modified)",
    };
  }

  return { safe: true };
}
