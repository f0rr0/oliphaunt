import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ELECTRON_RELEASE_DEPENDENCIES = [
  {
    packageName: "@oliphaunt/ts",
    versionSource: { type: "json", path: "src/sdks/js/package.json", keys: ["version"] },
  },
  {
    packageName: "@oliphaunt/extension-hstore",
    versionSource: { type: "text", path: "src/extensions/contrib/hstore/VERSION" },
  },
  {
    packageName: "@oliphaunt/extension-pg-trgm",
    versionSource: { type: "text", path: "src/extensions/contrib/pg_trgm/VERSION" },
  },
  {
    packageName: "@oliphaunt/extension-unaccent",
    versionSource: { type: "text", path: "src/extensions/contrib/unaccent/VERSION" },
  },
];

const ELECTRON_SMOKE_PACKAGES = [
  {
    packageName: "@oliphaunt/liboliphaunt-linux-x64-gnu",
    versionSource: {
      type: "json",
      path: "src/runtimes/liboliphaunt/native/packages/linux-x64-gnu/package.json",
      keys: ["version"],
    },
  },
  {
    packageName: "@oliphaunt/tools-linux-x64-gnu",
    versionSource: {
      type: "json",
      path: "src/runtimes/liboliphaunt/native/tools-packages/linux-x64-gnu/package.json",
      keys: ["version"],
    },
  },
];

function fail(message) {
  console.error(`example-release-dependencies.mjs: ${message}`);
  process.exit(2);
}

function readJsonObject(root, relativePath) {
  const file = path.join(root, relativePath);
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${relativePath} must contain a JSON object`);
  }
  return value;
}

function readVersion(root, source, context) {
  if (source.type === "text") {
    const version = readFileSync(path.join(root, source.path), "utf8").trim();
    if (!version) {
      throw new Error(`${source.path} does not define a version for ${context}`);
    }
    return version;
  }
  if (source.type === "json") {
    let current = readJsonObject(root, source.path);
    for (const key of source.keys) {
      if (current === null || Array.isArray(current) || typeof current !== "object") {
        throw new Error(`${source.path} has no JSON object at ${source.keys.join(".")} for ${context}`);
      }
      current = current[key];
    }
    if (typeof current !== "string" || !current) {
      throw new Error(`${source.path} does not define a string version for ${context}`);
    }
    return current;
  }
  throw new Error(`${context} uses unsupported version source ${JSON.stringify(source.type)}`);
}

export function electronReleaseDependencies(root) {
  return ELECTRON_RELEASE_DEPENDENCIES.map((entry) => ({
    packageName: entry.packageName,
    version: readVersion(root, entry.versionSource, entry.packageName),
  }));
}

export function electronPackageVersion(root, packageName) {
  const entry = [...ELECTRON_RELEASE_DEPENDENCIES, ...ELECTRON_SMOKE_PACKAGES].find(
    (candidate) => candidate.packageName === packageName,
  );
  if (entry === undefined) {
    throw new Error(`unknown Electron example package ${JSON.stringify(packageName)}`);
  }
  return readVersion(root, entry.versionSource, packageName);
}

function printElectronPackageVersion(argv) {
  const packageName = argv[0];
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail("usage: example-release-dependencies.mjs electron-package-version <package-name>");
  }
  try {
    process.stdout.write(`${electronPackageVersion(process.cwd(), packageName)}\n`);
  } catch (error) {
    fail(error.message);
  }
}

const mainUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === mainUrl) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "electron-package-version") {
    printElectronPackageVersion(args);
  } else {
    fail("usage: example-release-dependencies.mjs electron-package-version <package-name>");
  }
}
