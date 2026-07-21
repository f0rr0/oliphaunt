#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { stageIosApp } from "./stage-ios-app.mjs";

const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
const GENERATED_EXTENSION_CATALOG = JSON.parse(
  await fs.readFile(new URL("../src/generated/extensions.json", import.meta.url), "utf8"),
);
const GENERATED_EXTENSION_BY_SQL_NAME = new Map(
  GENERATED_EXTENSION_CATALOG.extensions.map((row) => [row["sql-name"], row]),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
}

function runFailure(command, args, pattern, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    pattern,
    `${command} ${args.join(" ")} failed without the expected diagnostic`,
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

async function logicalAsset(role, file, format, member) {
  const direct = await asset(role, file, format, member);
  return {
    envelope: {
      bytes: direct.bytes,
      format: direct.format,
      name: direct.name,
      sha256: direct.sha256,
      url: direct.url,
    },
    locator: {
      bytes: direct.bytes,
      carrier: direct.name,
      format: direct.format,
      member: direct.member,
      path: ".",
      role: direct.role,
      sha256: direct.sha256,
    },
  };
}

function retainReferencedCarriers(document) {
  const referenced = new Set(
    document.extensions.flatMap((extension) => extension.assets.map(({ carrier }) => carrier)),
  );
  document.carriers = document.carriers.filter(({ name }) => referenced.has(name));
  return document;
}

function replaceExtensionAssets(document, sqlName, replacements) {
  const row = document.extensions.find((candidate) => candidate.sqlName === sqlName);
  assert.ok(row, `missing fixture extension ${sqlName}`);
  const priorNames = new Set(row.assets.map(({ carrier }) => carrier));
  row.assets = replacements.map(({ locator }) => locator);
  document.carriers = [
    ...document.carriers.filter(({ name }) => !priorNames.has(name)),
    ...replacements.map(({ envelope }) => envelope),
  ];
  retainReferencedCarriers(document);
}

function replaceExtensionRuntimeAsset(document, sqlName, replacement) {
  const row = document.extensions.find((candidate) => candidate.sqlName === sqlName);
  assert.ok(row, `missing fixture extension ${sqlName}`);
  const prior = row.assets.find(({ role }) => role === "runtime-resources");
  assert.ok(prior, `missing runtime fixture asset for ${sqlName}`);
  row.assets = row.assets.map((assetRow) =>
    assetRow === prior ? replacement.locator : assetRow);
  document.carriers = [
    ...document.carriers.filter(({ name }) => name !== prior.carrier),
    replacement.envelope,
  ];
  retainReferencedCarriers(document);
}

async function tarDirectory(source, archive, member = ".") {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  run("tar", ["-czf", archive, "-C", source, member]);
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

async function metadataZip(archive, creator) {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const script = [
    "import sys, zipfile",
    "archive, creator = sys.argv[1:]",
    "host = 0 if creator == 'fat' else 3",
    "ambiguous = creator == 'ambiguous-unix'",
    "root = zipfile.ZipInfo('liboliphaunt.xcframework/')",
    "root.create_system = host",
    "root.external_attr = (((0o755 if ambiguous else 0o40755) << 16) | 0x10) if host == 3 else 0x10",
    "payload = zipfile.ZipInfo('liboliphaunt.xcframework/Info.plist')",
    "payload.create_system = host",
    "payload.external_attr = (((0o644 if ambiguous else 0o100644) << 16) | 0x20) if host == 3 else 0x20",
    "if creator == 'unicode-extra': payload.extra = b'\\x75\\x70\\x05\\x00\\x01\\x00\\x00\\x00\\x00'",
    "with zipfile.ZipFile(archive, 'w') as output:",
    "  output.writestr(root, b'')",
    "  output.writestr(payload, b'<plist><dict/></plist>\\n')",
  ].join("\n");
  run("python3", ["-c", script, archive, creator]);
}

async function addUnsupportedZipFlag(archive) {
  const buffer = await fs.readFile(archive);
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  assert.equal(buffer.readUInt32LE(centralOffset), 0x02014b50);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
  buffer.writeUInt16LE(buffer.readUInt16LE(centralOffset + 8) | 0x20, centralOffset + 8);
  buffer.writeUInt16LE(buffer.readUInt16LE(localOffset + 6) | 0x20, localOffset + 6);
  await fs.writeFile(archive, buffer);
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

async function highCardinalityIcuTar(archive, localeCount) {
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const script = [
    "import io, sys, tarfile",
    "archive, encoded_count = sys.argv[1:]",
    "with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as output:",
    "  for name in ['share/icu/icudt77l.dat'] + [f'share/icu/locale-{index:04d}.res' for index in range(int(encoded_count))]:",
    "    data = b'fixture'",
    "    info = tarfile.TarInfo(name)",
    "    info.mode = 0o644",
    "    info.size = len(data)",
    "    output.addfile(info, io.BytesIO(data))",
  ].join("\n");
  run("python3", ["-c", script, archive, String(localeCount)]);
}

async function rewriteFirstTarSize(archive, size) {
  const tar = gunzipSync(await fs.readFile(archive));
  const header = tar.subarray(0, 512);
  const octal = size.toString(8);
  assert.ok(octal.length <= 11, "forged tar size must fit the ustar size field");
  header.fill(0, 124, 136);
  Buffer.from(`${octal.padStart(11, "0")}\0`, "ascii").copy(header, 124);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, value) => total + value, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  await fs.writeFile(archive, gzipSync(tar, { mtime: 0 }));
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
      "selectedExtensions=",
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
      "selectedExtensions=",
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
  await write(
    path.join(baseFramework, "ios-arm64", "liboliphaunt.framework", "liboliphaunt"),
    "fixture framework binary\n",
  );
  const icu = path.join(source, "icu", "share", "icu");
  await write(path.join(icu, "icudt77l.dat"), "fixture icu\n");

  const archiveRoot = path.join(root, "archives");
  const runtimeArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-runtime-resources.tar.gz");
  const frameworkArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-apple-spm-xcframework.zip");
  const icuArchive = path.join(archiveRoot, "liboliphaunt-1.0.0-icu-data.tar.gz");
  await tarDirectory(path.dirname(runtime), runtimeArchive, path.basename(runtime));
  // POSIX typeflag 5 is authoritative even when an older producer omitted the
  // conventional slash. This is the exact archive shape from the failed run.
  await removeTarDirectorySlash(runtimeArchive, `${path.basename(runtime)}/`);
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
  const createsExtension = config.createsExtension ?? true;
  const dataFiles = config.dataFiles ?? [];
  const sharedPreloadLibraries = config.sharedPreloadLibraries ?? [];
  const mobilePrebuilt = config.mobilePrebuilt ?? (config.nativeModuleStem !== null);
  const nativeModuleFile = config.nativeModuleStem === null ? "" : `${config.nativeModuleStem}.dylib`;
  const nativeSymbolStem = config.nativeModuleStem?.replaceAll(/[^A-Za-z0-9_]/gu, "_") ?? "";
  const registrationSymbols = config.registrationSymbols ?? [];
  const staticSymbolAliases = registrationSymbols
    .filter(({ address, name }) => address !== name)
    .map(({ address, name }) => `${name}:${address}`)
    .sort();
  const mobileStaticArchives = config.nativeModuleStem === null
    ? []
    : ["ios-device", "ios-simulator"].map(
        (target) =>
          `${target}:mobile-static/${target}/extensions/${config.nativeModuleStem}/` +
          `liboliphaunt_extension_${config.nativeModuleStem}.a`,
      );
  const productionDependencyArchiveNames = new Map([
    ["geos-c", "libgeos_c.a"],
    ["openssl", "libcrypto.a"],
    ["sqlite", "libsqlite3.a"],
  ]);
  const mobileStaticDependencyArchives = ["ios-device", "ios-simulator"].flatMap((target) =>
    config.nativeDependencies.map(
      (dependency) =>
        `${target}:${dependency}:mobile-static/${target}/dependencies/${dependency}/` +
        `${productionDependencyArchiveNames.get(dependency) ?? `lib${dependency}.a`}`,
    ));
  await write(
    path.join(source, "manifest.properties"),
    [
      "packageLayout=oliphaunt-extension-artifact-v1",
      "pgMajor=18",
      `sqlName=${config.sqlName}`,
      `createsExtension=${createsExtension ? "yes" : "no"}`,
      `nativeModuleStem=${config.nativeModuleStem ?? ""}`,
      `nativeModuleFile=${nativeModuleFile}`,
      "nativeTarget=ios-xcframework",
      "nativeRuntimeProduct=liboliphaunt-native",
      "nativeRuntimeVersion=1.0.0",
      `dependencies=${config.dependencies.join(",")}`,
      `dataFiles=${dataFiles.join(",")}`,
      `extensionSqlFileNames=${config.extensionSqlFileNames.join(",")}`,
      `extensionSqlFilePrefixes=${config.extensionSqlFilePrefixes.join(",")}`,
      `sharedPreloadLibraries=${sharedPreloadLibraries.join(",")}`,
      `mobilePrebuilt=${mobilePrebuilt ? "yes" : "no"}`,
      `mobileStaticArchives=${mobileStaticArchives.join(",")}`,
      `mobileStaticDependencyArchives=${mobileStaticDependencyArchives.join(",")}`,
      `staticSymbolPrefix=${nativeSymbolStem ? `oliphaunt_static_${nativeSymbolStem}` : ""}`,
      `staticSymbolAliases=${staticSymbolAliases.join(",")}`,
      "files=files",
      "",
    ].join("\n"),
  );
  if (createsExtension) {
    await write(
      path.join(source, "files", "share", "postgresql", "extension", `${config.sqlName}.control`),
      `comment = '${config.sqlName} fixture'\n`,
    );
    await write(
      path.join(source, "files", "share", "postgresql", "extension", `${config.sqlName}--1.0.sql`),
      `select '${config.sqlName}';\n`,
    );
    if (config.includeUpdateSql === true) {
      await write(
        path.join(
          source,
          "files",
          "share",
          "postgresql",
          "extension",
          `${config.sqlName}--1.0--1.1.sql`,
        ),
        `select '${config.sqlName} update';\n`,
      );
    }
    if (config.sqlName === "pgtap") {
      await write(
        path.join(
          source,
          "files",
          "share",
          "postgresql",
          "extension",
          "pgtap.sql",
        ),
        "select 'pgtap ancillary SQL';\n",
      );
      await write(
        path.join(
          source,
          "files",
          "share",
          "postgresql",
          "extension",
          "pgtap--unpackaged--0.91.0.sql",
        ),
        "select 'pgtap legacy upgrade';\n",
      );
    }
    if (config.sqlName === "postgis") {
      await write(
        path.join(
          source,
          "files",
          "share",
          "postgresql",
          "extension",
          "postgis--TEMPLATED--TO--ANY.sql",
        ),
        "select 'postgis template upgrade';\n",
      );
    }
  }
  for (const dataFile of dataFiles) {
    await write(path.join(source, "files", "share", "postgresql", dataFile), `${config.sqlName} data\n`);
  }
  if (config.nativeModuleStem !== null) {
    await write(
      path.join(source, "files", "lib", "postgresql", `${config.nativeModuleStem}.dylib`),
      `${config.sqlName} native fixture\n`,
    );
  }
  for (const row of mobileStaticArchives) {
    const [, relative] = row.split(":");
    await write(path.join(source, ...relative.split("/")), `${config.sqlName} static fixture\n`);
  }
  for (const row of mobileStaticDependencyArchives) {
    const [, dependency, relative] = row.split(":");
    await write(path.join(source, ...relative.split("/")), `${dependency} static fixture\n`);
  }
  const archiveRoot = path.join(root, "archives");
  const runtimeArchive = path.join(
    archiveRoot,
    `oliphaunt-extension-${config.sqlName.replaceAll("_", "-")}-1.0.0-native-ios-runtime.tar.gz`,
  );
  await tarDirectory(source, runtimeArchive);
  const logicalAssets = [
    await logicalAsset("runtime-resources", runtimeArchive, "tar.gz", "."),
  ];
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
    logicalAssets.push(
      await logicalAsset(
        "extension-xcframework",
        frameworkArchive,
        "zip",
        path.basename(framework),
      ),
    );
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
      logicalAssets.push(
        await logicalAsset(
          "dependency-xcframework",
          dependencyArchive,
          "zip",
          path.basename(dependencyFramework),
        ),
      );
    }
  }
  const generated = GENERATED_EXTENSION_BY_SQL_NAME.get(config.sqlName);
  assert.ok(generated, `missing generated fixture metadata for ${config.sqlName}`);
  const product = generated["release-product"];
  return {
    carriers: logicalAssets.map(({ envelope }) => envelope),
    extension: {
      assets: logicalAssets.map(({ locator }) => locator),
      createsExtension,
      dataFiles,
      dependencies: config.dependencies,
      extensionSqlFileNames: config.extensionSqlFileNames,
      extensionSqlFilePrefixes: config.extensionSqlFilePrefixes,
      nativeDependencies: config.nativeDependencies,
      nativeModuleStem: config.nativeModuleStem,
      product,
      registration: config.nativeModuleStem === null
        ? null
        : {
            initSymbol: null,
            magicSymbol: `oliphaunt_static_${config.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}_Pg_magic_func`,
            symbols: registrationSymbols,
          },
      sharedPreloadLibraries,
      sqlName: config.sqlName,
      tag: `${product}-v1.0.0`,
      version: "1.0.0",
    },
  };
}

