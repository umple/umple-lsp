# 07 — Publishing the Zed extension

The Zed extension is structurally different from VS Code. Zed extensions ship as Rust crates that compile to WASM (`wasm32-wasip2`). The crate references the tree-sitter grammar by **a pinned `rev`** in `extension.toml`, and Zed builds the grammar from that commit when installing the extension. The LSP server is downloaded at runtime from npm by the extension's `lib.rs`.

So shipping to Zed has TWO axes:

1. **The extension repo** (`umple.zed`) — bumped + auto-PR'd by CI when grammar/queries change in this repo. You merge that PR.
2. **The marketplace** (`zed-industries/extensions`) — a separate repo whose `extensions/umple/` is a git submodule pointer to a tag in `umple.zed`. You manually open a PR there when you want a marketplace release.

## Repo details

- **Extension repo:** github.com/umple/umple.zed
- **Marketplace fork:** github.com/DraftTin/extensions (your fork) → PRs into github.com/zed-industries/extensions
- **Page (after marketplace):** Zed's extension browser → search "umple"
- **Build target:** WASM `wasm32-wasip2` via `cargo build --release`

## How the Zed extension consumes our work

Two files in `umple.zed/`:

```
extension.toml
  ├── version = "X.Y.Z"          ← extension's own version
  └── grammars.umple.rev = "<umple-lsp commit SHA>"   ← pins which umple-lsp HEAD's parser.c gets compiled

languages/umple/highlights.scm   ← copied from umple-lsp/packages/tree-sitter-umple/queries/highlights.scm
                                    (Zed loads from extension's languages/, NOT from the grammar repo)

src/lib.rs                       ← Rust glue: at extension load, calls
                                    npm_package_latest_version("umple-lsp-server"),
                                    download_file(...) the tarball, extracts, runs the server.
```

So bumping the `rev` makes Zed pull a different parser.c from umple-lsp; copying highlights.scm makes Zed re-color tokens; new LSP server features arrive via npm without any Zed extension change.

## The auto-sync workflow

We have CI in this repo (`.github/workflows/sync-umple-zed.yml`) that automates parts 1 and 2 of the umple.zed update. See [10-ci-automation.md](10-ci-automation.md) for the workflow's full design.

**Triggers** on push to `master` that touches:

- `packages/tree-sitter-umple/grammar.js`
- `packages/tree-sitter-umple/src/parser.c`
- `packages/tree-sitter-umple/queries/**.scm`

