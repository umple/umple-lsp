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

// ── Curated top-level construct keywords ───────────────────────────────────
// Derived from the grammar's _definition rule (grammar.js lines 66-92).
// Raw parser lookahead is NOT surfaced at this scope.

const TOP_LEVEL_KEYWORDS: string[] = [
  "namespace",
  "use",
  "generate",
  "class",
  "interface",
  "trait",
  "association",
  "associationClass",
  "enum",
  "external",
  "statemachine",
  "mixset",
  "req",
  "require",
  "isFeature",
  "filter",
  "strictness",
  "tracer",
  "suboption",
  "distributable",
  "before",
  "after",
  "around",
  "top",
  "implementsReq",
];

// ── Curated class-body construct keywords ──────────────────────────────────
// Derived from the grammar's _class_content rule (grammar.js lines 215-251).
// Raw parser lookahead is NOT surfaced at this scope.

const CLASS_BODY_KEYWORDS: string[] = [
  // Inheritance
  "isA",
  // Code injection
  "before", "after", "around",
  // Trace
  "trace", "tracecase",
  // Nested definitions
  "class", "enum", "mixset",
  // Class-level declarations
  "abstract", "singleton",
  // Attribute modifiers
  "const", "immutable", "unique", "lazy", "settable", "defaulted",
  "internal", "autounique", "sorted",
  // Key / depend
  "key", "depend",
  // Visibility
  "public", "private", "protected",
  // SM qualifiers
  "queued", "pooled",
  // Active objects / ports
  "active", "port", "emit",
  // Associations
  "symmetric", "reflexive",
  // Display
  "displayColor", "displayColour",
  // Positioning
  "position",
  // Requirements
  "implementsReq",
  // Testing
  "test", "generic",
];

// ── Curated trait-body construct keywords ───────────────────────────────────
// Derived from the grammar's _trait_content rule (grammar.js lines 313-314):
//   _trait_content = choice(_class_content, trait_method_signature, trait_definition)
// Extends CLASS_BODY_KEYWORDS with trait-specific additions.

const TRAIT_BODY_KEYWORDS: string[] = [
  ...CLASS_BODY_KEYWORDS,
  "trait",  // nested trait definitions
];

// ── Curated interface-body construct keywords ──────────────────────────────
// Derived from the grammar's interface_definition rule (grammar.js lines 281-296):
//   isa_declaration, depend_statement, method_signature, const_declaration,
//   _java_static_final_field
// Much narrower than class/trait bodies.

const INTERFACE_BODY_KEYWORDS: string[] = [
  // Inheritance
  "isA",
  // Dependencies
  "depend",
  // Constants
  "const", "constant",
  // Visibility (for method signatures)
  "public", "private", "protected",
  // Java interop modifiers (for method_signature and _java_static_final_field)
  "static", "final", "synchronized",
];

// ── Curated mixset-body construct keywords ─────────────────────────────────
// Derived from grammar's mixset_definition block form (grammar.js lines 428-451):
//   choice(_definition, _class_content, method_signature aliases,
//          transition, entry_exit_action, do_activity, state, standalone_transition,
//          display_color, "||")
// Union of top-level + class-body + state-level keyword starters.

const MIXSET_BODY_KEYWORDS: string[] = [
  // From TOP_LEVEL_KEYWORDS (valid _definition starters)
  "namespace", "use", "generate", "class", "interface", "trait",
  "association", "associationClass", "enum", "external", "statemachine",
  "mixset", "req", "require", "isFeature", "filter", "strictness",
  "tracer", "suboption", "distributable", "before", "after", "around",
  "top", "implementsReq",
  // From CLASS_BODY_KEYWORDS (valid _class_content starters, excluding duplicates)
  "isA", "trace", "tracecase", "abstract", "singleton",
  "const", "immutable", "unique", "lazy", "settable", "defaulted",
  "internal", "autounique", "sorted", "key", "depend",
  "public", "private", "protected", "queued", "pooled",
  "active", "port", "emit", "symmetric", "reflexive",
  "displayColor", "displayColour", "position",
  "test", "generic", "static", "synchronized",
  // State-level starters (entry_exit_action, do_activity)
  "entry", "exit", "do",
];

// ── Curated filter-body construct keywords ─────────────────────────────────
// Derived from grammar's filter_definition (grammar.js lines 1300-1307):
//   repeat(filter_statement) where filter_statement = filter_value | filter_combined_value
//   | filter_namespace_stmt | filter_hops

const FILTER_BODY_KEYWORDS: string[] = [
  "include",
  "includeFilter",
  "namespace",
  "hops",
];

