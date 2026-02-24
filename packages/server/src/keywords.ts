/**
 * Built-in types for attribute/parameter declarations.
 * NOT grammar keywords — they're regular identifiers highlighted by highlights.scm.
 * LookaheadIterator won't yield them, so we offer them explicitly.
 */
export const BUILTIN_TYPES = [
  "String",
  "Integer",
  "Double",
  "Float",
  "Boolean",
  "Date",
  "Time",
  "void",
];
