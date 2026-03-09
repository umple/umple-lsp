import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  SymbolKind,
  TextDocumentSyncKind,
  TextEdit,
  Position,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { BUILTIN_TYPES } from "./keywords";
import {
  symbolIndex,
  UseStatementWithPosition,
  SymbolKind as UmpleSymbolKind,
  SymbolEntry,
} from "./symbolIndex";

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();
let workspaceRoots: string[] = [];

/**
 * Normalize a file URI to a consistent key for the documents map.
 * Converts URI to file path and back to ensure consistent encoding.
 */
function normalizeUri(uri: string): string {
  if (!uri.startsWith("file:")) {
    return uri;
  }
  try {
    // Convert to path and back to normalize encoding
    const filePath = fileURLToPath(uri);
    return pathToFileURL(filePath).toString();
  } catch {
    return uri;
  }
}

/**
 * Get a document by URI, using normalized lookup.
 */
function getDocument(uri: string): TextDocument | undefined {
  return documents.get(normalizeUri(uri));
}

/**
 * Set a document by URI, using normalized key.
 */
function setDocument(uri: string, document: TextDocument): void {
  documents.set(normalizeUri(uri), document);
}

/**
 * Delete a document by URI, using normalized key.
 */
function deleteDocument(uri: string): void {
  documents.delete(normalizeUri(uri));
}

/**
 * Safely read a file, returning null if it fails.
 */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Return the first path from candidates that exists on disk, or undefined.
 */
function findFile(candidates: string[]): string | undefined {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

let umpleSyncJarPath: string | undefined;
let umpleSyncTimeoutMs = 30000;
let jarWarningShown = false;
let treeSitterWasmPath: string | undefined;
let symbolIndexReady = false;

const DEFAULT_UMPLESYNC_TIMEOUT_MS = 30000;

// Track in-flight validations so we can abort stale ones
const inFlightValidations = new Map<string, AbortController>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as
    | {
        umpleSyncJarPath?: string;
        umpleSyncTimeoutMs?: number;
      }
    | undefined;
  umpleSyncJarPath =
    initOptions?.umpleSyncJarPath || process.env.UMPLESYNC_JAR_PATH;
  if (typeof initOptions?.umpleSyncTimeoutMs === "number") {
    umpleSyncTimeoutMs = initOptions.umpleSyncTimeoutMs;
  } else if (process.env.UMPLESYNC_TIMEOUT_MS) {
    const parsed = Number(process.env.UMPLESYNC_TIMEOUT_MS);
    if (!Number.isNaN(parsed)) {
      umpleSyncTimeoutMs = parsed;
    }
  } else {
    umpleSyncTimeoutMs = DEFAULT_UMPLESYNC_TIMEOUT_MS;
  }

  workspaceRoots = resolveWorkspaceRoots(params);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["/", "."],
      },
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  connection.console.info("Umple language server initialized.");

  // Initialize tree-sitter symbol index for fast go-to-definition
  treeSitterWasmPath =
    process.env.UMPLE_TREE_SITTER_WASM_PATH ||
    treeSitterWasmPath ||
    findFile([
      path.join(__dirname, "..", "tree-sitter-umple.wasm"), // npm package (wasm copied to server root)
      path.join(
        __dirname,
        "..",
        "..",
        "tree-sitter-umple",
        "tree-sitter-umple.wasm",
      ), // monorepo dev
    ]);

  if (treeSitterWasmPath && fs.existsSync(treeSitterWasmPath)) {
    try {
      symbolIndexReady = await symbolIndex.initialize(treeSitterWasmPath);
      if (symbolIndexReady) {
        connection.console.info("Symbol index initialized with tree-sitter.");
      }
    } catch (err) {
      connection.console.warn(`Failed to initialize symbol index: ${err}`);
    }
  } else {
    connection.console.info(
      `Tree-sitter WASM not found at ${treeSitterWasmPath ?? "(no path configured)"}, using fallback go-to-definition.`,
    );
  }
});

// Create
connection.onDidOpenTextDocument((params) => {
  const document = TextDocument.create(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text,
  );
  setDocument(params.textDocument.uri, document);
  scheduleValidation(document);

  // Index current file only; imports are indexed on-demand by
  // ensureImportsIndexed() when completion or go-to-definition is triggered
  if (symbolIndexReady) {
    try {
      const filePath = fileURLToPath(params.textDocument.uri);
      symbolIndex.indexFile(filePath, params.textDocument.text);
    } catch {
      // Ignore errors for non-file URIs
    }
  }
});

/**
 * Ensure all files reachable via use statements are indexed, and return
 * the set of reachable file paths (including the current file).
 * Used by both completion and go-to-definition.
 */
function ensureImportsIndexed(docPath: string, text: string): Set<string> {
  const docDir = path.dirname(docPath);
  const reachableFiles = collectReachableFiles(docPath, text, docDir);
  reachableFiles.add(path.normalize(docPath));

  for (const file of reachableFiles) {
    // Prefer unsaved content from open editors over saved disk content
    const uri = pathToFileURL(file).toString();
    const openDoc = getDocument(uri);
    if (openDoc) {
      symbolIndex.updateFile(file, openDoc.getText());
    } else if (fs.existsSync(file)) {
      symbolIndex.indexFile(file);
    }
  }

  return reachableFiles;
}

connection.onDidChangeTextDocument((params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return;
  }
  const updated = TextDocument.update(
    document,
    params.contentChanges,
    params.textDocument.version,
  );
  setDocument(params.textDocument.uri, updated);
  scheduleValidation(updated);

  // Re-validate other open documents that might depend on this file
  scheduleDependentValidation(params.textDocument.uri);
});

