import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
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
  WorkspaceEdit,
  FileChangeType,
  DidChangeWatchedFilesNotification,
  MessageType,
  ShowMessageNotification,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  symbolIndex,
  UseStatementWithPosition,
  SymbolKind as UmpleSymbolKind,
  SymbolEntry,
} from "./symbolIndex";
import { stripLayoutTail } from "./tokenTypes";
import { resolveSymbolAtPosition as resolveSymbol } from "./resolver";
import {
  buildSemanticCompletionItems,
  symbolKindToCompletionKind,
} from "./completionBuilder";
import { buildHoverMarkdown, buildTraitSmOpHover } from "./hoverBuilder";
import { isRenameableKind, isValidNewName } from "./renameValidation";
import { resolveTraitSmEventLocations } from "./traitSmEventResolver";
import { buildDocumentSymbolTree } from "./documentSymbolBuilder";
import {
  expandCompactStates,
  computeIndentEdits,
  fixTransitionSpacing,
  fixAssociationSpacing,
  normalizeTopLevelBlankLines,
  reindentEmbeddedCode,
} from "./formatter";

// Handle CLI flags before opening the LSP connection. Editor integrations
// always spawn the server with `--stdio` and never pass these flags, so the
// only callers that hit this branch are humans running the binary directly
// to check what version they have installed.
{
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("-v") || cliArgs.includes("--version")) {
    process.stdout.write(`${readServerVersion()}\n`);
    process.exit(0);
  }
  if (cliArgs.includes("-h") || cliArgs.includes("--help")) {
    process.stdout.write(
      [
        "Usage: umple-lsp-server [--stdio]",
        "",
        "Options:",
        "  -v, --version   Print server version and exit",
        "  -h, --help      Print this help and exit",
        "      --stdio     Speak LSP over stdin/stdout (how editors invoke it)",
        "",
        "The server is normally launched by an editor extension, not manually.",
        "See https://github.com/umple/umple-lsp for editor integrations.",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }
}

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();
let workspaceRoots: string[] = [];


// ── Workspace use-graph: per-root readiness tracking ────────────────────────

type RootScanState = "idle" | "scanning" | "ready";
const rootScanStates = new Map<string, RootScanState>();

/**
 * Check if the workspace use-graph is ready for the root containing a file.
 * Returns true if the root's scan is complete, false if scanning or idle.
 * Files outside all workspace roots return true (local-only scope is acceptable).
 */
function isUseGraphReadyForFile(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  for (const [root, state] of rootScanStates) {
    if (normalized.startsWith(root)) return state === "ready";
  }
  // File outside all workspace roots — no graph needed, local scope is fine
  return true;
}

/**
 * Async cooperative directory scanner. Discovers .ump files without blocking
 * the event loop. Uses fs.promises.readdir with yielding every 100 directories.
 */
async function discoverUmpFilesAsync(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [root];
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "out",
    ".test-out",
    "build",
    "dist",
  ]);
  let processed = 0;

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, etc.
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          queue.push(full);
        }
      } else if (entry.name.endsWith(".ump")) {
        results.push(path.normalize(full));
      }
    }

    // Yield every 100 directories to keep the server responsive
    if (++processed % 100 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return results;
}

/**
 * Async cooperative use-graph population for a workspace root.
 * Discovers .ump files, extracts use statements (tree-sitter parse, no symbol extraction),
 * and populates the import graph. Skips already-indexed files.
 */
