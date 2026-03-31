/**
 * Symbol Index for fast go-to-definition lookups.
 *
 * Uses tree-sitter (via WASM) for incremental parsing and maintains an
 * in-memory index of all symbol definitions in the workspace.
 */

import * as fs from "fs";
import * as path from "path";

// web-tree-sitter types and module
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Language = InstanceType<typeof TreeSitter.Language>;
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;
type Query = InstanceType<typeof TreeSitter.Query>;

// Re-export shared types from neutral modules
export type { SymbolKind, LookupContext, DottedStateRef, StateDefinitionRef, TokenResult } from "./tokenTypes";
export type { SymbolEntry, UseStatementWithPosition, ReferenceLocation } from "./symbolTypes";
import type { SymbolKind, TokenResult } from "./tokenTypes";
import type { SymbolEntry, ReferenceLocation, UseStatementWithPosition } from "./symbolTypes";
import { SYMBOL_KINDS_LONGEST_FIRST } from "./tokenTypes";
import { resolveEnclosingScope, resolveStatePath, stripSmPrefix } from "./treeUtils";
import { analyzeToken } from "./tokenAnalysis";
import { analyzeCompletion } from "./completionAnalysis";
import { searchReferences } from "./referenceSearch";
import { ImportGraph } from "./importGraph";
export type { CompletionInfo } from "./completionAnalysis";

interface FileIndex {
  symbols: SymbolEntry[];
  tree: Tree | null;
  contentHash: string;
}

export class SymbolIndex {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parser: any = null;
  private language: Language | null = null;
  private referencesQuery: Query | null = null;
  private definitionsQuery: Query | null = null;
  private completionsQuery: Query | null = null;
  private files: Map<string, FileIndex> = new Map();
  private symbolsByContainer: Map<string, SymbolEntry[]> = new Map();
  // Per-file isA relationships (for cleanup when a file is re-indexed)
  private isAByFile: Map<string, Map<string, string[]>> = new Map();
  // Global isA graph: className → parent names (merged from all files)
  private isAGraph: Map<string, string[]> = new Map();
  // Import graph: forward/reverse edge management
  private importGraph = new ImportGraph();
  // SM reuse bindings: aliasContainer → baseContainer
  // e.g., "MotorController.motorStatus" → "deviceStatus"
  private smReuseBindings: Map<string, string> = new Map();
  private smReuseByFile: Map<string, Map<string, string>> = new Map();
  private initialized = false;

  /**
   * Initialize the tree-sitter parser with the Umple grammar.
   * @param wasmPath Path to the tree-sitter-umple.wasm file
   */
  async initialize(wasmPath: string): Promise<boolean> {
    try {
      // Initialize the WASM module first
      await TreeSitter.Parser.init();

      // Create parser instance
      this.parser = new TreeSitter.Parser();

      // Load the WASM language
      this.language = await TreeSitter.Language.load(wasmPath);
      this.parser.setLanguage(this.language);

      // Load .scm queries (co-located with WASM after build)
      const queryDir = path.dirname(wasmPath);

      const referencesScmPath = path.join(queryDir, "references.scm");
      if (fs.existsSync(referencesScmPath)) {
        const src = fs.readFileSync(referencesScmPath, "utf-8");
        this.referencesQuery = new TreeSitter.Query(this.language, src);
      }

      const definitionsScmPath = path.join(queryDir, "definitions.scm");
      if (fs.existsSync(definitionsScmPath)) {
        const src = fs.readFileSync(definitionsScmPath, "utf-8");
        this.definitionsQuery = new TreeSitter.Query(this.language, src);
      }

      const completionsScmPath = path.join(queryDir, "completions.scm");
      if (fs.existsSync(completionsScmPath)) {
        const src = fs.readFileSync(completionsScmPath, "utf-8");
        this.completionsQuery = new TreeSitter.Query(this.language, src);
      }

      this.initialized = true;
      return true;
    } catch (err) {
      console.error("Failed to initialize tree-sitter parser:", err);
      this.parser = null;
      this.language = null;
      return false;
    }
  }

  /**
   * Check if the symbol index is ready to use.
   */
  isReady(): boolean {
    return this.initialized && this.parser !== null;
  }

  /**
   * Parse content with the tree-sitter parser. Returns the tree or null.
   * Used by diagramNavigation for AST walking outside the index.
   */
  parse(content: string): any {
    if (!this.parser) return null;
    return this.parser.parse(content);
  }

