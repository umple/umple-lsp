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
import { getSnippetsForScope, snippetEntryToItem } from "./snippets";
import * as path from "path";

/**
 * Topic 054 — emit snippet completion items for the given scope when the
 * client advertised snippet support. No-op for typed-prefix / suppress /
 * symbol-only scopes (they have no snippet entries registered).
 */
function appendSnippetsForScope(
  items: CompletionItem[],
  seen: Set<string>,
  scope: string | null,
  snippetSupport: boolean,
): void {
  if (!snippetSupport) return;
  for (const entry of getSnippetsForScope(scope)) {
    if (seen.has(entry.label)) continue;
    seen.add(entry.label);
    items.push(snippetEntryToItem(entry));
  }
}

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

// ── Curated structured req body keyword lists ──────────────────────────────
// The compiler's userStoryTags rule accepts who/when/what/why.
// useCase additionally accepts userStep / systemResponse.
// No symbols are surfaced inside req bodies — only these four/six starters.
// Tag and step inner text stays on @scope.suppress.

const USER_STORY_BODY_STARTERS: string[] = [
  "who", "when", "what", "why",
];

const USE_CASE_BODY_STARTERS: string[] = [
  "who", "when", "what", "why",
  "userStep", "systemResponse",
];

// Practical right-multiplicity starters for `<mult> -> |` and `<mult> -- |`
// inside a class-like body. Covers the overwhelming majority of Umple
// associations without promising to enumerate every legal multiplicity.
const ASSOCIATION_MULTIPLICITY_STARTERS: string[] = [
  "1",
  "*",
  "0..1",
  "1..*",
  "0..*",
];

// All seven Umple association arrow operators, mirroring the grammar rule
//   arrow: choice("--", "->", "<-", "<@>-", "-<@>", ">->", "<-<")
// Offered after the left multiplicity (`1 |`) before the arrow is committed.
const ASSOCIATION_ARROW_STARTERS: string[] = [
  "--",
  "->",
  "<-",
  "<@>-",
  "-<@>",
  ">->",
  "<-<",
];

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

// ── Symbol append helper (topic 049 phase 1) ───────────────────────────────

interface AppendSymbolsOptions {
  /** Symbol kinds to enumerate, in emit order. */
  kinds: readonly SymbolKind[];
  /** Exact-match container scope (`className` or `className.smName`). */
  container?: string;
  /** Include inherited symbols via the isA graph. Requires `container`. */
  inherited?: boolean;
}

/**
 * Append symbols of the given kinds into `items`/`seen`. Each kind is looked
 * up either globally (no `container`) or container-scoped with optional
 * inheritance. Dedup is by label against the shared `seen` set, so callers
 * can interleave this with curated keyword / built-in emission.
 *
 * Order: kinds iterated in declared order; within a kind, whatever order
 * `symbolIndex.getSymbols` returns.
 */
