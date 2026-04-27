# 06 — Publishing the VS Code extension

The VS Code extension is a thin wrapper. It **bundles** `umple-lsp-server` inside the `.vsix` at packaging time, ships a TextMate grammar for syntax highlighting, plus snippets and a command palette entry. Most user-facing improvements come from the LSP server, so the extension itself rarely needs new code — but **every time you ship new server features you must repackage + republish the extension**. Unlike Zed (which downloads the latest npm at runtime), VS Code users receive only what was bundled when the .vsix was built.

Highlighting now has two possible sources in VS Code:

- The extension's TextMate grammar still provides baseline syntax scopes.
- The server also advertises `textDocument/semanticTokens/full`, backed by `packages/tree-sitter-umple/queries/highlights.scm`.

So most highlighting fixes belong in `umple-lsp` (`highlights.scm` or `semanticTokens.ts`) and then require a new bundled server inside the `.vsix`. Only touch `umple.vscode` itself when the extension manifest, TextMate grammar, activation, commands, snippets, or server launch wiring must change.

## Package details

- **Repo:** github.com/umple/umple.vscode
- **Marketplace ID:** `digized.umple` (publisher: `digized`)
- **Page:** https://marketplace.visualstudio.com/items?itemName=digized.umple
- **Tool:** `vsce` (Microsoft's VS Code Extension publisher CLI)

## One-time setup

You need a Personal Access Token (PAT) for the `digized` publisher.

1. Go to https://dev.azure.com/ and sign in (Microsoft / GitHub identity, depending on how the publisher was set up)
2. User settings → Personal access tokens → New
3. **Scopes:** Marketplace → "Manage" (read/write/publish)
4. Copy the token

Then either log in interactively (recommended for occasional use):

```bash
npx vsce login digized
# pastes the PAT
```

Or pass the token inline at publish time:

```bash
npx vsce publish --pat <token> ...
```

PATs expire — usually a year. When publish returns `401 Unauthorized` that's the first thing to check.

## Release flow

Assumes you've just published a new `umple-lsp-server` to npm (see [05-publishing-npm.md](05-publishing-npm.md)). The extension's `package.json` currently pins a **local tarball** (`file:../umple-lsp/packages/server/umple-lsp-server-X.Y.Z.tgz`) so that the .vsix bundles a precise build. To pick up a new server version, either update the path to point at a new tarball you've packed locally with `npm pack`, OR change the dep to `"umple-lsp-server": "^X.Y.Z"` and `npm install` to pull from the registry. Both approaches give an end-to-end-tested .vsix; pick whichever fits your release workflow.

```bash
# A. Pack the local server into a versioned tarball (assumes you just bumped + compiled it)
cd ~/.../workspace/lsp_umple/umple-lsp/packages/server
npm pack
# produces umple-lsp-server-X.Y.Z.tgz in packages/server/

# B. Switch to umple.vscode and refresh node_modules from that tarball
cd ~/.../workspace/lsp_umple/umple.vscode
# Edit package.json's umple-lsp-server dep to point at the new tarball path:
#   "umple-lsp-server": "file:../umple-lsp/packages/server/umple-lsp-server-X.Y.Z.tgz"
# Or just `npm install ../umple-lsp/packages/server/umple-lsp-server-X.Y.Z.tgz`
npm install ../umple-lsp/packages/server/umple-lsp-server-X.Y.Z.tgz

# C. Verify the bundled server matches what you expect
node node_modules/umple-lsp-server/out/server.js --version
# should print the new X.Y.Z

# D. Bump extension version (independent of server version)
npm version <patch|minor|major> --no-git-tag-version
# or pin: npm version 2.4.3 --no-git-tag-version

# E. Compile (extension TypeScript)
npm run compile

# F. Package the .vsix (no auth needed for this step)
npx vsce package
# produces umple-<X.Y.Z>.vsix in the repo root

# G. Sanity check: install the .vsix locally first
# In VS Code: Extensions panel → … menu → Install from VSIX...
# Open a .ump file, verify completion / hover / goto-def work
# For highlighting changes, also run "Developer: Inspect Editor Tokens and Scopes"
# and check semantic token entries such as class/type/property/method.

# H. Publish to marketplace
npx vsce publish --packagePath umple-<X.Y.Z>.vsix
# If PAT is configured (`vsce login digized` previously), this just works.

# I. Commit + push the bump (and the dep change if you updated package.json)
git add package.json package-lock.json
git commit -m "Bump version to <X.Y.Z>"
git push origin master  # or `org master` per local remote naming
```

**Alternative**: instead of pinning a local tarball, change the dep to `"umple-lsp-server": "^X.Y.Z"` and `npm install` after publishing the server to npm. Cleaner long-term but requires npm publish FIRST. The tarball approach lets you build + sanity-test the .vsix even before npm publish lands.

Marketplace propagation is usually 1–5 minutes; verify at https://marketplace.visualstudio.com/items?itemName=digized.umple.

## Version scheme

The VS Code extension's version is **independent** of the server version. We've been:

- Major bumps for big LSP feature batches (e.g. 2.4.x for the topic 038 phase A–D req work)
- Patch bumps for small server bumps that ship as new vsix

| VS Code | npm server bundled | What it added |
|---------|--------------------|---------------|
| 2.4.2 | 0.4.3 | Topic 044 association arrow slot |
| 2.4.1 | 0.4.2 | Topic 043 typed-prefix |
| 2.4.0 | 0.4.0 | Phase A–D req/implementsReq |
| 2.3.2 | 0.3.5 | CLI flags / serverInfo |

Append after each release.

## Shipping pre-npm-publish (advanced, usually wrong)

Sometimes you want the .vsix to bundle a server version that isn't yet on npm — e.g. you're prepping a release and want to test the .vsix before committing to npm. Two ways:

### A. Locally pack the server, install the tarball

```bash
# In umple-lsp:
cd packages/server && npm pack
# produces umple-lsp-server-<X.Y.Z>.tgz

# In umple.vscode:
cd ~/.../umple.vscode
npm install ../umple-lsp/packages/server/umple-lsp-server-<X.Y.Z>.tgz
# This pulls transitive deps properly (unlike `npm install <local-path>`).
node node_modules/umple-lsp-server/out/server.js --version  # confirms <X.Y.Z>

# Then bump + compile + package as above.
```

Do this with caution — the resulting `.vsix` works for end users (the server is bundled), but the marketplace release narrative is "vsix shipped 0.X.Y" while npm still serves an older version. If anyone investigates, the lag looks weird. Prefer the canonical "npm first, then vscode pulls from registry" flow.

### B. Symlink approach (dev only, never publish)

```bash
ln -sf ../../../umple-lsp/packages/server umple.vscode/node_modules/umple-lsp-server
```

Convenient for `code .` + F5 dev loop. **Never publish** a vsix from this state — symlinks don't pack into the .vsix correctly.

## Publishing without `vsce` (manual upload)

If `vsce` is broken / PAT expired and you need to ship now:

1. Go to https://marketplace.visualstudio.com/manage/publishers/digized
2. Sign in with the digized account
3. Click the umple extension → "Update"
4. Upload the `.vsix` you packaged with `npx vsce package`

This is the same outcome as `vsce publish`; just bypasses the CLI auth.

## Troubleshooting

### `vsce publish` returns 401

PAT expired. Refresh per [One-time setup](#one-time-setup) above and re-`vsce login digized`.

### `vsce package` warns about missing fields

Usually missing `repository` or `license` in the extension's `package.json`. Already configured for us; warning is informational only.

### Extension installs but features don't work

Check that `package.json` declares the bundled `umple-lsp-server` (currently a pinned tarball; could also be a registry version) and that `node_modules/umple-lsp-server/out/server.js --version` works on the user's install. Logs go to the "Umple Language Server" output channel in VS Code (`View → Output`).

### Bundle size

Each .vsix is ~3.7 MB (mostly tree-sitter WASM + node_modules). If size grows substantially, check that we haven't accidentally included `node_modules/.bin` or test fixtures via `.vscodeignore`. Ours is set up correctly; only worry if you add new dev deps.

## Where to go next

- Server release came first → [05-publishing-npm.md](05-publishing-npm.md)
- Zed extension's parallel pipeline → [07-publishing-zed.md](07-publishing-zed.md)
- Why we don't auto-publish — [10-ci-automation.md](10-ci-automation.md)
