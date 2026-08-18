import { createHash } from "node:crypto";

import { readPortableTarZstdBufferEntries } from "./portable-archive.mjs";

export const WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA =
  "oliphaunt-wasix-extension-install-sidecar-v1";
export const WASIX_EXTENSION_INSTALL_SCHEMA = "oliphaunt-wasix-extension-install-v1";
export const EXTENSION_RUNTIME_CONTRACT_PATH =
  "src/shared/extension-runtime-contract/contract.toml";
export const EXTENSION_RUNTIME_CONTRACT_SCHEMA =
  "oliphaunt-extension-runtime-contract-v1";

const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const SIDECAR_FIELDS = Object.freeze([
  "archive",
  "install",
  "schema",
  "sha256",
  "size",
  "sqlName",
]);
const INSTALL_FIELDS = Object.freeze([
  "coreExportsRequired",
  "dependencies",
  "installedFiles",
  "lifecycle",
  "loadOrder",
  "name",
  "nativeModule",
  "nativeModules",
  "schema",
  "unresolvedImports",
]);
const LIFECYCLE_FIELDS = Object.freeze([
  "createExtension",
  "createSchema",
  "loadSql",
  "postCreateSql",
  "preloadRequired",
  "restartRequired",
  "sharedMemoryRequired",
  "startupConfig",
]);
const NATIVE_MODULE_FIELDS = Object.freeze([
  "moduleSha256",
  "name",
  "path",
  "sha256",
  "size",
]);
const UNRESOLVED_IMPORT_FIELDS = Object.freeze(["kind", "module", "name"]);

function error(label, message) {
  return new Error(`wasix-extension-install-contract: ${label} ${message}`);
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(label, "must be an object");
  }
  return value;
}

function exactObject(value, fields, label) {
  const result = object(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw error(label, `must contain exactly ${expected.join(", ")}`);
  }
  return result;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw error(label, "must be a non-empty string");
  }
  return value;
}

function safeRelativePath(value, label) {
  const result = nonEmptyString(value, label);
  const normalized = result.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    result !== normalized
    || result.startsWith("/")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw error(label, "must be a canonical safe relative path");
  }
  return result;
}

function sha256(value, label) {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    throw error(label, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function positiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw error(label, "must be a positive safe integer");
  }
  return value;
}

function stringList(value, label, { paths = false } = {}) {
  if (!Array.isArray(value)) throw error(label, "must be an array");
  const result = value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    return paths ? safeRelativePath(entry, entryLabel) : nonEmptyString(entry, entryLabel);
  });
  if (new Set(result).size !== result.length) {
    throw error(label, "must not contain duplicates");
  }
  return result;
}

function uniqueValues(values, label) {
  if (new Set(values).size !== values.length) {
    throw error(label, "must not contain duplicates");
  }
}