async function scanWorkspaceRootAsync(
  root: string,
  getOpenDocContent: (filePath: string) => string | undefined,
): Promise<void> {
  rootScanStates.set(root, "scanning");
  try {
    const files = await discoverUmpFilesAsync(root);
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      // Skip already-indexed files (edges are fresh from didOpen/didChange)
      if (symbolIndex.isFileIndexed(filePath)) continue;

      // Prefer open document content over disk
      const content = getOpenDocContent(filePath) ?? readFileSafe(filePath);
      if (!content) continue;

      // Extract use statements and update import graph edges only
      const uses = symbolIndex.extractUseStatements(filePath, content);
      symbolIndex.updateUseGraphEdges(filePath, uses);

      // Yield every 50 files
      if (i % 50 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
    rootScanStates.set(root, "ready");
    connection.console.info(`Workspace use-graph ready for: ${root}`);
  } catch (err) {
    rootScanStates.set(root, "idle");
    connection.console.warn(
      `Workspace use-graph scan failed for ${root}: ${err}`,
    );
  }
}

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
    return stripLayoutTail(fs.readFileSync(filePath, "utf8"));
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

/**
 * Read the `Version:` field from a jar's META-INF/MANIFEST.MF without spawning
 * an external unzip process. Parses the central directory and inflates the
 * manifest entry directly. Returns undefined if anything goes wrong — this is
 * best-effort diagnostic logging, not a load-bearing check.
 */
function readJarManifestVersion(jarPath: string): string | undefined {
  try {
    const buf = fs.readFileSync(jarPath);
    const EOCD_SIG = 0x06054b50;
    const CD_SIG = 0x02014b50;
    const maxScan = Math.max(0, buf.length - 0xffff - 22);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
      const cdOffset = buf.readUInt32LE(i + 16);
      const cdSize = buf.readUInt32LE(i + 12);
      let p = cdOffset;
      const end = cdOffset + cdSize;
      while (p < end) {
        if (buf.readUInt32LE(p) !== CD_SIG) break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
        if (name === "META-INF/MANIFEST.MF") {
          const lfhNameLen = buf.readUInt16LE(localOffset + 26);
          const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
          const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
          const raw = buf.slice(dataStart, dataStart + compSize);
          const content =
            method === 0
              ? raw.toString("utf8")
              : method === 8
                ? zlib.inflateRawSync(raw).toString("utf8")
                : "";
          const m = content.match(/^Version:\s*(\S+)/m);
          return m ? m[1] : undefined;
        }
        p += 46 + nameLen + extraLen + commentLen;
      }
      return undefined;
    }
  } catch {
    // Ignore — diagnostics logging is best-effort
  }
  return undefined;
}

function readServerVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

let umpleSyncJarPath: string | undefined;
let umpleSyncTimeoutMs = 30000;
let jarWarningShown = false;
let treeSitterWasmPath: string | undefined;
let symbolIndexReady = false;
let supportsFileWatcherDynamicRegistration = false;

const DEFAULT_UMPLESYNC_TIMEOUT_MS = 30000;

// Track in-flight validations so we can abort stale ones
const inFlightValidations = new Map<string, AbortController>();