connection.onDidCloseTextDocument((params) => {
  const normalizedUri = normalizeUri(params.textDocument.uri);
  deleteDocument(params.textDocument.uri);
  const pendingValidation = pendingValidations.get(normalizedUri);
  if (pendingValidation) {
    clearTimeout(pendingValidation);
    pendingValidations.delete(normalizedUri);
  }
  // Abort any in-flight validation so stale results aren't published after close
  const inFlight = inFlightValidations.get(normalizedUri);
  if (inFlight) {
    inFlight.abort();
    inFlightValidations.delete(normalizedUri);
  }
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const docPath = getDocumentFilePath(document);
  if (!docPath || !symbolIndexReady) {
    return [];
  }

  const text = document.getText();
  const { line, character } = params.position;

  // 1. Get completion info from LookaheadIterator + scope query
  const info = symbolIndex.getCompletionInfo(text, line, character);

  // 2. Suppress completions
  if (info.isComment || info.isDefinitionName) {
    return [];
  }
  if (info.symbolKinds === "suppress") {
    return [];
  }

  // 3. Ensure imported files are indexed
  const reachableFiles = ensureImportsIndexed(docPath, text);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // 4. Normalize symbolKinds: use_path → file completions + mixset symbols
  //    "/" trigger outside use_path is suppressed
  let symbolKinds = info.symbolKinds;
  if (symbolKinds === "use_path") {
    for (const item of getUseFileCompletions(
      document,
      info.prefix,
      line,
      character,
    )) {
      seen.add(item.label);
      items.push(item);
    }
    // Path prefix (contains /) → only file completions, no keywords/mixsets
    if (info.prefix.includes("/")) {
      return items;
    }
    symbolKinds = ["mixset"] as UmpleSymbolKind[];
  } else if (params.context?.triggerCharacter === "/") {
    return [];
  } else if (params.context?.triggerCharacter === ".") {
    if (!info.dottedStatePrefix) return [];
    // Dot-state completion: return only child state names, skip all
    // generic phases (keywords, operators, types, other symbol kinds).
    const childNames = info.enclosingStateMachine
      ? symbolIndex.getChildStateNames(
          info.dottedStatePrefix,
          info.enclosingStateMachine,
          reachableFiles,
        )
      : [];
    return childNames.map((name) => ({
      label: name,
      kind: symbolKindToCompletionKind("state"),
      detail: "state",
      sortText: `0_${name}`,
    }));
  }

  // 5a. Keywords from LookaheadIterator
  for (const kw of info.keywords) {
    if (!seen.has(kw)) {
      seen.add(kw);
      items.push({ label: kw, kind: CompletionItemKind.Keyword });
    }
  }

  // 5b. Operators from LookaheadIterator
  for (const op of info.operators) {
    if (!seen.has(op)) {
      seen.add(op);
      items.push({ label: op, kind: CompletionItemKind.Operator });
    }
  }

  // 5c. Built-in types (when in type-compatible scope)
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

  // 5d. Constraint scope: only own attributes (Umple E28)
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

  // 5e. Symbol completions from index (scoped to reachable files)
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
      } else if (symKind === "template" && info.enclosingClass) {
        symbols = symbolIndex
          .getSymbols({ container: info.enclosingClass, kind: "template" })
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
});

// ── Shared symbol resolution (used by go-to-def and hover) ──────────────────

/**
 * Resolve symbol(s) at a given position.  Returns the token info plus
 * matching SymbolEntry[] filtered to reachable files, or null if no
 * identifier is found at the position.
 */
function resolveSymbolAtPosition(
  docPath: string,
  content: string,
  line: number,
  col: number,
): {
  token: NonNullable<ReturnType<typeof symbolIndex.getTokenAtPosition>>;
  symbols: SymbolEntry[];
} | null {
  const token = symbolIndex.getTokenAtPosition(docPath, content, line, col);
  if (!token) return null;

  // If references.scm didn't match any pattern, there's no valid target
  if (!token.kinds) return { token, symbols: [] };

  const reachableFiles = ensureImportsIndexed(docPath, content);

  const containerKinds = new Set<string>([
    "attribute",
    "const",
    "method",
    "template",
    "state",
    "statemachine",
  ]);
  const isScoped = token.kinds.some((k) => containerKinds.has(k));
  let container: string | undefined;
  if (isScoped) {
    container = token.kinds.some((k) => k === "state" || k === "statemachine")
      ? token.enclosingStateMachine
      : token.enclosingClass;
  }

  let symbols: SymbolEntry[] = [];
  if (container) {
    symbols = symbolIndex
      .getSymbols({
        name: token.word,
        kind: token.kinds,
        container,
        inherited: true,
      })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
  }

  if (symbols.length === 0) {
    symbols = symbolIndex
      .getSymbols({ name: token.word, kind: token.kinds })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
  }

  // Disambiguate dotted state paths (e.g., EEE.Open.Inner → only Inner inside Open)
  if (
    token.qualifiedPath &&
    token.pathIndex !== undefined &&
    token.pathIndex > 0 &&
    symbols.length > 1 &&
    token.enclosingStateMachine
  ) {
    const precedingPath = token.qualifiedPath.slice(0, token.pathIndex);
    const resolved = symbolIndex.resolveStateInPath(
      precedingPath,
      token.word,
      token.enclosingStateMachine,
      reachableFiles,
    );
    if (resolved) {
      symbols = [resolved];
    }
  }

  // Disambiguate state definition sites (e.g., cursor on Inner in `Inner {}` inside EEE.Open)
  if (
    token.stateDefinitionPath &&
    token.kinds?.includes("state") &&
    symbols.length > 1
  ) {
    const defPath = token.stateDefinitionPath;
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

connection.onDefinition(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return [];

  const docPath = getDocumentFilePath(document);
  if (!docPath) return [];

  const token = symbolIndex.getTokenAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!token) return [];

  // use statement with .ump extension: resolve as file reference
  if (token.word.endsWith(".ump")) {
    const baseDir = path.dirname(docPath);
    const targetPath = path.isAbsolute(token.word)
      ? token.word
      : path.join(baseDir, token.word);
    if (!fs.existsSync(targetPath)) return [];
    return [
      Location.create(
        pathToFileURL(targetPath).toString(),
        Range.create(Position.create(0, 0), Position.create(0, 0)),
      ),
    ];
  }

  const resolved = resolveSymbolAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!resolved || resolved.symbols.length === 0) return [];

  return resolved.symbols.map((sym) =>
    Location.create(
      pathToFileURL(sym.file).toString(),
      Range.create(
        Position.create(sym.line, sym.column),
        Position.create(sym.endLine, sym.endColumn),
      ),
    ),
  );
});

// ── Find References ──────────────────────────────────────────────────────────

