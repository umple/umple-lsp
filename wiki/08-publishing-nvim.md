# 08 — The Neovim plugin (`umple.nvim`)

There's no formal "marketplace" for Neovim plugins — distribution is via plugin managers (lazy.nvim, packer.nvim, vim-plug, etc.) that clone the plugin repo directly. So "shipping" amounts to: push to `umple.nvim` master and your users' plugin manager picks it up.

The plugin's job is two-fold:

1. **Wire Neovim's built-in LSP client to `umple-lsp-server`** (downloaded from npm during plugin build)
2. **Register the tree-sitter parser** with `nvim-treesitter` for syntax highlighting

Neovim normally highlights Umple through tree-sitter, not LSP semantic tokens. The server still advertises semantic tokens for clients that want them, but `umple.nvim`'s visible highlighting depends on `tree-sitter-umple/queries/highlights.scm` and the compiled parser. Fix server semantics in `umple-lsp`; fix Neovim parser/query installation or stale cache behavior in `umple.nvim`.

## Repo details

- **Repo:** github.com/umple/umple.nvim
- **No published version** — Neovim plugins distribute via Git
- **Filetype:** `umple` (auto-set for `.ump`)
- **LSP client name:** `umple` (via lspconfig)
- **Tree-sitter parser:** `umple` (compiled from `src/parser.c` extracted from this repo)

## How it works at install time

User adds the plugin to their Lua config:

```lua
{
  "umple/umple.nvim",
  build = ":Lazy build umple.nvim",
  config = function() require("umple-lsp").setup() end,
}
```

`build = ":Lazy build umple.nvim"` runs `umple.nvim/scripts/build.sh`:

```sh
#!/usr/bin/env sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Install LSP server from npm
npm install --prefix "$PLUGIN_DIR" umple-lsp-server

# 2. Download umplesync.jar (for diagnostics)
curl -fSL -o "$PLUGIN_DIR/node_modules/umple-lsp-server/umplesync.jar" \
  https://try.umple.org/scripts/umplesync.jar

# 3. Clone umple-lsp and extract the tree-sitter grammar
git clone --depth 1 https://github.com/umple/umple-lsp.git "$PLUGIN_DIR/_umple-lsp-tmp"
mv "$PLUGIN_DIR/_umple-lsp-tmp/packages/tree-sitter-umple" "$PLUGIN_DIR/tree-sitter-umple"
rm -rf "$PLUGIN_DIR/_umple-lsp-tmp"
```

Then the plugin's Lua at runtime:

- `lua/umple-lsp/init.lua` registers the LSP server with `lspconfig`, pointing `cmd` at `node node_modules/umple-lsp-server/out/server.js --stdio` and passing `umpleSyncJarPath` as an init option
- Auto-set filetype: `vim.filetype.add({ extension = { ump = "umple" } })`
- Tree-sitter parser registration: tells `nvim-treesitter` to compile `tree-sitter-umple/src/parser.c` into a native `.so` and load it

For tree-sitter highlighting to work, the user runs `:TSInstall umple` once after the plugin builds.

## Updating the plugin

When you push umple-lsp changes that should reach Neovim users, there's nothing extra to do for the plugin itself unless you've changed:

- The LSP client setup (lua glue)
- The build script
- The tree-sitter integration (how the grammar gets pulled or compiled)

For pure server / grammar changes, users get them automatically on their next `:Lazy build umple.nvim` (which re-runs `npm install umple-lsp-server` to pull the new npm version + re-clones umple-lsp for the parser.c).

So the typical "shipping new features to nvim users" flow is:

1. Land + push umple-lsp changes
2. `npm publish` from `packages/server/`
3. (No action on umple.nvim needed unless plugin code changes)
4. Users run `:Lazy update umple.nvim && :Lazy build umple.nvim`

## Local dev (symlink mode)

The standard dev-machine setup uses a **symlink** so your local umple-lsp changes are picked up by nvim immediately:

```bash
# After cloning umple.nvim, replace the npm-installed server with a symlink to local
cd umple.nvim/node_modules/umple-lsp-server
cd ..
rm -rf umple-lsp-server
ln -s ../../umple-lsp/packages/server umple-lsp-server
```

Verify:

```bash
ls -la umple.nvim/node_modules/umple-lsp-server
# should be a lrwxr-xr-x symlink to ../../umple-lsp/packages/server
```

Now `npm run compile` in umple-lsp + `:LspRestart` in nvim is the dev loop.

For tree-sitter:

```bash
ln -sf ../../umple-lsp/packages/tree-sitter-umple umple.nvim/tree-sitter-umple
```

After grammar.js edits + `npm run compile`, in nvim run `:TSInstall umple` to recompile the native parser from the freshly regenerated parser.c.

After `highlights.scm` edits, restart Neovim or reload the buffer. If colors still look stale, check:

```vim
:echo nvim_get_runtime_file('queries/umple/highlights.scm', v:true)
:echo nvim_get_runtime_file('parser/umple.so', v:true)
```

The plugin repairs stale query symlinks on startup, but a stale compiled parser still requires `:TSInstall umple`.

**Don't** commit symlinks. They're dev-machine-local; the build script handles real installs.

## Plugin file layout

```
umple.nvim/
├── lua/umple-lsp/init.lua    ← Plugin entry; setup(opts) hook
├── plugin/                   ← Vim init scripts
├── scripts/build.sh          ← Build hook called by `:Lazy build`
├── tree-sitter-umple/        ← Populated by build.sh; gitignored
├── node_modules/             ← Populated by build.sh; gitignored
├── test/                     ← Sample .ump files
├── README.md
└── .luarc.json               ← Lua-LSP config for plugin authors
```

## Configuration knobs

The plugin accepts an optional opts table:

```lua
require("umple-lsp").setup({
  port = 5556,           -- TCP port for the optional diagram server (rarely needed)
  plugin_dir = "/path",  -- override auto-detected plugin install path
})
```

Defaults are sensible for the common case.

## Troubleshooting

### Plugin loads but features don't work

Check `:LspInfo` in nvim with a `.ump` buffer. If the umple client isn't attached, the build step probably failed. Run `:Lazy build umple.nvim` and watch for errors. Common cause: `npm install` rate-limited or offline.

### `:TSInstall umple` fails

Means the tree-sitter parser couldn't compile. Check that `tree-sitter-umple/src/parser.c` exists in the plugin install dir. If not, build.sh didn't finish — re-run it.

### Highlighting works but completion / hover don't

LSP isn't connecting. Check:
- `:LspLog` for connection errors
- `:lua print(vim.fn.executable("node"))` (should print 1)
- `:lua print(require("umple-lsp.config").server_dir)` to see where it's looking

### Stale server after umple-lsp edit

Node doesn't hot-reload. After `npm run compile`, run `:LspRestart` in nvim. (No keymap by default — bind it: `vim.keymap.set("n", "<leader>lr", "<cmd>LspRestart<CR>")`.)

## Why no marketplace

Neovim's culture is "plugins are git repos, your plugin manager handles distribution." There IS no central marketplace in the VS Code / Zed sense. You can list at https://github.com/topics/neovim-plugin and on the official `awesome-neovim` lists for discoverability, but there's no "publish" step.

## Where to go next

- Server release that nvim users will pick up → [05-publishing-npm.md](05-publishing-npm.md)
- Other editors → [09-other-editors.md](09-other-editors.md)
