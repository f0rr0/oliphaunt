import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VERIFIED_NPM_COMMAND_FILES,
  ambientJsToolViolations,
  findJsToolCommandInvocations,
  isCommandSourcePath,
  repositoryCommandSources,
  staleVerifiedNpmCommandFiles,
} from "./assert-ambient-js-tools.mjs";

test("detects direct, assignment-prefixed, wrapped, and command-substitution shell launches", () => {
  const findings = findJsToolCommandInvocations("src/product/build.sh", [
    "npm pack .",
    "CI=1 npx expo prebuild",
    "value=\"$(PATH=\"$bin:$PATH\" npm --version)\"",
    "env --ignore-environment HOME=/tmp npm publish artifact.tgz",
    "command npx expo start",
  ].join("\n"));
  assert.deepEqual(findings.map(({ tool, line }) => [tool, line]), [
    ["npm", 1],
    ["npx", 2],
    ["npm", 3],
    ["npm", 4],
    ["npx", 5],
  ]);
});

test("does not classify PowerShell map keys as commands", () => {
  const findings = findJsToolCommandInvocations("tools/release/runner.ps1", [
    "$tools = [ordered]@{",
    "  npm = $NpmEnvelope",
    "  npx = $NpxEnvelope",
    "}",
    "npm = publish",
    "npm publish package.tgz",
    "npx expo start",
  ].join("\n"));
  assert.deepEqual(findings.map(({ tool, line }) => [tool, line]), [
    ["npm", 5],
    ["npm", 6],
    ["npx", 7],
  ]);
});

test("detects process launches and package scripts without matching prose", () => {
  assert.deepEqual(
    findJsToolCommandInvocations("src/product/tool.mjs", [
      'console.log("an npm package is ready");',
      'spawnSync("npm", ["pack"]);',
      'await runBoundedCommand("npx", ["expo"]);',
    ].join("\n")).map(({ tool, line }) => [tool, line]),
    [["npm", 2], ["npx", 3]],
  );
  assert.deepEqual(
    findJsToolCommandInvocations("src/product/package.json", JSON.stringify({
      scripts: {
        pack: "npm pack .",
        mobile: "CI=1 npx expo prebuild",
        safe: "pnpm exec expo prebuild",
      },
    }, null, 2)).map(({ tool }) => tool),
    ["npm", "npx"],
  );
});

test("detects direct and dynamic command-array launcher forms", () => {
  assert.deepEqual(
    findJsToolCommandInvocations("tools/release/registry.mjs", [
      'commandResult(["npm", "ping"]);',
      'const command = ["npm", "publish", tarball];',
      "commandResult(command);",
      'const publishArgs = ["npx", "expo", "start"];',
      "runCommand(publishArgs);",
    ].join("\n")).map(({ tool, line }) => [tool, line]),
    [["npm", 1], ["npm", 2], ["npx", 4]],
  );
});

test("rejects direct Bun shell-wrapper launches from JavaScript on every host", () => {
  const findings = findJsToolCommandInvocations("tools/release/runner.mjs", [
    'spawnSync("tools/dev/bun.sh", ["child.mjs"]);',
    'run(TOOL, ["tools/dev/bun.sh", "child.mjs"]);',
    'const command = ["tools/dev/bun.sh", "child.mjs"];',
    'return ["tools/dev/bun.sh", "child.mjs"];',
    'spawnSync(path.join(ROOT, "tools/dev/bun.sh"), ["child.mjs"]);',
    'spawnSync(process.execPath, ["child.mjs"]);',
    'console.log("tools/dev/bun.sh is a shell entrypoint");',
  ].join("\n"));
  assert.deepEqual(findings.map(({ tool, line }) => [tool, line]), [
    ["bun-shell-wrapper", 1],
    ["bun-shell-wrapper", 2],
    ["bun-shell-wrapper", 3],
    ["bun-shell-wrapper", 4],
    ["bun-shell-wrapper", 5],
  ]);
});

test("rejects mutable pnpm dlx packages while accepting exact package identities", () => {
  const shell = findJsToolCommandInvocations("tools/run.sh", [
    "pnpm dlx verdaccio@6 --version",
    "pnpm dlx expo@latest prebuild",
    "pnpm dlx verdaccio@6.8.0 --version",
    "pnpm --package=@biomejs/biome@2.4.16 dlx biome format",
  ].join("\n"));
  assert.deepEqual(shell.map(({ tool, spec, line }) => [tool, spec, line]), [
    ["pnpm-dlx", "verdaccio@6", 1],
    ["pnpm-dlx", "expo@latest", 2],
  ]);

  const javascript = findJsToolCommandInvocations("tools/run.mjs", [
    'spawn("pnpm", ["dlx", "verdaccio@6"]);',
    'const command = ["pnpm", "dlx", "expo@latest"];',
    'spawn("pnpm", ["dlx", "verdaccio@6.8.0"]);',
  ].join("\n"));
  assert.deepEqual(javascript.map(({ tool, spec, line }) => [tool, spec, line]), [
    ["pnpm-dlx", "verdaccio@6", 1],
    ["pnpm-dlx", "expo@latest", 2],
  ]);
});

test("allows pnpm commands and only explicitly verified npm consumers", () => {
  const sources = [
    { file: "src/product/build.sh", text: "pnpm pack --json\npnpm exec expo start\n" },
    { file: "tools/release/frozen-npm-publish.mjs", text: 'spawnImpl("npm", ["publish"]);\n' },
    { file: "tools/release/public-consumer-smoke.mjs", text: 'runBoundedCommand("npx", ["expo"]);\n' },
  ];
  assert.equal(VERIFIED_NPM_COMMAND_FILES.has("tools/release/frozen-npm-publish.mjs"), true);
  assert.deepEqual(ambientJsToolViolations(sources), [{
    file: "tools/release/public-consumer-smoke.mjs",
    tool: "npx",
    line: 1,
    kind: "process launch",
  }]);
});

test("rejects stale verified npm command inventory entries", () => {
  const verifiedNpmCommandFiles = new Set(["tools/release/active.mjs", "tools/release/stale.mjs"]);
  assert.deepEqual(staleVerifiedNpmCommandFiles([
    { file: "tools/release/active.mjs", text: 'spawnSync("npm", ["publish"]);\n' },
    { file: "tools/release/stale.mjs", text: 'spawnSync("pnpm", ["pack"]);\n' },
  ], { verifiedNpmCommandFiles }), ["tools/release/stale.mjs"]);
});

test("does not hide executable sources, but excludes tests and fixtures", () => {
  assert.equal(isCommandSourcePath("src/product/build.sh"), true);
  assert.equal(isCommandSourcePath(".github/workflows/ci.yml"), true);
  assert.equal(isCommandSourcePath("src/product/build.test.sh"), false);
  assert.equal(isCommandSourcePath("tools/policy/testdata/bad.sh"), false);
  assert.equal(isCommandSourcePath("docs/guide.md"), false);
});

test("repository inventory includes untracked sources and ignores tracked deletions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-ambient-js-tools-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(path.join(root, "deleted.sh"), "npm pack .\n");
    execFileSync("git", ["add", "deleted.sh"], { cwd: root });
    unlinkSync(path.join(root, "deleted.sh"));
    writeFileSync(path.join(root, "untracked.sh"), "npx expo prebuild\n");
    writeFileSync(path.join(root, ".gitignore"), "ignored.sh\n");
    writeFileSync(path.join(root, "ignored.sh"), "npm pack .\n");

    assert.deepEqual(repositoryCommandSources(root), [
      { file: "untracked.sh", text: "npx expo prebuild\n" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
