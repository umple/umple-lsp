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
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  TextDocumentSyncKind,
  Position,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { BUILTIN_TYPES } from "./keywords";
import {
  symbolIndex,
  UseStatementWithPosition,
  SymbolKind,
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
        triggerCharacters: ["/"],
      },
      definitionProvider: true,
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
      symbolIndex.updateFile(filePath, params.textDocument.text);
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
    symbolKinds = ["mixset"] as SymbolKind[];
  } else if (params.context?.triggerCharacter === "/") {
    return [];
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

connection.onDefinition(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return [];
  }

  if (!symbolIndexReady) {
    return [];
  }

  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return [];
  }

  const token = symbolIndex.getTokenAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!token) {
    return [];
  }

  // use statement with .ump extension: resolve as file reference
  if (token.word.endsWith(".ump")) {
    const baseDir = path.dirname(docPath);
    const targetPath = path.isAbsolute(token.word)
      ? token.word
      : path.join(baseDir, token.word);
    if (!fs.existsSync(targetPath)) {
      return [];
    }
    return [
      Location.create(
        pathToFileURL(targetPath).toString(),
        Range.create(Position.create(0, 0), Position.create(0, 0)),
      ),
    ];
  }

  // Symbol lookup, filtered by reachable files
  const reachableFiles = ensureImportsIndexed(docPath, document.getText());

  // For container-scoped kinds, try scoped lookup first (with inheritance), then global fallback
  const containerKinds = new Set<string>([
    "attribute",
    "method",
    "template",
    "state",
  ]);
  const isScoped = token.kinds?.some((k) => containerKinds.has(k));
  let container: string | undefined;
  if (isScoped) {
    container = token.kinds?.some((k) => k === "state")
      ? token.enclosingStateMachine
      : token.enclosingClass;
  }

  let filteredSymbols: SymbolEntry[] = [];
  if (container) {
    filteredSymbols = symbolIndex
      .getSymbols({
        name: token.word,
        kind: token.kinds ?? undefined,
        container,
        inherited: true,
      })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
  }

  if (filteredSymbols.length === 0) {
    filteredSymbols = symbolIndex
      .getSymbols({ name: token.word, kind: token.kinds ?? undefined })
      .filter((s) => reachableFiles.has(path.normalize(s.file)));
  }

  if (filteredSymbols.length > 0) {
    return filteredSymbols.map((sym) =>
      Location.create(
        pathToFileURL(sym.file).toString(),
        Range.create(
          Position.create(sym.line, sym.column),
          Position.create(sym.endLine, sym.endColumn),
        ),
      ),
    );
  }

  return [];
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
        // Umplesync writes errors to stderr and exits 0 — only reject on
        // actual execution failures (java not found, killed, etc.)
        if (error && !stderr && !stdout) {
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
function symbolKindToCompletionKind(kind: SymbolKind): CompletionItemKind {
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
