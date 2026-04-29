# 05 — Publishing the LSP server to npm

The `umple-lsp-server` npm package is the **single shipping unit** for all editor extensions — VS Code bundles it, Zed downloads it at runtime, Neovim installs it during plugin build. So publishing to npm is the action that gets new server / grammar work into users' hands.

## Package details

- **Name:** `umple-lsp-server`
- **Registry:** https://registry.npmjs.org
- **Page:** https://www.npmjs.com/package/umple-lsp-server
- **Publisher:** owned by the `umple` org. Normal releases use Trusted Publishing; npm owner access is still needed to configure package settings or run the manual fallback.
- **Version scheme:** semantic-ish. Patch bump for fixes, minor bump for new features. We've been pretty liberal with patch bumps for small features.

What ships in the tarball (per `packages/server/package.json` `files` field):

```
out/                       — compiled TS
bin/                       — `umple-lsp-server` shebang wrapper
tree-sitter-umple.wasm     — bundled grammar (copied from packages/tree-sitter-umple/)
references.scm             — copied at build time
definitions.scm            — copied at build time
completions.scm            — copied at build time
highlights.scm             — copied at build time for LSP semantic tokens
package.json
README (if present)
```

`umplesync.jar` is **NOT shipped** — editor extensions download it separately or auto-discover it. Keeps the tarball small (~270 KB compressed, ~1.8 MB unpacked).

## One-time setup: Trusted Publishing

The preferred release path is npm Trusted Publishing from GitHub Actions. It uses OpenID Connect (OIDC), so maintainers do not share or rotate a long-lived npm publish token.

GitHub side:

1. In `umple/umple-lsp`, create or verify the GitHub Environment `npm-publish`.
2. Add release maintainers as required reviewers.
3. Keep admin bypass enabled only if the repo admins agree that emergency releases need it.

npm side:

1. Open the npm package settings for `umple-lsp-server`.
2. Add a Trusted Publisher:
   - Provider: GitHub Actions
   - Organization/user: `umple`
   - Repository: `umple-lsp`
   - Workflow filename: `publish-npm.yml`
   - Environment name: `npm-publish`
3. After one successful trusted publish, set Publishing Access to require 2FA and disallow traditional tokens.

Trusted Publishing requires Node `22.14+` and npm CLI `11.5.1+`; the workflow uses Node `24`.

## Release flow

```bash
# 1. From repo root, ensure everything compiles + tests pass
npm test

# 2. Bump version in packages/server/package.json
cd packages/server
npm version <patch|minor|major> --no-git-tag-version
# or pin a specific version: npm version 0.5.0 --no-git-tag-version

# 3. Re-compile so out/ matches the new version
cd ../..
npm run compile

# 4. Commit + push the bump
git add packages/server/package.json
git commit -m "Bump server to <X.Y.Z>"
git push origin master    # or `org master` depending on your remote

# 5. In GitHub Actions, run "Publish npm package" from master.
# Enter X.Y.Z as the expected version, then approve the npm-publish environment.

# 6. Verify
npm view umple-lsp-server version --registry https://registry.npmjs.org/
# should print X.Y.Z after the workflow completes
```

The workflow is `.github/workflows/publish-npm.yml`. It verifies the branch, checks that the input version matches `packages/server/package.json`, rejects already-published versions, installs dependencies, downloads `umplesync.jar`, runs the full test suite, verifies `server --version`, runs `npm publish --dry-run`, publishes from `packages/server`, and checks the registry version.

The post-publish chain (what other things you might want to do after):

- **Zed users automatically benefit.** Zed's extension `lib.rs` calls `npm_package_latest_version("umple-lsp-server")` + `download_file(...)` at every extension load, so a fresh `npm publish` reaches existing Zed users on their next editor startup.
- **Neovim users get it on next plugin rebuild.** `umple.nvim`'s `scripts/build.sh` does `npm install umple-lsp-server` — fresh install pulls the latest version. Users run `:Lazy build umple.nvim` (or equivalent for their plugin manager).
- **VS Code users do NOT auto-pickup.** The `.vsix` bundles a specific server version at packaging time. To deliver the new server to VS Code users you must repackage + republish — see [06-publishing-vscode.md](06-publishing-vscode.md).
- **umple.zed sync PR** — the CI in [10-ci-automation.md](10-ci-automation.md) auto-opens a PR to bump the `rev` in `extension.toml` if the grammar changed. You can merge it any time after npm publish.

