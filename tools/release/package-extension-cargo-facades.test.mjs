import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  packageExtensionCargoFacades,
  renderUnsupportedNativeGuard,
  writeFacadeSource,
} from "./package-extension-cargo-facades.mjs";
import {
  extensionRegistryPackageTargetSets,
} from "./release-artifact-targets.mjs";
import {
  nativeExtensionCargoPackageName,
} from "./extension-registry-packages.mjs";
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

const directories = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fakeCarrier(root, { name, header, members }) {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, "src"), { recursive: true });
  const links = `oliphaunt_artifact_fixture_${name.replaceAll("-", "_")}`;
  writeFileSync(path.join(directory, "Cargo.toml"), `[package]
name = ${JSON.stringify(name)}
version = "0.0.0"
edition = "2024"
links = ${JSON.stringify(links)}
build = "build.rs"

[lib]
path = "src/lib.rs"

[workspace]
`);
  writeFileSync(path.join(directory, "src/lib.rs"), "#![forbid(unsafe_code)]\n");
  const lines = [
    "use std::env;",
    "use std::fs;",
    "use std::path::PathBuf;",
    "fn main() {",
    '  let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));',
    `  let mut manifest = ${JSON.stringify(`${header}\n`)}.to_owned();`,
  ];
  for (const [memberIndex, member] of members.entries()) {
    if (member.extension !== undefined) {
      lines.push(`  manifest.push_str(${JSON.stringify(`\n[[extensions]]\nextension = ${JSON.stringify(member.extension)}\ndependencies = ${JSON.stringify(member.dependencies ?? [])}\n`)});`);
    }
    for (const [fileIndex, file] of member.files.entries()) {
      const variable = `file_${memberIndex}_${fileIndex}`;
      lines.push(
        `  let ${variable} = out.join(${JSON.stringify(`payload/${member.extension ?? "root"}/${file.relative}`)});`,
        `  fs::create_dir_all(${variable}.parent().expect("parent")).expect("mkdir");`,
        `  fs::write(&${variable}, ${JSON.stringify(file.contents)}).expect("write payload");`,
        `  manifest.push_str(&format!(${JSON.stringify(`\n${member.extension === undefined ? "[[files]]" : "[[extensions.files]]"}\nsource = {:?}\nrelative = ${JSON.stringify(file.relative)}\nsha256 = ${JSON.stringify(sha256(file.contents))}\nexecutable = false\n`)}, ${variable}.display().to_string()));`,
      );
    }
  }
  lines.push(
    '  let path = out.join("oliphaunt-artifact.toml");',
    '  fs::write(&path, manifest).expect("write manifest");',
    '  println!("cargo::metadata=manifest={}", path.display());',
    "}",
  );
  writeFileSync(path.join(directory, "build.rs"), `${lines.join("\n")}\n`);
  return directory;
}

function findFile(root, basename) {
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry);
    if (statSync(candidate).isDirectory()) {
      const found = findFile(candidate, basename);
      if (found !== null) return found;
    } else if (entry === basename) {
      return candidate;
    }
  }
  return null;
}

