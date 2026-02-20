/**
 * Symbol Index for fast go-to-definition lookups.
 *
 * Uses tree-sitter (via WASM) for incremental parsing and maintains an
 * in-memory index of all symbol definitions in the workspace.
 */

import * as fs from "fs";
import * as path from "path";
import { debugLspInfo } from "./utils/debug";

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
  | "requirement";

const DUMMY_IDENTIFIER = "__CURSOR__";

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
  "generate",
  // State machine modifiers — next token is SM name (or another modifier)
  "queued",
  "pooled",
]);

export type CompletionContext =
  | "top"
  | "class_body"
  | "state_machine"
  | "state"
  | "association"
  | "enum"
  | "method"
  | "use_path"
  | "isa_type"
  | "transition_target"
  | "association_type"
  | "depend_package"
  | "definition_name"
  | "comment"
  | "unknown";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 0-indexed
  column: number; // 0-indexed
  endLine: number;
  endColumn: number;
}

export interface UseStatementWithPosition {
  path: string; // Original path from use statement (e.g., "Teacher" or "Teacher.ump")
  line: number; // 0-indexed line number
}

export interface FileIndex {
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
  private files: Map<string, FileIndex> = new Map();
  private symbolsByName: Map<string, SymbolEntry[]> = new Map();
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

    // Store the file index
    this.files.set(filePath, {
      symbols,
      tree,
      contentHash: hash,
    });

