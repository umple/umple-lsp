#!/bin/sh
# Prepare a self-contained packages/vscode/ for vsce packaging.
# vsce rejects any file with ".." in the path, so we must copy
# everything into local node_modules/ and the package root.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSCODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$VSCODE_DIR/../.." && pwd)"
SERVER_DIR="$(cd "$VSCODE_DIR/../server" && pwd)"

# Copy README and LICENSE into this package
cp "$ROOT_DIR/README.md" "$VSCODE_DIR/README.md" 2>/dev/null || true
cp "$ROOT_DIR/LICENSE" "$VSCODE_DIR/LICENSE" 2>/dev/null || true

# Wipe local node_modules completely to avoid symlink issues
rm -rf "$VSCODE_DIR/node_modules"
mkdir -p "$VSCODE_DIR/node_modules"

# Copy server package (real copy, not symlink)
SERVER_NM="$VSCODE_DIR/node_modules/umple-lsp-server"
mkdir -p "$SERVER_NM/out"
cp "$SERVER_DIR/package.json" "$SERVER_NM/"
cp "$SERVER_DIR/out/"*.js "$SERVER_NM/out/"
cp "$SERVER_DIR/out/"*.js.map "$SERVER_NM/out/" 2>/dev/null || true
cp "$SERVER_DIR/out/"*.d.ts "$SERVER_NM/out/" 2>/dev/null || true
cp "$SERVER_DIR/tree-sitter-umple.wasm" "$SERVER_NM/" 2>/dev/null || true
cp "$SERVER_DIR/umplesync.jar" "$SERVER_NM/" 2>/dev/null || true

# Copy runtime dependencies
for dep in vscode-languageserver vscode-languageserver-protocol \
           vscode-languageserver-types vscode-jsonrpc \
           vscode-languageserver-textdocument vscode-languageclient \
           web-tree-sitter; do
  cp -R "$ROOT_DIR/node_modules/$dep" "$VSCODE_DIR/node_modules/$dep"
done

# Remove workspace symlinks that point back into packages/.
# vsce follows these and finds every file twice → "duplicate" error.
# Running `npm install` at the root will recreate them.
rm -f "$ROOT_DIR/node_modules/umple-lsp"
rm -f "$ROOT_DIR/node_modules/umple-lsp-server"

echo "prepare-vsix: done  (run 'npm install' at root to restore workspace links)"