connection.onReferences(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return [];

  const docPath = getDocumentFilePath(document);
  if (!docPath) return [];

  // 1. Identify symbol (full declaration set)
  const resolved = resolveSymbolAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!resolved || resolved.symbols.length === 0) return [];

  // 2. Index all workspace files (content-hash skips unchanged files)
  symbolIndex.indexWorkspace(workspaceRoots, (filePath) => {
    const uri = pathToFileURL(filePath).toString();
    return getDocument(uri)?.getText();
  });

  // 3. Compute search scope: declaration files + reverse importers
  const declFiles = new Set(
    resolved.symbols.map((s) => path.normalize(s.file)),
  );
  const filesToSearch = symbolIndex.getReverseImporters(declFiles);
  // Include declaration files themselves
  for (const f of declFiles) filesToSearch.add(f);

  // 4. Find references
  const refs = symbolIndex.findReferences(
    resolved.symbols,
    filesToSearch,
    params.context.includeDeclaration,
  );

  // 5. Convert to Location[]
  return refs.map((r) =>
    Location.create(
      pathToFileURL(r.file).toString(),
      Range.create(
        Position.create(r.line, r.column),
        Position.create(r.endLine, r.endColumn),
      ),
    ),
  );
});

// ── Hover ───────────────────────────────────────────────────────────────────

/**
 * Find the definition node in the tree that matches a SymbolEntry's body range.
 */
function findDefNode(sym: SymbolEntry): /* SyntaxNode */ any | null {
  if (sym.defLine == null || sym.defEndLine == null) return null;
  const tree = symbolIndex.getTree(sym.file);
  if (!tree) return null;
  return tree.rootNode.descendantForPosition(
    { row: sym.defLine, column: sym.defColumn ?? 0 },
    { row: sym.defEndLine, column: sym.defEndColumn ?? 0 },
  );
}

function buildClassLikeHover(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
): string {
  const keyword = sym.kind; // class | interface | trait | enum
  const parts: string[] = [];

  // Check for abstract across ALL definition blocks (classes can be split)
  const sameNameSyms = allSymbols.filter(
    (s) => s.kind === sym.kind && s.name === sym.name,
  );
  let isAbstract = false;
  for (const s of sameNameSyms) {
    const node = findDefNode(s);
    if (
      node &&
      node.children.some((c: any) => c.type === "abstract_declaration")
    ) {
      isAbstract = true;
      break;
    }
  }

  // Build header
  let header = "";
  if (isAbstract) header += "abstract ";
  header += `${keyword} ${sym.name}`;
  parts.push(header);

  // isA parents (already aggregated from all blocks via isAGraph)
  const parents = symbolIndex.getIsAParents(sym.name);
  if (parents.length > 0) {
    parts.push(`isA ${parents.join(", ")}`);
  }

  // For enums, list values (enums don't split, use first defNode)
  if (keyword === "enum") {
    const defNode = findDefNode(sym);
    if (defNode) {
      const values: string[] = [];
      for (const child of defNode.children) {
        if (child.type === "enum_value") {
          const name = child.childForFieldName("name");
          if (name) values.push(name.text);
        }
      }
      if (values.length > 0) {
        parts.push(`{ ${values.join(", ")} }`);
      }
    }
  }

  return "```umple\n" + parts.join("\n") + "\n```";
}

function buildAttributeHover(
  sym: SymbolEntry,
  defNode: /* SyntaxNode */ any,
): string {
  const parts: string[] = [];

  // Modifier (unique, immutable, lazy, settable, autounique, etc.)
  const modifier = defNode.children.find(
    (c: any) => c.type === "attribute_modifier",
  );
  if (modifier) parts.push(modifier.text);

  // Type
  const typeNode = defNode.childForFieldName("type");
  if (typeNode) {
    parts.push(typeNode.text);
  } else if (!modifier || modifier.text !== "autounique") {
    // Default type is String in Umple (unless autounique which has no type)
    parts.push("String");
  }

  // Name
  parts.push(sym.name);

  // Container info
  let extra = "";
  if (sym.container) {
    extra = `\n\n*in class ${sym.container}*`;
  }

  return "```umple\n" + parts.join(" ") + "\n```" + extra;
}

function buildConstHover(
  sym: SymbolEntry,
  defNode: /* SyntaxNode */ any,
): string {
  // const_declaration: const Type name = value ;
  const typeNode = defNode.childForFieldName("type");
  const typeName = typeNode ? typeNode.text : "String";

  // Extract the value (everything between = and ;)
  let value = "";
  let seenEquals = false;
  for (const child of defNode.children) {
    if ((child as any).type === "=" || (child as any).text === "=") {
      seenEquals = true;
      continue;
    }
    if (seenEquals && (child as any).text !== ";") {
      value = (child as any).text;
      break;
    }
  }

  let result = "```umple\nconst " + typeName + " " + sym.name;
  if (value) result += " = " + value;
  result += "\n```";

  if (sym.container) {
    result += `\n\n*in class ${sym.container}*`;
  }
  return result;
}

function buildMethodHover(
  sym: SymbolEntry,
  defNode: /* SyntaxNode */ any,
): string {
  const parts: string[] = [];

  // Visibility
  const vis = defNode.children.find((c: any) => c.type === "visibility");
  if (vis) parts.push(vis.text);

  // Static (keyword child, not a field)
  for (const child of defNode.children) {
    if (child.type === "static") {
      parts.push("static");
      break;
    }
  }

  // Return type
  const returnType = defNode.childForFieldName("return_type");
  if (returnType) {
    parts.push(returnType.text);
  } else {
    parts.push("void");
  }

  // Name + params
  const paramList = defNode.children.find((c: any) => c.type === "param_list");
  let paramStr = "";
  if (paramList) {
    const params: string[] = [];
    for (const p of paramList.children) {
      if (p.type === "param") {
        const pName = p.childForFieldName("name");
        const pType = p.children.find((c: any) => c.type === "type_name");
        if (pType && pName) {
          params.push(`${pType.text} ${pName.text}`);
        } else if (pName) {
          params.push(pName.text);
        }
      }
    }
    paramStr = params.join(", ");
  }
  parts.push(`${sym.name}(${paramStr})`);

  let extra = "";
  if (sym.container) {
    extra = `\n\n*in class ${sym.container}*`;
  }

  return "```umple\n" + parts.join(" ") + "\n```" + extra;
}

