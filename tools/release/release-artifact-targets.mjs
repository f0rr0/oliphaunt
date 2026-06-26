import fs from "node:fs/promises";
import path from "node:path";

import { runMoon } from "../policy/moon.mjs";

export const ROOT = path.resolve(import.meta.dir, "../..");

const DESKTOP_TARGETS = {
  "linux-arm64-gnu": {
    archive: "tar.gz",
    brokerExecutable: "bin/oliphaunt-broker",
    nodeDirectLibrary: "oliphaunt_node.node",
  },
  "linux-x64-gnu": {
    archive: "tar.gz",
    brokerExecutable: "bin/oliphaunt-broker",
    nodeDirectLibrary: "oliphaunt_node.node",
  },
  "macos-arm64": {
    archive: "tar.gz",
    brokerExecutable: "bin/oliphaunt-broker",
    nodeDirectLibrary: "oliphaunt_node.node",
  },
  "windows-x64-msvc": {
    archive: "zip",
    brokerExecutable: "bin/oliphaunt-broker.exe",
    nodeDirectLibrary: "oliphaunt_node.node",
  },
};

const PRODUCT_PRESETS = {
  "oliphaunt-broker": "broker-helper",
  "oliphaunt-node-direct": "node-direct-addon",
};

export function fail(prefix, message) {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function archiveAsset(product, target, archive) {
  return `${product}-{version}-${target}.${archive}`;
}

function parseCargoVersion(text, file, prefix) {
  let inPackage = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "[package]") {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith("[")) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    const match = line.match(/^version\s*=\s*"([^"]+)"/u);
    if (match) {
      return match[1];
    }
  }
  fail(prefix, `${rel(file)} does not define a package version`);
}

async function readJson(file, prefix) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail(prefix, `failed to read ${rel(file)}: ${error.message}`);
  }
}

function moonReleaseProducts(prefix) {
  const value = JSON.parse(runMoon(["query", "projects"]));
  if (!Array.isArray(value.projects)) {
    fail(prefix, "moon query projects did not return a projects array");
  }
  const products = new Map();
  for (const project of value.projects) {
    const id = project?.id;
    const release = project?.config?.project?.metadata?.release;
    if (release === undefined) {
      continue;
    }
    if (typeof id !== "string" || typeof release !== "object" || release === null) {
      fail(prefix, "Moon release metadata returned an invalid product row");
    }
    products.set(id, release);
  }
  return products;
}

export function releaseMetadata(product, prefix) {
  const release = moonReleaseProducts(prefix).get(product);
  if (!release) {
    fail(prefix, `Moon release metadata does not include ${product}`);
  }
  if (release.component !== product) {
    fail(prefix, `Moon release metadata for ${product} must use matching component`);
  }
  if (typeof release.packagePath !== "string" || !release.packagePath) {
    fail(prefix, `Moon release metadata for ${product} must declare packagePath`);
  }
  const artifactTargets = release.artifactTargets;
  const expectedPreset = PRODUCT_PRESETS[product];
  if (
    typeof artifactTargets !== "object" ||
    artifactTargets === null ||
    artifactTargets.preset !== expectedPreset
  ) {
    fail(prefix, `Moon release metadata for ${product} must use artifactTargets preset ${expectedPreset}`);
  }
  return release;
}

export async function currentProductVersion(product, prefix) {
  const release = releaseMetadata(product, prefix);
  const packagePath = release.packagePath;
  const config = await readJson(path.join(ROOT, "release-please-config.json"), prefix);
  const packageConfig = config.packages?.[packagePath];
  if (typeof packageConfig !== "object" || packageConfig === null) {
    fail(prefix, `release-please-config.json does not include ${packagePath}`);
  }
  const versionFile =
    packageConfig["version-file"] ??
    (packageConfig["release-type"] === "rust"
      ? "Cargo.toml"
      : packageConfig["release-type"] === "node"
        ? "package.json"
        : null);
  if (typeof versionFile !== "string" || !versionFile) {
    fail(prefix, `${product} release-please config must declare a supported version file`);
  }
  const file = path.join(ROOT, packagePath, versionFile);
  const text = await fs.readFile(file, "utf8");
  if (path.basename(versionFile) === "Cargo.toml") {
    return parseCargoVersion(text, file, prefix);
  }
  if (path.basename(versionFile) === "package.json") {
    const data = JSON.parse(text);
    if (typeof data.version === "string" && data.version) {
      return data.version;
    }
  } else if (path.basename(versionFile) === "VERSION") {
    const version = text.trim();
    if (version) {
      return version;
    }
  }
  fail(prefix, `${rel(file)} does not define a release version for ${product}`);
}

export function artifactTargets(product, kind, prefix) {
  const release = releaseMetadata(product, prefix);
  const publishedTargets = release.artifactTargets.publishedTargets;
  if (
    !Array.isArray(publishedTargets) ||
    !publishedTargets.every((target) => typeof target === "string" && target)
  ) {
    fail(prefix, `Moon release metadata for ${product} must declare publishedTargets`);
  }
  const targets = [];
  for (const target of [...publishedTargets].sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    if (!platform) {
      fail(prefix, `unknown ${product} artifact target ${target}`);
    }
    if (product === "oliphaunt-broker") {
      targets.push({
        id: `${product}.${target}`,
        product,
        kind,
        target,
        asset: archiveAsset(product, target, platform.archive),
        executableRelativePath: platform.brokerExecutable,
      });
    } else if (product === "oliphaunt-node-direct") {
      targets.push({
        id: `${product}.${target}`,
        product,
        kind,
        target,
        asset: archiveAsset(product, target, platform.archive),
        libraryRelativePath: platform.nodeDirectLibrary,
      });
    } else {
      fail(prefix, `unsupported product ${product}`);
    }
  }
  return targets;
}

export function expectedAssets(product, kind, version, prefix) {
  const assets = artifactTargets(product, kind, prefix).map((target) =>
    target.asset.replaceAll("{version}", version),
  );
  assets.push(`${product}-${version}-release-assets.sha256`);
  return assets.sort(compareText);
}
