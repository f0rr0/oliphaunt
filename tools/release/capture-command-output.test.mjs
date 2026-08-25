#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
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

function fixtureScript(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-command-capture-test-"));
  const script = path.join(root, "child.mjs");
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return { root, script };
}

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

test("external stdout redirection retains complete failure diagnostics", () => {
  const { root, script } = fixtureScript([
    "process.stdout.write('partial payload');",
    "process.stderr.write('first failure line\\n');",
    "setImmediate(() => { process.stderr.write('last failure line\\n'); process.exitCode = 31; });",
    "",
  ].join("\n"));
  const destination = path.join(root, "redirected.bin");
  const descriptor = openSync(destination, "wx", 0o600);
  try {
    const result = captureCommandOutput(process.execPath, [script], {
      label: "failed redirected child",
      stdoutDescriptor: descriptor,
    });
    assert.equal(result.status, 31);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "first failure line\nlast failure line\n");
  } finally {
    closeSync(descriptor);
  }
  try {
    assert.equal(readFileSync(destination, "utf8"), "partial payload");
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
