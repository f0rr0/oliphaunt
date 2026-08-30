#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localWindowsTarInvocation } from "../../../../tools/release/tar-command.mjs";
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  stageWindowsVcRuntime,
} from "../../../../tools/release/windows-vc-runtime-closure.mjs";
import { portableCommand } from "./portable-command.mjs";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRODUCT_ROOT = path.join(WORKSPACE_ROOT, "src/runtimes/wasix-napi");
const BUN_WRAPPER = path.join(WORKSPACE_ROOT, "tools/dev/bun.sh");
const RELEASE_NOTICES = path.join(WORKSPACE_ROOT, "tools/release/release-notices.mjs");
const ARCHIVE_DIRECTORY = path.join(WORKSPACE_ROOT, "tools/release/archive_dir.mjs");
const PLATFORM_BINARY_CONTRACT = path.join(
  WORKSPACE_ROOT,
  "tools/release/platform-binary-contract.mjs",
);
const CHECK_LINUX_CONSUMER_BASELINE = path.join(
  WORKSPACE_ROOT,
  "tools/release/check-linux-consumer-baseline.sh",
);
const TARGETS = Object.freeze({
  "macos-arm64": "darwin-arm64",
  "linux-arm64-gnu": "linux-arm64-gnu",
  "linux-x64-gnu": "linux-x64-gnu",
  "windows-x64-msvc": "win32-x64-msvc",
});
const BINARY = "oliphaunt_wasix_napi.node";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireFile(file) {
  if (!existsSync(file)) {
    throw new Error(`missing required file: ${path.relative(WORKSPACE_ROOT, file)}`);
  }
}

