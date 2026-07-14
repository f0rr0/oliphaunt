#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const sdk = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.argv[2] ?? path.join(sdk, ".build", "carrier-test"));
const generator = path.join(import.meta.dirname, "render-extension-products.mjs");
const schema = "oliphaunt-react-native-ios-carrier-v1";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
    return `${result.stderr}${result.stdout}`;
  }
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
async function checksum(file) { return createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
async function asset(role, file, format, member) {
  return { role, name: path.basename(file), url: pathToFileURL(file).href, sha256: await checksum(file), bytes: (await fs.stat(file)).size, format, member };
}
async function maliciousZip(archive, entry, kind) {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const script = [
    "import stat, sys, zipfile",
    "archive, entry, kind = sys.argv[1:]",
    "info = zipfile.ZipInfo(entry)",
    "info.create_system = 3",
    "info.external_attr = ((stat.S_IFLNK | 0o777) if kind == 'symlink' else (stat.S_IFREG | 0o644)) << 16",
    "with zipfile.ZipFile(archive, 'w') as output: output.writestr(info, '../outside' if kind == 'symlink' else 'malicious')",
  ].join("\n");
  run("python3", ["-c", script, archive, entry, kind]);
}
async function zipFramework(name, archive) {
  const parent = path.join(root, "frameworks");
  await fs.mkdir(path.join(parent, name), { recursive: true });
  await fs.writeFile(path.join(parent, name, "Info.plist"), "<plist><dict/></plist>\n");
  run("zip", ["-qry", archive, name], { cwd: parent });
}
async function base() {
  const archives = path.join(root, "archives");
  await fs.mkdir(archives, { recursive: true });
  const framework = path.join(archives, "liboliphaunt-1.0.0-apple-spm-xcframework.zip");
  await zipFramework("liboliphaunt.xcframework", framework);
  const runtimeSource = path.join(root, "base", "runtime", "oliphaunt");
  await fs.mkdir(runtimeSource, { recursive: true });
  await fs.writeFile(path.join(runtimeSource, "fixture.txt"), "runtime\n");
  const runtime = path.join(archives, "liboliphaunt-1.0.0-runtime-resources.tar.gz");
  run("tar", ["-czf", runtime, "-C", path.dirname(runtimeSource), path.basename(runtimeSource)]);
  const icuSource = path.join(root, "base", "icu", "share", "icu");
  await fs.mkdir(icuSource, { recursive: true });
  await fs.writeFile(path.join(icuSource, "icudt.dat"), "icu\n");
  const icu = path.join(archives, "liboliphaunt-1.0.0-icu-data.tar.gz");
  run("tar", ["-czf", icu, "-C", path.join(root, "base", "icu"), "share/icu"]);
  return {
    assets: [
      await asset("base-xcframework", framework, "zip", "liboliphaunt.xcframework"),
      await asset("runtime-resources", runtime, "tar.gz", "oliphaunt"),
      await asset("icu-data", icu, "tar.gz", "share/icu"),
    ],
    product: "liboliphaunt-native",
    tag: "liboliphaunt-native-v1.0.0",
    version: "1.0.0",
  };
}
async function extension(sqlName, stem, dependencies = [], nativeDependencies = []) {
  const resource = path.join(sdk, "Tests", "Fixtures", "swiftpm-extension-resources", sqlName);
  const runtime = path.join(root, "archives", `${sqlName}-runtime.tar.gz`);
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  run("tar", ["-czf", runtime, "-C", resource, "."]);
  const assets = [await asset("runtime-resources", runtime, "tar.gz", ".")];
  if (stem !== null) {
    const frameworkName = `liboliphaunt_extension_${stem}.xcframework`;
    const archive = path.join(root, "archives", `${sqlName}-framework.zip`);
    await zipFramework(frameworkName, archive);
    assets.push(await asset("extension-xcframework", archive, "zip", frameworkName));
    for (const dependency of nativeDependencies) {
      const dependencyName = `liboliphaunt_dependency_${dependency}.xcframework`;
      const dependencyArchive = path.join(root, "archives", `${sqlName}-${dependency}.zip`);
      await zipFramework(dependencyName, dependencyArchive);
      assets.push(await asset("dependency-xcframework", dependencyArchive, "zip", dependencyName));
    }
  }
  const prefix = stem === null ? null : `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  const product = `oliphaunt-extension-${sqlName.replaceAll("_", "-")}`;
  const version = sqlName === "postgis" ? "3.6.1" : "1.0.0";
  return {
    product,
    version,
    tag: `${product}-v${version}`,
    sqlName,
    createsExtension: true,
    dependencies,
    nativeDependencies,
    nativeModuleStem: stem,
    sharedPreloadLibraries: [],
    registration: stem === null ? null : {
      magicSymbol: `${prefix}_Pg_magic_func`,
      initSymbol: null,
      symbols: [],
    },
    assets,
  };
}

async function main() {
  await fs.rm(root, { force: true, recursive: true });
  await fs.mkdir(root, { recursive: true });
  const manifest = {
    schema,
    base: await base(),
    extensions: [
      await extension("cube", "cube"),
      await extension("earthdistance", "earthdistance", ["cube"]),
      await extension("pgtap", null),
      await extension("postgis", "postgis-3", [], ["geos"]),
    ],
  };
  const carrier = path.join(root, "oliphaunt-react-native-ios-carriers.json");
  await fs.writeFile(carrier, `${JSON.stringify(manifest, null, 2)}\n`);
  const cache = path.join(root, "cache");
  const output = path.join(root, "selected");
  const common = [
    generator, "--carrier", carrier, "--extensions", "earthdistance,pgtap,postgis",
    "--cache-dir", cache, "--allow-file-urls", "--base-package-version", "0.1.0",
  ];
  run(process.execPath, [...common, "--output-dir", output]);
  const products = JSON.parse(await fs.readFile(path.join(output, "extension-products.json"), "utf8"));
  assert.deepEqual(products.selected.map(({ sqlName }) => sqlName), ["cube", "earthdistance", "pgtap", "postgis"]);
  assert.ok(products.targets.some(({ name }) => name === "OliphauntNativeDependencyGeos"));
  assert.ok(products.targets.some(({ name }) => name === "OliphauntExtensionPostgisBinary"));
  assert.ok(!products.targets.some(({ name }) => name === "OliphauntExtensionPgtapBinary"));
  assert.match(await fs.readFile(path.join(output, "Package.swift"), "utf8"), /postgis-framework\.zip/u);

  const pgtapRuntime = manifest.extensions.find(({ sqlName }) => sqlName === "pgtap").assets[0];
  const cachedPgtap = path.join(cache, "extracted", pgtapRuntime.sha256);
  await fs.writeFile(path.join(cachedPgtap, "manifest.properties"), "tampered-cache-entry\n");
  assert.equal((await fs.stat(`${cachedPgtap}.tree.json`)).isFile(), true);
  const offlineOutput = path.join(root, "offline");
  run(process.execPath, [...common, "--offline", "--output-dir", offlineOutput]);
  assert.doesNotMatch(await fs.readFile(path.join(cachedPgtap, "manifest.properties"), "utf8"), /tampered-cache-entry/u);
  run("diff", ["-ru", output, offlineOutput]);

  async function expectCarrierFailure(name, candidate, selected, pattern) {
    const file = path.join(root, `${name}.json`);
    await fs.writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`);
    const diagnostic = run(process.execPath, [
      generator, "--carrier", file, "--extensions", selected,
      "--cache-dir", path.join(root, `${name}-cache`), "--allow-file-urls",
      "--base-package-version", "0.1.0", "--output-dir", path.join(root, `${name}-output`),
    ], { expectFailure: true });
    assert.match(diagnostic, pattern);
  }

  const traversalArchive = path.join(root, "archives", "malicious-traversal.zip");
  await maliciousZip(traversalArchive, "../escaped-from-swift.txt", "file");
  const traversal = structuredClone(manifest);
  traversal.extensions.find(({ sqlName }) => sqlName === "pgtap").assets = [
    await asset("runtime-resources", traversalArchive, "zip", "."),
  ];
  await expectCarrierFailure("malicious-traversal", traversal, "pgtap", /unsafe/u);
  await assert.rejects(fs.access(path.join(root, "malicious-traversal-cache", "extracted", "escaped-from-swift.txt")));

  const symlinkArchive = path.join(root, "archives", "malicious-symlink.zip");
  await maliciousZip(symlinkArchive, "runtime-link", "symlink");
  const symlink = structuredClone(manifest);
  symlink.extensions.find(({ sqlName }) => sqlName === "pgtap").assets = [
    await asset("runtime-resources", symlinkArchive, "zip", "."),
  ];
  await expectCarrierFailure("malicious-symlink", symlink, "pgtap", /link or special entry/u);

  const unstable = structuredClone(manifest);
  unstable.base.version = "1.0.0-rc.1";
  unstable.base.tag = "liboliphaunt-native-v1.0.0-rc.1";
  await expectCarrierFailure("unstable-version", unstable, "pgtap", /stable SemVer/u);

  const wrongTag = structuredClone(manifest);
  wrongTag.extensions.find(({ sqlName }) => sqlName === "pgtap").tag = "unrelated-v1.0.0";
  await expectCarrierFailure("wrong-tag", wrongTag, "pgtap", /\.tag must be oliphaunt-extension-pgtap-v1\.0\.0/u);

  const malformedAssets = structuredClone(manifest);
  malformedAssets.base.assets = {};
  await expectCarrierFailure("malformed-assets", malformedAssets, "pgtap", /base\.assets must be an array/u);

  const malformedRegistration = structuredClone(manifest);
  malformedRegistration.extensions.find(({ sqlName }) => sqlName === "cube").registration.symbols = "not-an-array";
  await expectCarrierFailure("malformed-registration", malformedRegistration, "cube", /registration\.symbols must be an array/u);

  const duplicateName = structuredClone(manifest);
  const duplicateNamePostgis = duplicateName.extensions.find(({ sqlName }) => sqlName === "postgis");
  const duplicateNamePrimary = duplicateNamePostgis.assets.find(({ role }) => role === "extension-xcframework");
  const duplicateNameDependency = duplicateNamePostgis.assets.find(({ role }) => role === "dependency-xcframework");
  Object.assign(duplicateNameDependency, duplicateNamePrimary, {
    member: duplicateNameDependency.member,
    role: "dependency-xcframework",
  });
  await expectCarrierFailure("duplicate-asset-name", duplicateName, "postgis", /repeats an asset name/u);

  const duplicateIdentity = structuredClone(manifest);
  const duplicateIdentityPostgis = duplicateIdentity.extensions.find(({ sqlName }) => sqlName === "postgis");
  const geosAsset = duplicateIdentityPostgis.assets.find(({ role }) => role === "dependency-xcframework");
  const duplicateGeosArchive = path.join(root, "archives", "postgis-geos-duplicate.zip");
  await fs.copyFile(new URL(geosAsset.url), duplicateGeosArchive);
  duplicateIdentityPostgis.assets.push(
    await asset("dependency-xcframework", duplicateGeosArchive, "zip", `nested/${path.posix.basename(geosAsset.member)}`),
  );
  await expectCarrierFailure("duplicate-dependency-identity", duplicateIdentity, "postgis", /repeats a dependency carrier identity/u);

  const missingFile = path.join(root, "missing-dependency.json");
  await fs.writeFile(missingFile, `${JSON.stringify({
    ...manifest,
    extensions: manifest.extensions.filter(({ sqlName }) => sqlName === "earthdistance"),
  }, null, 2)}\n`);
  assert.match(run(process.execPath, [
    generator, "--carrier", missingFile, "--extensions", "earthdistance", "--cache-dir", path.join(root, "missing-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--output-dir", path.join(root, "missing-output"),
  ], { expectFailure: true }), /missing carrier for cube required by earthdistance/u);

  const tampered = structuredClone(manifest);
  tampered.extensions.find(({ sqlName }) => sqlName === "postgis").assets[0].sha256 = "0".repeat(64);
  const tamperedFile = path.join(root, "tampered.json");
  await fs.writeFile(tamperedFile, `${JSON.stringify(tampered, null, 2)}\n`);
  const diagnostic = run(process.execPath, [
    generator, "--carrier", tamperedFile, "--extensions", "postgis", "--cache-dir", path.join(root, "tampered-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--output-dir", path.join(root, "tampered-output"),
  ], { expectFailure: true });
  assert.match(diagnostic, /checksum mismatch/u);

  // Recreate only the SQL-only archive and leave a buildable consumer package
  // for check-sdk's clean Swift compile/link lane.
  const pgtap = await extension("pgtap", null);
  const sqlCarrier = path.join(root, "sql-only-carrier.json");
  await fs.writeFile(sqlCarrier, `${JSON.stringify({ ...manifest, extensions: [pgtap] }, null, 2)}\n`);
  const sqlOutput = path.join(root, "sql-only");
  run(process.execPath, [
    generator, "--carrier", sqlCarrier, "--extensions", "pgtap", "--cache-dir", path.join(root, "sql-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--base-package-path", sdk, "--output-dir", sqlOutput,
  ]);
  const sqlPackage = await fs.readFile(path.join(sqlOutput, "Package.swift"), "utf8");
  assert.doesNotMatch(sqlPackage, /binaryTarget/u);
  console.log(`swift-carrier-resolver.test.mjs: metadata, malicious ZIP, cache-tamper, and consumer checks passed; sql-only-package=${sqlOutput}`);
}

main().catch((error) => { console.error(error.stack ?? String(error)); process.exit(1); });
