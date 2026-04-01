/**
 * Shared completion-item assembly logic.
 *
 * Extracted from server.ts so both the LSP server and the test harness
 * exercise the same production code path.
 *
 * Scope: keyword filtering, operator suppression, built-in types, and
 * symbol-based completions. Does NOT handle use-path file completions,
 * trigger-character gating, or comment/definition-name suppression —
 * those stay in server.ts.
 */

import {
  CompletionItem,
  CompletionItemKind,
} from "vscode-languageserver/node";
import { SymbolIndex, SymbolEntry, SymbolKind, CompletionInfo } from "./symbolIndex";
import { BUILTIN_TYPES } from "./keywords";
import * as path from "path";

// ── Constraint keyword blocklist ────────────────────────────────────────────

const CONSTRAINT_BLOCKLIST = new Set([
  "ERROR",
  // Top-level definition keywords
  "namespace", "class", "interface", "trait", "abstract",
  "association", "associationClass", "statemachine",
  "enum", "external", "mixset",
  // Generate statement + all targets
  "generate", "Java", "Nothing", "Php", "RTCpp", "SimpleCpp",
  "Ruby", "Python", "Cpp", "Json", "StructureDiagram", "Yuml",
  "Violet", "Umlet", "Simulate", "TextUml", "Scxml",
  "GvStateDiagram", "GvClassDiagram", "GvFeatureDiagram",
  "GvClassTraitDiagram", "GvEntityRelationshipDiagram",
  "Alloy", "NuSMV", "NuSMVOptimizer", "Papyrus", "Ecore", "Xmi",
  "Xtext", "Sql", "StateTables", "EventSequence", "InstanceDiagram",
  "Umple", "UmpleSelf", "USE", "Test", "SimpleMetrics",
  "PlainRequirementsDoc", "Uigu2", "ExternalGrammar", "Mermaid",
  // Other top-level directives
  "use", "strictness",
  // Class-level keywords invalid inside constraints
  "isA", "req", "require", "subfeature", "isFeature",
  "depend", "singleton", "displayColor", "displayColour",
  "implementsReq", "filter", "includeFilter",
  // Trace/SM/attribute keywords that can't appear in expressions
  "trace", "tracecase", "activate", "deactivate",
  "onAllObjects", "onThisThreadOnly", "onThisObject",
  "where", "until", "giving", "record",
  "queued", "pooled", "as",
  "key", "immutable", "unique", "lazy", "settable",
  "internal", "defaulted", "autounique",
  "entry", "exit", "do",
  "emit", "around", "custom", "generated",
  "include", "hops", "super", "sub",
]);

// ── Kind → CompletionItemKind mapping ───────────────────────────────────────

export function symbolKindToCompletionKind(kind: SymbolKind): CompletionItemKind {
  switch (kind) {
    case "class":
      return CompletionItemKind.Class;
    case "interface":
      return CompletionItemKind.Interface;
    case "trait":
      return CompletionItemKind.Class;
    case "enum":
      return CompletionItemKind.Enum;
    case "state":
      return CompletionItemKind.EnumMember;
    case "statemachine":
      return CompletionItemKind.Enum;
    case "attribute":
      return CompletionItemKind.Field;
    case "const":
      return CompletionItemKind.Constant;
    case "method":
      return CompletionItemKind.Method;
    case "association":
      return CompletionItemKind.Reference;
    case "mixset":
      return CompletionItemKind.Module;
    case "requirement":
      return CompletionItemKind.Reference;
    case "template":
      return CompletionItemKind.Property;
    default:
      return CompletionItemKind.Text;
  }
}

// ── Main builder ────────────────────────────────────────────────────────────

/**
 * Build semantic completion items from a CompletionInfo + SymbolIndex.
 *
 * Handles: keyword filtering, operator suppression, built-in types,
 * own-attribute completion, guard/trace attribute+method completion,
 * and array-based symbol completions.
 *
 * Does NOT handle: use-path file completions, trigger-character gating,
 * dotted-state dot-trigger fast path, or comment/definition-name suppression.
 *
 * @param symbolKinds - the normalized symbolKinds (after use_path → mixset conversion).
 *   Caller should not pass "suppress", "use_path", isComment, or isDefinitionName states.
 */
