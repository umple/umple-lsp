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

export type SymbolKind =
  | "class"
  | "interface"
  | "trait"
  | "enum"
  | "enum_value"
  | "const"
  | "attribute"
  | "state"
  | "statemachine"
  | "method"
  | "association"
  | "mixset"
  | "requirement"
  | "template"
  | "tracecase";

/** All SymbolKind values sorted longest-first for greedy capture name parsing. */
const SYMBOL_KINDS_LONGEST_FIRST: SymbolKind[] = (
  [
    "class",
    "interface",
    "trait",
    "enum",
    "enum_value",
    "const",
    "attribute",
    "state",
    "statemachine",
    "method",
    "association",
    "mixset",
    "requirement",
    "template",
    "tracecase",
  ] as SymbolKind[]
).sort((a, b) => b.length - a.length);

/**
 * Keywords after which the next token is always a new name (definition).
 * Completions are suppressed when the cursor immediately follows one of these.
 */
const DEFINITION_KEYWORDS = new Set([
  "class",
  "interface",
  "trait",
  "enum",
  "mixset",
  "req",
  "associationClass",
  "statemachine",
  "namespace",
  // State machine modifiers — next token is SM name (or another modifier)
  "queued",
  "pooled",
  // Emit methods — next token is the method name
  "emit",
]);

/** Structural tokens that should NOT appear in completions. */
const STRUCTURAL_TOKENS = new Set([
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  ".",
  "<",
  ">",
  "=",
  "/",
  "[]",
  "*",
  "||",
]);

function isOperatorToken(name: string): boolean {
  // Matches association/transition arrows: --, ->, <-, <@>-, -<@>, >->, <-<
  return /^[<>-]/.test(name) && name.length > 1;
}

