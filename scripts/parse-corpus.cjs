#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const TreeSitter = require("web-tree-sitter");

const REPO_ROOT = path.resolve(__dirname, "..");
const END_OF_MODEL_DELIMITER = "//$?[End_of_model]$?";
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

function stripLayoutTail(text) {
  const idx = text.indexOf(END_OF_MODEL_DELIMITER);
  return idx === -1 ? text : text.substring(0, idx);
}

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
    corpusDir: env.UMPLE_CORPUS_DIR,
    failOnError: env.UMPLE_CORPUS_FAIL_ON_ERROR === "1",
    jsonPath: env.UMPLE_CORPUS_JSON,
    maxFiles: parsePositiveInteger(env.UMPLE_CORPUS_MAX_FILES, "UMPLE_CORPUS_MAX_FILES"),
    selfTest: false,
    top: parsePositiveInteger(env.UMPLE_CORPUS_TOP, "UMPLE_CORPUS_TOP") ?? DEFAULT_TOP,
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
        "--max-files"
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
    "tree-sitter-umple.wasm was not found. Run `npm run compile` first, or set UMPLE_TREE_SITTER_WASM_PATH."
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

function nodeSnippet(source, node) {
  const raw = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 80));
  return raw.replace(/\s+/g, " ").trim();
}

function collectErrors(rootNode, source) {
  const errors = [];
  let errorCount = 0;

  function visit(node) {
    if (!node) return;
    const isError = node.type === "ERROR" || node.isMissing;
    if (isError) {
      errorCount += 1;
      if (errors.length < 3) {
        errors.push({
          type: node.isMissing ? `MISSING ${node.type}` : node.type,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          snippet: nodeSnippet(source, node),
        });
      }
    }

    for (let i = 0; i < node.childCount; i += 1) {
      visit(node.child(i));
    }
  }

  visit(rootNode);

  if (rootNode.hasError && errors.length === 0) {
    errors.push({
      type: "ERROR",
      line: rootNode.startPosition.row + 1,
      column: rootNode.startPosition.column + 1,
      snippet: "",
    });
    errorCount = 1;
  }

  return { errorCount, errors };
}

async function createParser(wasmPath) {
  await TreeSitter.Parser.init();
  const parser = new TreeSitter.Parser();
  const language = await TreeSitter.Language.load(wasmPath);
  parser.setLanguage(language);
  return parser;
}

async function scanCorpus(options) {
  const corpusDir = path.resolve(options.corpusDir);
  const stats = await fsp.stat(corpusDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw Object.assign(new Error(`Corpus directory does not exist: ${corpusDir}`), { exitCode: 2 });
  }

  const wasmPath = resolveWasmPath(options.wasmPath);
  const parser = await createParser(wasmPath);
  const files = await collectUmpleFiles(corpusDir, options.maxFiles);
  if (files.length === 0) {
    throw Object.assign(new Error(`No .ump files found under ${corpusDir}`), { exitCode: 2 });
  }

  const failures = [];
  const readErrors = [];
  let clean = 0;
  let errored = 0;

  const startedAt = Date.now();
  for (const filePath of files) {
    let source;
    try {
      source = stripLayoutTail(await fsp.readFile(filePath, "utf8"));
    } catch (error) {
      readErrors.push({ file: path.relative(corpusDir, filePath), message: error.message });
      continue;
    }

    const tree = parser.parse(source);
    if (tree.rootNode.hasError) {
      errored += 1;
      const summary = collectErrors(tree.rootNode, source);
      failures.push({
        file: path.relative(corpusDir, filePath),
        errorCount: summary.errorCount,
        errors: summary.errors,
      });
    } else {
      clean += 1;
    }
  }

  failures.sort((a, b) => b.errorCount - a.errorCount || a.file.localeCompare(b.file));

  const parsed = clean + errored;
  const elapsedMs = Date.now() - startedAt;
  return {
    generatedAt: new Date().toISOString(),
    corpusDir,
    wasmPath,
    mode: options.failOnError ? "fail-on-error" : "report-only",
    maxFiles: options.maxFiles ?? null,
    totalFiles: files.length,
    parsed,
    clean,
    errored,
    errorRate: parsed === 0 ? 0 : errored / parsed,
    readErrors,
    failures,
    elapsedMs,
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printReport(report, top) {
  console.log("Umple corpus parse report");
  console.log(`Corpus: ${report.corpusDir}`);
  console.log(`WASM: ${report.wasmPath}`);
  console.log(`Mode: ${report.mode}`);
  if (report.maxFiles) console.log(`Max files: ${report.maxFiles}`);
  console.log(`Files found: ${report.totalFiles}`);
  console.log(`Parsed: ${report.parsed}`);
  console.log(`Clean: ${report.clean}`);
  console.log(`With ERROR nodes: ${report.errored} (${formatPercent(report.errorRate)})`);
  console.log(`Read errors: ${report.readErrors.length}`);
  console.log(`Elapsed: ${(report.elapsedMs / 1000).toFixed(2)}s`);

  if (report.failures.length > 0 && top > 0) {
    console.log("");
    console.log(`Top parse-error files (up to ${top}):`);
    for (const failure of report.failures.slice(0, top)) {
      const first = failure.errors[0];
      const location = first ? `${first.line}:${first.column}` : "?:?";
      const detail = first?.snippet ? ` ${JSON.stringify(first.snippet)}` : "";
      console.log(`- ${failure.file}:${location} ${failure.errorCount} error node(s)${detail}`);
    }
  }

  if (report.readErrors.length > 0) {
    console.log("");
    console.log("Read errors:");
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
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "umple-corpus-self-test-"));
  try {
    await fsp.writeFile(path.join(tempRoot, "clean.ump"), "class Clean {\n  name;\n}\n", "utf8");
    await fsp.writeFile(path.join(tempRoot, "broken.ump"), "class Broken {\n  1 ->\n}\n", "utf8");
    const report = await scanCorpus({ ...options, corpusDir: tempRoot, failOnError: false, maxFiles: undefined });

    if (report.totalFiles !== 2) {
      throw new Error(`self-test expected 2 files, got ${report.totalFiles}`);
    }
    if (report.clean !== 1) {
      throw new Error(`self-test expected 1 clean file, got ${report.clean}`);
    }
    if (report.errored !== 1) {
      throw new Error(`self-test expected 1 errored file, got ${report.errored}`);
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
    console.log("No corpus configured. Set UMPLE_CORPUS_DIR=/path/to/cruise.umple/test or pass a path.");
    console.log("Skipping corpus parse report.");
    return 0;
  }

  const report = await scanCorpus(options);
  printReport(report, options.top);
  await writeJsonReport(report, options.jsonPath);

  if (options.failOnError && (report.errored > 0 || report.readErrors.length > 0)) {
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
