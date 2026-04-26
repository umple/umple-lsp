/**
 * Completion trigger characters advertised during LSP initialize.
 *
 * Keep this list explicit and tested. These characters do not decide what the
 * server returns; they only tell clients when to ask the server again while the
 * user is typing. Space is intentionally included for Umple's structural slots
 * such as `association { 1 | }`, `1 -> |`, and `1 -> * |`.
 */
export const COMPLETION_TRIGGER_CHARACTERS = [
  "/",
  ".",
  "-",
  ">",
  "*",
  ",",
  "<",
  "@",
  "(",
  " ",
] as const;
