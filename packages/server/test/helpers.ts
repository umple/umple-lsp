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
import { buildHoverMarkdown } from "../src/hoverBuilder";
import { buildDocumentSymbolTree } from "../src/documentSymbolBuilder";
import { expandCompactStates, computeIndentEdits, fixTransitionSpacing, fixAssociationSpacing, normalizeTopLevelBlankLines } from "../src/formatter";
import { CompletionItem } from "vscode-languageserver/node";

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
    if (!result || result.symbols.length === 0) return null;
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
   * Format a file and return the resulting lines.
   */
  formatFile(filePath: string, content: string): string[] {
    this.si.indexFile(filePath, content);
    let tree = this.si.getTree(filePath);
    if (!tree) return content.split("\n");

    // Phase 0: expand compact state blocks
    let text = expandCompactStates(content, tree);
    if (text !== content) {
      this.si.indexFile(filePath, text);
      tree = this.si.getTree(filePath)!;
    }

    // Phase 1-2: formatting passes
    const indentEdits = computeIndentEdits(text, { tabSize: 2, insertSpaces: true }, tree);
    const spacingEdits = fixTransitionSpacing(text, tree);
    const assocEdits = fixAssociationSpacing(text, tree);
    const blankLineEdits = normalizeTopLevelBlankLines(text, tree);
    const edits = [...indentEdits, ...spacingEdits, ...assocEdits, ...blankLineEdits];

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
    return result.split("\n");
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
}
