/**
 * Snippet completion definitions (topic 054).
 *
 * Every entry's `insertText` was compiler-validated against
 * `umplesync.jar -generate nothing` with the default placeholder text
 * substituted. Validation is enforced by the `snippets.compiler_validation`
 * block at the end of `packages/server/test/semantic.test.ts`.
 *
 * `scopes` lists the scope names from `CompletionInfo.symbolKinds` where
 * the snippet should appear. Snippets are only emitted in the "fresh
 * start" scopes — typed-prefix / partial-construct / suppress scopes
 * never receive snippets.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";

export interface SnippetEntry {
  /** Human-readable label shown in the completion popup. */
  label: string;
  /** Text the editor matches against the user's typed prefix. */
  filterText: string;
  /** Snippet body with LSP `${N:placeholder}` syntax. */
  insertText: string;
  /** Brief description shown next to the label. */
  detail: string;
  /** Scopes (CompletionInfo.symbolKinds string values) where this fires. */
  scopes: readonly string[];
}

/** Sort key prefix to push snippets just below curated keywords. */
const SNIPPET_SORT_PREFIX = "z9_snippet_";

const TOP_LEVEL: readonly SnippetEntry[] = [
  {
    label: "class block",
    filterText: "class",
    insertText: "class ${1:ClassName} {\n  $0\n}",
    detail: "Umple class with empty body",
    scopes: ["top_level"],
  },
  {
    label: "interface block",
    filterText: "interface",
    insertText: "interface ${1:Name} {\n  $0\n}",
    detail: "Interface with empty body",
    scopes: ["top_level"],
  },
  {
    label: "trait block",
    filterText: "trait",
    insertText: "trait ${1:Name} {\n  $0\n}",
    detail: "Trait with empty body",
    scopes: ["top_level"],
  },
  {
    label: "association block",
    filterText: "association",
    insertText:
      "association {\n  ${1:1} ${2:LeftClass} -- ${3:*} ${4:RightClass};\n  $0\n}",
    detail: "Top-level association block",
    scopes: ["top_level"],
  },
  {
    label: "statemachine (top-level)",
    filterText: "statemachine",
    insertText:
      "statemachine ${1:Name} {\n  ${2:State} {\n    $0\n  }\n}",
    detail: "Top-level state machine",
    scopes: ["top_level"],
  },
  {
    label: "filter block",
    filterText: "filter",
    insertText:
      "filter ${1:Name} {\n  include ${2:ClassName};\n  $0\n}",
    detail: "Filter block with one include",
    scopes: ["top_level"],
  },
  {
    label: "req userStory",
    filterText: "req",
    insertText:
      "req ${1:REQ1} userStory {\n  who { ${2:actor} }\n  what { ${3:goal} }\n  $0\n}",
    detail: "Requirement (userStory form)",
    scopes: ["top_level"],
  },
  {
    label: "req useCase",
    filterText: "req",
    insertText:
      "req ${1:UC1} useCase {\n  userStep ${2:1} { ${3:action} }\n  systemResponse ${4:1} { ${5:response} }\n  $0\n}",
    detail: "Requirement (useCase form)",
    scopes: ["top_level"],
  },
  {
    label: "use file",
    filterText: "use",
    insertText: "use ${1:file}.ump;",
    detail: "Import another .ump file",
    scopes: ["top_level"],
  },
];

const CLASS_LIKE: readonly SnippetEntry[] = [
  {
    label: "attribute (typed)",
    filterText: "attr",
    insertText: "${1:Integer} ${2:name};",
    detail: "Typed attribute declaration",
    scopes: ["class_body", "trait_body", "assoc_class_body"],
  },
  {
    label: "method",
    filterText: "method",
    insertText: "${1:void} ${2:methodName}() {\n  $0\n}",
    detail: "Method declaration with empty body",
    // Excludes assoc_class_body (W1007: methods invalid in association class).
    scopes: ["class_body", "trait_body"],
  },
  {
    label: "isA inheritance",
    filterText: "isa",
    insertText: "isA ${1:ParentClass};",
    detail: "Inheritance",
    scopes: ["class_body", "trait_body", "assoc_class_body"],
  },
  {
    label: "inline association",
    filterText: "assoc",
    insertText: "${1:0..1} -- ${2:*} ${3:OtherClass} ${4:items};",
    detail: "Inline bidirectional association",
    scopes: ["class_body", "trait_body", "assoc_class_body"],
  },
  {
    label: "state machine",
    filterText: "sm",
    insertText:
      "${1:status} {\n  ${2:State1} {\n    ${3:event} -> ${4:State2};\n  }\n  ${4:State2} {\n    $0\n  }\n}",
    detail: "Class-body state-machine block",
    scopes: ["class_body", "trait_body"],
  },
  {
    label: "enum attribute",
    filterText: "enum",
    insertText: "${1:Status} { ${2:Active}, ${3:Inactive} }",
    detail: "Inline enum-attribute",
    scopes: ["class_body", "trait_body", "assoc_class_body"],
  },
  {
    label: "implementsReq link",
    filterText: "implements",
    insertText: "implementsReq ${1:R1};",
    detail: "Implements requirement",
    scopes: ["class_body", "trait_body", "assoc_class_body"],
  },
  {
    label: "before method",
    filterText: "before",
    insertText: "before ${1:methodName} {\n  $0\n}",
    detail: "Code injection before a method",
    scopes: ["class_body", "trait_body"],
  },
  {
    label: "after method",
    filterText: "after",
    insertText: "after ${1:methodName} {\n  $0\n}",
    detail: "Code injection after a method",
    scopes: ["class_body", "trait_body"],
  },
];

