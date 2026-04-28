/**
 * Semantic test helpers.
 *
 * Thin wrapper around SymbolIndex + resolver for the test harness.
 * Uses the real parser, queries, and index — no mocking.
 */

import * as path from "path";
import * as fs from "fs";
import { SymbolIndex, SymbolEntry, SymbolKind, CompletionInfo } from "../src/symbolIndex";
import { resolveSymbolAtPosition } from "../src/resolver";
import { buildSemanticCompletionItems } from "../src/completionBuilder";
import { buildHoverMarkdown, buildTraitSmOpHover } from "../src/hoverBuilder";
import { isRenameableKind, isValidNewName } from "../src/renameValidation";
import { buildDocumentSymbolTree } from "../src/documentSymbolBuilder";
import { buildWorkspaceSymbols } from "../src/workspaceSymbolBuilder";
import { buildInlayHints } from "../src/inlayHints";
import { expandCompactStates, computeIndentEdits, fixTransitionSpacing, fixAssociationSpacing, normalizeTopLevelBlankLines, reindentEmbeddedCode } from "../src/formatter";
import { checkFormatSafety } from "../src/formatSafetyNet";
import { CompletionItem, Range } from "vscode-languageserver/node";

// __dirname at runtime is .test-out/test/, so ../../ reaches the package root
const FIXTURE_DIR = path.resolve(__dirname, "../../test/fixtures/semantic");

/** Position extracted from a /*@name*​/ marker in fixture text. */
export interface MarkerPosition {
  name: string;
  line: number; // 0-based
  col: number; // 0-based (position of the token AFTER the marker)
}

/**
 * Extract /*@name*​/ markers from fixture text.
 * Returns clean text (markers stripped) and a map of marker positions.
 */
