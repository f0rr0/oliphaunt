import { expect, test } from "bun:test";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  consumeExactCargoCandidates,
  renderExactCargoConsumerManifest,
  validateExactCargoCandidateLock,
  validateExactCargoMetadata,
} from "./exact-cargo-candidate-consumer.mjs";
import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import { EXAMPLE_CARGO_REGISTRY_SOURCE } from "./example-cargo-registry.mjs";

test("renders deterministic all-feature exact Cargo dependencies", () => {
  const rendered = renderExactCargoConsumerManifest({
    packageName: "candidate-consumer",
    dependencies: [
      { name: "z-carrier", version: "1.2.3", features: ["wasix", "native"], defaultFeatures: false },
      { name: "a-carrier", version: "2.0.0", features: [] },
    ],
  });
  expect(rendered.indexOf('"a-carrier"')).toBeLessThan(rendered.indexOf('"z-carrier"'));
  expect(rendered).toContain('features = ["native", "wasix"]');
  expect(rendered).toContain("default-features = false");
  expect(() => renderExactCargoConsumerManifest({
    packageName: "candidate-consumer",
    dependencies: [
      { name: "dup", version: "1.0.0" },
      { name: "dup", version: "1.0.0" },
    ],
  })).toThrow("duplicate package names");
});

test("requires every exact indexed package in the Cargo lock and clean extracted metadata", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "exact-cargo-consumer-test-"));
  try {
    const index = path.join(root, "index");
    const crates = path.join(root, "crates");
    const cargoHome = path.join(root, "cargo-home");
    const extracted = path.join(cargoHome, "registry/src/test/candidate-1.0.0/Cargo.toml");
    mkdirSync(path.join(index, "ca", "nd"), { recursive: true });
    mkdirSync(crates, { recursive: true });
    mkdirSync(path.dirname(extracted), { recursive: true });
    const checksum = "a".repeat(64);
    writeFileSync(path.join(index, "config.json"), `${JSON.stringify({ dl: `file://${crates}/{crate}-{version}.crate` })}\n`);
    writeFileSync(path.join(index, "ca", "nd", "candidate"), `${JSON.stringify({
      name: "candidate",
      vers: "1.0.0",
      deps: [],
      features: {},
      cksum: checksum,
      yanked: false,
    })}\n`);
    writeFileSync(extracted, "[package]\nname='candidate'\nversion='1.0.0'\n");
    const lock = path.join(root, "Cargo.lock");
    writeFileSync(lock, `version = 4\n\n[[package]]\nname = "candidate"\nversion = "1.0.0"\nsource = "${EXAMPLE_CARGO_REGISTRY_SOURCE}"\nchecksum = "${checksum}"\n`);

    expect(validateExactCargoCandidateLock({ lockFile: lock, indexDirectory: index })).toEqual([{
      name: "candidate",
      version: "1.0.0",
      checksum,
      source: EXAMPLE_CARGO_REGISTRY_SOURCE,
    }]);
    expect(validateExactCargoMetadata({
      metadata: { packages: [{
        name: "candidate",
        version: "1.0.0",
        source: EXAMPLE_CARGO_REGISTRY_SOURCE,
        manifest_path: extracted,
      }] },
      candidates: [{ name: "candidate", vers: "1.0.0", cksum: checksum }],
      cargoHome,
    })).toHaveLength(1);

    writeFileSync(lock, "version = 4\npackage = []\n");
    expect(() => validateExactCargoCandidateLock({ lockFile: lock, indexDirectory: index })).toThrow(
      "resolved 0 lock rows",
    );
    expect(() => validateExactCargoMetadata({
      metadata: { packages: [{
        name: "candidate",
        version: "1.0.0",
        source: EXAMPLE_CARGO_REGISTRY_SOURCE,
        manifest_path: path.join(root, "outside.toml"),
      }] },
      candidates: [{ name: "candidate", vers: "1.0.0", cksum: checksum }],
      cargoHome,
    })).toThrow("was not extracted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetches the indexed archive through an isolated Cargo home and candidate source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "exact-cargo-consumer-integration-"));
  try {
    const source = path.join(root, "source");
    const crates = path.join(root, "crates");
    const index = path.join(root, "index");
    mkdirSync(path.join(source, "src"), { recursive: true });
    mkdirSync(path.join(index, "ca", "nd"), { recursive: true });
    writeFileSync(path.join(source, "Cargo.toml"), [
      "[package]",
      'name = "candidate"',
      'version = "1.0.0"',
      'edition = "2024"',
      'license = "MIT"',
      "",
      "[workspace]",
      "",
    ].join("\n"));
    writeFileSync(path.join(source, "src/lib.rs"), "pub const EXACT: bool = true;\n");
    const archive = manualCargoPackageSource(path.join(source, "Cargo.toml"), crates, {
      root,
      rel: String,
      fail: (_prefix, message) => { throw new Error(message); },
    });
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(
      path.join(index, "config.json"),
      `${JSON.stringify({ dl: `file://${crates}/{crate}-{version}.crate` })}\n`,
    );
    writeFileSync(path.join(index, "ca", "nd", "candidate"), `${JSON.stringify({
      name: "candidate",
      vers: "1.0.0",
      deps: [],
      features: {},
      cksum: checksum,
      yanked: false,
    })}\n`);
    execFileSync("git", ["init", "--quiet"], { cwd: index });
    execFileSync("git", ["add", "config.json", "ca/nd/candidate"], { cwd: index });
    execFileSync(
      "git",
      ["-c", "user.name=Oliphaunt Test", "-c", "user.email=test@oliphaunt.invalid", "commit", "--quiet", "-m", "candidate index"],
      { cwd: index },
    );

    const output = path.join(root, "output");
    const evidence = consumeExactCargoCandidates({
      indexDirectory: index,
      outputRoot: output,
      packageName: "candidate-consumer",
      dependencies: [{ name: "candidate", version: "1.0.0" }],
    });
    expect(evidence.locked).toHaveLength(1);
    expect(evidence.installed).toHaveLength(1);
    expect(evidence.installed[0]).toMatchObject({
      name: "candidate",
      version: "1.0.0",
      checksum,
      source: EXAMPLE_CARGO_REGISTRY_SOURCE,
    });
    expect(existsSync(path.join(output, "evidence", "Cargo.lock"))).toBe(true);
    expect(existsSync(path.join(output, "evidence", "exact-cargo-consumer.json"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
