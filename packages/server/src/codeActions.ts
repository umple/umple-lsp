/**
 * Topic 056 — quick-fix code actions for Umple diagnostics.
 *
 * Pure logic only: takes a TextDocument + Diagnostic[] and returns the
 * CodeActions that apply. No LSP transport, no compiler invocation.
 *
 * Currently produces a single action: `Add missing semicolon` for W1007
 * diagnostics whose line content matches one of the whitelisted shapes:
 *
 *   - `isA <id>(, <id>)*`         → class/trait/assoc-class isA list
 *   - `implementsReq <id>(, <id>)*` → req implementation list
 *   - inline association          → identifiers + Umple arrow + identifier
 *   - attribute-style declaration → 2+ bare identifiers
 *   - interface method signature  → `<retType>? <name>(<params>)` AND
 *                                   the cursor is inside an interface body
 *
 * The classifier rejects W1007 lines that contain expression operators,
 * class-body method signatures (where adding `;` doesn't help), and any
 * line where the last non-whitespace character is `;`, `{`, `}`, or `,`.
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
  if (diag.code !== W1007) return null;
  if (diag.source !== "umple") return null;
  // Imported-file diagnostics route to the `use` line; never offer a
  // semicolon-fix for those.
  if (diag.message?.startsWith("In imported file")) return null;

  const line = diag.range.start.line;
  if (line < 0 || line >= lines.length) return null;
  const lineText = lines[line];
  const split = splitCodeAndComment(lineText);
  const code = split.code;
  const codeTrimmed = code.trimEnd();
  if (codeTrimmed.length === 0) return null; // blank or comment-only

  const lastChar = codeTrimmed[codeTrimmed.length - 1];
  if (lastChar === ";" || lastChar === "{" || lastChar === "}" || lastChar === ",") {
    return null;
  }

  if (!classifyW1007(codeTrimmed.trimStart(), lines, line)) return null;

  const insertCol = codeTrimmed.length;
  const edit: TextEdit = TextEdit.insert(
    { line, character: insertCol },
    ";",
  );
  const workspaceEdit: WorkspaceEdit = {
    changes: { [document.uri]: [edit] },
  };

  return {
    title: SEMICOLON_TITLE,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: workspaceEdit,
  };
}

/**
 * Classify a W1007 line's trimmed code text against the missing-semicolon
 * whitelist. Returns true only when appending `;` is highly likely to fix
 * the diagnostic without changing semantics.
 */
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
// Characters that indicate an expression rather than an association line.
const ASSOC_REJECT_CHARS = /[+=&|!?:;{}()\[\]]/;
// Multiplicity tokens that must appear in a real Umple inline association
// (codex follow-up — `foo -> bar` would otherwise leak through). Matches
// `1`, `*`, `0..1`, `1..*`, `0..*`, `5..10`, `0..5`, etc.
const MULTIPLICITY = /(?:^|\s)(?:\*|\d+(?:\.\.(?:\*|\d+))?)(?:\s|$)/;

function looksLikeInlineAssociation(code: string): boolean {
  if (!ARROW.test(code)) return false;
  if (ASSOC_REJECT_CHARS.test(code)) return false;
  // Real Umple association lines carry at least one multiplicity token —
  // `1 -> * B b`, `0..1 -- * Other items`, etc. Without that we'd accept
  // expression lines like `foo -> bar` which W1007 also fires for and a
  // `;` doesn't fix.
  if (!MULTIPLICITY.test(code)) return false;
  // Last non-whitespace token must be an identifier (the role name or class).
  const trimmed = code.trim();
  if (!/[A-Za-z_]\w*$/.test(trimmed)) return false;
  return true;
}

function looksLikeMethodSignature(code: string): boolean {
  // Optional return type + method name + (params...) with NO body — body
  // would be `{` and the line wouldn't end in W1007.
  return new RegExp(
    `^(${ID}(\\s*<[\\w\\s,<>]+>)?\\s+)?${ID}\\s*\\([^)]*\\)\\s*$`,
  ).test(code);
}

// Structural / top-level statement keywords that must NOT be the first
// token of an attribute-style declaration. `class B` and `state S` are
// W1007 in a class body, but adding `;` doesn't recover the user's
// likely intent (a nested declaration) and creates a follow-up W131
// "attribute name should start lowercase" diagnostic.
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
  // Two or more whitespace-separated bare identifiers, no operators or
  // punctuation. Matches `Integer x`, `hello world`, `String firstName`.
  // Generic types (`List<X> items`) deliberately excluded — keeping the
  // whitelist conservative; users with generics can still type `;`.
  if (!new RegExp(`^${ID}(\\s+${ID})+$`).test(code)) return false;
  // Reject lines that begin with a structural keyword — those are partial
  // declarations the user is in the middle of, not attributes.
  const first = code.split(/\s+/, 1)[0];
  if (STRUCTURAL_FIRST_TOKENS.has(first)) return false;
  return true;
}

/**
 * Walk backwards from the diagnostic line, counting braces (ignoring those
 * inside line comments / strings only at the comment boundary), to find
 * the nearest unclosed `{`. Then check whether its containing line uses
 * the `interface` keyword.
 *
 * This is intentionally simple: it doesn't track multi-line block
 * comments or strings. Umple files use `//` line comments overwhelmingly,
 * so the string-literal edge case is rare and a false-positive here only
 * means we offer the action where it doesn't help — the user can ignore.
 */
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
          // Header line — usually the `interface Foo {` line itself, but
          // could be a continuation. Check the trimmed text.
          const headerHere = noComment.slice(0, j);
          if (/\binterface\b/.test(headerHere)) return true;
          // The `interface` keyword may live on a previous line if the
          // declaration spans lines (rare); peek back a few lines.
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

/**
 * Split a line into `code` (everything before any `//` line comment) and
 * `comment` (the comment portion if any). Naive — does not handle `//`
 * inside string literals, but Umple files rarely contain that shape.
 */
export function splitCodeAndComment(lineText: string): {
  code: string;
  comment: string;
} {
  const idx = lineText.indexOf("//");
  if (idx === -1) return { code: lineText, comment: "" };
  return { code: lineText.slice(0, idx), comment: lineText.slice(idx) };
}
