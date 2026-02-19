const PREFIX = "[umple-lsp]";

export function debugLspInfo(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