function buildStateMachineHover(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
): string {
  // Collect state names from ALL matching SM definitions (handles split classes)
  const stateNames: string[] = [];
  const sameNameSyms = allSymbols.filter(
    (s) => s.kind === "statemachine" && s.name === sym.name,
  );
  for (const s of sameNameSyms) {
    const node = findDefNode(s);
    if (!node) continue;
    for (const child of node.children) {
      if (child.type === "state") {
        const name = child.childForFieldName("name");
        if (name && !stateNames.includes(name.text)) {
          stateNames.push(name.text);
        }
      }
    }
  }

  let result = "```umple\n" + sym.name + " (state machine)\n```";
  if (stateNames.length > 0) {
    result += `\n\nStates: ${stateNames.join(", ")}`;
  }

  if (sym.container) {
    result += `\n\n*in class ${sym.container}*`;
  }

  return result;
}

function collectStateInfo(defNode: /* SyntaxNode */ any): {
  transitions: string[];
  actions: string[];
  nestedStates: string[];
} {
  const transitions: string[] = [];
  const actions: string[] = [];
  const nestedStates: string[] = [];

  for (const child of defNode.children) {
    if (child.type === "transition") {
      const event = child.childForFieldName("event");
      const target = child.childForFieldName("target");
      const guard = child.children.find((c: any) => c.type === "guard");

      let transStr = "  ";
      if (event) transStr += event.text;
      else transStr += "(auto)";
      if (guard) transStr += ` ${guard.text}`;
      if (target) transStr += ` -> ${target.text}`;
      if (!transitions.includes(transStr)) transitions.push(transStr);
    }

    if (child.type === "entry_exit_action") {
      const keyword =
        child.children.find((c: any) => c.text === "entry" || c.text === "exit")
          ?.text ?? "action";
      const line = `  ${keyword} / { ... }`;
      if (!actions.includes(line)) actions.push(line);
    }

    if (child.type === "state") {
      const name = child.childForFieldName("name");
      if (name && !nestedStates.includes(name.text)) {
        nestedStates.push(name.text);
      }
    }
  }

  return { transitions, actions, nestedStates };
}

function buildStateHover(sym: SymbolEntry, allSymbols: SymbolEntry[]): string {
  const lines: string[] = [`${sym.name} (state)`];

  // Merge transitions/actions/nested states from ALL matching state definitions
  const sameNameStates = allSymbols.filter(
    (s) => s.kind === "state" && s.name === sym.name,
  );
  for (const s of sameNameStates) {
    const node = findDefNode(s);
    if (!node) continue;
    const info = collectStateInfo(node);
    for (const t of info.transitions) {
      if (!lines.includes(t)) lines.push(t);
    }
    for (const a of info.actions) {
      if (!lines.includes(a)) lines.push(a);
    }
    // Collect nested states (shown at end)
    if (info.nestedStates.length > 0) {
      const nested = `  nested: ${info.nestedStates.join(", ")}`;
      if (!lines.includes(nested)) lines.push(nested);
    }
  }

  let result = "```umple\n" + lines.join("\n") + "\n```";

  if (sym.container) {
    const smDisplay = sym.container.includes(".")
      ? sym.container.substring(sym.container.indexOf(".") + 1)
      : sym.container;
    result += `\n\n*in state machine ${smDisplay}*`;
  }

  return result;
}

function buildAssociationHover(
  sym: SymbolEntry,
  defNode: /* SyntaxNode */ any,
): string {
  // Handle both association_definition (standalone) and inline_association
  const nodeType = defNode.type;

  if (nodeType === "association_definition") {
    const members = defNode.children.filter(
      (c: any) => c.type === "association_member",
    );
    if (members.length > 0) {
      const lines: string[] = [];
      for (const member of members) {
        lines.push(member.text.trim());
      }
      let result = "```umple\nassociation";
      if (sym.name) result += ` ${sym.name}`;
      result += `\n  ${lines.join("\n  ")}\n\`\`\``;
      return result;
    }
  }

  if (nodeType === "inline_association" || nodeType === "association_inline") {
    return "```umple\n" + defNode.text.trim() + "\n```";
  }

  // Fallback: show the raw text
  return "```umple\nassociation " + sym.name + "\n```";
}

/**
 * Build markdown hover content for a resolved symbol.
 * allSymbols is the full match list (needed for merging split definitions).
 */
function buildHoverMarkdown(
  sym: SymbolEntry,
  allSymbols: SymbolEntry[],
): string | null {
  const defNode = findDefNode(sym);
  if (!defNode) return null;

  switch (sym.kind) {
    case "class":
    case "interface":
    case "trait":
    case "enum":
      return buildClassLikeHover(sym, allSymbols);
    case "attribute":
      return buildAttributeHover(sym, defNode);
    case "const":
      return buildConstHover(sym, defNode);
    case "method":
      return buildMethodHover(sym, defNode);
    case "statemachine":
      return buildStateMachineHover(sym, allSymbols);
    case "state":
      return buildStateHover(sym, allSymbols);
    case "association":
      return buildAssociationHover(sym, defNode);
    case "enum_value": {
      let result = "```umple\n" + sym.name + "\n```";
      if (sym.container) {
        result += `\n\n*in enum ${sym.container}*`;
      }
      return result;
    }
    case "mixset":
      return "```umple\nmixset " + sym.name + "\n```";
    case "requirement":
      return "```umple\nrequirement " + sym.name + "\n```";
    case "template":
      return "```umple\ntemplate " + sym.name + "\n```";
    default:
      return "```umple\n" + sym.kind + " " + sym.name + "\n```";
  }
}

connection.onHover(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return null;

  const docPath = getDocumentFilePath(document);
  if (!docPath) return null;

  const resolved = resolveSymbolAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!resolved || resolved.symbols.length === 0) return null;

  const sym = resolved.symbols[0];
  const markdown = buildHoverMarkdown(sym, resolved.symbols);
  if (!markdown) return null;

  return { contents: { kind: "markdown" as const, value: markdown } };
});

// ── Document Symbols (Outline) ──────────────────────────────────────────────

function umpleKindToLspSymbolKind(kind: UmpleSymbolKind): SymbolKind {
  switch (kind) {
    case "class":
      return SymbolKind.Class;
    case "interface":
      return SymbolKind.Interface;
    case "trait":
      return SymbolKind.Interface;
    case "enum":
      return SymbolKind.Enum;
    case "enum_value":
      return SymbolKind.EnumMember;
    case "attribute":
      return SymbolKind.Field;
    case "const":
      return SymbolKind.Constant;
    case "method":
      return SymbolKind.Method;
    case "template":
      return SymbolKind.Field;
    case "statemachine":
      return SymbolKind.Struct;
    case "state":
      return SymbolKind.EnumMember;
    case "association":
      return SymbolKind.Property;
    case "mixset":
      return SymbolKind.Module;
    case "requirement":
      return SymbolKind.String;
    default:
      return SymbolKind.Variable;
  }
}

