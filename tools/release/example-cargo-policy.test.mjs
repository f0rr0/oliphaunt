import { describe, expect, test } from "bun:test";
import {
  readFileSync,
} from "node:fs";
import path from "node:path";

import {
  EXAMPLE_CARGO_POLICIES,
  REQUIRED_WASIX_CONSUMER_PINS,
  exampleCargoReleaseVersionBindings,
  validateExampleManifestPolicy,
  validateResolvedPackagePolicy,
  validateWasixConsumerDependencyPins,
} from "./example-cargo-policy.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const cratesIo = "registry+https://github.com/rust-lang/crates.io-index";
const toolchainVersions = {
  wasmer: "7.2.1",
  wasmerWasix: "0.702.1",
  webc: "12.0.0",
};
const wasmerPackages = [
  ["wasmer", "7.2.1"],
  ["wasmer-compiler", "7.2.1"],
  ["wasmer-derive", "7.2.1"],
  ["wasmer-types", "7.2.1"],
  ["wasmer-vm", "7.2.1"],
  ["wasmer-config", "0.702.1"],
  ["wasmer-journal", "0.702.1"],
  ["wasmer-package", "0.702.1"],
  ["wasmer-wasix", "0.702.1"],
  ["wasmer-wasix-types", "0.702.1"],
  ["virtual-fs", "0.702.1"],
  ["virtual-mio", "0.702.1"],
  ["virtual-net", "0.702.1"],
  ["webc", "12.0.0"],
].map(([name, version]) => ({ name, version, source: cratesIo }));

