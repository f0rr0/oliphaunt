#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  execFileSync as fdBackedExecFileSync,
  execSync as fdBackedExecSync,
  spawnSync as fdBackedSpawnSync,
} from "../test/fd-backed-spawn-sync.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIPPED_PRODUCTION_DIRECTORIES = new Set([
  ".build",
  ".cxx",
  ".git",
  ".gradle",
  ".moon",
  ".next",
  "DerivedData",
  "Pods",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function productionModules(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_PRODUCTION_DIRECTORIES.has(entry.name)) visit(file);
      } else if (
        entry.isFile()
        && /[.](?:cjs|js|mjs|ts|tsx)$/u.test(entry.name)
      ) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files.sort();
}

function bunOwnedModules(files) {
  const known = new Set(files.map((file) => path.resolve(file)));
  const owned = new Set();
  const queue = [];
  for (const file of known) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const nodeEntrypoint = /^#![^\r\n]*\bnode\b/u.test(source);
    const bunEntrypoint = /^#![^\r\n]*\bbun\b/u.test(source);
    const bunToolingDomain = /^(?:[.]github\/scripts\/|examples\/|tools\/)/u.test(relative);
    // Release mutation tests are always passed to `bun test` by
    // release-check.mjs. Their shebang is therefore documentation, not runtime
    // selection. Workflow tests in .github/scripts are also Bun gates and may
    // be imported through a tools/policy wrapper.
    const bunTestGate = /^(?:[.]github\/scripts\/|tools\/(?:policy|release)\/).*?[.](?:spec|test)[.](?:cjs|js|mjs|ts|tsx)$/u
      .test(relative);
    const explicitPublishedBunPath = relative === "src/sdks/react-native/app.plugin.js";
    if (
      bunTestGate
      || (!nodeEntrypoint && (bunEntrypoint || bunToolingDomain || explicitPublishedBunPath))
    ) {
      owned.add(file);
      queue.push(file);
    }
  }
  const importedFile = (importer, specifier) => {
    const base = path.resolve(path.dirname(importer), specifier);
    for (const candidate of [
      base,
      ...[".cjs", ".js", ".mjs", ".ts", ".tsx"].map((extension) => `${base}${extension}`),
      ...[".cjs", ".js", ".mjs", ".ts", ".tsx"].map((extension) => path.join(base, `index${extension}`)),
    ]) {
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  };
  while (queue.length > 0) {
    const importer = queue.pop();
    const source = readFileSync(importer, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?<specifier>[.]{1,2}\/[^"']+)["']/gu,
    )) {
      const imported = importedFile(importer, match.groups.specifier);
      if (imported !== undefined && !owned.has(imported)) {
        owned.add(imported);
        queue.push(imported);
      }
    }
  }
  return owned;
}

function callEnd(source, openingParenthesis) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingParenthesis; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("unterminated synchronous child call in policy scan");
}