## What goes in commit messages

Keep them factual. The auto-sync workflow puts the source SHA into the umple.zed PR body, so the commit message is what people read in npm's release log on the umple-lsp side.

Past examples:
- `Bump server to 0.4.1`
- `LSP: implementsReq traceability across all entity types`
- `Completion: structured req body starters at slot-ready positions`

## Npm-visible update log

Npm itself does not have a first-class release-notes field for each publish. The package page shows `packages/server/README.md`, and the tarball includes `packages/server/CHANGELOG.md`. For user-facing release notes:

1. Update `packages/server/README.md` when the npm page should advertise a new release highlight.
2. Append the new version to `packages/server/CHANGELOG.md`.
3. Append the concise operator-facing entry to the release table below.
4. For editor-specific announcements, update the matching editor publishing doc after the downstream extension is bumped.

## Manual fallback

Use manual `npm publish` only if Trusted Publishing is broken and the release cannot wait. You need an npm account with publish rights and 2FA:

```bash
cd packages/server
npm publish
```

Record why the fallback was used, and rotate/remove any temporary publish token afterward.

## Troubleshooting

### Workflow fails with authentication / OIDC errors

Check:

- npm Trusted Publisher settings exactly match `umple / umple-lsp / publish-npm.yml / npm-publish`.
- `.github/workflows/publish-npm.yml` has `permissions: id-token: write`.
- The workflow is running on GitHub-hosted runners, not self-hosted runners.
- The package's `repository.url` still points at `https://github.com/umple/umple-lsp.git`.

### `npm publish` returns 401

For the workflow, treat this as an OIDC/trusted-publisher configuration problem. For the manual fallback, run `npm login` and make sure your npm account has package publish rights.

### `npm publish` returns `EPUBLISHCONFLICT` / `cannot publish over the previously published versions`

Someone (you, in another shell) already published this version. Bump the version again.

### `npm view umple-lsp-server version` lags behind your publish

CDN propagation. Usually under a minute. `npm view --registry https://registry.npmjs.org/ umple-lsp-server version` to bypass any local cache.

## Recent release log (hand-curated)

Useful for sanity-checking what's in npm vs your local `packages/server/package.json`:

| Version | Date | What it added |
|---------|------|---------------|
| 1.0.1 | 2026-04-29 | Trusted Publishing workflow and release handoff docs; no runtime LSP behavior changes |
| 1.0.0 | 2026-04-29 | Stable LSP baseline: expanded semantic features, formatter safety, parser/query coverage, inlay hints, workspace symbols, and trace transition event symbols |
| 0.4.3 | 2026-04-23 | Topic 044: association arrow slot completion |
| 0.4.2 | 2026-04-23 | Topic 043: typed-prefix association right_type |
| 0.4.1 | 2026-04-22 | Topic 042: association multiplicity / type slot completion |
| 0.4.0 | 2026-04-22 | Phase A–D req/implementsReq catchup (topics 038/039) — structured req bodies, implementsReq across all entity types, requirement rename, etc. |
| 0.3.5 | 2026-04-19 | --version / --help CLI flags + serverInfo in initialize |
| 0.3.4 | 2026-04-08 | Earlier completion polish |

After each new release, append to this table.

## Where to go next

- After npm publish, ship VS Code → [06-publishing-vscode.md](06-publishing-vscode.md)
- Auto-sync to Zed will fire if grammar/queries changed → [07-publishing-zed.md](07-publishing-zed.md)
- For the canonical full-release order of all four pipelines → [10-ci-automation.md](10-ci-automation.md)
