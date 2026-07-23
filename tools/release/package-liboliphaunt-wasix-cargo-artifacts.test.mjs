#!/usr/bin/env bun
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { gzipSync, zstdCompressSync } from "node:zlib";

import { extensionSqlNames } from "./release-artifact-targets.mjs";
import {
  extractArchiveMemberToFile,
  extractTarZstd,
  injectRuntimeExtensionDependencies,
  validateRuntimePayload,
} from "./package_liboliphaunt_wasix_cargo_artifacts.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import {
  AOT_TARGET_TRIPLES,
  wasixExtensionAotPackageName,
} from "./wasix-cargo-artifact-contract.mjs";
import { canonicalWasixAotMetadata } from "./wasix-aot-manifest.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";

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

function supportedRustcHostTriple() {
  const { stdout } = run("rustc", ["--print", "host-tuple"]);
  const outputLines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (outputLines.length !== 1) {
    throw new Error(`rustc --print host-tuple returned unexpected output:\n${stdout}`);
  }
  const [hostTriple] = outputLines;
  const supportedTriples = [...new Set(Object.values(AOT_TARGET_TRIPLES))].sort();
  if (!supportedTriples.includes(hostTriple)) {
    throw new Error(
      `rustc host triple ${JSON.stringify(hostTriple)} is not a supported WASIX AOT target; expected one of ${supportedTriples.join(", ")}`,
    );
  }
  return hostTriple;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarOctal(value, length) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function adversarialTar(rows) {
  const records = [];
  for (const row of rows) {
    const data = Buffer.from(row.data ?? "");
    const header = Buffer.alloc(512);
    Buffer.from(row.name).copy(header, 0);
    tarOctal(row.mode ?? 0o644, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    tarOctal(data.length, 12).copy(header, 124);
    tarOctal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (row.type ?? "0").charCodeAt(0);
    if (row.link) Buffer.from(`${row.link}\0`).copy(header, 157);
    Buffer.from("ustar\0", "binary").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
    records.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...records, Buffer.alloc(1024)]);
}

function adversarialTarGz(rows) {
  return gzipSync(adversarialTar(rows), { mtime: 0 });
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
  writeFileSync(carrier, canonicalGzipSync(createDeterministicTar(stage, archiveRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  })));
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
      const raw = Buffer.concat(Array.from(
        { length: 64 },
        (_, index) => createHash("sha256").update(`${targetTriple}:${sqlName}:${index}`).digest(),
      ));
      const compressed = zstdCompressSync(raw);
      mkdirSync(directory, { recursive: true });
      writeFileSync(artifact, compressed);
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
          "raw-sha256": sha256Bytes(raw),
          "raw-size": raw.length,
          "module-sha256": sha256Bytes(Buffer.from(`module:${sqlName}`)),
          compressed: true,
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

  test("rejects duplicate and symlink carrier entries before materializing a member", () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-aggregate-adversarial-test-"));
    directories.push(root);

    const duplicate = path.join(root, "duplicate.tar.gz");
    writeFileSync(duplicate, adversarialTarGz([
      { name: "payload.bin", data: "first\n" },
      { name: "payload.bin", data: "second\n" },
    ]));
    const duplicateDestination = path.join(root, "duplicate-output.bin");
    expect(() => extractArchiveMemberToFile(duplicate, "payload.bin", duplicateDestination))
      .toThrow(/repeats archive member payload[.]bin/u);
    expect(() => statSync(duplicateDestination)).toThrow();

    const linked = path.join(root, "linked.tar.gz");
    writeFileSync(linked, adversarialTarGz([
      { name: "payload-link", type: "2", link: "payload.bin" },
    ]));
    const linkedDestination = path.join(root, "linked-output.bin");
    expect(() => extractArchiveMemberToFile(linked, "payload-link", linkedDestination))
      .toThrow(/link or special ustar entry/u);
    expect(() => statSync(linkedDestination)).toThrow();
  });

  test("direct tar.zst materialization preserves exact modes despite umask and read-only directories", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(path.join(ROOT, "target/wasix-materialization-mode-test-"));
    directories.push(root);
    const archive = path.join(root, "payload.tar.zst");
    const expected = Buffer.from("executable payload\n");
    writeFileSync(archive, zstdCompressSync(adversarialTar([
      { name: "payload/", type: "5", mode: 0o555 },
      { name: "payload/read-only/", type: "5", mode: 0o500 },
      { name: "payload/read-only/tool", mode: 0o751, data: expected },
    ])));

    const destination = path.join(root, "extracted");
    const previousUmask = process.umask(0o077);
    try {
      extractTarZstd(archive, destination);
    } finally {
      process.umask(previousUmask);
    }

    const payload = path.join(destination, "payload");
    const readOnly = path.join(payload, "read-only");
    const executable = path.join(readOnly, "tool");
    expect(statSync(payload).mode & 0o777).toBe(0o555);
    expect(statSync(readOnly).mode & 0o777).toBe(0o500);
    expect(statSync(executable).mode & 0o777).toBe(0o751);
    expect(readFileSync(executable)).toEqual(expected);

    // Restore cleanup access after proving the final archived modes.
    chmodSync(payload, 0o755);
    chmodSync(readOnly, 0o755);
  });

  test("package-side runtime validation binds the manifest to strict nested bytes", () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-runtime-validation-test-"));
    directories.push(root);
    const runtimeSource = path.join(root, "runtime-source", "oliphaunt");
    mkdirSync(path.join(runtimeSource, "bin"), { recursive: true });
    writeFileSync(path.join(runtimeSource, "bin/initdb"), "initdb\n");
    writeFileSync(path.join(runtimeSource, "bin/postgres"), "postgres\n");
    const runtimeBytes = zstdCompressSync(createDeterministicTar(runtimeSource, "oliphaunt", {
      fail(message) {
        throw new Error(message);
      },
      fixedFileMode: 0o644,
    }));

    const payload = path.join(root, "payload");
    mkdirSync(path.join(payload, "bin"), { recursive: true });
    mkdirSync(path.join(payload, "prepopulated"), { recursive: true });
    writeFileSync(path.join(payload, "bin/initdb.wasix.wasm"), "initdb-wasm\n");
    writeFileSync(path.join(payload, "prepopulated/pgdata-template.tar.zst"), "template\n");
    writeFileSync(path.join(payload, "prepopulated/pgdata-template.json"), "{}\n");
    writeFileSync(path.join(payload, "oliphaunt.wasix.tar.zst"), runtimeBytes);
    const manifestPath = path.join(payload, "manifest.json");
    const manifest = {
      runtime: {
        archive: "oliphaunt.wasix.tar.zst",
        sha256: sha256Bytes(runtimeBytes),
      },
      extensions: [],
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => validateRuntimePayload(payload)).not.toThrow();

    manifest.runtime.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => validateRuntimePayload(payload)).toThrow(/runtime[.]sha256 mismatch/u);

    const concatenated = Buffer.concat([runtimeBytes, runtimeBytes]);
    writeFileSync(path.join(payload, "oliphaunt.wasix.tar.zst"), concatenated);
    manifest.runtime.sha256 = sha256Bytes(concatenated);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => validateRuntimePayload(payload))
      .toThrow(/trailing data or multiple Zstandard frames/u);
  });

  test("extension packaging rejects AOT raw-digest tampering before Cargo packaging", () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-extension-aot-tamper-test-"));
    directories.push(root);
    const extensionRoot = aggregateFixture(root);
    const targetId = Object.keys(AOT_TARGET_TRIPLES).sort()[0];
    const manifestPath = path.join(
      extensionRoot,
      "wasix-aot",
      targetId,
      "cube",
      "manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.artifacts[0]["raw-sha256"] = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = spawnSync("bun", [
      "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
      "--extensions-only",
      "--extension-artifact-root", extensionRoot,
      "--output-dir", path.join(root, "output"),
      "--work-dir", path.join(root, "work"),
      "--version", "0.1.0",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/raw SHA-256 mismatch/u);
  });

  test("splits from part-001 and a single carrier feature selects earthdistance plus cube only", {
    timeout: 180_000,
  }, () => {
    const root = mkdtempSync(path.join(ROOT, "target/wasix-aggregate-cargo-test-"));
    directories.push(root);
    const extensionRoot = aggregateFixture(root);
    const output = path.join(root, "output");
    const work = path.join(root, "work");
    const cargoHome = path.join(root, "empty-cargo-home");
    mkdirSync(cargoHome);
    run("bun", [
      "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
      "--extensions-only",
      "--extension-artifact-root", extensionRoot,
      "--extension-part-bytes", "256",
      "--output-dir", output,
      "--work-dir", work,
      "--version", "0.1.0",
    ], {
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_NET_OFFLINE: "true",
      },
    });

    const sources = path.join(work, "cargo-package-sources");
    expect(statSync(path.join(work, "cargo-package-extracted")).isDirectory()).toBe(true);
    expect(statSync(path.join(work, "cargo-package-target")).isDirectory()).toBe(true);
    const carrierName = "oliphaunt-extension-contrib-pg18-wasix";
    const carrierManifest = Bun.TOML.parse(readFileSync(path.join(sources, carrierName, "Cargo.toml"), "utf8"));
    expect(carrierManifest["build-dependencies"].sha2).toBeUndefined();
    const carrierBuildScript = readFileSync(path.join(sources, carrierName, "build.rs"), "utf8");
    expect(carrierBuildScript).not.toContain("use sha2");
    expect(carrierBuildScript).toContain("fn sha256_compress");
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

    const hostTriple = supportedRustcHostTriple();
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
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json(${JSON.stringify(hostTriple)}, "earthdistance").is_some());
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json(${JSON.stringify(hostTriple)}, "cube").is_some());
    assert!(liboliphaunt_wasix_portable::extension_aot_manifest_json(${JSON.stringify(hostTriple)}, "hstore").is_none());
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
