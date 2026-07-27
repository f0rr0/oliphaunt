import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REQUIRED_WASIX_CONSUMER_PINS,
  validateCandidateLock,
  validateCandidateSourceSelection,
  validateResolvedPackagePolicy,
  validateWasixConsumerDependencyPins,
} from "./example-cargo-policy.mjs";

const cratesIo = "registry+https://github.com/rust-lang/crates.io-index";
const toolchainVersions = {
  wasmer: "7.2.0",
  wasmerWasix: "0.702.0",
  webc: "12.0.0",
};
const wasmerPackages = [
  ["wasmer", "7.2.0"],
  ["wasmer-compiler", "7.2.0"],
  ["wasmer-derive", "7.2.0"],
  ["wasmer-types", "7.2.0"],
  ["wasmer-vm", "7.2.0"],
  ["wasmer-config", "0.702.0"],
  ["wasmer-journal", "0.702.0"],
  ["wasmer-package", "0.702.0"],
  ["wasmer-wasix", "0.702.0"],
  ["wasmer-wasix-types", "0.702.0"],
  ["virtual-fs", "0.702.0"],
  ["virtual-mio", "0.702.0"],
  ["virtual-net", "0.702.0"],
  ["webc", "12.0.0"],
].map(([name, version]) => ({ name, version, source: cratesIo }));

describe("ephemeral example Cargo policy", () => {
  test("requires exact non-optional pins for the published WASIX family closure", () => {
    const dependencies = Object.fromEntries(
      REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
        name,
        name === "webc"
          ? "=12.0.0"
          : { version: "=0.702.0", "default-features": false },
      ]),
    );
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "fixture.toml", toolchainVersions },
    )).toEqual([]);

    dependencies["virtual-mio"] = { version: "0.702.0", "default-features": false };
    dependencies["virtual-net"] = {
      version: "=0.702.0",
      optional: true,
      "default-features": false,
    };
    delete dependencies["virtual-fs"];
    expect(validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: "fixture.toml", toolchainVersions },
    )).toEqual([
      "fixture.toml must declare non-optional virtual-fs exactly once, found 0",
      "fixture.toml dependencies.virtual-mio must pin virtual-mio exactly to =0.702.0, got \"0.702.0\"",
      "fixture.toml dependencies.virtual-net must keep virtual-net non-optional",
    ]);
  });

  test("rejects default-feature and source substitutions in published WASIX pins", () => {
    const dependencies = Object.fromEntries(
      REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
        name,
        name === "webc"
          ? "=12.0.0"
          : { version: "=0.702.0", "default-features": false },
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
          : { version: "=0.702.0", "default-features": false },
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
      pkg.name === "wasmer-wasix" ? { ...pkg, version: "0.702.0-alpha.3" } : pkg,
    );
    expect(validateResolvedPackagePolicy("fixture.lock", packages, {
      wasixToolchain: true,
      toolchainVersions,
    })).toContain("fixture.lock: wasmer-wasix resolved 0.702.0-alpha.3; expected 0.702.0");
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
      { name: "virtual-future", version: "0.702.0", source: cratesIo },
    ], { wasixToolchain: true, toolchainVersions });
    expect(failures).toContain(
      "fixture.lock: unexpected non-canonical WASIX toolchain package wasmer-future@1.0.0",
    );
    expect(failures).toContain(
      "fixture.lock: unexpected non-canonical WASIX toolchain package virtual-future@0.702.0",
    );
  });

  test("rejects candidate fallback to crates.io", () => {
    const checksum = "a".repeat(64);
    expect(validateCandidateSourceSelection("fixture.lock", [{
      name: "oliphaunt-wasix",
      version: "0.1.0",
      source: cratesIo,
      checksum,
    }], [{ name: "oliphaunt-wasix", vers: "0.1.0", cksum: checksum }])).toContain(
      "fixture.lock: selected candidate oliphaunt-wasix@0.1.0 resolved from registry+https://github.com/rust-lang/crates.io-index; expected registry+https://cargo.oliphaunt.invalid/index",
    );
  });

  test("rejects candidate lock checksum drift", () => {
    expect(validateCandidateSourceSelection("fixture.lock", [{
      name: "oliphaunt-wasix",
      version: "0.1.0",
      source: "registry+https://cargo.oliphaunt.invalid/index",
      checksum: "b".repeat(64),
    }], [{ name: "oliphaunt-wasix", vers: "0.1.0", cksum: "a".repeat(64) }])).toContain(
      "fixture.lock: oliphaunt-wasix@0.1.0 lock checksum differs from candidate index",
    );
  });

  test("the real candidate-lock entrypoint loads the canonical WASIX toolchain", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-wasix-candidate-lock-"));
    try {
      const lockfile = path.join(root, "Cargo.lock");
      const index = path.join(root, "registry/index");
      mkdirSync(path.join(index, "fi/xt"), { recursive: true });
      writeFileSync(lockfile, "version = 3\n");
      writeFileSync(
        path.join(index, "config.json"),
        `${JSON.stringify({ dl: "file:///nonexistent/{crate}-{version}.crate" })}\n`,
      );
      writeFileSync(
        path.join(index, "fi/xt/fixture-dep"),
        `${JSON.stringify({
          name: "fixture-dep",
          vers: "1.0.0",
          deps: [],
          cksum: "a".repeat(64),
          features: {},
          yanked: false,
        })}\n`,
      );

      expect(() => validateCandidateLock(
        "wasix-tauri",
        lockfile,
        index,
        { registryVerified: true },
      )).toThrow("expected exactly one resolved wasmer package, found 0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
