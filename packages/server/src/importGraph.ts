/**
 * Import graph data structure.
 *
 * Manages forward (file → imports) and reverse (file → importers) edge maps
 * for use-statement resolution. Owns only edge storage and traversal —
 * path resolution, use parsing, and fs policy stay in symbolIndex.ts.
 */

export class ImportGraph {
  private forward = new Map<string, Set<string>>();
  private reverse = new Map<string, Set<string>>();

  /**
   * Update import edges for a file. Removes old edges first, then adds new ones.
   */
  setEdges(filePath: string, imports: Set<string>): void {
    // Remove old forward edges from reverse map
    const oldImports = this.forward.get(filePath);
    if (oldImports) {
      for (const imp of oldImports) {
        const rev = this.reverse.get(imp);
        if (rev) {
          rev.delete(filePath);
          if (rev.size === 0) this.reverse.delete(imp);
        }
      }
    }

    // Set new forward edges
    this.forward.set(filePath, imports);

    // Add new reverse edges
    for (const imp of imports) {
      let rev = this.reverse.get(imp);
      if (!rev) {
        rev = new Set();
        this.reverse.set(imp, rev);
      }
      rev.add(filePath);
    }
  }

  /**
   * Remove all edges for a file (both directions).
   */
  removeEdges(filePath: string): void {
    // Clean forward → reverse
    const oldImports = this.forward.get(filePath);
    if (oldImports) {
      for (const imp of oldImports) {
        const rev = this.reverse.get(imp);
        if (rev) {
          rev.delete(filePath);
          if (rev.size === 0) this.reverse.delete(imp);
        }
      }
    }
    this.forward.delete(filePath);
    // Also remove as a target in reverse map
    this.reverse.delete(filePath);
  }

  /**
   * Get forward imports for a file.
   */
  getForward(filePath: string): Set<string> | undefined {
    return this.forward.get(filePath);
  }

  /**
   * Transitive reverse closure: all files whose use chain can reach
   * any of the given target files.
   */
  getReverseImporters(targetFiles: Set<string>): Set<string> {
    const result = new Set<string>();
    const queue = [...targetFiles];
    while (queue.length > 0) {
      const file = queue.pop()!;
      const importers = this.reverse.get(file);
      if (!importers) continue;
      for (const importer of importers) {
        if (!result.has(importer) && !targetFiles.has(importer)) {
          result.add(importer);
          queue.push(importer);
        }
      }
    }
    return result;
  }
}