function sqlName(value, label) {
  const result = nonEmptyString(value, label);
  if (!SQL_NAME.test(result)) throw error(label, "must be a portable PostgreSQL extension name");
  return result;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lifecycleFromManifest(value, label) {
  const row = object(value, label);
  const result = {
    createExtension: row["create-extension"],
    createSchema: row["create-schema"] ?? null,
    loadSql: row["load-sql"],
    postCreateSql: row["post-create-sql"],
    startupConfig: row["startup-config"],
    preloadRequired: row["preload-required"],
    restartRequired: row["restart-required"],
    sharedMemoryRequired: row["shared-memory-required"],
  };
  return checkedLifecycle(result, label);
}

function checkedLifecycle(value, label) {
  const row = exactObject(value, LIFECYCLE_FIELDS, label);
  for (const field of [
    "createExtension",
    "preloadRequired",
    "restartRequired",
    "sharedMemoryRequired",
  ]) {
    if (typeof row[field] !== "boolean") throw error(`${label}.${field}`, "must be a boolean");
  }
  if (row.createSchema !== null) nonEmptyString(row.createSchema, `${label}.createSchema`);
  return {
    createExtension: row.createExtension,
    createSchema: row.createSchema,
    loadSql: stringList(row.loadSql, `${label}.loadSql`),
    postCreateSql: stringList(row.postCreateSql, `${label}.postCreateSql`),
    startupConfig: stringList(row.startupConfig, `${label}.startupConfig`),
    preloadRequired: row.preloadRequired,
    restartRequired: row.restartRequired,
    sharedMemoryRequired: row.sharedMemoryRequired,
  };
}

function compactNativeModule(value, label) {
  const row = object(value, label);
  return checkedNativeModule({
    name: row.name,
    path: row.path,
    sha256: row.sha256,
    moduleSha256: row["module-sha256"],
    size: row.size,
  }, label);
}

function checkedNativeModule(value, label) {
  const row = exactObject(value, NATIVE_MODULE_FIELDS, label);
  return {
    name: nonEmptyString(row.name, `${label}.name`),
    path: safeRelativePath(row.path, `${label}.path`),
    sha256: sha256(row.sha256, `${label}.sha256`),
    moduleSha256: sha256(row.moduleSha256, `${label}.moduleSha256`),
    size: positiveSize(row.size, `${label}.size`),
  };
}

function checkedUnresolvedImport(value, label) {
  const row = exactObject(value, UNRESOLVED_IMPORT_FIELDS, label);
  return {
    module: nonEmptyString(row.module, `${label}.module`),
    name: nonEmptyString(row.name, `${label}.name`),
    kind: nonEmptyString(row.kind, `${label}.kind`),
  };
}

function checkedInstall(value, label, { expectedSqlName } = {}) {
  const row = exactObject(value, INSTALL_FIELDS, label);
  if (row.schema !== WASIX_EXTENSION_INSTALL_SCHEMA) {
    throw error(`${label}.schema`, `must be ${WASIX_EXTENSION_INSTALL_SCHEMA}`);
  }
  const nativeModule = row.nativeModule === null
    ? null
    : safeRelativePath(row.nativeModule, `${label}.nativeModule`);
  if (!Array.isArray(row.nativeModules)) throw error(`${label}.nativeModules`, "must be an array");
  if (!Array.isArray(row.unresolvedImports)) {
    throw error(`${label}.unresolvedImports`, "must be an array");
  }
  const nativeModules = row.nativeModules.map((entry, index) =>
    checkedNativeModule(entry, `${label}.nativeModules[${index}]`));
  uniqueValues(nativeModules.map((entry) => entry.name), `${label}.nativeModules names`);
  uniqueValues(nativeModules.map((entry) => entry.path), `${label}.nativeModules paths`);
  if ((nativeModule === null) !== (nativeModules.length === 0)) {
    throw error(
      `${label}.nativeModule`,
      "must be null exactly when nativeModules is empty",
    );
  }
  const dependencies = stringList(row.dependencies, `${label}.dependencies`)
    .map((dependency, index) => sqlName(dependency, `${label}.dependencies[${index}]`));
  if (expectedSqlName !== undefined) {
    const rootSqlName = sqlName(expectedSqlName, `${label} expected SQL name`);
    if (dependencies.includes(rootSqlName)) {
      throw error(`${label}.dependencies`, `must not include its own SQL name ${rootSqlName}`);
    }
  }
  const installedFiles = stringList(
    row.installedFiles,
    `${label}.installedFiles`,
    { paths: true },
  );
  for (const module of nativeModules) {
    if (!installedFiles.includes(module.path)) {
      throw error(
        `${label}.nativeModules`,
        `path ${module.path} must appear in installedFiles`,
      );
    }
  }
  return {
    schema: WASIX_EXTENSION_INSTALL_SCHEMA,
    name: nonEmptyString(row.name, `${label}.name`),
    nativeModule,
    nativeModules,
    coreExportsRequired: stringList(
      row.coreExportsRequired,
      `${label}.coreExportsRequired`,
    ),
    dependencies,
    loadOrder: stringList(row.loadOrder, `${label}.loadOrder`, { paths: true }),
    lifecycle: checkedLifecycle(row.lifecycle, `${label}.lifecycle`),
    installedFiles,
    unresolvedImports: row.unresolvedImports.map((entry, index) =>
      checkedUnresolvedImport(entry, `${label}.unresolvedImports[${index}]`)),
  };
}

export function assertWasixExtensionInstall(value, {
  expectedSqlName,
  label = "WASIX extension install",
} = {}) {
  return deepFreeze(checkedInstall(value, label, { expectedSqlName }));
}

export function assertWasixExtensionMemberInstall(value, {
  label = "extension member",
} = {}) {
  const member = object(value, label);
  if (!Array.isArray(member.assets)) throw error(`${label}.assets`, "must be an array");
  const portableAssets = member.assets.filter((asset) =>
    asset?.family === "wasix"
    && asset?.target === "wasix-portable"
    && asset?.kind === "wasix-runtime");
  if (portableAssets.length === 0) {
    if (member.wasixInstall !== null) {
      throw error(`${label}.wasixInstall`, "must be null without a portable WASIX asset");
    }
    return null;
  }
  if (portableAssets.length !== 1) {
    throw error(label, "must declare exactly one portable WASIX asset");
  }
  return assertWasixExtensionInstall(member.wasixInstall, {
    expectedSqlName: member.sqlName,
    label: `${label}.wasixInstall`,
  });
}

export function assertWasixExtensionInstallSidecar(value, {
  expectedArchive,
  expectedSha256,
  expectedSize,
  expectedSqlName,
  label = "install sidecar",
} = {}) {
  const row = exactObject(value, SIDECAR_FIELDS, label);
  if (row.schema !== WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA) {
    throw error(`${label}.schema`, `must be ${WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA}`);
  }
  const sqlName = nonEmptyString(row.sqlName, `${label}.sqlName`);
  if (!SQL_NAME.test(sqlName)) throw error(`${label}.sqlName`, "is not portable");
  const archive = safeRelativePath(row.archive, `${label}.archive`);
  const digest = sha256(row.sha256, `${label}.sha256`);
  const size = positiveSize(row.size, `${label}.size`);
  if (expectedSqlName !== undefined && sqlName !== expectedSqlName) {
    throw error(`${label}.sqlName`, `must be ${expectedSqlName}`);
  }
  if (archive !== `extensions/${sqlName}.tar.zst`) {
    throw error(`${label}.archive`, `must be extensions/${sqlName}.tar.zst`);
  }
  if (expectedArchive !== undefined && archive !== expectedArchive) {
    throw error(`${label}.archive`, `must be ${expectedArchive}`);
  }
  if (expectedSha256 !== undefined && digest !== expectedSha256) {
    throw error(`${label}.sha256`, "does not match the frozen archive digest");
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    throw error(`${label}.size`, "does not match the frozen archive size");
  }
  return deepFreeze({
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName,
    archive,
    sha256: digest,
    size,
    install: checkedInstall(row.install, `${label}.install`, { expectedSqlName: sqlName }),
  });
}

function assertStaticModelMatchesBuilt(model, built, label) {
  const modelSqlName = nonEmptyString(model["sql-name"], `${label} model.sql-name`);
  const builtSqlName = nonEmptyString(built["sql-name"], `${label} manifest.sql-name`);
  if (modelSqlName !== builtSqlName) throw error(label, "static and built SQL names differ");
  for (const [modelField, builtField] of [
    ["archive", "archive"],
    ["dependencies", "dependencies"],
    ["load-order", "load-order"],
  ]) {
    if (!sameValue(model[modelField], built[builtField])) {
      throw error(label, `static ${modelField} differs from the built manifest`);
    }
  }
  const modelNativeModule = model["native-module-file"] ?? null;
  const builtNativeModule = built["native-module"] ?? null;
  if (modelNativeModule !== builtNativeModule) {
    throw error(label, "static native-module-file differs from the built manifest");
  }
  if (!sameValue(
    lifecycleFromManifest(model.lifecycle, `${label} model.lifecycle`),
    lifecycleFromManifest(built.lifecycle, `${label} manifest.lifecycle`),
  )) {
    throw error(label, "static lifecycle differs from the built manifest");
  }

  const nativeModules = Array.isArray(built["native-modules"])
    ? built["native-modules"].map((entry, index) => compactNativeModule(
      entry,
      `${label} manifest.native-modules[${index}]`,
    ))
    : null;
  if (nativeModules === null) throw error(label, "built native-modules must be an array");
  if (!Array.isArray(model["native-support-modules"])) {
    throw error(label, "static native-support-modules must be an array");
  }
  const expectedModulePaths = [
    ...model["native-support-modules"].map((entry, index) =>
      safeRelativePath(entry?.["runtime-path"], `${label} model.native-support-modules[${index}]`)),
    ...(modelNativeModule === null ? [] : [`lib/postgresql/${modelNativeModule}`]),
  ];
  const actualModulePaths = nativeModules.map((entry) => entry.path);
  if (
    expectedModulePaths.length !== actualModulePaths.length
    || expectedModulePaths.some((modulePath) => !actualModulePaths.includes(modulePath))
  ) {
    throw error(label, "static native module inventory differs from the built manifest");
  }
}

export function projectWasixExtensionInstallSidecar({ modelRow, manifestRow }, {
  archiveBytes,
  label = "WASIX extension",
} = {}) {
  const model = object(modelRow, `${label} static model row`);
  const built = object(manifestRow, `${label} built manifest row`);
  assertStaticModelMatchesBuilt(model, built, label);
  const sidecar = assertWasixExtensionInstallSidecar({
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName: built["sql-name"],
    archive: built.archive,
    sha256: built.sha256,
    size: built.size,
    install: {
      schema: WASIX_EXTENSION_INSTALL_SCHEMA,
      name: built.name,
      nativeModule: built["native-module"] ?? null,
      nativeModules: built["native-modules"].map((entry, index) => compactNativeModule(
        entry,
        `${label} manifest.native-modules[${index}]`,
      )),
      coreExportsRequired: built["core-exports-required"],
      dependencies: built.dependencies,
      loadOrder: built["load-order"],
      lifecycle: lifecycleFromManifest(built.lifecycle, `${label} manifest.lifecycle`),
      installedFiles: built["installed-files"],
      unresolvedImports: built["unresolved-imports"],
    },
  }, { label });
  if (archiveBytes !== undefined) assertWasixExtensionArchiveInstall(archiveBytes, sidecar, { label });
  return sidecar;
}

export function assertWasixExtensionArchiveInstall(archiveBytes, sidecarValue, {
  label = "WASIX extension archive",
} = {}) {
  if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) {
    throw error(label, "bytes must be a Buffer or Uint8Array");
  }
  const bytes = Buffer.from(archiveBytes);
  const sidecar = assertWasixExtensionInstallSidecar(sidecarValue, { label: `${label} sidecar` });
  if (bytes.length !== sidecar.size) throw error(label, "size differs from its install sidecar");
  if (createHash("sha256").update(bytes).digest("hex") !== sidecar.sha256) {
    throw error(label, "digest differs from its install sidecar");
  }
  let entries;
  try {
    entries = readPortableTarZstdBufferEntries(bytes, { label });
  } catch (cause) {
    throw error(label, cause.message);
  }
  const files = [...entries]
    .filter(([, entry]) => entry.isFile)
    .map(([member]) => member);
  if (!sameValue(files, sidecar.install.installedFiles)) {
    throw error(label, "regular file inventory differs from install.installedFiles");
  }
  for (const [member, entry] of entries) {
    if (entry.isSymbolicLink) throw error(label, `must not contain symbolic link ${member}`);
  }
  for (const module of sidecar.install.nativeModules) {
    const entry = entries.get(module.path);
    if (entry === undefined || !entry.isFile || entry.isSymbolicLink) {
      throw error(label, `must contain native module ${module.path} as a regular file`);
    }
    const moduleBytes = Buffer.from(entry.data());
    const digest = createHash("sha256").update(moduleBytes).digest("hex");
    if (
      moduleBytes.length !== module.size
      || digest !== module.sha256
      || digest !== module.moduleSha256
    ) {
      throw error(label, `native module ${module.path} differs from its compact identity`);
    }
  }
  return sidecar;
}

export function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
