import { cargoDatabaseSmokeSource } from "./public-consumer-smoke.mjs";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  packageExtensionCargoFacades,
  renderUnsupportedNativeGuard,
  writeFacadeSource,
} from "./package-extension-cargo-facades.mjs";
import {
  extensionReleaseVersion,
  extensionRegistryPackageTargetSets,
} from "./release-artifact-targets.mjs";
import { loadGraph } from "./release-graph.mjs";
import { stageRustPackageSource } from "../../src/sdks/rust/tools/package-source.mjs";
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

function fakeCarrier(root, { name, version, header, members }) {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, "src"), { recursive: true });
  const links = `oliphaunt_artifact_fixture_${name.replaceAll("-", "_")}`;
  writeFileSync(path.join(directory, "Cargo.toml"), `[package]
name = ${JSON.stringify(name)}
version = ${JSON.stringify(version)}
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
  test("fails closed for unsupported native targets without a feature escape hatch", () => {
    const output = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-test-"));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(["oliphaunt-extension-pgtap"], output);
    const source = path.join(output, "sources/oliphaunt-extension-pgtap/src/lib.rs");
    const text = readFileSync(source, "utf8");
    expect(text).toContain("compile_error!");
    expect(text).not.toContain('feature = "native"');
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
    expect(unsupported.stderr).toContain("supports only");

    const wasixOnly = spawnSync("rustc", [
      "--crate-name", "oliphaunt_extension_pgtap",
      "--crate-type", "lib",
      "--edition", "2024",
      "--cfg", 'feature="wasix"',
      "--emit", "metadata",
      "-o", path.join(output, "wasix-only.rmeta"),
      forcedUnsupportedSource,
    ], { encoding: "utf8" });
    expect(wasixOnly.status).not.toBe(0);

    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, "utf8"));
    expect(manifest.features).toBeUndefined();
    expect(pkg.cratePath.endsWith(".crate")).toBe(true);
  });

  test("the native-owned contrib facade exposes every SQL member without WASIX carriers", () => {
    const output = mkdtempSync(path.join(import.meta.dir, "../../target/extension-facade-bundle-test-"));
    directories.push(output);
    const [pkg] = packageExtensionCargoFacades(["oliphaunt-extension-contrib-pg18"], output);
    const source = readFileSync(path.join(output, "sources/oliphaunt-extension-contrib-pg18/src/lib.rs"), "utf8");
    const manifest = Bun.TOML.parse(readFileSync(pkg.manifestPath, "utf8"));
    expect(source).toContain('"amcheck"');
    expect(source).toContain('"uuid-ossp"');
    expect(source).not.toContain("EXTENSION_SQL_NAME: &str");
    expect(manifest.package.version).toBe(extensionReleaseVersion(
      "oliphaunt-extension-contrib-pg18",
      "native",
      "package-extension-cargo-facades.test",
    ));
    expect(manifest.features).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["oliphaunt-resources"]);
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
    const graph = loadGraph("package-extension-cargo-facades.test");
    const nativeRuntimeVersion = graph.products["liboliphaunt-native"].version;
    const products = ["oliphaunt-extension-contrib-pg18", "oliphaunt-extension-vector"];
    const dependencyPaths = {
      oliphaunt: path.join(import.meta.dir, "../../src/sdks/rust"),
      "oliphaunt-resources": path.join(import.meta.dir, "../../src/sdks/rust/crates/oliphaunt-resources"),
      "oliphaunt-build": path.join(import.meta.dir, "../../src/sdks/rust/crates/oliphaunt-build"),
    };
    for (const product of products) {
      const productVersion = extensionReleaseVersion(
        product,
        "native",
        "package-extension-cargo-facades.test",
      );
      const targets = extensionRegistryPackageTargetSets(product, "extension-facade-integration");
      const nativeNames = targets.nativeCargoTargets.map((target) => [
        nativeExtensionCargoPackageName(product, target),
        targetTriples[target],
      ]);
      const wasixNames = product === "oliphaunt-extension-contrib-pg18"
        ? []
        : [
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
          ? `schema = "oliphaunt-artifact-manifest-v2"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}`
          : `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(productVersion)}\nkind = "extension"\ntarget = ${JSON.stringify(target)}\nruntime-product = "liboliphaunt-native"\nruntime-version = ${JSON.stringify(nativeRuntimeVersion)}\nextension = "vector"\ndependencies = []`;
        dependencyPaths[name] = fakeCarrier(leaves, { name, version: productVersion, header, members });
      }
      writeFacadeSource(product, generated, { dependencyPaths });
    }

    const genericCarrier = (name, product, version, kind, files) => fakeCarrier(leaves, {
      name,
      version,
      header: `schema = "oliphaunt-artifact-manifest-v1"\nproduct = ${JSON.stringify(product)}\nversion = ${JSON.stringify(version)}\nkind = ${JSON.stringify(kind)}\ntarget = ${JSON.stringify(host)}${kind === "native-runtime" ? '\ndirectories = ["cluster-seed/files/pg_notify", "cluster-seed/files/pg_wal/archive_status"]' : ""}`,
      members: [{ files: files.map((relative) => ({ relative, contents: relative.endsWith("/directories-v1.txt") ? "pg_notify\npg_wal/archive_status\n" : `${name}:${relative}` })) }],
    });
    const runtime = genericCarrier("fixture-native-runtime", "liboliphaunt-native", nativeRuntimeVersion, "native-runtime", [
      "runtime/bin/postgres", "runtime/bin/initdb", "runtime/bin/pg_ctl",
      "cluster-seed/manifest.properties", "cluster-seed/directories-v1.txt", "cluster-seed/files/PG_VERSION",
      "cluster-seed/files/global/pg_control",
    ]);
    const tools = genericCarrier("fixture-native-tools", "oliphaunt-tools", nativeRuntimeVersion, "native-tools", [
      "runtime/bin/pg_basebackup", "runtime/bin/pg_dump", "runtime/bin/psql",
    ]);
    const broker = genericCarrier("fixture-broker", "oliphaunt-broker", graph.products["oliphaunt-broker"].version, "broker-helper", [
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
runtime-version = ${JSON.stringify(nativeRuntimeVersion)}
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
    const cargo = spawnSync("cargo", ["check", "--target-dir", path.join(root, "cargo-target")], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(cargo.status, `${cargo.stdout}\n${cargo.stderr}`).toBe(0);
    const lock = findFile(path.join(root, "cargo-target"), "oliphaunt-assets.lock");
    expect(lock).not.toBeNull();
    for (const seed of ["cluster-seed"]) {
      expect(statSync(path.join(path.dirname(lock), "resources/native-runtime/liboliphaunt-native", seed, "files/pg_notify")).isDirectory()).toBe(true);
    }
    const text = readFileSync(lock, "utf8");
    expect(text).toContain('extension = "cube"');
    expect(text).toContain('extension = "pg_trgm"');
    expect(text).toContain('extension = "vector"');
    expect(text).not.toContain('extension = "hstore"');
    // The ordinary API needs only dependencies and imported descriptors.
    rmSync(path.join(app, "build.rs"));
    const sdk = path.join(root, "sdk");
    const sdkManifest = stageRustPackageSource(sdk);
    let sdkText = readFileSync(sdkManifest, "utf8");
    for (const name of ["oliphaunt-resources", "oliphaunt-build"]) {
      sdkText = sdkText.replace(new RegExp(`^${name} = .+$`, "m"), `${name} = { path = ${JSON.stringify(dependencyPaths[name])} }`);
    }
    const hostTarget = Object.entries(targetTriples).find(([, triple]) => triple === host)[0];
    const contribName = nativeExtensionCargoPackageName("oliphaunt-extension-contrib-pg18", hostTarget);
    sdkText = sdkText.replace("[dependencies]", `[dependencies]