// ── Curated statemachine-body construct keywords ───────────────────────────
// Derived from grammar's statemachine_definition (lines 554-563) and
// state_machine (lines 847-855).  Statemachine bodies accept state
// declarations, standalone transitions, mixset blocks, and trace statements.
// State/transition names are identifier-led, not keyword-led — only
// keyword-led starters are included here.

const STATEMACHINE_BODY_KEYWORDS: string[] = [
  "final",       // final state declaration prefix
  "mixset",      // nested mixset block
  "trace",       // trace statement (state_machine only)
];

// ── Curated state-body construct keywords ──────────────────────────────────
// Derived from grammar's state rule (grammar.js lines 857-879):
//   transition, entry_exit_action, do_activity, state, standalone_transition,
//   display_color, mixset_definition, method_declaration, trace_statement, ||, ;
// Only keyword-led starters are included.

const STATE_BODY_KEYWORDS: string[] = [
  // Entry/exit/do actions
  "entry", "exit", "do",
  // Nested state prefix
  "final",
  // Nested definitions
  "mixset",
  // Trace
  "trace", "tracecase",
  // Activate/deactivate (entry_exit_action forms)
  "activate", "deactivate",
  // Display
  "displayColor", "displayColour",
  // Method declaration modifiers (method_declaration is valid in state bodies)
  "public", "private", "protected",
  "static", "synchronized",
];

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

  // Top-level scope: curated keywords only, no raw lookahead or symbols.
  if (symbolKinds === "top_level") {
    return TOP_LEVEL_KEYWORDS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
  }

  // Class-body scope: curated keywords + built-in types + type symbols.
  if (symbolKinds === "class_body") {
    const cbItems: CompletionItem[] = [];
    const cbSeen = new Set<string>();
    for (const kw of CLASS_BODY_KEYWORDS) {
      cbSeen.add(kw);
      cbItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    for (const typ of BUILTIN_TYPES) {
      if (!cbSeen.has(typ)) {
        cbSeen.add(typ);
        cbItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    for (const symKind of ["class", "interface", "trait", "enum"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ kind: symKind })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!cbSeen.has(sym.name)) {
          cbSeen.add(sym.name);
          cbItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
    return cbItems;
  }

  // Trait-body scope: curated keywords + built-in types + type symbols.
  if (symbolKinds === "trait_body") {
    const tbItems: CompletionItem[] = [];
    const tbSeen = new Set<string>();
    for (const kw of TRAIT_BODY_KEYWORDS) {
      tbSeen.add(kw);
      tbItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    for (const typ of BUILTIN_TYPES) {
      if (!tbSeen.has(typ)) {
        tbSeen.add(typ);
        tbItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    for (const symKind of ["class", "interface", "trait", "enum"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ kind: symKind })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!tbSeen.has(sym.name)) {
          tbSeen.add(sym.name);
          tbItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
    return tbItems;
  }

  // Interface-body scope: curated keywords + built-in types + type symbols.
  if (symbolKinds === "interface_body") {
    const ibItems: CompletionItem[] = [];
    const ibSeen = new Set<string>();
    for (const kw of INTERFACE_BODY_KEYWORDS) {
      ibSeen.add(kw);
      ibItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    for (const typ of BUILTIN_TYPES) {
      if (!ibSeen.has(typ)) {
        ibSeen.add(typ);
        ibItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    for (const symKind of ["class", "interface", "trait", "enum"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ kind: symKind })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!ibSeen.has(sym.name)) {
          ibSeen.add(sym.name);
          ibItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
    return ibItems;
  }

  // Association-class-body scope: same as class body (shares _class_content).
  if (symbolKinds === "assoc_class_body") {
    const abItems: CompletionItem[] = [];
    const abSeen = new Set<string>();
    for (const kw of CLASS_BODY_KEYWORDS) {
      abSeen.add(kw);
      abItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    for (const typ of BUILTIN_TYPES) {
      if (!abSeen.has(typ)) {
        abSeen.add(typ);
        abItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    for (const symKind of ["class", "interface", "trait", "enum"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ kind: symKind })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!abSeen.has(sym.name)) {
          abSeen.add(sym.name);
          abItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
    return abItems;
  }

  // Filter-body scope: curated filter-statement starters only.
  if (symbolKinds === "filter_body") {
    return FILTER_BODY_KEYWORDS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
  }

  // Guard scope: scoped attrs/methods + boolean literals only, no raw keywords.
  if (symbolKinds === "guard_attribute_method" && info.enclosingClass) {
    const gItems: CompletionItem[] = [];
    const gSeen = new Set<string>();
    // Boolean literals
    for (const lit of ["true", "false"]) {
      gSeen.add(lit);
      gItems.push({ label: lit, kind: CompletionItemKind.Keyword });
    }
    // Scoped attrs + methods from enclosing class
    for (const kind of ["attribute", "method"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ container: info.enclosingClass, kind, inherited: true })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!gSeen.has(sym.name)) {
          gSeen.add(sym.name);
          gItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(kind),
            detail: kind,
          });
        }
      }
    }
    return gItems;
  }

  // Transition-target scope: state symbols only, no keywords.
  if (symbolKinds === "transition_target") {
    const ttItems: CompletionItem[] = [];
    const ttSeen = new Set<string>();
    if (info.enclosingStateMachine) {
      if (info.dottedStatePrefix) {
        const childNames = symbolIndex.getChildStateNames(
          info.dottedStatePrefix,
          info.enclosingStateMachine,
          reachableFiles,
        );
        for (const name of childNames) {
          ttItems.push({
            label: name,
            kind: symbolKindToCompletionKind("state"),
            detail: "state",
          });
        }
      } else {
        const states = symbolIndex
          .getSymbols({ kind: "state", container: info.enclosingStateMachine })
          .filter((s) => reachableFiles.has(path.normalize(s.file)));
        for (const sym of states) {
          if (!ttSeen.has(sym.name)) {
            ttSeen.add(sym.name);
            ttItems.push({
              label: sym.name,
              kind: symbolKindToCompletionKind("state"),
              detail: "state",
            });
          }
        }
      }
    }
    return ttItems;
  }

  // Mixset-body scope: curated keywords + built-in types + type symbols.
  if (symbolKinds === "mixset_body") {
    const mbItems: CompletionItem[] = [];
    const mbSeen = new Set<string>();
    for (const kw of MIXSET_BODY_KEYWORDS) {
      mbSeen.add(kw);
      mbItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    for (const typ of BUILTIN_TYPES) {
      if (!mbSeen.has(typ)) {
        mbSeen.add(typ);
        mbItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    for (const symKind of ["class", "interface", "trait", "enum"] as SymbolKind[]) {
      const symbols = symbolIndex
        .getSymbols({ kind: symKind })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of symbols) {
        if (!mbSeen.has(sym.name)) {
          mbSeen.add(sym.name);
          mbItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind(symKind),
            detail: symKind,
          });
        }
      }
    }
    return mbItems;
  }

  // Statemachine-body scope: curated keywords + state symbols from enclosing SM.
  if (symbolKinds === "statemachine_body") {
    const smItems: CompletionItem[] = [];
    const smSeen = new Set<string>();
    for (const kw of STATEMACHINE_BODY_KEYWORDS) {
      smSeen.add(kw);
      smItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    // Offer existing state names from the enclosing SM
    if (info.enclosingStateMachine) {
      const states = symbolIndex
        .getSymbols({ kind: "state", container: info.enclosingStateMachine })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of states) {
        if (!smSeen.has(sym.name)) {
          smSeen.add(sym.name);
          smItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind("state"),
            detail: "state",
          });
        }
      }
    }
    return smItems;
  }

  // State-body scope: curated keywords + state symbols + built-in types for methods.
  if (symbolKinds === "state_body") {
    const sbItems: CompletionItem[] = [];
    const sbSeen = new Set<string>();
    for (const kw of STATE_BODY_KEYWORDS) {
      sbSeen.add(kw);
      sbItems.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
    // Built-in types for method return types
    for (const typ of BUILTIN_TYPES) {
      if (!sbSeen.has(typ)) {
        sbSeen.add(typ);
        sbItems.push({ label: typ, kind: CompletionItemKind.TypeParameter, detail: "type" });
      }
    }
    // Offer state names from enclosing SM (for nested state references)
    if (info.enclosingStateMachine) {
      const states = symbolIndex
        .getSymbols({ kind: "state", container: info.enclosingStateMachine })
        .filter((s) => reachableFiles.has(path.normalize(s.file)));
      for (const sym of states) {
        if (!sbSeen.has(sym.name)) {
          sbSeen.add(sym.name);
          sbItems.push({
            label: sym.name,
            kind: symbolKindToCompletionKind("state"),
            detail: "state",
          });
        }
      }
    }
    return sbItems;
  }

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
  if (symbolKinds === "trace_state_method" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    // States from all SMs in the enclosing class
    const states = symbolIndex
      .getSymbols({ kind: "state" })
      .filter((s) => s.container?.startsWith(info.enclosingClass + "."))
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of states) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        items.push({ label: sym.name, kind: symbolKindToCompletionKind("state"), detail: "state" });
      }
    }
    // Methods from the enclosing class
    const methods = symbolIndex
      .getSymbols({ kind: "method", container: info.enclosingClass, inherited: true })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of methods) {
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
