import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import {
  allArtifactTargets,
  currentProductVersionSync,
} from "./release-artifact-targets.mjs";
import {
  prepareOliphauntBuildReleaseSource,
  prepareRustReleaseSource,
} from "./prepare-rust-release-source.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
} from "./release-notices.mjs";
import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import { rustNativeTargetCfg } from "./rust-native-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("freezes the generated target-wired Rust SDK source instead of the workspace facade", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "rust-release-source-test-"));
  try {
    const manifestPath = prepareRustReleaseSource({
      stageDir: path.join(root, "source"),
      log: false,
    });
    const manifest = readFileSync(manifestPath, "utf8");
    const source = readFileSync(path.join(root, "source/src/lib.rs"), "utf8");
    const workspaceSource = readFileSync(path.join(ROOT, "src/sdks/rust/src/lib.rs"), "utf8");
    const nativeVersion = currentProductVersionSync("liboliphaunt-native", "prepare-rust-release-source.test.mjs");
    const brokerVersion = currentProductVersionSync("oliphaunt-broker", "prepare-rust-release-source.test.mjs");
    const sdkVersion = currentProductVersionSync("oliphaunt-rust", "prepare-rust-release-source.test.mjs");
    const targets = allArtifactTargets({
      product: "liboliphaunt-native",
      kind: "native-runtime",
      surface: "rust-native-direct",
      publishedOnly: true,
    }, "prepare-rust-release-source.test.mjs");
    assert.equal(targets.length, 4);
    assert.match(manifest, /^license = "MIT"$/mu);
    assertReleaseNoticesInDirectory(path.join(root, "source"), { profile: "source-sdk" });

    for (const target of targets) {
      const cfg = rustNativeTargetCfg(target);
      assert.ok(manifest.includes(`[target.'cfg(${cfg})'.dependencies]`));
      assert.ok(manifest.includes(`liboliphaunt-native-${target.target} = { version = "=${nativeVersion}" }`));
      assert.ok(manifest.includes(`oliphaunt-broker-${target.target} = { version = "=${brokerVersion}" }`));
      assert.ok(source.includes(target.target));
    }
    assert.equal((manifest.match(/^oliphaunt-tools = /gmu) ?? []).length, targets.length);
    assert.match(source, /Generated release-only native target guard[.]/u);
    assert.match(source, /compile_error!/u);
    assert.match(source, /separately versioned oliphaunt-wasix crate/u);
    assert.doesNotMatch(workspaceSource, /Generated release-only native target guard|compile_error!/u);

    const cratePath = manualCargoPackageSource(
      manifestPath,
      path.join(root, "crate"),
      { root: ROOT, fail: (message) => assert.fail(message), rel: String },
    );
    assert.equal(path.basename(cratePath), `oliphaunt-${sdkVersion}.crate`);
    const packageRoot = `oliphaunt-${sdkVersion}`;
    assertReleaseNoticesInArchive(cratePath, {
      profile: "source-sdk",
      prefix: packageRoot,
    });
    const packedManifest = commandOutput("tar", ["-xOzf", cratePath, `${packageRoot}/Cargo.toml`]);
    const packedSource = commandOutput("tar", ["-xOzf", cratePath, `${packageRoot}/src/lib.rs`]);
    const packedNames = commandOutput("tar", ["-tzf", cratePath]);
    assert.equal(packedManifest, manifest);
    assert.equal(packedSource, source);
    assert.doesNotMatch(packedManifest, /=\s*\{[^}\n]*\bpath\s*=/u);
    assert.doesNotMatch(packedNames, /crates\/oliphaunt-build/u);

    // The product metadata intentionally points the Rust SDK at the broker
    // version while the broker executable is built from the SDK source. That
    // is not a registry cycle: published broker carriers are dependency-free
    // payload leaves, and only the generated SDK facade depends on them.
    const brokerCarriers = targets.map((target, publishOrder) => {
      const name = `oliphaunt-broker-${target.target}`;
      const brokerManifest = Bun.TOML.parse(readFileSync(
        path.join(ROOT, `src/runtimes/broker/crates/${target.target}/Cargo.toml`),
        "utf8",
      ));
      assert.equal(brokerManifest.dependencies, undefined, `${name} must not depend back on oliphaunt`);
      return {
        id: `cargo:${name}`,
        product: "oliphaunt-broker",
        ecosystem: "cargo",
        name,
        version: brokerVersion,
        publishOrder,
        dependencies: [],
      };
    });
    const brokerIds = brokerCarriers.map(({ id }) => id);
    const topology = normalPublicationPlan({
      products: [{ id: "oliphaunt-broker" }, { id: "oliphaunt-rust" }],
      carriers: [
        ...brokerCarriers,
        {
          id: "cargo:oliphaunt",
          product: "oliphaunt-rust",
          ecosystem: "cargo",
          name: "oliphaunt",
          version: sdkVersion,
          publishOrder: brokerCarriers.length,
          dependencies: brokerIds,
        },
      ],
    }, ["oliphaunt-broker", "oliphaunt-rust"]);
    const positions = new Map(topology.operations.map(({ carrierId }, index) => [carrierId, index]));
    for (const brokerId of brokerIds) {
      assert.ok(positions.get(brokerId) < positions.get("cargo:oliphaunt"));
      assert.match(packedManifest, new RegExp(`^${brokerId.slice("cargo:".length)} = \\{ version = "=${brokerVersion}" \\}$`, "mu"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freezes oliphaunt-build with truthful metadata and canonical notices", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "rust-build-release-source-test-"));
  try {
    const manifestPath = prepareOliphauntBuildReleaseSource({
      stageDir: path.join(root, "source"),
      log: false,
    });
    const manifest = readFileSync(manifestPath, "utf8");
    const version = currentProductVersionSync("oliphaunt-rust", "prepare-rust-release-source.test.mjs");
    assert.match(manifest, /^license = "MIT"$/mu);
    assert.doesNotMatch(manifest, /\.workspace\s*=\s*true/u);
    assertReleaseNoticesInDirectory(path.join(root, "source"), { profile: "source-sdk" });

    const cratePath = manualCargoPackageSource(
      manifestPath,
      path.join(root, "crate"),
      { root: ROOT, fail: (message) => assert.fail(message), rel: String },
    );
    assert.equal(path.basename(cratePath), `oliphaunt-build-${version}.crate`);
    assertReleaseNoticesInArchive(cratePath, {
      profile: "source-sdk",
      prefix: `oliphaunt-build-${version}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
