/**
 * Shared symbol resolution logic.
 *
 * Used by go-to-definition, hover, rename, and the semantic test harness.
 * Extracted from server.ts to ensure tests exercise the real production path.
 *
 * Phase 2: Uses the discriminated LookupContext model for primary resolution
 * and orthogonal DottedStateRef/StateDefinitionRef for post-lookup disambiguation.
 */

import * as path from "path";
import {
  SymbolIndex,
  SymbolEntry,
  SymbolKind as UmpleSymbolKind,
} from "./symbolIndex";

/** The token info returned by getTokenAtPosition, minus null. */
export type TokenResult = NonNullable<
  ReturnType<SymbolIndex["getTokenAtPosition"]>
>;

/**
 * Resolve symbol(s) at a given position. Returns the token info plus
 * matching SymbolEntry[] filtered to reachable files, or null if no
 * identifier is found at the position.
 */
export function resolveSymbolAtPosition(
  si: SymbolIndex,
  docPath: string,
  content: string,
  line: number,
  col: number,
  reachableFiles: Set<string>,
): {
  token: TokenResult;
  symbols: SymbolEntry[];
} | null {
  const token = si.getTokenAtPosition(docPath, content, line, col);
  if (!token) return null;

  // If references.scm didn't match any pattern, there's no valid target
  if (!token.kinds) return { token, symbols: [] };

  const containerKinds = new Set<string>([
    "attribute",
    "const",
    "method",
    "template",
    "state",
    "statemachine",
    "tracecase",
  ]);
  const isScoped = token.kinds.some((k) => containerKinds.has(k));
  let container: string | undefined;
  if (isScoped) {
    container = token.kinds.some((k) => k === "state" || k === "statemachine")
      ? token.enclosingStateMachine
      : token.enclosingClass;
  }

  // ── Primary lookup: switch on context type ──────────────────────────────

  let symbols: SymbolEntry[] = [];

  switch (token.context.type) {
    case "trait_sm_param": {
      // trait_sm_binding param (e.g., sm1 in isA T1<sm1 as sm.s2>).
      // The SM lives in the trait's scope, not the current class.
      const smContainer = `${token.context.traitName}.${token.word}`;
      symbols = si
        .getSymbols({
          name: token.word,
          kind: ["statemachine"],
          container: smContainer,
        })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      break;
    }

    case "trait_sm_value": {
      // trait_sm_binding value (e.g., sm.s2 in isA T1<sm1 as sm.s2>).
      // First segment = statemachine in current class, later = states in that SM.
      const { pathSegments, segmentIndex } = token.context;
      const smName = pathSegments[0];
      const smContainer = `${token.enclosingClass}.${smName}`;

      if (segmentIndex === 0) {
        symbols = si
          .getSymbols({
            name: smName,
            kind: ["statemachine"],
            container: smContainer,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      } else {
        symbols = si
          .getSymbols({
            name: token.word,
            kind: ["state"],
            container: smContainer,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));

        // Disambiguate by direct-child depth (compiler uses direct-child-per-segment)
        const precedingStatePath = pathSegments.slice(1, segmentIndex);
        if (precedingStatePath.length === 0) {
          // Direct child of SM root: require statePath.length === 1
          symbols = symbols.filter(
            (s) => !s.statePath || s.statePath.length === 1,
          );
        } else if (symbols.length > 1) {
          const resolved = si.resolveStateInPath(
            precedingStatePath,
            token.word,
            smContainer,
            reachableFiles,
          );
          if (resolved) symbols = [resolved];
        }
      }
      break;
    }

    case "referenced_sm": {
      // referenced_statemachine: "door as status" — try class-local SM first,
      // then fall back to top-level standalone statemachine.
      const className = token.enclosingClass!;
      const smContainer = `${className}.${token.word}`;
      symbols = si
        .getSymbols({
          name: token.word,
          kind: ["statemachine"],
          container: smContainer,
        })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      // Fallback: top-level standalone statemachine (container = smName itself)
      if (symbols.length === 0) {
        symbols = si
          .getSymbols({
            name: token.word,
            kind: ["statemachine"],
            container: token.word,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      }
      break;
    }

    case "toplevel_injection": {
      // toplevel_code_injection: "before { Counter } increment()"
      // Resolve operation name against the target class's own methods only.
      // The Umple compiler does not resolve inherited methods here (W1012).
      symbols = si
        .getSymbols({
          name: token.word,
          kind: ["method"],
          container: token.context.targetClass,
        })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      break;
    }

    case "default_value_qualifier":
    case "normal": {
      // Split kinds into scoped (class/SM-local) and unscoped (global).
      // Try scoped first; only fall through to unscoped if scoped finds nothing.
      // Scoped kinds never go global — preserves cross-class isolation.
      const scopedKinds = token.kinds.filter((k) => containerKinds.has(k));
      const unscopedKinds = token.kinds.filter((k) => !containerKinds.has(k));

      if (scopedKinds.length > 0 && container) {
        // Try local container first (includes inherited via isA)
        symbols = si
          .getSymbols({
            name: token.word,
            kind: scopedKinds,
            container,
            inherited: true,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));

        // Fallback: for reused SMs, try the base standalone SM container
        if (symbols.length === 0) {
          const candidates = si.getSmContainerCandidates(container);
          for (let ci = 1; ci < candidates.length && symbols.length === 0; ci++) {
            symbols = si
              .getSymbols({
                name: token.word,
                kind: scopedKinds,
                container: candidates[ci],
              })
              .filter((s) => reachableFiles.has(path.normalize(s.file)));
          }
        }
      }

      if (symbols.length === 0 && unscopedKinds.length > 0) {
        symbols = si
          .getSymbols({ name: token.word, kind: unscopedKinds })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      }
      break;
    }
  }

  // ── Post-lookup disambiguation (orthogonal to context type) ─────────────

  // Dotted state paths (e.g., EEE.Open.Inner → only Inner inside Open)
  if (
    token.dottedStateRef &&
    token.dottedStateRef.pathIndex > 0 &&
    symbols.length > 1 &&
    token.enclosingStateMachine
  ) {
    const precedingPath = token.dottedStateRef.qualifiedPath.slice(
      0,
      token.dottedStateRef.pathIndex,
    );
    const resolved = si.resolveStateInPath(
      precedingPath,
      token.word,
      token.enclosingStateMachine,
      reachableFiles,
    );
    if (resolved) {
      symbols = [resolved];
    }
  }

  // State definition sites (e.g., cursor on Inner in `Inner {}` inside EEE.Open)
  if (
    token.stateDefinitionRef &&
    token.kinds?.includes("state") &&
    symbols.length > 1
  ) {
    const defPath = token.stateDefinitionRef.definitionPath;
    const narrowed = symbols.filter(
      (s) =>
        s.kind === "state" &&
        s.statePath &&
        s.statePath.length === defPath.length &&
        s.statePath.every((seg, i) => seg === defPath[i]),
    );
    if (narrowed.length > 0) {
      symbols = narrowed;
    }
  }

  return { token, symbols };
}