function stageReleaseNotices(directory) {
  const invocation = portableCommand(BUN_WRAPPER, [
    RELEASE_NOTICES,
    "stage",
    directory,
    "--profile",
    "wasix-napi-addon",
  ]);
  execFileSync(
    invocation.command,
    invocation.args,
    { cwd: WORKSPACE_ROOT, stdio: "inherit" },
  );
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const target = options.target;
  const carrierDirectory = TARGETS[target];
  if (!carrierDirectory) {
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(", ")}`);
  }
  if (!options["build-inputs"]) {
    throw new Error("--build-inputs is required");
  }
  const buildInputsFile = path.resolve(options["build-inputs"]);
  requireFile(buildInputsFile);
  const buildInputs = readJson(buildInputsFile);
  if (
    buildInputs.schema !== "oliphaunt-wasix-napi-build-inputs-v1"
    || buildInputs.target !== target
    || typeof buildInputs.targetTriple !== "string"
    || buildInputs.targetTriple.length === 0
    || !Array.isArray(buildInputs.inputs?.extensionArtifacts)
    || buildInputs.inputs.extensionArtifacts.length === 0
  ) {
    throw new Error(`${path.basename(buildInputsFile)} has incompatible WASIX N-API build inputs`);
  }
  const prebuildDirectory = path.resolve(
    options["prebuild-dir"]
      ?? path.join(WORKSPACE_ROOT, "target/oliphaunt-wasix-napi/prebuilds", target),
  );
  requireFile(path.join(prebuildDirectory, BINARY));

  const sourcePackage = path.join(PRODUCT_ROOT, "packages", carrierDirectory);
  const packageWork = path.join(
    WORKSPACE_ROOT,
    "target/oliphaunt-wasix-napi/npm-package-work",
    carrierDirectory,
  );
  const packageOutput = path.join(WORKSPACE_ROOT, "target/oliphaunt-wasix-napi/npm-packages");
  rmSync(packageWork, { recursive: true, force: true });
  mkdirSync(path.join(packageWork, "prebuilds"), { recursive: true });
  mkdirSync(packageOutput, { recursive: true });
  cpSync(sourcePackage, packageWork, { recursive: true });
  const packagePrebuilds = path.join(packageWork, "prebuilds");
  mkdirSync(packagePrebuilds, { recursive: true });
  cpSync(path.join(prebuildDirectory, BINARY), path.join(packagePrebuilds, BINARY));
  stageReleaseNotices(packageWork);
  const windowsRuntimeNames = target === "windows-x64-msvc"
    ? stageWindowsVcRuntime({
      root: packageWork,
      destinations: [packagePrebuilds],
    }).required
    : [];

  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
  }).trim();
  const artifactSourceSha = process.env.OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA ?? sourceSha;
  if (!/^[0-9a-f]{40}$/.test(artifactSourceSha)) {
    throw new Error("OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA must be a lowercase Git SHA");
  }
  const provenance = {
    schema: "oliphaunt-wasix-napi-provenance-v1",
    product: "oliphaunt-wasix-napi",
    target,
    sourceSha,
    artifactSourceSha,
    build: {
      cargoProfile: "release",
      incremental: false,
      codegenUnits: 1,
      lto: "thin",
      strip: "symbols",
      features: ["release"],
      targetTriple: buildInputs.targetTriple,
    },
    buildInputs,
    binary: {
      filename: BINARY,
      sha256: sha256(path.join(packageWork, "prebuilds", BINARY)),
    },
  };
  writeFileSync(
    path.join(packageWork, "artifact-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );

  const rootManifest = readJson(path.join(PRODUCT_ROOT, "package.json"));
  const releaseStage = path.join(
    WORKSPACE_ROOT,
    "target/oliphaunt-wasix-napi/release-stage",
    target,
  );
  const releaseAssets = path.join(WORKSPACE_ROOT, "target/oliphaunt-wasix-napi/release-assets");
  rmSync(releaseStage, { recursive: true, force: true });
  mkdirSync(releaseStage, { recursive: true });
  mkdirSync(releaseAssets, { recursive: true });
  cpSync(path.join(prebuildDirectory, BINARY), path.join(releaseStage, BINARY));
  stageReleaseNotices(releaseStage);
  cpSync(
    path.join(packageWork, "artifact-provenance.json"),
    path.join(releaseStage, "artifact-provenance.json"),
  );
  if (target === "windows-x64-msvc") {
    const releaseRuntimeNames = stageWindowsVcRuntime({
      root: releaseStage,
      sourceDirectory: packagePrebuilds,
      destinations: [releaseStage],
    }).required;
    if (JSON.stringify(releaseRuntimeNames) !== JSON.stringify(windowsRuntimeNames)) {
      throw new Error("release and npm carriers derived different Windows VC runtime closures");
    }
  }
  const platformCheck = portableCommand(BUN_WRAPPER, [
    PLATFORM_BINARY_CONTRACT,
    "--target",
    target,
    "--root",
    releaseStage,
  ]);
  execFileSync(
    platformCheck.command,
    platformCheck.args,
    { cwd: WORKSPACE_ROOT, stdio: "inherit" },
  );
  if (target.startsWith("linux-")) {
    execFileSync(
      "bash",
      [CHECK_LINUX_CONSUMER_BASELINE, "--target", target, "--root", releaseStage],
      { cwd: WORKSPACE_ROOT, stdio: "inherit" },
    );
  }
  const archiveExtension = target === "windows-x64-msvc" ? "zip" : "tar.gz";
  const releaseArchive = path.join(
    releaseAssets,
    `oliphaunt-wasix-napi-${rootManifest.version}-${target}.${archiveExtension}`,
  );
  const archiveCommand = portableCommand(BUN_WRAPPER, [
    ARCHIVE_DIRECTORY,
    releaseStage,
    releaseArchive,
  ]);
  execFileSync(archiveCommand.command, archiveCommand.args, {
    cwd: WORKSPACE_ROOT,
    stdio: "inherit",
  });

  const packCommand = portableCommand("pnpm", [
    "--dir",
    packageWork,
    "pack",
    "--pack-destination",
    packageOutput,
    "--json",
  ]);
  const output = execFileSync(
    packCommand.command,
    packCommand.args,
    { cwd: WORKSPACE_ROOT, encoding: "utf8" },
  );
  const parsed = JSON.parse(output);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry.filename !== "string" || !entry.filename.endsWith(".tgz")) {
    throw new Error("pnpm pack did not report a .tgz filename");
  }
  const tarball = path.isAbsolute(entry.filename)
    ? entry.filename
    : path.join(packageOutput, entry.filename);
  requireFile(tarball);

  const tarInvocation = localWindowsTarInvocation(["-tzf", tarball], {
    cwd: WORKSPACE_ROOT,
  });
  const listing = execFileSync("tar", tarInvocation.args, {
    cwd: tarInvocation.cwd,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u);
  const requiredMembers = [
    `package/prebuilds/${BINARY}`,
    "package/artifact-provenance.json",
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
    "package/THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "package/THIRD_PARTY_LICENSES/ICU-LICENSE",
    "package/THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
  ];
  if (windowsRuntimeNames.length > 0) {
    requiredMembers.push(
      ...windowsRuntimeNames.map((name) => `package/prebuilds/${name}`),
      `package/prebuilds/${WINDOWS_VC_RUNTIME_RECEIPT}`,
    );
  }
  for (const member of requiredMembers) {
    if (!listing.includes(member)) {
      throw new Error(`${path.basename(tarball)} is missing ${member}`);
    }
  }
  process.stdout.write(`${tarball}\n${releaseArchive}\n`);
}

try {
  main();
} catch (error) {
  console.error(`package-wasix-napi-platform: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
