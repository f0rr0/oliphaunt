#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PREFIX = "ios-icu-autolinking.test.mjs";
const COLLIDING_RESOURCE = "zh_TW.res";
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const COMMUNITY_CLI_VERSION = "20.2.0";
const COMMUNITY_CLI_PACKAGES = [
  "@react-native-community/cli",
  "@react-native-community/cli-platform-android",
  "@react-native-community/cli-platform-ios",
];

function usage() {
  console.error(
    `usage: ${PREFIX} --react-native-tarball <archive.tgz> ` +
      `--icu-source <icu-npm-directory> --expo-project <expo-project-directory>`,
  );
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") {
      usage();
      process.exit(0);
    }
    if (!new Set(["--react-native-tarball", "--icu-source", "--expo-project"]).has(name)) {
      usage();
      throw new Error(`${PREFIX}: unknown argument ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      usage();
      throw new Error(`${PREFIX}: ${name} requires a value`);
    }
    options.set(name, path.resolve(value));
    index += 1;
  }
  for (const name of ["--react-native-tarball", "--icu-source", "--expo-project"]) {
    if (!options.has(name)) {
      usage();
      throw new Error(`${PREFIX}: missing ${name}`);
    }
  }
  return {
    expoProject: options.get("--expo-project"),
    icuSource: options.get("--icu-source"),
    reactNativeTarball: options.get("--react-native-tarball"),
  };
}

function run(command, args, { cwd = undefined, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

async function requireFile(file, label) {
  const stat = await fs.stat(file).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  assert.equal(stat?.isFile(), true, `${label} is missing: ${file}`);
  assert.ok(stat.size > 0, `${label} is empty: ${file}`);
}

async function write(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function copyIcuDescriptors(source, destination, { legacyFlatteningControl }) {
  for (const descriptor of ["package.json", "README.md", "OliphauntICU.podspec"]) {
    await requireFile(path.join(source, descriptor), `source ICU ${descriptor}`);
  }
  await fs.copyFile(path.join(source, "README.md"), path.join(destination, "README.md"));

  const packageJson = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@oliphaunt/icu");
  if (!legacyFlatteningControl) {
    assert.ok(
      packageJson.files?.includes("react-native.config.js"),
      "@oliphaunt/icu must publish react-native.config.js",
    );
    assert.ok(
      packageJson.files?.includes("OliphauntICU.bundle"),
      "@oliphaunt/icu must publish its structure-preserving resource bundle",
    );
    assert.equal(
      packageJson.oliphaunt?.dataRelativePath,
      "OliphauntICU.bundle/share/icu",
      "@oliphaunt/icu metadata must select ICU data within the resource bundle",
    );
    await requireFile(
      path.join(source, "react-native.config.js"),
      "source ICU react-native.config.js",
    );
    await fs.copyFile(
      path.join(source, "react-native.config.js"),
      path.join(destination, "react-native.config.js"),
    );
  } else {
    packageJson.files = (packageJson.files ?? [])
      .filter((member) => member !== "react-native.config.js" && member !== "OliphauntICU.bundle");
    packageJson.files.push("share");
    packageJson.oliphaunt = {
      ...(packageJson.oliphaunt ?? {}),
      dataRelativePath: "share/icu",
    };
  }
  await fs.writeFile(
    path.join(destination, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  const sourcePodspec = await fs.readFile(path.join(source, "OliphauntICU.podspec"), "utf8");
  let podspec = sourcePodspec;
  if (legacyFlatteningControl) {
    podspec = sourcePodspec.replace(
      /^  s\.resources = ['"]OliphauntICU\.bundle['"]$/mu,
      "  s.resource_bundles = {\n    'OliphauntICU' => ['share/icu/**/*']\n  }",
    );
    assert.notEqual(
      podspec,
      sourcePodspec,
      "legacy control must replace the source structure-preserving resource declaration",
    );
  }
  await fs.writeFile(path.join(destination, "OliphauntICU.podspec"), podspec);

  // These paths model the collision that the real ICU tree exposes hundreds of
  // times. The names deliberately match while their source directories do not.
  const resourceRoot = legacyFlatteningControl
    ? path.join(destination, "share/icu")
    : path.join(destination, "OliphauntICU.bundle/share/icu");
  await write(
    path.join(resourceRoot, "icudt-test/coll", COLLIDING_RESOURCE),
    "collation fixture\n",
  );
  await write(
    path.join(resourceRoot, "icudt-test/lang", COLLIDING_RESOURCE),
    "language fixture\n",
  );
}

async function packIcuFixture(source, root, name, { legacyFlatteningControl }) {
  const stage = path.join(root, `${name}-source`);
  const destination = path.join(root, `${name}-pack`);
  await fs.mkdir(stage, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  await copyIcuDescriptors(source, stage, { legacyFlatteningControl });
  run(
    PNPM,
    ["--dir", stage, "pack", "--pack-destination", destination],
    { env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: "true" } },
  );
  const archives = (await fs.readdir(destination))
    .filter((entry) => entry.endsWith(".tgz"))
    .sort();
  assert.equal(archives.length, 1, `${name} fixture must produce exactly one npm archive`);
  return path.join(destination, archives[0]);
}

async function extractNpmPackage(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  run("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"]);
}

async function resolveBareToolchain(expoProject) {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(expoProject, "package.json"), "utf8"),
  );
  const resolver = createRequire(path.join(expoProject, "package.json"));
  const packages = new Map();
  for (const name of COMMUNITY_CLI_PACKAGES) {
    assert.equal(
      packageJson.devDependencies?.[name],
      COMMUNITY_CLI_VERSION,
      `${name} must be workspace-pinned to ${COMMUNITY_CLI_VERSION}`,
    );
    const manifestPath = resolver.resolve(`${name}/package.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.version, COMMUNITY_CLI_VERSION, `${name} installed version drifted`);
    packages.set(name, { manifest, root: path.dirname(manifestPath) });
  }
  const reactNativeManifestPath = resolver.resolve("react-native/package.json");
  const reactNativeManifest = JSON.parse(await fs.readFile(reactNativeManifestPath, "utf8"));
  packages.set("react-native", {
    manifest: reactNativeManifest,
    root: path.dirname(reactNativeManifestPath),
  });
  const cli = packages.get("@react-native-community/cli");
  const cliBin = typeof cli.manifest.bin === "string"
    ? cli.manifest.bin
    : cli.manifest.bin?.["rnc-cli"] ?? Object.values(cli.manifest.bin ?? {})[0];
  assert.equal(typeof cliBin, "string", "Community CLI package must declare its executable");
  return { cliBin: path.join(cli.root, cliBin), packages };
}

