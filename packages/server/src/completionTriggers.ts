import type { CompletionInfo } from "./completionAnalysis";

/**
 * Completion trigger characters advertised during LSP initialize.
 *
 * Keep this list explicit and tested. These characters do not decide what the
 * server returns; they only tell clients when to ask the server again while the
 * user is typing. Space is intentionally included for Umple's structural slots
 * such as `association { 1 | }`, `1 -> |`, and `1 -> * |`.
 *
 * Deliberately do not advertise token-finishing characters such as ">" or
 * "*". In association syntax, they complete the current arrow/multiplicity
 * token; next-slot completion should wait until the separating space.
 */
export const COMPLETION_TRIGGER_CHARACTERS = [
  "/",
  ".",
  "-",
  ",",
  "<",
  "@",
  "(",
  " ",
] as const;

const WHITESPACE_TRIGGER_SCOPES = new Set<string>([
  "association_arrow",
  "association_multiplicity",
  "association_type",
  "association_typed_prefix",
  "isa_typed_prefix",
  "decl_type_typed_prefix",
  "return_type_typed_prefix",
  "param_type_typed_prefix",
  "code_injection_method",
  "filter_include_target",
  "transition_target",
  "userstory_body",
  "usecase_body",
  "own_attribute",
  "guard_attribute_method",
  "trace_attribute_method",
  "trace_state",
  "trace_method",
  "trace_state_method",
  "trace_attribute",
  "sorted_attribute",
  "trait_sm_op_sm",
  "trait_sm_op_state",
  "trait_sm_op_state_event",
  "trait_sm_op_event",
  "referenced_sm_target",
  "trait_sm_binding_target",
  "trait_sm_binding_state_target",
]);

/**
 * Space is a high-volume trigger. Only serve it for narrow, intentional slots;
 * broad body scopes such as `class_body` and `top_level` are manual-trigger
 * only to avoid noisy editor popups after ordinary prose/code spaces.
 */
export function shouldServeWhitespaceTriggeredCompletion(
  symbolKinds: CompletionInfo["symbolKinds"],
): boolean {
  if (Array.isArray(symbolKinds)) {
    return symbolKinds.length === 1 && symbolKinds[0] === "requirement";
  }
  return typeof symbolKinds === "string" && WHITESPACE_TRIGGER_SCOPES.has(symbolKinds);
}