/** Check if outer's definition range strictly contains inner's. */
function defRangeContains(outer: SymbolEntry, inner: SymbolEntry): boolean {
  const os = outer.defLine! * 1e6 + outer.defColumn!;
  const oe = outer.defEndLine! * 1e6 + outer.defEndColumn!;
  const is_ = inner.defLine! * 1e6 + inner.defColumn!;
  const ie = inner.defEndLine! * 1e6 + inner.defEndColumn!;
  return os <= is_ && oe >= ie && (os < is_ || oe > ie);
}

/**
 * Convert a flat list of SymbolEntry[] (single file) into a hierarchical
 * DocumentSymbol[] tree using range containment.
 */
function buildDocumentSymbolTree(symbols: SymbolEntry[]): DocumentSymbol[] {
  const entries = symbols.filter(
    (s) => s.defLine !== undefined && s.defEndLine !== undefined,
  );

  // Sort by body range start, then largest first (parents before children)
  entries.sort((a, b) => {
    const lineDiff = a.defLine! - b.defLine!;
    if (lineDiff !== 0) return lineDiff;
    const colDiff = a.defColumn! - b.defColumn!;
    if (colDiff !== 0) return colDiff;
    // Same start: larger range first
    const aEnd = a.defEndLine! * 1e6 + a.defEndColumn!;
    const bEnd = b.defEndLine! * 1e6 + b.defEndColumn!;
    return bEnd - aEnd;
  });

  const roots: DocumentSymbol[] = [];
  const stack: { sym: DocumentSymbol; entry: SymbolEntry }[] = [];

  for (const entry of entries) {
    const docSym = DocumentSymbol.create(
      entry.name,
      entry.kind,
      umpleKindToLspSymbolKind(entry.kind),
      Range.create(
        Position.create(entry.defLine!, entry.defColumn!),
        Position.create(entry.defEndLine!, entry.defEndColumn!),
      ),
      Range.create(
        Position.create(entry.line, entry.column),
        Position.create(entry.endLine, entry.endColumn),
      ),
    );

    // Pop stack until we find a parent that contains this entry
    while (stack.length > 0) {
      if (defRangeContains(stack[stack.length - 1].entry, entry)) break;
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(docSym);
    } else {
      const parent = stack[stack.length - 1].sym;
      if (!parent.children) parent.children = [];
      parent.children.push(docSym);
    }

    stack.push({ sym: docSym, entry });
  }

  return roots;
}

connection.onDocumentSymbol(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return [];

  const docPath = getDocumentFilePath(document);
  if (!docPath) return [];

  symbolIndex.updateFile(docPath, document.getText());
  return buildDocumentSymbolTree(symbolIndex.getFileSymbols(docPath));
});

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Collect line ranges of code_content and template_body nodes (embedded code
 * that the formatter should not re-indent).
 */
function getCodeContentRanges(
  document: TextDocument,
): { startLine: number; endLine: number }[] {
  const docPath = getDocumentFilePath(document);
  if (!docPath || !symbolIndexReady) return [];

  symbolIndex.updateFile(docPath, document.getText());
  const tree = symbolIndex.getTree(docPath);
  if (!tree) return [];

  const ranges: { startLine: number; endLine: number }[] = [];
  const cursor = tree.rootNode.walk();

  // Walk the tree and collect code_content / template_body nodes
  let reachedEnd = false;
  while (!reachedEnd) {
    const node = cursor.currentNode;
    if (node.type === "code_content" || node.type === "template_body") {
      ranges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      });
      // Don't descend into these nodes
      if (!cursor.gotoNextSibling()) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            reachedEnd = true;
            break;
          }
        }
      }
    } else if (!cursor.gotoFirstChild()) {
      if (!cursor.gotoNextSibling()) {
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            reachedEnd = true;
            break;
          }
        }
      }
    }
  }

  return ranges;
}

function isInSkipRange(
  line: number,
  ranges: { startLine: number; endLine: number }[],
): boolean {
  // Strictly between start and end — the boundary lines (method signature
  // with `{` and closing `}`) still get formatted as Umple structure.
  return ranges.some((r) => line > r.startLine && line < r.endLine);
}

function computeIndentEdits(
  text: string,
  options: { tabSize: number; insertSpaces: boolean },
  skipRanges: { startLine: number; endLine: number }[],
): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and lines inside embedded code
    if (!trimmed || isInSkipRange(i, skipRanges)) continue;

    // Count leading } to decrease depth before indenting this line
    let leadingCloses = 0;
    for (const ch of trimmed) {
      if (ch === "}") leadingCloses++;
      else break;
    }
    depth = Math.max(0, depth - leadingCloses);

    // Compute expected indent
    const expected = unit.repeat(depth);
    const currentIndent = line.substring(
      0,
      line.length - line.trimStart().length,
    );

    // Only emit edit if indent differs
    if (currentIndent !== expected) {
      edits.push(
        TextEdit.replace(
          Range.create(
            Position.create(i, 0),
            Position.create(i, currentIndent.length),
          ),
          expected,
        ),
      );
    }

    // Count all braces on this line for next line's depth
    let opens = 0;
    let closes = 0;
    for (const ch of trimmed) {
      if (ch === "{") opens++;
      else if (ch === "}") closes++;
    }
    // Subtract only non-leading closes (leading ones were already applied above)
    depth = Math.max(0, depth + opens - (closes - leadingCloses));
  }

  return edits;
}

connection.onDocumentFormatting(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) return [];

  const skipRanges = getCodeContentRanges(document);
  return computeIndentEdits(document.getText(), params.options, skipRanges);
});

function scheduleValidation(document: TextDocument): void {
  const uriKey = normalizeUri(document.uri);
  const existing = pendingValidations.get(uriKey);
  if (existing) {
    clearTimeout(existing);
  }
  const handle = setTimeout(() => {
    pendingValidations.delete(uriKey);
    void validateTextDocument(document);
  }, 300);
  pendingValidations.set(uriKey, handle);
}

// Debounce key for dependent validation
const dependentValidationKey = "__dependent__";

/**
 * Schedule re-validation for open documents that actually import the changed file.
 * Uses a longer debounce time to avoid excessive re-validation.
 */
