import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  EXAMPLE_CARGO_REGISTRY_INDEX,
  EXAMPLE_CARGO_REGISTRY_SOURCE,
  candidateRegistryPackages,
  configureExampleCargoRegistry,
  exampleCargoCandidatePatchConfig,
  verifyCandidateRegistryPackage,
} from "./example-cargo-registry.mjs";

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function run(args, { cwd, cargoHome }) {
  const result = spawnSync("cargo", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX: EXAMPLE_CARGO_REGISTRY_INDEX,
    },
  });
  assert.equal(result.status, 0, `cargo ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

function packageFixture(root) {
  const crate = path.join(root, "portable-dep");
  write(
    path.join(crate, "Cargo.toml"),
    '[package]\nname = "portable-dep"\nversion = "1.2.3"\nedition = "2021"\nlicense = "MIT"\n',
  );
  write(path.join(crate, "src/lib.rs"), "pub const VALUE: u8 = 7;\n");
  const cargoHome = path.join(root, "package-cargo-home");
  mkdirSync(cargoHome, { recursive: true });
  run(["package", "--allow-dirty", "--no-verify", "--offline"], { cwd: crate, cargoHome });
  const archive = path.join(crate, "target/package/portable-dep-1.2.3.crate");
  const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, checksum };
}

function stageRegistry(root, fixture) {
  const crates = path.join(root, "crates");
  const index = path.join(root, "index");
  mkdirSync(crates, { recursive: true });
  copyFileSync(fixture.archive, path.join(crates, "portable-dep-1.2.3.crate"));
  write(
    path.join(index, "config.json"),
    `${JSON.stringify({ dl: `${pathToFileURL(crates).href}/{crate}-{version}.crate` })}\n`,
  );
  write(
    path.join(index, "po/rt/portable-dep"),
    `${JSON.stringify({
      name: "portable-dep",
      vers: "1.2.3",
      deps: [],
      cksum: fixture.checksum,
      features: {},
      yanked: false,
    })}\n`,
  );
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: index, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@oliphaunt.invalid", "commit", "-qm", "index"]);
  return index;
}

test("an ephemeral generated lock remains usable when the staged registry moves", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-portable-registry-"));
  try {
    const fixture = packageFixture(root);
    const firstIndex = stageRegistry(path.join(root, "first-checkout/target/local-registries/cargo"), fixture);
    const firstHome = path.join(root, "first-checkout/target/local-registries/cargo-home");
    configureExampleCargoRegistry({ cargoHome: firstHome, indexDirectory: firstIndex });

    const consumer = path.join(root, "consumer");
    write(
      path.join(consumer, "Cargo.toml"),
      `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nportable-dep = "=1.2.3"\n\n${exampleCargoCandidatePatchConfig([{ name: "portable-dep", vers: "1.2.3" }])}`,
    );
    write(path.join(consumer, "src/main.rs"), "fn main() { assert_eq!(portable_dep::VALUE, 7); }\n");
    run(["generate-lockfile"], { cwd: consumer, cargoHome: firstHome });
    const lock = readFileSync(path.join(consumer, "Cargo.lock"), "utf8");
    assert.ok(lock.includes(`source = "${EXAMPLE_CARGO_REGISTRY_SOURCE}"`));
    assert.ok(lock.includes(`checksum = "${fixture.checksum}"`));

    rmSync(path.join(root, "first-checkout"), { recursive: true, force: true });
    rmSync(path.join(consumer, "target"), { recursive: true, force: true });
    const secondIndex = stageRegistry(path.join(root, "second-checkout/target/local-registries/cargo"), fixture);
    const secondHome = path.join(root, "second-checkout/target/local-registries/cargo-home");
    configureExampleCargoRegistry({ cargoHome: secondHome, indexDirectory: secondIndex });
    run(["check", "--locked"], { cwd: consumer, cargoHome: secondHome });
    assert.equal(readFileSync(path.join(consumer, "Cargo.lock"), "utf8"), lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate patch config is sorted, exact, and rejects more than one version per name", () => {
  assert.equal(
    exampleCargoCandidatePatchConfig([
      { name: "z-carrier", vers: "2.3.4" },
      { name: "a-carrier", vers: "1.2.3" },
    ]),
    '[patch.crates-io]\n"a-carrier" = { version = "=1.2.3", registry = "oliphaunt-local" }\n"z-carrier" = { version = "=2.3.4", registry = "oliphaunt-local" }\n',
  );
  assert.throws(
    () => exampleCargoCandidatePatchConfig([
      { name: "same", vers: "1.0.0" },
      { name: "same", vers: "2.0.0" },
    ]),
    /multiple versions for same/u,
  );
});

test("candidate index rejects multiple versions for one package", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-multi-version-registry-"));
  try {
    const fixture = packageFixture(root);
    const index = stageRegistry(path.join(root, "registry"), fixture);
    const indexFile = path.join(index, "po/rt/portable-dep");
    const first = JSON.parse(readFileSync(indexFile, "utf8"));
    writeFileSync(indexFile, `${JSON.stringify(first)}\n${JSON.stringify({ ...first, vers: "1.2.4" })}\n`);
    assert.throws(() => candidateRegistryPackages(index), /multiple versions for portable-dep/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification rejects file URLs outside the sibling crates directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-escaping-registry-"));
  try {
    const fixture = packageFixture(root);
    const index = stageRegistry(path.join(root, "registry"), fixture);
    writeFileSync(
      path.join(index, "config.json"),
      `${JSON.stringify({ dl: `${pathToFileURL(path.join(root, "outside")).href}/{crate}-{version}.crate` })}\n`,
    );
    const [entry] = candidateRegistryPackages(index);
    assert.throws(() => verifyCandidateRegistryPackage(index, entry), /escapes sibling crates directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification rejects a symlink that resolves outside the sibling crates directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-symlink-registry-"));
  try {
    const fixture = packageFixture(root);
    const registryRoot = path.join(root, "registry");
    const index = stageRegistry(registryRoot, fixture);
    const archive = path.join(registryRoot, "crates/portable-dep-1.2.3.crate");
    const outside = path.join(root, "outside.crate");
    copyFileSync(archive, outside);
    rmSync(archive);
    symlinkSync(outside, archive);
    const [entry] = candidateRegistryPackages(index);
    assert.throws(() => verifyCandidateRegistryPackage(index, entry), /resolves outside sibling crates directory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification rejects a sibling crates directory symlink escape", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-crates-symlink-registry-"));
  try {
    const fixture = packageFixture(root);
    const registryRoot = path.join(root, "registry");
    const index = stageRegistry(registryRoot, fixture);
    const crates = path.join(registryRoot, "crates");
    const outside = path.join(root, "outside-crates");
    renameSync(crates, outside);
    symlinkSync(outside, crates, "dir");
    const [entry] = candidateRegistryPackages(index);
    assert.throws(() => verifyCandidateRegistryPackage(index, entry), /resolves outside candidate registry root/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification rejects bytes that differ from the exact index checksum", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-checksum-registry-"));
  try {
    const fixture = packageFixture(root);
    const registryRoot = path.join(root, "registry");
    const index = stageRegistry(registryRoot, fixture);
    writeFileSync(path.join(registryRoot, "crates/portable-dep-1.2.3.crate"), "tampered");
    const [entry] = candidateRegistryPackages(index);
    assert.throws(() => verifyCandidateRegistryPackage(index, entry), /does not match archive/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
