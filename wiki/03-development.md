# 03 — Development

How to set up locally, build, test, and iterate on the LSP server + grammar.

## Prerequisites

- **Node.js 20+** (we test on 20 and 23)
- **npm 10+**
- **Java 11+** — needed only for diagnostics testing (`umplesync.jar` is a Java jar)
- **tree-sitter CLI** — installed automatically as a dev dep when you `npm install`

Optional but recommended:

- **gh** (GitHub CLI) — for inspecting workflow runs, PR creation
- **jq** / **yq** — for poking at JSON / YAML when debugging CI

## First-time setup

Clone all four lsp-side repos side-by-side under one workspace folder. The conventional layout is:

```
~/workspace/lsp_umple/
├── umple-lsp/        ← THIS repo (server + grammar)
├── umple.vscode/     ← VS Code extension
├── umple.zed/        ← Zed extension
└── umple.nvim/       ← Neovim plugin
```

```bash
cd ~/workspace/lsp_umple
git clone https://github.com/umple/umple-lsp.git
git clone https://github.com/umple/umple.vscode.git
git clone https://github.com/umple/umple.zed.git
git clone https://github.com/umple/umple.nvim.git
```

Then install the umple-lsp monorepo:

```bash
cd umple-lsp
npm install
```

That sets up both `packages/server` and `packages/tree-sitter-umple` via npm workspaces. **`npm install` alone does NOT build anything** — there's no `postinstall` hook. Run `npm run compile` next (or `npm run copy-wasm` if you only want the WASM + queries copied without recompiling TS):

```bash
npm run compile
```

This generates `parser.c` from `grammar.js`, builds `tree-sitter-umple.wasm`, copies the WASM + `.scm` query files into `packages/server/`, then runs `tsc -b`.

If you want to run diagnostics locally, you also need `umplesync.jar`:

```bash
npm run download-jar
# downloads from try.umple.org/scripts/umplesync.jar into packages/server/umplesync.jar
```

The server auto-discovers it at `packages/server/umplesync.jar` (relative to the server module).

## Build commands

| Command | What it does |
|---------|--------------|
| `npm run compile` | Full pipeline: `tree-sitter generate` → `tree-sitter build --wasm` → copy WASM + queries into server package → `tsc -b` |
| `npm run build-grammar` | Same as `compile`. Use this name when emphasizing the grammar regen step. |
| `npm run watch` | TypeScript watch mode for the server. Doesn't watch grammar — re-run `compile` after grammar edits. |
| `npm run copy-wasm` | Just the WASM + .scm copy step. Useful when you only edited a `.scm` file. |
| `npm test` | Auto-compiles, runs the semantic test suite, then runs parser and formatter corpus self-tests. |
| `npm run download-jar` | Pulls latest `umplesync.jar` from try.umple.org. |

## Running the server standalone

```bash
node packages/server/out/server.js --stdio
```

Then send LSP JSON-RPC over stdin. Useful for protocol-level debugging. The server also accepts:

```bash
node packages/server/out/server.js --version    # prints version, exits
node packages/server/out/server.js --help       # prints usage, exits
```

## Editing the server

1. Edit a TS file in `packages/server/src/`
2. `npm run compile` (or `npm run watch` once)
3. **Restart your editor's LSP** so it loads the new code — Node won't hot-reload (`:LspRestart` in nvim, "Developer: Reload Window" in VS Code)

## Editing the grammar

1. Edit `packages/tree-sitter-umple/grammar.js`
2. `npm run compile` regenerates `parser.c`, rebuilds the WASM, copies it to the server package, and recompiles the server
3. Sanity-check the parse:
   ```bash
   cd packages/tree-sitter-umple
   npx tree-sitter parse ../../test/some_file.ump
   ```
4. Run the semantic tests: `npm test` from repo root
5. If you also touched query files (`queries/*.scm`), the copy step is included in `compile` automatically
6. Restart your editor's LSP

For Neovim you also need to recompile the native parser:

```vim
:TSInstall umple
```

See [04-grammar.md](04-grammar.md) for the deeper grammar workflow.

## Testing

**Always test programmatically before testing in an editor.** Editor restart cycles are slow and the test harness gives you precise inspection.

### Run the full suite

```bash
npm test
```

Compiles + runs all 682 assertions against fixture files in `packages/server/test/fixtures/semantic/`. Should print `682 passed, 0 failed`. If a test fails, the error message includes the marker name and a snippet of the offending output.

### Add a test

Two-step pattern:

1. **Add a fixture file** to `packages/server/test/fixtures/semantic/<NN>_<name>.ump`. Use `/*@marker_name*/` to pin cursor positions:
   ```umple
   class /*@cls_a*/A {
     name;
     /*@inside_body*/
   }
   ```

2. **Add assertions** in `packages/server/test/semantic.test.ts`. Find the end of `TEST_CASES` and append a block:
   ```ts
   {
     name: "NN test_name: short description",
     fixtures: ["<NN>_<name>.ump"],
     assertions: [
       { type: "parse_clean", fixture: "<NN>_<name>.ump" },
       { type: "goto_def", at: "ref_marker", expect: [{ at: "def_marker" }] },
       { type: "completion_kinds", at: "inside_body", expect: "class_body" },
       // …
     ],
   },
   ```

The available assertion types are documented inline at the top of `semantic.test.ts`. Common ones:

