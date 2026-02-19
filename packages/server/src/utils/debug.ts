const PREFIX = "[umple-lsp]";

export function debug(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
