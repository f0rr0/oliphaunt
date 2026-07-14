#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from "./ios-carrier-manifest.mjs";
import { manualCargoPackageSource } from "./cargo-source-package.mjs";
import { prepareRustReleaseSource } from "./prepare-rust-release-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREFIX = "build-sdk-ci-artifacts.mjs";
const BUN = process.execPath;
const SDK_PRODUCTS = [
  "oliphaunt-rust",
  "oliphaunt-swift",
  "oliphaunt-kotlin",
  "oliphaunt-js",
  "oliphaunt-react-native",
  "oliphaunt-wasix-rust",
];

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function requireFile(file) {
  if (!isFile(file)) {
    fail(`missing package-shape output: ${rel(file)}`);
  }
}

function requireDir(file) {
  if (!isDirectory(file)) {
    fail(`missing package-shape output directory: ${rel(file)}`);
  }
}

function commandCandidates(command) {
  if (command.includes("/") || command.includes("\\")) {
    return [path.resolve(ROOT, command)];
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""];
  return pathEntries.flatMap((entry) => extensions.map((extension) => path.join(entry, `${command}${extension}`)));
}

function requireCommand(command) {
  for (const candidate of commandCandidates(command)) {
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return;
    } catch {
      // Keep scanning PATH.
    }
  }
  fail(`missing required command: ${command}`);
}

function copyDirContents(source, destination, { filter = () => true } = {}) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    cpSync(sourcePath, destinationPath, {
      recursive: true,
      filter,
    });
  }
}