export function buildSemanticCompletionItems(
  info: CompletionInfo,
  symbolKinds: CompletionInfo["symbolKinds"],
  symbolIndex: SymbolIndex,
  reachableFiles: Set<string>,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // Trait SM op contexts are symbol-only — no keywords or operators.
  // Handle them first to avoid leaking generic completions on empty results.
  if (
    symbolKinds === "trait_sm_op_sm" ||
    symbolKinds === "trait_sm_op_state" ||
    symbolKinds === "trait_sm_op_state_event" ||
    symbolKinds === "trait_sm_op_event"
  ) {
    return buildTraitSmOpItems(info, symbolKinds, symbolIndex, reachableFiles);
  }

  // Trace prefix completion — class-scoped, symbol-only, no keywords
  if (symbolKinds === "trace_state" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    // States from all SMs in the enclosing class
    const symbols = symbolIndex
      .getSymbols({ kind: "state" })
      .filter((s) => s.container?.startsWith(info.enclosingClass + "."))
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({ label: sym.name, kind: symbolKindToCompletionKind("state"), detail: "state" });
      }
    }
    return items;
  }
  if (symbolKinds === "trace_method" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const symbols = symbolIndex
      .getSymbols({ kind: "method", container: info.enclosingClass, inherited: true })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({ label: sym.name, kind: symbolKindToCompletionKind("method"), detail: "method" });
      }
    }
    return items;
  }
  if (symbolKinds === "trace_attribute" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const symbols = symbolIndex
      .getSymbols({ kind: "attribute", container: info.enclosingClass, inherited: true })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({ label: sym.name, kind: symbolKindToCompletionKind("attribute"), detail: "attribute" });
      }
    }
    return items;
  }

  // 1. Keywords from LookaheadIterator (filtered in constraint contexts)
  let keywords = info.keywords;
  if (
    symbolKinds === "own_attribute" ||
    symbolKinds === "guard_attribute_method" ||
    symbolKinds === "trace_attribute_method" ||
    symbolKinds === "sorted_attribute"
  ) {
    keywords = keywords.filter((kw) => !CONSTRAINT_BLOCKLIST.has(kw));
  }

  for (const kw of keywords) {
    if (!seen.has(kw)) {
      seen.add(kw);
      items.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
  }

  // 2. Operators (skip in guard/constraint/trace contexts)
  if (
    symbolKinds !== "own_attribute" &&
    symbolKinds !== "guard_attribute_method" &&
    symbolKinds !== "trace_attribute_method" &&
    symbolKinds !== "sorted_attribute"
  ) {
    for (const op of info.operators) {
      if (!seen.has(op)) {
        seen.add(op);
        items.push({ label: op, kind: CompletionItemKind.Operator });
      }
    }
  }

  // 3. Built-in types (when in type-compatible scope)
  if (
    Array.isArray(symbolKinds) &&
    symbolKinds.some((k) => ["class", "interface", "trait", "enum"].includes(k))
  ) {
    for (const typ of BUILTIN_TYPES) {
      if (!seen.has(typ)) {
        seen.add(typ);
        items.push({
          label: typ,
          kind: CompletionItemKind.TypeParameter,
          detail: "type",
        });
      }
    }
  }

  // 4. Constraint scope: only own attributes (Umple E28)
  if (symbolKinds === "own_attribute" && info.enclosingClass) {
    const symbols = symbolIndex
      .getSymbols({ container: info.enclosingClass, kind: "attribute" })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({
          label: sym.name,
          kind: symbolKindToCompletionKind("attribute"),
          detail: "attribute",
        });
      }
    }
    return items;
  }

  // 5. Sorted key scope: attributes of the owner class (with inheritance)
  if (symbolKinds === "sorted_attribute" && info.sortedKeyOwner) {
    const symbols = symbolIndex
      .getSymbols({ container: info.sortedKeyOwner, kind: "attribute", inherited: true })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({
          label: sym.name,
          kind: symbolKindToCompletionKind("attribute"),
          detail: "attribute",
        });
      }
    }
    return items;
  }

  // 6. Guard/trace scope: attributes + methods from enclosing class (with inheritance)
  if (
    (symbolKinds === "guard_attribute_method" ||
      symbolKinds === "trace_attribute_method") &&
    info.enclosingClass
  ) {
    for (const kind of ["attribute", "method"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ container: info.enclosingClass, kind, inherited: true })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!seen.has(sym.name)) {
          seen.add(sym.name);
          items.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(kind),
            detail: kind,
          });
        }
      }
    }
    return items;
  }

  // 6. Symbol completions from index (scoped to reachable files)
  if (Array.isArray(symbolKinds)) {
    for (const symKind of symbolKinds) {
      let symbols: SymbolEntry[];

      // Scoped lookups for container-aware kinds
      if (symKind === "attribute" && info.enclosingClass) {
        symbols = symbolIndex
          .getSymbols({
            container: info.enclosingClass,
            kind: "attribute",
            inherited: true,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      } else if (symKind === "state" && info.enclosingStateMachine) {
        if (info.dottedStatePrefix) {
          const childNames = symbolIndex.getChildStateNames(
            info.dottedStatePrefix,
            info.enclosingStateMachine,
            reachableFiles,
          );
          for (const name of childNames) {
            if (!seen.has(name)) {
              seen.add(name);
              items.push({
                label: name,
                kind: symbolKindToCompletionKind("state"),
                detail: "state",
              });
            }
          }
          continue;
        }
        symbols = symbolIndex
          .getSymbols({ container: info.enclosingStateMachine, kind: "state" })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      } else if (symKind === "statemachine" && info.enclosingClass) {
        symbols = symbolIndex
          .getSymbols({ kind: "statemachine" })
          .filter(
            (s) =>
              s.container?.startsWith(info.enclosingClass + ".") &&
              reachableFiles.has(path.normalize(s.file)),
          );
      } else if (symKind === "template" && info.enclosingClass) {
        symbols = symbolIndex
          .getSymbols({ container: info.enclosingClass, kind: "template" })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      } else if (symKind === "method" && info.enclosingClass) {
        symbols = symbolIndex
          .getSymbols({
            container: info.enclosingClass,
            kind: "method",
            inherited: true,
          })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      } else {
        symbols = symbolIndex
          .getSymbols({ kind: symKind })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
      }

      for (const sym of symbols) {
        if (!seen.has(sym.name)) {
          seen.add(sym.name);
          items.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
  }

  return items;
}

/**
 * Symbol-only completion for trait SM operations. Returns ONLY matching
 * symbols — no keywords, no operators. Empty result on bad paths.
 */
function buildTraitSmOpItems(
  info: CompletionInfo,
  symbolKinds: "trait_sm_op_sm" | "trait_sm_op_state" | "trait_sm_op_state_event" | "trait_sm_op_event",
  symbolIndex: SymbolIndex,
  reachableFiles: Set<string>,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const ctx = info.traitSmContext;
  if (!ctx) return items;

  // SM names from trait
  if (symbolKinds === "trait_sm_op_sm") {
    const symbols = symbolIndex
      .getSymbols({ kind: "statemachine" })
      .filter((s) => s.container?.startsWith(ctx.traitName + "."))
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({
          label: sym.name,
          kind: symbolKindToCompletionKind("statemachine"),
          detail: `statemachine (trait ${ctx.traitName})`,
        });
      }
    }
    return items;
  }

  if (!ctx.smName) return items;
  const smContainer = `${ctx.traitName}.${ctx.smName}`;

  // Find trait file for event extraction (filter by reachable files)
  const traitSymbols = symbolIndex
    .getSymbols({ name: ctx.traitName, kind: ["trait"] })
    .filter((s) => reachableFiles.has(path.normalize(s.file)));
  const traitFile = traitSymbols.length > 0 ? traitSymbols[0].file : undefined;

  // States: for trait_sm_op_state and trait_sm_op_state_event
  if (symbolKinds === "trait_sm_op_state" || symbolKinds === "trait_sm_op_state_event") {
    const expectedDepth = (ctx.statePath?.length ?? 0) + 1;
    const symbols = symbolIndex
      .getSymbols({ kind: "state", container: smContainer })
      .filter((s) => s.statePath && s.statePath.length === expectedDepth)
      .filter((s) => {
        if (ctx.statePath && s.statePath) {
          for (let i = 0; i < ctx.statePath.length; i++) {
            if (s.statePath[i] !== ctx.statePath[i]) return false;
          }
        }
        return true;
      })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of symbols) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({
          label: sym.name,
          kind: symbolKindToCompletionKind("state"),
          detail: `state (${smContainer})`,
        });
      }
    }
  }

  // Events: for trait_sm_op_state_event and trait_sm_op_event
  if (
    (symbolKinds === "trait_sm_op_state_event" || symbolKinds === "trait_sm_op_event") &&
    traitFile
  ) {
    const events = symbolIndex.getEventSignatures(
      traitFile,
      ctx.traitName,
      ctx.smName,
      symbolKinds === "trait_sm_op_event" ? undefined : ctx.statePath,
    );
    for (const evt of events) {
      if (!seen.has(evt.label)) {
        seen.add(evt.label);
        items.push({
          label: evt.label,
          kind: CompletionItemKind.Event,
          detail: ctx.statePath
            ? `event (in state ${ctx.statePath[ctx.statePath.length - 1]})`
            : `event (in ${ctx.smName})`,
          insertText: evt.label,
        });
      }
    }
  }

  return items;
}