function appendSymbolsOfKinds(
  items: CompletionItem[],
  seen: Set<string>,
  symbolIndex: SymbolIndex,
  reachableFiles: Set<string>,
  opts: AppendSymbolsOptions,
): void {
  for (const symKind of opts.kinds) {
    const query =
      opts.container !== undefined
        ? { container: opts.container, kind: symKind, inherited: opts.inherited }
        : { kind: symKind };
    const symbols = symbolIndex
      .getSymbols(query)
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
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

// ── Symbol-only type completion helper (topic 048 phase 2) ─────────────────

interface TypeCompletionOptions {
  /** Symbol kinds to enumerate, in emit order (class before interface, etc.). */
  kinds: readonly SymbolKind[];
  /** If true, prepend BUILTIN_TYPES before symbol kinds. Default false. */
  includeBuiltins?: boolean;
  /** If true (and includeBuiltins), skip `void` — it's method-return only. */
  excludeVoid?: boolean;
}

/**
 * Assemble a symbol-only completion list: optional built-ins followed by
 * named symbols across the given kinds. A single dedup Set shares across
 * built-ins and symbols so a user-defined type that shadows a built-in name
 * (rare) doesn't appear twice.
 *
 * Used by every typed-prefix scope and by `association_type`. Preserves the
 * exact emission ordering the pre-refactor branches relied on:
 *   1. built-ins in BUILTIN_TYPES order (optionally skipping `void`)
 *   2. symbols per-kind, kinds iterated in declared order
 *   3. within each kind, whatever order `SymbolIndex.getSymbols` returns
 */
function buildTypeCompletionItems(
  symbolIndex: SymbolIndex,
  reachableFiles: Set<string>,
  opts: TypeCompletionOptions,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  if (opts.includeBuiltins) {
    for (const typ of BUILTIN_TYPES) {
      if (opts.excludeVoid && typ === "void") continue;
      if (!seen.has(typ)) {
        seen.add(typ);
        items.push({
          label: typ,
          kind: CompletionItemKind.TypeParameter,
          detail: "built-in",
        });
      }
    }
  }

  appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
    kinds: opts.kinds,
  });

  return items;
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
  snippetSupport: boolean = false,
): CompletionItem[] {
  // Top-level scope: curated keywords only, no raw lookahead or symbols.
  if (symbolKinds === "top_level") {
    const tlItems: CompletionItem[] = TOP_LEVEL_KEYWORDS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
    const tlSeen = new Set<string>(TOP_LEVEL_KEYWORDS);
    appendSnippetsForScope(tlItems, tlSeen, "top_level", snippetSupport);
    return tlItems;
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
    appendSymbolsOfKinds(cbItems, cbSeen, symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
    });
    appendSnippetsForScope(cbItems, cbSeen, "class_body", snippetSupport);
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
    appendSymbolsOfKinds(tbItems, tbSeen, symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
    });
    appendSnippetsForScope(tbItems, tbSeen, "trait_body", snippetSupport);
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
    appendSymbolsOfKinds(ibItems, ibSeen, symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
    });
    appendSnippetsForScope(ibItems, ibSeen, "interface_body", snippetSupport);
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
    appendSymbolsOfKinds(abItems, abSeen, symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
    });
    appendSnippetsForScope(abItems, abSeen, "assoc_class_body", snippetSupport);
    return abItems;
  }

  // Filter-body scope: curated filter-statement starters only.
  if (symbolKinds === "filter_body") {
    const fbItems: CompletionItem[] = FILTER_BODY_KEYWORDS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
    const fbSeen = new Set<string>(FILTER_BODY_KEYWORDS);
    appendSnippetsForScope(fbItems, fbSeen, "filter_body", snippetSupport);
    return fbItems;
  }

  // Trace entity scope: scoped attrs/methods only, no raw keywords.
  if (symbolKinds === "trace_attribute_method" && info.enclosingClass) {
    const trItems: CompletionItem[] = [];
    const trSeen = new Set<string>();
    appendSymbolsOfKinds(trItems, trSeen, symbolIndex, reachableFiles, {
      kinds: ["attribute", "method"],
      container: info.enclosingClass,
      inherited: true,
    });
    return trItems;
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
    appendSymbolsOfKinds(gItems, gSeen, symbolIndex, reachableFiles, {
      kinds: ["attribute", "method"],
      container: info.enclosingClass,
      inherited: true,
    });
    return gItems;
  }

  // Constraint scope `[...]`: own attributes only (Umple E28 — no inherited
  // attrs in constraints). Symbol-only; no raw lookahead, no operators.
  if (symbolKinds === "own_attribute" && info.enclosingClass) {
    const oaItems: CompletionItem[] = [];
    const oaSeen = new Set<string>();
    appendSymbolsOfKinds(oaItems, oaSeen, symbolIndex, reachableFiles, {
      kinds: ["attribute"],
      container: info.enclosingClass,
    });
    return oaItems;
  }

  // Sorted-key scope `sorted{...}`: attributes of the owner class with
  // inheritance. Symbol-only; no raw lookahead, no operators.
  if (symbolKinds === "sorted_attribute" && info.sortedKeyOwner) {
    const skItems: CompletionItem[] = [];
    const skSeen = new Set<string>();
    appendSymbolsOfKinds(skItems, skSeen, symbolIndex, reachableFiles, {
      kinds: ["attribute"],
      container: info.sortedKeyOwner,
      inherited: true,
    });
    return skItems;
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
        appendSymbolsOfKinds(ttItems, ttSeen, symbolIndex, reachableFiles, {
          kinds: ["state"],
          container: info.enclosingStateMachine,
        });
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
    appendSymbolsOfKinds(mbItems, mbSeen, symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
    });
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
      appendSymbolsOfKinds(smItems, smSeen, symbolIndex, reachableFiles, {
        kinds: ["state"],
        container: info.enclosingStateMachine,
      });
    }
    appendSnippetsForScope(smItems, smSeen, "statemachine_body", snippetSupport);
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
      appendSymbolsOfKinds(sbItems, sbSeen, symbolIndex, reachableFiles, {
        kinds: ["state"],
        container: info.enclosingStateMachine,
      });
    }
    appendSnippetsForScope(sbItems, sbSeen, "state_body", snippetSupport);
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
    appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
      kinds: ["method"],
      container: info.enclosingClass,
      inherited: true,
    });
    return items;
  }
  // Topic 052 item 2 — `before |` / `after |` / `before p|` / `after p|`
  // code-injection slot. Method symbols of the enclosing class with
  // inheritance, no built-ins, no LookaheadIterator keywords. Same shape
  // as trace_method but kept on a distinct scalar for semantic clarity
  // (and to leave room for `around` etc. later).
  if (symbolKinds === "code_injection_method" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
      kinds: ["method"],
      container: info.enclosingClass,
      inherited: true,
    });
    return items;
  }

  // Topic 052 item 3 — `filter { include ... }` class-target slot. Class
  // symbols only — no built-ins, no `void`, no LookaheadIterator
  // keywords. Covers blank `include |` and typed `include S|`.
  if (symbolKinds === "filter_include_target") {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
      kinds: ["class"],
    });
    return items;
  }

  // Topic 052 item 4 — method parameter-type slot. Built-ins (excluding
  // `void`) + class / interface / trait / enum. Same shape as
  // decl_type_typed_prefix but on a distinct scalar so divergence is
  // contained.
  if (symbolKinds === "param_type_typed_prefix") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
      includeBuiltins: true,
      excludeVoid: true,
    });
  }
  if (symbolKinds === "trace_state_method" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    // States from all SMs in the enclosing class — pattern C, specialized.
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
    appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
      kinds: ["method"],
      container: info.enclosingClass,
      inherited: true,
    });
    return items;
  }
  if (symbolKinds === "trace_attribute" && info.enclosingClass) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    appendSymbolsOfKinds(items, seen, symbolIndex, reachableFiles, {
      kinds: ["attribute"],
      container: info.enclosingClass,
      inherited: true,
    });
    return items;
  }

  // Structured userStory body — curated tag starters only.
  if (symbolKinds === "userstory_body") {
    const usItems: CompletionItem[] = USER_STORY_BODY_STARTERS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
    const usSeen = new Set<string>(USER_STORY_BODY_STARTERS);
    appendSnippetsForScope(usItems, usSeen, "userstory_body", snippetSupport);
    return usItems;
  }

  // Partial inline association — arrow slot after the left multiplicity
  // (e.g. `1 |`, `1 -|`, `1 <|`). Curated arrow operators only — no
  // multiplicity, no type symbols, no class-body keywords.
  if (symbolKinds === "association_arrow") {
    return ASSOCIATION_ARROW_STARTERS.map((a) => ({
      label: a,
      kind: CompletionItemKind.Operator,
      detail: "association arrow",
    }));
  }

  // Partial inline association — right-multiplicity slot after the arrow
  // (e.g. `1 -> |`). Curated multiplicities only; no class-body junk.
  if (symbolKinds === "association_multiplicity") {
    return ASSOCIATION_MULTIPLICITY_STARTERS.map((m) => ({
      label: m,
      kind: CompletionItemKind.Value,
      detail: "multiplicity",
    }));
  }

  // Partial inline association — right-type slot after the right multiplicity
  // (e.g. `1 -> * |`). Offer class symbols only, no keywords.
  if (symbolKinds === "association_type") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class"],
    });
  }

  // Typed-prefix on the right_type identifier (e.g. `1 -> * O|`). Once the
  // parser commits to a complete `association_inline` / `association_member`,
  // the (association_inline) @scope.class_interface_trait capture would add
  // raw LookaheadIterator keyword junk; this narrower scope returns just the
  // legitimate type symbols (class / interface / trait) without keywords.
  if (symbolKinds === "association_typed_prefix") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait"],
    });
  }

  // Typed-prefix on the isa_declaration type identifier (topic 047 item 1).
  // Same motivation as association_typed_prefix above: the generic
  // (isa_declaration) @scope.class_interface_trait capture pulls in raw
  // LookaheadIterator keyword junk when recovering from incomplete parses.
  // This narrower scope returns only class / interface / trait symbols.
  if (symbolKinds === "isa_typed_prefix") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait"],
    });
  }

  // Typed-prefix on attribute/const declaration type identifier (topic 047
  // item 2). Cursor sits inside a type_name under attribute_declaration or
  // const_declaration. Default class_body scope leaks 54+ LookaheadIterator
  // keywords (test, generic, class, isA, trace, ...) and surfaces zero type
  // symbols. Symbol-only early-return: built-in types + class / interface /
  // trait / enum. `void` is deliberately excluded — method-return only.
  if (symbolKinds === "decl_type_typed_prefix") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
      includeBuiltins: true,
      excludeVoid: true,
    });
  }

  // Typed-prefix on method return-type identifier (topic 047 item 3).
  // Same shape as decl_type_typed_prefix, but fires on method_declaration /
  // abstract_method_declaration / method_signature / trait_method_signature
  // and KEEPS `void`. Parameter types sit under `param` (not a method rule)
  // and are excluded by detection, so they fall through to the class_body
  // path and remain untouched by this branch.
  if (symbolKinds === "return_type_typed_prefix") {
    return buildTypeCompletionItems(symbolIndex, reachableFiles, {
      kinds: ["class", "interface", "trait", "enum"],
      includeBuiltins: true,
    });
  }

  // Structured useCase body — userStoryTags plus useCaseStep starters.
  if (symbolKinds === "usecase_body") {
    const ucItems: CompletionItem[] = USE_CASE_BODY_STARTERS.map((kw) => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
    }));
    const ucSeen = new Set<string>(USE_CASE_BODY_STARTERS);
    appendSnippetsForScope(ucItems, ucSeen, "usecase_body", snippetSupport);
    return ucItems;
  }

  // implementsReq scope — symbol-only, no keywords/operators. The req_implementation
  // grammar rule only permits `implementsReq <id>(, <id>)* ;`, so surfacing class /
  // trait / interface keywords here is wrong. Offer known requirement ids only.
  if (Array.isArray(symbolKinds) && symbolKinds.length === 1 && symbolKinds[0] === "requirement") {
    const reqItems: CompletionItem[] = [];
    const reqSeen = new Set<string>();
    const reqs = symbolIndex
      .getSymbols({ kind: "requirement" })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
    for (const sym of reqs) {
      if (!reqSeen.has(sym.name)) {
        reqSeen.add(sym.name);
        reqItems.push({
          label: sym.name,
          kind: symbolKindToCompletionKind("requirement"),
          detail: "requirement",
        });
      }
    }
    return reqItems;
  }

  // Every specialized / curated scope has early-returned above. Everything
  // else falls through to the raw-lookahead path — it is the ONLY place in
  // this builder where `info.keywords` (LookaheadIterator output) reaches
  // the user. See `buildLookaheadFallbackItems` for the contract.
  return buildLookaheadFallbackItems(info, symbolKinds, symbolIndex, reachableFiles);
}

