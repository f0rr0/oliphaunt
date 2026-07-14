#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PREFIX = "verify-ios-package.mjs";

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  console.error(
    `usage: ${PREFIX} (--package-dir <sdk-directory> | --payload-dir <app-owned-directory>) ` +
      `[--allow-runtime-dylib]`,
  );
}

function parseArgs(argv) {
  const args = {
    allowRuntimeDylib: false,
    packageDir: undefined,
    payloadDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-dir") {
      args.packageDir = argv[index + 1];
      index += 1;
    } else if (arg === "--payload-dir") {
      args.payloadDir = argv[index + 1];
      index += 1;
    } else if (arg === "--allow-runtime-dylib") {
      args.allowRuntimeDylib = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`unknown argument ${arg}`);
    }
  }
  const roots = [args.packageDir, args.payloadDir].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (roots.length !== 1) {
    usage();
    fail("exactly one of --package-dir or --payload-dir is required");
  }
  if (args.packageDir) args.packageDir = path.resolve(args.packageDir);
  if (args.payloadDir) args.payloadDir = path.resolve(args.payloadDir);
  return args;
}

async function statOrUndefined(file) {
  return fs.stat(file).catch((error) => {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function requireFile(file, label) {
  const stat = await statOrUndefined(file);
  if (stat?.isFile() !== true || stat.size === 0) {
    fail(`${label} is missing or empty: ${file}`);
  }
}

async function requireDirectory(file, label) {
  const stat = await statOrUndefined(file);
  if (stat?.isDirectory() !== true) {
    fail(`${label} is missing: ${file}`);
  }
}

async function walk(root) {
  const rootStat = await statOrUndefined(root);
  if (rootStat?.isDirectory() !== true) {
    return [];
  }
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      result.push({ entry, file });
      if (entry.isDirectory()) {
        pending.push(file);
      }
    }
  }
  return result.sort((left, right) => left.file.localeCompare(right.file));
}

async function requirePayloadFiles(root, label) {
  const entries = await walk(root);
  if (!entries.some(({ entry }) => entry.isFile())) {
    fail(`${label} contains no payload files: ${root}`);
  }
}

function parseProperties(text, source) {
  const values = new Map();
  for (const [lineIndex, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      fail(`${source}:${lineIndex + 1} is not a key=value property`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) {
      fail(`${source}:${lineIndex + 1} repeats property ${key}`);
    }
    values.set(key, value);
  }
  return values;
}

async function readProperties(file) {
  await requireFile(file, "runtime-resource manifest");
  return parseProperties(await fs.readFile(file, "utf8"), file);
}

function requireProperty(properties, key, expected, source) {
  const actual = properties.get(key);
  if (actual !== expected) {
    fail(`${source} must declare ${key}=${expected}; got ${actual ?? "<missing>"}`);
  }
}

function portableCsv(properties, key, source) {
  const value = properties.get(key);
  if (value === undefined) {
    fail(`${source} is missing ${key}`);
  }
  if (!value) {
    return [];
  }
  const items = value.split(",");
  const seen = new Set();
  for (const item of items) {
    if (!/^[A-Za-z0-9._-]+$/u.test(item)) {
      fail(`${source} ${key} contains invalid portable id ${JSON.stringify(item)}`);
    }
    if (seen.has(item)) {
      fail(`${source} ${key} repeats ${item}`);
    }
    seen.add(item);
  }
  return items;
}

async function validatePackageAllowlist(packageDir) {
  const packageJsonFile = path.join(packageDir, "package.json");
  await requireFile(packageJsonFile, "React Native package manifest");
  const manifest = JSON.parse(await fs.readFile(packageJsonFile, "utf8"));
  if (!Array.isArray(manifest.files)) {
    fail(`${packageJsonFile} must define an npm files allowlist`);
  }
  if (!manifest.files.some((entry) => entry === "ios" || entry.startsWith("ios/"))) {
    fail(`${packageJsonFile} files allowlist does not include the iOS package tree`);
  }
  for (const relative of ["extension-frameworks", "frameworks", "generated", "resources"]) {
    for (const suffix of ["", "/**"]) {
      const exclusion = `!ios/${relative}${suffix}`;
      if (!manifest.files.includes(exclusion)) {
        fail(`${packageJsonFile} must exclude app-specific payload via ${exclusion}`);
      }
    }
  }
  if (!manifest.files.includes("tools/verify-ios-package.mjs")) {
    fail(`${packageJsonFile} must publish tools/verify-ios-package.mjs for clean-install verification`);
  }
  if (!manifest.files.includes("tools/stage-ios-app.mjs")) {
    fail(`${packageJsonFile} must publish tools/stage-ios-app.mjs for app-owned iOS staging`);
  }
  await requireFile(
    path.join(packageDir, "OliphauntReactNative.podspec"),
    "React Native CocoaPods specification",
  );
  await requireFile(
    path.join(packageDir, "tools/verify-ios-package.mjs"),
    "installed iOS package verifier",
  );
  await requireFile(
    path.join(packageDir, "tools/stage-ios-app.mjs"),
    "app-owned iOS carrier resolver",
  );
  for (const relative of [
    "ios/resources",
    "ios/frameworks",
    "ios/extension-frameworks",
    "ios/generated",
  ]) {
    if ((await statOrUndefined(path.join(packageDir, relative))) !== undefined) {
      fail(`selection-neutral React Native base package contains generated payload ${relative}`);
    }
  }
}

async function validateBaseLibrary(payloadDir, resourceRoot, allowRuntimeDylib) {
  const frameworkRoot = path.join(payloadDir, "frameworks/base");
  const frameworkRootStat = await statOrUndefined(frameworkRoot);
  const frameworks =
    frameworkRootStat?.isDirectory() === true
      ? (await fs.readdir(frameworkRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() &&
              (entry.name.endsWith(".xcframework") || entry.name.endsWith(".framework")),
          )
          .map((entry) => ({ entry, file: path.join(frameworkRoot, entry.name) }))
      : [];
  const runtimeDylib = path.join(resourceRoot, "lib/liboliphaunt.dylib");
  if (frameworks.length > 0) {
    if (frameworks.length !== 1) {
      fail(`staged iOS package must contain exactly one base Apple framework; found ${frameworks.length}`);
    }
    if ((await statOrUndefined(runtimeDylib)) !== undefined) {
      fail(`staged iOS package contains both a base Apple framework and ${runtimeDylib}`);
    }
    for (const { entry, file } of frameworks) {
      await requireFile(path.join(file, "Info.plist"), `${entry.name} metadata`);
    }
    return frameworks.length;
  }
  if (!allowRuntimeDylib) {
    fail(
      `staged iOS package has no base .xcframework or .framework under ${frameworkRoot}; ` +
        "runtime dylibs are accepted only with --allow-runtime-dylib",
    );
  }
  await requireFile(runtimeDylib, "runtime-resource liboliphaunt dylib");
  return 0;
}

async function validateNoBuildInputsInResources(resourceRoot) {
  const forbidden = (await walk(resourceRoot)).filter(
    ({ entry }) =>
      (entry.isDirectory() && entry.name.endsWith(".xcframework")) ||
      (entry.isFile() && entry.name === "oliphaunt_static_registry.c") ||
      entry.name === "archives",
  );
  if (forbidden.length > 0) {
    fail(
      `iOS resource bundle contains build-only input(s): ${forbidden
        .map(({ file }) => file)
        .join(", ")}`,
    );
  }
}

async function validateStagedPackage(payloadDir, allowRuntimeDylib) {
  const resourceRoot = path.join(
    payloadDir,
    "resources/OliphauntReactNativeResources.bundle/oliphaunt",
  );
  await requireDirectory(resourceRoot, "React Native iOS runtime-resource bundle");
  const runtimeManifestFile = path.join(resourceRoot, "runtime/manifest.properties");
  const templateManifestFile = path.join(resourceRoot, "template-pgdata/manifest.properties");
  const runtime = await readProperties(runtimeManifestFile);
  const template = await readProperties(templateManifestFile);
  requireProperty(runtime, "schema", "oliphaunt-runtime-resources-v1", runtimeManifestFile);
  requireProperty(runtime, "layout", "postgres-runtime-files-v1", runtimeManifestFile);
  requireProperty(template, "schema", "oliphaunt-runtime-resources-v1", templateManifestFile);
  requireProperty(template, "layout", "postgres-template-pgdata-v1", templateManifestFile);
  const extensions = portableCsv(runtime, "extensions", runtimeManifestFile);
  const stems = portableCsv(runtime, "nativeModuleStems", runtimeManifestFile);
  portableCsv(template, "extensions", templateManifestFile);
  portableCsv(template, "nativeModuleStems", templateManifestFile);
  await requirePayloadFiles(path.join(resourceRoot, "runtime/files"), "iOS PostgreSQL runtime");
  await requirePayloadFiles(
    path.join(resourceRoot, "template-pgdata/files"),
    "iOS template PGDATA",
  );
  await requireFile(path.join(resourceRoot, "package-size.tsv"), "iOS package-size report");
  const baseFrameworks = await validateBaseLibrary(payloadDir, resourceRoot, allowRuntimeDylib);
  await validateNoBuildInputsInResources(resourceRoot);

  const generatedRegistry = path.join(
    payloadDir,
    "generated/static-registry/oliphaunt_static_registry.c",
  );
  const staticRegistryManifestFile = path.join(
    resourceRoot,
    "static-registry/manifest.properties",
  );
  const extensionFrameworkRoot = path.join(payloadDir, "frameworks/extensions");
  const extensionFrameworks = (await walk(extensionFrameworkRoot)).filter(
    ({ entry }) => entry.isDirectory() && entry.name.endsWith(".xcframework"),
  );
  const packagedFrameworks = new Set(extensionFrameworks.map(({ entry }) => entry.name));

  if (stems.length === 0) {
    if ((await statOrUndefined(generatedRegistry)) !== undefined) {
      fail("iOS package contains a generated static registry but runtime manifest has no nativeModuleStems");
    }
    if (packagedFrameworks.size > 0) {
      fail("iOS package links extension XCFrameworks but runtime manifest has no nativeModuleStems");
    }
  } else {
    requireProperty(runtime, "mobileStaticRegistryState", "complete", runtimeManifestFile);
    const staticRegistry = await readProperties(staticRegistryManifestFile);
    requireProperty(
      staticRegistry,
      "packageLayout",
      "oliphaunt-static-registry-v1",
      staticRegistryManifestFile,
    );
    requireProperty(staticRegistry, "abiVersion", "1", staticRegistryManifestFile);
    requireProperty(staticRegistry, "state", "complete", staticRegistryManifestFile);
    requireProperty(
      staticRegistry,
      "source",
      "oliphaunt_static_registry.c",
      staticRegistryManifestFile,
    );
    const registryStems = portableCsv(
      staticRegistry,
      "nativeModuleStems",
      staticRegistryManifestFile,
    );
    const modules = portableCsv(staticRegistry, "modules", staticRegistryManifestFile);
    const nativeDependencies = portableCsv(
      staticRegistry,
      "dependencyArchives",
      staticRegistryManifestFile,
    );
    if (JSON.stringify([...registryStems].sort()) !== JSON.stringify([...stems].sort())) {
      fail(
        `${staticRegistryManifestFile} nativeModuleStems does not match the runtime manifest; ` +
          `registry=${registryStems.join(",") || "-"} runtime=${stems.join(",") || "-"}`,
      );
    }
    if (JSON.stringify([...modules].sort()) !== JSON.stringify([...stems].sort())) {
      fail(
        `${staticRegistryManifestFile} modules does not match selected nativeModuleStems; ` +
          `modules=${modules.join(",") || "-"} stems=${stems.join(",") || "-"}`,
      );
    }
    await requireFile(generatedRegistry, "generated iOS static-extension registry source");
    const registrySource = await fs.readFile(generatedRegistry, "utf8");
    if (!registrySource.includes("liboliphaunt_selected_static_extensions")) {
      fail(`${generatedRegistry} does not define the selected static-extension registry`);
    }
    const expectedFrameworks = new Set([
      ...stems.map((stem) => `liboliphaunt_extension_${stem}.xcframework`),
      ...nativeDependencies.map(
        (dependency) => `liboliphaunt_dependency_${dependency}.xcframework`,
      ),
    ]);
    const missing = [...expectedFrameworks].filter((name) => !packagedFrameworks.has(name));
    const extra = [...packagedFrameworks].filter((name) => !expectedFrameworks.has(name));
    if (missing.length > 0 || extra.length > 0) {
      fail(
        `iOS extension XCFramework selection mismatch; missing=${missing.sort().join(",") || "-"} ` +
          `extra=${extra.sort().join(",") || "-"}`,
      );
    }
    for (const { entry, file } of extensionFrameworks) {
      await requireFile(path.join(file, "Info.plist"), `${entry.name} metadata`);
    }
  }

  console.log(
    `${PREFIX}: verified ${payloadDir} ` +
      `(extensions=${extensions.join(",") || "none"}, nativeModuleStems=${stems.join(",") || "none"}, baseFrameworks=${baseFrameworks})`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.packageDir) {
    await validatePackageAllowlist(args.packageDir);
    console.log(`${PREFIX}: verified selection-neutral package contract for ${args.packageDir}`);
  } else {
    await validateStagedPackage(args.payloadDir, args.allowRuntimeDylib);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