function run(command, args, { cwd = ROOT, env = process.env, capture = false, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = capture && result.stderr ? result.stderr.trim() : "";
    fail(`${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function cargoPackageDir() {
  let targetDir = process.env.CARGO_TARGET_DIR ?? path.join(ROOT, "target");
  if (!path.isAbsolute(targetDir)) {
    targetDir = path.join(ROOT, targetDir);
  }
  return path.join(targetDir, "package");
}

function rustCrateName(manifest) {
  return run(
    BUN,
    ["tools/release/cargo-crate-filename.mjs", manifest],
    { capture: true, label: "cargo crate filename" },
  ).trim();
}

function pnpmPackManifest(envelope) {
  const manifests = Array.isArray(envelope) ? envelope : [envelope];
  if (manifests.length !== 1) {
    return null;
  }
  const [manifest] = manifests;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    typeof manifest.filename !== "string" ||
    !manifest.filename.endsWith(".tgz")
  ) {
    return null;
  }
  return manifest;
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n" && index + 1 < text.length) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function parsePackEnvelope(text) {
  try {
    const envelope = JSON.parse(text);
    const manifest = pnpmPackManifest(envelope);
    return manifest ? { envelope, manifest } : null;
  } catch {
    return null;
  }
}

function prefixContainsPackEnvelope(prefix) {
  const starts = lineStartOffsets(prefix);
  const ends = [...starts.slice(1).map((offset) => offset - 1), prefix.length];
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) {
        continue;
      }
      const candidate = prefix.slice(start, end).trim();
      if ((candidate.startsWith("{") || candidate.startsWith("[")) && parsePackEnvelope(candidate)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse the final machine-readable envelope from `pnpm pack --json` output.
 * Lifecycle scripts are allowed to log before the envelope, but a second pack
 * envelope is rejected so a stale or substituted filename cannot be selected.
 */
export function parsePnpmPackOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    throw new Error("pnpm pack produced no output");
  }

  const candidates = [];
  for (const offset of lineStartOffsets(text)) {
    const candidate = text.slice(offset).trimStart();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
      continue;
    }
    const parsed = parsePackEnvelope(candidate);
    if (parsed) {
      candidates.push({ ...parsed, offset: text.length - candidate.length });
    }
  }
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.offset, candidate])).values()];
  if (uniqueCandidates.length !== 1) {
    throw new Error(
      `pnpm pack output must end with exactly one JSON envelope containing one .tgz filename; found ${uniqueCandidates.length}`,
    );
  }

  const [selected] = uniqueCandidates;
  if (prefixContainsPackEnvelope(text.slice(0, selected.offset))) {
    throw new Error("pnpm pack output contained more than one JSON package envelope");
  }
  return { envelope: selected.envelope, manifest: selected.manifest };
}

function packageNpmWorkspace(packageDir, destination) {
  requireCommand("pnpm");
  mkdirSync(destination, { recursive: true });
  const packJson = run(
    "pnpm",
    ["--dir", packageDir, "pack", "--pack-destination", destination, "--json"],
    { capture: true, label: "pnpm pack" },
  );
  let parsed;
  try {
    parsed = parsePnpmPackOutput(packJson);
  } catch (error) {
    fail(`pnpm pack did not report an unambiguous JSON envelope: ${error.message}`);
  }
  const { envelope, manifest } = parsed;
  writeFileSync(path.join(destination, "pnpm-pack.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  const packFile = path.isAbsolute(manifest.filename)
    ? manifest.filename
    : path.join(destination, manifest.filename);
  if (!isFile(packFile)) {
    fail(`pnpm pack did not create ${rel(packFile)}`);
  }
}

function stageJsrSourceWorkspace(packageDir, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  copyDirContents(packageDir, destination, {
    filter: (source) => {
      const relative = path.relative(packageDir, source);
      if (!relative) {
        return true;
      }
      const [topLevel] = relative.split(path.sep);
      return !new Set(["node_modules", "lib", ".turbo"]).has(topLevel);
    },
  });
  requireFile(path.join(destination, "jsr.json"));
  requireFile(path.join(destination, "package.json"));
  requireDir(path.join(destination, "src"));
}

function kotlinVersion() {
  const gradleProperties = readFileSync(path.join(ROOT, "src/sdks/kotlin/gradle.properties"), "utf8");
  const versions = gradleProperties
    .split(/\r?\n/u)
    .map((line) => line.match(/^VERSION_NAME=(.+)$/u)?.[1]?.trim())
    .filter(Boolean);
  const version = versions.at(-1);
  if (!version) {
    fail("missing VERSION_NAME in src/sdks/kotlin/gradle.properties");
  }
  return version;
}

function stageRustSdkArtifacts(artifactRoot, workRoot) {
  requireCommand("cargo");
  const packageListing = path.join(ROOT, "target/liboliphaunt-sdk-check/rust-cargo-package-list.txt");
  requireFile(packageListing);

  const releaseManifest = prepareRustReleaseSource({
    stageDir: path.join(workRoot, "oliphaunt-release-source"),
    log: false,
  });
  const releaseCrate = manualCargoPackageSource(
    releaseManifest,
    path.join(workRoot, "oliphaunt-release-crate"),
    { root: ROOT, fail, rel },
  );
  requireFile(releaseCrate);
  copyFileSync(releaseCrate, path.join(artifactRoot, path.basename(releaseCrate)));

  const buildPackage = "oliphaunt-build";
  run("cargo", ["package", "-p", buildPackage, "--locked", "--allow-dirty", "--no-verify"], {
    label: `cargo package ${buildPackage}`,
  });
  const buildManifest = path.join(ROOT, "src/sdks/rust/crates/oliphaunt-build/Cargo.toml");
  const buildCrateName = rustCrateName(buildManifest);
  const packagedBuildCrate = path.join(cargoPackageDir(), buildCrateName);
  requireFile(packagedBuildCrate);
  copyFileSync(packagedBuildCrate, path.join(artifactRoot, buildCrateName));
  copyFileSync(packageListing, path.join(artifactRoot, "cargo-package-files.txt"));
}

function stageSwiftArtifacts(artifactRoot, workRoot) {
  requireCommand("swift");
  const swiftSourceArchive = path.join(
    ROOT,
    "target/liboliphaunt-sdk-check/oliphaunt-swift/package-shape/swift-source-archive/Oliphaunt-source.zip",
  );
  requireFile(swiftSourceArchive);
  copyFileSync(swiftSourceArchive, path.join(artifactRoot, "Oliphaunt-source.zip"));
  const assetDir = process.env.OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail("oliphaunt-swift package artifacts require OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR");
  }
  run(BUN, [
    "tools/release/render_swiftpm_release_package.mjs",
    "--asset-dir",
    assetDir,
    "--output",
    path.join(artifactRoot, "Package.swift.release"),
    "--generated-tree",
    path.join(workRoot, "swiftpm-release-tree"),
  ], { label: "render SwiftPM release package" });
  const releaseTree = path.join(artifactRoot, "release-tree");
  rmSync(releaseTree, { recursive: true, force: true });
  copyDirContents(path.join(workRoot, "swiftpm-release-tree"), releaseTree);
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  const carrierFile = path.join(
    releaseTree,
    "src/sdks/swift/Carriers",
    IOS_CARRIER_FILENAME,
  );
  mkdirSync(path.dirname(carrierFile), { recursive: true });
  writeFileSync(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`, "utf8");
  const manifest = readFileSync(path.join(artifactRoot, "Package.swift.release"), "utf8");
  for (const fragment of [
    "liboliphaunt-native-v",
    '.library(name: "COliphaunt"',
    '.library(name: "OliphauntExtensionSupport"',
    'path: "src/sdks/swift/Sources/OliphauntExtensionSupport"',
  ]) {
    if (!manifest.includes(fragment)) {
      fail(`staged SwiftPM release manifest is missing ${JSON.stringify(fragment)}`);
    }
  }
  if (manifest.includes("file://")) {
    fail("staged SwiftPM release manifest must not contain local file URLs");
  }
  const generatorRoot = path.join(artifactRoot, "extension-generator");
  mkdirSync(generatorRoot, { recursive: true });
  for (const name of [
    "render-extension-products.mjs",
    "swift-carrier-resolver.mjs",
    "swiftpm-extension-input.schema.json",
  ]) {
    copyFileSync(
      path.join(ROOT, "src/sdks/swift/tools", name),
      path.join(generatorRoot, name),
    );
  }
}

function stageKotlinArtifacts(artifactRoot, workRoot) {
  const mavenRepo = path.join(workRoot, "maven-local");
  const buildRoot = path.join(workRoot, "gradle-build");
  const cxxRoot = path.join(workRoot, "cxx-build");
  const cacheRoot = path.join(workRoot, "gradle-cache");
  const version = kotlinVersion();
  run(path.join(ROOT, "src/sdks/kotlin/gradlew"), [
    "-p",
    path.join(ROOT, "src/sdks/kotlin"),
    ":oliphaunt:publishAndroidReleasePublicationToMavenLocal",
    ":oliphaunt-android-gradle-plugin:publishToMavenLocal",
    `-Dmaven.repo.local=${mavenRepo}`,
    "-PoliphauntAndroidAbiFilters=arm64-v8a,x86_64",
    `-PoliphauntBuildRoot=${buildRoot}`,
    `-PoliphauntCxxBuildRoot=${cxxRoot}`,
    "--project-cache-dir",
    cacheRoot,
    "--no-configuration-cache",
  ], { label: "Kotlin SDK Gradle package artifacts" });
  requireFile(path.join(mavenRepo, `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}.aar`));
  requireFile(path.join(mavenRepo, `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}.jar`));
  const destination = path.join(artifactRoot, "maven");
  copyDirContents(mavenRepo, destination);
}

function stageJsArtifacts(artifactRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-js/package-shape/src/sdks/js");
  requireDir(packageShapeDir);
  packageNpmWorkspace(packageShapeDir, artifactRoot);
  stageJsrSourceWorkspace(packageShapeDir, path.join(artifactRoot, "jsr-source"));
}

function stageReactNativeArtifacts(artifactRoot) {
  const packageShapeDir = path.join(ROOT, "target/liboliphaunt-sdk-check/oliphaunt-react-native/package-shape/src/sdks/react-native");
  requireDir(packageShapeDir);
  const assetDir = process.env.OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail("oliphaunt-react-native package artifacts require OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR");
  }
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  writeFileSync(
    path.join(packageShapeDir, IOS_CARRIER_FILENAME),
    `${JSON.stringify(carrier, null, 2)}\n`,
    "utf8",
  );
  const packageJsonFile = path.join(packageShapeDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));
  packageJson.oliphaunt = {
    ...(packageJson.oliphaunt ?? {}),
    iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
  };
  packageJson.files = [...new Set([...(packageJson.files ?? []), IOS_CARRIER_FILENAME])];
  packageJson.exports = {
    ".": {
      types: "./lib/typescript/index.d.ts",
      "react-native": "./lib/module/index.js",
      import: "./lib/module/index.js",
      require: "./lib/commonjs/index.js",
      default: "./lib/module/index.js",
    },
    "./ios-carriers": `./${IOS_CARRIER_FILENAME}`,
    "./package.json": "./package.json",
  };
  writeFileSync(packageJsonFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  packageNpmWorkspace(packageShapeDir, artifactRoot);
  const carrierEvidence = path.join(artifactRoot, "ios-carriers", IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierEvidence), { recursive: true });
  writeFileSync(carrierEvidence, `${JSON.stringify(carrier, null, 2)}\n`, "utf8");
}

