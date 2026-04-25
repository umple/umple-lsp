/**
 * Quick-fix code actions for Umple diagnostics (topics 056, 057).
 *
 * Pure logic only: takes a TextDocument + Diagnostic[] and returns the
 * CodeActions that apply. No LSP transport, no compiler invocation.
 *
 * Currently produces a single user-visible action: `Add missing semicolon`.
 * Three trigger codes, three classifiers:
 *
 *   - W1007 (class-content): isA / implementsReq / inline assoc / interface
 *     method signature / attribute declaration (incl. simple default value).
 *   - W1006 (state-machine): transition with optional guard + action body.
 *   - E1502 (filter-body): include / includeFilter / namespace statements.
 *     The diagnostic line points to the filter HEADER, so this branch
 *     scans the filter block for an unterminated single-line statement and
 *     emits the action only when EXACTLY ONE candidate is found.
 *
 * Each classifier rejects line shapes where appending `;` either doesn't
 * fix the diagnostic or introduces a new one.
 */
import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const W1007 = "W1007";
const W1006 = "W1006";
const E1502 = "E1502";
const SEMICOLON_TITLE = "Add missing semicolon";

/**
 * Build all quick-fix CodeActions that apply to the given diagnostic set.
 * Currently this is just `Add missing semicolon`.
 */
export function buildQuickFixActions(
  document: TextDocument,
  diagnostics: Diagnostic[],
): CodeAction[] {
  const actions: CodeAction[] = [];
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  for (const diag of diagnostics) {
    const action = buildSemicolonAction(document, lines, diag);
    if (action) actions.push(action);
  }

  return actions;
}

function buildSemicolonAction(
  document: TextDocument,
  lines: string[],
  diag: Diagnostic,
): CodeAction | null {
  if (diag.source !== "umple") return null;
  if (diag.message?.startsWith("In imported file")) return null;

  if (diag.code === W1007) {
    return buildLineLocalSemicolonAction(document, lines, diag, classifyW1007);
  }
  if (diag.code === W1006) {
    return buildLineLocalSemicolonAction(document, lines, diag, classifyW1006);
  }
  if (diag.code === E1502) {
    return buildFilterStatementSemicolonAction(document, lines, diag);
  }
  return null;
}

/**
 * Common shape for W1007 / W1006 actions: the diagnostic line IS the line
 * we want to edit. The classifier callback decides whether the trimmed
 * code matches a known semicolon-fix shape.
 */
function buildLineLocalSemicolonAction(
  document: TextDocument,
  lines: string[],
  diag: Diagnostic,
  classify: (code: string, lines: string[], diagLine: number) => boolean,
): CodeAction | null {
  const line = diag.range.start.line;
  if (line < 0 || line >= lines.length) return null;

  const lineText = lines[line];
  const split = splitCodeAndComment(lineText);
  const codeTrimmed = split.code.trimEnd();
  if (codeTrimmed.length === 0) return null;

  const lastChar = codeTrimmed[codeTrimmed.length - 1];
  if (lastChar === ";" || lastChar === "{" || lastChar === "}" || lastChar === ",") {
    return null;
  }

  if (!classify(codeTrimmed.trimStart(), lines, line)) return null;

  return makeAction(document, diag, line, codeTrimmed.length);
}

/**
 * E1502 (filter-body) action. Diagnostic line is the filter header, NOT
 * the bad statement line. Find the enclosing filter block, scan inside
 * for unterminated single-line statements, and emit an action only when
 * EXACTLY ONE candidate exists. Multiple candidates → no action (E1502
 * doesn't tell us which to fix).
 */
function buildFilterStatementSemicolonAction(
  document: TextDocument,
  lines: string[],
  diag: Diagnostic,
): CodeAction | null {
  const block = findEnclosingFilterBlock(lines, diag.range.start.line);
  if (!block) return null;

  // Track nested brace depth as we walk through the filter body. Only
  // statements at the top level of the filter body (depth === 0) are
  // candidates for the semicolon fix. A nested `hops { include C }`
  // doesn't help E1502 even if `include C;` looks like a valid
  // filter-statement shape — the compiler diagnostic is still raised.
  const candidates: { line: number; insertCol: number }[] = [];
  let depth = 0;
  for (let i = block.bodyStart; i <= block.bodyEnd; i++) {
    const lineText = lines[i] ?? "";
    const split = splitCodeAndComment(lineText);
    const codeTrimmed = split.code.trimEnd();

    // Compute depth-at-start-of-line *before* updating from this line's
    // braces, so a candidate on a line that opens a nested block still
    // counts as filter-top-level if the depth was 0 going in.
    const depthAtLineStart = depth;
    for (let j = 0; j < split.code.length; j++) {
      const c = split.code[j];
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
    }

    if (codeTrimmed.length === 0) continue;
    if (depthAtLineStart !== 0) continue;

    const lastChar = codeTrimmed[codeTrimmed.length - 1];
    if (lastChar === ";" || lastChar === "{" || lastChar === "}" || lastChar === ",") {
      continue;
    }
    if (!looksLikeFilterStatement(codeTrimmed.trimStart())) continue;

    candidates.push({ line: i, insertCol: codeTrimmed.length });
  }

  if (candidates.length !== 1) return null;
  const c = candidates[0];
  return makeAction(document, diag, c.line, c.insertCol);
}