// Topic 054 — captured during initialize from
// `params.capabilities.textDocument.completion.completionItem.snippetSupport`.
// Snippet items are emitted only when this is true. Clients without snippet
// support keep the pre-topic-054 keyword/symbol completion shape.
let clientSnippetSupport = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  clientSnippetSupport =
    params.capabilities.textDocument?.completion?.completionItem?.snippetSupport ===
    true;
  const initOptions = params.initializationOptions as
    | {
        umpleSyncJarPath?: string;
        umpleSyncTimeoutMs?: number;
      }
    | undefined;
  umpleSyncJarPath =
    initOptions?.umpleSyncJarPath || process.env.UMPLESYNC_JAR_PATH;

  // Fallback: look next to the server module (covers npm install -g + BBEdit/editors
  // that launch the server without passing init options)
  if (!umpleSyncJarPath || !fs.existsSync(umpleSyncJarPath)) {
    const candidate = path.resolve(__dirname, "..", "umplesync.jar");
    if (fs.existsSync(candidate)) {
      umpleSyncJarPath = candidate;
    }
  }
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

  // Check if client supports dynamic file watcher registration (LSP spec §3.17)
  supportsFileWatcherDynamicRegistration =
    params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;

  return {
    serverInfo: {
      name: "umple-lsp",
      version: readServerVersion(),
    },
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        // Stage-1 trigger expansion (topic 051 item 1).
        //   "/"  use-path completion inside `use "..."`
        //   "."  qualified names, dotted state paths
        //   "-"  association arrow start (`1 -|`); trait-SM op marker
        //   ">"  association arrow finish (`1 ->|` → multiplicity slot);
        //        transition-target flow after `->`
        //   "*"  association right-multiplicity / type slot (`1 -> *|`)
        //   ","  isA / implementsReq / param continuation
        // Stage-2 (topic 053):
        //   "<"  association arrow `1 <|`; trait-SM op recovery `isA T<-|`
        //   "@"  Java annotation (suppressed); aggregation `1 <@|`
        //   "("  parameter-type slot at method (param-type completion)
        triggerCharacters: ["/", ".", "-", ">", "*", ",", "<", "@", "("],
      },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  const serverVersion = readServerVersion();
  const jarVersion =
    umpleSyncJarPath && fs.existsSync(umpleSyncJarPath)
      ? readJarManifestVersion(umpleSyncJarPath)
      : undefined;
  const jarInfo = umpleSyncJarPath
    ? `umplesync.jar ${jarVersion ?? "(version unknown)"} at ${umpleSyncJarPath}`
    : "umplesync.jar not found (diagnostics disabled)";
  connection.console.info(
    `Umple language server ${serverVersion} initialized. ${jarInfo}.`,
  );

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

        // Start async workspace use-graph scan (non-blocking, cooperative)
        if (workspaceRoots.length > 0) {
          for (const root of workspaceRoots) {
            rootScanStates.set(root, "idle");
            scanWorkspaceRootAsync(root, (filePath) => {
              const uri = pathToFileURL(filePath).toString();
              return getDocument(uri)?.getText();
            });
          }

          // Register file watcher for .ump files to keep the use-graph fresh.
          // Only attempt if the client advertises dynamic registration support
          // (LSP spec). Clients like CodeMirror lsp-client don't implement
          // client/registerCapability and the rejection crashes the server.
          if (supportsFileWatcherDynamicRegistration) {
            try {
              await connection.client.register(
                DidChangeWatchedFilesNotification.type,
                { watchers: [{ globPattern: "**/*.ump" }] },
              );
            } catch {
              connection.console.info("Client does not support file watching.");
            }
          }
        }
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
  const text = stripLayoutTail(params.textDocument.text);
  const document = TextDocument.create(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    text,
  );
  setDocument(params.textDocument.uri, document);
  scheduleValidation(document);

  // Index current file only; imports are indexed on-demand by
  // ensureImportsIndexed() when completion or go-to-definition is triggered
  if (symbolIndexReady) {
    try {
      const filePath = fileURLToPath(params.textDocument.uri);
      symbolIndex.indexFile(filePath, text);

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
  let updated = TextDocument.update(
    document,
    params.contentChanges,
    params.textDocument.version,
  );

  // A full-replacement change (no range) can reintroduce the layout tail.
  // Re-strip to ensure the stored document never contains it.
  const rawText = updated.getText();
  const stripped = stripLayoutTail(rawText);
  if (stripped.length !== rawText.length) {
    updated = TextDocument.create(
      updated.uri,
      updated.languageId,
      updated.version,
      stripped,
    );
  }
  setDocument(params.textDocument.uri, updated);

  // Keep the symbol index current so the clean baseline stays fresh.
  // Without this, state symbols added during clean edits would be lost
  // when the file later enters an errored state (error preservation
  // would use a stale clean snapshot).
  const changedPath = getDocumentFilePath(updated);
  if (changedPath && symbolIndexReady) {
    symbolIndex.updateFile(changedPath, updated.getText());
  }

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

  // If the file no longer exists on disk, purge its indexed state.
  try {
    const closedPath = fileURLToPath(params.textDocument.uri);
    if (!fs.existsSync(closedPath)) {
      symbolIndex.removeFile(path.normalize(closedPath));
    }
  } catch {
    // non-file URI
  }
});

// ── File watcher: keep workspace use-graph fresh for unopened files ──────────

