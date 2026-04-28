#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_TOP = 20;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".test-out",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

function requireBuilt(modulePath) {
  const resolved = path.join(REPO_ROOT, "packages/server/out", modulePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Missing built server module: ${resolved}. Run \`npm run compile\` first.`,
    );
  }
  return require(resolved);
}

const { SymbolIndex } = requireBuilt("symbolIndex.js");
const { stripLayoutTail } = requireBuilt("tokenTypes.js");
const {
  expandCompactStates,
  computeIndentEdits,
  fixTransitionSpacing,
  fixAssociationSpacing,
  fixDeclarationAssignmentSpacing,
  fixStructuralCommaSpacing,
  normalizeTopLevelBlankLines,
  reindentEmbeddedCode,
} = requireBuilt("formatter.js");
const { checkFormatSafety } = requireBuilt("formatSafetyNet.js");

function parsePositiveInteger(value, name) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function readOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

function readInlineOptionValue(value, name) {
  if (value === "") throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv, env) {
  const options = {
    corpusDir: env.UMPLE_FORMAT_CORPUS_DIR ?? env.UMPLE_CORPUS_DIR,
    failOnError:
      env.UMPLE_FORMAT_CORPUS_FAIL_ON_ERROR === "1" ||
      env.UMPLE_CORPUS_FAIL_ON_ERROR === "1",
    jsonPath: env.UMPLE_FORMAT_CORPUS_JSON,
    maxFiles: parsePositiveInteger(
      env.UMPLE_FORMAT_CORPUS_MAX_FILES ?? env.UMPLE_CORPUS_MAX_FILES,
      "UMPLE_FORMAT_CORPUS_MAX_FILES",
    ),
    selfTest: false,
    top: parsePositiveInteger(
      env.UMPLE_FORMAT_CORPUS_TOP ?? env.UMPLE_CORPUS_TOP,
      "UMPLE_FORMAT_CORPUS_TOP",
    ) ?? DEFAULT_TOP,
    wasmPath: env.UMPLE_TREE_SITTER_WASM_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--fail-on-error") {
      options.failOnError = true;
    } else if (arg === "--top") {
      options.top = parsePositiveInteger(readOptionValue(argv, i, "--top"), "--top");
      i += 1;
    } else if (arg.startsWith("--top=")) {
      options.top = parsePositiveInteger(readInlineOptionValue(arg.slice("--top=".length), "--top"), "--top");
    } else if (arg === "--max-files") {
      options.maxFiles = parsePositiveInteger(readOptionValue(argv, i, "--max-files"), "--max-files");
      i += 1;
    } else if (arg.startsWith("--max-files=")) {
      options.maxFiles = parsePositiveInteger(
        readInlineOptionValue(arg.slice("--max-files=".length), "--max-files"),
        "--max-files",
      );
    } else if (arg === "--json") {
      options.jsonPath = readOptionValue(argv, i, "--json");
      i += 1;
      if (!options.jsonPath) throw new Error("--json requires an output path");
    } else if (arg.startsWith("--json=")) {
      options.jsonPath = readInlineOptionValue(arg.slice("--json=".length), "--json");
    } else if (arg === "--wasm") {
      options.wasmPath = readOptionValue(argv, i, "--wasm");
      i += 1;
      if (!options.wasmPath) throw new Error("--wasm requires a WASM path");
    } else if (arg.startsWith("--wasm=")) {
      options.wasmPath = readInlineOptionValue(arg.slice("--wasm=".length), "--wasm");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.corpusDir) {
      options.corpusDir = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

function resolveWasmPath(configuredPath) {
  const candidates = [
    configuredPath,
    path.join(REPO_ROOT, "packages/server/tree-sitter-umple.wasm"),
    path.join(REPO_ROOT, "packages/tree-sitter-umple/tree-sitter-umple.wasm"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  throw new Error(
    "tree-sitter-umple.wasm was not found. Run `npm run compile` first, or set UMPLE_TREE_SITTER_WASM_PATH.",
  );
}

async function collectUmpleFiles(rootDir, maxFiles) {
  const files = [];

  async function walk(dir) {
    if (maxFiles && files.length >= maxFiles) return;

    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (maxFiles && files.length >= maxFiles) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ump")) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

function toOffsetFactory(text) {
  const lines = text.split("\n");
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  return (line, col) => (lineOffsets[line] ?? text.length) + col;
}

function applyEdits(text, edits) {
  const toOffset = toOffsetFactory(text);
  const sorted = [...edits].sort(
    (a, b) =>
      toOffset(b.range.start.line, b.range.start.character) -
      toOffset(a.range.start.line, a.range.start.character),
  );

  let result = text;
  for (const edit of sorted) {
    const start = toOffset(edit.range.start.line, edit.range.start.character);
    const end = toOffset(edit.range.end.line, edit.range.end.character);
    result = result.substring(0, start) + edit.newText + result.substring(end);
  }
  return result;
}

function formatOnce(symbolIndex, filePath, originalText) {
  symbolIndex.updateFile(filePath, originalText);
  const originalTree = symbolIndex.getTree(filePath);
  if (!originalTree) throw new Error("no parse tree");
  if (originalTree.rootNode.hasError) return originalText;

  let text = originalText;
  let formatTree = originalTree;
  const expandedText = expandCompactStates(text, formatTree);
  if (expandedText !== text) {
    text = expandedText;
    symbolIndex.updateFile(filePath, text);
    formatTree = symbolIndex.getTree(filePath);
    if (!formatTree) throw new Error("no parse tree after compact-state expansion");
  }

  const options = { tabSize: 2, insertSpaces: true };
  const edits = [
    ...computeIndentEdits(text, options, formatTree),
    ...fixTransitionSpacing(text, formatTree),
    ...fixAssociationSpacing(text, formatTree),
    ...fixDeclarationAssignmentSpacing(text, formatTree),
    ...fixStructuralCommaSpacing(text, formatTree),
    ...normalizeTopLevelBlankLines(text, formatTree),
    ...reindentEmbeddedCode(text, options, formatTree),
  ];
  const finalText = applyEdits(text, edits);

  if (expandedText !== originalText) {
    symbolIndex.updateFile(filePath, originalText);
  }
  if (finalText === originalText) return finalText;

  const originalSymbols = symbolIndex.getFileSymbols(filePath);
  symbolIndex.updateFile(filePath, finalText);
  const formattedTree = symbolIndex.getTree(filePath);
  const formattedClean = formattedTree ? !formattedTree.rootNode.hasError : false;
  const formattedSymbols = symbolIndex.getFileSymbols(filePath);
  symbolIndex.updateFile(filePath, originalText);

  const check = checkFormatSafety(originalSymbols, formattedSymbols, true, formattedClean);
  if (!check.safe) {
    throw new Error(`format safety check failed: ${check.reason}`);
  }

  return finalText;
}

function firstDiffLine(aText, bText) {
  const a = aText.split("\n");
  const b = bText.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `${i + 1}: ${JSON.stringify(a[i])} != ${JSON.stringify(b[i])}`;
    }
  }
  return "text differs";
}

async function scanCorpus(options) {
  const corpusDir = path.resolve(options.corpusDir);
  const stats = await fsp.stat(corpusDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw Object.assign(new Error(`Corpus directory does not exist: ${corpusDir}`), { exitCode: 2 });
  }

  const wasmPath = resolveWasmPath(options.wasmPath);
  const symbolIndex = new SymbolIndex();
  const initialized = await symbolIndex.initialize(wasmPath);
  if (!initialized) throw new Error(`Failed to initialize parser with ${wasmPath}`);

  const files = await collectUmpleFiles(corpusDir, options.maxFiles);
  if (files.length === 0) {
    throw Object.assign(new Error(`No .ump files found under ${corpusDir}`), { exitCode: 2 });
  }

  const failures = [];
  const readErrors = [];
  let parseClean = 0;
  let parseSkipped = 0;
  let formattedClean = 0;
  let changed = 0;
  let unchanged = 0;

  const startedAt = Date.now();
  for (const filePath of files) {
    let source;
    const relativeFile = path.relative(corpusDir, filePath);
    try {
      source = stripLayoutTail(await fsp.readFile(filePath, "utf8"));
    } catch (error) {
      readErrors.push({ file: relativeFile, message: error.message });
      continue;
    }

    symbolIndex.updateFile(filePath, source);
    const tree = symbolIndex.getTree(filePath);
    if (!tree || tree.rootNode.hasError) {
      parseSkipped += 1;
      continue;
    }

    parseClean += 1;
    try {
      const pass1 = formatOnce(symbolIndex, filePath, source);
      symbolIndex.updateFile(filePath, pass1);
      const formattedTree = symbolIndex.getTree(filePath);
      if (!formattedTree || formattedTree.rootNode.hasError) {
        failures.push({ file: relativeFile, reason: "formatted output has parse errors" });
        continue;
      }

      const pass2 = formatOnce(symbolIndex, filePath, pass1);
      if (pass1 !== pass2) {
        failures.push({
          file: relativeFile,
          reason: `not idempotent at ${firstDiffLine(pass1, pass2)}`,
        });
        continue;
      }

      formattedClean += 1;
      if (pass1 === source) unchanged += 1;
      else changed += 1;
    } catch (error) {
      failures.push({ file: relativeFile, reason: error.message });
    }
  }

  failures.sort((a, b) => a.file.localeCompare(b.file));
  const elapsedMs = Date.now() - startedAt;
  return {
    generatedAt: new Date().toISOString(),
    corpusDir,
    wasmPath,
    mode: options.failOnError ? "fail-on-error" : "report-only",
    maxFiles: options.maxFiles ?? null,
    totalFiles: files.length,
    parseClean,
    parseSkipped,
    formattedClean,
    changed,
    unchanged,
    failures,
    readErrors,
    elapsedMs,
  };
}

function printReport(report, top) {
  console.log("Umple corpus formatter report");
  console.log(`Corpus: ${report.corpusDir}`);
  console.log(`WASM: ${report.wasmPath}`);
  console.log(`Mode: ${report.mode}`);
  if (report.maxFiles) console.log(`Max files: ${report.maxFiles}`);
  console.log(`Files found: ${report.totalFiles}`);
  console.log(`Parse-clean files checked: ${report.parseClean}`);
  console.log(`Parser-error files skipped: ${report.parseSkipped}`);
  console.log(`Formatted clean + idempotent: ${report.formattedClean}`);
  console.log(`Changed: ${report.changed}`);
  console.log(`Unchanged: ${report.unchanged}`);
  console.log(`Failures: ${report.failures.length}`);
  console.log(`Read errors: ${report.readErrors.length}`);
  console.log(`Elapsed: ${(report.elapsedMs / 1000).toFixed(2)}s`);

  if (report.failures.length > 0 && top > 0) {
    console.log("");
    console.log(`Formatter failures (up to ${top}):`);
    for (const failure of report.failures.slice(0, top)) {
      console.log(`- ${failure.file}: ${failure.reason}`);
    }
  }

  if (report.readErrors.length > 0 && top > 0) {
    console.log("");
    console.log(`Read errors (up to ${top}):`);
    for (const item of report.readErrors.slice(0, top)) {
      console.log(`- ${item.file}: ${item.message}`);
    }
  }
}

async function writeJsonReport(report, jsonPath) {
  if (!jsonPath) return;
  const resolved = path.resolve(jsonPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`JSON report: ${resolved}`);
}

async function runSelfTest(options) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "umple-format-corpus-self-test-"));
  try {
    await fsp.writeFile(
      path.join(tempRoot, "clean.ump"),
      [
        "class Clean {",
        "Integer count=5;",
        "status { Open { go->Closed; } }",
        "}",
        "class Other {}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(path.join(tempRoot, "broken.ump"), "class Broken {\n  1 ->\n}\n", "utf8");

    const report = await scanCorpus({
      ...options,
      corpusDir: tempRoot,
      failOnError: true,
      maxFiles: undefined,
    });

    if (report.totalFiles !== 2) {
      throw new Error(`self-test expected 2 files, got ${report.totalFiles}`);
    }
    if (report.parseClean !== 1) {
      throw new Error(`self-test expected 1 parse-clean file, got ${report.parseClean}`);
    }
    if (report.parseSkipped !== 1) {
      throw new Error(`self-test expected 1 parser-error skip, got ${report.parseSkipped}`);
    }
    if (report.formattedClean !== 1 || report.failures.length !== 0) {
      throw new Error("self-test expected the clean file to format cleanly and idempotently");
    }
    if (report.changed !== 1) {
      throw new Error(`self-test expected the clean file to be changed, got ${report.changed}`);
    }

    printReport(report, options.top);
    console.log("");
    console.log("Self-test passed.");
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);

  if (options.selfTest) {
    await runSelfTest(options);
    return 0;
  }

  if (!options.corpusDir) {
    console.log("No corpus configured. Set UMPLE_FORMAT_CORPUS_DIR=/path/to/cruise.umple/test or pass a path.");
    console.log("Skipping corpus formatter report.");
    return 0;
  }

  const report = await scanCorpus(options);
  printReport(report, options.top);
  await writeJsonReport(report, options.jsonPath);

  if (options.failOnError && (report.failures.length > 0 || report.readErrors.length > 0)) {
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