async function rewrittenExtensionRuntime(root, sqlName, archiveName, rewrite) {
  const source = path.join(root, "source", "extensions", sqlName, "runtime");
  const stage = path.join(root, "rewritten-extension-runtime", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(stage, { force: true, recursive: true });
  await fs.cp(source, stage, { recursive: true });
  const manifestFile = path.join(stage, "manifest.properties");
  const original = await fs.readFile(manifestFile, "utf8");
  const rewritten = rewrite(original);
  assert.notEqual(rewritten, original, `${archiveName} rewrite must change manifest.properties`);
  await fs.writeFile(manifestFile, rewritten);
  const archive = path.join(root, "archives", archiveName);
  await fs.rm(archive, { force: true });
  await tarDirectory(stage, archive);
  return logicalAsset("runtime-resources", archive, "tar.gz", ".");
}

async function extendedExtensionRuntime(root, sqlName, archiveName, additions) {
  const source = path.join(root, "source", "extensions", sqlName, "runtime");
  const stage = path.join(root, "extended-extension-runtime", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(stage, { force: true, recursive: true });
  await fs.cp(source, stage, { recursive: true });
  for (const [relativePath, contents] of Object.entries(additions)) {
    await write(path.join(stage, relativePath), contents);
  }
  const archive = path.join(root, "archives", archiveName);
  await fs.rm(archive, { force: true });
  await tarDirectory(stage, archive);
  return logicalAsset("runtime-resources", archive, "tar.gz", ".");
}

async function mutatedExtensionRuntime(root, sqlName, archiveName, mutate) {
  const source = path.join(root, "source", "extensions", sqlName, "runtime");
  const stage = path.join(root, "mutated-extension-runtime", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(stage, { force: true, recursive: true });
  await fs.cp(source, stage, { recursive: true });
  await mutate(stage);
  const archive = path.join(root, "archives", archiveName);
  await fs.rm(archive, { force: true });
  await tarDirectory(stage, archive);
  return logicalAsset("runtime-resources", archive, "tar.gz", ".");
}

async function createFixture(root) {
  const base = {
    assets: await baseAssets(root),
    product: "liboliphaunt-native",
    tag: "liboliphaunt-native-v1.0.0",
    version: "1.0.0",
  };
  const carriers = [];
  const extensions = [];
  for (const fixture of [
    { sqlName: "auto_explain" },
    { sqlName: "cube" },
    { sqlName: "earthdistance" },
    { sqlName: "pgcrypto" },
    { sqlName: "pgtap", includeUpdateSql: true },
    {
      sqlName: "postgis",
      registrationSymbols: [
        { address: "oliphaunt_static_postgis_3_difference", name: "difference" },
        {
          address: "pg_finfo_oliphaunt_static_postgis_3_difference",
          name: "pg_finfo_difference",
        },
      ],
    },
  ]) {
    const generated = GENERATED_EXTENSION_BY_SQL_NAME.get(fixture.sqlName);
    assert.ok(generated, `missing generated fixture metadata for ${fixture.sqlName}`);
    if (fixture.sqlName === "pgcrypto") {
      assert.deepEqual(generated["ios-static-dependencies"], ["openssl"]);
    }
    if (fixture.sqlName === "postgis") {
      assert.deepEqual(
        generated["ios-static-dependencies"],
        ["geos", "geos-c", "json-c", "libxml2", "proj", "sqlite"],
      );
    }
    const config = {
      ...fixture,
      createsExtension: generated["creates-extension"],
      dataFiles: generated["runtime-share-data-files"],
      dependencies: generated["selected-extension-dependencies"],
      extensionSqlFileNames: generated["extension-sql-file-names"],
      extensionSqlFilePrefixes: generated["extension-sql-file-prefixes"],
      nativeDependencies: generated["ios-static-dependencies"],
      nativeModuleStem: generated["native-module-stem"],
      sharedPreloadLibraries: generated["shared-preload-libraries"],
    };
    const built = await extensionRow(root, config);
    carriers.push(...built.carriers);
    extensions.push(built.extension);
  }
  const carrier = { base, carriers, extensions, schema: SCHEMA };
  const carrierFile = path.join(root, "oliphaunt-react-native-ios-carriers.json");
  await write(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`);
  return { carrier, carrierFile };
}

async function bundledCarrierDocument(root, sourceDocument, sqlNames, archiveName, tamperSqlName) {
  const document = structuredClone(sourceDocument);
  document.extensions = document.extensions.filter(({ sqlName }) => sqlNames.includes(sqlName));
  const sourceRoot = path.join(root, "bundle-source", archiveName.replace(/\.tar\.gz$/u, ""));
  await fs.rm(sourceRoot, { force: true, recursive: true });
  const sourceCarriers = new Map(sourceDocument.carriers.map((row) => [row.name, row]));
  for (const extension of document.extensions) {
    for (const locator of extension.assets) {
      const envelope = sourceCarriers.get(locator.carrier);
      assert.ok(envelope, `missing source envelope ${locator.carrier}`);
      const nestedPath = `extensions/${extension.sqlName}/${envelope.name}`;
      const nestedFile = path.join(sourceRoot, ...nestedPath.split("/"));
      await fs.mkdir(path.dirname(nestedFile), { recursive: true });
      await fs.copyFile(fileURLToPath(envelope.url), nestedFile);
      if (extension.sqlName === tamperSqlName && locator.role === "runtime-resources") {
        await fs.appendFile(nestedFile, "tampered nested payload\n");
      }
      locator.carrier = archiveName;
      locator.path = nestedPath;
    }
  }
  const archive = path.join(root, "archives", archiveName);
  await fs.rm(archive, { force: true });
  await fs.mkdir(path.dirname(archive), { recursive: true });
  run("tar", ["-czf", archive, "-C", sourceRoot, "extensions"]);
  const direct = await asset("carrier", archive, "tar.gz", ".");
  document.carriers = [{
    bytes: direct.bytes,
    format: direct.format,
    name: direct.name,
    sha256: direct.sha256,
    url: direct.url,
  }];
  return document;
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
    const requested = ["auto_explain", "earthdistance", "pgcrypto", "pgtap", "postgis"];
    const fakeArchiveTools = path.join(root, "fake-archive-tools");
    await fs.mkdir(fakeArchiveTools, { recursive: true });
    const fakeZipinfo = path.join(fakeArchiveTools, "zipinfo");
    await fs.writeFile(fakeZipinfo, "#!/bin/sh\n# Reproduce a successful child whose formatted stdout was truncated.\nexit 0\n");
    await fs.chmod(fakeZipinfo, 0o755);
    const originalPath = process.env.PATH;
    let result;
    try {
      process.env.PATH = `${fakeArchiveTools}${path.delimiter}${originalPath ?? ""}`;
      result = await stageIosApp({
        allowFileUrls: true,
        cacheDir: cache,
        carriers: [carrierFile],
        extensions: requested,
        icu: true,
        outputDir: output,
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    assert.deepEqual(
      result.selected,
      ["auto_explain", "cube", "earthdistance", "pgcrypto", "pgtap", "postgis"],
    );
    run(
      process.execPath,
      [path.join(import.meta.dirname, "verify-ios-package.mjs"), "--payload-dir", output],
    );

    const payloadPodspec = await fs.readFile(
      path.join(output, "OliphauntReactNativePayload.podspec"),
      "utf8",
    );
    assert.match(
      payloadPodspec,
      /s\.resources = "resources\/OliphauntReactNativeResources\.bundle"/u,
    );
    assert.match(
      payloadPodspec,
      /s\.vendored_frameworks = "frameworks\/base\/liboliphaunt\.xcframework", "frameworks\/extensions\/\*\*\/\*\.xcframework"/u,
    );
    assert.doesNotMatch(payloadPodspec, /frameworks\/base\/[^"\n]*\*\*/u);
    assert.doesNotMatch(payloadPodspec, /frameworks\/base\/[^"\n]*\.framework/u);
    assert.match(payloadPodspec, /s\.source_files = "generated\/static-registry\/\*\.c"/u);
    assert.doesNotMatch(payloadPodspec, /(?:^|["'])\.\.\//mu);
    for (const relativeRoot of [
      "resources/OliphauntReactNativeResources.bundle",
      "frameworks/base",
      "frameworks/extensions",
      "generated/static-registry",
    ]) {
      await fs.access(path.join(output, relativeRoot));
    }
    await fs.access(path.join(
      output,
      "frameworks",
      "base",
      "liboliphaunt.xcframework",
      "ios-arm64",
      "liboliphaunt.framework",
      "liboliphaunt",
    ));

    const frameworkNames = (await fs.readdir(path.join(output, "frameworks", "extensions"))).sort();
    assert.deepEqual(frameworkNames, [
      "liboliphaunt_dependency_geos-c.xcframework",
      "liboliphaunt_dependency_geos.xcframework",
      "liboliphaunt_dependency_json-c.xcframework",
      "liboliphaunt_dependency_libxml2.xcframework",
      "liboliphaunt_dependency_openssl.xcframework",
      "liboliphaunt_dependency_proj.xcframework",
      "liboliphaunt_dependency_sqlite.xcframework",
      "liboliphaunt_extension_auto_explain.xcframework",
      "liboliphaunt_extension_cube.xcframework",
      "liboliphaunt_extension_earthdistance.xcframework",
      "liboliphaunt_extension_pgcrypto.xcframework",
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
    await assert.rejects(
      fs.access(
        path.join(output, "resources", "OliphauntReactNativeResources.bundle", "oliphaunt", "runtime", "files", "share", "postgresql", "extension", "auto_explain.control"),
      ),
    );
    const runtimeManifest = await fs.readFile(
      path.join(
        output,
        "resources",
        "OliphauntReactNativeResources.bundle",
        "oliphaunt",
        "runtime",
        "manifest.properties",
      ),
      "utf8",
    );
    assert.match(
      runtimeManifest,
      /^selectedExtensions=auto_explain,cube,earthdistance,pgcrypto,pgtap,postgis$/mu,
    );
    assert.match(
      runtimeManifest,
      /^extensions=cube,earthdistance,pgcrypto,pgtap,postgis$/mu,
    );
    assert.match(
      runtimeManifest,
      /^mobileStaticRegistryRegistered=auto_explain,cube,earthdistance,pgcrypto,postgis$/mu,
    );
    const packageSize = await fs.readFile(
      path.join(output, "resources", "OliphauntReactNativeResources.bundle", "oliphaunt", "package-size.tsv"),
      "utf8",
    );
    assert.match(packageSize, /^extension\tauto_explain\t-\t0\t0$/mu);
    assert.match(
      packageSize,
      /^extensions\tselected\tauto_explain,cube,earthdistance,pgcrypto,pgtap,postgis\t/mu,
    );
    const registry = await fs.readFile(
      path.join(output, "generated", "static-registry", "oliphaunt_static_registry.c"),
      "utf8",
    );
    assert.doesNotMatch(registry, /symbols\[\]\s*=\s*\{\s*\}/u);
    assert.match(registry, /\.symbols = NULL,/u);
    assert.match(registry, /\.name = "postgis-3"/u);
    assert.match(
      registry,
      /\.name = "difference", \.address = \(void \*\)oliphaunt_static_postgis_3_difference/u,
    );
    assert.match(
      registry,
      /\.name = "pg_finfo_difference", \.address = \(void \*\)pg_finfo_oliphaunt_static_postgis_3_difference/u,
    );

    const selection = JSON.parse(await fs.readFile(path.join(output, "selection.json"), "utf8"));
    assert.equal(selection.icu, true);
    assert.equal(
      selection.extensions.find(({ sqlName }) => sqlName === "auto_explain").createsExtension,
      false,
    );
    assert.equal(
      selection.extensions.find(({ sqlName }) => sqlName === "pgtap").createsExtension,
      true,
    );
    await fs.access(
      path.join(
        output,
        "resources",
        "OliphauntReactNativeResources.bundle",
        "oliphaunt",
        "runtime",
        "files",
        "share",
        "postgresql",
        "extension",
        "pgtap--1.0--1.1.sql",
      ),
    );
    assert.deepEqual(selection.requestedExtensions, [...requested].sort());
    assert.deepEqual(selection.extensions.map(({ sqlName }) => sqlName), result.selected);

    const missingCreateableOutput = path.join(root, "missing-createable-output");
    await fs.cp(output, missingCreateableOutput, { recursive: true });
    const missingCreateableManifest = path.join(
      missingCreateableOutput,
      "resources",
      "OliphauntReactNativeResources.bundle",
      "oliphaunt",
      "runtime",
      "manifest.properties",
    );
    await fs.writeFile(
      missingCreateableManifest,
      (await fs.readFile(missingCreateableManifest, "utf8")).replace(
        /^extensions=cube,earthdistance,pgcrypto,pgtap,postgis$/mu,
        "extensions=cube,earthdistance,pgcrypto,postgis",
      ),
    );
    runFailure(
      process.execPath,
      [
        path.join(import.meta.dirname, "verify-ios-package.mjs"),
        "--payload-dir",
        missingCreateableOutput,
      ],
      /extensions must match the exact canonical domain/u,
    );

    const missingNativeRegistrationOutput = path.join(root, "missing-native-registration-output");
    await fs.cp(output, missingNativeRegistrationOutput, { recursive: true });
    const missingNativeRegistrationManifest = path.join(
      missingNativeRegistrationOutput,
      "resources",
      "OliphauntReactNativeResources.bundle",
      "oliphaunt",
      "runtime",
      "manifest.properties",
    );
    await fs.writeFile(
      missingNativeRegistrationManifest,
      (await fs.readFile(missingNativeRegistrationManifest, "utf8")).replace(
        /^mobileStaticRegistryRegistered=auto_explain,cube,earthdistance,pgcrypto,postgis$/mu,
        "mobileStaticRegistryRegistered=cube,earthdistance,pgcrypto,postgis",
      ),
    );
    runFailure(
      process.execPath,
      [
        path.join(import.meta.dirname, "verify-ios-package.mjs"),
        "--payload-dir",
        missingNativeRegistrationOutput,
      ],
      /mobileStaticRegistryRegistered must match the exact canonical domain/u,
    );

    const contribBundle = await bundledCarrierDocument(
      root,
      carrier,
      ["auto_explain", "cube", "earthdistance"],
      "oliphaunt-extension-contrib-pg18-1.0.0-native-ios-bundle.tar.gz",
    );
    const contribBundleFile = path.join(root, "oliphaunt-extension-contrib-pg18-carrier.json");
    await write(contribBundleFile, `${JSON.stringify(contribBundle, null, 2)}\n`);
    const externalCarrier = structuredClone(carrier);
    externalCarrier.extensions = externalCarrier.extensions.filter(({ sqlName }) => sqlName === "pgtap");
    retainReferencedCarriers(externalCarrier);
    const externalCarrierFile = path.join(root, "oliphaunt-extension-pgtap-carrier.json");
    await write(externalCarrierFile, `${JSON.stringify(externalCarrier, null, 2)}\n`);
    const bundleOutput = path.join(root, "consumer-bundle", "ios", "oliphaunt");
    const bundleResult = await stageIosApp({
      allowFileUrls: true,
      cacheDir: path.join(root, "bundle-cache"),
      carriers: [contribBundleFile, externalCarrierFile],
      extensions: ["earthdistance", "pgtap"],
      outputDir: bundleOutput,
    });
    assert.deepEqual(bundleResult.selected, ["cube", "earthdistance", "pgtap"]);
    const bundleSelection = JSON.parse(await fs.readFile(path.join(bundleOutput, "selection.json"), "utf8"));
    assert.deepEqual(bundleSelection.extensions.map(({ product, sqlName }) => [product, sqlName]), [
      ["oliphaunt-extension-contrib-pg18", "cube"],
      ["oliphaunt-extension-contrib-pg18", "earthdistance"],
      ["oliphaunt-extension-pgtap", "pgtap"],
    ]);
    const unselectedAutoExplain = contribBundle.extensions
      .find(({ sqlName }) => sqlName === "auto_explain")
      .assets.find(({ role }) => role === "runtime-resources");
    await assert.rejects(
      fs.access(
        path.join(
          root,
          "bundle-cache",
          "payloads",
          `${unselectedAutoExplain.sha256}-${path.posix.basename(unselectedAutoExplain.path)}`,
        ),
      ),
    );

    // An independently versioned external extension is validated against the
    // immutable carrier contract that shipped with that extension version, not
    // against this SDK's newer generated extension catalog.
    const frozenOldExternal = structuredClone(carrier);
    frozenOldExternal.extensions = frozenOldExternal.extensions.filter(
      ({ sqlName }) => sqlName === "pgtap",
    );
    const frozenOldPgtap = frozenOldExternal.extensions[0];
    frozenOldPgtap.version = "0.9.0";
    frozenOldPgtap.tag = "oliphaunt-extension-pgtap-v0.9.0";
    frozenOldPgtap.dataFiles = ["legacy/pgtap-old.dat"];
    frozenOldPgtap.extensionSqlFileNames = ["uninstall_pgtap_legacy.sql"];
    frozenOldPgtap.extensionSqlFilePrefixes = ["pgtap-legacy"];
    frozenOldPgtap.sharedPreloadLibraries = ["pgtap_legacy"];
    replaceExtensionRuntimeAsset(
      frozenOldExternal,
      "pgtap",
      await mutatedExtensionRuntime(
        root,
        "pgtap",
        "pgtap-frozen-old-version.tar.gz",
        async (stage) => {
          const manifestFile = path.join(stage, "manifest.properties");
          const manifest = await fs.readFile(manifestFile, "utf8");
          await fs.writeFile(
            manifestFile,
            manifest
              .replace("dataFiles=", "dataFiles=legacy/pgtap-old.dat")
              .replace(
                "extensionSqlFileNames=uninstall_pgtap.sql",
                "extensionSqlFileNames=uninstall_pgtap_legacy.sql",
              )
              .replace(
                "extensionSqlFilePrefixes=pgtap-core,pgtap-schema",
                "extensionSqlFilePrefixes=pgtap-legacy",
              )
              .replace(
                "sharedPreloadLibraries=",
                "sharedPreloadLibraries=pgtap_legacy",
              ),
          );
          await write(
            path.join(stage, "files", "share", "postgresql", "legacy", "pgtap-old.dat"),
            "old independently versioned pgtap data\n",
          );
        },
      ),
    );
    retainReferencedCarriers(frozenOldExternal);
    const frozenOldExternalFile = path.join(root, "pgtap-frozen-old-version.json");
    await write(frozenOldExternalFile, `${JSON.stringify(frozenOldExternal, null, 2)}\n`);
    const frozenOldOutput = path.join(root, "pgtap-frozen-old-output");
    const frozenOldResult = await stageIosApp({
      allowFileUrls: true,
      cacheDir: path.join(root, "pgtap-frozen-old-cache"),
      carriers: [frozenOldExternalFile],
      extensions: ["pgtap"],
      outputDir: frozenOldOutput,
    });
    assert.deepEqual(frozenOldResult.selected, ["pgtap"]);
    assert.equal(
      await fs.readFile(
        path.join(
          frozenOldOutput,
          "resources",
          "OliphauntReactNativeResources.bundle",
          "oliphaunt",
          "runtime",
          "files",
          "share",
          "postgresql",
          "legacy",
          "pgtap-old.dat",
        ),
        "utf8",
      ),
      "old independently versioned pgtap data\n",
    );

    const tamperedBundle = await bundledCarrierDocument(
      root,
      carrier,
      ["cube", "earthdistance"],
      "oliphaunt-extension-contrib-pg18-1.0.0-native-ios-tampered-bundle.tar.gz",
      "earthdistance",
    );
    const tamperedBundleFile = path.join(root, "tampered-contrib-bundle.json");
    await write(tamperedBundleFile, `${JSON.stringify(tamperedBundle, null, 2)}\n`);
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        cacheDir: path.join(root, "tampered-bundle-cache"),
        carriers: [tamperedBundleFile],
        extensions: ["earthdistance"],
        outputDir: path.join(root, "tampered-bundle-output"),
      }),
      /nested payload .* does not match its frozen size\/checksum/u,
    );
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        carriers: [carrierFile, contribBundleFile],
        extensions: ["cube"],
        outputDir: path.join(root, "bundle-conflict"),
      }),
      /carrier manifests disagree for exact extension/u,
    );

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

    async function expectResourceManifestFailure(name, rewrite, pattern, sqlName = "pgtap") {
      const candidate = structuredClone(carrier);
      const replacement = await rewrittenExtensionRuntime(
        root,
        sqlName,
        `${name}.tar.gz`,
        rewrite,
      );
      replaceExtensionAssets(candidate, sqlName, [replacement]);
      await expectCarrierFailure(name, candidate, [sqlName], pattern);
    }

    const moduleOnlyBase = structuredClone(carrier);
    const moduleOnlyBaseRoot = path.join(
      root,
      "mutated-base-module-only",
      "oliphaunt",
    );
    await fs.cp(
      path.join(root, "source", "base", "runtime", "oliphaunt"),
      moduleOnlyBaseRoot,
      { recursive: true },
    );
    const moduleOnlyBaseManifest = path.join(
      moduleOnlyBaseRoot,
      "runtime",
      "manifest.properties",
    );
    await fs.writeFile(
      moduleOnlyBaseManifest,
      (await fs.readFile(moduleOnlyBaseManifest, "utf8")).replace(
        "selectedExtensions=\n",
        "selectedExtensions=auto_explain\n",
      ),
    );
    await write(
      path.join(moduleOnlyBaseRoot, "runtime", "files", "lib", "postgresql", "auto_explain.dylib"),
      "hidden module-only base payload\n",
    );
    const moduleOnlyBaseArchive = path.join(root, "archives", "module-only-base.tar.gz");
    await tarDirectory(path.dirname(moduleOnlyBaseRoot), moduleOnlyBaseArchive, "oliphaunt");
    moduleOnlyBase.base.assets = await Promise.all(
      moduleOnlyBase.base.assets.map(async (row) => row.role === "runtime-resources"
        ? asset("runtime-resources", moduleOnlyBaseArchive, "tar.gz", "oliphaunt")
        : row),
    );
    await expectCarrierFailure(
      "module-only-selection-in-base-runtime",
      moduleOnlyBase,
      [],
      /base React Native iOS carrier is not extension-free/u,
    );

    const missingRootEnvelopeField = structuredClone(carrier);
    delete missingRootEnvelopeField.carriers;
    await expectCarrierFailure(
      "missing-root-envelope-field",
      missingRootEnvelopeField,
      [],
      /fields must be exactly base,carriers,extensions,schema; got base,extensions,schema/u,
    );

    const missingCarrierEnvelopeField = structuredClone(carrier);
    delete missingCarrierEnvelopeField.carriers[0].bytes;
    await expectCarrierFailure(
      "missing-carrier-envelope-field",
      missingCarrierEnvelopeField,
      [],
      /fields must be exactly bytes,format,name,sha256,url; got format,name,sha256,url/u,
    );

    const missingLogicalEnvelopeField = structuredClone(carrier);
    delete missingLogicalEnvelopeField.extensions[0].assets[0].member;
    await expectCarrierFailure(
      "missing-logical-envelope-field",
      missingLogicalEnvelopeField,
      ["auto_explain"],
      /fields must be exactly bytes,carrier,format,member,path,role,sha256; got bytes,carrier,format,path,role,sha256/u,
    );

    const missingFrozenContentField = structuredClone(carrier);
    delete missingFrozenContentField.extensions.find(
      ({ sqlName }) => sqlName === "pgtap",
    ).dataFiles;
    await expectCarrierFailure(
      "missing-frozen-extension-content-field",
      missingFrozenContentField,
      ["pgtap"],
      /fields must be exactly .*dataFiles.*; got .*[^A-Za-z]dependencies/u,
    );

    const nonCanonicalFrozenList = structuredClone(carrier);
    nonCanonicalFrozenList.extensions.find(
      ({ sqlName }) => sqlName === "pgtap",
    ).extensionSqlFilePrefixes.reverse();
    await expectCarrierFailure(
      "non-canonical-frozen-extension-list",
      nonCanonicalFrozenList,
      ["pgtap"],
      /extensionSqlFilePrefixes must be sorted in ordinal order/u,
    );

    const selfDependentFrozenContract = structuredClone(carrier);
    selfDependentFrozenContract.extensions.find(
      ({ sqlName }) => sqlName === "pgtap",
    ).dependencies = ["pgtap"];
    await expectCarrierFailure(
      "self-dependent-frozen-extension-contract",
      selfDependentFrozenContract,
      ["pgtap"],
      /dependencies must not include pgtap itself/u,
    );

    const dottedFrozenSqlPrefix = structuredClone(carrier);
    dottedFrozenSqlPrefix.extensions.find(
      ({ sqlName }) => sqlName === "pgtap",
    ).extensionSqlFilePrefixes = ["pgtap.core"];
    await expectCarrierFailure(
      "dotted-frozen-extension-sql-prefix",
      dottedFrozenSqlPrefix,
      ["pgtap"],
      /dot-free portable SQL basename prefix/u,
    );

    async function expectCacheComponentSymlinkFailure(name, component, candidate, extensions) {
      const file = path.join(root, `${name}.json`);
      const cacheDir = path.join(root, `${name}-cache`);
      const redirected = path.join(root, `${name}-redirected`);
      await write(file, `${JSON.stringify(candidate, null, 2)}\n`);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.mkdir(redirected, { recursive: true });
      await fs.symlink(redirected, path.join(cacheDir, component), "dir");
      await expectReject(
        () => stageIosApp({
          allowFileUrls: true,
          cacheDir,
          carriers: [file],
          extensions,
          outputDir: path.join(root, `${name}-output`),
        }),
        /cache path component must be a real directory, not a symlink/u,
      );
      assert.deepEqual(
        await fs.readdir(redirected),
        [],
        `rejected ${component} cache symlink must not receive carrier bytes`,
      );
    }

    await expectCacheComponentSymlinkFailure(
      "objects-cache-symlink",
      "objects",
      carrier,
      [],
    );
    await expectCacheComponentSymlinkFailure(
      "extracted-cache-symlink",
      "extracted",
      carrier,
      [],
    );
    await expectCacheComponentSymlinkFailure(
      "payloads-cache-symlink",
      "payloads",
      contribBundle,
      ["cube"],
    );

    const cacheRootLinkManifest = path.join(root, "cache-root-symlink.json");
    const cacheRootLink = path.join(root, "cache-root-symlink-cache");
    const cacheRootRedirected = path.join(root, "cache-root-symlink-redirected");
    await write(cacheRootLinkManifest, `${JSON.stringify(carrier, null, 2)}\n`);
    await fs.mkdir(cacheRootRedirected, { recursive: true });
    await fs.symlink(cacheRootRedirected, cacheRootLink, "dir");
    await expectReject(
      () => stageIosApp({
        allowFileUrls: true,
        cacheDir: cacheRootLink,
        carriers: [cacheRootLinkManifest],
        extensions: [],
        outputDir: path.join(root, "cache-root-symlink-output"),
      }),
      /cache root must be a real directory, not a symlink/u,
    );
    assert.deepEqual(
      await fs.readdir(cacheRootRedirected),
      [],
      "rejected cache-root symlink must not receive carrier bytes",
    );

    await expectResourceManifestFailure(
      "missing-native-runtime-product",
      (manifest) => manifest.replace("nativeRuntimeProduct=liboliphaunt-native\n", ""),
      /is missing nativeRuntimeProduct/u,
    );
    await expectResourceManifestFailure(
      "missing-native-runtime-version",
      (manifest) => manifest.replace("nativeRuntimeVersion=1.0.0\n", ""),
      /is missing nativeRuntimeVersion/u,
    );
    await expectResourceManifestFailure(
      "wrong-native-runtime-product",
      (manifest) => manifest.replace(
        "nativeRuntimeProduct=liboliphaunt-native",
        "nativeRuntimeProduct=liboliphaunt-wasix",
      ),
      /must declare nativeRuntimeProduct=liboliphaunt-native; got liboliphaunt-wasix/u,
    );
    await expectResourceManifestFailure(
      "wrong-native-target",
      (manifest) => manifest.replace(
        "nativeTarget=ios-xcframework",
        "nativeTarget=linux-x64-gnu",
      ),
      /must declare nativeTarget=ios-xcframework; got linux-x64-gnu/u,
    );
    await expectResourceManifestFailure(
      "wrong-native-runtime-version",
      (manifest) => manifest.replace("nativeRuntimeVersion=1.0.0", "nativeRuntimeVersion=9.9.9"),
      /must declare nativeRuntimeVersion=1\.0\.0; got 9\.9\.9/u,
    );
    await expectResourceManifestFailure(
      "unstable-native-runtime-version",
      (manifest) => manifest.replace(
        "nativeRuntimeVersion=1.0.0",
        "nativeRuntimeVersion=1.0.0-rc.1",
      ),
      /nativeRuntimeVersion must be a stable SemVer X\.Y\.Z version/u,
    );
    await expectResourceManifestFailure(
      "unknown-extension-manifest-field",
      (manifest) => manifest.replace("files=files\n", "unsupportedFutureField=value\nfiles=files\n"),
      /contains unsupported field\(s\): unsupportedFutureField/u,
    );
    await expectResourceManifestFailure(
      "missing-extension-canonical-field",
      (manifest) => manifest.replace("nativeModuleFile=\n", ""),
      /must declare nativeModuleFile=; got <missing>/u,
    );
    await expectResourceManifestFailure(
      "missing-extension-sql-file-names",
      (manifest) => manifest.replace("extensionSqlFileNames=uninstall_pgtap.sql\n", ""),
      /is missing extensionSqlFileNames/u,
    );
    await expectResourceManifestFailure(
      "wrong-extension-sql-file-prefixes",
      (manifest) => manifest.replace(
        "extensionSqlFilePrefixes=pgtap-core,pgtap-schema",
        "extensionSqlFilePrefixes=pgtap-core,wildcard-trust",
      ),
      /extensionSqlFilePrefixes must exactly match the frozen carrier contract for pgtap/u,
    );
    await expectResourceManifestFailure(
      "wrong-extension-native-module-file",
      (manifest) => manifest.replace("nativeModuleFile=\n", "nativeModuleFile=other.dylib\n"),
      /must declare nativeModuleFile=; got other\.dylib/u,
    );
    await expectResourceManifestFailure(
      "wrong-extension-static-symbol-prefix",
      (manifest) => manifest.replace(
        "staticSymbolPrefix=\n",
        "staticSymbolPrefix=oliphaunt_static_other\n",
      ),
      /must declare staticSymbolPrefix=; got oliphaunt_static_other/u,
    );
    await expectResourceManifestFailure(
      "unselected-extension-static-symbol-alias",
      (manifest) => manifest.replace("staticSymbolAliases=", "staticSymbolAliases=sql_symbol:linked_symbol"),
      /must declare staticSymbolAliases=; got sql_symbol:linked_symbol/u,
    );

    const undeclaredExtensionFiles = structuredClone(carrier);
    replaceExtensionAssets(undeclaredExtensionFiles, "pgtap", [
      await extendedExtensionRuntime(
        root,
        "pgtap",
        "undeclared-extension-files.tar.gz",
        {
          "files/share/postgresql/extension/evil--1.0.sql": "SELECT 'undeclared';\n",
          "files/share/postgresql/extension/evil.control": "default_version = '1.0'\n",
        },
      ),
    ]);
    await expectCarrierFailure(
      "undeclared-extension-files",
      undeclaredExtensionFiles,
      ["pgtap"],
      /extension artifact inventory must be exact; .*extra=.*evil/u,
    );

    const undeclaredPrefixedNonSql = structuredClone(carrier);
    replaceExtensionAssets(undeclaredPrefixedNonSql, "pgtap", [
      await extendedExtensionRuntime(
        root,
        "pgtap",
        "undeclared-prefixed-non-sql.tar.gz",
        {
          "files/share/postgresql/extension/pgtap-core-evil.control":
            "default_version = '1.0'\n",
        },
      ),
    ]);
    await expectCarrierFailure(
      "undeclared-prefixed-non-sql",
      undeclaredPrefixedNonSql,
      ["pgtap"],
      /extension artifact inventory must be exact; .*extra=.*pgtap-core-evil\.control/u,
    );

    const ancillaryOnly = structuredClone(carrier);
    replaceExtensionAssets(ancillaryOnly, "pgtap", [
      await mutatedExtensionRuntime(
        root,
        "pgtap",
        "ancillary-only-pgtap.tar.gz",
        async (stage) => {
          const extensionDirectory = path.join(stage, "files", "share", "postgresql", "extension");
          for (const name of await fs.readdir(extensionDirectory)) {
            if (name === "pgtap.sql" || /^pgtap--.*\.sql$/u.test(name)) {
              await fs.rm(path.join(extensionDirectory, name));
            }
          }
          await write(path.join(extensionDirectory, "uninstall_pgtap.sql"), "SELECT 'ancillary only';\n");
        },
      ),
    ]);
    await expectCarrierFailure(
      "ancillary-only-install-sql",
      ancillaryOnly,
      ["pgtap"],
      /missing an install SQL file owned by pgtap/u,
    );

    const updateOnly = structuredClone(carrier);
    replaceExtensionAssets(updateOnly, "pgtap", [
      await mutatedExtensionRuntime(
        root,
        "pgtap",
        "update-only-pgtap.tar.gz",
        async (stage) => {
          await fs.rm(
            path.join(
              stage,
              "files",
              "share",
              "postgresql",
              "extension",
              "pgtap--1.0.sql",
            ),
          );
        },
      ),
    ]);
    await expectCarrierFailure(
      "update-only-install-sql",
      updateOnly,
      ["pgtap"],
      /missing an install SQL file owned by pgtap/u,
    );

    const nonDigitVersion = structuredClone(carrier);
    replaceExtensionAssets(nonDigitVersion, "pgtap", [
      await mutatedExtensionRuntime(
        root,
        "pgtap",
        "non-digit-version-pgtap.tar.gz",
        async (stage) => {
          const extensionDirectory = path.join(
            stage,
            "files",
            "share",
            "postgresql",
            "extension",
          );
          await fs.rm(path.join(extensionDirectory, "pgtap--1.0.sql"));
          await write(path.join(extensionDirectory, "pgtap--beta.sql"), "SELECT 'invalid';\n");
        },
      ),
    ]);
    await expectCarrierFailure(
      "non-digit-install-version",
      nonDigitVersion,
      ["pgtap"],
      /missing an install SQL file owned by pgtap/u,
    );

    const wrongDependencyArchive = structuredClone(carrier);
    replaceExtensionRuntimeAsset(
      wrongDependencyArchive,
      "postgis",
      await mutatedExtensionRuntime(
        root,
        "postgis",
        "wrong-dependency-archive-name.tar.gz",
        async (stage) => {
          const manifestFile = path.join(stage, "manifest.properties");
          const manifest = await fs.readFile(manifestFile, "utf8");
          await fs.writeFile(
            manifestFile,
            manifest.replace(
              "/dependencies/geos/libgeos.a",
              "/dependencies/geos/arbitrary.a",
            ),
          );
        },
      ),
    );
    await expectCarrierFailure(
      "wrong-dependency-archive-name",
      wrongDependencyArchive,
      ["postgis"],
      /must name a portable static archive lib\*\.a directly under .*\/dependencies\/geos/u,
    );

    const skewedDependencyArchive = structuredClone(carrier);
    replaceExtensionRuntimeAsset(
      skewedDependencyArchive,
      "pgcrypto",
      await mutatedExtensionRuntime(
        root,
        "pgcrypto",
        "skewed-dependency-archive-name.tar.gz",
        async (stage) => {
          const manifestFile = path.join(stage, "manifest.properties");
          const manifest = await fs.readFile(manifestFile, "utf8");
          await fs.writeFile(
            manifestFile,
            manifest.replace(
              "/dependencies/openssl/libcrypto.a",
              "/dependencies/openssl/libssl.a",
            ),
          );
        },
      ),
    );
    await expectCarrierFailure(
      "skewed-dependency-archive-name",
      skewedDependencyArchive,
      ["pgcrypto"],
      /must use the same archive file name across both iOS static targets for dependency openssl/u,
    );

    const oversizedEnvelope = structuredClone(carrier);
    oversizedEnvelope.base.assets[0].bytes = 2 * 1024 * 1024 * 1024 + 1;
    await expectCarrierFailure(
      "oversized-carrier-envelope",
      oversizedEnvelope,
      [],
      /exceeds the maximum supported size/u,
    );

    const oversizedTar = path.join(root, "archives", "oversized-member.tar.gz");
    await craftedTar(oversizedTar, [{ name: "payload", type: "file" }]);
    await rewriteFirstTarSize(oversizedTar, 4 * 1024 * 1024 * 1024);
    const oversizedTarCarrier = structuredClone(carrier);
    replaceExtensionAssets(oversizedTarCarrier, "pgtap", [
      await logicalAsset("runtime-resources", oversizedTar, "tar.gz", "."),
    ]);
    await expectCarrierFailure(
      "oversized-archive-member",
      oversizedTarCarrier,
      ["pgtap"],
      /exceeds the maximum expanded member size/u,
    );

    // ICU ships thousands of small locale/resource files. Prove that its
    // validated role receives the narrowly scoped higher ceiling while the
    // same archive remains forbidden for ordinary runtime carriers.
    const highCardinalityIcuArchive = path.join(
      root,
      "archives",
      "liboliphaunt-1.0.0-high-cardinality-icu-data.tar.gz",
    );
    await highCardinalityIcuTar(highCardinalityIcuArchive, 4098);
    const highCardinalityIcu = structuredClone(carrier);
    highCardinalityIcu.base.assets = await Promise.all(
      highCardinalityIcu.base.assets.map(async (row) => row.role === "icu-data"
        ? asset("icu-data", highCardinalityIcuArchive, "tar.gz", "share/icu")
        : row),
    );
    const highCardinalityIcuFile = path.join(root, "high-cardinality-icu.json");
    await write(highCardinalityIcuFile, `${JSON.stringify(highCardinalityIcu, null, 2)}\n`);
    const highCardinalityIcuOutput = path.join(root, "high-cardinality-icu-output");
    await stageIosApp({
      allowFileUrls: true,
      cacheDir: path.join(root, "high-cardinality-icu-cache"),
      carriers: [highCardinalityIcuFile],
      extensions: [],
      icu: true,
      outputDir: highCardinalityIcuOutput,
    });
    await fs.access(path.join(
      highCardinalityIcuOutput,
      "resources",
      "OliphauntReactNativeResources.bundle",
      "oliphaunt",
      "runtime",
      "files",
      "share",
      "icu",
      "locale-4097.res",
    ));

    const highCardinalityRuntime = structuredClone(carrier);
    highCardinalityRuntime.base.assets = await Promise.all(
      highCardinalityRuntime.base.assets.map(async (row) => row.role === "runtime-resources"
        ? asset(
            "runtime-resources",
            highCardinalityIcuArchive,
            "tar.gz",
            "share/icu",
          )
        : row),
    );
    await expectCarrierFailure(
      "high-cardinality-non-icu",
      highCardinalityRuntime,
      [],
      /exceeds the maximum supported 4096 archive entries/u,
    );

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

    const ambiguousUnixArchive = path.join(root, "archives", "ambiguous-unix-types.zip");
    await metadataZip(ambiguousUnixArchive, "ambiguous-unix");
    const ambiguousUnix = structuredClone(carrier);
    ambiguousUnix.base.assets = await Promise.all(ambiguousUnix.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", ambiguousUnixArchive, "zip", "liboliphaunt.xcframework")
      : row));
    await expectCarrierFailure("ambiguous-unix-types", ambiguousUnix, [], /ambiguous Unix member type/u);

    const fatArchive = path.join(root, "archives", "fat-types.zip");
    await metadataZip(fatArchive, "fat");
    const fat = structuredClone(carrier);
    fat.base.assets = await Promise.all(fat.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", fatArchive, "zip", "liboliphaunt.xcframework")
      : row));
    const fatCarrierFile = path.join(root, "fat-types.json");
    await write(fatCarrierFile, `${JSON.stringify(fat, null, 2)}\n`);
    const fatOutput = path.join(root, "fat-types-output");
    await stageIosApp({
      allowFileUrls: true,
      cacheDir: path.join(root, "fat-types-cache"),
      carriers: [fatCarrierFile],
      extensions: [],
      icu: false,
      outputDir: fatOutput,
    });
    await fs.access(path.join(fatOutput, "frameworks", "base", "liboliphaunt.xcframework", "Info.plist"));

    const unicodeExtraArchive = path.join(root, "archives", "unicode-path-extra.zip");
    await metadataZip(unicodeExtraArchive, "unicode-extra");
    const unicodeExtra = structuredClone(carrier);
    unicodeExtra.base.assets = await Promise.all(unicodeExtra.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", unicodeExtraArchive, "zip", "liboliphaunt.xcframework")
      : row));
    await expectCarrierFailure(
      "unicode-path-extra",
      unicodeExtra,
      [],
      /unsupported ZIP .* extra metadata .* field 0x7075/u,
    );

    const unsupportedFlagsArchive = path.join(root, "archives", "unsupported-flags.zip");
    await metadataZip(unsupportedFlagsArchive, "fat");
    await addUnsupportedZipFlag(unsupportedFlagsArchive);
    const unsupportedFlags = structuredClone(carrier);
    unsupportedFlags.base.assets = await Promise.all(unsupportedFlags.base.assets.map(async (row) => row.role === "base-xcframework"
      ? asset("base-xcframework", unsupportedFlagsArchive, "zip", "liboliphaunt.xcframework")
      : row));
    await expectCarrierFailure(
      "unsupported-flags",
      unsupportedFlags,
      [],
      /unsupported ZIP general-purpose flags 0x20/u,
    );

    for (const [name, entries, pattern] of [
      ["tar-file-directory-marker", [{ name: "payload", type: "file" }], /member type\/path marker mismatch/u],
      ["tar-traversal", [{ name: "../payload", type: "file" }], /not a safe archive-relative path/u],
      ["tar-symlink", [{ name: "payload", type: "symlink" }], /link or special entry/u],
      ["tar-duplicate", [{ name: "payload", type: "file" }, { name: "payload", type: "file" }], /repeats a normalized archive member/u],
      ["tar-case-collision", [{ name: "Payload", type: "file" }, { name: "payload", type: "file" }], /case-colliding archive members/u],
      ["tar-file-as-parent", [{ name: "parent", type: "file" }, { name: "parent/child", type: "file" }], /uses file parent as an archive directory/u],
    ]) {
      const archive = path.join(root, "archives", `${name}.tar.gz`);
      await craftedTar(archive, entries);
      if (name === "tar-file-directory-marker") await addTarFileSlash(archive, "payload");
      const candidate = structuredClone(carrier);
      replaceExtensionAssets(candidate, "pgtap", [
        await logicalAsset("runtime-resources", archive, "tar.gz", "."),
      ]);
      await expectCarrierFailure(name, candidate, ["pgtap"], pattern);
    }

    const unstable = structuredClone(carrier);
    unstable.base.version = "1.0.0-rc.1";
    unstable.base.tag = "liboliphaunt-native-v1.0.0-rc.1";
    await expectCarrierFailure("unstable-version", unstable, [], /stable SemVer/u);

    const leadingZero = structuredClone(carrier);
    leadingZero.extensions.find(({ sqlName }) => sqlName === "pgtap").version = "01.0.0";
    leadingZero.extensions.find(({ sqlName }) => sqlName === "pgtap").tag =
      "oliphaunt-extension-pgtap-v01.0.0";
    await expectCarrierFailure("leading-zero-version", leadingZero, ["pgtap"], /stable SemVer/u);

    const fakeOwner = structuredClone(carrier);
    fakeOwner.extensions.find(({ sqlName }) => sqlName === "cube").product =
      "oliphaunt-extension-fake-cube";
    fakeOwner.extensions.find(({ sqlName }) => sqlName === "cube").tag =
      "oliphaunt-extension-fake-cube-v1.0.0";
    await expectCarrierFailure(
      "fake-owner",
      fakeOwner,
      ["cube"],
      /product must be canonical owner oliphaunt-extension-contrib-pg18/u,
    );

    const ownerVersionConflict = structuredClone(carrier);
    ownerVersionConflict.extensions.find(({ sqlName }) => sqlName === "earthdistance").version =
      "1.0.1";
    ownerVersionConflict.extensions.find(({ sqlName }) => sqlName === "earthdistance").tag =
      "oliphaunt-extension-contrib-pg18-v1.0.1";
    await expectCarrierFailure(
      "owner-version-conflict",
      ownerVersionConflict,
      ["earthdistance"],
      /conflicting release versions for owner oliphaunt-extension-contrib-pg18/u,
    );

    const wrongTag = structuredClone(carrier);
    wrongTag.extensions.find(({ sqlName }) => sqlName === "pgtap").tag = "unrelated-v1.0.0";
    await expectCarrierFailure("wrong-tag", wrongTag, ["pgtap"], /\.tag must be oliphaunt-extension-pgtap-v1\.0\.0/u);

    const malformedAssets = structuredClone(carrier);
    malformedAssets.extensions.find(({ sqlName }) => sqlName === "pgtap").assets = {};
    await expectCarrierFailure("malformed-assets", malformedAssets, ["pgtap"], /\.assets must be an array/u);

    const malformedRegistration = structuredClone(carrier);
    malformedRegistration.extensions.find(({ sqlName }) => sqlName === "cube").registration.symbols = "not-an-array";
    await expectCarrierFailure("malformed-registration", malformedRegistration, ["cube"], /registration\.symbols must be an array/u);

    const duplicateLocator = structuredClone(carrier);
    const duplicateLocatorPostgis = duplicateLocator.extensions.find(({ sqlName }) => sqlName === "postgis");
    duplicateLocatorPostgis.assets.push(structuredClone(duplicateLocatorPostgis.assets[0]));
    await expectCarrierFailure(
      "duplicate-asset-locator",
      duplicateLocator,
      ["postgis"],
      /repeats an asset locator identity/u,
    );

    const duplicateIdentity = structuredClone(carrier);
    const duplicateIdentityPostgis = duplicateIdentity.extensions.find(({ sqlName }) => sqlName === "postgis");
    const geosAsset = duplicateIdentityPostgis.assets.find(({ role }) => role === "dependency-xcframework");
    const geosEnvelope = duplicateIdentity.carriers.find(({ name }) => name === geosAsset.carrier);
    const duplicateGeosArchive = path.join(root, "archives", "postgis-geos-duplicate.zip");
    await fs.copyFile(new URL(geosEnvelope.url), duplicateGeosArchive);
    const duplicateGeos = await logicalAsset(
      "dependency-xcframework",
      duplicateGeosArchive,
      "zip",
      `nested/${path.posix.basename(geosAsset.member)}`,
    );
    duplicateIdentityPostgis.assets.push(duplicateGeos.locator);
    duplicateIdentity.carriers.push(duplicateGeos.envelope);
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
        carriers: carrier.carriers.filter(({ name }) =>
          carrier.extensions
            .find(({ sqlName }) => sqlName === "earthdistance")
            .assets.some(({ carrier: carrierName }) => carrierName === name)),
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

    const carrierLeafDependencySkew = structuredClone(carrier);
    const omittedPostgis = carrierLeafDependencySkew.extensions.find(
      ({ sqlName }) => sqlName === "postgis",
    );
    omittedPostgis.nativeDependencies = omittedPostgis.nativeDependencies.filter(
      (dependency) => dependency !== "geos",
    );
    omittedPostgis.assets = omittedPostgis.assets.filter(
      ({ member, role }) =>
        !(role === "dependency-xcframework" && member.endsWith("dependency_geos.xcframework")),
    );
    retainReferencedCarriers(carrierLeafDependencySkew);
    await expectCarrierFailure(
      "carrier-leaf-dependency-skew",
      carrierLeafDependencySkew,
      ["postgis"],
      /mobileStaticDependencyArchives must exactly cover both iOS static targets/u,
    );

    const wrongInventory = structuredClone(carrier);
    const postgis = wrongInventory.extensions.find(({ sqlName }) => sqlName === "postgis");
    postgis.assets = postgis.assets.filter(({ role }) => role !== "dependency-xcframework");
    retainReferencedCarriers(wrongInventory);
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