function makeAction(
  document: TextDocument,
  diag: Diagnostic,
  line: number,
  character: number,
): CodeAction {
  const edit: TextEdit = TextEdit.insert({ line, character }, ";");
  const workspaceEdit: WorkspaceEdit = { changes: { [document.uri]: [edit] } };
  return {
    title: SEMICOLON_TITLE,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: workspaceEdit,
  };
}

// ── W1007 classifier (class-content) ───────────────────────────────────────

function classifyW1007(
  code: string,
  lines: string[],
  diagLine: number,
): boolean {
  if (looksLikeIsAList(code)) return true;
  if (looksLikeImplementsReqList(code)) return true;
  if (looksLikeInlineAssociation(code)) return true;
  if (looksLikeMethodSignature(code) && isInsideInterfaceBody(lines, diagLine)) return true;
  if (looksLikeAttributeDeclaration(code)) return true;
  return false;
}

const ID = "[A-Za-z_][A-Za-z_0-9]*";
const ID_LIST = `${ID}(\\s*,\\s*${ID})*`;

function looksLikeIsAList(code: string): boolean {
  return new RegExp(`^isA\\s+${ID_LIST}$`).test(code);
}

function looksLikeImplementsReqList(code: string): boolean {
  return new RegExp(`^implementsReq\\s+${ID_LIST}$`).test(code);
}

const ARROW = /(<@>-|-<@>|>->|<-<|->|<-|--)/;
const ASSOC_REJECT_CHARS = /[+=&|!?:;{}()\[\]]/;
const MULTIPLICITY = /(?:^|\s)(?:\*|\d+(?:\.\.(?:\*|\d+))?)(?:\s|$)/;

function looksLikeInlineAssociation(code: string): boolean {
  if (!ARROW.test(code)) return false;
  if (ASSOC_REJECT_CHARS.test(code)) return false;
  if (!MULTIPLICITY.test(code)) return false;
  const trimmed = code.trim();
  if (!/[A-Za-z_]\w*$/.test(trimmed)) return false;
  return true;
}

function looksLikeMethodSignature(code: string): boolean {
  return new RegExp(
    `^(${ID}(\\s*<[\\w\\s,<>]+>)?\\s+)?${ID}\\s*\\([^)]*\\)\\s*$`,
  ).test(code);
}

const STRUCTURAL_FIRST_TOKENS = new Set([
  "class",
  "interface",
  "trait",
  "associationClass",
  "enum",
  "state",
  "statemachine",
  "stateMachine",
  "filter",
  "req",
  "mixset",
  "namespace",
  "use",
]);

function looksLikeAttributeDeclaration(code: string): boolean {
  const first = code.split(/\s+/, 1)[0];
  if (STRUCTURAL_FIRST_TOKENS.has(first)) return false;
  // Path 1 (topic 056): two or more whitespace-separated bare identifiers.
  if (new RegExp(`^${ID}(\\s+${ID})+$`).test(code)) return true;
  // Path 2 (topic 057 item 3): default-value attribute. `<type> <name> =
  // <literal>` where literal is number, single-token quoted string, true,
  // false, or another bare identifier. Reject expression operators on RHS.
  return looksLikeDefaultValueAttribute(code);
}

const NUMBER_LITERAL = `-?\\d+(?:\\.\\d+)?`;
// Conservative quoted string: opening quote, no-quote chars (no escapes),
// closing quote. Allows spaces inside: `"Bob Smith"`. Backslash escapes
// not supported — documented as a false negative.
const STRING_LITERAL = `"[^"\\\\]*"`;
const RHS_VALUE = `(?:${NUMBER_LITERAL}|${STRING_LITERAL}|true|false|${ID})`;

function looksLikeDefaultValueAttribute(code: string): boolean {
  // `<type> <name> = <value>` — two id tokens before `=`, then a value.
  // Type-with-generics (`List<String>`) deliberately rejected (compiler
  // post-fix behavior introduces W46 — not a clean win).
  return new RegExp(`^${ID}\\s+${ID}\\s*=\\s*${RHS_VALUE}\\s*$`).test(code);
}

// ── W1006 classifier (state-machine transitions) ──────────────────────────

function classifyW1006(
  code: string,
  _lines: string[],
  _diagLine: number,
): boolean {
  return looksLikeStateTransition(code);
}