connection.onDidChangeWatchedFiles((params) => {
  if (!symbolIndexReady) return;

  for (const change of params.changes) {
    let filePath: string;
    try {
      filePath = path.normalize(fileURLToPath(change.uri));
    } catch {
      continue;
    }

    // Skip files that are open in the editor — their content is managed by didOpen/didChange.
    // Deletion of open files is also skipped: the buffer is still the source of truth
    // and the user may save it to recreate the file. Cleanup happens on didClose.
    if (getDocument(change.uri)) continue;

    if (change.type === FileChangeType.Deleted) {
      // File deleted — remove all indexed state (symbols, tree, isA, SM reuse, edges)
      symbolIndex.removeFile(filePath);
    } else {
      // Created or Changed — update use-graph edges from disk content
      const content = readFileSafe(filePath);
      if (content) {
        const uses = symbolIndex.extractUseStatements(filePath, content);
        symbolIndex.updateUseGraphEdges(filePath, uses);
      }
    }
  }
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

  // 5. Build semantic completion items (keywords, operators, types, symbols)
  const semanticItems = buildSemanticCompletionItems(
    info,
    symbolKinds,
    symbolIndex,
    reachableFiles,
    clientSnippetSupport,
  );

  // Merge use_path items (if any) with semantic items, deduplicating
  for (const item of semanticItems) {
    if (!seen.has(item.label)) {
      seen.add(item.label);
      items.push(item);
    }
  }

  return items;
});

// ── Shared symbol resolution (used by go-to-def and hover) ──────────────────