async function linkPackage(root, name, source) {
  const destination = path.join(root, "node_modules", ...name.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(
    await fs.realpath(source),
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeConsumer(root, reactNativeTarball, icuTarball, bareToolchain) {
  const reactNativeRoot = path.join(root, "node_modules/@oliphaunt/react-native");
  const icuRoot = path.join(root, "node_modules/@oliphaunt/icu");
  await extractNpmPackage(reactNativeTarball, reactNativeRoot);
  await extractNpmPackage(icuTarball, icuRoot);
  const cliDependencies = Object.fromEntries(
    COMMUNITY_CLI_PACKAGES.map((name) => [
      name,
      bareToolchain.packages.get(name).manifest.version,
    ]),
  );
  await write(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "oliphaunt-ios-autolinking-fixture",
      private: true,
      version: "0.0.0",
      dependencies: {
        "@oliphaunt/icu": "0.0.0",
        "@oliphaunt/react-native": "0.0.0",
        "react-native": bareToolchain.packages.get("react-native").manifest.version,
      },
      devDependencies: cliDependencies,
    }, null, 2)}\n`,
  );
  for (const [name, descriptor] of bareToolchain.packages) {
    await linkPackage(root, name, descriptor.root);
  }
  return { icuRoot, reactNativeRoot };
}

function autolink(expoProject, consumer, platform) {
  const output = run(PNPM, [
    "--dir",
    expoProject,
    "exec",
    "expo-modules-autolinking",
    "react-native-config",
    path.join(consumer, "node_modules"),
    "--project-root",
    consumer,
    "--platform",
    platform,
    "--json",
  ]);
  try {
    return JSON.parse(output);
  } catch (error) {
    assert.fail(`Expo autolinking returned invalid JSON: ${error.message}\n${output}`);
  }
}

function bareAutolink(cliBin, consumer, platform) {
  const output = run(process.execPath, [cliBin, "config", "--platform", platform], {
    cwd: consumer,
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    assert.fail(`React Native Community CLI returned invalid JSON: ${error.message}\n${output}`);
  }
}

async function duplicateResourceBasenames(icuRoot) {
  const packageJson = JSON.parse(await fs.readFile(path.join(icuRoot, "package.json"), "utf8"));
  const dataRelativePath = packageJson.oliphaunt?.dataRelativePath;
  assert.equal(typeof dataRelativePath, "string", "ICU fixture must declare oliphaunt.dataRelativePath");
  const resourceRoot = path.join(icuRoot, ...dataRelativePath.split("/"));
  const byBasename = new Map();
  const pending = [resourceRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile()) {
        const relative = path.relative(icuRoot, file).split(path.sep).join("/");
        const files = byBasename.get(entry.name) ?? [];
        files.push(relative);
        byBasename.set(entry.name, files);
      }
    }
  }
  return new Map(
    [...byBasename.entries()]
      .filter(([, files]) => files.length > 1)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function assertBrokenControlIsMeaningful(config, icuRoot) {
  const dependency = config.dependencies?.["@oliphaunt/icu"];
  assert.ok(dependency, "control ICU package without an opt-out must be discovered by Expo autolinking");
  assert.equal(
    path.basename(dependency.platforms?.ios?.podspecPath ?? ""),
    "OliphauntICU.podspec",
    "control ICU package must resolve its CocoaPods carrier",
  );
  const podspec = await fs.readFile(path.join(icuRoot, "OliphauntICU.podspec"), "utf8");
  assert.match(
    podspec,
    /resource_bundles[\s\S]*share\/icu\/\*\*\/\*/u,
    "control podspec must expose the recursive ICU tree through a resource bundle",
  );
  const duplicates = await duplicateResourceBasenames(icuRoot);
  assert.deepEqual(
    duplicates.get(COLLIDING_RESOURCE)?.sort(),
    [
      `share/icu/icudt-test/coll/${COLLIDING_RESOURCE}`,
      `share/icu/icudt-test/lang/${COLLIDING_RESOURCE}`,
    ],
    "control fixture must preserve a representative flattened-resource collision",
  );
}

async function assertCandidateIsSafe(config, consumer, icuRoot, platform) {
  const reactNative = config.dependencies?.["@oliphaunt/react-native"];
  assert.ok(
    reactNative,
    `packed @oliphaunt/react-native must be discovered by Expo ${platform} autolinking`,
  );
  assert.ok(
    reactNative.platforms?.[platform],
    `packed @oliphaunt/react-native must expose its ${platform} native carrier`,
  );
  if (platform === "ios") {
    assert.equal(
      path.basename(reactNative.platforms.ios.podspecPath ?? ""),
      "OliphauntReactNative.podspec",
      "packed @oliphaunt/react-native must resolve its CocoaPods carrier",
    );
  }
  assert.equal(
    config.dependencies?.["@oliphaunt/icu"],
    undefined,
    `packed @oliphaunt/icu must opt out of ${platform} native autolinking`,
  );

  const resolver = createRequire(path.join(consumer, "resolve-icu.cjs"));
  assert.equal(
    await fs.realpath(resolver.resolve("@oliphaunt/icu/package.json")),
    await fs.realpath(path.join(icuRoot, "package.json")),
    "autolinking opt-out must not make the ICU data package unavailable to JavaScript",
  );
  const podspec = await fs.readFile(path.join(icuRoot, "OliphauntICU.podspec"), "utf8");
  assert.match(
    podspec,
    /^  s\.resources = ['"]OliphauntICU\.bundle['"]$/mu,
    "packed @oliphaunt/icu must expose the preassembled bundle as one Xcode resource",
  );
  const duplicates = await duplicateResourceBasenames(icuRoot);
  assert.deepEqual(
    duplicates.get(COLLIDING_RESOURCE)?.sort(),
    [
      `OliphauntICU.bundle/share/icu/icudt-test/coll/${COLLIDING_RESOURCE}`,
      `OliphauntICU.bundle/share/icu/icudt-test/lang/${COLLIDING_RESOURCE}`,
    ],
    "packed bundle must retain colliding basenames in their distinct source directories",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await requireFile(args.reactNativeTarball, "packed @oliphaunt/react-native archive");
  await requireFile(path.join(args.expoProject, "package.json"), "Expo fixture package.json");
  const bareToolchain = await resolveBareToolchain(args.expoProject);
  await requireFile(bareToolchain.cliBin, "React Native Community CLI executable");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oliphaunt-ios-icu-autolinking-"));
  try {
    const candidateArchive = await packIcuFixture(args.icuSource, root, "candidate", {
      legacyFlatteningControl: false,
    });
    const candidateConsumer = path.join(root, "candidate-consumer");
    const candidatePackages = await writeConsumer(
      candidateConsumer,
      args.reactNativeTarball,
      candidateArchive,
      bareToolchain,
    );
    await assertCandidateIsSafe(
      autolink(args.expoProject, candidateConsumer, "ios"),
      candidateConsumer,
      candidatePackages.icuRoot,
      "ios",
    );
    await assertCandidateIsSafe(
      autolink(args.expoProject, candidateConsumer, "android"),
      candidateConsumer,
      candidatePackages.icuRoot,
      "android",
    );
    await assertCandidateIsSafe(
      bareAutolink(bareToolchain.cliBin, candidateConsumer, "ios"),
      candidateConsumer,
      candidatePackages.icuRoot,
      "ios",
    );
    await assertCandidateIsSafe(
      bareAutolink(bareToolchain.cliBin, candidateConsumer, "android"),
      candidateConsumer,
      candidatePackages.icuRoot,
      "android",
    );

    // Reconstruct the legacy package contract from the current source
    // descriptors: omit the opt-out and expose the recursive ICU tree through
    // resource_bundles. This proves the test observes the old collision
    // mechanism rather than passing merely because dependency discovery broke.
    const controlArchive = await packIcuFixture(args.icuSource, root, "control", {
      legacyFlatteningControl: true,
    });
    const controlConsumer = path.join(root, "control-consumer");
    const controlPackages = await writeConsumer(
      controlConsumer,
      args.reactNativeTarball,
      controlArchive,
      bareToolchain,
    );
    await assertBrokenControlIsMeaningful(
      autolink(args.expoProject, controlConsumer, "ios"),
      controlPackages.icuRoot,
    );
    await assertBrokenControlIsMeaningful(
      bareAutolink(bareToolchain.cliBin, controlConsumer, "ios"),
      controlPackages.icuRoot,
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }

  console.log("Packed React Native and ICU Expo/bare autolinking contract passed");
}

await main();