export function extractMarkers(raw: string): {
  clean: string;
  markers: Map<string, MarkerPosition>;
} {
  const markers = new Map<string, MarkerPosition>();
  const markerRegex = /\/\*@(\w+)\*\//g;

  // First pass: find all markers and their positions in the raw text
  const markerEntries: { name: string; start: number; length: number }[] = [];
  let match;
  while ((match = markerRegex.exec(raw)) !== null) {
    markerEntries.push({
      name: match[1],
      start: match.index,
      length: match[0].length,
    });
  }

  // Build clean text by removing all markers
  let clean = "";
  let prevEnd = 0;
  const offsets: number[] = []; // cumulative offset removed before each marker
  let totalRemoved = 0;
  for (const entry of markerEntries) {
    clean += raw.slice(prevEnd, entry.start);
    totalRemoved += entry.length;
    offsets.push(totalRemoved);
    prevEnd = entry.start + entry.length;
  }
  clean += raw.slice(prevEnd);

  // Compute line/col for each marker in the clean text
  for (let i = 0; i < markerEntries.length; i++) {
    const cleanOffset = markerEntries[i].start - (offsets[i] - markerEntries[i].length);
    let line = 0;
    let col = 0;
    for (let j = 0; j < cleanOffset; j++) {
      if (clean[j] === "\n") {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    markers.set(markerEntries[i].name, { name: markerEntries[i].name, line, col });
  }

  return { clean, markers };
}

export interface DeclSpec {
  name: string;
  kind: SymbolKind;
  container: string;
  statePath?: string[];
}

export interface RefLocation {
  file: string;
  line: number;
  column: number;
}

export class SemanticTestHelper {
  si!: SymbolIndex;

  async init(): Promise<void> {
    this.si = new SymbolIndex();
    await this.si.initialize(
      path.resolve(__dirname, "../../tree-sitter-umple.wasm"),
    );
  }

  /**
   * Load and index fixture file(s). Returns clean content and markers per file,
   * plus a reachable file set.
   */
  indexFixtures(
    ...names: string[]
  ): {
    files: Map<string, { path: string; content: string; markers: Map<string, MarkerPosition> }>;
    reachable: Set<string>;
  } {
    const files = new Map<
      string,
      { path: string; content: string; markers: Map<string, MarkerPosition> }
    >();

    for (const name of names) {
      const filePath = path.resolve(FIXTURE_DIR, name);
      const raw = fs.readFileSync(filePath, "utf8");
      const { clean, markers } = extractMarkers(raw);
      const normalizedPath = path.normalize(filePath);
      this.si.indexFile(normalizedPath, clean);
      files.set(name, { path: normalizedPath, content: clean, markers });
    }

    // Build reachable set: all indexed files (for single-file tests this is just the file itself)
    // For cross-file tests, we need the use-statement resolution
    const reachable = new Set<string>();
    for (const f of files.values()) {
      reachable.add(f.path);
    }
    return { files, reachable };
  }

  /**
   * Index additional fixture files WITHOUT adding them to the reachable set.
   * Returns the files map (for marker lookup) but does not affect reachability.
   */
  indexUnreachable(
    ...names: string[]
  ): Map<string, { path: string; content: string; markers: Map<string, MarkerPosition> }> {
    const files = new Map<
      string,
      { path: string; content: string; markers: Map<string, MarkerPosition> }
    >();
    for (const name of names) {
      const filePath = path.resolve(FIXTURE_DIR, name);
      const raw = fs.readFileSync(filePath, "utf8");
      const { clean, markers } = extractMarkers(raw);
      const normalizedPath = path.normalize(filePath);
      this.si.indexFile(normalizedPath, clean);
      files.set(name, { path: normalizedPath, content: clean, markers });
    }
    return files;
  }

  /**
   * Load fixture file content and extract markers WITHOUT indexing.
   * Used to simulate files discovered by background scan but not yet opened.
   */
  loadWithoutIndexing(
    ...names: string[]
  ): Map<string, { path: string; content: string; markers: Map<string, MarkerPosition> }> {
    const files = new Map<
      string,
      { path: string; content: string; markers: Map<string, MarkerPosition> }
    >();
    for (const name of names) {
      const filePath = path.resolve(FIXTURE_DIR, name);
      const raw = fs.readFileSync(filePath, "utf8");
      const { clean, markers } = extractMarkers(raw);
      const normalizedPath = path.normalize(filePath);
      // Do NOT call indexFile — just store content and markers
      files.set(name, { path: normalizedPath, content: clean, markers });
    }
    return files;
  }

  /**
   * Inject use-graph edges for a file WITHOUT fully indexing it.
   * Simulates the background workspace scanner discovering a file's use statements.
   */
  injectUseGraphEdges(filePath: string, content: string): void {
    const uses = this.si.extractUseStatements(filePath, content);
    this.si.updateUseGraphEdges(filePath, uses);
  }

  /**
   * Find refs using the rename/reference pipeline:
   * 1. Use provided reachable set for forward-reachable files
   * 2. Compute reverse importers from the import graph
   * 3. Lazily index any reverse importers not yet fully indexed
   * 4. Search the combined scope
   */
  findRefsWithReverseImporters(
    decl: DeclSpec,
    reachable: Set<string>,
    fileContents: Map<string, string>,
  ): RefLocation[] {
    // Compute reverse importers from the import graph
    const declFiles = new Set<string>();
    const declarations = this.si.getSymbols({
      name: decl.name,
      kind: decl.kind,
      container: decl.container,
    });
    for (const d of declarations) {
      if (reachable.has(path.normalize(d.file))) {
        declFiles.add(path.normalize(d.file));
      }
    }

    const reverseImporters = this.si.getReverseImporters(declFiles);

    // Lazily index reverse importers that aren't fully indexed yet
    for (const file of reverseImporters) {
      if (!this.si.isFileIndexed(file)) {
        const content = fileContents.get(file);
        if (content) {
          this.si.indexFile(file, content);
        }
      }
    }

    // Build full search scope
    const filesToSearch = new Set([...reachable, ...reverseImporters]);

    // Filter declarations to full scope (including newly-indexed reverse importers)
    let allDecls = this.si.getSymbols({
      name: decl.name,
      kind: decl.kind,
      container: decl.container,
    });
    allDecls = allDecls.filter((d) => filesToSearch.has(path.normalize(d.file)));

    return this.si.findReferences(allDecls, filesToSearch, true).map((r) => ({
      file: r.file,
      line: r.line,
      column: r.column,
    }));
  }

  /**
   * Get raw token info at a position. Used for context-model assertions.
   */
  tokenAt(
    filePath: string,
    content: string,
    line: number,
    col: number,
  ) {
    return this.si.getTokenAtPosition(filePath, content, line, col);
  }

  /**
   * Resolve symbol(s) at a marker position. Uses the real production resolver.
   */
  resolve(
    filePath: string,
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
  ): { token: any; symbols: SymbolEntry[] } | null {
    return resolveSymbolAtPosition(this.si, filePath, content, line, col, reachable);
  }

  /**
   * Find references for a declaration spec.
   */
  findRefs(decl: DeclSpec, reachable: Set<string>): RefLocation[] {
    let declarations = this.si.getSymbols({
      name: decl.name,
      kind: decl.kind,
      container: decl.container,
    });
    if (decl.statePath) {
      declarations = declarations.filter(
        (d) =>
          d.statePath &&
          d.statePath.length === decl.statePath!.length &&
          d.statePath.every((seg, i) => seg === decl.statePath![i]),
      );
    }
    // Filter declarations to reachable files (matches production behavior:
    // server resolves target symbols filtered by reachable before calling findReferences)
    declarations = declarations.filter((d) => reachable.has(path.normalize(d.file)));
    return this.si.findReferences(declarations, reachable, true).map((r) => ({
      file: r.file,
      line: r.line,
      column: r.column,
    }));
  }

  /**
   * Find references with shared-state expansion (mirrors production pipeline).
   * Calls getSharedStateDeclarations before findReferences.
   */
  findSharedRefs(decl: DeclSpec, reachable: Set<string>): RefLocation[] {
    let declarations = this.si.getSymbols({
      name: decl.name,
      kind: decl.kind,
      container: decl.container,
    });
    if (decl.statePath) {
      declarations = declarations.filter(
        (d) =>
          d.statePath &&
          d.statePath.length === decl.statePath!.length &&
          d.statePath.every((seg, i) => seg === decl.statePath![i]),
      );
    }
    declarations = declarations.filter((d) => reachable.has(path.normalize(d.file)));
    // Expand to shared-state equivalence class
    declarations = this.si.getSharedStateDeclarations(declarations, reachable);
    return this.si.findReferences(declarations, reachable, true).map((r) => ({
      file: r.file,
      line: r.line,
      column: r.column,
    }));
  }

  /**
   * Get completion info at a position. Calls the real getCompletionInfo().
   */
  completionInfo(
    content: string,
    line: number,
    col: number,
  ): CompletionInfo {
    return this.si.getCompletionInfo(content, line, col);
  }

  /**
   * Get implementation locations for the class/interface/trait at the cursor.
   * Mirrors the production handler: resolve cursor → require exactly one
   * supported target symbol → walk `findIsAImplementers` over the reachable
   * scope. Returns deduplicated declaration locations. Empty array on
   * unsupported or zero/multiple-target resolution.
   */
  implementationsAt(
    filePath: string,
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
  ): RefLocation[] {
    const resolved = this.resolve(filePath, content, line, col, reachable);
    if (!resolved) return [];
    const targetSymbols = resolved.symbols.filter((s: SymbolEntry) =>
      s.kind === "class" || s.kind === "interface" || s.kind === "trait",
    );
    if (targetSymbols.length !== 1) return [];
    const target = targetSymbols[0];
    const implementers = this.si.findIsAImplementers(
      target.name,
      target.kind as "class" | "interface" | "trait",
      reachable,
    );
    return implementers.map((s: SymbolEntry) => ({
      file: s.file,
      line: s.line,
      column: s.column,
    }));
  }

  /**
   * Production-shaped find-implementations with reverse-
   * importer discovery and lazy indexing. Mirrors `connection.onImplementation`
   * in `server.ts`:
   *   1. Resolve cursor → require exactly one class/interface/trait symbol.
   *   2. Compute reverse importers for the trait's declaration files.
   *   3. Lazily index any reverse importers not yet indexed (using
   *      `fileContents` as the disk-shadow source).
   *   4. Add trait files + reverse importers to the search scope.
   *   5. Call `findTraitImplementers` over the unioned scope.
   *
   * Used by `use_graph_implementations` assertions to prove the cross-
   * file path goes through reverse-importer discovery (which is what the
   * production server does) rather than a pre-populated reachable set.
   */
  implementationsAtWithReverseImporters(
    filePath: string,
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
    fileContents: Map<string, string>,
  ): RefLocation[] {
    const resolved = this.resolve(filePath, content, line, col, reachable);
    if (!resolved) return [];
    const targetSymbols = resolved.symbols.filter((s: SymbolEntry) =>
      s.kind === "class" || s.kind === "interface" || s.kind === "trait",
    );
    if (targetSymbols.length !== 1) return [];
    const target = targetSymbols[0];

    const traitFiles = new Set([path.normalize(target.file)]);
    const fullScope = new Set<string>(reachable);
    for (const f of traitFiles) fullScope.add(f);

    const reverseImporters = this.si.getReverseImporters(traitFiles);
    for (const f of reverseImporters) {
      if (!this.si.isFileIndexed(f)) {
        const c = fileContents.get(f);
        if (c) this.si.indexFile(f, c);
      }
      fullScope.add(f);
    }

    const implementers = this.si.findIsAImplementers(
      target.name,
      target.kind as "class" | "interface" | "trait",
      fullScope,
    );
    return implementers.map((s: SymbolEntry) => ({
      file: s.file,
      line: s.line,
      column: s.column,
    }));
  }

  /**
   * Get completion items at a position. Uses the real production builder.
   */
  completionItems(
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
  ): CompletionItem[] {
    const info = this.si.getCompletionInfo(content, line, col);
    if (info.isComment || info.isDefinitionName || info.symbolKinds === "suppress") {
      return [];
    }
    // Skip use_path and trigger-character gating (those stay in server.ts)
    const symbolKinds = info.symbolKinds === "use_path" ? null : info.symbolKinds;
    if (!symbolKinds) return [];
    return buildSemanticCompletionItems(info, symbolKinds, this.si, reachable);
  }

  /**
   * Get completion items at a position with client snippet capability advertised.
   * Used by snippet regression tests; production server gates this on the
   * `textDocument.completion.completionItem.snippetSupport` capability bit.
   */
  completionItemsWithSnippets(
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
  ): CompletionItem[] {
    const info = this.si.getCompletionInfo(content, line, col);
    if (info.isComment || info.isDefinitionName || info.symbolKinds === "suppress") {
      return [];
    }
    const symbolKinds = info.symbolKinds === "use_path" ? null : info.symbolKinds;
    if (!symbolKinds) return [];
    return buildSemanticCompletionItems(info, symbolKinds, this.si, reachable, true);
  }

  /**
   * Get hover markdown for a symbol at a position.
   */
  hoverAt(
    filePath: string,
    content: string,
    line: number,
    col: number,
    reachable: Set<string>,
  ): string | null {
    const result = this.resolve(filePath, content, line, col, reachable);
    if (!result) return null;

    // Trait SM operation hover: use shared helper
    if (result.token.context.type === "trait_sm_op") {
      const ctx = result.token.context;
      return buildTraitSmOpHover(
        result.symbols,
        { word: result.token.word, context: ctx },
        (f, tn, sm, sp) => this.si.getEventSignatures(f, tn, sm, sp),
        () => {
          const traitSyms = this.si
            .getSymbols({ name: ctx.traitName, kind: ["trait"] as SymbolKind[] })
            .filter((s: SymbolEntry) => reachable.has(path.normalize(s.file)));
          return traitSyms.length > 0 ? traitSyms[0].file : undefined;
        },
      );
    }

    if (result.symbols.length === 0) return null;
    const sym = result.symbols[0];
    return buildHoverMarkdown(sym, result.symbols, {
      getTree: (fp: string) => this.si.getTree(fp),
      getIsAParents: (name: string) => this.si.getIsAParents(name),
    });
  }

  /**
   * Build document symbol tree for a file's symbols.
   */
  documentSymbols(filePath: string) {
    const symbols = this.si.getFileSymbols(filePath);
    return buildDocumentSymbolTree(symbols);
  }

  /**
   * Build workspace/symbol results from all currently indexed files.
   */
  workspaceSymbols(query: string) {
    return buildWorkspaceSymbols(this.si.getAllSymbols(), query);
  }

  /**
   * Build inlay hints for a file from its indexed parse tree.
   */
  inlayHints(filePath: string, range?: Range) {
    return buildInlayHints(this.si.getTree(filePath), range);
  }

  /**
   * Format a file and return the resulting lines.
   */
  formatFile(filePath: string, content: string): string[] {
    this.si.indexFile(filePath, content);
    let tree = this.si.getTree(filePath);
    if (!tree) return content.split("\n");

    // Skip formatting for broken files
    if (tree.rootNode.hasError) return content.split("\n");

    // Phase 0: expand compact state blocks
    let text = expandCompactStates(content, tree);
    if (text !== content) {
      this.si.indexFile(filePath, text);
      tree = this.si.getTree(filePath)!;
    }

    // Phase 1-3: formatting passes
    const indentEdits = computeIndentEdits(text, { tabSize: 2, insertSpaces: true }, tree);
    const spacingEdits = fixTransitionSpacing(text, tree);
    const assocEdits = fixAssociationSpacing(text, tree);
    const blankLineEdits = normalizeTopLevelBlankLines(text, tree);
    const codeEdits = reindentEmbeddedCode(text, { tabSize: 2, insertSpaces: true }, tree);
    const edits = [...indentEdits, ...spacingEdits, ...assocEdits, ...blankLineEdits, ...codeEdits];

    // Apply edits on the (possibly expanded) text
    const lines = text.split("\n");
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }

    const toOffset = (line: number, col: number) =>
      (lineOffsets[line] ?? text.length) + col;

    const sorted = [...edits].sort((a, b) => {
      const aOff = toOffset(a.range.start.line, a.range.start.character);
      const bOff = toOffset(b.range.start.line, b.range.start.character);
      return bOff - aOff; // reverse order
    });

    let result = text;
    for (const edit of sorted) {
      const start = toOffset(edit.range.start.line, edit.range.start.character);
      const end = toOffset(edit.range.end.line, edit.range.end.character);
      result = result.substring(0, start) + edit.newText + result.substring(end);
    }

    // Safety net: verify formatting preserved semantics (same as server.ts)
    const originalClean = !tree.rootNode.hasError;
    if (originalClean && result !== content) {
      const originalSymbols = this.si.getFileSymbols(filePath);
      this.si.indexFile(filePath, result);
      const formattedTree = this.si.getTree(filePath);
      const formattedClean = formattedTree ? !formattedTree.rootNode.hasError : false;
      const formattedSymbols = this.si.getFileSymbols(filePath);
      this.si.indexFile(filePath, content); // restore
      const check = checkFormatSafety(originalSymbols, formattedSymbols, originalClean, formattedClean);
      if (!check.safe) {
        throw new Error(`Format safety check failed: ${check.reason}`);
      }
    }

    return result.split("\n");
  }

  /**
   * Format a file with custom options (e.g., tab mode). Returns full text.
   */
  formatFileWithOptions(
    filePath: string,
    content: string,
    options: { tabSize: number; insertSpaces: boolean },
  ): string {
    this.si.indexFile(filePath, content);
    let tree = this.si.getTree(filePath);
    if (!tree) return content;

    // Skip formatting for broken files
    if (tree.rootNode.hasError) return content;

    let text = expandCompactStates(content, tree);
    if (text !== content) {
      this.si.indexFile(filePath, text);
      tree = this.si.getTree(filePath)!;
    }

    const indentEdits = computeIndentEdits(text, options, tree);
    const spacingEdits = fixTransitionSpacing(text, tree);
    const assocEdits = fixAssociationSpacing(text, tree);
    const blankLineEdits = normalizeTopLevelBlankLines(text, tree);
    const codeEdits = reindentEmbeddedCode(text, options, tree);
    const edits = [...indentEdits, ...spacingEdits, ...assocEdits, ...blankLineEdits, ...codeEdits];

    const lines = text.split("\n");
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }
    const toOffset = (line: number, col: number) =>
      (lineOffsets[line] ?? text.length) + col;
    const sorted = [...edits].sort((a, b) => {
      const aOff = toOffset(a.range.start.line, a.range.start.character);
      const bOff = toOffset(b.range.start.line, b.range.start.character);
      return bOff - aOff;
    });
    let result = text;
    for (const edit of sorted) {
      const start = toOffset(edit.range.start.line, edit.range.start.character);
      const end = toOffset(edit.range.end.line, edit.range.end.character);
      result = result.substring(0, start) + edit.newText + result.substring(end);
    }

    // Safety net (same as formatFile)
    if (result !== content) {
      const originalSymbols = this.si.getFileSymbols(filePath);
      this.si.indexFile(filePath, result);
      const formattedTree = this.si.getTree(filePath);
      const formattedClean = formattedTree ? !formattedTree.rootNode.hasError : false;
      const formattedSymbols = this.si.getFileSymbols(filePath);
      this.si.indexFile(filePath, content);
      const check = checkFormatSafety(originalSymbols, formattedSymbols, true, formattedClean);
      if (!check.safe) {
        throw new Error(`Format safety check failed: ${check.reason}`);
      }
    }

    return result;
  }

  /**
   * Get child state names for dotted completion testing.
   */
  childStates(
    parentPath: string[],
    smContainer: string,
    reachable: Set<string>,
  ): string[] {
    return this.si.getChildStateNames(parentPath, smContainer, reachable);
  }

  /**
   * Simulate the server's rename pipeline (prepareRename + rename) from a
   * cursor position. Returns:
   *   - `no-symbol`      — resolver produced nothing
   *   - `not-renameable` — kind is not in the renameable set
   *   - `ambiguous`      — multiple symbols, different identities
   *   - `invalid-name`   — newName failed the kind-aware validator
   *   - `ok` + edits     — list of ref positions that would be renamed
   * Uses the production resolver + findReferences, so behavior tracks
   * server.ts 1:1 without wiring LSP transport.
   */
  renameAt(
    filePath: string,
    content: string,
    line: number,
    col: number,
    newName: string,
    reachable: Set<string>,
    searchScope: Set<string> = reachable,
  ):
    | { status: "ok"; edits: RefLocation[] }
    | { status: "no-symbol" | "not-renameable" | "ambiguous" | "invalid-name" } {
    const resolved = this.resolve(filePath, content, line, col, reachable);
    if (!resolved || resolved.symbols.length === 0) return { status: "no-symbol" };
    const kind = resolved.symbols[0].kind;
    if (!isRenameableKind(kind)) return { status: "not-renameable" };
    // Same identity check as server.isUnambiguousRename for the top-level
    // mergeable kinds we care about here (requirement is same-name = same).
    const baseName = resolved.symbols[0].name;
    if (!resolved.symbols.every((s: SymbolEntry) => s.kind === kind && s.name === baseName)) {
      return { status: "ambiguous" };
    }
    if (!isValidNewName(kind, newName)) return { status: "invalid-name" };

    const target = resolved.symbols[0];
    const declarations = this.si.getSymbols({
      name: target.name,
      kind: target.kind,
    }).filter((candidate: SymbolEntry) =>
      searchScope.has(path.normalize(candidate.file)) &&
      candidate.name === target.name &&
      candidate.kind === target.kind &&
      this.isUnambiguousRename([...resolved.symbols, candidate]),
    );

    // Run find-references with the expanded declaration set — same pipeline
    // as the production rename request after it has computed its search scope.
    const edits = this.si
      .findReferences(declarations, searchScope, true)
      .map((r: any) => ({ file: r.file, line: r.line, column: r.column }));
    return { status: "ok", edits };
  }

  private isUnambiguousRename(symbols: SymbolEntry[]): boolean {
    if (symbols.length <= 1) return symbols.length === 1;
    const kind = symbols[0].kind;
    if (!symbols.every((s: SymbolEntry) => s.kind === kind)) return false;
    if (kind === "state") {
      const refPath = symbols[0].statePath?.join(".");
      return symbols.every((s: SymbolEntry) => s.statePath?.join(".") === refPath);
    }
    const containerScoped = new Set<SymbolKind>([
      "attribute",
      "const",
      "method",
      "template",
      "statemachine",
    ]);
    if (containerScoped.has(kind)) {
      const { container, name } = symbols[0];
      return symbols.every((s: SymbolEntry) => s.container === container && s.name === name);
    }
    const name = symbols[0].name;
    return symbols.every((s: SymbolEntry) => s.name === name);
  }
}
