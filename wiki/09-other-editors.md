# 09 — Other editors (BBEdit, IntelliJ, Sublime)

The four "main" editors (VS Code, Zed, Neovim, plus the BBEdit codeless module) all live in their own dedicated repos or in `editors/`. This page covers the ones that aren't in the limelight but still ship.

## BBEdit

BBEdit (Bare Bones Software's macOS-only editor) supports LSP via its **Codeless Language Modules** (CLM) — a `.plist` file that declares syntax coloring rules + an `BBLMLanguageServerInfo` block that points at an LSP server.

### Configuration

Files live in `editors/bbedit/`:

```
editors/bbedit/
├── Umple.plist             ← Codeless language module
├── README.md               ← Install instructions
└── lib.bbedit/             ← Optional snippets
```

Key plist fields:

```xml
<key>BBLMLanguageDisplayName</key>
<string>Umple</string>
<key>BBLMLanguageCode</key>
<string>UMPL</string>            <!-- exactly 4 chars -->
<key>BBLMSuffixMap</key>
<array>...<string>.ump</string>...</array>
<key>BBLMLanguageServerInfo</key>
<dict>
  <key>ServerLanguageID</key>
  <string>Umple</string>          <!-- must match BBLMLanguageDisplayName casing -->
  <key>ServerInvocationCommand</key>
  <string>umple-lsp-server --stdio</string>
</dict>
```

User installs the .plist into `~/Library/Application Support/BBEdit/Language Modules/` and ensures `umple-lsp-server` is on `$PATH` (typically via `npm install -g umple-lsp-server`).

### Important BBEdit quirks

- **`$PATH` must be set in `~/.zshenv`**, not `~/.zshrc`. BBEdit launches subprocesses from a non-interactive shell that doesn't read `.zshrc`.
- **BBEdit doesn't use LSP for syntax highlighting** — the keyword list in the plist is required. Update it when you add new Umple keywords (mirrors what we add to `highlights.scm`).
- **BBEdit doesn't support `textDocument/hover`**. Don't expect hover features there.
- **`BBLMLanguageCode`** must be exactly 4 chars (`"UMPL"`).
- **`ServerLanguageID`** must match `BBLMLanguageDisplayName` exactly (capital U: `"Umple"`).
- Debug log: `~/Library/Logs/BBEdit/LanguageServerProtocol-Umple.txt`.

### Updating

When new Umple keywords are added (rare), update the keyword list in `Umple.plist`. Otherwise no maintenance — BBEdit picks up new server features when the user updates their npm-global install.

## IntelliJ

The IntelliJ side uses the **LSP4IJ** plugin from Red Hat — a generic LSP client that works with all JetBrains editions including Community.

### Configuration

Files live in `editors/intellij/`:

```
editors/intellij/
├── umple.tmLanguage             ← TextMate grammar for syntax highlighting
└── README.md                    ← Setup walkthrough
```

User installs LSP4IJ from the JetBrains Marketplace, then in **Settings → Language Servers**:

- Add a new server
- Command: `umple-lsp-server --stdio`
- File pattern: `*.ump`

For syntax highlighting, register the TextMate grammar via the **TextMate Bundles** support built into IntelliJ (or via a third-party plugin if you want more features).

### Why TextMate grammar instead of tree-sitter

IntelliJ has its own native LSP support (commercial editions only) that's incompatible with LSP4IJ. We picked LSP4IJ because it works in Community Edition. Native IntelliJ/LSP4IJ does not use tree-sitter directly, so the server now emits LSP semantic tokens from `highlights.scm`. The TextMate grammar remains a fallback for clients or themes that do not consume semantic tokens.

### Why no rename

The native IntelliJ LSP API supports rename, but it's commercial-only. LSP4IJ supports rename for some IntelliJ editions only. So rename works in Community via the LSP4IJ rename action; in others it depends on the user's edition. Document this in the IntelliJ README; nothing to do on our side.

### Updating

When you add new Umple keywords, update `umple.tmLanguage` to match. Otherwise no maintenance.

## Sublime

`editors/sublime/` has a `.sublime-syntax` file (Sublime's native YAML-based grammar format) and a brief setup README. We don't actively maintain a Sublime LSP integration — Sublime users install LSP-server via Sublime's `LSP` package by Sublime Text and configure it manually.

Configuration is just:

1. Install Package Control's `LSP` package
2. Add a client config pointing at `umple-lsp-server --stdio` for `*.ump`
3. Optionally install our `.sublime-syntax` for syntax highlighting

Updating: refresh `umple.sublime-syntax` when new keywords land.

## Other editors not currently covered

Anyone with a generic LSP client setup can use `umple-lsp-server` directly:

- **Helix:** add to `languages.toml` per their docs, point at `umple-lsp-server --stdio`
- **Emacs:** `lsp-mode` or `eglot` configured similarly
- **Kakoune:** via `kak-lsp`
- **Sublime:** as above

We don't ship config files for these but the server is fully editor-agnostic over LSP. If you want to add first-class support for one, follow the same pattern as Sublime (a `.md` README + any required syntax file in `editors/<name>/`).

## Where to go next

- Main editor pipelines → [06-publishing-vscode.md](06-publishing-vscode.md), [07-publishing-zed.md](07-publishing-zed.md), [08-publishing-nvim.md](08-publishing-nvim.md)
- Server-side release that all editors consume → [05-publishing-npm.md](05-publishing-npm.md)