**Does:** clones umple.zed with a bot PAT, runs `umple.zed/scripts/sync-grammar.sh --source ../umple-lsp` (which bumps `extension.toml.rev` + copies `highlights.scm` — that's all the script does), then in a separate workflow step bumps the `extension.toml` patch version, force-pushes to a stable branch `sync/umple-lsp-master`, and opens (or updates in place) a PR with a body that classifies the change as `grammar | highlights | both` and tells the reviewer whether to wait for npm publish before merging.

**One-time setup:** create `UMPLE_ZED_BOT_PAT` (fine-grained PAT scoped to `umple/umple.zed`, Contents + Pull requests R/W) and add to `umple-lsp` repo secrets. PATs expire annually — when CI starts failing with 401, that's the first thing to check. See [10-ci-automation.md](10-ci-automation.md) for the rotation procedure.

## Release flow (umple.zed extension version)

This is the part the auto-sync workflow handles. You just merge the PR.

After a relevant push to umple-lsp:

1. Workflow fires → opens or updates PR `#N` on umple.zed titled `Sync from umple-lsp@<sha> (<change-type>, v<X.Y.Z>)`
2. Read the PR body's "Safe to merge?" section:
   - **highlights-only** → merge immediately, no other action needed
   - **grammar or both** → make sure you've published the matching `umple-lsp-server` to npm first (run `npm view umple-lsp-server version` to check). Otherwise the new grammar lands in Zed but server features lag. Merge after npm catches up.
3. Merge the PR. umple.zed master now has the new rev + highlights + version.
4. (Done — but for marketplace, see next section.)

## Release flow (marketplace — manual)

Cutting a marketplace release means making the Zed Extensions Marketplace serve the new umple.zed version. This is intentionally manual because zed-industries maintainers review every PR and marketplace users expect slow, meaningful releases.

The marketplace lives in github.com/zed-industries/extensions. Each extension is a git submodule pointer + an `extensions.toml` entry. You PR a submodule bump.

```bash
# 1. Tag the umple.zed version (so the submodule pointer is meaningful)
cd ~/.../workspace/lsp_umple/umple.zed
git pull origin master                    # make sure you have the latest merged sync PR
ZED_VERSION=$(grep '^version' extension.toml | sed 's/.*"\([0-9.]*\)".*/\1/')
git tag "v$ZED_VERSION"
git push origin "v$ZED_VERSION"

# 2. Update your fork of zed-industries/extensions
cd ~/.../workspace/extensions     # your local clone of DraftTin/extensions (the fork)
git fetch upstream                # upstream = zed-industries/extensions
git checkout main
git reset --hard upstream/main    # always start from upstream's tip

# 3. Update the submodule pointer
cd extensions/umple
git fetch origin                  # origin = umple/umple.zed
git checkout "v$ZED_VERSION"
cd ../..

# 4. Bump the version in extensions.toml
# Edit extensions/extensions.toml, find the `umple` entry, bump version to match $ZED_VERSION
$EDITOR extensions.toml

# 5. Commit + branch + push
git add extensions/umple extensions.toml
git commit -m "umple: <X.Y.Z>"
git checkout -b sync/umple-$ZED_VERSION
git push origin sync/umple-$ZED_VERSION

# 6. Open the PR
gh pr create \
  --repo zed-industries/extensions \
  --base main --head DraftTin:sync/umple-$ZED_VERSION \
  --title "umple: <X.Y.Z>" \
  --body "Bump Umple extension to <X.Y.Z>. Adds <summary of new features>."
```

Then wait. zed-industries reviews PRs in their own time — usually days but sometimes weeks. They'll comment if anything's wrong (most common: the `version` in `extensions.toml` doesn't match the tag, or the submodule pointer is on a non-tagged commit).

## Verifying a Zed install locally

Hard to test locally without publishing. Two options:

- **Dev mode in Zed:** `cmd-shift-p` → "zed: install dev extension" → point at `umple.zed/`. Zed builds the WASM and loads it.
- **Manual test of just the WASM build:**
  ```bash
  cd ~/.../umple.zed
  CARGO_TARGET_DIR=/tmp/umple-zed-target cargo build --release --target wasm32-wasip2
  # success means the Rust glue is compileable. Doesn't test it actually runs.
  ```

The `CARGO_TARGET_DIR=/tmp/...` workaround sidesteps an iCloud Drive issue we hit where cargo's `target/` inside iCloud caused multi-hour build hangs. See [12-gotchas.md](12-gotchas.md).

## Troubleshooting

### `sync/umple-lsp-master` PR doesn't auto-update on subsequent pushes

CI uses force-push. If the PR didn't update:
- Check `.github/workflows/sync-umple-zed.yml` runs at https://github.com/umple/umple-lsp/actions
- Look for failed runs (red X). Most common: `UMPLE_ZED_BOT_PAT` expired.

### Zed users report "extension not loading"

Usually the LSP server tarball download is the issue. Zed's `lib.rs` calls `npm_package_latest_version("umple-lsp-server")` then `download_file(<npm tarball URL>, ...)`. If npm is rate-limiting or the user is offline, that fails.

### Marketplace PR rejected for non-tagged submodule

Re-tag umple.zed at the merged-sync commit, force-push the tag if necessary, then re-point the submodule on your sync branch.

### Fork desync (DraftTin/extensions has stale main)

Always start your sync branch from `upstream/main` after `git reset --hard upstream/main`. Don't merge upstream into your fork's main; just hard-reset.

## Where to go next

- Companion CI workflow design → [10-ci-automation.md](10-ci-automation.md)
- Server-side release that the umple.zed PR needs → [05-publishing-npm.md](05-publishing-npm.md)
- Neovim is simpler — just [08-publishing-nvim.md](08-publishing-nvim.md)
