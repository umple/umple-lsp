# 19 - Full Release Checklist

Use this page when shipping a complete user-facing release across npm, VS Code, and Zed. The detailed process pages remain the source of truth for each channel:

- npm server package: [05-publishing-npm.md](05-publishing-npm.md)
- VS Code extension: [06-publishing-vscode.md](06-publishing-vscode.md)
- Zed extension and marketplace PR: [07-publishing-zed.md](07-publishing-zed.md)
- CI and automation boundaries: [10-ci-automation.md](10-ci-automation.md)

## Release Order

1. Publish `umple-lsp-server` to npm.
2. Update and publish `umple.vscode` so VS Code bundles that server.
3. Sync, tag, and publish the Zed extension marketplace PR.
4. Communicate Neovim and other generic-LSP users can update from npm.

Do not publish VS Code before npm. VS Code packages the server into the `.vsix`, so a registry-backed release must be available before the extension install is rebuilt. Zed downloads the latest npm server at runtime, but grammar and highlight changes still require the `umple.zed` grammar rev and marketplace submodule bump.

## 0. Preconditions

```bash
# In umple-lsp
git status --short
git remote -v

# Confirm the intended server version is not already taken
npm view umple-lsp-server version --registry https://registry.npmjs.org/
```

Make sure unrelated scratch files stay unstaged. In this workspace there are often local `.ump` test files, tarballs, jars, and parse reports that should not go into release commits.

## 1. Server npm Release

In `umple-lsp`:

```bash
npm test

# Bump packages/server/package.json, update package README / CHANGELOG / wiki release table.
# Example:
cd packages/server
npm version 1.0.0 --no-git-tag-version

cd ../..
npm run compile
node packages/server/out/server.js --version
npm pack --dry-run -w packages/server
git diff --check

# Stage only the intended release files: version bump, code/docs changes, tests,
# package README/CHANGELOG, and publishing notes. Leave scratch files unstaged.
# Example:
# git add README.md packages/server/package.json packages/server/README.md packages/server/CHANGELOG.md wiki/05-publishing-npm.md
git commit -m "Release server X.Y.Z"
git push org master

cd packages/server
npm publish
npm view umple-lsp-server version --registry https://registry.npmjs.org/
```

If the release includes grammar or query changes, make sure the pushed `umple-lsp` commit is the one Zed should pin in `extension.toml`.

## 2. VS Code Extension Release

In `umple.vscode`, after npm shows the new server version:

```bash
git status --short

# Edit package.json:
# - extension version, e.g. "3.0.0"
# - exact server dependency, e.g. "umple-lsp-server": "1.0.0"

rm -f package-lock.json umple-*.vsix
rm -rf node_modules/umple-lsp-server
npm install --no-package-lock

test ! -L node_modules/umple-lsp-server
node node_modules/umple-lsp-server/out/server.js --version
npm ls umple-lsp-server

npm run compile
npm test
npx @vscode/vsce package

# Inspect the packaged versions
unzip -p umple-<VS_CODE_VERSION>.vsix extension/package.json
unzip -p umple-<VS_CODE_VERSION>.vsix extension/node_modules/umple-lsp-server/package.json

git diff --check
git add package.json README.md
git commit -m "Release VS Code extension <VS_CODE_VERSION>"
git push org master
```

Publish after the local `.vsix` smoke test:

```bash
npx @vscode/vsce publish --packagePath umple-<VS_CODE_VERSION>.vsix
```

The repo intentionally does not track `package-lock.json`; keep it absent unless the project policy changes.

## 3. Zed Extension Sync

In `umple.zed`, after the server npm publish and after the target `umple-lsp` commit has been pushed:

```bash
git fetch --all --prune
git checkout master
git pull org master

bash scripts/sync-grammar.sh --source ../umple-lsp
bash scripts/sync-grammar.sh --source ../umple-lsp --check

# Bump extension.toml version.
CARGO_TARGET_DIR=/tmp/umple-zed-target cargo build --release --target wasm32-wasip2
git diff --check

git add extension.toml languages/umple/highlights.scm
git commit -m "Sync Umple grammar for <ZED_VERSION>"
git push org master

git tag "v<ZED_VERSION>"
git push org "v<ZED_VERSION>"
```

The sync script is the only supported way to update the pinned grammar rev and copied highlight query. Manual edits to `languages/umple/highlights.scm` should be made upstream in `umple-lsp/packages/tree-sitter-umple/queries/highlights.scm`, then synced.

## 4. Zed Marketplace PR

In the local `DraftTin/extensions` fork. In this workspace the Git checkout is `../extensions 2`, while `../extensions` is not a Git checkout.

```bash
cd ../extensions\ 2
git fetch --all --prune
git switch -c codex/umple-<ZED_VERSION> upstream/main
git submodule update --init extensions/umple

git -C extensions/umple fetch --tags origin
git -C extensions/umple checkout "v<ZED_VERSION>"

# Edit extensions.toml [umple] version to <ZED_VERSION>.

COREPACK_ENABLE_AUTO_PIN=0 pnpm install --frozen-lockfile
COREPACK_ENABLE_AUTO_PIN=0 pnpm build
COREPACK_ENABLE_AUTO_PIN=0 pnpm test
COREPACK_ENABLE_AUTO_PIN=0 pnpm sort-extensions
git diff --check

git add extensions.toml extensions/umple
git commit -m "umple: <ZED_VERSION>"
git push -u origin codex/umple-<ZED_VERSION>

gh pr create \
  --repo zed-industries/extensions \
  --base main \
  --head DraftTin:codex/umple-<ZED_VERSION> \
  --title "umple: <ZED_VERSION>" \
  --body "Bump Umple extension to <ZED_VERSION>."
```

Confirm the PR points at a tagged `umple.zed` commit. Marketplace maintainers commonly reject submodule updates that point at untagged commits.

## 5. Neovim and Other Editors

No central publish step is needed for Neovim, BBEdit, IntelliJ/LSP4IJ, Helix, or other generic LSP clients. Once npm has the new `umple-lsp-server`:

- Zed downloads it at extension load.
- `umple.nvim` users get it on their next plugin rebuild.
- Generic LSP users get it by updating their global or project npm install.

If grammar queries changed, Neovim users may also need to rebuild or refresh the tree-sitter parser/query install as documented in [08-publishing-nvim.md](08-publishing-nvim.md).

## Final Sanity Checks

```bash
npm view umple-lsp-server version --registry https://registry.npmjs.org/
git -C ../umple.vscode log --oneline -1
git -C ../umple.zed describe --tags --exact-match
gh pr list --repo zed-industries/extensions --search "umple in:title state:open"
```

Record any release-specific notes in the relevant release table:

- `packages/server/CHANGELOG.md`
- `wiki/05-publishing-npm.md`
- `wiki/06-publishing-vscode.md`
- `wiki/07-publishing-zed.md` if the Zed flow changes