describe("ephemeral example Cargo policy", () => {
  test("owns every registry example version and native runtime binding", () => {
    const bindings = exampleCargoReleaseVersionBindings();
    expect(bindings.filter(({ kind }) => kind === "dependency")).toHaveLength(
      EXAMPLE_CARGO_POLICIES.reduce((count, policy) => count + policy.directPackages.length, 0),
    );
    expect(bindings.filter(({ kind }) => kind === "runtime")).toHaveLength(
      EXAMPLE_CARGO_POLICIES.filter(({ runtime }) => runtime !== undefined).length,
    );
    expect(new Set(bindings.map(({ file }) => file))).toEqual(new Set(
      EXAMPLE_CARGO_POLICIES.map(({ crateDir }) => `${crateDir}/Cargo.toml`),
    ));
    for (const policy of EXAMPLE_CARGO_POLICIES) {
      expect(bindings.filter(({ policyId, kind }) => policyId === policy.id && kind === "dependency"))
        .toHaveLength(policy.directPackages.length);
    }
  });

  test("rejects stale runtime metadata, duplicate dependencies, and dependency scope drift", () => {
    const policy = EXAMPLE_CARGO_POLICIES.find(({ id }) => id === "native-tauri");
    const bindings = exampleCargoReleaseVersionBindings().filter(({ policyId }) => policyId === policy.id);
    const runtimeBinding = bindings.find(({ kind }) => kind === "runtime");
    const manifest = Bun.TOML.parse(readFileSync(path.join(ROOT, policy.crateDir, "Cargo.toml"), "utf8"));

    manifest.package.metadata.oliphaunt["runtime-version"] = "9.9.9";
    manifest["dev-dependencies"] = { oliphaunt: bindings.find(({ name }) => name === "oliphaunt").expected };
    delete manifest.dependencies.oliphaunt;
    const failures = validateExampleManifestPolicy(policy, manifest, bindings);
    expect(failures).toContain(
      `${policy.crateDir}/Cargo.toml runtime-version uses "9.9.9"; expected ${runtimeBinding.expected}`,
    );
    expect(failures).toContain(
      `${policy.crateDir}/Cargo.toml oliphaunt must remain at TOML path dependencies.oliphaunt`,
    );

    manifest.dependencies.oliphaunt = bindings.find(({ name }) => name === "oliphaunt").expected;
    expect(validateExampleManifestPolicy(policy, manifest, bindings).some(
      (failure) => failure.includes("direct Oliphaunt dependencies"),
    )).toBe(true);
  });

  test("requires exact non-optional pins for the published WASIX family closure", () => {
    const dependencies = Object.fromEntries(
      REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
        name,
        name === "webc"
          ? "=12.0.0"
          : { version: "=0.702.1", "default-features": false },
      ]),
    );
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "fixture.toml", toolchainVersions },
    )).toEqual([]);

    dependencies["virtual-mio"] = { version: "0.702.1", "default-features": false };
    dependencies["virtual-net"] = {
      version: "=0.702.1",
      optional: true,
      "default-features": false,
    };
    delete dependencies["virtual-fs"];
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "fixture.toml", toolchainVersions },
    )).toEqual([
      "fixture.toml must declare non-optional virtual-fs exactly once, found 0",
      "fixture.toml dependencies.virtual-mio must pin virtual-mio exactly to =0.702.1, got \"0.702.1\"",
      "fixture.toml dependencies.virtual-net must keep virtual-net non-optional",
    ]);
  });

  test("rejects default-feature and source substitutions in published WASIX pins", () => {
    const dependencies = Object.fromEntries(
      REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
        name,
        name === "webc"
          ? "=12.0.0"
          : { version: "=0.702.1", "default-features": false },
      ]),
    );
    delete dependencies["wasmer-config"]["default-features"];
    dependencies["wasmer-journal"]["default-features"] = true;
    dependencies["wasmer-package"].path = "../../substituted";
    dependencies["wasmer-wasix-types"].git = "https://example.invalid/wasix";
    dependencies["virtual-fs"].registry = "substituted";

    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "fixture.toml", toolchainVersions },
    )).toEqual([
      "fixture.toml dependencies.wasmer-config must set default-features = false for wasmer-config",
      "fixture.toml dependencies.wasmer-journal must set default-features = false for wasmer-journal",
      "fixture.toml dependencies.wasmer-package must resolve wasmer-package from crates.io without source selectors, found path",
      "fixture.toml dependencies.wasmer-wasix-types must resolve wasmer-wasix-types from crates.io without source selectors, found git",
      "fixture.toml dependencies.virtual-fs must resolve virtual-fs from crates.io without source selectors, found registry",
    ]);
  });

  test("rejects missing, ranged, optional, and source-substituted WebC pins", () => {
    const dependencies = Object.fromEntries(
      REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
        name,
        name === "webc"
          ? "=12.0.0"
          : { version: "=0.702.1", "default-features": false },
      ]),
    );

    delete dependencies.webc;
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "missing.toml", toolchainVersions },
    )).toContain("missing.toml must declare non-optional webc exactly once, found 0");

    dependencies.webc = {
      version: "^12.0.0",
      optional: true,
      git: "https://example.invalid/webc",
    };
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "substituted.toml", toolchainVersions },
    )).toEqual([
      "substituted.toml dependencies.webc must pin webc exactly to =12.0.0, got \"^12.0.0\"",
      "substituted.toml dependencies.webc must keep webc non-optional",
      "substituted.toml dependencies.webc must resolve webc from crates.io without source selectors, found git",
    ]);
  });

  test("accepts canonical stable WASIX packages and advisory floors", () => {
    expect(validateResolvedPackagePolicy("fixture.lock", [
      ...wasmerPackages,
      { name: "crossbeam-epoch", version: "0.9.20", source: cratesIo },
      { name: "postgres-protocol", version: "0.6.12", source: cratesIo },
    ], { wasixToolchain: true, toolchainVersions })).toEqual([]);
  });

  test("rejects prerelease Wasmer drift", () => {
    const packages = wasmerPackages.map((pkg) =>
      pkg.name === "wasmer-wasix" ? { ...pkg, version: "0.702.1-alpha.3" } : pkg,
    );
    expect(validateResolvedPackagePolicy("fixture.lock", packages, {
      wasixToolchain: true,
      toolchainVersions,
    })).toContain("fixture.lock: wasmer-wasix resolved 0.702.1-alpha.3; expected 0.702.1");
  });

  test("rejects duplicate or drifted WebC identities from fresh consumer locks", () => {
    const duplicate = [
      ...wasmerPackages,
      { name: "webc", version: "11.0.0", source: cratesIo },
    ];
    expect(validateResolvedPackagePolicy("fixture.lock", duplicate, {
      wasixToolchain: true,
      toolchainVersions,
    })).toContain("fixture.lock: expected exactly one resolved webc package, found 2");

    const drifted = wasmerPackages.map((pkg) =>
      pkg.name === "webc" ? { ...pkg, version: "12.0.1" } : pkg
    );
    expect(validateResolvedPackagePolicy("fixture.lock", drifted, {
      wasixToolchain: true,
      toolchainVersions,
    })).toContain("fixture.lock: webc resolved 12.0.1; expected 12.0.0");
  });

  test("rejects advisory versions below their floors", () => {
    expect(validateResolvedPackagePolicy("fixture.lock", [
      { name: "crossbeam-epoch", version: "0.9.18", source: cratesIo },
      { name: "postgres-protocol", version: "0.6.11", source: cratesIo },
    ])).toEqual([
      "fixture.lock: crossbeam-epoch 0.9.18 is below required floor 0.9.20",
      "fixture.lock: postgres-protocol 0.6.11 is below required floor 0.6.12",
    ]);
  });

  test("fails closed when a required transitive package disappears", () => {
    expect(validateResolvedPackagePolicy(
      "fixture.lock",
      wasmerPackages.filter((pkg) => pkg.name !== "virtual-net"),
      { wasixToolchain: true, toolchainVersions },
    )).toContain("fixture.lock: expected exactly one resolved virtual-net package, found 0");
  });

  test("rejects unknown Wasmer and virtual packages instead of accepting stable drift", () => {
    const failures = validateResolvedPackagePolicy("fixture.lock", [
      ...wasmerPackages,
      { name: "wasmer-future", version: "1.0.0", source: cratesIo },
      { name: "virtual-future", version: "0.702.1", source: cratesIo },
    ], { wasixToolchain: true, toolchainVersions });
    expect(failures).toContain(
      "fixture.lock: unexpected non-canonical WASIX toolchain package wasmer-future@1.0.0",
    );
    expect(failures).toContain(
      "fixture.lock: unexpected non-canonical WASIX toolchain package virtual-future@0.702.1",
    );
  });

});
