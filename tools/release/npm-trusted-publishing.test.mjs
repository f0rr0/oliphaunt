#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from "./npm-trusted-publishing.mjs";
import {
  checkNpmTrustCliContract,
  isFullyQualifiedNativePath,
  validateNpmTrustCliHelp,
  validateNpmTrustCliRuntime,
  validateNpmTrustedPublishingRuntime,
} from "./npm-trusted-publishing-runtime.mjs";

const CLI = fileURLToPath(new URL("npm-trusted-publishing-runtime.mjs", import.meta.url));

function manifest(overrides = {}) {
  return {
    name: "@oliphaunt/example",
    version: "1.2.3",
    repository: {
      type: "git",
      url: NPM_TRUSTED_PUBLISHING_REPOSITORY,
    },
    publishConfig: {
      access: "public",
      provenance: true,
    },
    ...overrides,
  };
}

test("accepts the minimum supported trusted-publishing runtime", () => {
  assert.deepEqual(
    validateNpmTrustedPublishingRuntime({ nodeVersion: "v22.14.0", npmVersion: "11.5.1" }),
    { nodeVersion: "v22.14.0", npmVersion: "11.5.1" },
  );
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingRuntime({ nodeVersion: "24.1.0", npmVersion: "11.18.0" })
  );
});

test("the runtime checker executes directly under Node without a Bun prerequisite", () => {
  const accepted = spawnSync("node", [
    CLI,
    "check-runtime",
    "--node", "v22.22.3",
    "--npm", "11.18.0",
  ], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /npm trusted-publishing runtime passed/u);

  const rejected = spawnSync("node", [
    CLI,
    "check-runtime",
    "--node", "v22.13.0",
    "--npm", "11.18.0",
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Node[.]js v22[.]13[.]0 is too old/u);
});

test("the trust checker reuses active Node and preserves a spaced npm CLI path", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "oliphaunt npm trust "));
  const npmCli = path.join(fixture, "npm cli.js");
  writeFileSync(npmCli, `
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("11.18.0");
} else if (args.join(" ") === "trust list --help") {
  console.log("Options: --json --registry");
} else if (args.join(" ") === "trust github --help") {
  console.log("Options: --file --repository --environment --allow-publish --json --registry --yes");
} else if (args[0] === "trust" && args[1] === "github" && args.includes("--dry-run")) {
  console.log(JSON.stringify({
    package: "@oliphaunt/oliphaunt-cli-contract-probe",
    file: "release.yml",
    repository: "f0rr0/oliphaunt",
    environment: "release-publish",
    permissions: ["createPackage"],
  }));
} else {
  console.error("unexpected fake npm invocation", JSON.stringify(args));
  process.exitCode = 2;
}
`, { mode: 0o600 });
  try {
    const accepted = spawnSync("node", [
      CLI,
      "check-trust-cli",
      "--npm-cli", npmCli,
    ], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /npm trust CLI contract passed: npm 11[.]18[.]0/u);

    const redundantNodePath = spawnSync("node", [
      CLI,
      "check-trust-cli",
      "--node-executable", process.execPath,
      "--npm-cli", npmCli,
    ], { encoding: "utf8" });
    assert.notEqual(redundantNodePath.status, 0);
    assert.match(redundantNodePath.stderr, /unknown argument --node-executable/u);

    const relativeNpmPath = spawnSync("node", [
      CLI,
      "check-trust-cli",
      "--npm-cli", "npm-cli.js",
    ], { encoding: "utf8" });
    assert.notEqual(relativeNpmPath.status, 0);
    assert.match(relativeNpmPath.stderr, /--npm-cli must be a fully qualified native absolute path/u);

    const missingNpmPath = spawnSync("node", [
      CLI,
      "check-trust-cli",
      "--npm-cli", path.join(fixture, "missing npm cli.js"),
    ], { encoding: "utf8" });
    assert.notEqual(missingNpmPath.status, 0);
    assert.match(missingNpmPath.stderr, /--npm-cli does not identify a readable file/u);

    const duplicateNpmPath = spawnSync("node", [
      CLI,
      "check-trust-cli",
      "--npm-cli", npmCli,
      "--npm-cli", npmCli,
    ], { encoding: "utf8" });
    assert.notEqual(duplicateNpmPath.status, 0);
    assert.match(duplicateNpmPath.stderr, /--npm-cli may be specified only once/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("rejects MSYS and root-relative spellings as native Windows file identities", () => {
  for (const candidate of [
    "/d/a/npm-cli.js",
    String.raw`\d\a\npm-cli.js`,
    "/npm-cli.js",
    String.raw`\npm-cli.js`,
    String.raw`D:npm-cli.js`,
  ]) {
    assert.equal(isFullyQualifiedNativePath(candidate, "win32"), false, candidate);
  }
  for (const candidate of [
    String.raw`D:\a\npm-cli.js`,
    "D:/a/npm-cli.js",
    String.raw`\\server\share\npm-cli.js`,
    String.raw`\\?\D:\a\npm-cli.js`,
  ]) {
    assert.equal(isFullyQualifiedNativePath(candidate, "win32"), true, candidate);
  }
  assert.equal(isFullyQualifiedNativePath("/opt/node/bin/node", "linux"), true);
  assert.equal(isFullyQualifiedNativePath("node", "linux"), false);
});

test("rejects old or malformed Node.js and npm versions", () => {
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22.13.9", npmVersion: "11.5.1" }),
    /Node\.js 22\.13\.9 is too old/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22.14.0", npmVersion: "11.5.0" }),
    /npm 11\.5\.0 is too old/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22", npmVersion: "11.5.1" }),
    /complete semver/u,
  );
});

test("requires npm 11.15 only for trust-configuration management", () => {
  assert.equal(validateNpmTrustCliRuntime("11.15.0"), "11.15.0");
  assert.throws(() => validateNpmTrustCliRuntime("11.14.9"), /npm trust CLI 11\.14\.9 is too old/u);
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingRuntime({ nodeVersion: "22.14.0", npmVersion: "11.5.1" })
  );
});

