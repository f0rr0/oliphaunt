import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  requireExactWasixSdkCrate,
  wasixRustCandidateContract,
} from "./wasix-rust-exact-candidate-consumer.mjs";
import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";

const SDK_VERSION = currentProductVersionSync(
  "oliphaunt-wasix-rust",
  "wasix-rust-exact-candidate-consumer.test",
);

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
