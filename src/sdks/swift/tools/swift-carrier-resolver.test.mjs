#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  extractVerifiedZipArchive,
  localTarArchiveBinding,
  resolveSwiftCarrierSelection,
} from "./swift-carrier-resolver.mjs";

const sdk = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.argv[2] ?? path.join(sdk, ".build", "carrier-test"));
const generator = path.join(import.meta.dirname, "render-extension-products.mjs");
const schema = "oliphaunt-react-native-ios-carrier-v1";
const extensionCarrierSchema = "oliphaunt-swift-extension-carrier-v1";
const postgisNativeDependencies = [
  ["geos", "OliphauntNativeDependencyGeos"],
  ["geos-c", "OliphauntNativeDependencyGeosC"],
  ["json-c", "OliphauntNativeDependencyJsonC"],
  ["libxml2", "OliphauntNativeDependencyLibxml2"],
  ["proj", "OliphauntNativeDependencyProj"],
  ["sqlite", "OliphauntNativeDependencySqlite"],
];
const productionDependencyArchiveNames = new Map([
  ["geos", "libgeos.a"],
  ["geos-c", "libgeos_c.a"],
  ["json-c", "libjson-c.a"],
  ["libxml2", "libxml2.a"],
  ["proj", "libproj.a"],
  ["sqlite", "libsqlite3.a"],
]);
const frozenContent = new Map([
  ["pgtap", {
    dataFiles: [],
    extensionSqlFileNames: ["uninstall_pgtap.sql"],
    extensionSqlFilePrefixes: ["pgtap-core", "pgtap-schema"],
  }],
  ["postgis", {
    dataFiles: [
      "contrib/postgis-3.6/legacy.sql",
      "contrib/postgis-3.6/legacy_gist.sql",
      "contrib/postgis-3.6/legacy_minimal.sql",
      "contrib/postgis-3.6/postgis.sql",
      "contrib/postgis-3.6/postgis_upgrade.sql",
      "contrib/postgis-3.6/spatial_ref_sys.sql",
      "contrib/postgis-3.6/uninstall_legacy.sql",
      "contrib/postgis-3.6/uninstall_postgis.sql",
      "proj/proj.db",
    ],
    extensionSqlFileNames: ["uninstall_postgis.sql"],
    extensionSqlFilePrefixes: [
      "postgis_comments",
      "postgis_proc_set_search_path",
      "rtpostgis",
    ],
  }],
]);

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
function carrierize(rawExtensions) {
  const carriers = new Map();
  const extensions = rawExtensions.map((extensionRow) => ({
    ...extensionRow,
    assets: extensionRow.assets.map((raw) => {
      const envelope = {
        name: raw.name,
        url: raw.url,
        sha256: raw.sha256,
        bytes: raw.bytes,
        format: raw.format,
      };
      const existing = carriers.get(envelope.name);
      if (existing !== undefined) assert.deepEqual(existing, envelope);
      carriers.set(envelope.name, envelope);
      return {
        role: raw.role,
        carrier: envelope.name,
        path: ".",
        sha256: raw.sha256,
        bytes: raw.bytes,
        format: raw.format,
        member: raw.member,
      };
    }),
  }));
  return { carriers: [...carriers.values()].sort((left, right) => left.name.localeCompare(right.name)), extensions };
}
function setDirectExtensionAssets(document, sqlName, rawAssets) {
  const extensionRow = document.extensions.find((row) => row.sqlName === sqlName);
  assert.ok(extensionRow, `missing ${sqlName} fixture row`);
  const converted = carrierize([{ ...extensionRow, assets: rawAssets }]);
  extensionRow.assets = converted.extensions[0].assets;
  const referenced = new Set(document.extensions.flatMap((row) => row.assets.map(({ carrier }) => carrier)));
  const byName = new Map(document.carriers.filter(({ name }) => referenced.has(name)).map((row) => [row.name, row]));
  for (const row of converted.carriers) byName.set(row.name, row);
  document.carriers = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
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
async function craftedTar(archive, entries) {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const script = [
    "import io, json, sys, tarfile",
    "archive, encoded = sys.argv[1:]",
    "with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as output:",
    "  for row in json.loads(encoded):",
    "    info = tarfile.TarInfo(row['name'])",
    "    info.mode = 0o755 if row['type'] == 'directory' else 0o644",
    "    if row['type'] == 'directory': info.type = tarfile.DIRTYPE; output.addfile(info)",
    "    elif row['type'] == 'symlink': info.type = tarfile.SYMTYPE; info.linkname = 'target'; output.addfile(info)",
    "    else: data = b'fixture'; info.size = len(data); output.addfile(info, io.BytesIO(data))",
  ].join("\n");
  run("python3", ["-c", script, archive, JSON.stringify(entries)]);
}
async function removeTarDirectorySlash(archive, member) {
  const tar = gunzipSync(await fs.readFile(archive));
  let found = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const field = (start, length) => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${fullName}`);
    if (fullName === member) {
      assert.equal(String.fromCharCode(header[156]), "5", `${member} must be a directory header`);
      assert.equal(prefix, "", `${member} test helper only supports the ustar name field`);
      assert.ok(name.endsWith("/"), `${member} must initially use a canonical directory marker`);
      header[name.length - 1] = 0;
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((total, value) => total + value, 0);
      Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
      found = true;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(found, true, `missing tar directory ${member}`);
  await fs.writeFile(archive, gzipSync(tar, { mtime: 0 }));
}
async function addTarFileSlash(archive, member) {
  const tar = gunzipSync(await fs.readFile(archive));
  let found = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const end = header.subarray(0, 100).indexOf(0);
    const name = header.subarray(0, end < 0 ? 100 : end).toString("utf8");
    const sizeEnd = header.subarray(124, 136).indexOf(0);
    const size = Number.parseInt(
      header.subarray(124, sizeEnd < 0 ? 136 : 124 + sizeEnd).toString("utf8").trim() || "0",
      8,
    );
    if (name === member) {
      assert.equal(String.fromCharCode(header[156]), "0", `${member} must be a regular file header`);
      assert.ok(member.length < 99, `${member} must leave room for a slash`);
      header[member.length] = "/".charCodeAt(0);
      header[member.length + 1] = 0;
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((total, value) => total + value, 0);
      Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
      found = true;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(found, true, `missing tar file ${member}`);
  await fs.writeFile(archive, gzipSync(tar, { mtime: 0 }));
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
  const framework = path.join(archives, "liboliphaunt-0.1.0-apple-spm-xcframework.zip");
  await zipFramework("liboliphaunt.xcframework", framework);
  const runtimeSource = path.join(root, "base", "runtime", "oliphaunt");
  await fs.mkdir(runtimeSource, { recursive: true });
  await fs.writeFile(path.join(runtimeSource, "fixture.txt"), "runtime\n");
  const runtime = path.join(archives, "liboliphaunt-0.1.0-runtime-resources.tar.gz");
  run("tar", ["-czf", runtime, "-C", path.dirname(runtimeSource), path.basename(runtimeSource)]);
  const icuSource = path.join(root, "base", "icu", "share", "icu");
  await fs.mkdir(icuSource, { recursive: true });
  await fs.writeFile(path.join(icuSource, "icudt.dat"), "icu\n");
  const icu = path.join(archives, "liboliphaunt-0.1.0-icu-data.tar.gz");
  run("tar", ["-czf", icu, "-C", path.join(root, "base", "icu"), "share/icu"]);
  return {
    assets: [
      await asset("base-xcframework", framework, "zip", "liboliphaunt.xcframework"),
      await asset("runtime-resources", runtime, "tar.gz", "oliphaunt"),
      await asset("icu-data", icu, "tar.gz", "share/icu"),
    ],
    product: "liboliphaunt-native",
    tag: "liboliphaunt-native-v0.1.0",
    version: "0.1.0",
  };
}

async function productionExtensionResource(sqlName, stem, nativeDependencies) {
  const source = path.join(sdk, "Tests", "Fixtures", "swiftpm-extension-resources", sqlName);
  if (stem === null) return source;
  const stage = path.join(root, "production-extension-resources", sqlName);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.cp(source, stage, { recursive: true });
  const targets = ["ios-device", "ios-simulator"];
  const mobileStaticArchives = targets.map(
    (target) =>
      `${target}:mobile-static/${target}/extensions/${stem}/` +
      `liboliphaunt_extension_${stem}.a`,
  );
  const mobileStaticDependencyArchives = targets.flatMap((target) =>
    nativeDependencies.map((dependency) => {
      const archiveName = productionDependencyArchiveNames.get(dependency) ?? `lib${dependency}.a`;
      return `${target}:${dependency}:mobile-static/${target}/dependencies/${dependency}/${archiveName}`;
    }));
  if (nativeDependencies.includes("geos") && nativeDependencies.includes("geos-c")) {
    assert.notDeepEqual(
      mobileStaticDependencyArchives,
      [...mobileStaticDependencyArchives].sort(),
      "the production fixture must preserve structured order that differs from raw-string order",
    );
  }
  const manifestFile = path.join(stage, "manifest.properties");
  let manifest = await fs.readFile(manifestFile, "utf8");
  assert.ok(manifest.includes("mobileStaticArchives=\n"));
  assert.ok(manifest.includes("mobileStaticDependencyArchives=\n"));
  manifest = manifest
    .replace("mobileStaticArchives=\n", `mobileStaticArchives=${mobileStaticArchives.join(",")}\n`)
    .replace(
      "mobileStaticDependencyArchives=\n",
      `mobileStaticDependencyArchives=${mobileStaticDependencyArchives.join(",")}\n`,
    );
  await fs.writeFile(manifestFile, manifest);
  for (const row of [...mobileStaticArchives, ...mobileStaticDependencyArchives]) {
    const relative = row.slice(row.lastIndexOf(":") + 1);
    const archive = path.join(stage, ...relative.split("/"));
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, `static archive fixture for ${sqlName}\n`);
  }
  return stage;
}

async function extension(sqlName, stem, dependencies = [], nativeDependencies = []) {
  const resource = await productionExtensionResource(sqlName, stem, nativeDependencies);
  const runtime = path.join(root, "archives", `${sqlName}-runtime.tar.gz`);
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  run("tar", ["-czf", runtime, "-C", resource, "."]);
  if (sqlName === "cube") {
    // Reproduce the valid POSIX typeflag-5/no-trailing-slash carrier emitted by
    // the previous archive producer and rejected by the failed CI run.
    await removeTarDirectorySlash(runtime, "./files/");
  }
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
  const product = new Set(["cube", "earthdistance", "pg_trgm"]).has(sqlName)
    ? "oliphaunt-extension-contrib-pg18"
    : `oliphaunt-extension-${sqlName.replaceAll("_", "-")}`;
  const version = sqlName === "postgis" ? "3.6.1" : "1.0.0";
  const content = frozenContent.get(sqlName) ?? {
    dataFiles: [],
    extensionSqlFileNames: [],
    extensionSqlFilePrefixes: [],
  };
  return {
    product,
    version,
    tag: `${product}-v${version}`,
    sqlName,
    createsExtension: true,
    dataFiles: content.dataFiles,
    dependencies,
    extensionSqlFileNames: content.extensionSqlFileNames,
    extensionSqlFilePrefixes: content.extensionSqlFilePrefixes,
    nativeDependencies,
    nativeModuleStem: stem,
    sharedPreloadLibraries: [],
    registration: stem === null ? null : {
      magicSymbol: `${prefix}_Pg_magic_func`,
      initSymbol: null,
      symbols: sqlName === "postgis"
        ? [
            { name: "difference", address: `${prefix}_difference` },
            { name: "pg_finfo_difference", address: `pg_finfo_${prefix}_difference` },
          ]
        : [],
    },
    assets,
  };
}

async function rewrittenResourceArchive(sqlName, archiveName, replacements) {
  const source = path.join(sdk, "Tests", "Fixtures", "swiftpm-extension-resources", sqlName);
  const stage = path.join(root, "rewritten-resources", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(stage, { recursive: true, force: true });
  await fs.cp(source, stage, { recursive: true });
  const manifestFile = path.join(stage, "manifest.properties");
  let manifest = await fs.readFile(manifestFile, "utf8");
  for (const [expected, replacement] of replacements) {
    assert.ok(manifest.includes(expected), `resource fixture is missing ${expected}`);
    manifest = manifest.replace(expected, replacement);
  }
  await fs.writeFile(manifestFile, manifest);
  const archive = path.join(root, "archives", archiveName);
  run("tar", ["-czf", archive, "-C", stage, "."]);
  return archive;
}

async function contaminatedResourceArchive(sqlName, archiveName, relativePath) {
  const source = path.join(sdk, "Tests", "Fixtures", "swiftpm-extension-resources", sqlName);
  const stage = path.join(root, "contaminated-resources", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(stage, { recursive: true, force: true });
  await fs.cp(source, stage, { recursive: true });
  const injected = path.join(stage, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(injected), { recursive: true });
  await fs.writeFile(injected, "undeclared carrier contamination\n");
  const archive = path.join(root, "archives", archiveName);
  run("tar", ["-czf", archive, "-C", stage, "."]);
  return archive;
}

function dependencyReference(row) {
  return {
    product: row.product,
    sqlName: row.sqlName,
    tag: row.tag,
    version: row.version,
  };
}

function extensionReleaseCarrier(baseRow, release, extensionRows, availableExtensions, availableCarriers) {
  const carrierNames = new Set(extensionRows.flatMap((row) => row.assets.map(({ carrier }) => carrier)));
  return {
    schema: extensionCarrierSchema,
    release: {
      product: release.product,
      tag: release.tag,
      version: release.version,
    },
    base: {
      product: baseRow.product,
      tag: baseRow.tag,
      version: baseRow.version,
    },
    carriers: availableCarriers.filter(({ name }) => carrierNames.has(name)),
    entries: extensionRows.map((extensionRow) => ({
      dependencyCarriers: extensionRow.dependencies.map((sqlName) => {
        const dependency = availableExtensions.find((row) => row.sqlName === sqlName);
        assert.ok(dependency, `missing test dependency ${sqlName}`);
        return dependencyReference(dependency);
      }),
      extension: extensionRow,
    })),
  };
}

function extensionCarrier(baseRow, extensionRow, availableExtensions, availableCarriers) {
  return extensionReleaseCarrier(baseRow, extensionRow, [extensionRow], availableExtensions, availableCarriers);
}

async function nestExtensionCarrierPayloads(document, archiveName) {
  const stage = path.join(root, `aggregate-${archiveName}`);
  const carrierRoot = archiveName.replace(/\.tar\.gz$/u, "");
  await fs.rm(stage, { recursive: true, force: true });
  const byName = new Map(document.carriers.map((row) => [row.name, row]));
  for (const { extension: extensionRow } of document.entries) {
    for (const locator of extensionRow.assets) {
      assert.equal(locator.path, ".");
      const envelope = byName.get(locator.carrier);
      assert.ok(envelope, `missing envelope ${locator.carrier}`);
      const memberPath = `${carrierRoot}/extensions/${extensionRow.sqlName}/${envelope.name}`;
      const destination = path.join(stage, ...memberPath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(new URL(envelope.url), destination);
      locator.carrier = archiveName;
      locator.path = memberPath;
    }
  }
  const output = path.join(root, "archives", archiveName);
  await fs.mkdir(path.dirname(output), { recursive: true });
  run("tar", ["--format=ustar", "-czf", output, "-C", stage, carrierRoot]);
  document.carriers = [{
    name: archiveName,
    url: pathToFileURL(output).href,
    sha256: await checksum(output),
    bytes: (await fs.stat(output)).size,
    format: "tar.gz",
  }];
  return document;
}

async function main() {
  assert.deepEqual(
    localTarArchiveBinding("D:\\release\\bundle.tar.gz", path.win32),
    { archiveName: "bundle.tar.gz", cwd: "D:\\release" },
  );
  assert.ok(!localTarArchiveBinding("D:\\release\\bundle.tar.gz", path.win32).archiveName.includes(":"));
  await fs.rm(root, { force: true, recursive: true });
  await fs.mkdir(root, { recursive: true });
  const carrierized = carrierize([
    await extension("cube", "cube"),
    await extension("earthdistance", "earthdistance", ["cube"]),
    await extension("pgtap", null),
    await extension(
      "postgis",
      "postgis-3",
      [],
      postgisNativeDependencies.map(([name]) => name),
    ),
  ]);
  const manifest = {
    schema,
    base: await base(),
    carriers: carrierized.carriers,
    extensions: carrierized.extensions,
  };
  const carrier = path.join(root, "oliphaunt-react-native-ios-carriers.json");
  await fs.writeFile(carrier, `${JSON.stringify(manifest, null, 2)}\n`);

  // Independently versioned extension content is governed by its frozen
  // carrier row. A newer SDK catalog may change content metadata, but retains
  // authority only over the stable SQL-name -> release-product ownership.
  const frozenOldCarrier = structuredClone(manifest);
  frozenOldCarrier.extensions = frozenOldCarrier.extensions.filter(
    ({ sqlName }) => sqlName === "pgtap",
  );
  frozenOldCarrier.extensions[0].version = "0.9.0";
  frozenOldCarrier.extensions[0].tag = "oliphaunt-extension-pgtap-v0.9.0";
  const frozenCarrierNames = new Set(
    frozenOldCarrier.extensions[0].assets.map(({ carrier: name }) => name),
  );
  frozenOldCarrier.carriers = frozenOldCarrier.carriers.filter(
    ({ name }) => frozenCarrierNames.has(name),
  );
  const frozenOldCarrierFile = path.join(root, "pgtap-frozen-old-carrier.json");
  await fs.writeFile(frozenOldCarrierFile, `${JSON.stringify(frozenOldCarrier, null, 2)}\n`);
  const mutableNewCatalogFile = path.join(root, "mutable-new-swift-catalog.json");
  await fs.writeFile(mutableNewCatalogFile, `${JSON.stringify({
    consumer: "swift",
    extensions: [{
      "sql-name": "pgtap",
      "release-product": "oliphaunt-extension-pgtap",
      "creates-extension": false,
      "native-module-stem": "future_pgtap",
      "selected-extension-dependencies": ["cube"],
      "runtime-share-data-files": ["future/data.dat"],
      "extension-sql-file-names": ["future.sql"],
      "extension-sql-file-prefixes": ["future"],
      "shared-preload-libraries": ["future_preload"],
    }],
  }, null, 2)}\n`);
  const frozenOldSelection = await resolveSwiftCarrierSelection({
    allowFileUrls: true,
    basePackageVersion: "0.1.0",
    cacheDir: path.join(root, "frozen-old-cache"),
    carrierFile: frozenOldCarrierFile,
    extensions: ["pgtap"],
    ownerCatalogFile: mutableNewCatalogFile,
  });
  assert.equal(frozenOldSelection.extensions[0].version, "0.9.0");
  assert.deepEqual(frozenOldSelection.extensions[0].extensionSqlFileNames, [
    "uninstall_pgtap.sql",
  ]);
  const pgtapOverride = structuredClone(manifest.extensions.find(({ sqlName }) => sqlName === "pgtap"));
  pgtapOverride.version = "1.1.0";
  pgtapOverride.tag = `${pgtapOverride.product}-v${pgtapOverride.version}`;
  const pgtapCarrierDocument = extensionCarrier(
    manifest.base,
    pgtapOverride,
    manifest.extensions,
    manifest.carriers,
  );
  const pgtapCarrier = path.join(root, "pgtap-1.1.0-swift-ios-carrier.json");
  await fs.writeFile(pgtapCarrier, `${JSON.stringify(pgtapCarrierDocument, null, 2)}\n`);
  const verifiedBase = path.join(root, "verified-base-xcframework");
  const verifiedTree = await extractVerifiedZipArchive({
    archive: path.join(root, "archives", "liboliphaunt-0.1.0-apple-spm-xcframework.zip"),
    destination: verifiedBase,
  });
  assert.ok(verifiedTree.some(({ path: entry }) => entry === "liboliphaunt.xcframework/Info.plist"));
  const cache = path.join(root, "cache");
  const output = path.join(root, "selected");
  const common = [
    generator, "--carrier", carrier, "--extension-carrier", pgtapCarrier,
    "--extensions", "earthdistance,pgtap,postgis",
    "--cache-dir", cache, "--allow-file-urls", "--base-package-version", "0.1.0",
  ];
  run(process.execPath, [...common, "--output-dir", output]);
  assert.deepEqual(
    (await fs.readdir(output, { recursive: true })).filter((entry) => entry.endsWith(".a")),
    [],
    "carrier-resolved mobile static archives must not enter the generated Swift package",
  );
  const products = JSON.parse(await fs.readFile(path.join(output, "extension-products.json"), "utf8"));
  assert.deepEqual(products.nativeRuntime, {
    product: "liboliphaunt-native",
    version: "0.1.0",
  });
  assert.deepEqual(products.selected.map(({ sqlName }) => sqlName), ["cube", "earthdistance", "pgtap", "postgis"]);
  assert.equal(products.selected.find(({ sqlName }) => sqlName === "pgtap").version, "1.1.0");
  const selectedPostgis = products.selected.find(({ sqlName }) => sqlName === "postgis");
  assert.deepEqual(
    selectedPostgis.nativeDependencies.map(({ name, binaryTarget }) => [name, binaryTarget]),
    postgisNativeDependencies,
  );
  for (const [name, targetName] of postgisNativeDependencies) {
    assert.deepEqual(
      products.targets.find(({ name: candidate }) => candidate === targetName),
      {
        checksum: await checksum(path.join(root, "archives", `postgis-${name}.zip`)),
        kind: "binaryTarget",
        name: targetName,
        url: pathToFileURL(path.join(root, "archives", `postgis-${name}.zip`)).href,
      },
    );
  }
  assert.ok(products.targets.some(({ name }) => name === "OliphauntExtensionPostgisBinary"));
  assert.ok(!products.targets.some(({ name }) => name === "OliphauntExtensionPgtapBinary"));
  assert.deepEqual(
    products.targets.find(({ name }) => name === "COliphauntExtensionPostgis").dependencies
      .filter((dependency) => typeof dependency === "string"),
    [
      "OliphauntExtensionPostgisBinary",
      ...postgisNativeDependencies.map(([, targetName]) => targetName),
    ],
  );
  assert.match(await fs.readFile(path.join(output, "Package.swift"), "utf8"), /postgis-framework\.zip/u);

  const localOutput = path.join(root, "selected-local-binaries");
  run(process.execPath, [
    ...common,
    "--local-binary-targets",
    "--base-package-path", sdk,
    "--output-dir", localOutput,
  ]);
  const localPackage = await fs.readFile(path.join(localOutput, "Package.swift"), "utf8");
  assert.match(localPackage, /\.binaryTarget\([\s\S]*path: "Artifacts\/OliphauntExtensionPostgisBinary\.xcframework"/u);
  assert.match(
    localPackage,
    /name: "COliphauntExtensionPostgis"[\s\S]*linkerSettings: \[\.linkedLibrary\("c\+\+"\)\]/u,
  );
  assert.doesNotMatch(localPackage, /postgis-framework\.zip/u);
  for (const target of [
    "OliphauntExtensionCubeBinary",
    "OliphauntExtensionEarthdistanceBinary",
    "OliphauntExtensionPostgisBinary",
    ...postgisNativeDependencies.map(([, targetName]) => targetName),
  ]) {
    const artifact = path.join(localOutput, "Artifacts", `${target}.xcframework`, "Info.plist");
    assert.equal((await fs.stat(artifact)).isFile(), true, `missing copied local binary target ${target}`);
  }
  for (const [, targetName] of postgisNativeDependencies) {
    assert.match(
      localPackage,
      new RegExp(`\\.binaryTarget\\(\\s*name: "${targetName}",[\\s\\S]*?path: "Artifacts/${targetName}\\.xcframework"`, "u"),
    );
  }

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

  async function expectResourceManifestFailure(name, replacements, pattern, sqlName = "pgtap") {
    const archive = await rewrittenResourceArchive(
      sqlName,
      `${sqlName}-${name}.tar.gz`,
      replacements,
    );
    const candidate = structuredClone(manifest);
    setDirectExtensionAssets(candidate, sqlName, [
      await asset("runtime-resources", archive, "tar.gz", "."),
    ]);
    await expectCarrierFailure(name, candidate, sqlName, pattern);
  }

  async function expectExtensionCarrierFailure(name, candidates, selected, pattern) {
    const args = [generator, "--carrier", carrier];
    for (const [index, candidate] of candidates.entries()) {
      const file = path.join(root, `${name}-${index}-extension-carrier.json`);
      await fs.writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`);
      args.push("--extension-carrier", file);
    }
    args.push(
      "--extensions", selected,
      "--cache-dir", path.join(root, `${name}-cache`),
      "--allow-file-urls",
      "--base-package-version", "0.1.0",
      "--output-dir", path.join(root, `${name}-output`),
    );
    assert.match(run(process.execPath, args, { expectFailure: true }), pattern);
  }

  const contaminatedPgtapArchive = await contaminatedResourceArchive(
    "pgtap",
    "pgtap-recomputed-contaminated.tar.gz",
    "files/share/postgresql/extension/pgtap-core-evil.control",
  );
  const contaminatedPgtapCarrier = structuredClone(manifest);
  setDirectExtensionAssets(contaminatedPgtapCarrier, "pgtap", [
    await asset("runtime-resources", contaminatedPgtapArchive, "tar.gz", "."),
  ]);
  await expectCarrierFailure(
    "recomputed-contaminated-resource",
    contaminatedPgtapCarrier,
    "pgtap",
    /undeclared extension SQL\/control file.*pgtap-core-evil\.control/u,
  );

  const contribOverrideRelease = {
    product: "oliphaunt-extension-contrib-pg18",
    tag: "oliphaunt-extension-contrib-pg18-v1.1.0",
    version: "1.1.0",
  };
  const contribOverrideRows = ["cube", "earthdistance"].map((sqlName) => {
    const row = structuredClone(
      manifest.extensions.find((extensionRow) => extensionRow.sqlName === sqlName),
    );
    Object.assign(row, contribOverrideRelease);
    return row;
  });
  const earthdistanceCarrierDocument = extensionReleaseCarrier(
    manifest.base,
    contribOverrideRelease,
    contribOverrideRows,
    contribOverrideRows,
    manifest.carriers,
  );
  const earthdistanceCarrier = path.join(root, "earthdistance-1.1.0-swift-ios-carrier.json");
  await fs.writeFile(earthdistanceCarrier, `${JSON.stringify(earthdistanceCarrierDocument, null, 2)}\n`);
  const composedOutput = path.join(root, "dependency-composed");
  run(process.execPath, [
    generator, "--carrier", carrier, "--extension-carrier", earthdistanceCarrier,
    "--extensions", "earthdistance", "--cache-dir", path.join(root, "dependency-composed-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--output-dir", composedOutput,
  ]);
  const composedProducts = JSON.parse(await fs.readFile(path.join(composedOutput, "extension-products.json"), "utf8"));
  assert.deepEqual(composedProducts.selected.map(({ sqlName, version }) => [sqlName, version]), [
    ["cube", "1.1.0"],
    ["earthdistance", "1.1.0"],
  ]);

  const bundleRelease = {
    product: "oliphaunt-extension-contrib-pg18",
    tag: "oliphaunt-extension-contrib-pg18-v1.2.0",
    version: "1.2.0",
  };
  const bundleRows = ["cube", "earthdistance"].map((sqlName) => {
    const row = structuredClone(manifest.extensions.find((extensionRow) => extensionRow.sqlName === sqlName));
    Object.assign(row, bundleRelease);
    return row;
  });
  const pgTrgmRow = structuredClone(bundleRows.find(({ sqlName }) => sqlName === "cube"));
  pgTrgmRow.sqlName = "pg_trgm";
  pgTrgmRow.dependencies = [];
  bundleRows.push(pgTrgmRow);
  // ios-carrier-manifest.test.mjs proves that an extension-ci-artifacts-v2
  // aggregate becomes this checksum-bound carrier shape. This consumer-side
  // case proves partial selection and dependency closure from that aggregate.
  const bundleDocument = await nestExtensionCarrierPayloads(extensionReleaseCarrier(
    manifest.base,
    bundleRelease,
    bundleRows,
    bundleRows,
    manifest.carriers,
  ), "oliphaunt-extension-contrib-pg18-1.2.0-native-ios-xcframework-bundle.tar.gz");
  const bundleCarrier = path.join(root, "contrib-pg18-swift-ios-carrier.json");
  await fs.writeFile(bundleCarrier, `${JSON.stringify(bundleDocument, null, 2)}\n`);
  assert.equal(bundleDocument.schema, extensionCarrierSchema);
  assert.deepEqual(bundleDocument.entries.map(({ extension }) => extension.sqlName), [
    "cube",
    "earthdistance",
    "pg_trgm",
  ]);
  assert.deepEqual(bundleDocument.carriers.map(({ name }) => name), [
    "oliphaunt-extension-contrib-pg18-1.2.0-native-ios-xcframework-bundle.tar.gz",
  ]);
  assert.deepEqual(
    bundleDocument.entries.filter(({ extension }) => ["cube", "pg_trgm"].includes(extension.sqlName))
      .map(({ extension }) => [extension.product, extension.version, extension.tag]),
    [
      [bundleRelease.product, bundleRelease.version, bundleRelease.tag],
      [bundleRelease.product, bundleRelease.version, bundleRelease.tag],
    ],
  );
  const bundleOutput = path.join(root, "bundle-selected");
  run(process.execPath, [
    generator, "--carrier", carrier, "--extension-carrier", bundleCarrier,
    "--extensions", "earthdistance", "--cache-dir", path.join(root, "bundle-selected-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--output-dir", bundleOutput,
  ]);
  const bundleProducts = JSON.parse(await fs.readFile(path.join(bundleOutput, "extension-products.json"), "utf8"));
  assert.deepEqual(bundleProducts.selected.map(({ product, sqlName, version }) => [product, sqlName, version]), [
    ["oliphaunt-extension-contrib-pg18", "cube", "1.2.0"],
    ["oliphaunt-extension-contrib-pg18", "earthdistance", "1.2.0"],
  ]);
  assert.deepEqual(
    bundleProducts.targets.filter(({ kind }) => kind === "binaryTarget"),
    [
      {
        kind: "binaryTarget",
        name: "OliphauntExtensionCubeBinary",
        path: "Artifacts/OliphauntExtensionCubeBinary.xcframework",
      },
      {
        kind: "binaryTarget",
        name: "OliphauntExtensionEarthdistanceBinary",
        path: "Artifacts/OliphauntExtensionEarthdistanceBinary.xcframework",
      },
    ],
  );
  const bundlePackage = await fs.readFile(path.join(bundleOutput, "Package.swift"), "utf8");
  for (const sqlName of ["Cube", "Earthdistance"]) {
    const targetName = `OliphauntExtension${sqlName}Binary`;
    assert.match(
      bundlePackage,
      new RegExp(`path: "Artifacts/${targetName}\\.xcframework"`, "u"),
    );
    assert.equal(
      (await fs.stat(path.join(bundleOutput, "Artifacts", `${targetName}.xcframework`, "Info.plist"))).isFile(),
      true,
      `missing aggregate-carrier artifact for ${targetName}`,
    );
  }
  assert.doesNotMatch(
    bundlePackage,
    /url: .*contrib-pg18.*bundle/u,
  );

  const contribV1 = structuredClone(bundleDocument);
  contribV1.entries = contribV1.entries.filter(
    ({ extension }) => extension.sqlName === "cube",
  );
  const contribV2 = structuredClone(bundleDocument);
  contribV2.entries = contribV2.entries.filter(
    ({ extension }) => extension.sqlName === "pg_trgm",
  );
  contribV2.release.version = "1.3.0";
  contribV2.release.tag = `${contribV2.release.product}-v1.3.0`;
  contribV2.entries[0].extension.version = "1.3.0";
  contribV2.entries[0].extension.tag = contribV2.release.tag;
  await expectExtensionCarrierFailure(
    "same-owner-release-skew",
    [contribV1, contribV2],
    "cube,pg_trgm",
    /resolved selected extensions assigns inconsistent version\/tag identities to release owner oliphaunt-extension-contrib-pg18/u,
  );

  const incompatibleBase = structuredClone(pgtapCarrierDocument);
  incompatibleBase.base.version = "2.0.0";
  incompatibleBase.base.tag = "liboliphaunt-native-v2.0.0";
  await expectExtensionCarrierFailure("incompatible-base", [incompatibleBase], "pgtap", /requires liboliphaunt-native-v2\.0\.0.*provides liboliphaunt-native-v0\.1\.0/u);

  const fakeOwner = structuredClone(pgtapCarrierDocument);
  fakeOwner.release.product = "oliphaunt-extension-contrib-pg18";
  fakeOwner.release.tag = `oliphaunt-extension-contrib-pg18-v${fakeOwner.release.version}`;
  fakeOwner.entries[0].extension.product = fakeOwner.release.product;
  fakeOwner.entries[0].extension.tag = fakeOwner.release.tag;
  await expectExtensionCarrierFailure(
    "fake-independent-owner",
    [fakeOwner],
    "pgtap",
    /product must be canonical owner oliphaunt-extension-pgtap for pgtap/u,
  );

  const leadingZeroVersion = structuredClone(pgtapCarrierDocument);
  leadingZeroVersion.release.version = "01.1.0";
  leadingZeroVersion.release.tag = "oliphaunt-extension-pgtap-v01.1.0";
  leadingZeroVersion.entries[0].extension.version = "01.1.0";
  leadingZeroVersion.entries[0].extension.tag = "oliphaunt-extension-pgtap-v01.1.0";
  await expectExtensionCarrierFailure(
    "leading-zero-version",
    [leadingZeroVersion],
    "pgtap",
    /stable SemVer/u,
  );

  await expectExtensionCarrierFailure(
    "duplicate-explicit-row",
    [pgtapCarrierDocument, pgtapCarrierDocument],
    "pgtap",
    /repeat explicit row pgtap/u,
  );
  await expectExtensionCarrierFailure(
    "unused-explicit-row",
    [pgtapCarrierDocument],
    "postgis",
    /supplied no selected or required row/u,
  );

  const incompleteDependencyPins = structuredClone(earthdistanceCarrierDocument);
  incompleteDependencyPins.entries.find(
    ({ extension }) => extension.sqlName === "earthdistance",
  ).dependencyCarriers = [];
  await expectExtensionCarrierFailure(
    "incomplete-dependency-pins",
    [incompleteDependencyPins],
    "earthdistance",
    /must exactly pin earthdistance dependencies/u,
  );

  const omittedCanonicalDependency = structuredClone(earthdistanceCarrierDocument);
  const omittedEarthdistance = omittedCanonicalDependency.entries.find(
    ({ extension }) => extension.sqlName === "earthdistance",
  );
  omittedEarthdistance.extension.dependencies = [];
  omittedEarthdistance.dependencyCarriers = [];
  await expectExtensionCarrierFailure(
    "omitted-canonical-dependency",
    [omittedCanonicalDependency],
    "earthdistance",
    /manifest dependencies must be ""/u,
  );

  const substitutedCanonicalDependency = structuredClone(earthdistanceCarrierDocument);
  const substitutedEarthdistance = substitutedCanonicalDependency.entries.find(
    ({ extension }) => extension.sqlName === "earthdistance",
  );
  substitutedEarthdistance.extension.dependencies = ["pg_trgm"];
  substitutedEarthdistance.dependencyCarriers = [
    {
      product: "oliphaunt-extension-contrib-pg18",
      sqlName: "pg_trgm",
      tag: "oliphaunt-extension-contrib-pg18-v1.1.0",
      version: "1.1.0",
    },
  ];
  await expectExtensionCarrierFailure(
    "substituted-canonical-dependency",
    [substitutedCanonicalDependency],
    "earthdistance",
    /missing carrier for pg_trgm required by earthdistance/u,
  );

  const dependencySkewRelease = {
    product: "oliphaunt-extension-contrib-pg18",
    tag: "oliphaunt-extension-contrib-pg18-v2.0.0",
    version: "2.0.0",
  };
  const dependencySkewRows = ["cube", "earthdistance"].map((sqlName) => {
    const row = structuredClone(
      manifest.extensions.find((extensionRow) => extensionRow.sqlName === sqlName),
    );
    Object.assign(row, dependencySkewRelease);
    return row;
  });
  const dependencySkewEarthdistance = extensionReleaseCarrier(
    manifest.base,
    dependencySkewRelease,
    dependencySkewRows.filter(({ sqlName }) => sqlName === "earthdistance"),
    dependencySkewRows,
    manifest.carriers,
  );
  dependencySkewEarthdistance.entries[0].dependencyCarriers[0].version = "1.0.0";
  dependencySkewEarthdistance.entries[0].dependencyCarriers[0].tag =
    "oliphaunt-extension-contrib-pg18-v1.0.0";
  const dependencySkewCube = extensionReleaseCarrier(
    manifest.base,
    dependencySkewRelease,
    dependencySkewRows.filter(({ sqlName }) => sqlName === "cube"),
    dependencySkewRows,
    manifest.carriers,
  );
  await expectExtensionCarrierFailure(
    "dependency-version-skew",
    [dependencySkewEarthdistance, dependencySkewCube],
    "earthdistance",
    /earthdistance requires dependency carrier oliphaunt-extension-contrib-pg18-v1\.0\.0.*resolved oliphaunt-extension-contrib-pg18-v2\.0\.0/u,
  );

  const traversalArchive = path.join(root, "archives", "malicious-traversal.zip");
  await maliciousZip(traversalArchive, "../escaped-from-swift.txt", "file");
  const traversal = structuredClone(manifest);
  setDirectExtensionAssets(traversal, "pgtap", [
    await asset("runtime-resources", traversalArchive, "zip", "."),
  ]);
  await expectCarrierFailure("malicious-traversal", traversal, "pgtap", /unsafe/u);
  await assert.rejects(fs.access(path.join(root, "malicious-traversal-cache", "extracted", "escaped-from-swift.txt")));
  await assert.rejects(
    extractVerifiedZipArchive({
      archive: traversalArchive,
      destination: path.join(root, "direct-traversal-output"),
    }),
    /unsafe/u,
  );

  const symlinkArchive = path.join(root, "archives", "malicious-symlink.zip");
  await maliciousZip(symlinkArchive, "runtime-link", "symlink");
  const symlink = structuredClone(manifest);
  setDirectExtensionAssets(symlink, "pgtap", [
    await asset("runtime-resources", symlinkArchive, "zip", "."),
  ]);
  await expectCarrierFailure("malicious-symlink", symlink, "pgtap", /link or special entry/u);
  await assert.rejects(
    extractVerifiedZipArchive({
      archive: symlinkArchive,
      destination: path.join(root, "direct-symlink-output"),
    }),
    /link or special entry/u,
  );

  for (const [name, entries, pattern] of [
    ["tar-file-directory-marker", [{ name: "payload", type: "file" }], /member type\/path marker mismatch/u],
    ["tar-traversal", [{ name: "../payload", type: "file" }], /member is unsafe/u],
    ["tar-symlink", [{ name: "payload", type: "symlink" }], /link or special entry/u],
    ["tar-duplicate", [{ name: "payload", type: "file" }, { name: "payload", type: "file" }], /repeats a normalized archive member/u],
    ["tar-case-collision", [{ name: "Payload", type: "file" }, { name: "payload", type: "file" }], /case\/NFC-colliding paths/u],
    ["tar-non-nfc", [{ name: "cafe\u0301", type: "file" }], /must be canonical NFC/u],
    ["tar-file-as-parent", [{ name: "parent", type: "file" }, { name: "parent/child", type: "file" }], /uses file parent as an archive directory/u],
  ]) {
    const archive = path.join(root, "archives", `${name}.tar.gz`);
    await craftedTar(archive, entries);
    if (name === "tar-file-directory-marker") await addTarFileSlash(archive, "payload");
    const candidate = structuredClone(manifest);
    setDirectExtensionAssets(candidate, "pgtap", [
      await asset("runtime-resources", archive, "tar.gz", "."),
    ]);
    await expectCarrierFailure(name, candidate, "pgtap", pattern);
  }

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

  await expectResourceManifestFailure(
    "wrong-resource-native-runtime-version",
    [["nativeRuntimeVersion=0.1.0", "nativeRuntimeVersion=9.9.9"]],
    /manifest nativeRuntimeVersion must be "0\.1\.0"/u,
  );
  await expectResourceManifestFailure(
    "missing-resource-native-runtime-product",
    [["nativeRuntimeProduct=liboliphaunt-native\n", ""]],
    /exact canonical fields in canonical order/u,
  );
  await expectResourceManifestFailure(
    "missing-resource-native-runtime-version",
    [["nativeRuntimeVersion=0.1.0\n", ""]],
    /exact canonical fields in canonical order/u,
  );
  await expectResourceManifestFailure(
    "wrong-resource-native-runtime-product",
    [["nativeRuntimeProduct=liboliphaunt-native", "nativeRuntimeProduct=other-runtime"]],
    /manifest nativeRuntimeProduct must be "liboliphaunt-native"/u,
  );
  await expectResourceManifestFailure(
    "unknown-resource-manifest-field",
    [["nativeRuntimeVersion=0.1.0\n", "nativeRuntimeVersion=0.1.0\nunexpectedField=value\n"]],
    /exact canonical fields in canonical order/u,
  );
  await expectResourceManifestFailure(
    "missing-resource-canonical-field",
    [["nativeModuleFile=\n", ""]],
    /exact canonical fields in canonical order/u,
  );
  await expectResourceManifestFailure(
    "wrong-resource-native-module-file",
    [["nativeModuleFile=\n", "nativeModuleFile=other.dylib\n"]],
    /manifest nativeModuleFile must be ""/u,
  );
  await expectResourceManifestFailure(
    "wrong-resource-static-symbol-prefix",
    [["staticSymbolPrefix=\n", "staticSymbolPrefix=oliphaunt_static_other\n"]],
    /manifest staticSymbolPrefix must be ""/u,
  );
  await expectResourceManifestFailure(
    "wrong-resource-static-symbol-alias",
    [["staticSymbolAliases=\n", "staticSymbolAliases=sql_symbol:linked_symbol\n"]],
    /manifest staticSymbolAliases do not match carrier registration metadata/u,
  );

  const mismatchedCreatesExtension = structuredClone(manifest);
  mismatchedCreatesExtension.extensions.find(({ sqlName }) => sqlName === "pgtap").createsExtension = false;
  await expectCarrierFailure(
    "mismatched-creates-extension",
    mismatchedCreatesExtension,
    "pgtap",
    /manifest createsExtension must be "no"/u,
  );

  const duplicateName = structuredClone(manifest);
  duplicateName.carriers.push({ ...duplicateName.carriers[0], sha256: "0".repeat(64) });
  await expectCarrierFailure("duplicate-asset-name", duplicateName, "postgis", /repeats a carrier name/u);

  const duplicateIdentity = structuredClone(manifest);
  const duplicateIdentityPostgis = duplicateIdentity.extensions.find(({ sqlName }) => sqlName === "postgis");
  const geosAsset = duplicateIdentityPostgis.assets.find(({ role }) => role === "dependency-xcframework");
  const geosEnvelope = duplicateIdentity.carriers.find(({ name }) => name === geosAsset.carrier);
  const duplicateGeosArchive = path.join(root, "archives", "postgis-geos-duplicate.zip");
  await fs.copyFile(new URL(geosEnvelope.url), duplicateGeosArchive);
  const duplicateGeos = carrierize([{
    ...duplicateIdentityPostgis,
    assets: [await asset(
      "dependency-xcframework",
      duplicateGeosArchive,
      "zip",
      `nested/${path.posix.basename(geosAsset.member)}`,
    )],
  }]);
  duplicateIdentityPostgis.assets.push(duplicateGeos.extensions[0].assets[0]);
  duplicateIdentity.carriers.push(...duplicateGeos.carriers);
  duplicateIdentity.carriers.sort((left, right) => left.name.localeCompare(right.name));
  await expectCarrierFailure("duplicate-dependency-identity", duplicateIdentity, "postgis", /repeats a dependency carrier identity/u);

  const missingFile = path.join(root, "missing-dependency.json");
  const missingExtensions = manifest.extensions.filter(({ sqlName }) => sqlName === "earthdistance");
  const missingCarrierNames = new Set(missingExtensions.flatMap((row) => row.assets.map(({ carrier }) => carrier)));
  await fs.writeFile(missingFile, `${JSON.stringify({
    ...manifest,
    carriers: manifest.carriers.filter(({ name }) => missingCarrierNames.has(name)),
    extensions: missingExtensions,
  }, null, 2)}\n`);
  assert.match(run(process.execPath, [
    generator, "--carrier", missingFile, "--extensions", "earthdistance", "--cache-dir", path.join(root, "missing-cache"),
    "--allow-file-urls", "--base-package-version", "0.1.0", "--output-dir", path.join(root, "missing-output"),
  ], { expectFailure: true }), /missing carrier for cube required by earthdistance/u);

  const tampered = structuredClone(manifest);
  const tamperedAsset = tampered.extensions.find(({ sqlName }) => sqlName === "postgis").assets[0];
  tamperedAsset.sha256 = "0".repeat(64);
  tampered.carriers.find(({ name }) => name === tamperedAsset.carrier).sha256 = "0".repeat(64);
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
  const sqlOnly = carrierize([pgtap]);
  const sqlCarrier = path.join(root, "sql-only-carrier.json");
  await fs.writeFile(sqlCarrier, `${JSON.stringify({
    ...manifest,
    carriers: sqlOnly.carriers,
    extensions: sqlOnly.extensions,
  }, null, 2)}\n`);
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
