#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { stageIosApp } from "./stage-ios-app.mjs";

const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
}

async function write(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function asset(role, file, format, member) {
  const stat = await fs.stat(file);
  return {
    bytes: stat.size,
    format,
    member,
    name: path.basename(file),
    role,
    sha256: await sha256(file),
    url: pathToFileURL(file).href,
  };
}

async function tarDirectory(source, archive, member = ".") {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  run("tar", ["-czf", archive, "-C", source, member]);
}

async function zipMember(sourceParent, member, archive) {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  run("zip", ["-qry", archive, member], sourceParent);
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

async function baseAssets(root) {
  const source = path.join(root, "source", "base");
  const runtime = path.join(source, "runtime", "oliphaunt");
  await write(
    path.join(runtime, "runtime", "manifest.properties"),
    [
      "schema=oliphaunt-runtime-resources-v1",
      "cacheKey=fixture-base",
      "layout=postgres-runtime-files-v1",
      "source=fixture",
      "extensions=",
      "runtimeFeatures=",
      "sharedPreloadLibraries=",
      "mobileStaticRegistryState=not-required",
      "mobileStaticRegistryRegistered=",
      "mobileStaticRegistryPending=",
      "nativeModuleStems=",
      "mobileStaticRegistrySource=",
      "",
    ].join("\n"),
  );
  await write(
    path.join(runtime, "template-pgdata", "manifest.properties"),
    [
      "schema=oliphaunt-runtime-resources-v1",
      "cacheKey=fixture-template",
      "layout=postgres-template-pgdata-v1",
      "source=fixture",
      "extensions=",
      "runtimeFeatures=",
      "sharedPreloadLibraries=",
      "mobileStaticRegistryState=not-required",
      "mobileStaticRegistryRegistered=",
      "mobileStaticRegistryPending=",
      "nativeModuleStems=",
      "mobileStaticRegistrySource=",
      "",
    ].join("\n"),
  );
  await write(path.join(runtime, "runtime", "files", "share", "postgresql", "postgres.bki"), "base\n");
  await write(path.join(runtime, "template-pgdata", "files", "base", "PG_VERSION"), "18\n");
  await write(
    path.join(runtime, "package-size.tsv"),
    "kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t2\t8\n",
  );

  const baseFramework = path.join(source, "framework", "liboliphaunt.xcframework");
  await write(path.join(baseFramework, "Info.plist"), "<plist><dict/></plist>\n");
  const icu = path.join(source, "icu", "share", "icu");
  await write(path.join(icu, "icudt77l.dat"), "fixture icu\n");

  const archiveRoot = path.join(root, "archives");
  const runtimeArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-runtime-resources.tar.gz");
  const frameworkArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-apple-spm-xcframework.zip");
  const icuArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-icu-data.tar.gz");
  await tarDirectory(path.dirname(runtime), runtimeArchive, path.basename(runtime));
  await zipMember(path.dirname(baseFramework), path.basename(baseFramework), frameworkArchive);
  await tarDirectory(path.join(source, "icu"), icuArchive, "share/icu");
  return [
    await asset("base-xcframework", frameworkArchive, "zip", "liboliphaunt.xcframework"),
    await asset("runtime-resources", runtimeArchive, "tar.gz", "oliphaunt"),
    await asset("icu-data", icuArchive, "tar.gz", "share/icu"),
  ];
}

async function extensionRow(root, config) {
  const source = path.join(root, "source", "extensions", config.sqlName, "runtime");
  await write(
    path.join(source, "manifest.properties"),
    [
      "packageLayout=oliphaunt-extension-artifact-v1",
      "pgMajor=18",
      `sqlName=${config.sqlName}`,
      "createsExtension=yes",
      `dependencies=${config.dependencies.join(",")}`,
      `nativeModuleStem=${config.nativeModuleStem ?? ""}`,
      "sharedPreloadLibraries=",
      "mobilePrebuilt=yes",
      "files=files",
      "",
    ].join("\n"),
  );
  await write(
    path.join(source, "files", "share", "postgresql", "extension", `${config.sqlName}.control`),
    `comment = '${config.sqlName} fixture'\n`,
  );
  await write(
    path.join(source, "files", "share", "postgresql", "extension", `${config.sqlName}--1.0.sql`),
    `select '${config.sqlName}';\n`,
  );
  const archiveRoot = path.join(root, "archives");
  const runtimeArchive = path.join(
    archiveRoot,
    `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}-1.0.0-native-ios-runtime.tar.gz`,
  );
  await tarDirectory(source, runtimeArchive);
  const assets = [await asset("runtime-resources", runtimeArchive, "tar.gz", ".")];
  if (config.nativeModuleStem !== null) {
    const framework = path.join(
      root,
      "source",
      "extensions",
      config.sqlName,
      `liboliphaunt_extension_${config.nativeModuleStem}.xcframework`,
    );
    await write(path.join(framework, "Info.plist"), "<plist><dict/></plist>\n");
    const frameworkArchive = path.join(
      archiveRoot,
      `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}-1.0.0-native-ios-xcframework.zip`,
    );
    await zipMember(path.dirname(framework), path.basename(framework), frameworkArchive);
    assets.push(await asset("extension-xcframework", frameworkArchive, "zip", path.basename(framework)));
    for (const dependency of config.nativeDependencies) {
      const dependencyFramework = path.join(
        root,
        "source",
        "extensions",
        config.sqlName,
        `liboliphaunt_dependency_${dependency}.xcframework`,
      );
      await write(path.join(dependencyFramework, "Info.plist"), "<plist><dict/></plist>\n");
      const dependencyArchive = path.join(
        archiveRoot,
        `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}-1.0.0-native-ios-dependency-${dependency}.zip`,
      );
      await zipMember(path.dirname(dependencyFramework), path.basename(dependencyFramework), dependencyArchive);
      assets.push(
        await asset(
          "dependency-xcframework",
          dependencyArchive,
          "zip",
          path.basename(dependencyFramework),
        ),
      );
    }
  }
  return {
    assets,
    createsExtension: true,
    dependencies: config.dependencies,
    nativeDependencies: config.nativeDependencies,
    nativeModuleStem: config.nativeModuleStem,
    product: `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}`,
    registration: config.nativeModuleStem === null
      ? null
      : {
          initSymbol: null,
          magicSymbol: `oliphaunt_static_${config.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}_Pg_magic_func`,
          symbols: [],
        },
    sharedPreloadLibraries: [],
    sqlName: config.sqlName,
    tag: `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}-v1.0.0`,
    version: "1.0.0",
  };
}

async function createFixture(root) {
  const base = {
    assets: await baseAssets(root),
    product: "liboliphaunt-native",
    tag: "liboliphaunt-native-v1.0.0",
    version: "1.0.0",
  };
  const extensions = [];
  for (const config of [
    { sqlName: "cube", dependencies: [], nativeModuleStem: "cube", nativeDependencies: [] },
    { sqlName: "earthdistance", dependencies: ["cube"], nativeModuleStem: null, nativeDependencies: [] },
    { sqlName: "pgtap", dependencies: [], nativeModuleStem: null, nativeDependencies: [] },
    { sqlName: "postgis", dependencies: [], nativeModuleStem: "postgis-3", nativeDependencies: ["geos"] },
  ]) {
    extensions.push(await extensionRow(root, config));
  }
  const carrier = { base, extensions, schema: SCHEMA };
  const carrierFile = path.join(root, "oliphaunt-react-native-ios-carriers.json");
  await write(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`);
  return { carrier, carrierFile };
}

async function expectReject(action, pattern) {
  let error;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected action to reject");
  assert.match(error.message, pattern);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oliphaunt-rn-ios-carrier-"));
  try {
    const { carrier, carrierFile } = await createFixture(root);
    const output = path.join(root, "consumer", "ios", "oliphaunt");
    const cache = path.join(root, "cache");
    const requested = ["earthdistance", "pgtap", "postgis"];
    const result = await stageIosApp({
      allowFileUrls: true,
      cacheDir: cache,
      carriers: [carrierFile],
      extensions: requested,
      icu: true,
      outputDir: output,
    });
    assert.deepEqual(result.selected, ["cube", "earthdistance", "pgtap", "postgis"]);
    run(
      process.execPath,
      [path.join(import.meta.dirname, "verify-ios-package.mjs"), "--payload-dir", output],
    );

    const frameworkNames = (await fs.readdir(path.join(output, "frameworks", "extensions"))).sort();
    assert.deepEqual(frameworkNames, [
      "liboliphaunt_dependency_geos.xcframework",
      "liboliphaunt_extension_cube.xcframework",
      "liboliphaunt_extension_postgis-3.xcframework",
    ]);
    assert.equal(
      await fs.readFile(
        path.join(output, "resources", "OliphauntReactNativeResources.bundle", "oliphaunt", "runtime", "files", "share", "icu", "icudt77l.dat"),
        "utf8",
      ),
      "fixture icu\n",
    );
    await fs.access(
      path.join(output, "resources", "OliphauntReactNativeResources.bundle", "oliphaunt", "runtime", "files", "share", "postgresql", "extension", "pgtap.control"),
    );
    await assert.rejects(
      fs.access(path.join(output, "frameworks", "extensions", "liboliphaunt_extension_pgtap.xcframework")),
    );
    const registry = await fs.readFile(
      path.join(output, "generated", "static-registry", "oliphaunt_static_registry.c"),
      "utf8",
    );
    assert.doesNotMatch(registry, /symbols\[\]\s*=\s*\{\s*\}/u);
    assert.match(registry, /\.symbols = NULL,/u);
    assert.match(registry, /\.name = "postgis-3"/u);

    const selection = JSON.parse(await fs.readFile(path.join(output, "selection.json"), "utf8"));
    assert.equal(selection.icu, true);
    assert.deepEqual(selection.requestedExtensions, [...requested].sort());
    assert.deepEqual(selection.extensions.map(({ sqlName }) => sqlName), result.selected);

    const baseRuntime = carrier.base.assets.find(({ role }) => role === "runtime-resources");
    const cachedBase = path.join(cache, "extracted", baseRuntime.sha256);
    await fs.writeFile(
      path.join(cachedBase, "oliphaunt", "runtime", "manifest.properties"),
      "tampered-cache-entry\n",
    );
    assert.equal((await fs.stat(`${cachedBase}.tree.json`)).isFile(), true);
    const recoveredOutput = path.join(root, "consumer-recovered", "ios", "oliphaunt");
    await stageIosApp({
      allowFileUrls: true,
      cacheDir: cache,
      carriers: [carrierFile],
      extensions: requested,
      icu: true,
      outputDir: recoveredOutput,
    });
    assert.doesNotMatch(
      await fs.readFile(path.join(cachedBase, "oliphaunt", "runtime", "manifest.properties"), "utf8"),
      /tampered-cache-entry/u,
    );
    run("diff", ["-ru", output, recoveredOutput]);

    async function expectCarrierFailure(name, candidate, extensions, pattern) {
      const file = path.join(root, `${name}.json`);
      await write(file, `${JSON.stringify(candidate, null, 2)}\n`);
      await expectReject(
        () => stageIosApp({
          allowFileUrls: true,
          cacheDir: path.join(root, `${name}-cache`),
          carriers: [file],
          extensions,
          outputDir: path.join(root, `${name}-output`),
        }),
        pattern,
      );
    }

    const traversalArchive = path.join(root, "archives", "malicious-traversal.zip");
    await maliciousZip(traversalArchive, "../escaped-from-rn.txt", "file");
    const traversal = structuredClone(carrier);
    traversal.base.assets = await Promise.all(traversal.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", traversalArchive, "zip", "liboliphaunt.xcframework")
      : row));
    await expectCarrierFailure("malicious-traversal", traversal, [], /not a safe archive-relative path/u);
    await assert.rejects(fs.access(path.join(root, "malicious-traversal-cache", "extracted", "escaped-from-rn.txt")));

    const symlinkArchive = path.join(root, "archives", "malicious-symlink.zip");
    await maliciousZip(symlinkArchive, "liboliphaunt.xcframework", "symlink");
    const symlink = structuredClone(carrier);
    symlink.base.assets = await Promise.all(symlink.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", symlinkArchive, "zip", "liboliphaunt.xcframework")
      : row));
    await expectCarrierFailure("malicious-symlink", symlink, [], /link or special entry/u);

    const unstable = structuredClone(carrier);
    unstable.base.version = "1.0.0-rc.1";
    unstable.base.tag = "liboliphaunt-native-v1.0.0-rc.1";
    await expectCarrierFailure("unstable-version", unstable, [], /stable SemVer/u);

    const wrongTag = structuredClone(carrier);
    wrongTag.extensions.find(({ sqlName }) => sqlName === "pgtap").tag = "unrelated-v1.0.0";
    await expectCarrierFailure("wrong-tag", wrongTag, ["pgtap"], /\.tag must be oliphaunt-extension-pgtap-v1\.0\.0/u);

    const malformedAssets = structuredClone(carrier);
    malformedAssets.extensions.find(({ sqlName }) => sqlName === "pgtap").assets = {};
    await expectCarrierFailure("malformed-assets", malformedAssets, ["pgtap"], /\.assets must be an array/u);

    const malformedRegistration = structuredClone(carrier);
    malformedRegistration.extensions.find(({ sqlName }) => sqlName === "cube").registration.symbols = "not-an-array";
    await expectCarrierFailure("malformed-registration", malformedRegistration, ["cube"], /registration\.symbols must be an array/u);

    const duplicateName = structuredClone(carrier);
    const duplicateNamePostgis = duplicateName.extensions.find(({ sqlName }) => sqlName === "postgis");
    const duplicateNamePrimary = duplicateNamePostgis.assets.find(({ role }) => role === "extension-xcframework");
    const duplicateNameDependency = duplicateNamePostgis.assets.find(({ role }) => role === "dependency-xcframework");
    Object.assign(duplicateNameDependency, duplicateNamePrimary, {
      member: duplicateNameDependency.member,
      role: "dependency-xcframework",
    });
    await expectCarrierFailure("duplicate-asset-name", duplicateName, ["postgis"], /repeats an asset name/u);

    const duplicateIdentity = structuredClone(carrier);
    const duplicateIdentityPostgis = duplicateIdentity.extensions.find(({ sqlName }) => sqlName === "postgis");
    const geosAsset = duplicateIdentityPostgis.assets.find(({ role }) => role === "dependency-xcframework");
    const duplicateGeosArchive = path.join(root, "archives", "postgis-geos-duplicate.zip");
    await fs.copyFile(new URL(geosAsset.url), duplicateGeosArchive);
    duplicateIdentityPostgis.assets.push(
      await asset("dependency-xcframework", duplicateGeosArchive, "zip", `nested/${path.posix.basename(geosAsset.member)}`),
    );
    await expectCarrierFailure(
      "duplicate-dependency-identity",
      duplicateIdentity,
      ["postgis"],
      /repeats a dependency carrier identity/u,
    );

    await expectReject(
      () => stageIosApp({ carriers: [carrierFile], extensions: [], outputDir: path.join(root, "https-only") }),
      /must use HTTPS/u,
    );

    const missingDependencyFile = path.join(root, "missing-dependency.json");
    await write(
      missingDependencyFile,
      `${JSON.stringify({
        base: carrier.base,
        extensions: carrier.extensions.filter(({ sqlName }) => sqlName === "earthdistance"),
        schema: SCHEMA,
      }, null, 2)}\n`,
    );
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        cacheDir: path.join(root, "missing-cache"),
        carriers: [missingDependencyFile],
        extensions: ["earthdistance"],
        outputDir: path.join(root, "missing-output"),
      }),
      /missing iOS carrier for cube required by earthdistance/u,
    );

    const tampered = structuredClone(carrier);
    tampered.base.assets.find(({ role }) => role === "runtime-resources").sha256 = "0".repeat(64);
    const tamperedFile = path.join(root, "tampered.json");
    await write(tamperedFile, `${JSON.stringify(tampered, null, 2)}\n`);
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        cacheDir: path.join(root, "tampered-cache"),
        carriers: [tamperedFile],
        extensions: [],
        outputDir: path.join(root, "tampered-output"),
      }),
      /checksum mismatch/u,
    );

    const wrongInventory = structuredClone(carrier);
    const postgis = wrongInventory.extensions.find(({ sqlName }) => sqlName === "postgis");
    postgis.assets = postgis.assets.filter(({ role }) => role !== "dependency-xcframework");
    const wrongInventoryFile = path.join(root, "wrong-inventory.json");
    await write(wrongInventoryFile, `${JSON.stringify(wrongInventory, null, 2)}\n`);
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        cacheDir: path.join(root, "inventory-cache"),
        carriers: [wrongInventoryFile],
        extensions: ["postgis"],
        outputDir: path.join(root, "inventory-output"),
      }),
      /dependency-xcframework roles do not exactly match nativeDependencies/u,
    );

    console.log("stage-ios-app.test.mjs: carrier, malicious ZIP, cache-tamper, and payload checks passed");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
