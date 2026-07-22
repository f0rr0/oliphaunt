import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

import {
  BROKER_DEPENDENCY_LICENSE_FETCH_ARGS,
  BROKER_DEPENDENCY_LICENSE_ROOT,
  BROKER_PAYLOAD_LICENSE,
  auditBrokerDependencyLicenseContract,
  assertBrokerDependencyLicensesInArchive,
  assertBrokerDependencyLicensesInDirectory,
  brokerDependencyLicenseMembers,
  isAllowedBrokerPathPackageMetadataRow,
  loadBrokerDependencyLicenseContract,
  normalizeBrokerDependencyLicenseModes,
  stageBrokerDependencyLicenses,
} from "./broker-dependency-license-contract.mjs";
import { brokerNpmTarballs } from "./release-product-dry-run.mjs";
import { brokerNpmTarballs as localRegistryBrokerNpmTarballs } from "./local-registry-publish.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTRACT = path.join(ROOT, "src/runtimes/broker/dependency-licenses.json");
const TARGETS = ["linux-x64-gnu", "linux-arm64-gnu", "macos-arm64", "windows-x64-msvc"];
const TIMEOUT = 120_000;

function scratch(t, label) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-broker-license-${label}-`));
  chmodSync(directory, 0o755);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stageCarrier(t, target) {
  const directory = scratch(t, target);
  stageReleaseNotices(directory, { profile: "broker" });
  stageBrokerDependencyLicenses(directory, target);
  return directory;
}

function writeMutatedContract(t, mutate) {
  const directory = scratch(t, "contract");
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
  mutate(contract);
  const file = path.join(directory, "dependency-licenses.json");
  writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
  return file;
}

function archive(directory, extension) {
  const output = `${directory}.${extension}`;
  const result = spawnSync(
    path.join(ROOT, "tools/release/archive_dir.mjs"),
    [directory, output],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return output;
}

function spawnResult(command, args, logRoot) {
  return new Promise((resolve, reject) => {
    const stdoutPath = path.join(logRoot, "stdout.log");
    const stderrPath = path.join(logRoot, "stderr.log");
    const stdoutDescriptor = openSync(stdoutPath, "wx", 0o600);
    const stderrDescriptor = openSync(stderrPath, "wx", 0o600);
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
    });
    closeSync(stdoutDescriptor);
    closeSync(stderrDescriptor);
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      status,
      signal,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    }));
  });
}

test("broker contract pins the complete package-specific legal inventory", { timeout: TIMEOUT }, () => {
  const { contract } = loadBrokerDependencyLicenseContract();
  assert.equal(contract.packages.length, 56);
  assert.equal(contract.payloadLicense, BROKER_PAYLOAD_LICENSE);
  const legalFiles = contract.packages.flatMap((row) => row.licenseFiles);
  assert.equal(legalFiles.length, 120);
  assert.equal(new Set(legalFiles.map(({ sha256 }) => sha256)).size, 59);
  assert.ok(contract.packages.every((row) => row.licenseFiles.length > 0));
  assert.ok(contract.packages.some((row) =>
    row.name === "memchr"
    && row.selectedLicense === "MIT"
    && row.licenseFiles.some(({ name }) => name === "UNLICENSE")));
  assert.ok(contract.packages.some((row) => row.name === "libloading" && row.selectedLicense === "ISC"));
  assert.ok(contract.packages.some((row) => row.name === "zopfli" && row.selectedLicense === "Apache-2.0"));
  assert.ok(contract.packages.some((row) => row.name === "unicode-ident" && row.selectedLicense === "MIT AND Unicode-3.0"));
  assert.ok(contract.packages.some((row) =>
    row.name === "crossbeam-channel"
    && row.selectedLicense === "MIT AND CC-BY-3.0"
    && row.licenseFiles.some(({ name }) => name === "LICENSE-THIRD-PARTY")));
  assert.ok(contract.packages.some((row) =>
    row.name === "zstd-sys"
    && row.selectedLicense === "MIT AND BSD-3-Clause"
    && row.licenseFiles.some(({ name }) => name === "zstd/LICENSE")));
});

test("production audit prefetches the exact locked all-target closure into a clean home before verification", (t) => {
  const temporaryRoot = scratch(t, "clean-audit");
  let observedCargoHome;
  const marker = "prefetched-all-target-sources";
  const state = auditBrokerDependencyLicenseContract({
    temporaryRoot,
    captureCargoCommand(command, args, options) {
      assert.equal(command, "cargo");
      assert.deepEqual(args, BROKER_DEPENDENCY_LICENSE_FETCH_ARGS);
      assert.equal(args.includes("--target"), false);
      assert.equal(options.cwd, ROOT);
      assert.equal(options.env.CARGO_NET_OFFLINE, "false");
      observedCargoHome = options.env.CARGO_HOME;
      assert.equal(path.dirname(observedCargoHome), temporaryRoot);
      assert.deepEqual(readdirSync(observedCargoHome), []);
      writeFileSync(path.join(observedCargoHome, marker), "ready\n", { mode: 0o600 });
      return { status: 0, stdout: "", stderr: "" };
    },
    verifyContract(options) {
      assert.equal(options.auditGraph, true);
      assert.equal(options.cargoHome, observedCargoHome);
      assert.equal(readFileSync(path.join(options.cargoHome, marker), "utf8"), "ready\n");
      return Object.freeze({ verified: true });
    },
  });
  assert.deepEqual(state, { verified: true });
  assert.equal(existsSync(observedCargoHome), false);
});

test("broker path-package validation follows exact manifests without pinning release versions", () => {
  const sdkManifest = path.join(ROOT, "src/sdks/rust/Cargo.toml");
  assert.equal(isAllowedBrokerPathPackageMetadataRow({
    name: "oliphaunt",
    version: "17.23.401",
    source: null,
    manifest_path: sdkManifest,
  }), true);
  assert.equal(isAllowedBrokerPathPackageMetadataRow({
    name: "oliphaunt",
    version: "17.23.401",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    manifest_path: sdkManifest,
  }), false);
  assert.equal(isAllowedBrokerPathPackageMetadataRow({
    name: "unexpected-local-crate",
    version: "17.23.401",
    source: null,
    manifest_path: sdkManifest,
  }), false);
  assert.equal(isAllowedBrokerPathPackageMetadataRow({
    name: "oliphaunt",
    version: "17.23.401",
    source: null,
    manifest_path: path.join(ROOT, "Cargo.toml"),
  }), false);
});

test("selected-target carrier staging is self-contained without Cargo or registry sources", (t) => {
  const directory = scratch(t, "offline-selected-target");
  const emptyPath = scratch(t, "empty-path");
  const emptyCargoHome = scratch(t, "empty-cargo-home");
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "tools/release/broker-dependency-license-contract.mjs"),
      "stage",
      directory,
      "--target",
      "linux-x64-gnu",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CARGO_HOME: emptyCargoHome,
        PATH: emptyPath,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assertBrokerDependencyLicensesInDirectory(directory, { target: "linux-x64-gnu" });
});

test("target indexes exclude other operating systems' conditional dependencies", { timeout: TIMEOUT }, (t) => {
  const indexes = new Map();
  for (const target of TARGETS) {
    const directory = stageCarrier(t, target);
    assertBrokerDependencyLicensesInDirectory(directory, { target });
    const index = JSON.parse(readFileSync(
      path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"), "DEPENDENCIES.json"),
      "utf8",
    ));
    assert.equal(index.target, target);
    assert.equal(index.payloadLicense, BROKER_PAYLOAD_LICENSE);
    indexes.set(target, new Set(index.packages.map(({ name }) => name)));
  }
  assert.ok(indexes.get("linux-x64-gnu").has("linux-raw-sys"));
  assert.ok(!indexes.get("linux-x64-gnu").has("windows-link"));
  assert.ok(indexes.get("macos-arm64").has("errno"));
  assert.ok(!indexes.get("macos-arm64").has("linux-raw-sys"));
  assert.ok(indexes.get("windows-x64-msvc").has("windows-link"));
  assert.ok(indexes.get("windows-x64-msvc").has("winapi"));
  assert.ok(!indexes.get("windows-x64-msvc").has("libc"));
});

test("staged and packed closures preserve exact bytes, modes, and members", { timeout: TIMEOUT }, (t) => {
  for (const [target, extension] of [["linux-x64-gnu", "tar.gz"], ["windows-x64-msvc", "zip"]]) {
    const directory = stageCarrier(t, target);
    const packed = archive(directory, extension);
    t.after(() => rmSync(packed, { force: true }));
    assertBrokerDependencyLicensesInArchive(packed, { target });
    const expected = brokerDependencyLicenseMembers(target);
    assert.ok(expected.includes(`${BROKER_DEPENDENCY_LICENSE_ROOT}/DEPENDENCIES.json`));
    assert.ok(expected.some((member) => member.startsWith(`${BROKER_DEPENDENCY_LICENSE_ROOT}/licenses/`)));
  }

  const extraDirectory = stageCarrier(t, "linux-x64-gnu");
  writeFileSync(
    path.join(extraDirectory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"), "licenses/extra.txt"),
    "undeclared\n",
    { mode: 0o644 },
  );
  const extraArchive = archive(extraDirectory, "tar.gz");
  t.after(() => rmSync(extraArchive, { force: true }));
  assert.throws(
    () => assertBrokerDependencyLicensesInArchive(extraArchive, { target: "linux-x64-gnu" }),
    /unexpected dependency license member/u,
  );
});

test("real npm target tarballs reopen the exact target-specific dependency closure", { timeout: TIMEOUT }, (t) => {
  const assetDir = scratch(t, "npm-assets");
  const fixture = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    [
      "tools/test/create-broker-release-fixture.mjs",
      "--asset-dir",
      assetDir,
      "--version",
      "0.0.0",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  const packageTargets = new Map([
    ["@oliphaunt/broker-darwin-arm64", "macos-arm64"],
    ["@oliphaunt/broker-linux-arm64-gnu", "linux-arm64-gnu"],
    ["@oliphaunt/broker-linux-x64-gnu", "linux-x64-gnu"],
    ["@oliphaunt/broker-win32-x64-msvc", "windows-x64-msvc"],
  ]);
  const tarballs = brokerNpmTarballs("0.0.0", { assetDir });
  assert.equal(tarballs.length, packageTargets.size);
  for (const [packageName, tarball] of tarballs) {
    assertBrokerDependencyLicensesInArchive(tarball, {
      target: packageTargets.get(packageName),
      prefix: "package",
    });
  }

  const localTarballs = localRegistryBrokerNpmTarballs(
    "0.0.0",
    scratch(t, "local-registry-npm-stage"),
    scratch(t, "local-registry-npm-tarballs"),
    assetDir,
  );
  assert.equal(localTarballs.length, packageTargets.size);
  for (const [packageName, tarball] of localTarballs) {
    assertBrokerDependencyLicensesInArchive(tarball, {
      target: packageTargets.get(packageName),
      prefix: "package",
    });
  }
});

test("concurrent real Cargo payload packagers are isolated and reopen exact target closures", { timeout: TIMEOUT }, async (t) => {
  const assetDir = scratch(t, "cargo-assets");
  const outputDirs = [scratch(t, "cargo-output-a"), scratch(t, "cargo-output-b")];
  const sourceOutputDirs = [scratch(t, "cargo-source-a"), scratch(t, "cargo-source-b")];
  const logRoots = [scratch(t, "cargo-log-a"), scratch(t, "cargo-log-b")];
  const fixture = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    [
      "tools/test/create-broker-release-fixture.mjs",
      "--asset-dir",
      assetDir,
      "--version",
      "0.0.0",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  const packagedRuns = await Promise.all(outputDirs.map((outputDir, index) => spawnResult(
    path.join(ROOT, "tools/dev/bun.sh"),
    [
      "tools/release/package_broker_cargo_artifacts.mjs",
      "--asset-dir",
      assetDir,
      "--output-dir",
      outputDir,
      "--source-output-dir",
      sourceOutputDirs[index],
      "--version",
      "0.0.0",
    ],
    logRoots[index],
  )));
  for (const packaged of packagedRuns) {
    assert.equal(
      packaged.status,
      0,
      `${packaged.stderr}\n${packaged.stdout}\nsignal=${packaged.signal ?? "none"}`,
    );
  }
  const targets = new Map(TARGETS.map((target) => [
    `oliphaunt-broker-${target}-0.0.0.crate`,
    target,
  ]));
  for (const outputDir of outputDirs) {
    const crates = readdirSync(outputDir).filter((name) => name.endsWith(".crate")).sort();
    assert.deepEqual(crates, [...targets.keys()].sort());
    for (const crate of crates) {
      assertBrokerDependencyLicensesInArchive(path.join(outputDir, crate), {
        target: targets.get(crate),
        prefix: crate.replace(/\.crate$/u, ""),
      });
    }
  }
});

test("directory closure rejects missing, changed, extra, executable, and symlinked legal members", { timeout: TIMEOUT }, (t) => {
  const mutations = [
    ["missing", (directory, member) => rmSync(path.join(directory, ...member.split("/")))],
    ["changed", (directory, member) => writeFileSync(path.join(directory, ...member.split("/")), "changed\n")],
    ["executable", (directory, member) => chmodSync(path.join(directory, ...member.split("/")), 0o755)],
    ["extra", (directory) => writeFileSync(
      path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"), "licenses/extra.txt"),
      "extra\n",
      { mode: 0o644 },
    )],
  ];
  for (const [label, mutate] of mutations) {
    const directory = stageCarrier(t, "linux-x64-gnu");
    const member = brokerDependencyLicenseMembers("linux-x64-gnu").find((value) => value.endsWith(".txt"));
    mutate(directory, member);
    assert.throws(
      () => assertBrokerDependencyLicensesInDirectory(directory, { target: "linux-x64-gnu" }),
      /broker dependency license|canonical|mode 0644|unexpected|missing/u,
      label,
    );
  }

  const directory = stageCarrier(t, "linux-x64-gnu");
  const licenses = path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split("/"), "licenses");
  const replacement = path.join(directory, "replacement");
  mkdirSync(replacement, { mode: 0o755 });
  rmSync(licenses, { recursive: true });
  symlinkSync(replacement, licenses, "dir");
  assert.throws(
    () => assertBrokerDependencyLicensesInDirectory(directory, { target: "linux-x64-gnu" }),
    /symlink|missing/u,
  );
});

test("staging rejects a symlinked legal namespace ancestor without touching its target", { timeout: TIMEOUT }, (t) => {
  const directory = scratch(t, "symlink-parent-stage");
  const external = scratch(t, "symlink-parent-external");
  const externalRust = path.join(external, "rust");
  mkdirSync(externalRust, { mode: 0o755 });
  const sentinel = path.join(externalRust, "sentinel.txt");
  writeFileSync(sentinel, "must survive\n", { mode: 0o644 });
  symlinkSync(external, path.join(directory, "THIRD_PARTY_LICENSES"), "dir");

  assert.throws(
    () => stageBrokerDependencyLicenses(directory, "linux-x64-gnu"),
    /symlink|non-directory ancestor/u,
  );
  assert.throws(
    () => normalizeBrokerDependencyLicenseModes(directory, "linux-x64-gnu"),
    /symlink/u,
  );
  assert.throws(
    () => assertBrokerDependencyLicensesInDirectory(directory, { target: "linux-x64-gnu" }),
    /symlink/u,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "must survive\n");
});

test("contract mutations cannot omit attribution, change lock identity, lie about a selected branch, or skew target claims", { timeout: TIMEOUT }, (t) => {
  {
    const file = writeMutatedContract(t, (contract) => {
      const crossbeam = contract.packages.find(({ name }) => name === "crossbeam-channel");
      crossbeam.licenseFiles = crossbeam.licenseFiles.filter(({ name }) => name !== "LICENSE-THIRD-PARTY");
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /CC-BY-3.0|license blobs differ/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      const rustix = contract.packages.find(({ name }) => name === "rustix");
      rustix.licenseFiles = rustix.licenseFiles.filter(({ name }) => name !== "COPYRIGHT");
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /license blobs differ/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      contract.packages[0].checksum = "0".repeat(64);
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file, auditLock: true }),
      /Cargo\.lock identity changed/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      contract.packages.find(({ name }) => name === "zopfli").selectedLicense = "MIT";
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file, auditGraph: false }),
      /selects MIT but declares Apache-2.0/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      const key = "zopfli@0.8.3";
      contract.targets["linux-x64-gnu"].packages = contract.targets["linux-x64-gnu"].packages.filter((value) => value !== key);
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /package graph and package target claims disagree/u,
    );
  }
});
