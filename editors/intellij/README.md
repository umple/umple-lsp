# Umple for IntelliJ IDEA

Umple language support for IntelliJ IDEA and other JetBrains IDEs via [LSP4IJ](https://github.com/redhat-developer/lsp4ij). Provides diagnostics, code completion, go-to-definition, find references, rename, hover, formatting, and document symbols for `.ump` files.

Works in **all editions** including Community Edition.

## Prerequisites

- **IntelliJ IDEA 2024.2+** (Community or Ultimate) or any other JetBrains IDE 2024.2+
- **Node.js 18+**
- **Java 11+** (optional — only needed for diagnostics)

## Setup

### 1. Install LSP4IJ

**Settings** (`Cmd+,` / `Ctrl+Alt+S`) > **Plugins** > **Marketplace** > search **LSP4IJ** > **Install** > restart IDE.

### 2. Install the Umple LSP server

```bash
npm install -g umple-lsp-server
```

Download `umplesync.jar` (needed for diagnostics):

```bash
curl -fSL -o "$(npm root -g)/umple-lsp-server/umplesync.jar" \
  https://try.umple.org/scripts/umplesync.jar
```

### 3. Configure the language server

**Settings** > **Languages & Frameworks** > **Language Servers** > click **+** (New Language Server)

- **Server tab**:
  - **Name**: `Umple`
  - **Command**: `umple-lsp-server --stdio`

- **Mappings tab**:
  - Click **File name patterns**
  - Click **+** and add `*.ump`
  - Set **Language Id** to `umple`

Click **OK**.

### 4. Add syntax highlighting (optional but recommended)

LSP does not provide syntax highlighting. To get keyword coloring, add a TextMate grammar:

**Settings** > **Editor** > **TextMate Bundles** > click **+** > navigate to the `editors/intellij/` folder in this repo (it contains `umple.tmLanguage`).

### 5. Verify

Open any `.ump` file. You should see:

- Syntax highlighting (if TextMate grammar is installed)
- Diagnostics (red/yellow underlines for errors/warnings)
- Code completion (type and suggestions appear)
- Go-to-definition (`Cmd+Click` or `Cmd+B`)
- Find references (`Alt+F7`)
- Rename (`Shift+F6`)
- Hover (`Cmd+hover` or `Ctrl+hover`)
- Formatting (`Cmd+Alt+L` or `Ctrl+Alt+L`)
- Document symbols (`Cmd+F12` or `Ctrl+F12`)

## LSP Console

LSP4IJ provides a built-in debug console: **View** > **Tool Windows** > **Language Servers**. This shows active servers, JSON-RPC messages, and errors — useful for troubleshooting.

## Updating

```bash
npm update -g umple-lsp-server
```

Then restart the IDE.

## Troubleshooting

### Server not starting

1. Verify `umple-lsp-server` is on your PATH:
   ```bash
   which umple-lsp-server
   ```
2. If using nvm/fnm, IntelliJ may not see your PATH. Use the full path in the server command:
   ```bash
   /Users/you/.nvm/versions/node/v22.0.0/bin/umple-lsp-server --stdio
   ```

### No diagnostics

1. Verify `umplesync.jar` exists:
   ```bash
   ls "$(npm root -g)/umple-lsp-server/umplesync.jar"
   ```
2. Verify Java is installed: `java -version`

### No syntax highlighting

Install the TextMate grammar (step 4 above). LSP does not provide syntax highlighting in IntelliJ.
