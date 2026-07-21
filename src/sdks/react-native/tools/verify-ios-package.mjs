#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PREFIX = "verify-ios-package.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      result.push({ entry, file });
      if (entry.isDirectory()) {
        pending.push(file);
      }
    }
  }
  return result.sort((left, right) => compareText(left.file, right.file));
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

function requireExactDomain(actual, expected, label) {
  const canonicalExpected = [...new Set(expected)].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    fail(
      `${label} must match the exact canonical domain; ` +
        `actual=${actual.join(",") || "-"} expected=${canonicalExpected.join(",") || "-"}`,
    );
  }
}

function requirePortableSelectionId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    fail(`${label} must be a portable id; got ${JSON.stringify(value)}`);
  }
  return value;
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
  const selectedExtensions = portableCsv(runtime, "selectedExtensions", runtimeManifestFile);
  const extensions = portableCsv(runtime, "extensions", runtimeManifestFile);
  const stems = portableCsv(runtime, "nativeModuleStems", runtimeManifestFile);
  const runtimeRegistered = portableCsv(
    runtime,
    "mobileStaticRegistryRegistered",
    runtimeManifestFile,
  );
  const runtimePending = portableCsv(
    runtime,
    "mobileStaticRegistryPending",
    runtimeManifestFile,
  );
  const selectedSet = new Set(selectedExtensions);
  const unselectedCreateable = extensions.filter((extension) => !selectedSet.has(extension));
  if (unselectedCreateable.length > 0) {
    fail(
      `${runtimeManifestFile} extensions must be a subset of selectedExtensions; ` +
        `unselected=${unselectedCreateable.join(",")}`,
    );
  }
  const selectionFile = path.join(payloadDir, "selection.json");
  await requireFile(selectionFile, "iOS extension selection manifest");
  const selection = JSON.parse(await fs.readFile(selectionFile, "utf8"));
  if (!Array.isArray(selection.extensions)) {
    fail(`${selectionFile} extensions must be an array`);
  }
  const frozenRows = selection.extensions.map((extension, index) => {
    const label = `${selectionFile} extensions[${index}]`;
    const sqlName = requirePortableSelectionId(extension?.sqlName, `${label}.sqlName`);
    if (typeof extension?.createsExtension !== "boolean") {
      fail(`${label}.createsExtension must be boolean`);
    }
    if (extension.nativeModuleStem === undefined) {
      fail(`${label}.nativeModuleStem must be a portable id or null`);
    }
    if (extension.nativeModuleStem !== null) {
      requirePortableSelectionId(extension.nativeModuleStem, `${label}.nativeModuleStem`);
    }
    return extension;
  });
  const frozenSelected = frozenRows.map(({ sqlName }) => sqlName);
  requireExactDomain(frozenSelected, frozenSelected, `${selectionFile} extension SQL names`);
  const frozenCreateable = frozenRows
    .filter(({ createsExtension }) => createsExtension)
    .map(({ sqlName }) => sqlName);
  const frozenNative = frozenRows.filter(
    ({ nativeModuleStem }) => typeof nativeModuleStem === "string",
  );
  const frozenNativeExtensions = frozenNative.map(({ sqlName }) => sqlName);
  const frozenNativeStems = frozenNative.map(({ nativeModuleStem }) => nativeModuleStem);
  const frozenNativeDependencies = frozenNative.flatMap(({ sqlName, nativeDependencies }) => {
    if (!Array.isArray(nativeDependencies)) {
      fail(`${selectionFile} native extension ${sqlName} must list nativeDependencies`);
    }
    const dependencies = nativeDependencies.map((dependency) =>
      requirePortableSelectionId(dependency, `${selectionFile} nativeDependencies`));
    requireExactDomain(
      dependencies,
      dependencies,
      `${selectionFile} native extension ${sqlName} nativeDependencies`,
    );
    return dependencies;
  });
  requireExactDomain(selectedExtensions, frozenSelected, `${runtimeManifestFile} selectedExtensions`);
  requireExactDomain(extensions, frozenCreateable, `${runtimeManifestFile} extensions`);
  requireExactDomain(stems, frozenNativeStems, `${runtimeManifestFile} nativeModuleStems`);
  requireExactDomain(
    runtimeRegistered,
    frozenNativeExtensions,
    `${runtimeManifestFile} mobileStaticRegistryRegistered`,
  );
  requireExactDomain(runtimePending, [], `${runtimeManifestFile} mobileStaticRegistryPending`);
  requireProperty(
    runtime,
    "mobileStaticRegistryState",
    frozenNative.length > 0 ? "complete" : "not-required",
    runtimeManifestFile,
  );
  requireProperty(
    runtime,
    "mobileStaticRegistrySource",
    frozenNative.length > 0 ? "oliphaunt_static_registry.c" : "",
    runtimeManifestFile,
  );
  requireExactDomain(
    portableCsv(template, "extensions", templateManifestFile),
    [],
    `${templateManifestFile} extensions`,
  );
  requireExactDomain(
    portableCsv(template, "selectedExtensions", templateManifestFile),
    [],
    `${templateManifestFile} selectedExtensions`,
  );
  requireExactDomain(
    portableCsv(template, "nativeModuleStems", templateManifestFile),
    [],
    `${templateManifestFile} nativeModuleStems`,
  );
  requireExactDomain(
    portableCsv(template, "mobileStaticRegistryRegistered", templateManifestFile),
    [],
    `${templateManifestFile} mobileStaticRegistryRegistered`,
  );
  requireExactDomain(
    portableCsv(template, "mobileStaticRegistryPending", templateManifestFile),
    [],
    `${templateManifestFile} mobileStaticRegistryPending`,
  );
  requireProperty(
    template,
    "mobileStaticRegistryState",
    "not-required",
    templateManifestFile,
  );
  requireProperty(template, "mobileStaticRegistrySource", "", templateManifestFile);
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
  const staticRegistry = await readProperties(staticRegistryManifestFile);
  requireProperty(
    staticRegistry,
    "packageLayout",
    "oliphaunt-static-registry-v1",
    staticRegistryManifestFile,
  );
  requireProperty(staticRegistry, "abiVersion", "1", staticRegistryManifestFile);
  requireProperty(
    staticRegistry,
    "state",
    frozenNative.length > 0 ? "complete" : "not-required",
    staticRegistryManifestFile,
  );
  const registryStems = portableCsv(
    staticRegistry,
    "nativeModuleStems",
    staticRegistryManifestFile,
  );
  const modules = portableCsv(staticRegistry, "modules", staticRegistryManifestFile);
  const registeredExtensions = portableCsv(
    staticRegistry,
    "registeredExtensions",
    staticRegistryManifestFile,
  );
  const pendingExtensions = portableCsv(
    staticRegistry,
    "pendingExtensions",
    staticRegistryManifestFile,
  );
  const nativeDependencies = portableCsv(
    staticRegistry,
    "dependencyArchives",
    staticRegistryManifestFile,
  );
  const archiveTargets = portableCsv(
    staticRegistry,
    "archiveTargets",
    staticRegistryManifestFile,
  );
  const dependencyArchiveTargets = portableCsv(
    staticRegistry,
    "dependencyArchiveTargets",
    staticRegistryManifestFile,
  );
  requireExactDomain(
    registeredExtensions,
    frozenNativeExtensions,
    `${staticRegistryManifestFile} registeredExtensions`,
  );
  requireExactDomain(
    registryStems,
    frozenNativeStems,
    `${staticRegistryManifestFile} nativeModuleStems`,
  );
  requireExactDomain(modules, frozenNativeStems, `${staticRegistryManifestFile} modules`);
  requireExactDomain(pendingExtensions, [], `${staticRegistryManifestFile} pendingExtensions`);
  requireExactDomain(
    nativeDependencies,
    frozenNativeDependencies,
    `${staticRegistryManifestFile} dependencyArchives`,
  );
  requireExactDomain(
    archiveTargets,
    frozenNative.length > 0 ? ["ios-device", "ios-simulator"] : [],
    `${staticRegistryManifestFile} archiveTargets`,
  );
  requireExactDomain(
    dependencyArchiveTargets,
    frozenNativeDependencies.length > 0 ? ["ios-device", "ios-simulator"] : [],
    `${staticRegistryManifestFile} dependencyArchiveTargets`,
  );
  requireProperty(
    staticRegistry,
    "source",
    frozenNative.length > 0 ? "oliphaunt_static_registry.c" : "",
    staticRegistryManifestFile,
  );

  if (stems.length === 0) {
    if ((await statOrUndefined(generatedRegistry)) !== undefined) {
      fail("iOS package contains a generated static registry but runtime manifest has no nativeModuleStems");
    }
    if (packagedFrameworks.size > 0) {
      fail("iOS package links extension XCFrameworks but runtime manifest has no nativeModuleStems");
    }
  } else {
    requireProperty(
      staticRegistry,
      "source",
      "oliphaunt_static_registry.c",
      staticRegistryManifestFile,
    );
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
      `(selectedExtensions=${selectedExtensions.join(",") || "none"}, ` +
        `extensions=${extensions.join(",") || "none"}, ` +
        `nativeModuleStems=${stems.join(",") || "none"}, baseFrameworks=${baseFrameworks})`,
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