function scheduleDependentValidation(changedUri: string): void {
  // Clear any existing dependent validation timer
  const existing = pendingValidations.get(dependentValidationKey);
  if (existing) {
    clearTimeout(existing);
  }

  const normalizedChangedUri = normalizeUri(changedUri);

  const handle = setTimeout(() => {
    pendingValidations.delete(dependentValidationKey);

    // Get the changed file's basename for matching
    let changedFilename: string | null = null;
    try {
      const changedPath = fileURLToPath(changedUri);
      changedFilename = path.basename(changedPath);
    } catch {
      return; // Can't process non-file URIs
    }

    // Re-validate open documents that import the changed file
    for (const [uri, doc] of documents) {
      if (uri === normalizedChangedUri || !uri.endsWith(".ump")) {
        continue;
      }

      // Check if this document imports the changed file
      if (documentImportsFile(doc, changedFilename)) {
        scheduleValidation(doc);
      }
    }
  }, 500); // Longer debounce for dependent files

  pendingValidations.set(dependentValidationKey, handle);
}

/**
 * Check if a document imports a specific file (directly or transitively).
 */
function documentImportsFile(
  document: TextDocument,
  targetFilename: string,
): boolean {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return false;
  }

  const docDir = path.dirname(docPath);
  const reachableFiles = collectReachableFiles(
    docPath,
    document.getText(),
    docDir,
  );

  // Check if any reachable file matches the target filename
  for (const filePath of reachableFiles) {
    if (path.basename(filePath) === targetFilename) {
      return true;
    }
  }

  return false;
}

async function validateTextDocument(document: TextDocument): Promise<void> {
  const jarPath = resolveJarPath();
  if (!jarPath) {
    return;
  }

  const uriKey = normalizeUri(document.uri);
  const docVersion = document.version;

  // Abort any in-flight validation for this document
  const previous = inFlightValidations.get(uriKey);
  if (previous) {
    previous.abort();
  }
  const abortController = new AbortController();
  inFlightValidations.set(uriKey, abortController);

  try {
    const diagnostics = await runUmpleSyncAndParseDiagnostics(
      jarPath,
      document,
      abortController.signal,
    );
    if (abortController.signal.aborted) {
      return;
    }
    // Drop stale results if the document has been edited since we started
    const current = getDocument(document.uri);
    if (!current || current.version !== docVersion) {
      return;
    }
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }
    const current = getDocument(document.uri);
    if (!current || current.version !== docVersion) {
      return;
    }
    connection.console.error(`Diagnostics failed: ${String(error)}`);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  } finally {
    if (inFlightValidations.get(uriKey) === abortController) {
      inFlightValidations.delete(uriKey);
    }
  }
}

function resolveJarPath(): string | undefined {
  if (!umpleSyncJarPath || !fs.existsSync(umpleSyncJarPath)) {
    if (!jarWarningShown) {
      connection.window.showWarningMessage(
        "Umple diagnostics are disabled: umplesync.jar was not found. " +
          "Completion and go-to-definition still work. " +
          "Reload the window to retry.",
      );
      jarWarningShown = true;
    }
    return undefined;
  }

  return umpleSyncJarPath;
}

async function runUmpleSyncAndParseDiagnostics(
  jarPath: string,
  document: TextDocument,
  signal?: AbortSignal,
): Promise<Diagnostic[]> {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return [];
  }

  // Create shadow workspace with all unsaved documents
  const shadow = await createShadowWorkspace(docPath);
  if (!shadow) {
    return [];
  }

  try {
    // Write current document to shadow workspace with trailing newlines
    let text = document.getText();
    if (!text.endsWith("\n\n")) {
      text = text.replace(/\n?$/, "\n\n");
    }
    await fs.promises.writeFile(shadow.targetFile, text, "utf8");

    const { stdout, stderr } = await runUmpleDirect(
      jarPath,
      shadow.targetFile,
      signal,
    );
    const tempFilename = path.basename(shadow.targetFile);
    const documentDir = getDocumentDirectory(document);
    return parseUmpleDiagnostics(
      stderr,
      stdout,
      document,
      tempFilename,
      documentDir,
    );
  } finally {
    await shadow.cleanup();
  }
}

/**
 * Run umplesync.jar directly as a subprocess (one process per request).
 * This is simpler and more reliable than the socket server approach —
 * no persistent state, no stuck connections between requests.
 */