/**
 * The raw-lookahead fallback path for `buildSemanticCompletionItems`.
 *
 * After topic 049 phase 2 this is reached only when `symbolKinds` is an
 * array (`SymbolKind[]`) — every scalar scope has its own early-return
 * branch above. This is the ONLY place in the builder where raw
 * `info.keywords` (LookaheadIterator output) is surfaced to the user, and
 * it is now array-only: no scalar scope surfaces raw lookahead anywhere.
 *
 * If you add a new scalar scope, route it via an early-return in
 * `buildSemanticCompletionItems`, not through this path.
 */
function buildLookaheadFallbackItems(
  info: CompletionInfo,
  symbolKinds: CompletionInfo["symbolKinds"],
  symbolIndex: SymbolIndex,
  reachableFiles: Set<string>,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // 1. Keywords from LookaheadIterator.
  for (const kw of info.keywords) {
    if (!seen.has(kw)) {
      seen.add(kw);
      items.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
  }

  // 2. Operators.
  for (const op of info.operators) {
    if (!seen.has(op)) {
      seen.add(op);
      items.push({ label: op, kind: CompletionItemKind.Operator });
    }
  }

  // 3. Built-in types (when in type-compatible scope).
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

  // 4. Symbol completions from index (scoped to reachable files).
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