- `parse_clean` / `parse_has_error`
- `symbol_count` — `{ name, kind, expect: number }`
- `goto_def` / `goto_def_exact` / `goto_def_empty`
- `refs` / `refs_exclude` / `shared_refs`
- `hover_output` (must contain) / `hover_excludes` (must NOT contain)
- `completion_kinds` / `completion_includes` / `completion_excludes`
- `rename_edits` / `rename_rejected`
- `document_symbols`
- `format_output` / `format_idempotent`

### Programmatic probes (no test harness)

Quick one-off debugging — drop into a `node - <<NODE` block:

```bash
node - <<'NODE'
const path = require('path');
const fs = require('fs');
const { SymbolIndex } = require('./packages/server/out/symbolIndex.js');

(async () => {
  const si = new SymbolIndex();
  await si.initialize(path.resolve('packages/server/tree-sitter-umple.wasm'));

  const file = path.resolve('test/Person.ump');
  si.indexFile(file, fs.readFileSync(file, 'utf8'));

  const token = si.getTokenAtPosition(file, fs.readFileSync(file, 'utf8'), 10, 5);
  console.log('token at L11:5:', token);
})();
NODE
```

Or for completion specifically:

```bash
node - <<'NODE'
const path = require('path');
const fs = require('fs');
const TS = require('web-tree-sitter');
const { analyzeCompletion } = require('./packages/server/out/completionAnalysis.js');

(async () => {
  await TS.Parser.init();
  const lang = await TS.Language.load(path.resolve('packages/server/tree-sitter-umple.wasm'));
  const parser = new TS.Parser();
  parser.setLanguage(lang);
  const completionsScm = fs.readFileSync(path.resolve('packages/server/completions.scm'), 'utf8');
  const completionsQuery = new TS.Query(lang, completionsScm);

  const src = `class C { 1 -> * `;
  const tree = parser.parse(src + '}');
  const info = analyzeCompletion(tree, lang, completionsQuery, src + '}', 0, src.length);
  console.log('scope:', info.symbolKinds);
})();
NODE
```

This pattern is used heavily during topic-driven development — see commits 109cd2a / 9bba9d7 / 757232e / 9f00033 for examples.

### Manual testing in editors

After programmatic tests pass, smoke-test in at least one editor:

- **VS Code:** open `umple.vscode/` in VS Code, hit F5 to launch the Extension Development Host. Open a `.ump` file from `test/`. Try go-to-def, completion, hover, rename.
- **Neovim:** if you've set up `umple.nvim` with a symlinked dev install (see [08-publishing-nvim.md](08-publishing-nvim.md)), nvim picks up your local `packages/server/out/` automatically. `:LspRestart` after each compile.
- **Zed:** harder to test locally. Edit `umple.zed/` and `zed: open extension dev`-style; not heavily used in our flow.

### Upstream Umple / UmpleOnline safety check

When a change affects an LSP feature, especially workspace-scoped behavior such as rename, references, workspace symbols, implementations, diagnostics, or file lifecycle handling, also check the current upstream Umple checkout. Keep the checkout beside this repo:

```bash
cd /Users/ningyuheng/workspace/umple-dev
git clone https://github.com/umple/umple.git umple
# later refreshes:
git -C umple pull --ff-only
```

Then run the normal LSP suite and the current upstream compiler corpus report:

```bash
cd /Users/ningyuheng/workspace/umple-dev/umple-lsp
npm test
UMPLE_CORPUS_DIR=/Users/ningyuheng/workspace/umple-dev/umple/cruise.umple/test npm run parse:corpus
```

For UmpleOnline compatibility, inspect the browser/proxy boundary in the upstream checkout:

```bash
node --check /Users/ningyuheng/workspace/umple-dev/umple/umpleonline/scripts/lsp-proxy/server.js
node --check /Users/ningyuheng/workspace/umple-dev/umple/umpleonline/scripts/codemirror6/editor.mjs
```

The important invariant is that UmpleOnline starts one LSP process per model session. Its CodeMirror client sets `rootUri` to `file://<window.UMPLE_UMP_BASE>/<Page.getModel()>`, while the WebSocket proxy validates the `session` query parameter against `UMP_BASE_DIR` and spawns a fresh `umple-lsp-server` process for that model directory. Workspace-wide server features must therefore stay bounded to that model root, plus explicit `use`-reachable files, and must not assume the root is the whole `umpleonline/ump` tree.

If you have a configured UmpleOnline browser test environment, run the LSP specs in `umpleonline/testsuite/spec/lsp_phase*_test_spec.rb` against the server build being tested. Without that environment, treat the corpus report plus the static proxy/client check as a compatibility smoke test, not a full browser E2E pass.

## Symlink-vs-npm dev flow

`umple.nvim/node_modules/umple-lsp-server` is **a symlink** to `umple-lsp/packages/server` on the standard dev box (set up manually once with `ln -s`). This lets nvim consume your local server without npm publish per change. The same is NOT done by default for umple.vscode (it has a real install) — for VS Code, either:

- Mirror the symlink trick: `ln -sf ../../../umple-lsp/packages/server umple.vscode/node_modules/umple-lsp-server`
- Or use `npm link`: `cd packages/server && npm link`, then `cd ~/.../umple.vscode && npm link umple-lsp-server`

After symlink/link setup, `npm run compile` in umple-lsp is enough to refresh both editors (after LSP restart).

## Where to go next

- Architecture deep dive → [02-architecture.md](02-architecture.md)
- Grammar work → [04-grammar.md](04-grammar.md)
- Common debugging patterns → [12-gotchas.md](12-gotchas.md)