function runUmpleDirect(
  jarPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    execFile(
      "java",
      ["-jar", jarPath, "-generate", "nothing", filePath],
      { signal, timeout: umpleSyncTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        // Umplesync writes diagnostics to stderr and exits 0 on compile errors.
        // Any non-null error here is a real execution failure (java not found,
        // corrupt jar, runtime crash, timeout kill) — reject unconditionally.
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

interface ShadowWorkspace {
  shadowDir: string;
  targetFile: string; // Path to the main document in shadow workspace
  cleanup: () => Promise<void>;
}

/**
 * Create a shadow workspace with only the files needed for compilation:
 * the current document and all files it imports via `use` statements.
 */
async function createShadowWorkspace(
  documentPath: string,
): Promise<ShadowWorkspace | null> {
  const documentDir = path.dirname(documentPath);

  // Get document content (from open doc or disk)
  const fileUri = pathToFileURL(documentPath).toString();
  const openDoc = getDocument(fileUri);
  const documentContent = openDoc?.getText() ?? readFileSafe(documentPath);

  if (!documentContent) {
    return null;
  }

  // Create shadow directory
  const shadowDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "umple-shadow-"),
  );

  try {
    // Find only files reachable via use statements (lazy approach)
    const reachableFiles = collectReachableFiles(
      documentPath,
      documentContent,
      documentDir,
    );

    // Also include the current document
    const normalizedDocPath = path.normalize(documentPath);
    reachableFiles.add(normalizedDocPath);

    // Compute a common ancestor directory so all relative paths stay inside
    // the shadow workspace (no "../" escapes). Always include the document
    // path in the ancestor calculation even if it doesn't exist on disk,
    // since we always write it to the shadow workspace.
    const allForBase = Array.from(reachableFiles);
    const baseDir = findCommonAncestor(allForBase);
    const allPaths = allForBase.filter((f) => fs.existsSync(f));

    // Create directory structure and symlink/copy files
    for (const filePath of allPaths) {
      const relativePath = path.relative(baseDir, filePath);
      const shadowPath = path.join(shadowDir, relativePath);
      const shadowFileDir = path.dirname(shadowPath);

      // Create directory structure
      await fs.promises.mkdir(shadowFileDir, { recursive: true });

      // Check if this file is open in the editor with unsaved changes
      const uri = pathToFileURL(filePath).toString();
      const doc = getDocument(uri);

      if (doc) {
        // Write unsaved content
        await fs.promises.writeFile(shadowPath, doc.getText(), "utf8");
      } else {
        // Symlink to original file
        await fs.promises.symlink(filePath, shadowPath);
      }
    }

    const targetFile = path.join(
      shadowDir,
      path.relative(baseDir, normalizedDocPath),
    );
    // Ensure target directory exists (document may not be on disk,
    // so the symlink/copy loop above may not have created it)
    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });

    return {
      shadowDir,
      targetFile,
      cleanup: async () => {
        await fs.promises.rm(shadowDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Cleanup on error
    await fs.promises.rm(shadowDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Find the deepest common ancestor directory of a list of file paths.
 * Used to ensure all shadow workspace relative paths stay positive (no "../").
 */
function findCommonAncestor(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return os.tmpdir();
  }
  const dirs = filePaths.map((f) => path.dirname(path.normalize(f)));
  const segments = dirs[0].split(path.sep);
  let commonLength = segments.length;
  for (let i = 1; i < dirs.length; i++) {
    const parts = dirs[i].split(path.sep);
    commonLength = Math.min(commonLength, parts.length);
    for (let j = 0; j < commonLength; j++) {
      if (segments[j] !== parts[j]) {
        commonLength = j;
        break;
      }
    }
  }
  return segments.slice(0, commonLength).join(path.sep) || path.sep;
}

/**
 * Collect all file paths reachable via transitive use statements.
 * Used to filter go-to-definition results to only show symbols from imported files.
 */
function collectReachableFiles(
  filePath: string,
  content: string,
  documentDir: string,
): Set<string> {
  const visited = new Set<string>();
  collectReachableFilesRecursive(filePath, content, documentDir, visited);
  return visited;
}

/**
 * Recursively collect reachable file paths.
 */
function collectReachableFilesRecursive(
  filePath: string,
  content: string,
  documentDir: string,
  visited: Set<string>,
): void {
  const useStatements = symbolIndex.extractUseStatements(filePath, content);
  for (const usePath of useStatements) {
    // Skip mixset names (no .ump extension = not a file reference)
    if (!usePath.endsWith(".ump")) {
      continue;
    }

    // Resolve the file path
    let resolvedPath: string;
    if (path.isAbsolute(usePath)) {
      resolvedPath = usePath;
    } else {
      resolvedPath = path.resolve(documentDir, usePath);
    }

    const normalizedPath = path.normalize(resolvedPath);
    if (visited.has(normalizedPath)) {
      continue; // Already visited, skip to avoid cycles
    }
    visited.add(normalizedPath);

    // Recursively process this file's use statements
    if (fs.existsSync(resolvedPath)) {
      try {
        const fileContent = fs.readFileSync(resolvedPath, "utf8");
        const fileDir = path.dirname(resolvedPath);
        collectReachableFilesRecursive(
          resolvedPath,
          fileContent,
          fileDir,
          visited,
        );
      } catch {
        // Ignore read errors
      }
    }
  }
}

function parseUmpleDiagnostics(
  stderr: string,
  stdout: string,
  document: TextDocument,
  tempFilename: string,
  documentDir: string | null,
): Diagnostic[] {
  const jsonDiagnostics = parseUmpleJsonDiagnostics(
    stderr,
    document,
    tempFilename,
    documentDir,
  );

  if (jsonDiagnostics.length === 0 && stdout.includes("Success")) {
    connection.console.info("Umple compile succeeded.");
  }

  return jsonDiagnostics;
}

type UmpleJsonResult = {
  errorCode?: string;
  severity?: string;
  url?: string;
  line?: string;
  filename?: string;
  message?: string;
};

/**
 * Build a map of direct import filename → use statement line number.
 * Also builds a transitive map: direct filename → set of all transitive filenames.
 */
function buildImportMaps(
  useStatements: UseStatementWithPosition[],
  documentDir: string,
): {
  directImports: Map<string, number>;
  transitiveMap: Map<string, Set<string>>;
} {
  const directImports = new Map<string, number>();
  const transitiveMap = new Map<string, Set<string>>();

  for (const useStmt of useStatements) {
    // Skip mixset names (no .ump extension = not a file reference)
    if (!useStmt.path.endsWith(".ump")) {
      continue;
    }

    // Resolve the use path to a filename
    let resolvedPath = useStmt.path;
    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(documentDir, resolvedPath);
    }
    const filename = path.basename(resolvedPath);

    // Map direct import filename to line
    directImports.set(filename, useStmt.line);

    // Collect transitive imports for this direct import
    const transitiveFiles = new Set<string>();
    transitiveFiles.add(filename); // Include the direct import itself
    collectTransitiveFilenames(resolvedPath, transitiveFiles);
    transitiveMap.set(filename, transitiveFiles);
  }

  return { directImports, transitiveMap };
}

/**
 * Recursively collect all filenames transitively imported by a file.
 */
function collectTransitiveFilenames(
  filePath: string,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  const normalizedPath = path.normalize(filePath);
  if (visited.has(normalizedPath)) {
    return; // Avoid cycles
  }
  visited.add(normalizedPath);

  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fileDir = path.dirname(filePath);
    const useStatements = symbolIndex.extractUseStatements(filePath, content);

    for (const usePath of useStatements) {
      // Skip mixset names (no .ump extension = not a file reference)
      if (!usePath.endsWith(".ump")) {
        continue;
      }

      let resolvedPath = usePath;
      if (!path.isAbsolute(resolvedPath)) {
        resolvedPath = path.resolve(fileDir, resolvedPath);
      }
      const filename = path.basename(resolvedPath);
      collected.add(filename);
      collectTransitiveFilenames(resolvedPath, collected, visited);
    }
  } catch {
    // Ignore read errors
  }
}

/**
 * Find the use statement line for an error from an imported file.
 * Returns the line number if found, or undefined if the error doesn't match any import.
 */
function findUseLineForError(
  errorFilename: string,
  directImports: Map<string, number>,
  transitiveMap: Map<string, Set<string>>,
): number | undefined {
  // Check if it's a direct import
  if (directImports.has(errorFilename)) {
    return directImports.get(errorFilename);
  }

  // Check transitive imports
  for (const [directFilename, transitiveFiles] of transitiveMap) {
    if (transitiveFiles.has(errorFilename)) {
      return directImports.get(directFilename);
    }
  }

  return undefined;
}

function parseUmpleJsonDiagnostics(
  stderr: string,
  document: TextDocument,
  tempFilename: string,
  documentDir: string | null,
): Diagnostic[] {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return [];
  }

  const jsonText = extractJson(trimmed);
  if (!jsonText) {
    return [];
  }

  try {
    // Sanitize invalid JSON escapes from umplesync (e.g. \' is not valid JSON)
    const sanitized = jsonText.replace(/\\'/g, "'");
    const parsed = JSON.parse(sanitized) as { results?: UmpleJsonResult[] };
    if (!Array.isArray(parsed.results)) {
      return [];
    }

    const lines = document.getText().split(/\r?\n/);
    const diagnostics: Diagnostic[] = [];

    // Build import maps for mapping imported file errors to use statement lines
    const docPath = getDocumentFilePath(document);
    let directImports = new Map<string, number>();
    let transitiveMap = new Map<string, Set<string>>();

    if (docPath && documentDir) {
      const useStatements = symbolIndex.extractUseStatementsWithPositions(
        docPath,
        document.getText(),
      );
      const maps = buildImportMaps(useStatements, documentDir);
      directImports = maps.directImports;
      transitiveMap = maps.transitiveMap;
    }

    for (const result of parsed.results) {
      const severityValue = Number(result.severity ?? "3");
      const severity =
        severityValue > 2
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Error;

      // Check if error is from an imported file
      if (result.filename && result.filename !== tempFilename) {
        // Find the use statement line for this imported file error
        const useLine = findUseLineForError(
          result.filename,
          directImports,
          transitiveMap,
        );
        if (useLine !== undefined) {
          const useLineText = lines[useLine] ?? "";
          const errorCode = result.errorCode
            ? (severity === DiagnosticSeverity.Warning ? "W" : "E") +
              result.errorCode
            : "";
          const message = errorCode
            ? `In imported file (${result.filename}:${result.line}): ${errorCode}: ${result.message}`
            : `In imported file (${result.filename}:${result.line}): ${result.message}`;

          diagnostics.push({
            severity,
            range: Range.create(
              Position.create(useLine, 0),
              Position.create(useLine, useLineText.length),
            ),
            message,
            source: "umple",
          });
        }
        continue;
      }

      // Error in current file
      const lineNumber = Math.max(Number(result.line ?? "1") - 1, 0);
      const lineText = lines[lineNumber] ?? "";
      const firstNonSpace = lineText.search(/\S/);
      const startChar = firstNonSpace === -1 ? 0 : firstNonSpace;

      const details = [
        result.errorCode
          ? (severity === DiagnosticSeverity.Warning ? "W" : "E") +
            result.errorCode
          : undefined,
        result.message,
      ].filter(Boolean);

      diagnostics.push({
        severity,
        range: Range.create(
          Position.create(lineNumber, startChar),
          Position.create(lineNumber, lineText.length),
        ),
        message: details.join(": "),
        source: "umple",
      });
    }

    return diagnostics;
  } catch {
    return [];
  }
}

function resolveWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  if (Array.isArray(params.workspaceFolders)) {
    for (const folder of params.workspaceFolders) {
      if (folder.uri.startsWith("file:")) {
        try {
          roots.push(path.resolve(fileURLToPath(folder.uri)));
        } catch {
          // ignore invalid workspace uri
        }
      }
    }
  }
  if (
    roots.length === 0 &&
    params.rootUri &&
    params.rootUri.startsWith("file:")
  ) {
    try {
      roots.push(path.resolve(fileURLToPath(params.rootUri)));
    } catch {
      // ignore invalid root uri
    }
  }
  return roots;
}

function getDocumentDirectory(document: TextDocument): string | null {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return null;
  }
  return path.dirname(docPath);
}