/**
 * Match `<event> ([guard])? (/ { action-body })? -> <state>(.<state>)*`.
 *
 * - `<event>` is an identifier.
 * - `[guard]` is bracketed content (no nested `]`).
 * - `/{action}` is balanced single-level braces (no nested `{`).
 * - RHS is an identifier or dotted state path.
 *
 * Nested braces inside the action body are deliberately rejected — the
 * single-line classifier wouldn't see them anyway since multi-line action
 * bodies span multiple diagnostic lines and the W1006 line targeting
 * already points at the transition header line.
 */
function looksLikeStateTransition(code: string): boolean {
  return new RegExp(
    `^${ID}` +
      `(?:\\s*\\[[^\\]]*\\])?` + // optional [guard]
      `(?:\\s*/\\s*\\{[^{}]*\\})?` + // optional /{action}
      `\\s*->\\s*${ID}(?:\\.${ID})*\\s*$`,
  ).test(code);
}

// ── E1502 classifier (filter-body statements) ─────────────────────────────

const FILTER_STATEMENT_FIRST_TOKENS = new Set([
  "include",
  "includeFilter",
  "namespace",
]);

/**
 * Match exactly one of:
 *   include <id>(.<id>)*
 *   includeFilter <id>(.<id>)*
 *   namespace <id>(.<id>)*
 *
 * Reject anything else under E1502 — the code is broad and covers many
 * filter parse errors that `;` doesn't fix.
 */
function looksLikeFilterStatement(code: string): boolean {
  const first = code.split(/\s+/, 1)[0];
  if (!FILTER_STATEMENT_FIRST_TOKENS.has(first)) return false;
  return new RegExp(
    `^(?:include|includeFilter|namespace)\\s+${ID}(?:\\s*\\.\\s*${ID})*\\s*$`,
  ).test(code);
}

/**
 * Find the `filter <name> { ... }` block that contains (or starts at) the
 * given hint line. Returns inclusive body-line bounds, or null if no
 * single filter block can be unambiguously identified.
 */
function findEnclosingFilterBlock(
  lines: string[],
  hintLine: number,
): { headerLine: number; bodyStart: number; bodyEnd: number } | null {
  // Locate a filter header at or before the hint line whose `{` opens a
  // block that covers (or comes immediately after) the hint.
  // Walk forward from the start of the hint line, but anchor on the most
  // recent `filter <id> {` header at or before it.
  let headerLine = -1;
  let openCol = -1;
  for (let i = Math.min(hintLine, lines.length - 1); i >= 0; i--) {
    const lineText = lines[i] ?? "";
    const noComment = splitCodeAndComment(lineText).code;
    const m = noComment.match(/\bfilter\s+[A-Za-z_]\w*\s*\{/);
    if (m && m.index !== undefined) {
      headerLine = i;
      openCol = m.index + m[0].length - 1;
      break;
    }
  }
  if (headerLine === -1) return null;

  // Now walk forward from the `{` counting braces to find the matching `}`.
  let depth = 0;
  let bodyEnd = -1;
  for (let i = headerLine; i < lines.length; i++) {
    const lineText = lines[i] ?? "";
    const noComment = splitCodeAndComment(lineText).code;
    const startCol = i === headerLine ? openCol : 0;
    for (let j = startCol; j < noComment.length; j++) {
      const c = noComment[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    if (bodyEnd !== -1) break;
  }
  if (bodyEnd === -1) return null;

  // Body content is the lines between the header `{` and the matching `}`.
  const bodyStart = headerLine + 1;
  if (bodyEnd < bodyStart) return null;
  // Confirm the hint line is at the header or inside the block; if it's
  // outside (e.g., diag pointed elsewhere) refuse.
  if (hintLine < headerLine || hintLine > bodyEnd) return null;
  return { headerLine, bodyStart, bodyEnd: bodyEnd - 1 };
}

// ── Shared helpers ────────────────────────────────────────────────────────

function isInsideInterfaceBody(lines: string[], diagLine: number): boolean {
  let depth = 0;
  for (let i = diagLine; i >= 0; i--) {
    const lineText = lines[i] ?? "";
    const noComment = splitCodeAndComment(lineText).code;
    for (let j = noComment.length - 1; j >= 0; j--) {
      const c = noComment[j];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          const headerHere = noComment.slice(0, j);
          if (/\binterface\b/.test(headerHere)) return true;
          for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
            const prev = splitCodeAndComment(lines[k] ?? "").code;
            if (/\binterface\b/.test(prev)) return true;
            if (/\b(class|trait|associationClass|enum|filter|statemachine|req)\b/.test(prev)) return false;
          }
          return false;
        }
        depth--;
      }
    }
  }
  return false;
}

export function splitCodeAndComment(lineText: string): {
  code: string;
  comment: string;
} {
  const idx = lineText.indexOf("//");
  if (idx === -1) return { code: lineText, comment: "" };
  return { code: lineText.slice(0, idx), comment: lineText.slice(idx) };
}