/** Information needed by the completion handler. */
export interface CompletionInfo {
  /** Keywords the parser expects at this position. */
  keywords: string[];
  /** Operators the parser expects at this position. */
  operators: string[];
  /** Which symbol kinds to offer, or null for none. */
  symbolKinds: SymbolKind[] | "suppress" | "use_path" | "own_attribute" | "guard_attribute_method" | "trace_attribute_method" | null;
  /** True if cursor is at a definition-name position (suppress all). */
  isDefinitionName: boolean;
  /** True if cursor is inside a comment. */
  isComment: boolean;
  /** Text of the token at the cursor (identifier or use_path), empty if none. */
  prefix: string;
  /** Name of enclosing class (for scoped attribute lookups). */
  enclosingClass?: string;
  /** Name of enclosing root state machine (for scoped state lookups). */
  enclosingStateMachine?: string;
  /** Dotted path prefix for state completions (e.g., ["EEE", "Open"] when typing "EEE.Open."). */
  dottedStatePrefix?: string[];
}

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
   * Get completion information at a position using LookaheadIterator + scope query.
   *
   * Operates on the ORIGINAL parse tree (no dummy insertion). Uses:
   * 1. Previous leaf node's nextParseState → LookaheadIterator for keywords
   * 2. completions.scm query for symbol kind detection
   * 3. Simple tree checks for comments, definition names
   *
   * @param content The document text (original)
   * @param line 0-indexed cursor line
   * @param column 0-indexed cursor column
   * @returns CompletionInfo with keywords, operators, and symbol kinds
   */
  getCompletionInfo(
    content: string,
    line: number,
    column: number,
  ): CompletionInfo {
    const empty: CompletionInfo = {
      keywords: [],
      operators: [],
      symbolKinds: null,
      isDefinitionName: false,
      isComment: false,
      prefix: "",
    };

    if (!this.initialized || !this.parser || !this.language) {
      return empty;
    }

    // Parse original text (no dummy insertion)
    const tree = this.parser.parse(content);
    if (!tree) return empty;

    // --- Comment check ---
    // Use column - 1 to land inside the token when cursor is at its end boundary
    // (tree-sitter uses half-open intervals [start, end))
    const nodeAtCursor = tree.rootNode.descendantForPosition({
      row: line,
      column: Math.max(0, column - 1),
    });
    if (nodeAtCursor && this.isInsideComment(nodeAtCursor)) {
      return { ...empty, isComment: true };
    }

    // --- Extract prefix from the token at cursor ---
    let prefix = "";
    if (
      column > 0 &&
      nodeAtCursor &&
      (nodeAtCursor.type === "identifier" || nodeAtCursor.type === "use_path")
    ) {
      const nodeStartCol =
        nodeAtCursor.startPosition.row === line
          ? nodeAtCursor.startPosition.column
          : 0;
      prefix = nodeAtCursor.text.substring(0, column - nodeStartCol);
    }

    // --- Definition name check ---
    const lastToken = this.lastTokenBeforeCursor(content, line, column);
    if (
      (lastToken && DEFINITION_KEYWORDS.has(lastToken)) ||
      this.isAtAttributeNamePosition(tree, content, line, column)
    ) {
      return { ...empty, isDefinitionName: true };
    }

    // --- LookaheadIterator for keywords ---
    const prevLeaf = this.findPreviousLeaf(tree, content, line, column);
    // When no previous token exists (file start / after only comments),
    // use the node at cursor's parseState instead of state 0.
    // State 0 is the initial LR state which is overly broad.
    const stateId = prevLeaf
      ? prevLeaf.nextParseState
      : (nodeAtCursor?.parseState ?? 0);
    const keywords: string[] = [];
    const operators: string[] = [];

    const iter = this.language.lookaheadIterator(stateId);
    if (iter) {
      try {
        for (const symbolName of iter) {
          const typeId = iter.currentTypeId;
          // Skip named nodes (identifier, type_name, etc.)
          if (this.language.nodeTypeIsNamed(typeId)) continue;
          // Skip structural tokens
          if (STRUCTURAL_TOKENS.has(symbolName)) continue;

          if (isOperatorToken(symbolName)) {
            operators.push(symbolName);
          } else if (/^[a-zA-Z]/.test(symbolName)) {
            keywords.push(symbolName);
          }
        }
      } finally {
        iter.delete(); // MUST free WASM memory
      }
    }

    // --- Scope query for symbol kinds ---
    let symbolKinds = this.resolveCompletionScope(tree, line, column);

    // --- before/after method-name completion (position-aware) ---
    // Only the first direct identifier child of before_after is the method name.
    // Param types, param names, and code bodies are not direct identifier children.
    // Additional guard: cursor column must fall within the identifier's span to avoid
    // false positives when nodeAtCursor (at column-1) bleeds into the method name
    // while the real cursor is past it (e.g., at the '(' of a param list).
    const baNode = nodeAtCursor?.type === "identifier" && nodeAtCursor.parent?.type === "before_after"
      ? nodeAtCursor : (prevLeaf?.type === "identifier" && prevLeaf.parent?.type === "before_after" ? prevLeaf : null);
    if (baNode && line === baNode.startPosition.row && column <= baNode.endPosition.column) {
      const firstId = baNode.parent!.namedChildren.find((c: SyntaxNode) => c.type === "identifier");
      if (firstId && firstId.id === baNode.id) {
        symbolKinds = ["method"];
      }
    }

    // --- Trace completion fallback for zero-identifier case ("trace |") ---
    // When the user types "trace " without an identifier, tree-sitter produces
    // ERROR, so the completions.scm anchored capture doesn't match. Detect via
    // prevLeaf being the "trace" keyword inside an ERROR node.
    if (prevLeaf?.type === "trace" && prevLeaf.parent?.type === "ERROR") {
      symbolKinds = "trace_attribute_method";
    }

    // --- Zero-identifier completion fallbacks ---
    // When the user types "keyword |" without an identifier yet, tree-sitter
    // produces ERROR nodes and completions.scm can't match. Detect via prevLeaf.
    const CLASS_LIKE_TYPES = new Set([
      "class_definition", "trait_definition",
      "interface_definition", "association_class_definition",
    ]);

    // "isA |" in class/trait/interface body — exclude enum from completion
    if (prevLeaf?.type === "isA" && prevLeaf.parent?.type === "ERROR") {
      const errorParent = prevLeaf.parent.parent;
      if (errorParent && CLASS_LIKE_TYPES.has(errorParent.type)) {
        symbolKinds = ["class", "interface", "trait"];
      }
    }

    // "before |" or "after |" in class body — method completion (no body parsed yet)
    if (
      (prevLeaf?.type === "before" || prevLeaf?.type === "after") &&
      prevLeaf.parent?.type === "ERROR"
    ) {
      const errorParent = prevLeaf.parent.parent;
      if (errorParent && CLASS_LIKE_TYPES.has(errorParent.type)) {
        symbolKinds = ["method"];
      }
    }

    // "as |" in referenced_statemachine context — offer statemachines
    if (prevLeaf?.type === "as" && prevLeaf.parent?.type === "ERROR") {
      const errorParent = prevLeaf.parent.parent;
      if (
        errorParent &&
        (CLASS_LIKE_TYPES.has(errorParent.type) || errorParent.type === "attribute_declaration")
      ) {
        symbolKinds = ["statemachine"];
      }
    }

    // "-> |" inside statemachine — state completion
    if (prevLeaf?.type === "->" && prevLeaf.parent?.type === "ERROR") {
      let n: SyntaxNode | null = prevLeaf.parent;
      while (n) {
        if (n.type === "state_machine" || n.type === "statemachine_definition") {
          symbolKinds = ["state"];
          break;
        }
        if (n.type === "class_definition" || n.type === "source_file") break;
        n = n.parent;
      }
    }

    // --- Enclosing scope for scoped lookups ---
    const { enclosingClass, enclosingStateMachine } =
      this.resolveEnclosingScope(tree, line, column);

    // --- Dotted state prefix for path-scoped completions ---
    // Gate on enclosingStateMachine rather than symbolKinds from the scope
    // query — the scope query can fail on errored trees where we still want
    // dotted completion.  Being inside a state machine + detecting "->" on
    // the line is a sufficient safety check (isInTransitionTarget validates).
    let dottedStatePrefix: string[] | undefined;
    if (
      enclosingStateMachine &&
      this.isInTransitionTarget(tree, line, column, content)
    ) {
      const lineText = content.split("\n")[line] ?? "";
      let pos = column;
      while (pos > 0 && /[a-zA-Z_0-9]/.test(lineText[pos - 1])) {
        pos--;
      }
      if (pos > 0 && lineText[pos - 1] === ".") {
        dottedStatePrefix = this.extractDottedPrefix(lineText, pos - 1);
      }
    }

    return {
      keywords,
      operators,
      symbolKinds,
      isDefinitionName: false,
      isComment: false,
      prefix,
      enclosingClass,
      enclosingStateMachine,
      dottedStatePrefix,
    };
  }

  /**
   * Get the token (identifier) at a position using tree-sitter, along with
   * an optional SymbolKind filter based on the surrounding context.
   *
   * Uses the references.scm query to determine which symbol kinds are valid
   * for the cursor's context. See queries/references.scm for supported patterns.
   */
  getTokenAtPosition(
    filePath: string,
    content: string,
    line: number,
    column: number,
  ): {
    word: string;
    kinds: SymbolKind[] | null;
    enclosingClass?: string;
    enclosingStateMachine?: string;
    qualifiedPath?: string[];
    pathIndex?: number;
    stateDefinitionPath?: string[];
    traitSmContext?: { traitName: string };
    traitSmValueContext?: { pathSegments: string[]; segmentIndex: number };
    referencedSmContext?: { enclosingClass: string };
  } | null {
    if (!this.initialized || !this.parser) {
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

    const node = tree.rootNode.descendantForPosition({ row: line, column });
    if (
      !node ||
      (node.type !== "identifier" &&
        node.type !== "use_path" &&
        node.type !== "filter_pattern")
    ) {
      return null;
    }

    // For filter_pattern: skip wildcards (contain * or ?) and exclusion patterns
    // (start with ~) — neither has a meaningful go-to-def target.
    let word = node.text;
    if (node.type === "filter_pattern") {
      if (/[*?]/.test(word) || word.startsWith("~")) {
        return null;
      }
    }
    let kinds = this.resolveDefinitionKinds(tree, node);
    const { enclosingClass, enclosingStateMachine } =
      this.resolveEnclosingScope(tree, line, column);

    // Detect dotted state path in transition targets
    let qualifiedPath: string[] | undefined;
    let pathIndex: number | undefined;
    const parent = node.parent;
    if (node.type === "identifier" && parent?.type === "qualified_name") {
      const grandparent = parent.parent;
      if (grandparent?.type === "transition") {
        const targetNode = grandparent.childForFieldName("target");
        if (targetNode?.id === parent.id) {
          const ids: string[] = [];
          let idx = -1;
          for (let i = 0; i < parent.namedChildCount; i++) {
            const child = parent.namedChild(i);
            if (child?.type === "identifier") {
              if (child.id === node.id) idx = ids.length;
              ids.push(child.text);
            }
          }
          if (ids.length > 1 && idx >= 0) {
            qualifiedPath = ids;
            pathIndex = idx;
          }
        }
      }
    }

    // Detect state definition names — identifier is the `name` field of a `state` node
    let stateDefinitionPath: string[] | undefined;
    if (
      node.type === "identifier" &&
      parent?.type === "state" &&
      parent.childForFieldName("name")?.id === node.id
    ) {
      stateDefinitionPath = this.resolveStatePath(node);
    }

    // Detect trait_sm_binding param: isA T1<sm1 as sm.s2> — sm1 references
    // a statemachine in the trait, not in the current class.
    // AST: type_name > trait_sm_binding > param:identifier
    let traitSmContext: { traitName: string } | undefined;
    if (
      node.type === "identifier" &&
      parent?.type === "trait_sm_binding" &&
      parent.childForFieldName("param")?.id === node.id
    ) {
      const typeName = parent.parent;
      if (typeName?.type === "type_name") {
        const qn = typeName.childForFieldName("name") ?? typeName.namedChild(0);
        if (qn?.type === "qualified_name") {
          // Use last identifier segment (handles qualified names like ns1.ns2.T1)
          const lastId = qn.namedChild(qn.namedChildCount - 1);
          if (lastId?.type === "identifier") {
            traitSmContext = { traitName: lastId.text };
          }
        }
      }
    }

    // Detect trait_sm_binding value: isA T1<sm1 as sm.s2> — sm.s2 references
    // class-side statemachine and state. First segment = SM, rest = states.
    // AST: trait_sm_binding > value:qualified_name > identifier
    let traitSmValueContext:
      | { pathSegments: string[]; segmentIndex: number }
      | undefined;
    if (
      node.type === "identifier" &&
      parent?.type === "qualified_name" &&
      parent.parent?.type === "trait_sm_binding" &&
      parent.parent.childForFieldName("value")?.id === parent.id
    ) {
      const segments: string[] = [];
      let idx = -1;
      for (let i = 0; i < parent.namedChildCount; i++) {
        const child = parent.namedChild(i);
        if (child?.type === "identifier") {
          if (child.id === node.id) idx = segments.length;
          segments.push(child.text);
        }
      }
      if (idx >= 0 && segments.length >= 1) {
        traitSmValueContext = { pathSegments: segments, segmentIndex: idx };
        // Override kinds: first segment = statemachine, rest = state
        kinds = idx === 0 ? ["statemachine"] : ["state"];
      }
    }

    // Detect referenced_statemachine: "door as status" — definition field
    // references an SM in the enclosing class, not an enclosing SM ancestor.
    let referencedSmContext: { enclosingClass: string } | undefined;
    if (
      node.type === "identifier" &&
      parent?.type === "referenced_statemachine" &&
      parent.childForFieldName("definition")?.id === node.id &&
      enclosingClass
    ) {
      referencedSmContext = { enclosingClass };
    }

    // Detect default-value qualifier in "Status.ACTIVE" — non-final segment
    // is an enum name, not a value. Override kinds for qualifier position.
    // AST: attribute_declaration > qualified_name (not inside type_name) > identifier
    if (
      node.type === "identifier" &&
      parent?.type === "qualified_name" &&
      parent.namedChildCount > 1
    ) {
      const gp = parent.parent;
      if (gp?.type === "attribute_declaration" || gp?.type === "const_declaration") {
        const isLastSegment = parent.namedChild(parent.namedChildCount - 1)?.id === node.id;
        if (!isLastSegment) {
          kinds = ["enum"];
        }
      }
    }

    return {
      word,
      kinds,
      enclosingClass,
      enclosingStateMachine,
      qualifiedPath,
      pathIndex,
      stateDefinitionPath,
      traitSmContext,
      traitSmValueContext,
      referencedSmContext,
    };
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
  private resolveDefinitionKinds(
    tree: Tree,
    node: SyntaxNode,
  ): SymbolKind[] | null {
    if (!this.referencesQuery) return null;

    // Run query with position filtering to find captures at this node
    const captures = this.referencesQuery.captures(tree.rootNode, {
      startPosition: node.startPosition,
      endPosition: node.endPosition,
    });

    // Find the capture whose node best matches our target.
    // When multiple patterns capture the same node (e.g. isA type matched
    // by both type_name and isa_declaration), pick the most specific:
    //   1. Smallest node size (fewest bytes)
    //   2. Fewest kinds in the capture name (fewer = more specific)
    let bestCapture: { name: string; node: SyntaxNode } | null = null;
    let bestSize = Infinity;
    let bestKindCount = Infinity;
    for (const capture of captures) {
      if (
        capture.node.startIndex <= node.startIndex &&
        capture.node.endIndex >= node.endIndex
      ) {
        const size = capture.node.endIndex - capture.node.startIndex;
        const kindCount = capture.name.split("_").length;
        if (
          size < bestSize ||
          (size === bestSize && kindCount < bestKindCount)
        ) {
          bestSize = size;
          bestKindCount = kindCount;
          bestCapture = capture;
        }
      }
    }

    if (!bestCapture) return null;

    // Parse capture name: "reference.class_interface_trait" → ["class", "interface", "trait"]
    // Must match against known SymbolKind values to handle multi-word kinds like "enum_value"
    const prefix = "reference.";
    if (!bestCapture.name.startsWith(prefix)) return null;
    let rest = bestCapture.name.substring(prefix.length);
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
   * Find the previous non-extra leaf node before the cursor position.
   * Skips the current partial word being typed and any whitespace.
   *
   * @param tree    The (original, un-modified) parse tree
   * @param content The document text
   * @param line    0-indexed cursor line
   * @param column  0-indexed cursor column
   * @returns The previous leaf node, or null if cursor is at file start
   */
  private findPreviousLeaf(
    tree: Tree,
    content: string,
    line: number,
    column: number,
  ): SyntaxNode | null {
    // Convert (line, column) to absolute offset
    const lines = content.split("\n");
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    offset += Math.min(column, lines[line]?.length ?? 0);

    // Skip the current partial identifier backwards
    let pos = offset;
    while (pos > 0 && /[a-zA-Z_0-9]/.test(content[pos - 1])) {
      pos--;
    }

    // Skip whitespace backwards
    while (pos > 0 && /\s/.test(content[pos - 1])) {
      pos--;
    }

    if (pos === 0) return null;

    // Find the node at (pos - 1) — the last character before the gap
    let node = tree.rootNode.descendantForIndex(pos - 1, pos - 1);
    if (!node) return null;

    // Skip extra nodes (comments) by walking to previous siblings
    while (node && node.isExtra) {
      const prev = node.previousSibling;
      if (prev) {
        node = prev;
        while (node.childCount > 0) {
          node = node.lastChild!;
        }
      } else if (node.parent) {
        node = node.parent;
      } else {
        return null;
      }
    }

    // Walk to leaf
    while (node && node.childCount > 0) {
      node = node.lastChild!;
    }

    return node;
  }

  /**
   * Run completions.scm to find the innermost scope at the cursor position.
   * Returns symbol kinds to offer, "suppress", "use_path", or null (keywords only).
   */
  private resolveCompletionScope(
    tree: Tree,
    line: number,
    column: number,
  ): SymbolKind[] | "suppress" | "use_path" | "own_attribute" | "guard_attribute_method" | "trace_attribute_method" | null {
    if (!this.completionsQuery) return null;

    // Don't pass position filtering to the query — tree-sitter uses
    // half-open intervals [start, end), so a point query at a node's
    // exact end boundary misses it (e.g., `use Per|` at use_statement's
    // end). The manual containment check below uses inclusive boundaries
    // and handles this correctly.
    const captures = this.completionsQuery.captures(tree.rootNode);

    // Find the innermost (smallest) scope that contains the cursor
    let best: { name: string; size: number } | null = null;
    for (const capture of captures) {
      const node = capture.node;
      const startOk =
        node.startPosition.row < line ||
        (node.startPosition.row === line &&
          node.startPosition.column <= column);
      const endOk =
        node.endPosition.row > line ||
        (node.endPosition.row === line && node.endPosition.column >= column);

      if (startOk && endOk) {
        const size = node.endIndex - node.startIndex;
        if (!best || size < best.size) {
          best = { name: capture.name, size };
        }
      }
    }

    if (!best) return null;

    const prefix = "scope.";
    if (!best.name.startsWith(prefix)) return null;
    const kindStr = best.name.substring(prefix.length);

    if (kindStr === "suppress") return "suppress";
    if (kindStr === "use_path") return "use_path";
    if (kindStr === "own_attribute") return "own_attribute";
    if (kindStr === "guard_attribute_method") return "guard_attribute_method";
    if (kindStr === "trace_attribute_method") return "trace_attribute_method";
    if (kindStr === "none") return null;

    return kindStr.split("_") as SymbolKind[];
  }

  /**
   * Check if a node is inside a comment (line_comment or block_comment).
   */
  private isInsideComment(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current) {
      if (current.type === "line_comment" || current.type === "block_comment") {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Resolve enclosing class and root state machine names at a position.
   * For state machines, keeps walking to find the outermost (root) SM.
   */
  private resolveEnclosingScope(
    tree: Tree,
    line: number,
    column: number,
  ): { enclosingClass?: string; enclosingStateMachine?: string } {
    let node: SyntaxNode | null = tree.rootNode.descendantForPosition({
      row: line,
      column,
    });
    let enclosingClass: string | undefined;
    let enclosingStateMachine: string | undefined;

    while (node) {
      // For state machines: keep overwriting to find the ROOT (outermost) SM
      if (node.type === "state_machine") {
        enclosingStateMachine =
          node.childForFieldName("name")?.text ?? enclosingStateMachine;
      }
      if (node.type === "statemachine_definition") {
        enclosingStateMachine =
          node.childForFieldName("name")?.text ?? enclosingStateMachine;
      }
      // For class: stop at first (innermost is what we want)
      if (
        !enclosingClass &&
        [
          "class_definition",
          "trait_definition",
          "interface_definition",
          "association_class_definition",
        ].includes(node.type)
      ) {
        enclosingClass = node.childForFieldName("name")?.text;
      }
      node = node.parent;
    }

    // Qualify SM name with class name for unique container identification
    if (enclosingStateMachine && enclosingClass) {
      enclosingStateMachine = `${enclosingClass}.${enclosingStateMachine}`;
    }

    return { enclosingClass, enclosingStateMachine };
  }

  /**
   * Check if the cursor is at an attribute name position (after a type name).
   * E.g., "Integer |" — the previous leaf is inside a type_name that is the
   * "type" field of an attribute_declaration, const_declaration, method, or param.
   */
  private isAtAttributeNamePosition(
    tree: Tree,
    content: string,
    line: number,
    column: number,
  ): boolean {
    const prevLeaf = this.findPreviousLeaf(tree, content, line, column);
    if (!prevLeaf) return false;

    // Walk up to find if prevLeaf is inside a type_name
    let node: SyntaxNode | null = prevLeaf;
    while (node) {
      if (node.type === "type_name") {
        const parent = node.parent;
        if (parent) {
          for (let i = 0; i < parent.childCount; i++) {
            if (parent.child(i)?.id === node.id) {
              const fieldName = parent.fieldNameForChild(i);
              if (fieldName === "type" || fieldName === "return_type") {
                return true;
              }
            }
          }
        }
        break;
      }
      node = node.parent;
    }
    return false;
  }

  /**
   * Scan backwards from the cursor position to find the token before the
   * word currently being typed. Skips the current partial identifier first,
   * then whitespace, then extracts the previous token.
   *
   * Examples (| = cursor):
   *   "class |"      → "class"
   *   "class Fo|"    → "class"
   *   "class\n  Fo|" → "class"
   */
  private lastTokenBeforeCursor(
    content: string,
    line: number,
    column: number,
  ): string | null {
    const lines = content.split("\n");

    // Convert (line, column) to absolute offset
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    offset += Math.min(column, lines[line]?.length ?? 0);

    // Skip the current partial identifier (the word being typed)
    let pos = offset;
    while (pos > 0 && /[a-zA-Z_0-9]/.test(content[pos - 1])) {
      pos--;
    }

    // Skip whitespace
    while (pos > 0 && /\s/.test(content[pos - 1])) {
      pos--;
    }

    if (pos === 0) return null;

    // Collect the previous token
    let start = pos;
    while (start > 0 && /[a-zA-Z_]/.test(content[start - 1])) {
      start--;
    }

    if (start === pos) return null; // Hit punctuation, not a word

    return content.substring(start, pos);
  }

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

  /**
   * Check if the cursor is inside the target field of a transition node.
   * Uses a layered strategy:
   *   1. AST check: walk ancestors for qualified_name → transition.target
   *   2. Lexical fallback: scan line for "->" before cursor position
   *
   * Layer 2 handles ERROR recovery cases where tree-sitter doesn't produce
   * a transition node (e.g., "dddd -> EEE." produces state + ERROR).
   * This is safe because we only call this when resolveCompletionScope
   * already confirmed @scope.state context, and within state/SM bodies
   * "->" exclusively marks transition targets.
   */
  private isInTransitionTarget(
    tree: Tree,
    line: number,
    column: number,
    content: string,
  ): boolean {
    // Layer 1: AST — walk ancestors for qualified_name inside transition.target
    let node: SyntaxNode | null = tree.rootNode.descendantForPosition({
      row: line,
      column: Math.max(0, column - 1),
    });

    while (node) {
      if (node.type === "qualified_name") {
        const parent = node.parent;
        if (parent?.type === "transition") {
          const targetNode = parent.childForFieldName("target");
          if (targetNode?.id === node.id) return true;
        }
        break;
      }
      // Stop at scope boundaries — don't walk past state/SM
      if (
        node.type === "transition" ||
        node.type === "state" ||
        node.type === "state_machine" ||
        node.type === "statemachine_definition"
      ) {
        break;
      }
      node = node.parent;
    }

    // Layer 2: Lexical — scan line text for "->" before cursor.
    // Within @scope.state (already confirmed by caller), "->" exclusively
    // marks transition targets. We just check for its presence before the
    // cursor — no need to validate what's between (action code like
    // "/act" is valid between "->" and target in Umple: `e -> /act T;`).
    const lineText = content.split("\n")[line] ?? "";
    const beforeCursor = lineText.substring(0, column);
    if (beforeCursor.includes("->")) {
      return true;
    }

    return false;
  }

  /**
   * Extract dotted prefix segments from a line, scanning backward from a dot position.
   * E.g., for "-> EEE.Open." at dotPos pointing to the last '.', returns ["EEE", "Open"].
   */
  private extractDottedPrefix(
    lineText: string,
    dotPos: number,
  ): string[] | undefined {
    const segments: string[] = [];
    let pos = dotPos;

    while (pos >= 0 && lineText[pos] === ".") {
      const identEnd = pos;
      let identStart = pos;
      while (identStart > 0 && /[a-zA-Z_0-9]/.test(lineText[identStart - 1])) {
        identStart--;
      }
      if (identStart === identEnd) break;

      segments.unshift(lineText.substring(identStart, identEnd));

      if (identStart > 0 && lineText[identStart - 1] === ".") {
        pos = identStart - 1;
      } else {
        break;
      }
    }

    return segments.length > 0 ? segments : undefined;
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
  private resolveStatePath(nameNode: SyntaxNode): string[] {
    const segments: string[] = [nameNode.text];
    let current = nameNode.parent; // The state node itself
    if (current) current = current.parent; // Go above it

    while (current) {
      if (current.type === "state") {
        const name = current.childForFieldName("name");
        if (name) segments.unshift(name.text);
      }
      if (
        current.type === "state_machine" ||
        current.type === "statemachine_definition"
      ) {
        break;
      }
      current = current.parent;
    }
    return segments;
  }

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
        entry.statePath = this.resolveStatePath(node);
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
            const candidatePath = this.resolveStatePath(node);
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
