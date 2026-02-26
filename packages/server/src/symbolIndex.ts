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
  | "attribute"
  | "state"
  | "statemachine"
  | "method"
  | "association"
  | "mixset"
  | "requirement"
  | "template";

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
  symbolKinds: SymbolKind[] | "suppress" | "use_path" | "own_attribute" | null;
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
}

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 0-indexed
  column: number; // 0-indexed
  endLine: number;
  endColumn: number;
  container?: string; // Enclosing class (for attributes/methods) or root SM (for states)
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

    // Remove old symbols for this file from the name index
    if (existing) {
      this.removeFileSymbols(filePath);
    }

    // Parse the file
    const tree = this.parser.parse(fileContent);

    // Extract symbols from the AST
    const symbols = this.extractSymbols(filePath, tree.rootNode);

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

    return true;
  }

  /**
   * Update a file with new content.
   * For web-tree-sitter, we do a full reparse but the index diffing is still efficient.
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
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
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
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
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
    const symbolKinds = this.resolveCompletionScope(tree, line, column);

    // --- Enclosing scope for scoped lookups ---
    const { enclosingClass, enclosingStateMachine } =
      this.resolveEnclosingScope(tree, line, column);
    return {
      keywords,
      operators,
      symbolKinds,
      isDefinitionName: false,
      isComment: false,
      prefix,
      enclosingClass,
      enclosingStateMachine,
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
    if (!node || (node.type !== "identifier" && node.type !== "use_path")) {
      return null;
    }

    const word = node.text;
    const kinds = this.resolveDefinitionKinds(tree, node);
    const { enclosingClass, enclosingStateMachine } =
      this.resolveEnclosingScope(tree, line, column);
    return { word, kinds, enclosingClass, enclosingStateMachine };
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
    const prefix = "reference.";
    if (!bestCapture.name.startsWith(prefix)) return null;
    const kindStr = bestCapture.name.substring(prefix.length);
    return kindStr.split("_") as SymbolKind[];
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
  ): SymbolKind[] | "suppress" | "use_path" | "own_attribute" | null {
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
    let current = node.parent;
    while (current) {
      if (current.type === "state_machine") {
        rootSmName = current.childForFieldName("name")?.text ?? rootSmName;
      }
      if (current.type === "statemachine_definition") {
        rootSmName = current.childForFieldName("name")?.text ?? rootSmName;
      }
      current = current.parent;
    }
    return rootSmName;
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
        kind === "method" ||
        kind === "template"
      ) {
        container = this.resolveClassContainer(node);
      } else {
        // Top-level symbols (class, interface, trait, enum, etc.) are self-containers
        container = node.text;
      }

      symbols.push({
        name: node.text,
        kind,
        file: filePath,
        line: node.startPosition.row,
        column: node.startPosition.column,
        endLine: node.endPosition.row,
        endColumn: node.endPosition.column,
        container,
      });
    }
    return symbols;
  }
}

// Singleton instance
export const symbolIndex = new SymbolIndex();