/**
 * Resolve symbol(s) at a given position. Thin wrapper around the shared
 * resolver that handles reachable-file computation from the document context.
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
  const reachableFiles = ensureImportsIndexed(docPath, content);
  return resolveSymbol(
    symbolIndex,
    docPath,
    content,
    line,
    col,
    reachableFiles,
  );
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

  // Trait SM event goto-def: dedicated resolver, not through symbol resolver
  if (
    resolved?.token.context.type === "trait_sm_op" &&
    resolved.token.context.isEventSegment &&
    resolved.symbols.length === 0
  ) {
    const ctx = resolved.token.context;
    const reachable = ensureImportsIndexed(docPath, document.getText());
    const locations = resolveTraitSmEventLocations(
      symbolIndex, ctx.traitName, ctx.pathSegments[0],
      resolved.token.word, ctx.eventParams ?? [], ctx.pathSegments, reachable,
    );
    return locations.map((loc) =>
      Location.create(
        pathToFileURL(loc.file).toString(),
        Range.create(
          Position.create(loc.line, loc.column),
          Position.create(loc.endLine, loc.endColumn),
        ),
      ),
    );
  }

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

  // 2. Index forward-reachable files (fast, import-chain only — no workspace crawl).
  //
  // Scope model: references searches the current file, forward-reachable imports,
  // and reverse importers known to the import graph. The import graph is populated
  // by: (1) didOpen/didChange for open files, (2) async background workspace scan
  // on init, (3) file watcher events for disk changes. This avoids synchronous
  // workspace-wide crawling on the request path. References is best-effort — it
  // uses whatever graph state is available without blocking.
  const reachableFiles = ensureImportsIndexed(docPath, document.getText());

  // 3. Compute search scope: declaration files + forward-reachable + known reverse importers
  const declFiles = new Set(
    resolved.symbols.map((s) => path.normalize(s.file)),
  );
  const reverseImporters = symbolIndex.getReverseImporters(declFiles);
  const filesToSearch = new Set([
    ...declFiles,
    ...reachableFiles,
    ...reverseImporters,
  ]);

  // Ensure reverse importers are fully indexed
  for (const file of reverseImporters) {
    if (!symbolIndex.isFileIndexed(file)) {
      const uri = pathToFileURL(file).toString();
      const openDoc = getDocument(uri);
      if (openDoc) {
        symbolIndex.updateFile(file, openDoc.getText());
      } else if (fs.existsSync(file)) {
        symbolIndex.indexFile(file);
      }
    }
  }

  // 4. Expand shared state declarations (reused SM alias/base equivalence)
  const sharedDecls = symbolIndex.getSharedStateDeclarations(
    resolved.symbols,
    filesToSearch,
  );

  // 5. Find references
  const refs = symbolIndex.findReferences(
    sharedDecls,
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

// ── Rename ───────────────────────────────────────────────────────────────────

// RENAMEABLE_KINDS and the new-name regex live in `renameValidation.ts` so
// the semantic test harness can exercise the same rules without importing
// LSP transport types.

function isUnambiguousRename(symbols: SymbolEntry[]): boolean {
  if (symbols.length <= 1) return symbols.length === 1;

  // All symbols must share the same kind
  const kind = symbols[0].kind;
  if (!symbols.every((s) => s.kind === kind)) return false;

  // State: must share same statePath (different paths = different states)
  if (kind === "state") {
    const refPath = symbols[0].statePath?.join(".");
    return symbols.every((s) => s.statePath?.join(".") === refPath);
  }

  // Container-scoped kinds: must share container + name
  const containerScoped = new Set<UmpleSymbolKind>([
    "attribute",
    "const",
    "method",
    "template",
    "statemachine",
  ]);
  if (containerScoped.has(kind)) {
    const { container, name } = symbols[0];
    return symbols.every((s) => s.container === container && s.name === name);
  }

  // Top-level mergeable kinds (class, interface, trait, enum, mixset):
  // same name = partial definitions of the same entity
  const name = symbols[0].name;
  return symbols.every((s) => s.name === name);
}

connection.onPrepareRename(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return null;

  const docPath = getDocumentFilePath(document);
  if (!docPath) return null;

  // Full semantic resolution
  const resolved = resolveSymbolAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!resolved || resolved.symbols.length === 0) return null;

  // Block rename on recovered symbols (cold-open error tolerance)
  if (resolved.symbols.some((s) => s.recovered)) {
    connection.sendNotification(ShowMessageNotification.type, {
      type: MessageType.Warning,
      message: "Cannot rename: this file has parse errors. Fix errors before renaming.",
    });
    return null;
  }

  // Kind must be in the renameable set
  if (!isRenameableKind(resolved.symbols[0].kind)) return null;

  // Identity must be unambiguous
  if (!isUnambiguousRename(resolved.symbols)) return null;

  // Get precise identifier range
  const range = symbolIndex.getNodeRangeAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!range) return null;

  return {
    range: Range.create(
      Position.create(range.startLine, range.startColumn),
      Position.create(range.endLine, range.endColumn),
    ),
    placeholder: resolved.token.word,
  };
});

connection.onRenameRequest(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return null;

  const docPath = getDocumentFilePath(document);
  if (!docPath) return null;

  // 1. Full semantic resolution (same checks as prepareRename).
  //    Do this BEFORE validating the new name so the name rule can be
  //    kind-aware — req ids use a different regex than normal identifiers.
  const resolved = resolveSymbolAtPosition(
    docPath,
    document.getText(),
    params.position.line,
    params.position.character,
  );
  if (!resolved || resolved.symbols.length === 0) return null;

  // Block rename on recovered symbols (cold-open error tolerance)
  if (resolved.symbols.some((s) => s.recovered)) return null;

  if (!isRenameableKind(resolved.symbols[0].kind)) return null;
  if (!isUnambiguousRename(resolved.symbols)) return null;

  // Validate new name against the kind-specific rule.
  if (!isValidNewName(resolved.symbols[0].kind, params.newName)) return null;

  // Check workspace use-graph readiness for the DECLARATION files' roots.
  // Rename must not return partial WorkspaceEdits — if any declaration's
  // root is still scanning, fail explicitly rather than silently miss importers.
  // (Checked after resolution so we know which roots actually matter.)
  for (const sym of resolved.symbols) {
    if (!isUseGraphReadyForFile(sym.file)) {
      // Use window/showMessage notification instead of showWarningMessage
      // (window/showMessageRequest) — some clients like CodeMirror don't
      // implement the request and the rejection crashes the server.
      connection.sendNotification(ShowMessageNotification.type, {
        type: MessageType.Warning,
        message: "Workspace scan in progress. Please try rename again in a moment.",
      });
      return null;
    }
  }

  // 2. Index forward-reachable files (fast, import-chain only — no workspace crawl).
  // Same scope model as references: current file + forward imports + known reverse
  // importers. See onReferences comment for full rationale.
  const reachableFiles = ensureImportsIndexed(docPath, document.getText());

  // 3. Compute search scope: declaration files + forward-reachable + known reverse importers
  const declFiles = new Set(
    resolved.symbols.map((s) => path.normalize(s.file)),
  );
  const reverseImporters = symbolIndex.getReverseImporters(declFiles);
  const filesToSearch = new Set([
    ...declFiles,
    ...reachableFiles,
    ...reverseImporters,
  ]);

  // Ensure reverse importers are fully indexed
  for (const file of reverseImporters) {
    if (!symbolIndex.isFileIndexed(file)) {
      const uri = pathToFileURL(file).toString();
      const openDoc = getDocument(uri);
      if (openDoc) {
        symbolIndex.updateFile(file, openDoc.getText());
      } else if (fs.existsSync(file)) {
        symbolIndex.indexFile(file);
      }
    }
  }

  // 4. Expand shared state declarations (reused SM alias/base equivalence)
  const sharedDecls = symbolIndex.getSharedStateDeclarations(
    resolved.symbols,
    filesToSearch,
  );

  // 5. Find ALL references including declarations
  const refs = symbolIndex.findReferences(
    sharedDecls,
    filesToSearch,
    true,
  );

  // 5. Build WorkspaceEdit
  const changes: { [uri: string]: TextEdit[] } = {};
  for (const r of refs) {
    const uri = pathToFileURL(r.file).toString();
    if (!changes[uri]) changes[uri] = [];
    changes[uri].push(
      TextEdit.replace(
        Range.create(
          Position.create(r.line, r.column),
          Position.create(r.endLine, r.endColumn),
        ),
        params.newName,
      ),
    );
  }

  return { changes };
});

// ── Hover ───────────────────────────────────────────────────────────────────

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

  // Trait SM operation hover: trait-aware formatting + event fallback
  if (resolved?.token.context.type === "trait_sm_op") {
    const ctx = resolved.token.context;
    const reachable = ensureImportsIndexed(docPath, document.getText());
    const markdown = buildTraitSmOpHover(
      resolved.symbols,
      { word: resolved.token.word, context: ctx },
      (f, tn, sm, sp) => symbolIndex.getEventSignatures(f, tn, sm, sp),
      () => {
        const traitSyms = symbolIndex
          .getSymbols({ name: ctx.traitName, kind: ["trait"] })
          .filter((s) => reachable.has(path.normalize(s.file)));
        return traitSyms.length > 0 ? traitSyms[0].file : undefined;
      },
    );
    return markdown ? { contents: { kind: "markdown" as const, value: markdown } } : null;
  }

  if (!resolved || resolved.symbols.length === 0) return null;

  const sym = resolved.symbols[0];
  const markdown = buildHoverMarkdown(sym, resolved.symbols, {
    getTree: (fp: string) => symbolIndex.getTree(fp),
    getIsAParents: (name: string) => symbolIndex.getIsAParents(name),
  });
  if (!markdown) return null;

  return { contents: { kind: "markdown" as const, value: markdown } };
});

// ── Document Symbols (Outline) ──────────────────────────────────────────────

connection.onDocumentSymbol(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document || !symbolIndexReady) return [];

  const docPath = getDocumentFilePath(document);
  if (!docPath) return [];

  symbolIndex.updateFile(docPath, document.getText());
  return buildDocumentSymbolTree(symbolIndex.getFileSymbols(docPath));
});

// ── Formatting ──────────────────────────────────────────────────────────────

connection.onDocumentFormatting(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) return [];

  const docPath = getDocumentFilePath(document);
  if (!docPath || !symbolIndexReady) return [];

  symbolIndex.updateFile(docPath, document.getText());
  const tree = symbolIndex.getTree(docPath);
  if (!tree) return [];

  // Do not format files with parse errors — formatting can corrupt broken trees
  if (tree.rootNode.hasError) return [];

  let text = document.getText();

  const originalText = text;

  // Phase 0: expand compact state blocks (may insert newlines)
  const expandedText = expandCompactStates(text, tree);
  let formatTree = tree;
  if (expandedText !== text) {
    // Temporarily index expanded text to get a parsed tree.
    // We restore the original text at the end to avoid corrupting
    // the live index (the editor document hasn't changed yet).
    symbolIndex.updateFile(docPath, expandedText);
    formatTree = symbolIndex.getTree(docPath)!;
    text = expandedText;
  }

  // Phase 1-3: formatting passes on the (possibly expanded) text
  const edits = [
    ...computeIndentEdits(text, params.options, formatTree),
    ...fixTransitionSpacing(text, formatTree),
    ...fixAssociationSpacing(text, formatTree),
    ...normalizeTopLevelBlankLines(text, formatTree),
    ...reindentEmbeddedCode(text, params.options, formatTree),
  ];

  // Apply edits internally to produce final text
  const lines = text.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const toOffset = (line: number, col: number) =>
    (lineOffsets[line] ?? text.length) + col;

  const sorted = [...edits].sort(
    (a, b) =>
      toOffset(b.range.start.line, b.range.start.character) -
      toOffset(a.range.start.line, a.range.start.character),
  );

  let finalText = text;
  for (const edit of sorted) {
    const start = toOffset(edit.range.start.line, edit.range.start.character);
    const end = toOffset(edit.range.end.line, edit.range.end.character);
    finalText =
      finalText.substring(0, start) + edit.newText + finalText.substring(end);
  }

  // Restore the live index to the original document text if we mutated it
  if (expandedText !== originalText) {
    symbolIndex.updateFile(docPath, originalText);
  }

  // Return single whole-document replace
  if (finalText === originalText) return [];

  // Safety net: verify formatting preserved semantics
  const originalClean = !tree.rootNode.hasError;
  if (originalClean) {
    const originalSymbols = symbolIndex.getFileSymbols(docPath);
    // Temporarily index formatted text to check
    symbolIndex.updateFile(docPath, finalText);
    const formattedTree = symbolIndex.getTree(docPath);
    const formattedClean = formattedTree ? !formattedTree.rootNode.hasError : false;
    const formattedSymbols = symbolIndex.getFileSymbols(docPath);
    // Restore original
    symbolIndex.updateFile(docPath, originalText);

    const check = checkFormatSafety(originalSymbols, formattedSymbols, originalClean, formattedClean);
    if (!check.safe) {
      connection.console.warn(`Format safety check failed: ${check.reason}. Edits suppressed.`);
      return [];
    }
  }

  const lastLine = document.lineCount - 1;
  const lastChar = (originalText.split("\n")[lastLine] ?? "").length;
  return [
    TextEdit.replace(
      Range.create(Position.create(0, 0), Position.create(lastLine, lastChar)),
      finalText,
    ),
  ];
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
      // Use window/showMessage notification instead of showWarningMessage
      // (window/showMessageRequest) — some clients like CodeMirror don't
      // implement the request and the rejection crashes the server.
      connection.sendNotification(ShowMessageNotification.type, {
        type: MessageType.Warning,
        message: "Umple diagnostics are disabled: umplesync.jar was not found. " +
          "Completion and go-to-definition still work. " +
          "Reload the window to retry.",
      });
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
        // Write unsaved content (already stripped via didOpen/didChange)
        await fs.promises.writeFile(shadowPath, doc.getText(), "utf8");
      } else {
        // Symlink when possible (fast); copy+strip only when file has layout tail
        try {
          const raw = fs.readFileSync(filePath, "utf8");
          if (raw.includes("//$?[End_of_model]$?")) {
            await fs.promises.writeFile(shadowPath, stripLayoutTail(raw), "utf8");
          } else {
            await fs.promises.symlink(filePath, shadowPath);
          }
        } catch {
          await fs.promises.symlink(filePath, shadowPath);
        }
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

    // Only add to reachable set if the file actually exists on disk
    if (!fs.existsSync(resolvedPath)) {
      continue;
    }
    visited.add(normalizedPath);

    // Recursively process this file's use statements
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

      // Normalize filename to basename — newer umplesync versions output full paths
      const errorFilename = result.filename
        ? path.basename(result.filename)
        : undefined;

      // Check if error is from an imported file
      if (errorFilename && errorFilename !== tempFilename) {
        // Find the use statement line for this imported file error
        const useLine = findUseLineForError(
          errorFilename,
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
            ? `In imported file (${errorFilename}:${result.line}): ${errorCode}: ${result.message}`
            : `In imported file (${errorFilename}:${result.line}): ${result.message}`;

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

// Register custom diagram click-to-select request handlers
import { registerDiagramRequests } from "./diagramRequests";
import { checkFormatSafety } from "./formatSafetyNet";
registerDiagramRequests(connection, {
  symbolIndex,
  isSymbolIndexReady: () => symbolIndexReady,
  getDocument,
  getDocumentFilePath: (doc) => getDocumentFilePath(doc),
});

connection.listen();
