import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  requireExactWasixSdkCrate,
  validateWasixRustToolchainClosure,
  wasixRustCandidateContract,
} from "./wasix-rust-exact-candidate-consumer.mjs";
import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";

const SDK_VERSION = currentProductVersionSync(
  "oliphaunt-wasix-rust",
  "wasix-rust-exact-candidate-consumer.test",
);
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const WASIX_TOOLCHAIN_PACKAGES = [
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
].map(([name, version]) => ({ name, version, source: CRATES_IO_SOURCE }));

test("binds the WASIX Rust candidate to the complete liboliphaunt WASIX Cargo carrier set", () => {
  const contract = wasixRustCandidateContract();
  expect(contract.products).toEqual(["liboliphaunt-wasix", "oliphaunt-wasix-rust"]);
  expect(contract.sdk).toEqual({ name: "oliphaunt-wasix", version: SDK_VERSION, features: ["icu", "tools"] });
  expect(contract.runtimePackages).toEqual([
    "liboliphaunt-wasix-aot-aarch64-apple-darwin",
    "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
    "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
    "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
    "liboliphaunt-wasix-portable",
    "oliphaunt-icu",
    "oliphaunt-wasix-tools",
    "oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
    "oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
    "oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
    "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
  ]);
});

test("rejects compatible upstream patch drift in the clean WASIX consumer closure", () => {
  const closure = validateWasixRustToolchainClosure(WASIX_TOOLCHAIN_PACKAGES, {
    lockfile: "fixture.lock",
    canonical: { wasmer: "7.2.0", wasmerWasix: "0.702.0", webc: "12.0.0" },
  });
  expect(closure).toMatchObject({
    wasmerVersion: "7.2.0",
    wasmerWasixVersion: "0.702.0",
    webcVersion: "12.0.0",
  });
  expect(closure.packages).toEqual(
    [...WASIX_TOOLCHAIN_PACKAGES].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ),
  );
  expect(closure.sha256).toMatch(/^[0-9a-f]{64}$/u);

  const drifted = WASIX_TOOLCHAIN_PACKAGES.map((pkg) =>
    pkg.name === "virtual-mio" ? { ...pkg, version: "0.702.1" } : pkg
  );
  expect(() => validateWasixRustToolchainClosure(drifted, {
    lockfile: "fixture.lock",
    canonical: { wasmer: "7.2.0", wasmerWasix: "0.702.0", webc: "12.0.0" },
  })).toThrow("fixture.lock: virtual-mio resolved 0.702.1; expected 0.702.0");

  expect(() => validateWasixRustToolchainClosure([
    ...WASIX_TOOLCHAIN_PACKAGES,
    { name: "webc", version: "11.0.0", source: CRATES_IO_SOURCE },
  ], {
    lockfile: "fixture.lock",
    canonical: { wasmer: "7.2.0", wasmerWasix: "0.702.0", webc: "12.0.0" },
  })).toThrow("fixture.lock: expected exactly one resolved webc package, found 2");
});

test("accepts exactly one frozen oliphaunt-wasix crate and rejects substitutions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wasix-rust-candidate-test-"));
  try {
    const source = path.join(root, "source");
    const crates = path.join(root, "crates");
    mkdirSync(path.join(source, "src"), { recursive: true });
    writeFileSync(path.join(source, "Cargo.toml"), [
      "[package]",
      'name = "oliphaunt-wasix"',
      `version = "${SDK_VERSION}"`,
      'edition = "2024"',
      'license = "MIT"',
      "",
      "[workspace]",
      "",
    ].join("\n"));
    writeFileSync(path.join(source, "src/lib.rs"), "pub const OK: bool = true;\n");
    const crate = manualCargoPackageSource(path.join(source, "Cargo.toml"), crates, {
      root,
      rel: String,
      fail: (_prefix, message) => { throw new Error(message); },
    });
    expect(requireExactWasixSdkCrate(crates)).toMatchObject({
      path: crate,
      name: "oliphaunt-wasix",
      version: SDK_VERSION,
    });
    writeFileSync(path.join(crates, "substitution.crate"), "not a package");
    expect(() => requireExactWasixSdkCrate(crates)).toThrow("expected exactly one staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