  /**
   * Check if a file has been fully indexed (has symbols + tree).
   */
  isFileIndexed(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /**
   * Remove import graph edges for a file (e.g., when it's deleted from disk).
   */
  removeImportEdges(filePath: string): void {
    this.importGraph.removeEdges(filePath);
  }

  /**
   * Update import graph edges for a file from its use statements,
   * WITHOUT full symbol indexing. Used by the async workspace use-graph scanner.
   * Skips files that are already fully indexed (their edges are fresh from didOpen/didChange).
   */
  updateUseGraphEdges(filePath: string, useStatements: string[]): void {
    // Don't overwrite edges for already-indexed files
    if (this.files.has(filePath)) return;

    const fileDir = path.dirname(filePath);
    const resolvedImports = new Set<string>();
    for (const usePath of useStatements) {
      if (!usePath.endsWith(".ump")) continue;
      const resolved = path.isAbsolute(usePath)
        ? path.normalize(usePath)
        : path.normalize(path.resolve(fileDir, usePath));
      if (fs.existsSync(resolved)) {
        resolvedImports.add(resolved);
      }
    }
    this.importGraph.setEdges(filePath, resolvedImports);
  }

  /**
   * Index a file or update its index if content changed.
   * @param filePath Absolute path to the file
   * @param content File content (optional, will be read from disk if not provided)
   * @returns true if the file was (re)indexed, false if cache hit
   */
  indexFile(filePath: string, content?: string): boolean {
    if (!this.parser) return false;

    const fileContent = content ?? this.readFileSafe(filePath);
    if (fileContent === null) return false;

    const hash = this.hashContent(fileContent);

    const existing = this.files.get(filePath);
    if (existing && existing.contentHash === hash) {
      // Content unchanged, skip re-indexing
      return false;
    }

    // Parse the file
    const tree = this.parser.parse(fileContent);

    // Remove old symbols for this file from the container index
    if (existing) {
      this.removeFileSymbols(filePath);
    }

    const newSymbols = this.extractSymbols(filePath, tree.rootNode);

    // Kind-sensitive error preservation: when the tree has errors,
    // live-update recovery-safe kinds (whose identity doesn't depend
    // on AST nesting) but preserve recovery-fragile kinds (state,
    // statemachine) from the last clean snapshot.
    let symbols: SymbolEntry[];
    if (tree.rootNode.hasError) {
      // High-confidence kinds safe to extract from error trees
      const RECOVERY_SAFE_KINDS: Set<SymbolKind> = new Set([
        "class", "interface", "trait", "enum",
        "mixset", "attribute", "const", "method",
        "statemachine", "state",
      ]);

      let liveSymbols = newSymbols.filter((s) => RECOVERY_SAFE_KINDS.has(s.kind));

      // Cold-open: filter out bogus symbols that pass normal extraction but
      // shouldn't be trusted in a broken file:
      // - empty-body statemachines (misparsed class boundaries)
      // - nested states (depth > 1) — path ambiguity too high
      if (!existing) {
        const SM_CONTENT = new Set(["state", "standalone_transition", "mixset_definition", "trace_statement"]);
        liveSymbols = liveSymbols.filter((s) => {
          if (s.kind === "statemachine") {
            // Reject empty-body SMs
            const smNode = tree.rootNode.descendantForPosition(
              { row: s.defLine ?? s.line, column: s.defColumn ?? s.column },
              { row: s.defEndLine ?? s.line, column: s.defEndColumn ?? s.column },
            );
            if (!smNode) return false;
            for (let ci = 0; ci < smNode.namedChildCount; ci++) {
              const c = smNode.namedChild(ci);
              if (c && SM_CONTENT.has(c.type)) return true;
            }
            return false;
          }
          if (s.kind === "state") {
            // Reject nested states (depth > 1)
            return !s.statePath || s.statePath.length <= 1;
          }
          return true;
        });
      }

      const preservedSymbols = existing
        ? existing.symbols.filter((s) => !RECOVERY_SAFE_KINDS.has(s.kind))
        : [];

      // Cold-open recovery: mark extracted symbols as recovered when no prior clean snapshot
      if (!existing) {
        for (const s of liveSymbols) {
          s.recovered = true;
        }
      }

      symbols = [...liveSymbols, ...preservedSymbols];
    } else {
      // Clean parse: clear any recovered flags from previous error state
      for (const s of newSymbols) {
        delete s.recovered;
      }
      symbols = newSymbols;
    }

    // Extract isA relationships
    const isAMap = this.extractIsARelationships(tree.rootNode);
    this.isAByFile.set(filePath, isAMap);
    this.rebuildIsAGraph();

    // Extract SM reuse bindings from referenced_statemachine nodes
    const reuseMap = this.extractSmReuseBindings(tree.rootNode);
    this.smReuseByFile.set(filePath, reuseMap);
    this.rebuildSmReuseBindings();

    // Store the file index
    this.files.set(filePath, {
      symbols,
      tree,
      contentHash: hash,
    });

    // Add symbols to the container index
    for (const symbol of symbols) {
      if (symbol.container) {
        const containerSyms =
          this.symbolsByContainer.get(symbol.container) ?? [];
        containerSyms.push(symbol);
        this.symbolsByContainer.set(symbol.container, containerSyms);
      }
    }

    // Update forward/reverse import maps
    this.updateImportMaps(filePath, fileContent);

    return true;
  }

  /**
   * Update a file with new content from the live editor.
   */
  updateFile(filePath: string, content: string): boolean {
    return this.indexFile(filePath, content);
  }

  /**
   * Unified symbol lookup. All old getters are replaced by this method.
   *
   * @param opts.container  Scope to this container (class name or SM name)
   * @param opts.kind       Filter by kind(s)
   * @param opts.name       Filter by symbol name
   * @param opts.inherited  Walk isA chain when container is specified
   */
  getSymbols(opts: {
    container?: string;
    kind?: SymbolKind | SymbolKind[];
    name?: string;
    inherited?: boolean;
  }): SymbolEntry[] {
    const kindSet = opts.kind
      ? new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind])
      : null;