test("checks the pinned npm trust command-specific help contract without network access", () => {
  const calls = [];
  const captureImpl = (command, args, options) => {
    calls.push({ command, args, options });
    let stdout;
    if (args.at(-1) === "--version") stdout = "11.18.0\n";
    else if (args.includes("list")) stdout = "Options: --json --registry\n";
    else if (args.includes("--dry-run")) {
      stdout = JSON.stringify({
        package: "@oliphaunt/oliphaunt-cli-contract-probe",
        file: "release.yml",
        repository: "f0rr0/oliphaunt",
        environment: "release-publish",
        permissions: ["createPackage"],
      });
    }
    else {
      stdout =
        "Options: --file --repository --environment --allow-publish --json --registry --yes\n";
    }
    return { status: 0, stdout, stderr: "" };
  };
  const result = checkNpmTrustCliContract({
    nodeExecutable: "/verified/node",
    npmCli: "/verified/npm-cli.js",
    captureImpl,
  });
  assert.equal(result.npmVersion, "11.18.0");
  assert.deepEqual(calls.map(({ args }) => args), [
    ["/verified/npm-cli.js", "--version"],
    ["/verified/npm-cli.js", "trust", "list", "--help"],
    ["/verified/npm-cli.js", "trust", "github", "--help"],
    [
      "/verified/npm-cli.js",
      "trust", "github", "@oliphaunt/oliphaunt-cli-contract-probe",
      "--file", "release.yml",
      "--repo", "f0rr0/oliphaunt",
      "--env", "release-publish",
      "--allow-publish",
      "--yes",
      "--json",
      "--registry", "http://127.0.0.1:9/",
      "--dry-run",
    ],
  ]);
  assert.ok(calls.every(({ options }) => options.timeout === 30_000));
  assert.ok(calls.every(({ options }) => options.maxOutputBytes === 256 * 1024));
  assert.ok(calls.every(({ options }) => typeof options.label === "string"));
  assert.equal(calls[3].options.env.NPM_CONFIG_FETCH_RETRIES, "0");

  assert.throws(
    () => validateNpmTrustCliHelp({
      listHelp: "Options: --json",
      githubHelp:
        "Options: --file --repository --environment --allow-publish --json --registry --yes",
    }),
    /npm trust list does not advertise required option --registry/u,
  );
  assert.throws(
    () => checkNpmTrustCliContract({
      nodeExecutable: "/verified/node",
      npmCli: "/verified/npm-cli.js",
      captureImpl: (_command, args) => ({
        status: args.at(-1) === "--version" ? 0 : 1,
        stdout: args.at(-1) === "--version" ? "11.18.0\n" : "",
        stderr: args.at(-1) === "--version" ? "" : "unsupported command",
      }),
    }),
    /npm trust list --help failed with exit 1/u,
  );
});

test("requires the exact repository URL and permits only publish-safe metadata", () => {
  assert.doesNotThrow(() => validateNpmTrustedPublishingManifest(manifest()));
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingManifest(manifest({ publishConfig: undefined }))
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({ repository: undefined })),
    /repository must be an object/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({
      repository: { type: "git", url: "https://github.com/f0rr0/oliphaunt" },
    })),
    /repository\.url must exactly match/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({
      publishConfig: { access: "public", provenance: false },
    })),
    /must not disable npm provenance/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({ private: true })),
    /must not be private/u,
  );
});