describe("exact extension Cargo facade", () => {
  test("fails closed for unsupported default-native targets while WASIX opt-out compiles", () => {
    const output = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-test-"));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(["oliphaunt-extension-pgtap"], output);
    const source = path.join(output, "sources/oliphaunt-extension-pgtap/src/lib.rs");
    const text = readFileSync(source, "utf8");
    expect(text).toContain("compile_error!");
    expect(text).toContain("default-features = false");
    expect(text).toContain('feature = "native"');
    expect(text).toContain('target_env = "gnu"');
    expect(text).toContain('target_env = "msvc"');

    const forcedUnsupportedSource = path.join(output, "forced-unsupported.rs");
    writeFileSync(forcedUnsupportedSource, `#![forbid(unsafe_code)]
${renderUnsupportedNativeGuard("fixture-extension", ["fixture-unsupported"], ["any()"]) }
pub const FIXTURE: bool = true;
`);
    const unsupported = spawnSync("rustc", [
      "--crate-name", "oliphaunt_extension_pgtap",
      "--crate-type", "lib",
      "--edition", "2024",
      "--cfg", 'feature="native"',
      forcedUnsupportedSource,
    ], { encoding: "utf8" });
    expect(unsupported.status).not.toBe(0);
    expect(unsupported.stderr).toContain("default native feature supports only");

    const wasixOnly = spawnSync("rustc", [
      "--crate-name", "oliphaunt_extension_pgtap",
      "--crate-type", "lib",
      "--edition", "2024",
      "--cfg", 'feature="wasix"',
      "--emit", "metadata",
      "-o", path.join(output, "wasix-only.rmeta"),
      forcedUnsupportedSource,
    ], { encoding: "utf8" });
    expect(wasixOnly.status).toBe(0);

    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, "utf8"));
    expect(manifest.features.default).toEqual(["native"]);
    expect(manifest.features.wasix).toEqual([`dep:oliphaunt-extension-pgtap-wasix`]);
    expect(pkg.cratePath.endsWith(".crate")).toBe(true);
  });

  test("one contrib facade owns every exact SQL member and compact AOT dependencies", () => {
    const output = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-bundle-test-"));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(["oliphaunt-extension-contrib-pg18"], output);
    const source = readFileSync(path.join(output, "sources/oliphaunt-extension-contrib-pg18/src/lib.rs"), "utf8");
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, "utf8"));
    expect(source).toContain('"amcheck"');
    expect(source).toContain('"uuid-ossp"');
    expect(source).not.toContain("EXTENSION_SQL_NAME: &str");
    expect(manifest.features["wasix-aot-x86_64-pc-windows-msvc"]).toEqual([
      "dep:oliphaunt-extension-contrib-pg18-wasix",
      "dep:oliphaunt-extension-contrib-pg18-aot-windows-x64",
    ]);
    expect(Object.keys(manifest.dependencies)).toContain("oliphaunt-extension-contrib-pg18-aot-windows-x64");
  });

  test("real Cargo metadata relays exact bundle and external manifests into an app build", {
    timeout: 60_000,
  }, () => {
    const root = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-integration-"));
    directories.push(root);
    const leaves = path.join(root, "leaves");
    const generated = path.join(root, "generated");
    mkdirSync(leaves, { recursive: true });
    const rustcVersion = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
    expect(rustcVersion.status, rustcVersion.stderr).toBe(0);
    const host = rustcVersion.stdout.match(/^host: (.+)$/mu)?.[1];
    if (host === undefined) {
      throw new Error(`rustc -vV did not report a host target:\n${rustcVersion.stdout}`);
    }
    expect(host).toMatch(/^[A-Za-z0-9_+.]+(?:-[A-Za-z0-9_+.]+){2,3}$/u);
    const targetTriples = {
      "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
      "linux-x64-gnu": "x86_64-unknown-linux-gnu",
      "macos-arm64": "aarch64-apple-darwin",
      "windows-x64-msvc": "x86_64-pc-windows-msvc",
    };
    const products = ["oliphaunt-extension-contrib-pg18", "oliphaunt-extension-vector"];
    const dependencyPaths = {};
    for (const product of products) {
      const targets = extensionRegistryPackageTargetSets(product, "extension-facade-integration");
      const nativeNames = targets.nativeCargoTargets.map((target) => [
        nativeExtensionCargoPackageName(product, target),
        targetTriples[target],
      ]);
      const wasixNames = [
        [wasixExtensionPackageName(product), "portable"],
        ...expectedExtensionAotTargets().map((target) => [wasixExtensionAotPackageName(product, target), target]),
      ];
      for (const [name, target] of [...nativeNames, ...wasixNames]) {
        const bundled = product === "oliphaunt-extension-contrib-pg18";
        const members = bundled
          ? ["cube", "hstore", "pg_trgm"].map((extension) => ({
              extension,
              dependencies: [],
              files: [{
                relative: `share/postgresql/extension/${extension}.control`,
                contents: `${extension} fixture`,
              }],
            }))
          : [{
              files: [{
                relative: "share/postgresql/extension/vector.control",
                contents: "vector fixture",
              }],
            }];
        const header = bundled
          ? `schema = "oliphaunt-artifact-manifest-v2"\nproduct = ${JSON.stringify(product)}\nversion = "0.0.0"\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = "0.0.0"`
          : `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = "0.0.0"\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = "0.0.0"\nextension = "vector"\ndependencies = []`;
        dependencyPaths[name] = fakeCarrier(leaves, { name, header, members });
      }
      writeFacadeSource(product, generated, { dependencyPaths });
    }

    const genericCarrier = (name, product, kind, files) => fakeCarrier(leaves, {
      name,
      header: `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = "0.0.0"\nkind = ${JSON.stringify(kind)}\ntarget = ${JSON.stringify(host)}`,
      members: [{ files: files.map((relative) => ({ relative, contents: `${name}:${relative}` })) }],
    });
    const runtime = genericCarrier("fixture-native-runtime", "liboliphaunt-native", "native-runtime", [
      "runtime/bin/postgres", "runtime/bin/initdb", "runtime/bin/pg_ctl",
    ]);
    const tools = genericCarrier("fixture-native-tools", "oliphaunt-tools", "native-tools", [
      "runtime/bin/pg_dump", "runtime/bin/psql",
    ]);
    const broker = genericCarrier("fixture-broker", "oliphaunt-broker", "broker-helper", [
      "bin/oliphaunt-broker",
    ]);
    const app = path.join(root, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(path.join(app, "src/lib.rs"), "#![forbid(unsafe_code)]\n");
    writeFileSync(path.join(app, "build.rs"), "fn main() { oliphaunt_build::configure(); }\n");
    writeFileSync(path.join(app, "Cargo.toml"), `[package]
name = "facade-app"
version = "0.0.0"
edition = "2024"
build = "build.rs"

[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.0.0"
extensions = ["cube", "pg_trgm", "vector"]

[dependencies]
contrib = { package = "oliphaunt-extension-contrib-pg18", path = ${JSON.stringify(path.join(generated, "sources/oliphaunt-extension-contrib-pg18"))} }
vector = { package = "oliphaunt-extension-vector", path = ${JSON.stringify(path.join(generated, "sources/oliphaunt-extension-vector"))} }
fixture-native-runtime = { path = ${JSON.stringify(runtime)} }
fixture-native-tools = { path = ${JSON.stringify(tools)} }
fixture-broker = { path = ${JSON.stringify(broker)} }

[build-dependencies]
oliphaunt-build = { path = ${JSON.stringify(path.join(import.meta.dir, "../../src/sdks/rust/crates/oliphaunt-build"))} }

[workspace]
`);
    const cargo = spawnSync("cargo", ["check", "--offline", "--target-dir", path.join(root, "cargo-target")], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(cargo.status, `${cargo.stdout}\n${cargo.stderr}`).toBe(0);
    const lock = findFile(path.join(root, "cargo-target"), "oliphaunt-assets.lock");
    expect(lock).not.toBeNull();
    const text = readFileSync(lock, "utf8");
    expect(text).toContain('extension = "cube"');
    expect(text).toContain('extension = "pg_trgm"');
    expect(text).toContain('extension = "vector"');
    expect(text).not.toContain('extension = "hstore"');
  });
});
