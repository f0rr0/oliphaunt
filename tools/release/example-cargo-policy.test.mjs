import { describe, expect, test } from "bun:test";

import {
  validateCandidateSourceSelection,
  validateResolvedPackagePolicy,
} from "./example-cargo-policy.mjs";

const cratesIo = "registry+https://github.com/rust-lang/crates.io-index";
const toolchainVersions = { wasmer: "7.2.0", wasmerWasix: "0.702.0" };
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
].map(([name, version]) => ({ name, version, source: cratesIo }));

describe("ephemeral example Cargo policy", () => {
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
});
