# 10 — CI / automation

What runs automatically and what doesn't, why, and how to maintain it.

## Workflows

### `umple-lsp/.github/workflows/ci.yml`

Builds and tests the LSP on pull requests to `master`, pushes to `master`, and manual dispatch.

**Trigger:**

```yaml
on:
  pull_request:
    branches: [master]
  push:
    branches: [master]
  workflow_dispatch: {}
```

**Steps (high-level):**

1. Checkout umple-lsp.
2. Install Node 22.
3. Install Java 17 because snippet compiler-validation tests invoke `umplesync.jar`.
4. Run `npm install` (this repo does not track a root lockfile, so CI does not use `npm ci`).
5. Run `npm run download-jar`.
6. Run root `npm test`, which rebuilds the grammar/WASM, runs the semantic suite, and runs parser/formatter corpus self-tests against generated mini-corpora.

### Corpus parse stress reporter

The repo includes a read-only corpus reporter:

```bash
UMPLE_CORPUS_DIR=/path/to/cruise.umple/test npm run parse:corpus
```

It recursively parses `.ump` files, strips UmpleOnline layout tails, and reports how many files contain tree-sitter ERROR nodes. It does not download or clone the compiler corpus. If no corpus path is configured it skips cleanly; if a path is explicitly provided but invalid it fails so typos are visible.

The full compiler corpus is not part of the default CI job because GitHub runners do not have `cruise.umple/test` checked out. Default mode is report-only even when parse errors are found. Use `UMPLE_CORPUS_FAIL_ON_ERROR=1` or `--fail-on-error` only after choosing a baseline that should block merges.

### `umple-lsp/.github/workflows/sync-umple-zed.yml`

Auto-opens (or updates) a PR on `umple/umple.zed` whenever the grammar or query files change in this repo.

**Trigger:**

```yaml
on:
  push:
    branches: [master]
    paths:
      - "packages/tree-sitter-umple/grammar.js"
      - "packages/tree-sitter-umple/src/parser.c"
      - "packages/tree-sitter-umple/queries/**.scm"
  workflow_dispatch: {}
```

Pushes that ONLY touch the server TS or fixtures don't fire it (no zed-side artifact to update).

**Steps (high-level):**

1. Checkout umple-lsp at the pushed SHA (`fetch-depth: 0` — needed so `github.event.before` is in history for the diff)
2. Checkout `umple/umple.zed` using `UMPLE_ZED_BOT_PAT` secret
3. Classify change type from `git diff --name-only $before HEAD --` against the path filter → `grammar | highlights | both`
4. Run `bash scripts/sync-grammar.sh --source ../umple-lsp` inside umple.zed (this is umple.zed's own script — we don't reach in to modify it)
5. Check if sync produced any diff. If no → log "no PR needed" and exit clean.
6. Patch-bump `extension.toml` version
7. Force-push to stable branch `sync/umple-lsp-master` (so repeated commits coalesce into one open PR instead of stacking)
8. Open new PR or `gh pr edit` the existing one. PR body contains:
   - source SHA
   - change type
   - changed paths
   - merge-gate note: "highlights only → safe; grammar/both → wait for npm publish if new syntax requires server-side support"

The original design rationale for keeping release actions human-gated is in `.collab/archive/040_zed_release_automation_scope.md`. npm publish now uses a manually approved Trusted Publishing workflow instead of a local token-backed publish.

**Required secrets:** `UMPLE_ZED_BOT_PAT` (fine-grained PAT scoped to `umple/umple.zed`, Contents R/W + Pull requests R/W). To rotate:

1. Create a new fine-grained PAT at https://github.com/settings/personal-access-tokens/new
2. Resource owner `umple`, repo `umple/umple.zed`, permissions Contents R/W + Pull requests R/W
3. Update at https://github.com/umple/umple-lsp/settings/secrets/actions

### `umple.zed/.github/workflows/check-sync.yml`

Companion drift detector in the umple.zed repo. Runs on push/PR to umple.zed master and verifies that `extension.toml` rev + `languages/umple/highlights.scm` match what's in the pinned umple-lsp HEAD. Fails the build if drift is detected.

This catches the case where someone manually edits umple.zed without running the sync script. In normal flow you don't see it — the auto-PR keeps things in sync, and merging the PR doesn't introduce drift.

## What we deliberately do NOT automate

### npm publish

Manual approval, automated execution. `.github/workflows/publish-npm.yml` is a `workflow_dispatch` release workflow protected by the `npm-publish` GitHub Environment. It publishes through npm Trusted Publishing / OIDC, so no long-lived npm token is stored in GitHub.

Reasons for this shape:

- npm publish is a hard-to-reverse action with global blast radius, so a human still bumps the committed package version and approves the environment. The workflow has no manual version input; its Run workflow dialog shows a one-option Version source field and publishes the version from `packages/server/package.json`.
- Trusted Publishing removes the shared-token problem and gives npm provenance for public packages.
- The workflow re-runs the full test suite, performs a dry-run package publish, publishes from `packages/server`, and verifies the exact registry version.

### VS Code marketplace publish

Manual. `npx vsce publish` from `umple.vscode/` in your terminal. Reasons:

- `digized` PAT lives on a personal Azure DevOps account; not delegating it to a CI bot.
- Marketplace users expect slow, meaningful version churn.
- We want a human eyeball on the .vsix before it ships (e.g. install + smoke test).

### zed-industries/extensions marketplace PR

Manual. PR opened from your fork (DraftTin/extensions) into `zed-industries/extensions`. Reasons:

- zed-industries maintainers manually review every PR. Auto-firing PRs annoys them.
- Marketplace users expect slow churn here too.
- The submodule + `extensions.toml` bump is a 5-minute manual task; not worth automating.

## Past automation considered + rejected

We discussed a "tag-triggered coupled automation" pattern — push a tag like `server-v0.4.3`, CI publishes npm + opens umple.zed PR + opens marketplace PR. Decided against it because the coupling is mostly cosmetic: the LSP server and the Zed grammar copy don't need to advance in lockstep at the wire-protocol level (Zed parses source itself, server parses source itself; they don't exchange ASTs). See `.collab/archive/040_zed_release_automation_scope.md` for the full discussion.

## How to add a new workflow

Two reasons you'd add one:

- **Additional release or drift automation.** The LSP already has build/test CI and umple.zed sync PR automation. New workflows should cover a distinct release, dependency, or external-sync need.
- **Auto-bump and PR new dependency versions.** Dependabot can do this without writing a workflow. Configure at `.github/dependabot.yml` (we don't currently use it).

For ANY new workflow:

1. Use `concurrency:` group to prevent races
2. Pin third-party actions to a SHA, not a tag
3. Test with `workflow_dispatch:` first before relying on auto-triggers

## Workflow run dashboard

https://github.com/umple/umple-lsp/actions

Filter by workflow name "Sync grammar to umple.zed" to see the auto-sync history.

To inspect a specific run from the CLI:

```bash
gh run list --repo umple/umple-lsp --workflow sync-umple-zed.yml --limit 5
gh run view <run-id> --repo umple/umple-lsp --log
```

## Where to go next

- Why the workflow design ended up this way → `.collab/archive/040_zed_release_automation_scope.md`
- The umple.zed-side companion workflow → covered briefly above
- General Zed publishing → [07-publishing-zed.md](07-publishing-zed.md)
