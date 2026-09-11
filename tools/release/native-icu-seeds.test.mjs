import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitNativeIcuSeed, stageNativeIcuSeeds, nativeIcuSeedAsset } from "./native-icu-seeds.mjs";
import { filesystemTreeRows, logicalTreeSha256, NATIVE_PGDATA_DIRECTORIES, writeNativeSeedDirectories } from "./native-cluster-seed-contract.mjs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

test("optional native ICU carrier owns the matching seed and base retains only standard", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-icu-seeds-"));
  try {
    const target = "linux-x64-gnu";
    const data = path.join(root, "data");
    mkdirSync(data);
    writeFileSync(path.join(data, "icudt76l.dat"), "ICU fixture");
    const seed = path.join(root, "cluster-seed-icu");
    for (const directory of NATIVE_PGDATA_DIRECTORIES) {
      mkdirSync(path.join(seed, "files", directory), { recursive: true });
    }
    writeNativeSeedDirectories(seed);
    writeFileSync(path.join(seed, "files/PG_VERSION"), "18\n");
    writeFileSync(path.join(seed, "files/global/pg_control"), "fixture");
    const fixture = readFileSync(new URL("../../src/shared/cluster-seed-contract/fixtures/native-icu.valid.properties", import.meta.url), "utf8");
    writeFileSync(path.join(seed, "manifest.properties"), fixture
      .replace(/^target=.*$/mu, `target=${target}`)
      .replace(/^compatibilityKey=.*$/mu, `compatibilityKey=native-pg18-${target}-v1`)
      .replace(/^icuDataTreeSha256=.*$/mu, `icuDataTreeSha256=${logicalTreeSha256(filesystemTreeRows(data))}`));
    const output = path.join(root, nativeIcuSeedAsset("1.0.0", target));
    writeFileSync(path.join(root, "package-size.tsv"), "kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t-\t30\npackage\tcluster-seed-icu\t-\t-\t10\n");
    await splitNativeIcuSeed(root, data, target, output);
    expect(existsSync(seed)).toBe(false);
    expect(readFileSync(path.join(root, "package-size.tsv"), "utf8")).toContain("package\ttotal\t-\t-\t20");
    const destination = path.join(root, "optional");
    stageNativeIcuSeeds(root, "1.0.0", destination, data, [target]);
    expect(readFileSync(path.join(destination, target, "files/global/pg_control"), "utf8")).toBe("fixture");
    if (process.platform === "linux" && process.arch === "x64") {
      const repo = path.resolve(import.meta.dir, "../..");
      const crate = path.join(root, "icu-crate");
      cpSync(path.join(repo, "src/runtimes/liboliphaunt/icu"), crate, { recursive: true });
      const manifest = path.join(crate, "Cargo.toml");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace(
        'path = "../../../sdks/rust/crates/oliphaunt-resources"',
        `path = ${JSON.stringify(path.join(repo, "src/sdks/rust/crates/oliphaunt-resources"))}`,
      ));
      cpSync(destination, path.join(crate, "payload/native-seeds"), { recursive: true });
      const app = path.join(root, "app");
      mkdirSync(path.join(app, "src"), { recursive: true });
      writeFileSync(path.join(app, "Cargo.toml"), `[package]\nname = "optional-native-icu-proof"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\noliphaunt-icu = { path = ${JSON.stringify(crate)} }\n[build-dependencies]\noliphaunt-build = { path = ${JSON.stringify(path.join(repo, "src/sdks/rust/crates/oliphaunt-build"))} }\n[workspace]\n`);
      writeFileSync(path.join(app, "build.rs"), 'fn main() { oliphaunt_build::embed_resolved_artifacts().unwrap(); }');
      writeFileSync(path.join(app, "src/main.rs"), `fn main() {
    let files = oliphaunt_icu::ICU.resources;
    let embedded: &[(&str, &[u8], &str, bool)] = include!(concat!(env!("OUT_DIR"), "/embedded_resources.rs"));
    assert_eq!(files.len(), embedded.len());
    for resource in files { assert!(embedded.contains(resource), "missing {}", resource.0); }
    assert!(files.iter().any(|row| row.0 == "icu-data/oliphaunt-icu/native-seeds/linux-x64-gnu/files/global/pg_control" && row.1 == b"fixture"));
    assert!(files.iter().any(|row| row.0.ends_with("/share/icu/icudt76l.dat")));
    assert!(files.iter().any(|row| row.0.ends_with("/files/pg_wal/") && row.1.is_empty()));
    assert!(!files.iter().any(|row| row.0.contains("native-seeds/macos")));
}
`);
      const result = spawnSync("cargo", ["run", "--offline", "--manifest-path", path.join(app, "Cargo.toml")], {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OLIPHAUNT_ICU_DATA_DIR: data, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1", CARGO_TARGET_DIR: path.join(repo, "target/optional-native-icu-proof") },
      });
      expect(result.status, result.stderr).toBe(0);
    }
    writeFileSync(path.join(data, "icudt76l.dat"), "different ICU");
    expect(() => stageNativeIcuSeeds(root, "1.0.0", destination, data, [target])).toThrow("icuDataTreeSha256");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);


test("WASIX ICU uses its own runtime version and contains no native resources", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wasix-icu-version-"));
  const repo = path.resolve(import.meta.dir, "../..");
  try {
    const crate = path.join(root, "icu");
    cpSync(path.join(repo, "src/runtimes/liboliphaunt/wasix/crates/icu"), crate, { recursive: true });
    const manifest = path.join(crate, "Cargo.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8")
      .replace(/^version = "[^"]+"$/mu, 'version = "7.6.5"')
      .replace('path = "../../../../../sdks/rust/crates/oliphaunt-resources"', `path = ${JSON.stringify(path.join(repo, "src/sdks/rust/crates/oliphaunt-resources"))}`));
    mkdirSync(path.join(crate, "payload/cluster-seeds"), { recursive: true });
    writeFileSync(path.join(crate, "payload/icu-data.tar.zst"), "fixture ICU");
    writeFileSync(path.join(crate, "payload/cluster-seeds/icu.tar.zst"), "fixture seed");
    writeFileSync(path.join(crate, "payload/cluster-seeds/icu.json"), JSON.stringify({runtime: {version: "7.6.5"}, catalogProfile: "icu", icu: {dataTreeSha256: "a".repeat(64)}}));
    const app = path.join(root, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(path.join(app, "Cargo.toml"), `[package]\nname = "wasix-icu-version-proof"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\noliphaunt-wasix-icu = { path = ${JSON.stringify(crate)} }\n[workspace]\n`);
    writeFileSync(path.join(app, "src/main.rs"), `fn main() {
      let icu = oliphaunt_wasix_icu::ICU;
      assert_eq!(icu.runtime_version, "7.6.5");
      assert_eq!(icu.native_runtime_version, "unavailable");
      assert!(icu.resources.is_empty());
      assert_eq!(icu.wasix_archive.unwrap(), b"fixture ICU");
      assert_eq!(icu.wasix_seed_archive.unwrap(), b"fixture seed");
    }`);
    const result = spawnSync("cargo", ["run", "--offline", "--manifest-path", path.join(app, "Cargo.toml")], {
      cwd: repo, encoding: "utf8", env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1", CARGO_TARGET_DIR: path.join(repo, "target/optional-native-icu-proof") },
    });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
