import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function optionalLstat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function relativeEvidencePath(value) {
  return value.split(path.sep).join("/");
}

export const DENO_EMBEDDED_MODULE_DIRECTORY = "lib/modules";
const DENO_EMBEDDED_MODULE_SEGMENTS = DENO_EMBEDDED_MODULE_DIRECTORY.split("/");

function isReservedDenoModulePath(relativePath) {
  return relativeEvidencePath(relativePath) === DENO_EMBEDDED_MODULE_DIRECTORY;
}

function pathContains(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertDenoPreparedRuntimePathsDoNotOverlap(
  runtimeSourceRoot,
  moduleSourceRoot,
  destinationRoot,
) {
  for (const [label, sourceRoot] of [
    ["runtime source", runtimeSourceRoot],
    ["module source", moduleSourceRoot],
  ]) {
    if (pathContains(sourceRoot, destinationRoot) || pathContains(destinationRoot, sourceRoot)) {
      throw new Error(
        `Deno prepared runtime destination must not overlap ${label}: `
        + `${path.resolve(destinationRoot)} and ${path.resolve(sourceRoot)}`,
      );
    }
  }
}

export async function stageDenoModuleDirectory(sourceRoot, destinationRoot) {
  const copiedFiles = [];

  async function copyDirectory(source, destination, relativeDirectory) {
    const sourceStat = await optionalLstat(source);
    if (sourceStat === undefined || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Deno embedded module source must be a directory: ${source}`);
    }
    const destinationStat = await optionalLstat(destination);
    if (destinationStat !== undefined) {
      throw new Error(`Deno embedded module destination must not already exist: ${destination}`);
    }
    await mkdir(destination);

    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const sourceEntry = path.join(source, entry.name);
      const destinationEntry = path.join(destination, entry.name);
      const relativeEntry = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`Deno embedded module payload must contain only files and directories: ${sourceEntry}`);
      }
      if (entry.isDirectory()) {
        await copyDirectory(sourceEntry, destinationEntry, relativeEntry);
        continue;
      }
      await cp(sourceEntry, destinationEntry, {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      copiedFiles.push(relativeEvidencePath(relativeEntry));
    }
  }

  const destinationParent = path.dirname(destinationRoot);
  const parentStat = await optionalLstat(destinationParent);
  if (parentStat === undefined) {
    await mkdir(destinationParent, { recursive: true });
  } else if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Deno embedded module parent must be a directory: ${destinationParent}`);
  }
  await copyDirectory(sourceRoot, destinationRoot, "");
  return { copiedFiles };
}

export async function stageDenoPreparedRuntime(
  runtimeSourceRoot,
  moduleSourceRoot,
  destinationRoot,
) {
  assertDenoPreparedRuntimePathsDoNotOverlap(
    runtimeSourceRoot,
    moduleSourceRoot,
    destinationRoot,
  );
  const copiedRuntimeFiles = [];
  let excludedRuntimeModuleDirectory = false;

  async function copyRuntimeDirectory(source, destination, relativeDirectory) {
    const sourceStat = await optionalLstat(source);
    if (sourceStat === undefined || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Deno prepared runtime source must be a directory: ${source}`);
    }
    const destinationStat = await optionalLstat(destination);
    if (destinationStat !== undefined) {
      throw new Error(`Deno prepared runtime destination must not already exist: ${destination}`);
    }
    await mkdir(destination);

    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const sourceEntry = path.join(source, entry.name);
      const destinationEntry = path.join(destination, entry.name);
      const relativeEntry = path.join(relativeDirectory, entry.name);
      if (isReservedDenoModulePath(relativeEntry)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(
            `Deno prepared runtime reserved module path must be a directory: ${sourceEntry}`,
          );
        }
        excludedRuntimeModuleDirectory = true;
        continue;
      }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(
          `Deno prepared runtime payload must contain only files and directories: ${sourceEntry}`,
        );
      }
      if (entry.isDirectory()) {
        await copyRuntimeDirectory(sourceEntry, destinationEntry, relativeEntry);
        continue;
      }
      await cp(sourceEntry, destinationEntry, {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      copiedRuntimeFiles.push(relativeEvidencePath(relativeEntry));
    }
  }

  const destinationParent = path.dirname(destinationRoot);
  const parentStat = await optionalLstat(destinationParent);
  if (parentStat === undefined) {
    await mkdir(destinationParent, { recursive: true });
  } else if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Deno prepared runtime parent must be a directory: ${destinationParent}`);
  }
  await copyRuntimeDirectory(runtimeSourceRoot, destinationRoot, "");
  const moduleDirectory = path.join(destinationRoot, ...DENO_EMBEDDED_MODULE_SEGMENTS);
  const moduleStaging = await stageDenoModuleDirectory(moduleSourceRoot, moduleDirectory);
  return {
    moduleDirectory,
    moduleStaging,
    runtimeStaging: {
      copiedFiles: copiedRuntimeFiles,
      excludedModuleDirectory: excludedRuntimeModuleDirectory
        ? DENO_EMBEDDED_MODULE_DIRECTORY
        : null,
    },
  };
}

export async function prepareDenoRuntime(env = process.env) {
  const contractPath = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_EXTENSION_CONTRACT", env));
  const outputRoot = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_PREPARED_RUNTIME", env));
  const receiptPath = path.resolve(
    requiredEnv("OLIPHAUNT_CONSUMER_PREPARED_RUNTIME_RECEIPT", env),
  );
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const extensions = contract.extensions.map((entry) => entry.sqlName);
  assert.ok(extensions.length > 0, "exact candidate must prepare at least one Deno extension");

  const assetsNodeUrl = new URL(
    "./node_modules/@oliphaunt/ts/lib/native/assets-node.js",
    import.meta.url,
  );
  const {
    prepareNodeExtensionInstall,
    resolveNodeNativeInstall,
  } = await import(assetsNodeUrl.href);
  const install = await resolveNodeNativeInstall();
  assert.equal(install.packageManaged, true, "Deno preparation must use the exact installed packages");
  const prepared = await prepareNodeExtensionInstall(install, extensions);
  assert.ok(prepared.runtimeDirectory, "extension materialization must produce a runtime directory");
  assert.ok(prepared.moduleDirectory, "extension materialization must produce a module directory");

  await rm(outputRoot, { force: true, recursive: true });
  const preparedRuntime = await stageDenoPreparedRuntime(
    prepared.runtimeDirectory,
    prepared.moduleDirectory,
    outputRoot,
  );

  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    candidate: contract.candidate,
    extensionCount: extensions.length,
    packageManagedInput: true,
    preparedLayout: "explicit-deno-runtime-v2",
    embeddedModuleDirectory: DENO_EMBEDDED_MODULE_DIRECTORY,
    moduleStaging: {
      policy: "separate-embedded-modules-v1",
      copiedFileCount: preparedRuntime.moduleStaging.copiedFiles.length,
    },
  }, null, 2)}\n`, "utf8");
}

function isMainModule() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  await prepareDenoRuntime();
}