const INTERFACE_BODY: readonly SnippetEntry[] = [
  {
    label: "const declaration",
    filterText: "const",
    insertText: "const ${1:Integer} ${2:NAME} = ${3:0};",
    detail: "Interface constant",
    scopes: ["interface_body"],
  },
  {
    label: "method signature",
    filterText: "method",
    insertText: "${1:void} ${2:methodName}();",
    detail: "Abstract method signature",
    scopes: ["interface_body"],
  },
];

const STATE_MACHINE_AND_STATE: readonly SnippetEntry[] = [
  {
    label: "state",
    filterText: "state",
    insertText: "${1:StateName} {\n  $0\n}",
    detail: "State with empty body",
    scopes: ["statemachine_body", "state_body"],
  },
  {
    label: "final state",
    filterText: "final",
    insertText: "final ${1:StateName} {\n  $0\n}",
    detail: "Final state",
    scopes: ["statemachine_body", "state_body"],
  },
  {
    label: "transition",
    filterText: "transition",
    insertText: "${1:event} -> ${2:NextState};",
    detail: "Event-triggered transition",
    scopes: ["state_body"],
  },
  {
    label: "guarded transition",
    filterText: "tg",
    insertText: "${1:event} [${2:guard}] -> ${3:NextState};",
    detail: "Guarded transition",
    scopes: ["state_body"],
  },
  {
    label: "entry activity",
    filterText: "entry",
    insertText: "entry / {\n  $0\n}",
    detail: "Entry activity",
    scopes: ["state_body"],
  },
  {
    label: "exit activity",
    filterText: "exit",
    insertText: "exit / {\n  $0\n}",
    detail: "Exit activity",
    scopes: ["state_body"],
  },
  {
    label: "do activity",
    filterText: "do",
    insertText: "do {\n  $0\n}",
    detail: "Do activity",
    scopes: ["state_body"],
  },
];

const FILTER_BODY: readonly SnippetEntry[] = [
  {
    label: "include statement",
    filterText: "include",
    insertText: "include ${1:ClassName};",
    detail: "Include a class in the filter",
    scopes: ["filter_body"],
  },
  {
    label: "includeFilter statement",
    filterText: "includeFilter",
    insertText: "includeFilter ${1:OtherFilter};",
    detail: "Include another filter",
    scopes: ["filter_body"],
  },
  {
    label: "namespace statement",
    filterText: "namespace",
    insertText: "namespace ${1:foo.bar};",
    detail: "Namespace filter",
    scopes: ["filter_body"],
  },
  {
    label: "hops block",
    filterText: "hops",
    insertText:
      "hops {\n  super ${1:1};\n  sub ${2:1};\n  association ${3:1};\n}",
    detail: "Hops block (super/sub/association bounds)",
    scopes: ["filter_body"],
  },
];

const REQ_BODY: readonly SnippetEntry[] = [
  {
    label: "who tag",
    filterText: "who",
    insertText: "who { ${1:actor} }",
    detail: "Requirement who tag",
    scopes: ["userstory_body", "usecase_body"],
  },
  {
    label: "when tag",
    filterText: "when",
    insertText: "when { ${1:condition} }",
    detail: "Requirement when tag",
    scopes: ["userstory_body", "usecase_body"],
  },
  {
    label: "what tag",
    filterText: "what",
    insertText: "what { ${1:goal} }",
    detail: "Requirement what tag",
    scopes: ["userstory_body", "usecase_body"],
  },
  {
    label: "why tag",
    filterText: "why",
    insertText: "why { ${1:reason} }",
    detail: "Requirement why tag",
    scopes: ["userstory_body", "usecase_body"],
  },
  {
    label: "userStep block",
    filterText: "userStep",
    insertText: "userStep ${1:1} { ${2:action} }",
    detail: "Numbered user step",
    scopes: ["usecase_body"],
  },
  {
    label: "systemResponse block",
    filterText: "systemResponse",
    insertText: "systemResponse ${1:1} { ${2:response} }",
    detail: "Numbered system response",
    scopes: ["usecase_body"],
  },
];

/** Flattened registry across all categories. */
export const ALL_SNIPPETS: readonly SnippetEntry[] = [
  ...TOP_LEVEL,
  ...CLASS_LIKE,
  ...INTERFACE_BODY,
  ...STATE_MACHINE_AND_STATE,
  ...FILTER_BODY,
  ...REQ_BODY,
];

/**
 * Return the snippet entries that apply to the given scope key. `scope`
 * is a string member of `CompletionInfo.symbolKinds` (when scalar) — array
 * scopes and typed-prefix / suppress scopes get an empty list.
 */
export function getSnippetsForScope(scope: string | null): readonly SnippetEntry[] {
  if (!scope) return [];
  return ALL_SNIPPETS.filter((s) => s.scopes.includes(scope));
}

/**
 * Convert a SnippetEntry into a CompletionItem. The caller decides
 * whether to emit (gated on client snippet capability).
 */
export function snippetEntryToItem(entry: SnippetEntry): CompletionItem {
  return {
    label: entry.label,
    kind: CompletionItemKind.Snippet,
    insertTextFormat: InsertTextFormat.Snippet,
    insertText: entry.insertText,
    filterText: entry.filterText,
    detail: entry.detail,
    sortText: SNIPPET_SORT_PREFIX + entry.label,
  };
}