fixture-native-runtime = { path = ${JSON.stringify(runtime)} }
fixture-broker = { path = ${JSON.stringify(broker)} }
${contribName} = { path = ${JSON.stringify(dependencyPaths[contribName])} }`);
    writeFileSync(sdkManifest, sdkText);
    writeFileSync(path.join(app, "Cargo.toml"), `[package]
name = "facade-app"
version = "0.0.0"
edition = "2024"
[dependencies]
oliphaunt = { path = ${JSON.stringify(sdk)} }
vector = { package = "oliphaunt-extension-vector", path = ${JSON.stringify(path.join(generated, "sources/oliphaunt-extension-vector"))} }
[workspace]
`);
    writeFileSync(path.join(app, "src/lib.rs"), `pub fn configured() -> oliphaunt::OliphauntBuilder {
      oliphaunt::Oliphaunt::builder().extensions([vector::VECTOR, oliphaunt::extensions::HSTORE])
    }\n`);
    writeFileSync(path.join(app, "src/main.rs"), cargoDatabaseSmokeSource().replace("use locked_entry::", "use oliphaunt::"));
    const plain = spawnSync("cargo", ["check", "--offline", "--target-dir", path.join(root, "cargo-target")], {
      cwd: app, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    expect(plain.status, `${plain.stdout}\n${plain.stderr}`).toBe(0);
    const buildRoot = path.join(root, "cargo-target/debug/build");
    const embedded = readdirSync(buildRoot)
      .filter(name => /^oliphaunt-[0-9a-f]+$/u.test(name))
      .map(name => findFile(path.join(buildRoot, name), "embedded_resources.rs"))
      .filter(file => file !== null)
      .map(file => readFileSync(file, "utf8"))
      .find(source => source.includes("native-runtime/liboliphaunt-native/"));
    expect(embedded).toContain("runtime/bin/postgres");
    expect(embedded).toContain("cluster-seed/files/pg_notify/");
    expect(embedded).toContain("extension/oliphaunt-extension-contrib-pg18/");
    expect(embedded).not.toContain("native-tools/");
    expect(embedded).not.toContain("extension/oliphaunt-extension-vector/");
  });
});
