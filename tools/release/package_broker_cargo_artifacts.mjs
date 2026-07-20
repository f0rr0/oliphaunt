#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  parseWindowsVcRuntimeReceipt,
} from "./windows-vc-runtime-closure.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PRODUCT = "oliphaunt-broker";
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const TARGETS = ["linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"];

function fail(message) {
  console.error(`package_broker_cargo_artifacts.mjs: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative;
}

function usage() {
  fail(
    "usage: package_broker_cargo_artifacts.mjs [--asset-dir DIR] [--output-dir DIR] [--target TARGET]... [--version VERSION]",
  );
}

function optionValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  return value;
}

async function parseArgs(argv) {
  const args = {
    assetDir: "target/oliphaunt-broker/release-assets",
    outputDir: "target/oliphaunt-broker/cargo-artifacts",
    targets: [],
    version: undefined,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      args.assetDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--output-dir") {
      args.outputDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--target") {
      args.targets.push(optionValue(argv, index));
      index += 2;
    } else if (arg === "--version") {
      args.version = optionValue(argv, index);
      index += 2;
    } else {
      usage();
    }
  }
  return {
    assetDir: repoPath(args.assetDir),
    outputDir: repoPath(args.outputDir),
    targets: args.targets,
    version: args.version ?? (await currentVersion()),
  };
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

async function currentVersion() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, ".release-please-manifest.json"), "utf8"));
  const version = manifest["src/runtimes/broker"];
  if (typeof version !== "string" || version.length === 0) {
    fail(".release-please-manifest.json is missing src/runtimes/broker");
  }
  return version;
}

function cargoPackageName(targetId) {
  return `${PRODUCT}-${targetId}`;
}

function cargoLinksName(targetId) {
  return `oliphaunt_artifact_broker_${targetId.replaceAll("-", "_")}`;
}

function sourceCrateDir(targetId) {
  return path.join(ROOT, "src/runtimes/broker/crates", targetId);
}

async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function run(args, options = {}) {
  const cwd = options.cwd ?? ROOT;
  const invocation = args[0] === "tar"
    ? localWindowsTarInvocation(args.slice(1), { cwd })
    : { args: args.slice(1), cwd };
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], invocation.args, {
    cwd: invocation.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) {
    fail(`${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

async function extractMember(archivePath, memberName, destination) {
  const candidates = [memberName, `./${memberName}`];
  let data;
  for (const candidate of candidates) {
    const command = archivePath.endsWith(".zip")
      ? ["unzip", "-p", archivePath, candidate]
      : ["tar", "-xOf", archivePath, candidate];
    const invocation = command[0] === "tar"
      ? localWindowsTarInvocation(command.slice(1), { cwd: ROOT })
      : { args: command.slice(1), cwd: ROOT };
    const result = spawnSync(command[0], invocation.args, {
      cwd: invocation.cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      fail(`${command[0]} failed to start: ${result.error.message}`);
    }
    if (result.status === 0) {
      data = result.stdout;
      break;
    }
  }
  if (data === undefined) {
    fail(`${rel(archivePath)} is missing ${memberName}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, data);
}

function targetFromSource(targetId, version) {
  return {
    target: targetId,
    packageName: cargoPackageName(targetId),
    sourceDir: sourceCrateDir(targetId),
    archiveName: `${PRODUCT}-${version}-${targetId}.${targetId === "windows-x64-msvc" ? "zip" : "tar.gz"}`,
  };
}

async function copySourceCrate(target, crateDir, version) {
  if (!(await isDirectory(target.sourceDir))) {
    fail(`${target.target} source Cargo artifact crate is missing: ${rel(target.sourceDir)}`);
  }
  await rm(crateDir, { recursive: true, force: true });
  run(["cp", "-R", target.sourceDir, crateDir]);
  const cargoTomlPath = path.join(crateDir, "Cargo.toml");
  const cargoToml = await readFile(cargoTomlPath, "utf8");
  const metadata = Bun.TOML.parse(cargoToml);
  const expectedLinks = cargoLinksName(target.target);
  if (metadata?.package?.name !== target.packageName) {
    fail(`${rel(path.join(target.sourceDir, "Cargo.toml"))} has package.name=${JSON.stringify(metadata?.package?.name)}, expected ${target.packageName}`);
  }
  if (metadata?.package?.version !== version) {
    fail(`${rel(path.join(target.sourceDir, "Cargo.toml"))} has package.version=${JSON.stringify(metadata?.package?.version)}, expected ${version}`);
  }
  if (metadata?.package?.links !== expectedLinks) {
    fail(`${rel(path.join(target.sourceDir, "Cargo.toml"))} has package.links=${JSON.stringify(metadata?.package?.links)}, expected ${expectedLinks}`);
  }
  if (metadata?.package?.build !== "build.rs") {
    fail(`${rel(path.join(target.sourceDir, "Cargo.toml"))} must declare build = "build.rs"`);
  }
  if (!Array.isArray(metadata?.package?.include) || !metadata.package.include.includes("payload/**")) {
    fail(`${rel(path.join(target.sourceDir, "Cargo.toml"))} must include "payload/**"`);
  }

  const libRsPath = path.join(crateDir, "src/lib.rs");
  const libRs = await readFile(libRsPath, "utf8");
  const constants = Object.fromEntries(
    [...libRs.matchAll(/pub const ([A-Z_]+): &str = "([^"]+)";/g)].map((match) => [match[1], match[2]]),
  );
  for (const [key, value] of Object.entries({
    PRODUCT,
    KIND: "broker-helper",
    RELEASE_TARGET: target.target,
  })) {
    if (constants[key] !== value) {
      fail(`${rel(path.join(target.sourceDir, "src/lib.rs"))} has ${key}=${JSON.stringify(constants[key])}, expected ${value}`);
    }
  }
  if (typeof constants.CARGO_TARGET !== "string" || constants.CARGO_TARGET.length === 0) {
    fail(`${rel(path.join(target.sourceDir, "src/lib.rs"))} must declare CARGO_TARGET`);
  }
  if (typeof constants.EXECUTABLE_RELATIVE_PATH !== "string" || constants.EXECUTABLE_RELATIVE_PATH.length === 0) {
    fail(`${rel(path.join(target.sourceDir, "src/lib.rs"))} must declare EXECUTABLE_RELATIVE_PATH`);
  }
  target.executableRelativePath = constants.EXECUTABLE_RELATIVE_PATH;
}

async function sha256File(file) {
  const digest = createHash("sha256");
  for await (const chunk of Bun.file(file).stream()) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function validateCrate(cratePath, packageName, version, payloadMembers) {
  if (!(await isFile(cratePath))) {
    fail(`missing generated Cargo crate ${rel(cratePath)}`);
  }
  const size = (await stat(cratePath)).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  const expected = new Set([
    `${packageName}-${version}/Cargo.toml`,
    `${packageName}-${version}/README.md`,
    `${packageName}-${version}/build.rs`,
    `${packageName}-${version}/src/lib.rs`,
    `${packageName}-${version}/payload/sha256`,
    ...payloadMembers.map((member) => `${packageName}-${version}/payload/${member}`),
  ]);
  const names = new Set(run(["tar", "-tzf", cratePath], { capture: true }).split(/\r?\n/).filter(Boolean));
  const missing = [...expected].filter((name) => !names.has(name)).sort();
  if (missing.length > 0) {
    fail(`${rel(cratePath)} is missing package members: ${missing.join(", ")}`);
  }
}

async function packageTarget(target, { version, assetDir, sourceRoot, outputDir, cargoTargetDir }) {
  const crateDir = path.join(sourceRoot, target.packageName);
  await copySourceCrate(target, crateDir, version);
  const archive = path.join(assetDir, target.archiveName);
  if (!(await isFile(archive))) {
    fail(`missing broker release asset: ${rel(archive)}`);
  }
  const payload = path.join(crateDir, "payload", target.executableRelativePath);
  await extractMember(archive, target.executableRelativePath, payload);
  if ((await stat(payload)).size <= 0) {
    fail(`${rel(payload)} must be a non-empty broker helper payload`);
  }
  await chmod(payload, 0o755);
  const payloadMembers = [target.executableRelativePath];
  if (target.target === "windows-x64-msvc") {
    const receiptRelativePath = `bin/${WINDOWS_VC_RUNTIME_RECEIPT}`;
    const receiptPath = path.join(crateDir, "payload", receiptRelativePath);
    await extractMember(archive, receiptRelativePath, receiptPath);
    const receipt = parseWindowsVcRuntimeReceipt(
      await readFile(receiptPath),
      `${rel(archive)}:${receiptRelativePath}`,
    );
    payloadMembers.push(receiptRelativePath);
    for (const [name, digest] of receipt) {
      const relativePath = `bin/${name}`;
      const destination = path.join(crateDir, "payload", relativePath);
      await extractMember(archive, relativePath, destination);
      if (await sha256File(destination) !== digest) {
        fail(`${rel(archive)} ${relativePath} does not match ${receiptRelativePath}`);
      }
      payloadMembers.push(relativePath);
    }
  }
  payloadMembers.sort();
  const checksumText = target.target === "windows-x64-msvc"
    ? `${(await Promise.all(payloadMembers.map(async (member) => `${await sha256File(path.join(crateDir, "payload", member))}  ${member}`))).join("\n")}\n`
    : `${await sha256File(payload)}\n`;
  await writeFile(path.join(crateDir, "payload/sha256"), checksumText, "utf8");
  run(
    [
      "cargo",
      "package",
      "--manifest-path",
      path.join(crateDir, "Cargo.toml"),
      "--target-dir",
      cargoTargetDir,
      "--allow-dirty",
    ],
    { env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" } },
  );
  const packaged = path.join(cargoTargetDir, "package", `${target.packageName}-${version}.crate`);
  const output = path.join(outputDir, path.basename(packaged));
  await copyFile(packaged, output);
  await validateCrate(output, target.packageName, version, payloadMembers);
  return output;
}

async function main() {
  const args = await parseArgs(Bun.argv.slice(2));
  if (!(await isDirectory(args.assetDir))) {
    fail(`broker release asset directory does not exist: ${rel(args.assetDir)}`);
  }
  const sourceRoot = path.join(ROOT, "target/oliphaunt-broker/cargo-package-sources");
  const cargoTargetDir = path.join(ROOT, "target/oliphaunt-broker/cargo-package-target");
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(args.outputDir, { recursive: true, force: true });
  await rm(cargoTargetDir, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(args.outputDir, { recursive: true });

  let targets = TARGETS.map((target) => targetFromSource(target, args.version));
  if (args.targets.length > 0) {
    const selected = new Set(args.targets);
    const known = new Set(TARGETS);
    const unknown = [...selected].filter((target) => !known.has(target)).sort();
    if (unknown.length > 0) {
      fail(`unsupported broker target(s): ${unknown.join(", ")}`);
    }
    targets = targets.filter((target) => selected.has(target.target));
  }

  const outputs = [];
  for (const target of targets) {
    outputs.push(
      await packageTarget(target, {
        version: args.version,
        assetDir: args.assetDir,
        sourceRoot,
        outputDir: args.outputDir,
        cargoTargetDir,
      }),
    );
  }

  console.log("generated broker Cargo artifact crates:");
  for (const output of outputs) {
    console.log(rel(output));
  }
}

await main();
