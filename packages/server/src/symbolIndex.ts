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
import type { SymbolKind, TokenResult } from "./tokenTypes";
import { SYMBOL_KINDS_LONGEST_FIRST } from "./tokenTypes";
import { resolveEnclosingScope, resolveStatePath } from "./treeUtils";
import { analyzeToken } from "./tokenAnalysis";
import { analyzeCompletion } from "./completionAnalysis";
export type { CompletionInfo } from "./completionAnalysis";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 0-indexed, name identifier position
  column: number; // 0-indexed
  endLine: number;
  endColumn: number;
  container?: string; // Enclosing class (for attributes/methods) or root SM (for states)
  // Definition node range (full body extent, e.g., class_definition start to closing })
  defLine?: number;
  defColumn?: number;
  defEndLine?: number;
  defEndColumn?: number;
  // For states: nesting path from root SM, e.g., ["EEE", "Open", "Inner"]
  statePath?: string[];
}

export interface UseStatementWithPosition {
  path: string; // Original path from use statement (e.g., "Teacher" or "Teacher.ump")
  line: number; // 0-indexed line number
}

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
  // Forward import graph: file → set of files it imports via `use`
  private forwardImports: Map<string, Set<string>> = new Map();
  // Reverse import graph: file → set of files that import it
  private reverseImports: Map<string, Set<string>> = new Map();
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
      const LIVE_KINDS: Set<SymbolKind> = new Set([
        "class", "interface", "trait", "enum",
        "mixset", "attribute", "const",
      ]);

      const liveSymbols = newSymbols.filter((s) => LIVE_KINDS.has(s.kind));
      const preservedSymbols = existing
        ? existing.symbols.filter((s) => !LIVE_KINDS.has(s.kind))
        : [];
      symbols = [...liveSymbols, ...preservedSymbols];
    } else {
      symbols = newSymbols;
    }

    // Extract isA relationships
    const isAMap = this.extractIsARelationships(tree.rootNode);
    this.isAByFile.set(filePath, isAMap);
    this.rebuildIsAGraph();

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
        node.type !== "filter_pattern")
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

    const effectivePath = this.stripSmPrefix(parentPath, smContainer);
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

    const effectivePath = this.stripSmPrefix(precedingPath, smContainer);
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

  /**
   * Strip a leading state-machine name from a dotted path if it matches
   * the bare SM name of the container. E.g., path ["bulb","EEE"] with
   * container "TrafficLight.bulb" → ["EEE"].
   */
  private stripSmPrefix(pathSegments: string[], smContainer: string): string[] {
    const dotIdx = smContainer.lastIndexOf(".");
    const bareSmName =
      dotIdx >= 0 ? smContainer.substring(dotIdx + 1) : smContainer;
    if (pathSegments[0] === bareSmName) {
      return pathSegments.slice(1);
    }
    return pathSegments;
  }

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
      if (current.type === "state_machine") {
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
      const imports = this.forwardImports.get(filePath);
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
      const imports = this.forwardImports.get(filePath);
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
    const result = new Set<string>();
    const queue = [...declarationFiles];
    while (queue.length > 0) {
      const file = queue.pop()!;
      const importers = this.reverseImports.get(file);
      if (!importers) continue;
      for (const importer of importers) {
        if (!result.has(importer) && !declarationFiles.has(importer)) {
          result.add(importer);
          queue.push(importer);
        }
      }
    }
    return result;
  }

  /**
   * Find all references to a symbol across the given files.
   * Uses references.scm query to find candidate sites, then filters
   * by name, kind, and container/path context.
   */
  findReferences(
    declarations: SymbolEntry[],
    filesToSearch: Set<string>,
    includeDeclaration: boolean,
  ): { file: string; line: number; column: number; endLine: number; endColumn: number }[] {
    if (!this.referencesQuery || declarations.length === 0) return [];

    const sym = declarations[0];
    const symName = sym.name;
    const symKind = sym.kind;
    const symContainer = sym.container;

    // Collect definition positions for deduplication and includeDeclaration
    const defPositions = new Set<string>();
    for (const d of declarations) {
      defPositions.add(`${d.file}:${d.line}:${d.column}:${d.endLine}:${d.endColumn}`);
    }

    // Container-scoped kinds need enclosing scope verification
    const containerScopedKinds = new Set<SymbolKind>([
      "attribute", "const", "method", "template", "state", "statemachine", "tracecase",
    ]);
    const isContainerScoped = containerScopedKinds.has(symKind);

    const results: { file: string; line: number; column: number; endLine: number; endColumn: number }[] = [];
    const seen = new Set<string>();

    const addResult = (file: string, line: number, column: number, endLine: number, endColumn: number) => {
      const key = `${file}:${line}:${column}:${endLine}:${endColumn}`;
      if (seen.has(key)) return;
      // Skip definition sites unless includeDeclaration
      if (!includeDeclaration && defPositions.has(key)) return;
      seen.add(key);
      results.push({ file, line, column, endLine, endColumn });
    };

    // If includeDeclaration, add all definition sites first
    if (includeDeclaration) {
      for (const d of declarations) {
        addResult(d.file, d.line, d.column, d.endLine, d.endColumn);
      }
    }

    // Scan each file
    for (const filePath of filesToSearch) {
      const fileIndex = this.files.get(filePath);
      if (!fileIndex?.tree) continue;

      const captures = this.referencesQuery.captures(fileIndex.tree.rootNode);

      for (const capture of captures) {
        const node = capture.node;
        if (node.text !== symName) continue;

        // Parse capture name to get reference kinds
        const refKinds = this.parseCaptureKinds(capture.name);
        if (!refKinds || !refKinds.includes(symKind)) continue;

        // For container-scoped kinds, verify enclosing scope matches
        if (isContainerScoped && symContainer) {
          const enclosing = this.resolveEnclosingScopeFromNode(node, symKind);
          if (enclosing && enclosing !== symContainer) {
            // Check inheritance: enclosing class may inherit from container's class
            if (symKind === "state" || symKind === "statemachine") {
              // SM container is "ClassName.smName" — no inheritance walk needed,
              // must match exactly
              continue;
            }
            // For attribute/method/etc: enclosing is class name, check isA chain
            const containerClass = symContainer;
            if (!this.isInheritanceChain(enclosing, containerClass)) {
              continue;
            }
          }
        }

        // For trait_sm_binding value paths, filter by segment position and depth
        const valSegIdx = this.getTraitSmBindingValueSegmentIndex(node);
        if (valSegIdx !== undefined) {
          // Kind filtering: segment 0 = statemachine only, segment 1+ = state only
          if (valSegIdx === 0 && symKind !== "statemachine") continue;
          if (valSegIdx > 0 && symKind !== "state") continue;

          // Depth filtering: segment index must match statePath length
          if (symKind === "state" && sym.statePath &&
              valSegIdx !== sym.statePath.length) continue;
        }

        // For nested states, disambiguate by path context.
        // Three cases:
        //   1. Dotted path (inside qualified_name, index > 0): compare preceding segments
        //   2. Definition site (node.parent is "state"): walk ancestor states, exact path match
        //   3. Bare reference (everything else): no path synthesis, existing rules apply
        if (symKind === "state" && sym.statePath && sym.statePath.length >= 1) {
          const pathCtx = this.extractPathContextFromNode(node);
          if (pathCtx) {
            // Case 1: dotted path (transition target or trait_sm_binding value)
            let preceding = pathCtx.preceding;
            // Strip SM name prefix for trait_sm_binding value paths
            // (first segment is the SM name, not a state ancestor)
            if (
              node.parent?.parent?.type === "trait_sm_binding" &&
              node.parent?.parent?.childForFieldName("value")?.id ===
                node.parent?.id
            ) {
              preceding = preceding.slice(1);
            }
            const targetPrecedingPath = sym.statePath.slice(0, sym.statePath.length - 1);
            if (!this.pathMatches(preceding, targetPrecedingPath, true)) {
              continue;
            }
          } else if (node.parent?.type === "state") {
            // Case 2: state definition name (e.g., Open {})
            const candidatePath = resolveStatePath(node);
            if (!this.pathMatches(candidatePath, sym.statePath, false)) {
              continue;
            }
          }
          // Case 3: bare reference — fall through, no path filtering
        }

        addResult(
          filePath,
          node.startPosition.row,
          node.startPosition.column,
          node.endPosition.row,
          node.endPosition.column,
        );
      }
    }

    return results;
  }

  /**
   * Parse a references.scm capture name into symbol kinds.
   * e.g., "reference.class_interface_trait" → ["class", "interface", "trait"]
   */
  private parseCaptureKinds(captureName: string): SymbolKind[] | null {
    const prefix = "reference.";
    if (!captureName.startsWith(prefix)) return null;
    let rest = captureName.substring(prefix.length);
    const kinds: SymbolKind[] = [];
    while (rest.length > 0) {
      const match = SYMBOL_KINDS_LONGEST_FIRST.find((k) => rest.startsWith(k));
      if (!match) break;
      kinds.push(match);
      rest = rest.substring(match.length);
      if (rest.startsWith("_")) rest = rest.substring(1);
    }
    return kinds.length > 0 ? kinds : null;
  }

  /**
   * Resolve the enclosing container for a node, for scoped reference matching.
   * Returns the container string (e.g., "ClassName" for attributes, "ClassName.smName" for states).
   */
  private resolveEnclosingScopeFromNode(
    node: SyntaxNode,
    targetKind: SymbolKind,
  ): string | undefined {
    let current: SyntaxNode | null = node.parent;
    let enclosingClass: string | undefined;
    let enclosingSM: string | undefined;

    while (current) {
      if (current.type === "state_machine" || current.type === "statemachine_definition") {
        enclosingSM = current.childForFieldName("name")?.text ?? enclosingSM;
      }
      if (
        !enclosingClass &&
        ["class_definition", "trait_definition", "interface_definition", "association_class_definition"].includes(current.type)
      ) {
        enclosingClass = current.childForFieldName("name")?.text;
      }
      current = current.parent;
    }

    if (targetKind === "state" || targetKind === "statemachine") {
      if (enclosingClass && enclosingSM) return `${enclosingClass}.${enclosingSM}`;
      if (enclosingSM) return enclosingSM; // top-level statemachine
      // Synthetic container for trait_sm_binding value paths (no enclosing SM ancestor)
      if (enclosingClass) {
        const smName = this.resolveTraitSmBindingValueSM(node);
        if (smName) return `${enclosingClass}.${smName}`;
        // Synthetic container for referenced_statemachine definition field
        // "door as status" → container is "ClassName.status"
        const refSmName = this.resolveReferencedSmDefinition(node);
        if (refSmName) return `${enclosingClass}.${refSmName}`;
      }
      return undefined;
    }

    // Synthetic container for toplevel_code_injection operation
    // "before { Counter } increment()" → container is "Counter"
    if (!enclosingClass && targetKind === "method") {
      const parent = node.parent;
      if (
        parent?.type === "toplevel_code_injection" &&
        parent.childForFieldName("operation")?.id === node.id
      ) {
        const targetNode = parent.childForFieldName("target");
        if (targetNode) return targetNode.text;
      }
    }

    return enclosingClass;
  }

  /**
   * If the node is inside a trait_sm_binding value qualified_name,
   * return the first identifier segment (the statemachine name).
   */
  private resolveTraitSmBindingValueSM(node: SyntaxNode): string | undefined {
    const parent = node.parent;
    if (parent?.type !== "qualified_name") return undefined;
    const grandparent = parent.parent;
    if (grandparent?.type !== "trait_sm_binding") return undefined;
    if (grandparent.childForFieldName("value")?.id !== parent.id) return undefined;
    const firstId = parent.namedChild(0);
    return firstId?.type === "identifier" ? firstId.text : undefined;
  }

  /**
   * If the node is the definition field of a referenced_statemachine
   * ("door as status"), return the SM name ("status").
   */
  private resolveReferencedSmDefinition(node: SyntaxNode): string | undefined {
    const parent = node.parent;
    if (parent?.type !== "referenced_statemachine") return undefined;
    if (parent.childForFieldName("definition")?.id !== node.id) return undefined;
    return node.text;
  }

  /**
   * Return the 0-based segment index if this node is an identifier inside
   * a trait_sm_binding value path, or undefined otherwise.
   */
  private getTraitSmBindingValueSegmentIndex(node: SyntaxNode): number | undefined {
    const parent = node.parent;
    if (parent?.type !== "qualified_name") return undefined;
    const grandparent = parent.parent;
    if (grandparent?.type !== "trait_sm_binding") return undefined;
    if (grandparent.childForFieldName("value")?.id !== parent.id) return undefined;
    let idx = 0;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child?.type === "identifier") {
        if (child.id === node.id) return idx;
        idx++;
      }
    }
    return undefined;
  }

  /**
   * Check if childClass inherits from parentClass (directly or transitively).
   */
  private isInheritanceChain(childClass: string, parentClass: string): boolean {
    const visited = new Set<string>();
    const queue = [childClass];
    while (queue.length > 0) {
      const cls = queue.pop()!;
      if (cls === parentClass) return true;
      if (visited.has(cls)) continue;
      visited.add(cls);
      const parents = this.isAGraph.get(cls);
      if (parents) queue.push(...parents);
    }
    return false;
  }

  /**
   * Extract dotted path context for a state reference node inside a qualified_name.
   * Returns the preceding path segments, or null if not in a qualified_name.
   */
  private extractPathContextFromNode(
    node: SyntaxNode,
  ): { preceding: string[] } | null {
    const parent = node.parent;
    if (!parent || parent.type !== "qualified_name") return null;

    const segments: string[] = [];
    let nodeIndex = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child?.type === "identifier") {
        if (child.id === node.id) nodeIndex = segments.length;
        segments.push(child.text);
      }
    }
    if (nodeIndex <= 0) return null; // first segment or not found
    return { preceding: segments.slice(0, nodeIndex) };
  }

  /**
   * Check if an actual path matches the target path.
   * When suffix is true, actual may be a relative path matching the tail of target.
   * When suffix is false, requires exact full-path match.
   */
  private pathMatches(actual: string[], target: string[], suffix: boolean): boolean {
    if (suffix) {
      if (actual.length > target.length) return false;
      const offset = target.length - actual.length;
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== target[offset + i]) return false;
      }
      return true;
    }
    if (actual.length !== target.length) return false;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== target[i]) return false;
    }
    return true;
  }

  /**
   * Update forward/reverse import maps for a file.
   */
  private updateImportMaps(filePath: string, content: string): void {
    // Remove old forward edges from reverse map
    const oldImports = this.forwardImports.get(filePath);
    if (oldImports) {
      for (const imp of oldImports) {
        const rev = this.reverseImports.get(imp);
        if (rev) {
          rev.delete(filePath);
          if (rev.size === 0) this.reverseImports.delete(imp);
        }
      }
    }

    // Compute new forward imports
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
    this.forwardImports.set(filePath, newImports);

    // Add new reverse edges
    for (const imp of newImports) {
      let rev = this.reverseImports.get(imp);
      if (!rev) {
        rev = new Set();
        this.reverseImports.set(imp, rev);
      }
      rev.add(filePath);
    }
  }

  /**
   * Fully remove a file from the index (symbols, imports, isA).
   */
  private removeFile(filePath: string): void {
    this.removeFileSymbols(filePath);
    this.files.delete(filePath);

    // Clean import maps
    const oldImports = this.forwardImports.get(filePath);
    if (oldImports) {
      for (const imp of oldImports) {
        const rev = this.reverseImports.get(imp);
        if (rev) {
          rev.delete(filePath);
          if (rev.size === 0) this.reverseImports.delete(imp);
        }
      }
    }
    this.forwardImports.delete(filePath);
    // Also remove as a target in reverse map
    this.reverseImports.delete(filePath);

    // Clean isA
    this.isAByFile.delete(filePath);
    this.rebuildIsAGraph();
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