    if (opts.container) {
      const result: SymbolEntry[] = [];
      if (opts.inherited) {
        this.collectFromContainerChain(
          opts.container,
          kindSet,
          opts.name,
          new Set(),
          result,
        );
      } else {
        const syms = this.symbolsByContainer.get(opts.container) ?? [];
        for (const s of syms) {
          if (kindSet && !kindSet.has(s.kind)) continue;
          if (opts.name && s.name !== opts.name) continue;
          result.push(s);
        }
      }
      return result;
    }

    // No container: iterate all containers
    const result: SymbolEntry[] = [];
    for (const syms of this.symbolsByContainer.values()) {
      for (const s of syms) {
        if (kindSet && !kindSet.has(s.kind)) continue;
        if (opts.name && s.name !== opts.name) continue;
        result.push(s);
      }
    }
    return result;
  }

  /**
   * Get all symbols defined in a specific file (for document outline).
   */
  getFileSymbols(filePath: string): SymbolEntry[] {
    return this.files.get(filePath)?.symbols ?? [];
  }


  /**
   * Get the parsed tree for a file (for formatting, etc.).
   */
  getTree(filePath: string): Tree | null {
    return this.files.get(filePath)?.tree ?? null;
  }

  /** Get the direct isA parents for a class name. */
  getIsAParents(className: string): string[] {
    return this.isAGraph.get(className) ?? [];
  }

  private collectFromContainerChain(
    container: string,
    kindSet: Set<SymbolKind> | null,
    name: string | undefined,
    visited: Set<string>,
    result: SymbolEntry[],
  ): void {
    if (visited.has(container)) return;
    visited.add(container);

    const syms = this.symbolsByContainer.get(container) ?? [];
    for (const s of syms) {
      if (kindSet && !kindSet.has(s.kind)) continue;
      if (name && s.name !== name) continue;
      result.push(s);
    }

    const parents = this.isAGraph.get(container);
    if (parents) {
      for (const parent of parents) {
        this.collectFromContainerChain(parent, kindSet, name, visited, result);
      }
    }
  }

  /**
   * Extract use statement paths from a file using tree-sitter.
   * @param filePath Path to the file
   * @param content File content (optional, will be read from disk if not provided)
   * @returns Array of use paths (without quotes)
   */
  extractUseStatements(filePath: string, content?: string): string[] {
    if (!this.initialized || !this.parser) {
      return [];
    }

    const fileContent = content ?? this.readFileSafe(filePath);
    if (!fileContent) {
      return [];
    }

    // Use cached tree if available and content matches
    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (fileIndex?.tree && !content) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(fileContent);
    }

    const usePaths: string[] = [];
    const visit = (node: SyntaxNode) => {
      if (node.type === "use_statement") {
        const pathNodes = node.childrenForFieldName("path");
        for (const pathNode of pathNodes) {
          usePaths.push(pathNode.text);
        }
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child);
        }
      }
    };

    visit(tree.rootNode);
    return usePaths;
  }

  /**
   * Extract use statement paths with their positions from a file using tree-sitter.
   * @param filePath Path to the file
   * @param content File content (optional, will be read from disk if not provided)
   * @returns Array of use statements with path and line number
   */
  extractUseStatementsWithPositions(
    filePath: string,
    content?: string,
  ): UseStatementWithPosition[] {
    if (!this.initialized || !this.parser) {
      return [];
    }

    const fileContent = content ?? this.readFileSafe(filePath);
    if (!fileContent) {
      return [];
    }

    // Use cached tree if available and content matches
    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (fileIndex?.tree && !content) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(fileContent);
    }

    const useStatements: UseStatementWithPosition[] = [];
    const visit = (node: SyntaxNode) => {
      if (node.type === "use_statement") {
        const pathNodes = node.childrenForFieldName("path");
        for (const pathNode of pathNodes) {
          useStatements.push({
            path: pathNode.text,
            line: node.startPosition.row,
          });
        }
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child);
        }
      }
    };

    visit(tree.rootNode);
    return useStatements;
  }

  /**
   * Get completion information at a position.
   * Delegates to the pure analyzeCompletion() function after tree acquisition.
   */
  getCompletionInfo(
    content: string,
    line: number,
    column: number,
  ): import("./completionAnalysis").CompletionInfo {
    const empty = {
      keywords: [] as string[],
      operators: [] as string[],
      symbolKinds: null as any,
      isDefinitionName: false,
      isComment: false,
      prefix: "",
    };

    if (!this.initialized || !this.parser || !this.language || !this.completionsQuery) {
      return empty;
    }

    const tree = this.parser.parse(content);
    if (!tree) return empty;

    return analyzeCompletion(tree, this.language, this.completionsQuery, content, line, column);
  }

  /**
   * Get the token (identifier) at a position using tree-sitter, along with
   * context information for symbol resolution.
   *
   * Delegates to the pure analyzeToken() function after tree acquisition.
   */
  getTokenAtPosition(
    filePath: string,
    content: string,
    line: number,
    column: number,
  ): TokenResult | null {
    if (!this.initialized || !this.parser || !this.referencesQuery) {
      return null;
    }

    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (
      fileIndex?.tree &&
      fileIndex.contentHash === this.hashContent(content)
    ) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(content);
    }

    return analyzeToken(tree, this.referencesQuery, line, column);
  }

  /**
   * Get the exact range of the token node at a position.
   * Used by prepareRename to return the precise rename range.
   * Accepts the same node types as getTokenAtPosition(): identifier,
   * use_path, and filter_pattern.
   */
  getNodeRangeAtPosition(
    filePath: string,
    content: string,
    line: number,
    column: number,
  ): {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null {
    if (!this.initialized || !this.parser) return null;

    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (
      fileIndex?.tree &&
      fileIndex.contentHash === this.hashContent(content)
    ) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(content);
    }

    const node = tree.rootNode.descendantForPosition({ row: line, column });
    if (
      !node ||
      (node.type !== "identifier" &&
        node.type !== "use_path" &&
        node.type !== "filter_pattern" &&
        node.type !== "req_id")
    ) {
      return null;
    }

    return {
      startLine: node.startPosition.row,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row,
      endColumn: node.endPosition.column,
    };
  }

  /**
   * Use the references.scm query to determine which symbol kinds an
   * identifier can reference based on its position in the AST.
   *
   * The query captures identifiers with names like @reference.class_interface_trait,
   * encoding the valid symbol kinds directly. This replaces the old parent-chain
   * walking approach with a declarative .scm file.
   */
  /**
   * Get the names of direct child states of a given state path within a state machine.
   * Uses pre-computed statePath on each SymbolEntry for O(n) lookup without AST walking.
   *
   * @param parentPath Path segments to the parent state (e.g., ["EEE", "Open"])
   * @param smContainer Qualified SM container (e.g., "ClassName.smName")
   * @returns Names of direct child states of the resolved parent
   */
  getChildStateNames(
    parentPath: string[],
    smContainer: string,
    reachableFiles?: Set<string>,
  ): string[] {
    if (parentPath.length === 0) return [];

    const effectivePath = stripSmPrefix(parentPath, smContainer);
    if (effectivePath.length === 0) return [];

    const allStates = this.getSymbols({
      container: smContainer,
      kind: "state",
    });
    const names = new Set<string>();

    for (const s of allStates) {
      if (reachableFiles && !reachableFiles.has(path.normalize(s.file)))
        continue;
      if (!s.statePath || s.statePath.length < effectivePath.length + 1)
        continue;
      // Suffix match: check if effectivePath matches the segments ending
      // just before the child name (e.g., ["Closed"] matches tail of ["EEE","Closed","Inner"])
      const suffixStart = s.statePath.length - effectivePath.length - 1;
      let match = true;
      for (let i = 0; i < effectivePath.length; i++) {
        if (s.statePath[suffixStart + i] !== effectivePath[i]) {
          match = false;
          break;
        }
      }
      if (match) names.add(s.name);
    }

    return [...names];
  }

  /**
   * Resolve a state within a dotted path context, returning the matching SymbolEntry.
   * Uses pre-computed statePath for exact path matching without AST walking.
   *
   * @param precedingPath Path segments before the target (e.g., ["EEE", "Open"])
   * @param targetName The target state name (e.g., "Inner")
   * @param smContainer Qualified SM container (e.g., "ClassName.smName")
   * @returns The SymbolEntry for the target state, or undefined if not found
   */
  resolveStateInPath(
    precedingPath: string[],
    targetName: string,
    smContainer: string,
    reachableFiles?: Set<string>,
  ): SymbolEntry | undefined {
    if (precedingPath.length === 0) return undefined;

    const effectivePath = stripSmPrefix(precedingPath, smContainer);
    const targetPath = [...effectivePath, targetName];

    let candidates = this.getSymbols({
      container: smContainer,
      kind: "state",
      name: targetName,
    });
    if (reachableFiles) {
      candidates = candidates.filter((s) =>
        reachableFiles.has(path.normalize(s.file)),
      );
    }

    // Suffix match: targetPath may be a partial path (e.g., ["Closed","Inner"])
    // that matches the tail of a full statePath (e.g., ["EEE","Closed","Inner"])
    return candidates.find((s) => {
      if (!s.statePath || s.statePath.length < targetPath.length) return false;
      const offset = s.statePath.length - targetPath.length;
      for (let i = 0; i < targetPath.length; i++) {
        if (s.statePath[offset + i] !== targetPath[i]) return false;
      }
      return true;
    });
  }

  // =====================
  // Private methods
  // =====================

  private readFileSafe(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private removeFileSymbols(filePath: string): void {
    const fileIndex = this.files.get(filePath);
    if (!fileIndex) return;

    for (const symbol of fileIndex.symbols) {
      if (symbol.container) {
        const containerSyms = this.symbolsByContainer.get(symbol.container);
        if (containerSyms) {
          const filtered = containerSyms.filter((s) => s.file !== filePath);
          if (filtered.length === 0) {
            this.symbolsByContainer.delete(symbol.container);
          } else {
            this.symbolsByContainer.set(symbol.container, filtered);
          }
        }
      }
    }
  }

  private hashContent(content: string): string {
    // Simple hash for change detection
    // For production, consider using crypto.createHash('sha256')
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Extract isA relationships from the AST.
   * Returns a map of className → parent names.
   */
  private extractIsARelationships(rootNode: SyntaxNode): Map<string, string[]> {
    const isAMap = new Map<string, string[]>();
    const visit = (node: SyntaxNode) => {
      if (node.type === "isa_declaration") {
        // Find enclosing class name
        let parent = node.parent;
        while (
          parent &&
          ![
            "class_definition",
            "trait_definition",
            "interface_definition",
            "association_class_definition",
          ].includes(parent.type)
        ) {
          parent = parent.parent;
        }
        const className = parent?.childForFieldName("name")?.text;
        if (!className) return;

        // Extract parent names from type_list → type_name → qualified_name
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === "type_list") {
            for (let j = 0; j < child.childCount; j++) {
              const tn = child.child(j);
              if (tn?.type === "type_name") {
                for (let k = 0; k < tn.childCount; k++) {
                  const qn = tn.child(k);
                  if (qn?.type === "qualified_name") {
                    const parents = isAMap.get(className) ?? [];
                    parents.push(qn.text);
                    isAMap.set(className, parents);
                  }
                }
              }
            }
          }
        }
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child);
        }
      }
    };
    visit(rootNode);
    return isAMap;
  }

  /** Rebuild the global isA graph from all per-file isA maps. */
  private rebuildIsAGraph(): void {
    this.isAGraph.clear();
    for (const fileIsA of this.isAByFile.values()) {
      for (const [className, parents] of fileIsA) {
        const existing = this.isAGraph.get(className) ?? [];
        existing.push(...parents);
        this.isAGraph.set(className, existing);
      }
    }
  }

  /**
   * Extract SM reuse bindings from referenced_statemachine nodes.
   * E.g., "motorStatus as deviceStatus { ... }" inside class MotorController
   * produces: "MotorController.motorStatus" → "deviceStatus"
   */
  private extractSmReuseBindings(
    rootNode: SyntaxNode,
  ): Map<string, string> {
    const bindings = new Map<string, string>();
    function walk(node: SyntaxNode, className?: string) {
      if (
        ["class_definition", "trait_definition", "interface_definition",
         "association_class_definition"].includes(node.type)
      ) {
        className = node.childForFieldName("name")?.text ?? className;
      }
      if (node.type === "referenced_statemachine") {
        const aliasName = node.childForFieldName("name")?.text;
        const baseName = node.childForFieldName("definition")?.text;
        if (aliasName && baseName && className) {
          bindings.set(`${className}.${aliasName}`, baseName);
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, className);
      }
    }
    walk(rootNode);
    return bindings;
  }

  private rebuildSmReuseBindings(): void {
    this.smReuseBindings.clear();
    for (const fileBindings of this.smReuseByFile.values()) {
      for (const [alias, base] of fileBindings) {
        this.smReuseBindings.set(alias, base);
      }
    }
  }

  /**
   * Get the ordered candidate containers for a state machine container.
   * For a reused SM: returns [aliasContainer, baseContainer].
   * For a normal SM: returns [container].
   */
  getSmContainerCandidates(smContainer: string): string[] {
    const candidates = [smContainer];
    const base = this.smReuseBindings.get(smContainer);
    if (base) candidates.push(base);
    return candidates;
  }

  /**
   * Get the shared declaration set for a state that may exist in both
   * an alias container and its base standalone SM.
   * Returns declarations from both containers when the same statePath exists in both.
   * For unique local states, returns only the local declaration.
   */
  getSharedStateDeclarations(
    declarations: SymbolEntry[],
    reachableFiles?: Set<string>,
  ): SymbolEntry[] {
    if (declarations.length === 0) return declarations;
    const sym = declarations[0];
    if (sym.kind !== "state") return declarations;

    const container = sym.container;
    if (!container) return declarations;

    // Build the full equivalence class of containers:
    // 1. If container is an alias → include its base
    // 2. If container is a base → include ALL aliases that reuse it
    // 3. If container is an alias → also include sibling aliases of the same base
    const equivalentContainers = new Set<string>([container]);

    // Find the base for this container (if it's an alias)
    const base = this.smReuseBindings.get(container);
    const baseContainer = base || container;

    // If this is an alias, add the base
    if (base) equivalentContainers.add(base);

    // Find ALL aliases that map to the same base
    for (const [alias, baseName] of this.smReuseBindings) {
      if (baseName === baseContainer) {
        equivalentContainers.add(alias);
      }
    }

    // If no equivalence found beyond the original, return as-is
    if (equivalentContainers.size <= 1) return declarations;

    // Gather declarations from all equivalent containers with matching name/path
    const combined: SymbolEntry[] = [...declarations];
    for (const eqContainer of equivalentContainers) {
      if (eqContainer === container) continue; // already in declarations
      const candidates = this.getSymbols({
        name: sym.name,
        kind: "state",
        container: eqContainer,
      }).filter(
        (s) =>
          (!reachableFiles || reachableFiles.has(path.normalize(s.file))) &&
          (!sym.statePath || !s.statePath ||
           sym.statePath.join(".") === s.statePath.join(".")),
      );
      combined.push(...candidates);
    }

    // Deduplicate
    const seen = new Set<string>();
    return combined.filter((s) => {
      const key = `${s.file}:${s.line}:${s.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** For attributes/methods: walk up to find the enclosing class name. */
  private resolveClassContainer(node: SyntaxNode): string | undefined {
    let current = node.parent;
    while (current) {
      if (
        [
          "class_definition",
          "trait_definition",
          "interface_definition",
          "association_class_definition",
        ].includes(current.type)
      ) {
        return current.childForFieldName("name")?.text;
      }
      current = current.parent;
    }
    return undefined;
  }

  /**
   * For states/statemachines: walk up to find the ROOT (outermost) state machine name.
   * All states share the same container so nested states can target any state at any level.
   */
  private resolveStateMachineContainer(node: SyntaxNode): string | undefined {
    let rootSmName: string | undefined;
    let className: string | undefined;
    let current = node.parent;
    while (current) {
      if (current.type === "state_machine" || current.type === "referenced_statemachine") {
        rootSmName = current.childForFieldName("name")?.text ?? rootSmName;
      }
      if (current.type === "statemachine_definition") {
        rootSmName = current.childForFieldName("name")?.text ?? rootSmName;
      }
      if (
        !className &&
        [
          "class_definition",
          "trait_definition",
          "interface_definition",
          "association_class_definition",
        ].includes(current.type)
      ) {
        className = current.childForFieldName("name")?.text;
      }
      current = current.parent;
    }
    if (!rootSmName) return undefined;
    return className ? `${className}.${rootSmName}` : rootSmName;
  }

  /** For enum values: walk up to find the enclosing enum_definition name. */
  private resolveEnumContainer(node: SyntaxNode): string | undefined {
    let current = node.parent;
    while (current) {
      if (current.type === "enum_definition") {
        return current.childForFieldName("name")?.text;
      }
      current = current.parent;
    }
    return undefined;
  }

  /**
   * Build the nesting path for a state by walking up parent state nodes.
   * E.g., for Inner inside Open inside EEE: ["EEE", "Open", "Inner"]
   */
  /**
   * Extract symbol definitions from the AST using the definitions.scm query.
   * Falls back to an empty list if the query isn't loaded.
   */
  private extractSymbols(
    filePath: string,
    rootNode: SyntaxNode,
  ): SymbolEntry[] {
    if (!this.definitionsQuery) return [];

    const captures = this.definitionsQuery.captures(rootNode);
    const symbols: SymbolEntry[] = [];

    for (const capture of captures) {
      const prefix = "definition.";
      if (!capture.name.startsWith(prefix)) continue;
      const kind = capture.name.substring(prefix.length) as SymbolKind;
      const node = capture.node;

      let container: string | undefined;
      if (kind === "state" || kind === "statemachine") {
        container = this.resolveStateMachineContainer(node);
      } else if (
        kind === "attribute" ||
        kind === "const" ||
        kind === "method" ||
        kind === "template" ||
        kind === "tracecase"
      ) {
        container = this.resolveClassContainer(node);
      } else if (kind === "enum_value") {
        // Enum values belong to their enclosing enum
        container = this.resolveEnumContainer(node);
      } else {
        // Top-level symbols (class, interface, trait, enum, etc.) are self-containers
        container = node.text;
      }

      const defNode = node.parent;

      // Skip symbols from malformed subtrees: if the definition node itself
      // has errors, the captured name may be garbage (e.g., "BROKEN" parsed
      // as an attribute name). Top-level kinds (class, interface, trait, enum)
      // are exempt — their name is reliable even in partial trees.
      // Methods get a refined check: recover if the method_declaration node
      // type is correct AND the name field is present (valid declaration shape).
      if (defNode?.hasError) {
        const TOP_LEVEL_KINDS: Set<string> = new Set([
          "class", "interface", "trait", "enum", "mixset",
        ]);
        if (TOP_LEVEL_KINDS.has(kind)) {
          // Always recover top-level kinds
        } else if (kind === "method" && defNode.type === "method_declaration" && !defNode.isError) {
          // Method recovery: accept if name field is valid and no ERROR exists
          // between the name and the body opener `{`. ERROR before the name
          // (return type/modifiers) is tolerated — tree-sitter often wraps those
          // in ERROR during recovery but the method identity is still reliable.
          const nameNode = defNode.childForFieldName("name");
          if (!nameNode || nameNode.type !== "identifier") continue;
          let hasPostNameError = false;
          let pastName = false;
          for (let ci = 0; ci < defNode.childCount; ci++) {
            const c = defNode.child(ci);
            if (!pastName) {
              if (c.startIndex === nameNode.startIndex) pastName = true;
              continue;
            }
            if (c.type === "{") break; // reached body — stop
            if (c.type === "ERROR" || c.isError) { hasPostNameError = true; break; }
          }
          if (hasPostNameError) continue;
        } else if (kind === "statemachine") {
          // SM recovery: accept if node type is correct, name field exists,
          // not itself an ERROR node, and body has real SM content.
          const SM_TYPES = new Set(["state_machine", "statemachine_definition"]);
          if (!SM_TYPES.has(defNode.type) || defNode.isError) continue;
          const smNameNode = defNode.childForFieldName("name");
          if (!smNameNode || smNameNode.type !== "identifier") continue;
          // Class-local SMs: require resolvable enclosing class
          if (defNode.type === "state_machine") {
            const classContainer = this.resolveClassContainer(node);
            if (!classContainer) continue;
          }
          // Require at least one SM-content child to reject bogus empty SMs
          // (e.g., "class B {}" misparsed as a state_machine inside a broken class)
          const SM_CONTENT = new Set(["state", "standalone_transition", "mixset_definition", "trace_statement"]);
          let hasContent = false;
          for (let ci = 0; ci < defNode.namedChildCount; ci++) {
            const c = defNode.namedChild(ci);
            if (c && SM_CONTENT.has(c.type)) { hasContent = true; break; }
          }
          if (!hasContent) continue;
        } else if (kind === "state") {
          // State recovery (V2b): only depth-1 direct children of a valid SM.
          if (defNode.type !== "state" || defNode.isError) continue;
          const stateNameNode = defNode.childForFieldName("name");
          if (!stateNameNode || stateNameNode.type !== "identifier") continue;
          // No ERROR in header before `{`
          let hasHeaderError = false;
          for (let ci = 0; ci < defNode.childCount; ci++) {
            const c = defNode.child(ci);
            if (c.type === "{") break;
            if (c.type === "ERROR" || c.isError) { hasHeaderError = true; break; }
          }
          if (hasHeaderError) continue;
          // Depth-1 only: statePath must have exactly 1 element
          const sp = resolveStatePath(stateNameNode);
          if (sp.length !== 1) continue;
        } else {
          continue;
        }
      }

      const entry: SymbolEntry = {
        name: node.text,
        kind,
        file: filePath,
        line: node.startPosition.row,
        column: node.startPosition.column,
        endLine: node.endPosition.row,
        endColumn: node.endPosition.column,
        container,
        defLine: defNode?.startPosition.row,
        defColumn: defNode?.startPosition.column,
        defEndLine: defNode?.endPosition.row,
        defEndColumn: defNode?.endPosition.column,
      };
      if (kind === "state") {
        entry.statePath = resolveStatePath(node);
      }
      symbols.push(entry);
    }
    return symbols;
  }

  // ── Workspace indexing & import graph ──────────────────────────────────

  /**
   * Scan workspace roots for all .ump files, follow use chains to external
   * files, and index everything. Content-hash skips unchanged files.
   *
   * @param workspaceRoots Workspace root directories
   * @param getOpenDocContent Returns in-memory editor content if the file is open, undefined otherwise
   */
  indexWorkspace(
    workspaceRoots: string[],
    getOpenDocContent: (filePath: string) => string | undefined,
  ): void {
    if (!this.initialized || !this.parser) return;

    // 1. Discover all .ump files under workspace roots
    const discoveredFiles = new Set<string>();
    for (const root of workspaceRoots) {
      this.globUmpFiles(root, discoveredFiles);
    }

    // 2. Index each discovered file (open-doc content takes precedence)
    for (const filePath of discoveredFiles) {
      const openContent = getOpenDocContent(filePath);
      if (openContent !== undefined) {
        this.indexFile(filePath, openContent);
      } else {
        this.indexFile(filePath);
      }
    }

    // 3. Follow use chains to index external files (outside workspace roots)
    //    Only treat an external file as live if it's open in the editor or exists on disk.
    //    This prevents stale forward-import edges from re-adding deleted files.
    const externalFiles = new Set<string>();
    for (const filePath of discoveredFiles) {
      const imports = this.importGraph.getForward(filePath);
      if (imports) {
        for (const imp of imports) {
          if (
            !discoveredFiles.has(imp) &&
            !externalFiles.has(imp) &&
            (getOpenDocContent(imp) !== undefined || fs.existsSync(imp))
          ) {
            externalFiles.add(imp);
          }
        }
      }
    }
    // Index external files and follow their chains too (transitive)
    const queue = [...externalFiles];
    while (queue.length > 0) {
      const filePath = queue.pop()!;
      const openContent = getOpenDocContent(filePath);
      if (openContent !== undefined) {
        this.indexFile(filePath, openContent);
      } else {
        this.indexFile(filePath);
      }
      const imports = this.importGraph.getForward(filePath);
      if (imports) {
        for (const imp of imports) {
          if (
            !discoveredFiles.has(imp) &&
            !externalFiles.has(imp) &&
            (getOpenDocContent(imp) !== undefined || fs.existsSync(imp))
          ) {
            externalFiles.add(imp);
            queue.push(imp);
          }
        }
      }
    }

    // 4. Remove stale indexed files.
    //    A file is removed if it's not in the discovered/external set AND not open in the editor.
    //    Note: fs.existsSync is intentionally NOT checked here — a file that still exists on disk
    //    but is no longer reachable (e.g., use statement removed) should be dropped from the index.
    const allKnownFiles = new Set([...discoveredFiles, ...externalFiles]);
    for (const filePath of this.files.keys()) {
      if (
        !allKnownFiles.has(filePath) &&
        getOpenDocContent(filePath) === undefined
      ) {
        this.removeFile(filePath);
      }
    }
  }

  /**
   * Get all files whose use chain can reach any of the given declaration files.
   * Transitive reverse closure.
   */
  getReverseImporters(declarationFiles: Set<string>): Set<string> {
    return this.importGraph.getReverseImporters(declarationFiles);
  }

  /**
   * Find all references to a symbol across the given files.
   * Delegates to the extracted searchReferences() function.
   */
  findReferences(
    declarations: SymbolEntry[],
    filesToSearch: Set<string>,
    includeDeclaration: boolean,
  ): ReferenceLocation[] {
    if (!this.referencesQuery || declarations.length === 0) return [];

    // Build filePath→tree map for the files to search
    const fileTreeMap = new Map<string, any>();
    for (const fp of filesToSearch) {
      const tree = this.files.get(fp)?.tree;
      if (tree) fileTreeMap.set(fp, tree);
    }

    return searchReferences(
      declarations,
      includeDeclaration,
      this.referencesQuery,
      fileTreeMap,
      this.isAGraph,
      this.smReuseBindings,
    );
  }

  /**
   * Update forward/reverse import maps for a file.
   */
  private updateImportMaps(filePath: string, content: string): void {
    // Compute resolved imports from use statements
    const usePaths = this.extractUseStatements(filePath, content);
    const fileDir = path.dirname(filePath);
    const newImports = new Set<string>();
    for (const usePath of usePaths) {
      if (!usePath.endsWith(".ump")) continue;
      const resolved = path.isAbsolute(usePath)
        ? path.normalize(usePath)
        : path.normalize(path.resolve(fileDir, usePath));
      if (fs.existsSync(resolved)) {
        newImports.add(resolved);
      }
    }
    // Delegate edge management to ImportGraph
    this.importGraph.setEdges(filePath, newImports);
  }

  /**
   * Fully remove a file from the index (symbols, imports, isA).
   */
  private removeFile(filePath: string): void {
    this.removeFileSymbols(filePath);
    this.files.delete(filePath);
    this.importGraph.removeEdges(filePath);
    this.isAByFile.delete(filePath);
    this.rebuildIsAGraph();
    this.smReuseByFile.delete(filePath);
    this.rebuildSmReuseBindings();
  }

  /**
   * Recursively find all .ump files under a directory.
   */
  private globUmpFiles(dir: string, result: Set<string>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common non-source directories
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "out") {
          continue;
        }
        this.globUmpFiles(fullPath, result);
      } else if (entry.name.endsWith(".ump")) {
        result.add(path.normalize(fullPath));
      }
    }
  }

}

// Singleton instance
export const symbolIndex = new SymbolIndex();
