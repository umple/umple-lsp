/**
 * Shared symbol index data types.
 *
 * Lives in a neutral module to avoid dependency cycles between
 * symbolIndex, referenceSearch, resolver, and tests.
 */

import type { SymbolKind } from "./tokenTypes";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 0-indexed, name identifier position
  column: number; // 0-indexed
  endLine: number;
  endColumn: number;
  container?: string; // Enclosing class (for attributes/methods) or root SM (for states)
  // Definition node range (full body extent, e.g., class_definition start to closing })
  defLine?: number;
  defColumn?: number;
  defEndLine?: number;
  defEndColumn?: number;
  // For states: nesting path from root SM, e.g., ["EEE", "Open", "Inner"]
  statePath?: string[];
  // True if extracted from a tree with parse errors (cold-open recovery)
  recovered?: boolean;
  // Explicit declaration type for typed declarations such as attributes and ports.
  declaredType?: string;
  // Structured requirement metadata (populated on kind="requirement" entries).
  // Compiler normalizes userstory → userStory and usecase → useCase; we do the
  // same in the indexer so queries can match the canonical form.
  reqLanguage?: string;
  reqWho?: string;
  reqWhen?: string;
  reqWhat?: string;
  reqWhy?: string;
  // Structured use-case step metadata (populated on kind="use_case_step" entries).
  reqStepKind?: "userStep" | "systemResponse";
  reqStepId?: string;
}

export interface UseStatementWithPosition {
  path: string; // Original path from use statement (e.g., "Teacher" or "Teacher.ump")
  line: number; // 0-indexed line number
}

/** Reference location returned by findReferences / searchReferences. */
export interface ReferenceLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