function getDocumentFilePath(document: TextDocument): string | null {
  if (!document.uri.startsWith("file:")) {
    return null;
  }
  try {
    return fileURLToPath(document.uri);
  } catch {
    return null;
  }
}

/**
 * Map a SymbolKind to the appropriate LSP CompletionItemKind.
 */
function symbolKindToCompletionKind(kind: UmpleSymbolKind): CompletionItemKind {
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

function getUseFileCompletions(
  document: TextDocument,
  prefix: string,
  line: number,
  character: number,
): CompletionItem[] {
  const docDir = getDocumentDirectory(document);
  if (!docDir) {
    return [];
  }

  // Split prefix into directory part and filename filter
  const lastSlash = prefix.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? prefix.substring(0, lastSlash + 1) : "";
  const filePart = lastSlash >= 0 ? prefix.substring(lastSlash + 1) : prefix;

  // Resolve target directory
  const targetDir = path.resolve(docDir, dirPart);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const docBasename = path.basename(getDocumentFilePath(document) ?? "");
  const isSameDir = path.normalize(targetDir) === path.normalize(docDir);
  const lowerFilter = filePart.toLowerCase();

  // Replace range covers only the filePart (after the last '/').
  // The dirPart is already in the document and stays untouched.
  // This ensures VS Code filters items against the filePart, not the full prefix.
  const replaceRange = Range.create(
    Position.create(line, character - filePart.length),
    Position.create(line, character),
  );

  const items: CompletionItem[] = [];

  for (const entry of entries) {
    const name = entry.name;
    // Skip hidden files/dirs
    if (name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      const label = name + "/";
      if (!label.toLowerCase().startsWith(lowerFilter)) continue;
      items.push({
        label,
        kind: CompletionItemKind.Folder,
        detail: "Directory",
        textEdit: { range: replaceRange, newText: label },
        // Re-trigger completions after inserting folder name
        command: {
          title: "Continue completion",
          command: "editor.action.triggerSuggest",
        },
      });
    } else if (name.endsWith(".ump")) {
      // Skip current file if listing the same directory
      if (isSameDir && name === docBasename) continue;
      if (!name.toLowerCase().startsWith(lowerFilter)) continue;
      items.push({
        label: name,
        kind: CompletionItemKind.File,
        detail: "Umple file",
        textEdit: { range: replaceRange, newText: name },
      });
    }
  }

  return items;
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

connection.listen();
