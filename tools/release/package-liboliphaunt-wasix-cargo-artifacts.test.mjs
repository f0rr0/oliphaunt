#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { extensionSqlNames } from "./release-artifact-targets.mjs";
import {
  extractArchiveMemberToFile,
  injectRuntimeExtensionDependencies,
} from "./package_liboliphaunt_wasix_cargo_artifacts.mjs";
import {
  AOT_TARGET_TRIPLES,
  wasixExtensionAotPackageName,
} from "./wasix-cargo-artifact-contract.mjs";
import { canonicalWasixAotMetadata } from "./wasix-aot-manifest.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const directories = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function run(command, args, { cwd = ROOT, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function aggregateFixture(root) {
  const product = "oliphaunt-extension-contrib-pg18";
  const version = "0.0.0";
  const productRoot = path.join(root, product);
  const releaseAssets = path.join(productRoot, "release-assets");
  const archiveRoot = `${product}-${version}-wasix-wasix-portable-bundle`;
  const carrierName = `${archiveRoot}.tar.gz`;
  const stage = path.join(root, "stage", archiveRoot);
  const extensions = [];
  const sqlNames = extensionSqlNames(product, "package-liboliphaunt-wasix-cargo-artifacts.test");
  for (const sqlName of sqlNames) {
    const name = `${product}-${version}-wasix-portable.tar.zst`;
    const memberPath = `extensions/${sqlName}/${name}`;
    const file = path.join(stage, ...memberPath.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(`${sqlName}:`.repeat(20)));
    extensions.push({
      sqlName,
      dependencies: sqlName === "earthdistance" ? ["cube"] : [],
      nativeModuleStem: ["cube", "earthdistance"].includes(sqlName) ? sqlName : null,
      assets: [{
        name,
        family: "wasix",
        target: "wasix-portable",
        kind: "wasix-runtime",
        identity: null,
        path: file,
        sha256: sha256(file),
        bytes: statSync(file).size,
        carrierAsset: carrierName,
        carrierRoot: archiveRoot,
        memberPath,
      }],
    });
  }
  mkdirSync(releaseAssets, { recursive: true });
  const carrier = path.join(releaseAssets, carrierName);
  run("tar", ["-czf", carrier, "-C", path.dirname(stage), archiveRoot]);
  writeFileSync(path.join(productRoot, "extension-artifacts.json"), `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v2",
    product,
    version,
    extensions,
    carrierAssets: [{
      name: carrierName,
      family: "wasix",
      target: "wasix-portable",
      kind: "extension-bundle",
      sha256: sha256(carrier),
      bytes: statSync(carrier).size,
      memberCount: sqlNames.length,
    }],
  }, null, 2)}\n`);
  const canonicalAot = canonicalWasixAotMetadata();
  for (const [targetId, targetTriple] of Object.entries(AOT_TARGET_TRIPLES)) {
    for (const sqlName of ["cube", "earthdistance"]) {
      const directory = path.join(productRoot, "wasix-aot", targetId, sqlName);
      const artifactName = `${sqlName}.bin.zst`;
      const artifact = path.join(directory, artifactName);
      mkdirSync(directory, { recursive: true });
      writeFileSync(artifact, Buffer.from(`${targetTriple}:${sqlName}:`.repeat(30)));
      writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify({
        "format-version": 1,
        "source-lane": canonicalAot.sourceLane,
        "engine": canonicalAot.engine,
        "wasmer-version": canonicalAot.wasmerVersion,
        "wasmer-wasix-version": canonicalAot.wasmerWasixVersion,
        "target-triple": targetTriple,
        artifacts: [{
          name: `extension:${sqlName}`,
          path: artifactName,
          sha256: sha256(artifact),
        }],
      }, null, 2)}\n`);
    }
  }
  return productRoot;
}

describe("aggregate WASIX Cargo artifact packaging", () => {
  test("streams nested portable archives larger than spawnSync's default buffer", () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-aggregate-stream-test-"));
    directories.push(root);
    const carrierRoot = "aggregate-carrier";
    const member = `${carrierRoot}/extensions/pgcrypto/extension.tar.zst`;
    const source = path.join(root, "stage", ...member.split("/"));
    const expected = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, expected);
    const carrier = path.join(root, "carrier.tar.gz");
    run("tar", ["-czf", carrier, "-C", path.join(root, "stage"), carrierRoot]);

    const destination = path.join(root, "materialized", "extension.tar.zst");
    extractArchiveMemberToFile(carrier, member, destination);
    expect(readFileSync(destination)).toEqual(expected);
  });

  test("splits from part-001 and a single carrier feature selects earthdistance plus cube only", {
    timeout: 180_000,
  }, () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-aggregate-cargo-test-"));
    directories.push(root);
    const extensionRoot = aggregateFixture(root);
    const output = path.join(root, "output");
    run("bun", [
      "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
      "--extensions-only",
      "--extension-artifact-root", extensionRoot,
      "--extension-part-bytes", "256",
      "--output-dir", output,
      "--version", "0.1.0",
    ]);

    const sources = path.join(ROOT, "target/oliphaunt-wasix/cargo-package-sources");
    const carrierName = "oliphaunt-extension-contrib-pg18-wasix";
    const carrierManifest = Bun.TOML.parse(readFileSync(path.join(sources, carrierName, "Cargo.toml"), "utf8"));
    const partNames = Object.keys(carrierManifest["build-dependencies"])
      .filter((name) => name.startsWith(`${carrierName}-part-`))
      .sort();
    expect(partNames.length).toBeGreaterThan(1);
    expect(partNames[0]).toBe(`${carrierName}-part-001`);
    expect(partNames).toEqual(partNames.map((_, index) => `${carrierName}-part-${String(index + 1).padStart(3, "0")}`));
    expect(partNames.every((name) => name.length <= 64)).toBe(true);

    const runtimeName = "liboliphaunt-wasix-portable";
    const runtimeSource = path.join(sources, runtimeName);
    cpSync(path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/assets"), runtimeSource, {
      recursive: true,
      filter: (source) => !["target", "payload", "artifacts"].includes(path.basename(source)),
    });
    const members = extensionSqlNames("oliphaunt-extension-contrib-pg18", "package-liboliphaunt-wasix-cargo-artifacts.test")
      .map((sqlName) => ({ sqlName, dependencies: sqlName === "earthdistance" ? ["cube"] : [] }));
    const runtimeCargoToml = path.join(runtimeSource, "Cargo.toml");
    const aotSources = Object.values(AOT_TARGET_TRIPLES).map((target) => ({ spec: {
      name: wasixExtensionAotPackageName("oliphaunt-extension-contrib-pg18", target),
      product: "oliphaunt-extension-contrib-pg18",
      target,
      dependencyRequirement: "=0.0.0",
    } }));
    writeFileSync(runtimeCargoToml, injectRuntimeExtensionDependencies(
      readFileSync(runtimeCargoToml, "utf8"),
      [{ spec: {
        name: carrierName,
        product: "oliphaunt-extension-contrib-pg18",
        dependencyRequirement: "=0.0.0",
        members,
      } }],
      aotSources,
    ));
    const runtimeManifest = Bun.TOML.parse(readFileSync(runtimeCargoToml, "utf8"));
    expect(Object.keys(runtimeManifest.dependencies).filter((name) => name === carrierName)).toEqual([carrierName]);
    expect(runtimeManifest.features["extension-earthdistance"]).toEqual([
      "extension-cube",
      `dep:${carrierName}`,
      ...aotSources.map((source) => `dep:${source.spec.name}`).sort(),
    ]);
    expect(runtimeManifest.features["extension-cube"]).toEqual([
      `dep:${carrierName}`,
      ...aotSources.map((source) => `dep:${source.spec.name}`).sort(),
    ]);
    expect(runtimeManifest.features["extension-hstore"]).toEqual([
      `dep:${carrierName}`,
      ...aotSources.map((source) => `dep:${source.spec.name}`).sort(),
    ]);

    const app = path.join(root, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(path.join(app, "Cargo.toml"), `[package]
name = "wasix-selection-proof"
version = "0.0.0"
edition = "2024"

[dependencies]
liboliphaunt-wasix-portable = { path = ${JSON.stringify(path.join(sources, runtimeName))}, features = ["extension-earthdistance"] }

[workspace]
`);
    writeFileSync(path.join(app, "src/main.rs"), `fn main() {
    let selected = liboliphaunt_wasix_portable::SELECTED_EXTENSION_SQL_NAMES;
    assert!(selected.contains(&"earthdistance"));
    assert!(selected.contains(&"cube"));
    assert!(!selected.contains(&"hstore"));
    assert!(liboliphaunt_wasix_portable::extension_archive("earthdistance").is_some());
    assert!(liboliphaunt_wasix_portable::extension_archive("cube").is_some());
    assert!(liboliphaunt_wasix_portable::extension_archive("hstore").is_none());
    assert!(liboliphaunt_wasix_portable::SELECTED_EXTENSION_AOT_SQL_NAMES.contains(&"earthdistance"));
    assert!(liboliphaunt_wasix_portable::SELECTED_EXTENSION_AOT_SQL_NAMES.contains(&"cube"));
    assert!(!liboliphaunt_wasix_portable::SELECTED_EXTENSION_AOT_SQL_NAMES.contains(&"hstore"));
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json("x86_64-unknown-linux-gnu", "earthdistance").is_some());
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json("x86_64-unknown-linux-gnu", "cube").is_some());
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json("x86_64-unknown-linux-gnu", "hstore").is_none());
}
`);
    run("cargo", ["run", "--offline", "--manifest-path", path.join(app, "Cargo.toml")], {
      env: { ...process.env, CARGO_TARGET_DIR: path.join(root, "cargo-target") },
    });

    const packages = JSON.parse(readFileSync(path.join(output, "packages.json"), "utf8")).packages;
    expect(packages.filter((row) => row.name.startsWith(`${carrierName}-part-`)).length).toBe(partNames.length);
    for (const target of Object.values(AOT_TARGET_TRIPLES)) {
      const parent = wasixExtensionAotPackageName("oliphaunt-extension-contrib-pg18", target);
      expect(packages.some((row) => row.name === parent)).toBe(true);
      expect(packages.some((row) => row.name === `${parent}-part-001`)).toBe(true);
    }
    expect(packages.every((row) => row.size <= 10 * 1024 * 1024)).toBe(true);
  });
});