    // Add symbols to the name index
    for (const symbol of symbols) {
      const existing = this.symbolsByName.get(symbol.name) ?? [];
      existing.push(symbol);
      this.symbolsByName.set(symbol.name, existing);
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
   * Find definition of a symbol by name.
   * @param name Symbol name to look up
   * @param kind Optional kind filter
   * @returns Array of matching symbol entries
   */
  findDefinition(
    name: string,
    kinds?: SymbolKind | SymbolKind[],
  ): SymbolEntry[] {
    const symbols = this.symbolsByName.get(name) ?? [];
    if (kinds) {
      const kindSet = new Set(Array.isArray(kinds) ? kinds : [kinds]);
      return symbols.filter((s) => kindSet.has(s.kind));
    }
    return symbols;
  }

  /**
   * Get all symbols in a file.
   */
  getFileSymbols(filePath: string): SymbolEntry[] {
    return this.files.get(filePath)?.symbols ?? [];
  }

  /**
   * Get all indexed files.
   */
  getIndexedFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get all symbol names.
   */
  getAllSymbolNames(): string[] {
    return Array.from(this.symbolsByName.keys());
  }

  /**
   * Remove a file from the index.
   */
  removeFile(filePath: string): void {
    this.removeFileSymbols(filePath);
    this.files.delete(filePath);
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.files.clear();
    this.symbolsByName.clear();
  }

  /**
   * Get index statistics.
   */
  getStats(): { files: number; symbols: number; uniqueNames: number } {
    let totalSymbols = 0;
    for (const fileIndex of this.files.values()) {
      totalSymbols += fileIndex.symbols.length;
    }
    return {
      files: this.files.size,
      symbols: totalSymbols,
      uniqueNames: this.symbolsByName.size,
    };
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
   * Get the completion context at a specific position using the dummy identifier trick.
   *
   * Inserts a dummy identifier (__CURSOR__) at the cursor position, parses the
   * modified text, then walks up from the dummy node to determine context.
   * This produces reliable results because the dummy forces the parser to place
   * it in a grammatically valid position (e.g. "isA __CURSOR__" parses as an
   * isa_declaration with type __CURSOR__).
   *
   * @param filePath Path to the file
   * @param content File content (original, without dummy)
   * @param line 0-indexed line number
   * @param column 0-indexed column number (raw cursor position, NOT column-1)
   * @returns The completion context type
   */
  getCompletionContext(
    filePath: string,
    content: string,
    line: number,
    column: number,
  ): CompletionContext {
    if (!this.initialized || !this.parser) {
      return "unknown";
    }

    // Check if the cursor follows a definition keyword (e.g. "class ",
    // "enum ", "statemachine queued "). Scans backwards through the content
    // to find the last token, handling multi-line cases correctly.
    const lines = content.split("\n");
    if (line < 0 || line >= lines.length) {
      return "unknown";
    }
    const lineText = lines[line];
    const linePrefix = lineText.substring(0, column);
    const lastToken = this.lastTokenBeforeCursor(content, line, column);
    if (lastToken && DEFINITION_KEYWORDS.has(lastToken)) {
      return "definition_name";
    }

    // Insert dummy identifier at cursor position
    lines[line] = linePrefix + DUMMY_IDENTIFIER + lineText.substring(column);
    const modifiedText = lines.join("\n");

    // Parse modified text (throwaway — do NOT update index)
    const tree = this.parser.parse(modifiedText);

    // Find the dummy node — it starts at (line, column) in the modified text
    const dummyNode = tree.rootNode.descendantForPosition({
      row: line,
      column,
    });
    if (!dummyNode) {
      return "unknown";
    }

    // Walk up from the dummy node to determine context
    let current: SyntaxNode | null = dummyNode;
    while (current) {
      switch (current.type) {
        // Comments: suppress all completions
        case "line_comment":
        case "block_comment":
          return "comment";

        // Specific keyword contexts (checked before structural)
        case "use_statement":
          return "use_path";

        case "isa_declaration":
          return "isa_type";

        case "transition": {
          const targetNode = current.childForFieldName("target");
          if (targetNode && targetNode.text.includes(DUMMY_IDENTIFIER)) {
            return "transition_target";
          }
          // Dummy is in event position — fall through to state context
          return "state";
        }

        case "depend_statement":
          return "depend_package";

        case "association_inline": {
          const rightType = current.childForFieldName("right_type");
          if (rightType && rightType.text.includes(DUMMY_IDENTIFIER)) {
            return "association_type";
          }
          // Dummy is in role or other position — fall through
          break;
        }

        case "association_member": {
          const leftType = current.childForFieldName("left_type");
          const rightType = current.childForFieldName("right_type");
          if (
            (leftType && leftType.text.includes(DUMMY_IDENTIFIER)) ||
            (rightType && rightType.text.includes(DUMMY_IDENTIFIER))
          ) {
            return "association_type";
          }
          return "association";
        }

        // Brace-delimited: always reliable
        case "state":
          return "state";
        case "state_machine":
          return "state_machine";
        case "association_definition":
          return "association";
        case "enum_definition":
          return "enum";
        case "class_definition":
        case "trait_definition":
        case "interface_definition":
        case "association_class_definition":
          return "class_body";
        case "mixset_definition":
        case "statemachine_definition":
        case "requirement_definition":
        case "source_file":
          return "top";
        case "code_content":
        case "code_block":
          return "method";
      }
      current = current.parent;
    }

    return "unknown";
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
  ): { word: string; kinds: SymbolKind[] | null } | null {
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
    return { word, kinds };
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

  /**
   * Get all symbols of a specific kind from the index.
   * @param kind The kind of symbols to retrieve
   * @returns Array of symbol entries of that kind
   */
  getSymbolsByKind(kind: SymbolKind): SymbolEntry[] {
    const result: SymbolEntry[] = [];
    for (const symbols of this.symbolsByName.values()) {
      for (const symbol of symbols) {
        if (symbol.kind === kind) {
          result.push(symbol);
        }
      }
    }
    return result;
  }

  /**
   * Get all symbols (useful for type completions).
   */
  getAllSymbols(): SymbolEntry[] {
    const result: SymbolEntry[] = [];
    for (const symbols of this.symbolsByName.values()) {
      result.push(...symbols);
    }
    return result;
  }

  // =====================
  // Private methods
  // =====================

  /**
   * Debug helper: print a tree-sitter AST as an S-expression with positions.
   * Output matches the format used by `tree-sitter parse` and Neovim InspectTree.
   */
  debugPrintTree(content: string): string | null {
    if (!this.initialized || !this.parser) {
      return null;
    }
    const tree = this.parser.parse(content);
    const lines: string[] = [];
    const visit = (node: SyntaxNode, depth: number) => {
      const indent = "  ".repeat(depth);
      let field: string | null = null;
      if (node.parent) {
        for (let j = 0; j < node.parent.childCount; j++) {
          if (node.parent.child(j)?.id === node.id) {
            field = node.parent.fieldNameForChild(j);
            break;
          }
        }
      }
      const prefix = field ? `${field}: ` : "";
      const pos = `[${node.startPosition.row}, ${node.startPosition.column}] - [${node.endPosition.row}, ${node.endPosition.column}]`;
      if (node.childCount === 0) {
        lines.push(`${indent}${prefix}(${node.type} ${pos}) "${node.text}"`);
      } else {
        lines.push(`${indent}${prefix}(${node.type} ${pos}`);
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child, depth + 1);
        }
        lines.push(`${indent})`);
      }
    };
    visit(tree.rootNode, 0);
    return lines.join("\n");
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
      const symbols = this.symbolsByName.get(symbol.name);
      if (symbols) {
        const filtered = symbols.filter((s) => s.file !== filePath);
        if (filtered.length === 0) {
          this.symbolsByName.delete(symbol.name);
        } else {
          this.symbolsByName.set(symbol.name, filtered);
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

      symbols.push({
        name: node.text,
        kind,
        file: filePath,
        line: node.startPosition.row,
        column: node.startPosition.column,
        endLine: node.endPosition.row,
        endColumn: node.endPosition.column,
      });
    }

    return symbols;
  }
}

// Singleton instance
export const symbolIndex = new SymbolIndex();