function childProcessSyncBindings(source) {
  const imports = [];
  for (const match of source.matchAll(
    /import\s*\{(?<bindings>[^}]*)\}\s*from\s*["'](?:node:)?child_process["']\s*;?/gu,
  )) {
    const bindings = match.groups.bindings
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean);
    for (const binding of bindings) {
      const parsed = /^(?<imported>spawnSync|execFileSync|execSync)(?:\s+as\s+(?<local>[A-Za-z_$][\w$]*))?$/u.exec(binding);
      if (parsed !== null) {
        imports.push({
          end: match.index + match[0].length,
          local: parsed.groups.local ?? parsed.groups.imported,
          start: match.index,
        });
      }
    }
  }
  for (const match of source.matchAll(
    /import\s*[*]\s*as\s*(?<namespace>[A-Za-z_$][\w$]*)\s*from\s*["'](?:node:)?child_process["']\s*;?/gu,
  )) {
    for (const method of ["spawnSync", "execFileSync", "execSync"]) {
      imports.push({
        end: match.index + match[0].length,
        local: `${match.groups.namespace}.${method}`,
        start: match.index,
      });
    }
  }
  for (const match of source.matchAll(
    /import\s*(?<namespace>[A-Za-z_$][\w$]*)\s*from\s*["'](?:node:)?child_process["']\s*;?/gu,
  )) {
    for (const method of ["spawnSync", "execFileSync", "execSync"]) {
      imports.push({
        end: match.index + match[0].length,
        local: `${match.groups.namespace}.${method}`,
        start: match.index,
      });
    }
  }
  for (const match of source.matchAll(
    /(?:const|let|var)\s*\{(?<bindings>[^}]*)\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*;?/gu,
  )) {
    for (const binding of match.groups.bindings.split(",").map((value) => value.trim()).filter(Boolean)) {
      const parsed = /^(?<imported>spawnSync|execFileSync|execSync)(?:\s*:\s*(?<local>[A-Za-z_$][\w$]*))?$/u.exec(binding);
      if (parsed !== null) {
        imports.push({
          end: match.index + match[0].length,
          local: parsed.groups.local ?? parsed.groups.imported,
          start: match.index,
        });
      }
    }
  }
  for (const match of source.matchAll(
    /(?:const|let|var)\s+(?<namespace>[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*;?/gu,
  )) {
    for (const method of ["spawnSync", "execFileSync", "execSync"]) {
      imports.push({
        end: match.index + match[0].length,
        local: `${match.groups.namespace}.${method}`,
        start: match.index,
      });
    }
  }
  return imports;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fixtureScript(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-command-capture-test-"));
  const script = path.join(root, "child.mjs");
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return { root, script };
}

function relativeModuleClosure(entryFiles) {
  const closure = new Set(entryFiles.map((file) => path.resolve(file)));
  const queue = [...closure];
  while (queue.length > 0) {
    const importer = queue.pop();
    const source = readFileSync(importer, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?<specifier>[.]{1,2}\/[^"']+)["']/gu,
    )) {
      const base = path.resolve(path.dirname(importer), match.groups.specifier);
      const sourceBase = /[.](?:cjs|js|mjs)$/u.test(base)
        ? base.replace(/[.](?:cjs|js|mjs)$/u, "")
        : base;
      const candidates = [
        base,
        ...[".cjs", ".js", ".mjs", ".ts", ".tsx"].map(
          (extension) => `${sourceBase}${extension}`,
        ),
        ...[".cjs", ".js", ".mjs", ".ts", ".tsx"].map((extension) => `${base}${extension}`),
        ...[".cjs", ".js", ".mjs", ".ts", ".tsx"].map(
          (extension) => path.join(base, `index${extension}`),
        ),
      ];
      const imported = candidates.find((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      assert.notEqual(
        imported,
        undefined,
        `${path.relative(ROOT, importer)} has an unresolved relative import ${match.groups.specifier}`,
      );
      if (!closure.has(imported)) {
        closure.add(imported);
        queue.push(imported);
      }
    }
  }
  return closure;
}

test("sync child binding audit recognizes ESM and CommonJS import forms", () => {
  const bindings = childProcessSyncBindings([
    'import childProcess from "node:child_process";',
    'import { spawnSync as launch } from "child_process";',
    'import * as childNamespace from "node:child_process";',
    'const { execFileSync: execute } = require("child_process");',
    'const requiredChildProcess = require("node:child_process");',
    '',
  ].join("\n")).map(({ local }) => local).sort();
  assert.deepEqual(bindings, [
    "childNamespace.execFileSync",
    "childNamespace.execSync",
    "childNamespace.spawnSync",
    "childProcess.execFileSync",
    "childProcess.execSync",
    "childProcess.spawnSync",
    "execute",
    "launch",
    "requiredChildProcess.execFileSync",
    "requiredChildProcess.execSync",
    "requiredChildProcess.spawnSync",
  ]);
});

test("file-backed capture retains stdout written at a successful child's final event-loop turn", () => {
  const { root, script } = fixtureScript([
    "process.stdout.write('first\\0');",
    "setImmediate(() => process.stdout.write('second\\0'));",
    "",
  ].join("\n"));
  try {
    const result = captureCommandOutput(process.execPath, [script], {
      label: "delayed successful child",
      stdoutTerminator: "\0",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "first\0second\0");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("NUL inventory capture fails closed on a successful partial record", () => {
  const { root, script } = fixtureScript("process.stdout.write('partial');\n");
  try {
    assert.throws(
      () => captureCommandOutput(process.execPath, [script], {
        label: "partial inventory child",
        stdoutTerminator: "\0",
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("required record terminators reject a successful empty inventory", () => {
  const { root, script } = fixtureScript("");
  try {
    assert.throws(
      () => captureCommandOutput(process.execPath, [script], {
        label: "empty inventory child",
        stdoutTerminator: "\0",
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("optional record inventories accept empty stdout but still reject partial records", () => {
  const empty = fixtureScript("");
  const partial = fixtureScript("process.stdout.write('partial');\n");
  try {
    const result = captureCommandOutput(process.execPath, [empty.script], {
      allowEmptyOutput: true,
      label: "optional empty inventory child",
      stdoutTerminator: "\0",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.throws(
      () => captureCommandOutput(process.execPath, [partial.script], {
        allowEmptyOutput: true,
        label: "optional partial inventory child",
        stdoutTerminator: "\0",
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(empty.root, { force: true, recursive: true });
    rmSync(partial.root, { force: true, recursive: true });
  }
});

test("record capture rejects an explicitly empty terminator before spawning", () => {
  assert.throws(
    () => captureCommandOutput("command-that-must-not-run", [], { stdoutTerminator: "" }),
    /non-empty stdout terminator/u,
  );
});

test("allowEmptyOutput is valid only for a terminated record protocol", () => {
  assert.throws(
    () => captureCommandOutput("command-that-must-not-run", [], { allowEmptyOutput: true }),
    /allowEmptyOutput requires a stdout terminator/u,
  );
});

test("file-backed capture retains complete failure diagnostics", () => {
  const { root, script } = fixtureScript([
    "process.stderr.write('first failure line\\n');",
    "setImmediate(() => { process.stderr.write('last failure line\\n'); process.exitCode = 23; });",
    "",
  ].join("\n"));
  try {
    const result = captureCommandOutput(process.execPath, [script], { label: "failed child" });
    assert.equal(result.status, 23);
    assert.equal(result.stderr, "first failure line\nlast failure line\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("failed commands return diagnostics instead of enforcing success framing", () => {
  const { root, script } = fixtureScript([
    "process.stderr.write('complete failure diagnostic\\n');",
    "process.exitCode = 29;",
    "",
  ].join("\n"));
  try {
    const result = captureCommandOutput(process.execPath, [script], {
      label: "failed framed child",
      stdoutTerminator: "\0",
    });
    assert.equal(result.status, 29);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "complete failure diagnostic\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("start failures return their spawn error instead of enforcing success framing", () => {
  const result = captureCommandOutput("oliphaunt-command-that-does-not-exist", [], {
    label: "missing framed child",
    stdoutTerminator: "\0",
  });
  assert.notEqual(result.error, undefined);
  assert.ok(result.status == null);
  assert.equal(result.stdout, "");
});

test("external stdout redirection preserves large bytes and leaves its descriptor open", () => {
  const bytes = 2 * 1024 * 1024 + 17;
  const { root, script } = fixtureScript([
    `const remaining = ${bytes};`,
    "process.stdout.write(Buffer.alloc(remaining, 0xa5));",
    "",
  ].join("\n"));
  const destination = path.join(root, "redirected.bin");
  const descriptor = openSync(destination, "wx", 0o600);
  try {
    const result = captureCommandBytes(process.execPath, [script], {
      label: "large redirected child",
      maxOutputBytes: 1024,
      stdoutDescriptor: descriptor,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, Buffer.alloc(0));
    assert.deepEqual(result.stderr, Buffer.alloc(0));
    assert.equal(writeSync(descriptor, Buffer.from([0x5a]), 0, 1, bytes), 1);
  } finally {
    closeSync(descriptor);
  }
  try {
    const actual = readFileSync(destination);
    assert.equal(actual.length, bytes + 1);
    assert.equal(actual.subarray(0, bytes).every((byte) => byte === 0xa5), true);
    assert.equal(actual[bytes], 0x5a);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("external stdout redirection rejects record framing", () => {
  const { root, script } = fixtureScript("");
  const destination = path.join(root, "redirected.bin");
  const descriptor = openSync(destination, "wx", 0o600);
  try {
    assert.throws(
      () => captureCommandOutput(process.execPath, [script], {
        stdoutDescriptor: descriptor,
        stdoutTerminator: "\0",
      }),
      /cannot frame externally redirected stdout/u,
    );
    assert.equal(writeSync(descriptor, Buffer.from([0x5a])), 1);
  } finally {
    closeSync(descriptor);
    rmSync(root, { force: true, recursive: true });
  }
});

test("external stdout redirection rejects non-regular descriptors", {
  skip: process.platform === "win32",
}, () => {
  const descriptor = openSync("/dev/null", "w");
  try {
    assert.throws(
      () => captureCommandBytes(process.execPath, ["--version"], { stdoutDescriptor: descriptor }),
      /must identify a regular file/u,
    );
    assert.equal(writeSync(descriptor, Buffer.from([0x5a])), 1);
  } finally {
    closeSync(descriptor);
  }
});

test("Bun-owned modules and mutation tests never parse synchronous child pipes", () => {
  const failures = [];
  const files = productionModules(ROOT);
  const bunOwned = bunOwnedModules(files);
  const auditImplementations = new Set([
    "tools/dev/capture-command-output.mjs",
    "tools/release/capture-command-output.test.mjs",
    "tools/test/fd-backed-spawn-sync.mjs",
  ]);
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (auditImplementations.has(relative)) continue;
    const source = readFileSync(file, "utf8");
    if (!bunOwned.has(path.resolve(file))) continue;
    if (/\bBun[.]spawnSync\s*\(/u.test(source)) {
      failures.push(`${relative}: Bun.spawnSync is not an approved output transport`);
    }
    for (const binding of childProcessSyncBindings(source)) {
      const occurrences = [...source.matchAll(new RegExp(`\\b${regexEscape(binding.local)}\\b`, "gu"))];
      for (const occurrence of occurrences) {
        if (occurrence.index >= binding.start && occurrence.index < binding.end) continue;
        const suffix = source.slice(occurrence.index + occurrence[0].length);
        const openingOffset = suffix.search(/\S/u);
        if (openingOffset < 0 || suffix[openingOffset] !== "(") {
          failures.push(`${relative}: ${binding.local} is aliased or passed instead of being auditable at its call site`);
          continue;
        }
        const opening = occurrence.index + occurrence[0].length + openingOffset;
        const call = source.slice(occurrence.index, callEnd(source, opening));
        const selfContainedPublishedCapture = relative === "src/sdks/react-native/app.plugin.js"
          && binding.local === "spawnSync"
          && /stdio\s*:\s*\[\s*["']ignore["']\s*,\s*stdoutDescriptor\s*,\s*stderrDescriptor\s*\]/u.test(call);
        if (selfContainedPublishedCapture) continue;
        const stdinOnlyPipe = /stdio\s*:\s*\[\s*["']pipe["']\s*,\s*["'](?:inherit|ignore)["']\s*,\s*["'](?:inherit|ignore)["']\s*\]/u
          .test(call);
        if (/["']pipe["']/u.test(call) && !stdinOnlyPipe) {
          failures.push(`${relative}: ${binding.local} captures stdout or stderr through a pipe`);
          continue;
        }
        const closedOutput = /stdio\s*:\s*["'](?:inherit|ignore)["']/u.test(call) || stdinOnlyPipe;
        if (!closedOutput) {
          failures.push(`${relative}: ${binding.local} does not explicitly inherit or ignore stdout and stderr`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
  const helper = readFileSync(path.join(ROOT, "tools/dev/capture-command-output.mjs"), "utf8");
  assert.doesNotMatch(helper, /["']pipe["']/u);
  assert.match(
    helper,
    /stdio:\s*\[\s*stdinDescriptor\s*\?\?\s*["']ignore["']\s*,\s*stdoutDescriptor\s*\?\?\s*capturedStdoutDescriptor\s*,\s*stderrDescriptor\s*,?\s*\]/u,
  );
  const testFacade = readFileSync(path.join(ROOT, "tools/test/fd-backed-spawn-sync.mjs"), "utf8");
  assert.match(testFacade, /captureCommandBytes/u);
  assert.match(testFacade, /if \(!capturesStdout && !capturesStderr\)/u);
  assert.match(testFacade, /return nativeSpawnSync\(command, args, options\)/u);
  assert.match(testFacade, /maxOutputBytes: boundedMaxBuffer\(options[.]maxBuffer\)/u);
  assert.match(testFacade, /output: \[null, stdout, stderr\]/u);
  assert.doesNotMatch(testFacade, /Bun[.]spawnSync/u);
  const configPlugin = readFileSync(path.join(ROOT, "src/sdks/react-native/app.plugin.js"), "utf8");
  assert.match(configPlugin, /require\(["']node:os["']\)/u);
  assert.match(configPlugin, /mkdtempSync\(/u);
  assert.match(configPlugin, /openSync\(stdoutFile, ["']wx["'], 0o600\)/u);
  assert.match(configPlugin, /statSync\(file\)[.]size/u);
  assert.match(
    configPlugin,
    /stdio:\s*\[\s*["']ignore["']\s*,\s*stdoutDescriptor\s*,\s*stderrDescriptor\s*\]/u,
  );
  assert.match(configPlugin, /rmSync\(directory, \{ force: true, recursive: true \}\)/u);
  assert.match(configPlugin, /spawnSyncImpl = undefined/u);
  assert.doesNotMatch(configPlugin, /capture-command-output[.]mjs/u);
});

test("isolated React Native SDK worktrees materialize their external module closure", () => {
  const packageRoot = path.join(ROOT, "src/sdks/react-native");
  const packagePrefix = `${packageRoot}${path.sep}`;
  const copiedModules = productionModules(packageRoot).filter(
    (file) => path.relative(packageRoot, file).split(path.sep)[0] !== "lib",
  );
  const externalModules = [...relativeModuleClosure(copiedModules)]
    .filter((file) => !file.startsWith(packagePrefix))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(externalModules, [
    "tools/dev/capture-command-output.mjs",
    "tools/test/fd-backed-spawn-sync.mjs",
  ]);

  const worktreeBuilder = readFileSync(
    path.join(packageRoot, "tools/check-sdk.sh"),
    "utf8",
  );
  for (const required of [
    'mkdir -p "$scratch_root/tools/dev"',
    'mkdir -p "$scratch_root/tools/test"',
    '"$root/tools/dev/capture-command-output.mjs"',
    '"$scratch_root/tools/dev/capture-command-output.mjs"',
    '"$root/tools/test/fd-backed-spawn-sync.mjs"',
    '"$root/tools/test/run-js-tests.mjs"',
    '"$scratch_root/tools/test/"',
    'test "$package_dir/tools/ios-app-transport.test.mjs"',
    'test "$package_dir/tools/mobile-extension-artifact-paths.test.mjs"',
  ]) {
    assert.ok(worktreeBuilder.includes(required), `missing isolated-worktree contract: ${required}`);
  }
  assert.doesNotMatch(worktreeBuilder, /rsync[^\n]*tools\/test/u);

  const jsWorktreeBuilder = readFileSync(
    path.join(ROOT, "src/sdks/js/tools/check-sdk.sh"),
    "utf8",
  );
  assert.ok(
    jsWorktreeBuilder.includes(
      'cp "$root/tools/test/run-js-tests.mjs" "$scratch_root/tools/test/run-js-tests.mjs"',
    ),
  );
  assert.doesNotMatch(jsWorktreeBuilder, /rsync[^\n]*tools\/test/u);
});

test("binary capture preserves exact non-UTF-8 bytes without a pipe", () => {
  const { root, script } = fixtureScript(
    "process.stdout.write(Buffer.from([0x00, 0xff, 0x7f, 0x0a]));\n",
  );
  try {
    const result = captureCommandBytes(process.execPath, [script], {
      label: "binary child",
      stdoutTerminator: Buffer.from([0x0a]),
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, Buffer.from([0x00, 0xff, 0x7f, 0x0a]));
    assert.deepEqual(result.stderr, Buffer.alloc(0));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("file-backed stdin preserves exact binary bytes", () => {
  const { root, script } = fixtureScript([
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "process.stdout.write(Buffer.concat(chunks));",
    "",
  ].join("\n"));
  try {
    const input = Buffer.from([0x00, 0xff, 0x7f, 0x0a, 0x00]);
    const result = captureCommandBytes(process.execPath, [script], {
      input,
      label: "binary stdin child",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, input);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("file-backed stdin accepts an explicitly empty input", () => {
  const { root, script } = fixtureScript([
    "let length = 0;",
    "for await (const chunk of process.stdin) length += chunk.length;",
    "process.stdout.write(`${length}\\n`);",
    "",
  ].join("\n"));
  try {
    const result = captureCommandOutput(process.execPath, [script], {
      input: Buffer.alloc(0),
      label: "empty stdin child",
      stdoutTerminator: "\n",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "0\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("test spawn facade preserves the synchronous child result shape without pipes", () => {
  const { root, script } = fixtureScript([
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "process.stdout.write(Buffer.concat(chunks));",
    "process.stderr.write('diagnostic\\n');",
    "",
  ].join("\n"));
  try {
    const result = fdBackedSpawnSync(process.execPath, [script], {
      encoding: "utf8",
      input: "complete-output\n",
      maxBuffer: 1024,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: false,
    });
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "complete-output\n");
    assert.equal(result.stderr, "diagnostic\n");
    assert.deepEqual(result.output, [null, result.stdout, result.stderr]);
    assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);

    const binary = fdBackedSpawnSync(process.execPath, [script], {
      input: Buffer.from([0x00, 0xff, 0x0a]),
    });
    assert.equal(binary.status, 0);
    assert.deepEqual(binary.stdout, Buffer.from([0x00, 0xff, 0x0a]));
    assert.deepEqual(binary.stderr, Buffer.from("diagnostic\n"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("test spawn facade delegates explicitly closed output and emulates execSync APIs", () => {
  const ignored = fdBackedSpawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout, null);
  assert.equal(ignored.stderr, null);

  const output = fdBackedExecFileSync(
    process.execPath,
    ["-e", "process.stdout.write('facade-output')"],
    { encoding: "utf8" },
  );
  assert.equal(output, "facade-output");
  assert.equal(
    fdBackedExecSync("echo shell-output", { encoding: "utf8" }).trim(),
    "shell-output",
  );
  assert.throws(
    () => fdBackedExecFileSync(
      process.execPath,
      ["-e", "process.stdout.write('partial'); process.stderr.write('failed'); process.exit(17)"],
      { encoding: "utf8" },
    ),
    (error) => error.status === 17
      && error.stdout === "partial"
      && error.stderr === "failed"
      && error.output[1] === "partial",
  );
});

test("Bun-owned release inventories route captured children through file-backed capture", () => {
  for (const relative of [
    "tools/release/release-check.mjs",
    "tools/release/release-semantic-inputs.mjs",
    "tools/release/sync-release-pr.mjs",
  ]) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /from "[.][.]\/dev\/capture-command-output[.]mjs"/u, relative);
    assert.doesNotMatch(source, /from "node:child_process"/u, relative);
  }
});

test("release materializers do not parse child-process pipes", () => {
  for (const relative of [
    "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
    "tools/release/package_broker_cargo_artifacts.mjs",
    "tools/release/release-product-dry-run.mjs",
    "tools/release/check-staged-artifacts.mjs",
    "tools/release/publication-lock.mjs",
    "tools/release/check-liboliphaunt-wasix-release-assets.mjs",
    "tools/release/extension-registry-carrier-materializer.mjs",
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
  ]) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    assert.ok(
      source.includes('from "../dev/capture-command-output.mjs"')
        || !source.includes('from "node:child_process"'),
      relative,
    );
    assert.doesNotMatch(source, /["']pipe["']/u, relative);
  }
});

test("artifact recovery parsers never consume synchronous child pipes", () => {
  for (const relative of [
    ".github/scripts/download-bootstrap-ledger.mjs",
    ".github/scripts/download-normal-publication-checkpoint.mjs",
    ".github/scripts/release-continuation-artifact.mjs",
  ]) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /capture-command-output[.]mjs/u, relative);
    assert.doesNotMatch(source, /from "node:child_process"/u, relative);
    assert.doesNotMatch(source, /stdio:\s*\[[^\]]*"pipe"/u, relative);
  }

  const buildDownloader = readFileSync(
    path.join(ROOT, ".github/scripts/download-build-artifacts.mjs"),
    "utf8",
  );
  assert.match(buildDownloader, /capture-command-output[.]mjs/u);
  assert.match(buildDownloader, /actualDigest = await fileSha256\(archive\)/u);
  assert.doesNotMatch(
    buildDownloader,
    /spawnSync\(process[.]execPath,\s*\["-e",\s*`[^`]*createHash/u,
  );
});