function stageWasixRustArtifacts(artifactRoot) {
  requireCommand("cargo");
  const packageListing = path.join(ROOT, "target/oliphaunt-wasix-rust/package/oliphaunt-wasix.package-files.txt");
  requireFile(packageListing);
  run(BUN, ["tools/release/package_oliphaunt_wasix_sdk_crate.mjs", "--output-dir", artifactRoot], {
    label: "package oliphaunt-wasix SDK crate",
  });
  copyFileSync(packageListing, path.join(artifactRoot, "cargo-package-files.txt"));
}

function writeArtifactIndex(artifactRoot) {
  const entries = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name))
    .sort(compareText);
  if (entries.length === 0) {
    fail("no SDK artifacts were staged");
  }
  const index = path.join(artifactRoot, "artifacts.txt");
  const lines = [...entries, index].sort(compareText).map((entry) => rel(entry));
  writeFileSync(index, `${lines.join("\n")}\n`);
}

function main() {
  const product = Bun.argv[2] ?? "";
  if (product === "--help" || product === "-h") {
    console.log(`usage: tools/release/build-sdk-ci-artifacts.mjs <${SDK_PRODUCTS.join("|")}>`);
    process.exit(0);
  }
  if (!product) {
    fail(`usage: tools/release/build-sdk-ci-artifacts.mjs <${SDK_PRODUCTS.join("|")}>`);
  }
  if (!SDK_PRODUCTS.includes(product)) {
    fail(`unsupported SDK product: ${product}`);
  }

  const artifactRoot = path.join(ROOT, "target/sdk-artifacts", product);
  const workRoot = path.join(ROOT, "target/sdk-artifacts-work", product);
  rmSync(artifactRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  if (product === "oliphaunt-rust") {
    stageRustSdkArtifacts(artifactRoot, workRoot);
  } else if (product === "oliphaunt-swift") {
    stageSwiftArtifacts(artifactRoot, workRoot);
  } else if (product === "oliphaunt-kotlin") {
    stageKotlinArtifacts(artifactRoot, workRoot);
  } else if (product === "oliphaunt-js") {
    stageJsArtifacts(artifactRoot);
  } else if (product === "oliphaunt-react-native") {
    stageReactNativeArtifacts(artifactRoot);
  } else if (product === "oliphaunt-wasix-rust") {
    stageWasixRustArtifacts(artifactRoot);
  }

  writeArtifactIndex(artifactRoot);
  run(BUN, ["tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product], {
    label: "check staged SDK artifacts",
  });
  console.log(`Staged ${product} SDK artifacts under ${rel(artifactRoot)}`);
}

if (import.meta.main) {
  main();
}
