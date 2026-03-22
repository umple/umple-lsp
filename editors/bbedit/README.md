# Umple for BBEdit

Umple language support for [BBEdit](https://www.barebones.com/products/bbedit/) 14+, providing syntax highlighting, diagnostics, code completion, go-to-definition, find references, rename, formatting, and document symbols for `.ump` files.

BBEdit has built-in Language Server Protocol support — no plugins required.

## How It Works

Two systems work together:

| Responsibility | Provided By |
|---|---|
| Syntax coloring (keywords, comments, strings) | Codeless Language Module (plist) |
| Comment/uncomment commands | Codeless Language Module (plist) |
| Diagnostics, completion, go-to-def, references, rename, formatting, symbols | LSP server (`umple-lsp-server`) |

BBEdit explicitly does NOT use LSP for syntax highlighting — you need both the plist and the server.

## Prerequisites

- **BBEdit 14+** (built-in LSP support)
- **Node.js 18+** (for running the LSP server)
- **Java 11+** (optional — only needed for diagnostics from the Umple compiler)

## Installation

### 1. Install the LSP server

```bash
npm install -g umple-lsp-server
```

Download `umplesync.jar` (needed for diagnostics):

```bash
curl -fSL -o "$(npm root -g)/umple-lsp-server/umplesync.jar" \
  https://try.umple.org/scripts/umplesync.jar
```

### 2. Install the Codeless Language Module

The [`Umple.plist` file in this directory](https://github.com/umple/umple-lsp/blob/master/editors/bbedit/Umple.plist) is a complete Codeless Language Module that provides both syntax coloring and LSP server auto-discovery. Copy it to BBEdit's Language Modules folder:

```bash
mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Modules
cp Umple.plist ~/Library/Application\ Support/BBEdit/Language\ Modules/
```

Or if you cloned this repo:

```bash
mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Modules
cp editors/bbedit/Umple.plist ~/Library/Application\ Support/BBEdit/Language\ Modules/
```

You may need to set the initialization options as specified in Section 5.


### 3. Restart BBEdit

Quit BBEdit completely and relaunch. Language modules are only loaded at startup.

### 4. Verify

1. Open any `.ump` file
2. Check the language selector at the bottom of the editor — it should show **Umple**
3. Check **BBEdit > Settings > Languages > Umple > Server** — the status dot should be **green** (server found)
4. If the dot is red, see [Troubleshooting](#troubleshooting) below
5. Create an Umple file (.ump suffix) and type `statemachine sm {}` and save the file. Verify that the keyword statemachine is coloured. If not see [Troubleshooting](#troubleshooting)
6. In the same Umple file, type an error (such as a single line with junk) and save the file. Verify that a pink colour appears on the line number and also in a little triangle at the top; click either of these to see the diagnostic information; then click Show All to see the diagnostics panel. If this does not work follow the directions in the next section to set initialization options.

### 5. Diagnostics setup

The server automatically finds `umplesync.jar` next to itself (since v0.2.6). As long as you downloaded the jar into the npm package directory in step 1, diagnostics work with no extra configuration.

If diagnostics still don't work, you can explicitly point BBEdit to the jar. Find the jar path:

```bash
echo "$(npm root -g)/umple-lsp-server/umplesync.jar"
```

Create a configuration file:

```bash
mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Servers/Configuration
```

Save the following as `~/Library/Application Support/BBEdit/Language Servers/Configuration/Umple.json` (adjust the path if your jar is in a different location):

```json
{
  "initializationOptions": {
    "umpleSyncJarPath": "/usr/local/lib/node_modules/umple-lsp-server/umplesync.jar"
  }
}
```

Then tell BBEdit to use it: **Settings > Languages > Custom Settings** > double-click **Umple** > **Server** tab > set **Configuration** to **Umple**.

BBEdit supports C-style comments (`//`, `/* */`) in these JSON config files.

## Features

### From the Codeless Language Module (plist)

- **Syntax highlighting** — Keywords, comments (`//`, `/* */`), and strings (`"..."`) are colored
- **Comment/uncomment** — `Cmd+/` toggles line comments; `Cmd+Shift+/` toggles block comments
- **Block folding** — `{` / `}` blocks can be folded

### From the LSP Server

| Feature | How to Use |
|---|---|
| **Diagnostics** | Errors/warnings appear as colored dots in the line number gutter. Click to see details. When showing details, select Show All to open a window enabling you to navigate all diagnostics  |
| **Code completion** | Type and BBEdit shows completion suggestions from the server |
| **Go to Definition** | `Cmd`-double-click a symbol, or right-click > **Go to Definition** |
| **Go to Declaration** | Right-click > **Go to Declaration** |
| **Find References** | **Search > Find References to Selected Symbol** |
| **Rename** | Right-click > **Rename Selected Symbol**, or **Edit > Rename Selected Symbol** |
| **Document Formatting** | **Edit > Reformat Document** (or **Reformat Selection** for range formatting) |
| **Document Symbols** | **Go > Go to Named Symbol** for quick navigation |
| **Workspace Symbols** | **Go > Find Symbol in Workspace** for project-wide search |
| **Code Actions** | Right-click for context-menu code actions |
| **Signature Help** | **Edit > Show Parameter Help** |

### Not supported by BBEdit

- **Hover** — BBEdit does not support `textDocument/hover`
- **Semantic tokens** — Syntax coloring comes from the plist, not the LSP

## How the Plist Works

The `Umple.plist` file does two things:

**1. Language definition** — Maps `.ump` files to the "Umple" language, defines comment/string delimiters, and provides a keyword list for syntax coloring.

**2. LSP auto-discovery** — The `BBLMLanguageServerInfo` dictionary tells BBEdit to automatically launch `umple-lsp-server --stdio` when `.ump` files are opened:

```xml
<key>BBLMLanguageServerInfo</key>
<dict>
    <key>ServerCommand</key>
    <string>umple-lsp-server</string>
    <key>ServerArguments</key>
    <array>
        <string>--stdio</string>
    </array>
    <key>ServerLanguageID</key>
    <string>umple</string>
</dict>
```

This means no manual configuration in Settings > Languages > Server is needed — it's all automatic from the plist.

## Troubleshooting

### Server status dot is red

The red dot in **Settings > Languages > Umple > Server** means BBEdit found the configuration but can't locate the executable.

**Common cause:** BBEdit reads `$PATH` from `~/.zshenv`, NOT `~/.zshrc`. If you installed Node.js via nvm, fnm, or Homebrew and only added it to PATH in `.zshrc`, BBEdit won't find it.

**Fix options:**

1. Add the PATH export to `~/.zshenv`:
   ```bash
   # ~/.zshenv
   export PATH="/opt/homebrew/bin:$PATH"
   # or for nvm:
   export NVM_DIR="$HOME/.nvm"
   [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
   ```

2. Or use the full absolute path: open **Settings > Languages > Umple > Server** and set **Command** to the full path:
   ```bash
   which umple-lsp-server
   # e.g., /opt/homebrew/bin/umple-lsp-server
   ```

3. Or symlink into BBEdit's Language Servers directory:
   ```bash
   mkdir -p ~/Library/Application\ Support/BBEdit/Language\ Servers
   ln -s "$(which umple-lsp-server)" ~/Library/Application\ Support/BBEdit/Language\ Servers/
   ```

### Server status dot is gray

Gray means the server is not configured. Make sure `Umple.plist` is in `~/Library/Application Support/BBEdit/Language Modules/` and you've restarted BBEdit.

### No diagnostics

1. Ensure `umplesync.jar` exists:
   ```bash
   ls "$(npm root -g)/umple-lsp-server/umplesync.jar"
   ```
2. Verify Java is installed: `java -version`
3. If the jar is in a non-standard location, create `Umple.json` (see step 5 above)

### LSP features not working

Check the debug log:
```
~/Library/Logs/BBEdit/LanguageServerProtocol-Umple.txt
```

This log shows all JSON-RPC messages between BBEdit and the server.

### Server hangs on quit

If BBEdit hangs when closing, the server may not be responding to the `exit` notification. Fix:
```bash
defaults write com.barebones.bbedit ForceQuitLSPServerAfterExit_umple-lsp-server -int 2
```

This tells BBEdit to force-kill the server after 2 seconds if it doesn't exit cleanly.

## Per-Project Configuration

For project-specific settings, place a `.BBEditLSPWorkspaceConfig.json` file in the project root:

```json
{
  // Project-specific LSP settings
}
```

BBEdit passes this to the server as workspace configuration.

## Updating

```bash
npm update -g umple-lsp-server
```

Then restart BBEdit. The plist does not need updating unless new keywords are added to the Umple language.

## Customizing Keywords

The keyword list in `Umple.plist` controls which identifiers get syntax coloring. To add or remove keywords, edit the `BBLMKeywordList` array in the plist and restart BBEdit. The full list of keywords is organized by category:

- **Entity declarations:** `class`, `interface`, `trait`, `enum`, `association`, `associationClass`, `namespace`, `statemachine`
- **Class body:** `isA`, `singleton`, `immutable`, `abstract`, `lazy`, `const`, `autounique`, `defaulted`, `depend`, `use`, `key`
- **Visibility:** `public`, `private`, `protected`, `internal`
- **Types:** `Integer`, `String`, `Boolean`, `Double`, `Float`, `Date`, `Time`, `void`
- **State machine:** `queued`, `pooled`, `entry`, `exit`, `do`, `final`, `unspecified`, `as`, `afterEvery`
- **Code injection:** `before`, `after`, `around`
- **Directives:** `generate`, `mixset`, `require`, `trace`, `tracecase`
