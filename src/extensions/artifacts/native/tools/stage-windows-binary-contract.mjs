#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { WINDOWS_VC_RUNTIME_DLLS } from "../../../../../tools/release/windows-vc-runtime-closure.mjs";
import {
  inspectPlatformBinaryBuffer,
  inspectPlatformBinaryEntries,
} from "../../../../../tools/release/platform-binary-contract.mjs";

const TOOL = "stage-windows-binary-contract.mjs";
const CATALOG_HEADER = Object.freeze([
  "sql_name",
  "pg_major",
  "creates_extension",
  "native_module_stem",
  "dependencies",
  "shared_preload",
  "desktop_prebuilt",
  "mobile_prebuilt",
  "mobile_static_registry_required",
  "mobile_static_archive_targets",
  "data_files",
  "artifact",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(message) {
  return new Error(`${TOOL}: ${message}`);
}

export function validateWindowsEmbeddedModuleImports(data, label) {
  const inspected = inspectPlatformBinaryBuffer(data, {
    target: "windows-x64-msvc",
    label,
  });
  const imports = new Set(
    inspected.slices
      .flatMap((slice) => slice.imports ?? [])
      .map((name) => name.toLowerCase()),
  );
  if (imports.has("postgres.exe")) {
    throw failure(
      `${label} imports postgres.exe; embedded extension DLLs must not bind to the standalone server provider (they may bind to oliphaunt.dll or be host-neutral)`,
    );
  }
  const providerBound = imports.has("oliphaunt.dll");
  return {
    imports: [...imports].sort(compareText),
    backendProvider: providerBound ? "oliphaunt.dll" : "host-neutral",
    hostNeutral: !providerBound,
    providerBound,
  };
}

export function validateWindowsServerModuleImports(data, label) {
  const inspected = inspectPlatformBinaryBuffer(data, {
    target: "windows-x64-msvc",
    label,
  });
  const imports = new Set(
    inspected.slices
      .flatMap((slice) => slice.imports ?? [])
      .map((name) => name.toLowerCase()),
  );
  if (imports.has("oliphaunt.dll")) {
    throw failure(
      `${label} imports oliphaunt.dll; standalone PostgreSQL extension DLLs must not bind to the embedded provider (they may bind to postgres.exe or be host-neutral)`,
    );
  }
  const serverBound = imports.has("postgres.exe");
  return {
    imports: [...imports].sort(compareText),
    backendProvider: serverBound ? "postgres.exe" : "host-neutral",
    hostNeutral: !serverBound,
    serverBound,
  };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function portableId(value, label) {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw failure(
      `${label} ${JSON.stringify(value)} is not a portable identifier`,
    );
  }
  return value;
}

function parseSelection(value) {
  if (value === undefined || value === null || value === "") return [];
  const result = String(value)
    .split(",")
    .map((item) => portableId(item.trim(), "selected SQL name"));
  if (result.some((item) => item.length === 0)) {
    throw failure(
      "selected SQL names must be a comma-separated list without empty entries",
    );
  }
  if (new Set(result).size !== result.length) {
    throw failure("selected SQL names contain duplicates");
  }
  return result;
}

export function parseExtensionCatalog(text, selectedSqlNames = "") {
  const lines = String(text).replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines[0] !== CATALOG_HEADER.join("\t")) {
    throw failure(
      "extension catalog header does not match the exact native artifact schema",
    );
  }

  const rows = new Map();
  for (const [offset, line] of lines.slice(1).entries()) {
    if (line.length === 0)
      throw failure(`extension catalog row ${offset + 2} is empty`);
    const columns = line.split("\t");
    if (columns.length !== CATALOG_HEADER.length) {
      throw failure(
        `extension catalog row ${offset + 2} has ${columns.length} columns; expected ${CATALOG_HEADER.length}`,
      );
    }
    const sqlName = portableId(
      columns[0],
      `extension catalog row ${offset + 2} SQL name`,
    );
    if (rows.has(sqlName))
      throw failure(`extension catalog repeats SQL name ${sqlName}`);
    if (columns[1] !== "18")
      throw failure(
        `extension catalog ${sqlName} targets PostgreSQL ${columns[1]}, not 18`,
      );
    if (!["yes", "no"].includes(columns[6])) {
      throw failure(
        `extension catalog ${sqlName} has invalid desktop_prebuilt value ${JSON.stringify(columns[6])}`,
      );
    }
    const stem =
      columns[3] === "-"
        ? null
        : portableId(columns[3], `extension catalog ${sqlName} module stem`);
    rows.set(sqlName, { sqlName, stem, desktopPrebuilt: columns[6] === "yes" });
  }

  const requested = parseSelection(selectedSqlNames);
  const selected =
    requested.length === 0
      ? [...rows.values()].filter(({ desktopPrebuilt }) => desktopPrebuilt)
      : requested.map((sqlName) => {
          const row = rows.get(sqlName);
          if (row === undefined)
            throw failure(
              `selected SQL name ${sqlName} is absent from the extension catalog`,
            );
          if (!row.desktopPrebuilt)
            throw failure(
              `selected SQL name ${sqlName} is not a desktop prebuilt extension`,
            );
          return row;
        });
  return selected.sort((left, right) =>
    compareText(left.sqlName, right.sqlName),
  );
}

function containsPath(parent, candidate) {
  const comparableParent =
    process.platform === "win32" ? parent.toLowerCase() : parent;
  const comparableCandidate =
    process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(comparableParent, comparableCandidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function canonicalProspectivePath(candidate) {
  const suffix = [];
  let current = path.resolve(candidate);
  while (true) {
    const stat = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw failure(
        `cannot inspect prospective binary-contract output ancestor ${current}: ${error.message}`,
      );
    });
    if (stat !== null) {
      const canonical = await realpath(current).catch((error) => {
        throw failure(
          `cannot resolve prospective binary-contract output ancestor ${current}: ${error.message}`,
        );
      });
      if (suffix.length > 0 && !(await lstat(canonical)).isDirectory()) {
        throw failure(
          `prospective binary-contract output ancestor ${current} is not a directory`,
        );
      }
      return path.resolve(canonical, ...suffix);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw failure(
        `cannot find an existing ancestor for binary-contract output ${candidate}`,
      );
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

async function requireRealDirectory(directory, label) {
  const stat = await lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure(`${label} ${directory} must be a real directory`);
  }
  return realpath(directory);
}

async function copyContainedFile(
  runtimeRoot,
  runtimeReal,
  relativePath,
  stageRoot,
) {
  const source = path.join(runtimeRoot, ...relativePath.split("/"));
  const stat = await lstat(source).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    throw failure(
      `required Windows carrier file ${relativePath} must be a real regular file under ${runtimeRoot}`,
    );
  }
  const sourceReal = await realpath(source);
  if (!containsPath(runtimeReal, sourceReal)) {
    throw failure(
      `required Windows carrier file ${relativePath} resolves outside ${runtimeRoot}`,
    );
  }
  const destination = path.join(stageRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return relativePath;
}

async function collectArtifactEntries(
  artifactRoot,
  artifactReal,
  relative = "",
) {
  const entries = [];
  const directory = path.join(artifactRoot, relative);
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => compareText(left.name, right.name));
  for (const child of children) {
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    const childPath = path.join(artifactRoot, ...childRelative.split("/"));
    const stat = await lstat(childPath);
    if (stat.isSymbolicLink()) {
      throw failure(
        `exact Windows extension artifact contains symbolic link ${childRelative}`,
      );
    }
    if (stat.isDirectory()) {
      entries.push(
        ...(await collectArtifactEntries(
          artifactRoot,
          artifactReal,
          childRelative,
        )),
      );
      continue;
    }
    if (!stat.isFile()) {
      throw failure(
        `exact Windows extension artifact contains non-regular entry ${childRelative}`,
      );
    }
    const childReal = await realpath(childPath);
    if (!containsPath(artifactReal, childReal)) {
      throw failure(
        `exact Windows extension artifact file ${childRelative} resolves outside ${artifactRoot}`,
      );
    }
    entries.push({
      name: `artifact/${childRelative}`,
      data: await readFile(childPath),
      isFile: true,
    });
  }
  return entries;
}

export async function validateWindowsExtensionArtifactBinaryContract({
  artifactRoot,
  providerRuntimeRoot,
}) {
  if (!artifactRoot) throw failure("artifactRoot is required");
  if (!providerRuntimeRoot) throw failure("providerRuntimeRoot is required");
  const artifact = path.resolve(artifactRoot);
  const provider = path.resolve(providerRuntimeRoot);
  const artifactReal = await requireRealDirectory(
    artifact,
    "exact Windows extension artifact root",
  );
  const providerReal = await requireRealDirectory(
    provider,
    "Windows provider runtime root",
  );
  const entries = await collectArtifactEntries(artifact, artifactReal);
  const serverModules = new Map();
  const embeddedModules = new Map();
  for (const entry of entries) {
    if (/^artifact\/files\/lib\/postgresql\/[^/]+\.dll$/iu.test(entry.name)) {
      const moduleName = path.posix.basename(entry.name);
      serverModules.set(moduleName, {
        data: entry.data,
        ...validateWindowsServerModuleImports(entry.data, entry.name),
      });
    } else if (/^artifact\/files\/lib\/modules\/[^/]+\.dll$/iu.test(entry.name)) {
      const moduleName = path.posix.basename(entry.name);
      embeddedModules.set(moduleName, {
        data: entry.data,
        ...validateWindowsEmbeddedModuleImports(entry.data, entry.name),
      });
    }
  }
  const moduleNames = [
    ...new Set([...serverModules.keys(), ...embeddedModules.keys()]),
  ].sort(compareText);
  for (const moduleName of moduleNames) {
    if (!serverModules.has(moduleName)) {
      throw failure(
        `exact Windows extension artifact is missing standalone server profile files/lib/postgresql/${moduleName}`,
      );
    }
    if (!embeddedModules.has(moduleName)) {
      throw failure(
        `exact Windows extension artifact is missing embedded provider profile files/lib/modules/${moduleName}`,
      );
    }
    const serverModule = serverModules.get(moduleName);
    const embeddedModule = embeddedModules.get(moduleName);
    const serverDigest = sha256(serverModule.data);
    const embeddedDigest = sha256(embeddedModule.data);
    if (
      serverDigest === embeddedDigest &&
      !(serverModule.hostNeutral && embeddedModule.hostNeutral)
    ) {
      throw failure(
        `exact Windows extension artifact ${moduleName} host-bound server and embedded profiles have identical SHA-256 ${serverDigest}`,
      );
    }
  }
  for (const name of WINDOWS_VC_RUNTIME_DLLS) {
    const relativePath = `bin/${name}`;
    const source = path.join(provider, ...relativePath.split("/"));
    const stat = await lstat(source).catch(() => null);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
      throw failure(
        `required Windows carrier file ${relativePath} must be a real regular file under ${provider}`,
      );
    }
    const sourceReal = await realpath(source);
    if (!containsPath(providerReal, sourceReal)) {
      throw failure(
        `required Windows carrier file ${relativePath} resolves outside ${provider}`,
      );
    }
    entries.push({
      name: `provider/${relativePath}`,
      data: await readFile(source),
      isFile: true,
    });
  }
  const inspection = inspectPlatformBinaryEntries(entries, {
    target: "windows-x64-msvc",
    rootLabel: "exact Windows extension artifact with provider runtime",
    windowsVcRuntimeProfile: "provider",
  });
  return {
    ...inspection,
    standaloneBackendProvider: "postgres.exe",
    embeddedBackendProvider: "oliphaunt.dll",
    serverBoundExtensionModules: moduleNames.filter(
      (moduleName) => serverModules.get(moduleName).serverBound,
    ),
    hostNeutralServerModules: moduleNames.filter(
      (moduleName) => serverModules.get(moduleName).hostNeutral,
    ),
    providerBoundEmbeddedModules: moduleNames.filter(
      (moduleName) => embeddedModules.get(moduleName).providerBound,
    ),
    hostNeutralEmbeddedModules: moduleNames.filter(
      (moduleName) => embeddedModules.get(moduleName).hostNeutral,
    ),
    byteIdenticalHostNeutralModules: moduleNames.filter((moduleName) => {
      const serverModule = serverModules.get(moduleName);
      const embeddedModule = embeddedModules.get(moduleName);
      return (
        serverModule.hostNeutral &&
        embeddedModule.hostNeutral &&
        sha256(serverModule.data) === sha256(embeddedModule.data)
      );
    }),
    profileBindings: Object.fromEntries(
      moduleNames.map((moduleName) => [
        moduleName,
        {
          server: serverModules.get(moduleName).backendProvider,
          embedded: embeddedModules.get(moduleName).backendProvider,
        },
      ]),
    ),
    profileSha256: Object.fromEntries(
      moduleNames.map((moduleName) => [
        moduleName,
        {
          server: sha256(serverModules.get(moduleName).data),
          embedded: sha256(embeddedModules.get(moduleName).data),
        },
      ]),
    ),
  };
}

export async function stageWindowsExtensionBinaryContract({
  runtimeRoot,
  catalogText,
  selectedSqlNames = "",
  outputRoot,
}) {
  if (!runtimeRoot) throw failure("runtimeRoot is required");
  if (catalogText === undefined) throw failure("catalogText is required");
  if (!outputRoot) throw failure("outputRoot is required");

  const runtime = path.resolve(runtimeRoot);
  const output = path.resolve(outputRoot);
  const runtimeReal = await requireRealDirectory(
    runtime,
    "Windows extension runtime root",
  );
  const outputStat = await lstat(output).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw failure(
      `cannot inspect binary-contract output ${output}: ${error.message}`,
    );
  });
  if (
    outputStat !== null &&
    (!outputStat.isDirectory() || outputStat.isSymbolicLink())
  ) {
    throw failure(
      `existing binary-contract output ${output} must be a real directory`,
    );
  }
  const outputCanonical = await canonicalProspectivePath(output);
  if (
    containsPath(runtimeReal, outputCanonical) ||
    containsPath(outputCanonical, runtimeReal)
  ) {
    throw failure("binary-contract output must not overlap the source runtime");
  }

  const selected = parseExtensionCatalog(catalogText, selectedSqlNames);
  const moduleNames = [
    ...new Set(selected.map(({ stem }) => stem).filter(Boolean)),
  ].sort();
  const serverBoundExtensionModules = [];
  const hostNeutralServerModules = [];
  const partial = `${output}.partial-${process.pid}-${randomUUID()}`;
  await rm(partial, { recursive: true, force: true });
  try {
    await mkdir(partial, { recursive: true });
    const files = [];
    for (const name of WINDOWS_VC_RUNTIME_DLLS) {
      files.push(
        await copyContainedFile(runtime, runtimeReal, `bin/${name}`, partial),
      );
    }
    for (const stem of moduleNames) {
      const relativePath = await copyContainedFile(
        runtime,
        runtimeReal,
        `lib/postgresql/${stem}.dll`,
        partial,
      );
      const binding = validateWindowsServerModuleImports(
        await readFile(path.join(partial, ...relativePath.split("/"))),
        relativePath,
      );
      if (binding.serverBound) {
        serverBoundExtensionModules.push(`${stem}.dll`);
      } else {
        hostNeutralServerModules.push(`${stem}.dll`);
      }
      files.push(relativePath);
    }
    const manifest = {
      schema: "oliphaunt-windows-extension-binary-contract-v4",
      selectedSqlNames: selected.map(({ sqlName }) => sqlName),
      standaloneBackendProvider: "postgres.exe",
      forbiddenEmbeddedBackendProvider: "oliphaunt.dll",
      providerRuntimeDlls: [...WINDOWS_VC_RUNTIME_DLLS],
      extensionModules: moduleNames.map((stem) => `${stem}.dll`),
      serverBoundExtensionModules,
      hostNeutralServerModules,
      files: [...files].sort(),
    };
    await writeFile(
      path.join(partial, "binary-contract-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await rm(output, { recursive: true, force: true });
    await mkdir(path.dirname(output), { recursive: true });
    await rename(partial, output);
    return manifest;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return `usage: ${TOOL} --runtime DIR --catalog FILE --output DIR [--selected-sql-names CSV]\n`;
}

function parseArgs(argv) {
  const args = { runtime: "", catalog: "", output: "", selectedSqlNames: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[++index];
    if (value === undefined) throw failure(`${flag} requires a value`);
    if (flag === "--runtime") args.runtime = value;
    else if (flag === "--catalog") args.catalog = value;
    else if (flag === "--output") args.output = value;
    else if (flag === "--selected-sql-names") args.selectedSqlNames = value;
    else throw failure(`unknown argument ${flag}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.runtime || !args.catalog || !args.output) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const manifest = await stageWindowsExtensionBinaryContract({
    runtimeRoot: args.runtime,
    catalogText: await readFile(args.catalog, "utf8"),
    selectedSqlNames: args.selectedSqlNames,
    outputRoot: args.output,
  });
  console.log(
    `Windows server extension binary-contract view staged: modules=${manifest.extensionModules.length} serverBound=${manifest.serverBoundExtensionModules.length} hostNeutral=${manifest.hostNeutralServerModules.length} providerDlls=${manifest.providerRuntimeDlls.length}`,
  );
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
