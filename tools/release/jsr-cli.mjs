import { constants, accessSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const SDK_WORKSPACE = "src/sdks/js";
const JSR_PACKAGE = "jsr";
const JSR_BIN = "dist/bin.js";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function object(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pinned JSR CLI: ${label} must be an object`);
  }
  return value;
}

function readJson(file, label) {
  try {
    return object(JSON.parse(readFileSync(file, "utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`pinned JSR CLI: ${label} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function requireRegularNonSymlink(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    throw new Error(`pinned JSR CLI: ${label} is unavailable at ${file}: ${error.message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`pinned JSR CLI: ${label} must be a regular non-symlink file: ${file}`);
  }
}

/**
 * Resolve the exact lock-installed JSR executable owned by the JavaScript SDK.
 *
 * The returned path is the real package bin, rather than an ambient PATH lookup
 * or pnpm exec shim. Callers may therefore retain the frozen package source as
 * their cwd without changing dependency resolution.
 */
export function resolvePinnedJsrCli(root = ROOT) {
  const workspaceRoot = path.join(root, SDK_WORKSPACE);
  const workspaceManifest = readJson(path.join(workspaceRoot, "package.json"), `${SDK_WORKSPACE}/package.json`);
  const declaredSpecifier = object(workspaceManifest.devDependencies, `${SDK_WORKSPACE} devDependencies`)[JSR_PACKAGE];
  if (typeof declaredSpecifier !== "string" || declaredSpecifier.length === 0) {
    throw new Error(`pinned JSR CLI: ${SDK_WORKSPACE}/package.json must declare devDependencies.${JSR_PACKAGE}`);
  }

  let lock;
  try {
    lock = object(Bun.YAML.parse(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")), "pnpm-lock.yaml");
  } catch (error) {
    throw new Error(`pinned JSR CLI: cannot parse pnpm-lock.yaml: ${error.message}`);
  }
  const importer = object(object(lock.importers, "pnpm-lock.yaml importers")[SDK_WORKSPACE], `${SDK_WORKSPACE} lock importer`);
  const lockedDependency = object(
    object(importer.devDependencies, `${SDK_WORKSPACE} lock devDependencies`)[JSR_PACKAGE],
    `${SDK_WORKSPACE} locked ${JSR_PACKAGE} dependency`,
  );
  if (lockedDependency.specifier !== declaredSpecifier) {
    throw new Error(
      `pinned JSR CLI: manifest specifier ${JSON.stringify(declaredSpecifier)} does not match lock specifier ${JSON.stringify(lockedDependency.specifier)}`,
    );
  }
  const version = lockedDependency.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`pinned JSR CLI: lock importer has no exact ${JSR_PACKAGE} version`);
  }
  const lockPackage = object(object(lock.packages, "pnpm-lock.yaml packages")[`${JSR_PACKAGE}@${version}`], `${JSR_PACKAGE}@${version} lock package`);
  const integrity = object(lockPackage.resolution, `${JSR_PACKAGE}@${version} lock resolution`).integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`pinned JSR CLI: ${JSR_PACKAGE}@${version} must have a sha512 lock integrity`);
  }

  const installedPackageRoot = path.join(workspaceRoot, "node_modules", JSR_PACKAGE);
  const canonicalPackageRoot = path.join(root, "node_modules", ".pnpm", `${JSR_PACKAGE}@${version}`, "node_modules", JSR_PACKAGE);
  let installedPackageReal;
  let canonicalPackageReal;
  try {
    installedPackageReal = realpathSync(installedPackageRoot);
    canonicalPackageReal = realpathSync(canonicalPackageRoot);
  } catch (error) {
    throw new Error(
      `pinned JSR CLI: install the frozen pnpm workspace before publishing (${JSR_PACKAGE}@${version} is unavailable): ${error.message}`,
    );
  }
  if (installedPackageReal !== canonicalPackageReal) {
    throw new Error(
      `pinned JSR CLI: ${SDK_WORKSPACE}/node_modules/${JSR_PACKAGE} does not resolve to the lock-owned virtual-store package`,
    );
  }

  const installedManifest = readJson(path.join(installedPackageRoot, "package.json"), `installed ${JSR_PACKAGE} package.json`);
  if (installedManifest.name !== JSR_PACKAGE || installedManifest.version !== version) {
    throw new Error(
      `pinned JSR CLI: installed package identity ${JSON.stringify(installedManifest.name)}@${JSON.stringify(installedManifest.version)} does not match ${JSR_PACKAGE}@${version}`,
    );
  }
  const installedBin = object(installedManifest.bin, `installed ${JSR_PACKAGE} bin`).jsr;
  if (installedBin !== JSR_BIN) {
    throw new Error(`pinned JSR CLI: ${JSR_PACKAGE}@${version} bin.jsr must be ${JSON.stringify(JSR_BIN)}`);
  }

  const declaredExecutable = path.join(installedPackageRoot, installedBin);
  requireRegularNonSymlink(declaredExecutable, `${JSR_PACKAGE}@${version} executable`);
  const executable = realpathSync(declaredExecutable);
  requireRegularNonSymlink(executable, `${JSR_PACKAGE}@${version} real executable`);
  if (!executable.startsWith(`${canonicalPackageReal}${path.sep}`)) {
    throw new Error(`pinned JSR CLI: executable escapes the lock-owned ${JSR_PACKAGE}@${version} package`);
  }
  if (process.platform !== "win32") {
    try {
      accessSync(executable, constants.X_OK);
    } catch (error) {
      throw new Error(`pinned JSR CLI: executable is not executable: ${executable}: ${error.message}`);
    }
  }
  if (!readFileSync(executable, "utf8").startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`pinned JSR CLI: executable does not declare the expected Node.js interpreter: ${executable}`);
  }
  return executable;
}

function resolveSetupNodeExecutable(root) {
  const probe = captureCommandOutput(
    "node",
    ["-e", "process.stdout.write(JSON.stringify({ executable: process.execPath, version: process.versions.node }))"],
    {
      cwd: root,
      label: "resolve setup-provided Node.js identity",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `pinned JSR CLI: cannot resolve the setup-provided Node.js executable: ${probe.error?.message ?? probe.stderr.trim() ?? `status ${String(probe.status)}`}`,
    );
  }
  let identity;
  try {
    identity = object(JSON.parse(probe.stdout), "setup-provided Node.js identity");
  } catch (error) {
    throw new Error(`pinned JSR CLI: setup-provided Node.js returned an invalid identity: ${error.message}`);
  }
  if (typeof identity.executable !== "string" || !path.isAbsolute(identity.executable)) {
    throw new Error("pinned JSR CLI: setup-provided Node.js did not report an absolute executable path");
  }
  const executable = realpathSync(identity.executable);
  requireRegularNonSymlink(executable, "setup-provided Node.js executable");

  if (process.env.GITHUB_ACTIONS === "true") {
    const nodeManifest = object(
      Bun.TOML.parse(readFileSync(path.join(root, "src/sources/toolchains/node-runtime.toml"), "utf8")),
      "Node.js runtime manifest",
    );
    const expectedVersion = object(nodeManifest.toolchain, "Node.js runtime manifest toolchain").version;
    if (identity.version !== expectedVersion) {
      throw new Error(
        `pinned JSR CLI: GitHub Actions Node.js ${JSON.stringify(identity.version)} does not match the verified runtime pin ${JSON.stringify(expectedVersion)}`,
      );
    }
  }
  return executable;
}

/**
 * Build a portable invocation of the exact JSR package executable.
 *
 * Always bypass the package shebang and launch through the absolute Node.js
 * executable placed first on PATH by setup-node-runtime. Hosted release use
 * also requires that runtime to match the repository's exact source pin.
 */
export function resolvePinnedJsrInvocation(args, { root = ROOT } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("pinned JSR CLI: invocation arguments must be an array of strings");
  }
  const jsr = resolvePinnedJsrCli(root);
  return [resolveSetupNodeExecutable(root), jsr, ...args];
}
