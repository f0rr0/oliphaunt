const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXTENSION_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const packageMetadata = require('./package.json');
const extensionMetadata = require('./src/generated/extensions.json');
const IOS_PODFILE_START = '# @oliphaunt/react-native begin';
const IOS_PODFILE_END = '# @oliphaunt/react-native end';
const IOS_MINIMUM_DEPLOYMENT_TARGET = '17.0';
const IOS_CARRIER_SCHEMA = 'oliphaunt-react-native-ios-carrier-v1';
const IOS_CARRIER_FILENAME = 'oliphaunt-react-native-ios-carriers.json';
const IOS_BASE_CARRIER_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER';
const IOS_EXTENSION_CARRIERS_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS';
const IOS_CARRIER_CACHE_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_CACHE_DIR';
const IOS_ALLOW_FILE_URLS_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_ALLOW_FILE_URLS';
const ANDROID_APP_PLUGIN_RE = /id\s*(?:\(\s*)?['"]dev\.oliphaunt\.android['"]/;
const STABLE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const KNOWN_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions.map((extension) => extension['sql-name']),
);
const EXTENSION_METADATA_BY_SQL_NAME = new Map(
  extensionMetadata.extensions.map((extension) => [extension['sql-name'], extension]),
);
const MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions
    .filter((extension) => extension['mobile-release-ready'] === true)
    .map((extension) => extension['sql-name']),
);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeOptions(options = {}) {
  const extensions = Array.isArray(options.extensions) ? options.extensions : [];
  const selected = [...new Set(extensions.map((value) => String(value).trim()).filter(Boolean))].sort();
  for (const extension of selected) {
    if (!EXTENSION_NAME_RE.test(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' must be an exact PostgreSQL extension name`,
      );
    }
    if (!KNOWN_EXTENSION_SQL_NAMES.has(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' is not in the generated exact-extension catalog`,
      );
    }
    if (!MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES.has(extension)) {
      throw new Error(
        `@oliphaunt/react-native extension '${extension}' is known but does not have release-ready iOS/Android artifacts`,
      );
    }
  }
  return {
    extensions: selected,
    icu: Boolean(options.icu),
    liboliphauntVersion: optionalString(options.liboliphauntVersion),
    assetBaseUrl: optionalString(options.assetBaseUrl),
    kotlinPluginVersion: optionalString(options.kotlinPluginVersion) ?? packageMetadata.oliphaunt?.kotlinSdkVersion,
  };
}

function optionalString(value) {
  if (value == null) {
    return undefined;
  }
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : undefined;
}

function extensionPackageName(sqlName) {
  const extension = EXTENSION_METADATA_BY_SQL_NAME.get(sqlName);
  if (!extension) {
    throw new Error(`unknown Oliphaunt extension SQL name ${sqlName}`);
  }
  return extension['npm-package'];
}

function selectedExtensionClosure(extensions) {
  const selected = new Set();
  const visiting = new Set();
  function visit(sqlName) {
    if (selected.has(sqlName)) {
      return;
    }
    if (visiting.has(sqlName)) {
      throw new Error(`generated extension dependency cycle includes ${sqlName}`);
    }
    const extension = EXTENSION_METADATA_BY_SQL_NAME.get(sqlName);
    if (!extension) {
      throw new Error(`unknown Oliphaunt extension SQL name ${sqlName}`);
    }
    visiting.add(sqlName);
    for (const dependency of extension['selected-extension-dependencies'] ?? []) {
      visit(dependency);
    }
    visiting.delete(sqlName);
    selected.add(sqlName);
  }
  for (const sqlName of extensions) {
    visit(sqlName);
  }
  return [...selected].sort();
}

function releaseOwnerForSqlName(sqlName) {
  const extension = EXTENSION_METADATA_BY_SQL_NAME.get(sqlName);
  if (!extension) {
    throw new Error(`unknown Oliphaunt extension SQL name ${sqlName}`);
  }
  const members = extensionMetadata.extensions
    .filter(
      (candidate) =>
        candidate['release-product'] === extension['release-product'] &&
        candidate['npm-package'] === extension['npm-package'],
    )
    .map((candidate) => candidate['sql-name'])
    .sort();
  if (
    members.length === 0 ||
    extensionMetadata.extensions
      .filter((candidate) => members.includes(candidate['sql-name']))
      .some(
        (candidate) =>
          candidate['maven-group'] !== extension['maven-group'] ||
          candidate['maven-artifact'] !== extension['maven-artifact'] ||
          candidate['runtime-bound'] !== extension['runtime-bound'],
      )
  ) {
    throw new Error(`generated extension ownership metadata is inconsistent for ${sqlName}`);
  }
  return {
    members,
    mavenArtifact: extension['maven-artifact'],
    mavenGroup: extension['maven-group'],
    npmPackage: extension['npm-package'],
    releaseProduct: extension['release-product'],
    runtimeBound: extension['runtime-bound'] === true,
  };
}

function absoluteFromProject(projectRoot, value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  return path.resolve(projectRoot, value);
}

function readJsonObject(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read from ${file}: ${error.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} at ${file} must be a JSON object`);
  }
  return value;
}

function readCarrierSummary(file, label = 'iOS carrier manifest') {
  const manifest = readJsonObject(file, label);
  if (manifest.schema !== IOS_CARRIER_SCHEMA) {
    throw new Error(`${label} at ${file} must declare schema=${IOS_CARRIER_SCHEMA}`);
  }
  if (manifest.base === null || Array.isArray(manifest.base) || typeof manifest.base !== 'object') {
    throw new Error(`${label} at ${file} must contain a base carrier object`);
  }
  if (
    manifest.base.product !== 'liboliphaunt-native' ||
    typeof manifest.base.version !== 'string' ||
    !STABLE_SEMVER_RE.test(manifest.base.version) ||
    manifest.base.tag !== `liboliphaunt-native-v${manifest.base.version}`
  ) {
    throw new Error(`${label} at ${file} contains an invalid base release identity`);
  }
  if (!Array.isArray(manifest.carriers)) {
    throw new Error(`${label} at ${file} must contain a carriers array`);
  }
  const carrierNames = new Set();
  for (const [index, carrier] of manifest.carriers.entries()) {
    if (carrier === null || Array.isArray(carrier) || typeof carrier !== 'object') {
      throw new Error(`${label} at ${file} carriers[${index}] must be an object`);
    }
    if (
      typeof carrier.name !== 'string' ||
      carrier.name.length === 0 ||
      typeof carrier.url !== 'string' ||
      carrier.url.length === 0 ||
      typeof carrier.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(carrier.sha256) ||
      !Number.isSafeInteger(carrier.bytes) ||
      carrier.bytes <= 0 ||
      !['zip', 'tar.gz'].includes(carrier.format)
    ) {
      throw new Error(`${label} at ${file} carriers[${index}] is invalid`);
    }
    if (carrierNames.has(carrier.name)) {
      throw new Error(`${label} at ${file} repeats carrier ${carrier.name}`);
    }
    carrierNames.add(carrier.name);
  }
  if (!Array.isArray(manifest.extensions)) {
    throw new Error(`${label} at ${file} must contain an extensions array`);
  }
  const releasesByOwner = new Map();
  const extensions = manifest.extensions.map((row, index) => {
    if (row === null || Array.isArray(row) || typeof row !== 'object') {
      throw new Error(`${label} at ${file} extensions[${index}] must be an object`);
    }
    if (typeof row.sqlName !== 'string' || !EXTENSION_NAME_RE.test(row.sqlName)) {
      throw new Error(`${label} at ${file} extensions[${index}].sqlName is invalid`);
    }
    if (
      !Array.isArray(row.dependencies) ||
      row.dependencies.some((dependency) => typeof dependency !== 'string' || !EXTENSION_NAME_RE.test(dependency))
    ) {
      throw new Error(`${label} at ${file} extension ${row.sqlName} has invalid dependencies`);
    }
    const dependencies = [...new Set(row.dependencies)].sort();
    if (dependencies.length !== row.dependencies.length) {
      throw new Error(`${label} at ${file} extension ${row.sqlName} repeats a dependency`);
    }
    const owner = releaseOwnerForSqlName(row.sqlName);
    if (row.product !== owner.releaseProduct) {
      throw new Error(
        `${label} at ${file} extension ${row.sqlName} must be owned by ${owner.releaseProduct}`,
      );
    }
    if (typeof row.version !== 'string' || !STABLE_SEMVER_RE.test(row.version)) {
      throw new Error(
        `${label} at ${file} extension ${row.sqlName} has an invalid stable SemVer version`,
      );
    }
    const expectedTag = `${owner.releaseProduct}-v${row.version}`;
    if (row.tag !== expectedTag) {
      throw new Error(`${label} at ${file} extension ${row.sqlName}.tag must be ${expectedTag}`);
    }
    const generatedDependencies = [
      ...(EXTENSION_METADATA_BY_SQL_NAME.get(row.sqlName)?.['selected-extension-dependencies'] ?? []),
    ].sort();
    if (JSON.stringify(dependencies) !== JSON.stringify(generatedDependencies)) {
      throw new Error(
        `${label} at ${file} extension ${row.sqlName} dependencies do not match generated metadata`,
      );
    }
    const release = `${row.version}\0${row.tag}`;
    const previousRelease = releasesByOwner.get(owner.releaseProduct);
    if (previousRelease !== undefined && previousRelease !== release) {
      throw new Error(
        `${label} at ${file} contains conflicting releases for owner ${owner.releaseProduct}`,
      );
    }
    releasesByOwner.set(owner.releaseProduct, release);
    if (owner.runtimeBound && row.version !== manifest.base.version) {
      throw new Error(
        `${label} at ${file} runtime-bound owner ${owner.releaseProduct} version ${row.version} ` +
          `must match base ${manifest.base.version}`,
      );
    }
    return {
      dependencies,
      product: owner.releaseProduct,
      sqlName: row.sqlName,
      tag: row.tag,
      version: row.version,
    };
  });
  if (new Set(extensions.map(({ sqlName }) => sqlName)).size !== extensions.length) {
    throw new Error(`${label} at ${file} repeats an extension row`);
  }
  return {
    base: {
      product: manifest.base.product,
      tag: manifest.base.tag,
      version: manifest.base.version,
    },
    carriers: manifest.carriers,
    extensions,
    file: path.resolve(file),
  };
}

function carrierPointerFromPackage(packageJsonFile, expectedPackageName, owner) {
  const installedOwner = owner ? validateInstalledExtensionOwner(packageJsonFile, owner) : undefined;
  const packageJson = installedOwner?.packageJson ??
    readJsonObject(packageJsonFile, `${expectedPackageName} package metadata`);
  if (packageJson.name !== expectedPackageName) {
    throw new Error(
      `${expectedPackageName} resolved to package metadata for ${String(packageJson.name)}`,
    );
  }
  const pointer = packageJson.oliphaunt?.iosCarrierManifest;
  if (typeof pointer !== 'string' || pointer.trim() === '') {
    throw new Error(
      `${expectedPackageName} must declare package.json.oliphaunt.iosCarrierManifest`,
    );
  }
  const packageRoot = path.dirname(packageJsonFile);
  const carrier = path.resolve(packageRoot, pointer);
  const relative = path.relative(packageRoot, carrier);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${expectedPackageName} iOS carrier manifest must stay inside its package`);
  }
  if (path.basename(carrier) !== IOS_CARRIER_FILENAME || !fs.statSync(carrier, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${expectedPackageName} iOS carrier manifest must be the packaged ${IOS_CARRIER_FILENAME}`,
    );
  }
  return {
    carrier,
    ownerLiboliphauntVersion: installedOwner?.liboliphauntVersion,
    ownerVersion: installedOwner?.version,
    packageRoot,
  };
}

function resolvePackageJson(packageName, searchPaths) {
  try {
    return require.resolve(`${packageName}/package.json`, { paths: searchPaths });
  } catch (error) {
    throw new Error(
      `selected extension requires installed package ${packageName}: ${error.message}`,
    );
  }
}

function validateInstalledExtensionOwner(packageJsonFile, owner) {
  const packageJson = readJsonObject(packageJsonFile, `${owner.npmPackage} package metadata`);
  if (packageJson.name !== owner.npmPackage) {
    throw new Error(
      `${owner.npmPackage} resolved to package metadata for ${String(packageJson.name)}`,
    );
  }
  if (
    typeof packageJson.version !== 'string' ||
    packageJson.version.length === 0 ||
    !STABLE_SEMVER_RE.test(packageJson.version)
  ) {
    throw new Error(`${owner.npmPackage} package metadata has an invalid version`);
  }
  if (packageJson.oliphaunt?.product !== owner.releaseProduct) {
    throw new Error(`${owner.npmPackage} package metadata does not declare ${owner.releaseProduct}`);
  }
  const expectedKind = owner.members.length > 1 ? 'exact-extension-bundle' : 'exact-extension';
  if (packageJson.oliphaunt?.kind !== expectedKind) {
    throw new Error(`${owner.npmPackage} package metadata does not declare ${expectedKind}`);
  }
  if (owner.members.length > 1) {
    if (JSON.stringify(packageJson.oliphaunt?.members) !== JSON.stringify(owner.members)) {
      throw new Error(
        `${owner.npmPackage} package metadata members do not match its generated release ownership`,
      );
    }
  } else if (packageJson.oliphaunt?.sqlName !== owner.members[0]) {
    throw new Error(
      `${owner.npmPackage} package metadata does not declare SQL extension ${owner.members[0]}`,
    );
  }
  const liboliphauntVersion = packageJson.oliphaunt?.liboliphauntVersion;
  if (
    typeof liboliphauntVersion !== 'string' ||
    liboliphauntVersion.length === 0 ||
    !STABLE_SEMVER_RE.test(liboliphauntVersion)
  ) {
    throw new Error(`${owner.npmPackage} package metadata does not pin liboliphauntVersion`);
  }
  if (owner.runtimeBound && packageJson.version !== liboliphauntVersion) {
    throw new Error(
      `${owner.npmPackage} is runtime-bound but version ${packageJson.version} does not match liboliphauntVersion ${liboliphauntVersion}`,
    );
  }
  return {
    liboliphauntVersion,
    packageJson,
    packageJsonFile: path.resolve(packageJsonFile),
    packageRoot: path.dirname(packageJsonFile),
    version: packageJson.version,
  };
}

function resolveInstalledExtensionOwners(
  projectRoot,
  extensions,
  {
    liboliphauntVersion,
    packageJsonResolver = resolvePackageJson,
  } = {},
) {
  const closure = selectedExtensionClosure(extensions);
  const ownersByPackage = new Map();
  for (const sqlName of closure) {
    const owner = releaseOwnerForSqlName(sqlName);
    const previous = ownersByPackage.get(owner.npmPackage);
    if (previous) {
      if (
        previous.releaseProduct !== owner.releaseProduct ||
        previous.mavenGroup !== owner.mavenGroup ||
        previous.mavenArtifact !== owner.mavenArtifact ||
        previous.runtimeBound !== owner.runtimeBound ||
        JSON.stringify(previous.members) !== JSON.stringify(owner.members)
      ) {
        throw new Error(`selected SQL members disagree about release owner ${owner.npmPackage}`);
      }
      continue;
    }
    ownersByPackage.set(owner.npmPackage, owner);
  }

  const resolved = [];
  const versionsByMavenCoordinate = new Map();
  const extensionVersions = {};
  let compatibleRuntimeVersion = optionalString(liboliphauntVersion);
  for (const owner of [...ownersByPackage.values()].sort((left, right) =>
    compareText(left.npmPackage, right.npmPackage),
  )) {
    const packageJsonFile = packageJsonResolver(owner.npmPackage, [projectRoot]);
    const installed = validateInstalledExtensionOwner(packageJsonFile, owner);
    if (
      compatibleRuntimeVersion !== undefined &&
      compatibleRuntimeVersion !== installed.liboliphauntVersion
    ) {
      throw new Error(
        `${owner.npmPackage} requires liboliphaunt ${installed.liboliphauntVersion}, but the app selected ${compatibleRuntimeVersion}`,
      );
    }
    compatibleRuntimeVersion ??= installed.liboliphauntVersion;
    const coordinate = `${owner.mavenGroup}:${owner.mavenArtifact}`;
    const previousVersion = versionsByMavenCoordinate.get(coordinate);
    if (previousVersion !== undefined && previousVersion !== installed.version) {
      throw new Error(
        `selected extension packages require conflicting versions ${previousVersion} and ${installed.version} for ${coordinate}`,
      );
    }
    versionsByMavenCoordinate.set(coordinate, installed.version);
    const previousOwnerVersion = extensionVersions[owner.releaseProduct];
    if (previousOwnerVersion !== undefined && previousOwnerVersion !== installed.version) {
      throw new Error(
        `selected extension packages require conflicting versions for ${owner.releaseProduct}`,
      );
    }
    extensionVersions[owner.releaseProduct] = installed.version;
    resolved.push({ ...owner, ...installed });
  }
  return {
    closure,
    extensionVersions,
    liboliphauntVersion: compatibleRuntimeVersion,
    owners: resolved,
  };
}

function serializeExtensionVersions(extensionVersions) {
  return Object.entries(extensionVersions)
    .sort(([left], [right]) => compareText(left, right))
    .map(([owner, version]) => `${owner}=${version}`)
    .join(',');
}

function parseExtensionCarrierOverrides(projectRoot, value) {
  if (value == null || String(value).trim() === '') {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${IOS_EXTENSION_CARRIERS_ENV} must be a JSON object: ${error.message}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${IOS_EXTENSION_CARRIERS_ENV} must be a JSON object keyed by SQL name`);
  }
  const result = new Map();
  for (const [sqlName, file] of Object.entries(parsed)) {
    if (!EXTENSION_NAME_RE.test(sqlName)) {
      throw new Error(`${IOS_EXTENSION_CARRIERS_ENV} contains invalid SQL name ${sqlName}`);
    }
    result.set(
      sqlName,
      absoluteFromProject(projectRoot, file, `${IOS_EXTENSION_CARRIERS_ENV}.${sqlName}`),
    );
  }
  return result;
}

function validateAggregateCarrierClosure(summary, selected) {
  const bySqlName = new Map(summary.extensions.map((row) => [row.sqlName, row]));
  const visited = new Set();
  const visiting = new Set();

  function visit(sqlName, requiredBy) {
    if (visited.has(sqlName)) {
      return;
    }
    if (visiting.has(sqlName)) {
      throw new Error(`aggregate iOS carrier dependency cycle includes ${sqlName}`);
    }
    const row = bySqlName.get(sqlName);
    if (!row) {
      throw new Error(
        `aggregate iOS carrier is missing ${sqlName}${requiredBy ? ` required by ${requiredBy}` : ''}`,
      );
    }
    visiting.add(sqlName);
    for (const dependency of row.dependencies) {
      visit(dependency, sqlName);
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
  }

  for (const sqlName of selected) {
    visit(sqlName, undefined);
  }
}

function resolveIosCarrierManifests(
  projectRoot,
  extensions,
  {
    basePackageRoot = __dirname,
    env = process.env,
    packageJsonResolver = resolvePackageJson,
  } = {},
) {
  const selected = [...new Set(extensions)].sort();
  const baseCarrierOverride = optionalString(env[IOS_BASE_CARRIER_ENV]);
  let baseCarrier;
  if (baseCarrierOverride) {
    baseCarrier = absoluteFromProject(projectRoot, baseCarrierOverride, IOS_BASE_CARRIER_ENV);
  } else {
    baseCarrier = carrierPointerFromPackage(
      path.join(basePackageRoot, 'package.json'),
      '@oliphaunt/react-native',
    ).carrier;
  }
  const baseSummary = readCarrierSummary(baseCarrier, 'React Native base iOS carrier manifest');
  const overrides = parseExtensionCarrierOverrides(
    projectRoot,
    env[IOS_EXTENSION_CARRIERS_ENV],
  );
  if (baseCarrierOverride && baseSummary.extensions.length > 0) {
    if (overrides.size > 0) {
      throw new Error(
        `${IOS_EXTENSION_CARRIERS_ENV} cannot be combined with an aggregate ${IOS_BASE_CARRIER_ENV}`,
      );
    }
    validateAggregateCarrierClosure(baseSummary, selected);
    return [baseSummary.file];
  }
  if (baseSummary.extensions.length !== 0) {
    throw new Error('the installed @oliphaunt/react-native base iOS carrier manifest must be extension-free');
  }

  const visited = new Set();
  const visiting = new Set();
  const extensionCarriers = [];
  const extensionCarrierFiles = new Set();
  const installedOwnerCarriers = new Map();
  const releasesByOwner = new Map();

  function registerOwnerReleases(summary) {
    for (const row of summary.extensions) {
      const release = `${row.version}\0${row.tag}`;
      const previous = releasesByOwner.get(row.product);
      if (previous !== undefined && previous !== release) {
        throw new Error(`iOS carrier manifests require conflicting releases for owner ${row.product}`);
      }
      releasesByOwner.set(row.product, release);
    }
  }

  function visit(sqlName, searchPaths, requiredBy) {
    if (visited.has(sqlName)) {
      return;
    }
    if (visiting.has(sqlName)) {
      throw new Error(`iOS carrier dependency cycle includes ${sqlName}`);
    }
    visiting.add(sqlName);
    const owner = releaseOwnerForSqlName(sqlName);
    const packageName = owner.npmPackage;
    let carrier;
    let dependencySearchPaths = searchPaths;
    let installedOwnerLiboliphauntVersion;
    let installedOwnerVersion;
    let summary;
    if (overrides.has(sqlName)) {
      carrier = overrides.get(sqlName);
    } else {
      const cached = installedOwnerCarriers.get(packageName);
      if (cached) {
        carrier = cached.carrier;
        dependencySearchPaths = cached.dependencySearchPaths;
        installedOwnerLiboliphauntVersion = cached.installedOwnerLiboliphauntVersion;
        installedOwnerVersion = cached.installedOwnerVersion;
        summary = cached.summary;
      } else {
        let packageJsonFile;
        try {
          packageJsonFile = packageJsonResolver(packageName, searchPaths);
        } catch (error) {
          const suffix = requiredBy ? ` required by ${requiredBy}` : '';
          throw new Error(`missing ${packageName}${suffix}: ${error.message}`);
        }
        const resolved = carrierPointerFromPackage(packageJsonFile, packageName, owner);
        carrier = resolved.carrier;
        installedOwnerLiboliphauntVersion = resolved.ownerLiboliphauntVersion;
        installedOwnerVersion = resolved.ownerVersion;
        dependencySearchPaths = [resolved.packageRoot, ...searchPaths];
        summary = readCarrierSummary(carrier, `${packageName} iOS carrier manifest`);
        const carrierMembers = summary.extensions.map((row) => row.sqlName).sort();
        if (JSON.stringify(carrierMembers) !== JSON.stringify(owner.members)) {
          throw new Error(
            `${packageName} iOS carrier members do not match its generated release ownership`,
          );
        }
        installedOwnerCarriers.set(packageName, {
            carrier,
            dependencySearchPaths,
            installedOwnerLiboliphauntVersion,
            installedOwnerVersion,
            summary,
          });
      }
    }
    summary ??= readCarrierSummary(carrier, `${packageName} iOS carrier manifest`);
    if (JSON.stringify(summary.base) !== JSON.stringify(baseSummary.base)) {
      throw new Error(
        `${packageName} iOS carrier pins ${summary.base.tag}, but the selected base carrier ` +
          `pins ${baseSummary.base.tag}`,
      );
    }
    if (
      installedOwnerLiboliphauntVersion !== undefined &&
      summary.base.version !== installedOwnerLiboliphauntVersion
    ) {
      throw new Error(
        `${packageName} iOS carrier base ${summary.base.version} does not match installed package ` +
          `liboliphauntVersion ${installedOwnerLiboliphauntVersion}`,
      );
    }
    registerOwnerReleases(summary);
    const extensionRow = summary.extensions.find((row) => row.sqlName === sqlName);
    if (!extensionRow) {
      throw new Error(
        `${packageName} iOS carrier manifest does not contain the ${sqlName} extension row`,
      );
    }
    if (installedOwnerVersion !== undefined && extensionRow.version !== installedOwnerVersion) {
      throw new Error(
        `${packageName} iOS carrier version ${extensionRow.version} does not match installed package ` +
          `version ${installedOwnerVersion}`,
      );
    }
    for (const dependency of extensionRow.dependencies) {
      visit(dependency, dependencySearchPaths, sqlName);
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
    if (!extensionCarrierFiles.has(summary.file)) {
      extensionCarrierFiles.add(summary.file);
      extensionCarriers.push(summary.file);
    }
  }

  for (const sqlName of selected) {
    visit(sqlName, [projectRoot], undefined);
  }
  return [baseSummary.file, ...extensionCarriers];
}

function explicitBooleanEnv(env, name) {
  const value = optionalString(env[name]);
  if (value === undefined || value === '0' || value === 'false') {
    return false;
  }
  if (value === '1' || value === 'true') {
    return true;
  }
  throw new Error(`${name} must be one of 1, 0, true, or false`);
}

function iosStageCommand(
  projectRoot,
  iosRoot,
  normalized,
  { basePackageRoot = __dirname, env = process.env, packageJsonResolver = resolvePackageJson } = {},
) {
  const outputDir = path.join(iosRoot, 'oliphaunt');
  const carrierManifests = resolveIosCarrierManifests(projectRoot, normalized.extensions, {
    basePackageRoot,
    env,
    packageJsonResolver,
  });
  const args = [path.join(__dirname, 'tools', 'stage-ios-app.mjs')];
  for (const carrier of carrierManifests) {
    args.push('--carrier', carrier);
  }
  args.push('--output-dir', outputDir);
  if (normalized.extensions.length > 0) {
    args.push('--extensions', normalized.extensions.join(','));
  }
  if (normalized.icu) {
    args.push('--icu');
  }
  const cacheDir = optionalString(env[IOS_CARRIER_CACHE_ENV]);
  if (cacheDir) {
    args.push('--cache-dir', absoluteFromProject(projectRoot, cacheDir, IOS_CARRIER_CACHE_ENV));
  }
  if (explicitBooleanEnv(env, IOS_ALLOW_FILE_URLS_ENV)) {
    args.push('--allow-file-urls');
  }
  return {
    args,
    carrierManifests,
    command: process.execPath,
    outputDir,
  };
}

// The published config plugin cannot depend on repository tooling. Keep this
// regular-file capture local so Bun never has to drain synchronous child pipes.
function captureCommandOutputSync(command, args, { cwd, env, label }) {
  const maximum = 64 * 1024 * 1024;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-react-native-command-'));
  const stdoutFile = path.join(directory, 'stdout');
  const stderrFile = path.join(directory, 'stderr');
  let stdoutDescriptor;
  let stderrDescriptor;
  try {
    stdoutDescriptor = fs.openSync(stdoutFile, 'wx', 0o600);
    stderrDescriptor = fs.openSync(stderrFile, 'wx', 0o600);
    const result = spawnSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
    });
    fs.closeSync(stdoutDescriptor);
    stdoutDescriptor = undefined;
    fs.closeSync(stderrDescriptor);
    stderrDescriptor = undefined;
    for (const [file, stream] of [[stdoutFile, 'stdout'], [stderrFile, 'stderr']]) {
      const bytes = fs.statSync(file).size;
      if (bytes > maximum) {
        throw new Error(`${label} ${stream} exceeded the ${maximum}-byte capture limit`);
      }
    }
    return {
      ...result,
      stderr: fs.readFileSync(stderrFile, 'utf8'),
      stdout: fs.readFileSync(stdoutFile, 'utf8'),
    };
  } finally {
    if (stdoutDescriptor !== undefined) fs.closeSync(stdoutDescriptor);
    if (stderrDescriptor !== undefined) fs.closeSync(stderrDescriptor);
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function stageIosAppPayload(
  projectRoot,
  iosRoot,
  normalized,
  {
    basePackageRoot = __dirname,
    env = process.env,
    packageJsonResolver = resolvePackageJson,
    spawnSyncImpl = undefined,
  } = {},
) {
  const command = iosStageCommand(projectRoot, iosRoot, normalized, {
    basePackageRoot,
    env,
    packageJsonResolver,
  });
  const result = spawnSyncImpl === undefined
    ? captureCommandOutputSync(command.command, command.args, {
        cwd: projectRoot,
        env,
        label: 'iOS carrier resolver',
      })
    : spawnSyncImpl(command.command, command.args, {
        cwd: projectRoot,
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  if (result.error) {
    throw new Error(`failed to start the iOS carrier resolver: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(
      `iOS carrier resolver failed${result.status == null ? '' : ` with exit code ${result.status}`}: ${detail || 'no diagnostic output'}`,
    );
  }
  const podspec = path.join(command.outputDir, 'OliphauntReactNativePayload.podspec');
  if (!fs.statSync(podspec, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`iOS carrier resolver did not produce ${podspec}`);
  }
  return command;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function compareAppleDeploymentTargets(left, right) {
  const parse = (value) => {
    if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(value)) {
      throw new Error(`iOS deployment target must be a numeric dotted version, got ${JSON.stringify(value)}`);
    }
    return value.split('.').map((part) => Number(part));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function ensureIosDeploymentTarget(properties) {
  if (properties === null || Array.isArray(properties) || typeof properties !== 'object') {
    throw new Error('ios/Podfile.properties.json must contain a JSON object');
  }
  const current = properties['ios.deploymentTarget'];
  if (
    current !== undefined &&
    compareAppleDeploymentTargets(current, IOS_MINIMUM_DEPLOYMENT_TARGET) >= 0
  ) {
    return { ...properties };
  }
  return { ...properties, 'ios.deploymentTarget': IOS_MINIMUM_DEPLOYMENT_TARGET };
}

function ensureIosConfigDeploymentTarget(config) {
  if (config === null || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Expo config must be an object');
  }
  const ios = config.ios ?? {};
  const normalized = ensureIosDeploymentTarget(
    ios.deploymentTarget === undefined
      ? {}
      : { 'ios.deploymentTarget': ios.deploymentTarget },
  );
  return {
    ...config,
    ios: {
      ...ios,
      deploymentTarget: normalized['ios.deploymentTarget'],
    },
  };
}

function ensureIosDeploymentTargetFile(file) {
  const before = fs.existsSync(file) ? readJsonObject(file, 'ios/Podfile.properties.json') : {};
  const after = ensureIosDeploymentTarget(before);
  if (JSON.stringify(after) !== JSON.stringify(before)) writeJson(file, after);
}

function mergeProperties(file, entries) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  }
  const keys = new Set(Object.keys(entries));
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      return true;
    }
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    return !keys.has(key);
  });
  for (const [key, value] of Object.entries(entries)) {
    if (value != null && String(value).trim() !== '') {
      kept.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(file, `${kept.join('\n').replace(/\n+$/, '')}\n`);
}

function iosPodfileBlock(options = {}) {
  const lines = [
    IOS_PODFILE_START,
    "oliphaunt_podspecs_path = File.expand_path('../node_modules/@oliphaunt/react-native/ios/podspecs', __dir__)",
    "pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec'), :modular_headers => true",
    "pod 'Oliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'Oliphaunt.podspec')",
    "oliphaunt_payload_path = File.expand_path('oliphaunt', __dir__)",
    "oliphaunt_payload_podspec = File.join(oliphaunt_payload_path, 'OliphauntReactNativePayload.podspec')",
    "raise 'Oliphaunt iOS payload is missing; rerun Expo prebuild' unless File.file?(oliphaunt_payload_podspec)",
    "pod 'OliphauntReactNativePayload', :path => oliphaunt_payload_path",
  ];
  lines.push(IOS_PODFILE_END);
  return lines.join('\n');
}

function replaceMarkedBlock(contents, block) {
  const start = contents.indexOf(IOS_PODFILE_START);
  const end = contents.indexOf(IOS_PODFILE_END);
  if (start === -1 && end === -1) {
    return undefined;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error('ios/Podfile has a partial @oliphaunt/react-native managed block');
  }
  const lineStart = contents.lastIndexOf('\n', start) + 1;
  const indent = contents.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? '';
  const indentedBlock = block
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  const afterEnd = end + IOS_PODFILE_END.length;
  return `${contents.slice(0, lineStart)}${indentedBlock}${contents.slice(afterEnd)}`;
}

function insertIosPodfileBlock(contents, options = {}) {
  const block = iosPodfileBlock(options);
  const replaced = replaceMarkedBlock(contents, block);
  if (replaced !== undefined) {
    return `${replaced.replace(/\n+$/, '')}\n`;
  }

  const lines = contents.split(/\r?\n/);
  const anchorIndex = lines.findIndex((line) => /config\s*=\s*use_native_modules!\s*/.test(line));
  const fallbackIndex = lines.findIndex((line) => /^\s*use_expo_modules!\s*$/.test(line));
  const insertAfter = anchorIndex >= 0 ? anchorIndex : fallbackIndex;
  if (insertAfter < 0) {
    throw new Error('ios/Podfile must call use_native_modules! or use_expo_modules! before Oliphaunt can add Swift SDK podspecs');
  }
  const indent = lines[insertAfter].match(/^\s*/)?.[0] ?? '';
  const indentedBlock = block
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  lines.splice(insertAfter + 1, 0, indentedBlock);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function patchIosPodfile(file, options = {}) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = insertIosPodfileBlock(before, options);
  if (after !== before) {
    fs.writeFileSync(file, after);
  }
  return true;
}

function androidPluginVersion(options) {
  return optionalString(options.kotlinPluginVersion) ?? packageMetadata.oliphaunt?.kotlinSdkVersion;
}

function androidAppPluginLine(version) {
  return `    id 'dev.oliphaunt.android' version '${version}'`;
}

function insertAppGradlePlugin(contents, version) {
  if (ANDROID_APP_PLUGIN_RE.test(contents)) {
    return `${contents.replace(/\n+$/, '')}\n`;
  }
  const lines = contents.split(/\r?\n/);
  const pluginsIndex = lines.findIndex((line) => /^\s*plugins\s*\{\s*$/.test(line));
  if (pluginsIndex < 0) {
    return `plugins {\n${androidAppPluginLine(version)}\n}\n\n${contents.replace(/\n+$/, '')}\n`;
  }
  let insertAt = pluginsIndex + 1;
  while (insertAt < lines.length && lines[insertAt].trim().startsWith('//')) {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, androidAppPluginLine(version));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function patchAndroidGradle(androidRoot, normalized) {
  const version = androidPluginVersion(normalized);
  if (!version) {
    throw new Error('@oliphaunt/react-native requires oliphaunt.kotlinSdkVersion metadata or kotlinPluginVersion');
  }
  const appBuildGradle = path.join(androidRoot, 'app', 'build.gradle');
  if (fs.existsSync(appBuildGradle)) {
    const before = fs.readFileSync(appBuildGradle, 'utf8');
    const after = insertAppGradlePlugin(before, version);
    if (after !== before) {
      fs.writeFileSync(appBuildGradle, after);
    }
  }
}

function withOliphaunt(config, options = {}) {
  const plugin = require('expo/config-plugins');
  const normalized = normalizeOptions(options);
  // Expo's built-in iOS mods consume this synchronously and propagate it to
  // both the Xcode project and Podfile.properties.json during prebuild.
  config = ensureIosConfigDeploymentTarget(config);

  config = plugin.withDangerousMod(config, [
    'android',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      const installedExtensions = resolveInstalledExtensionOwners(
        projectRoot,
        normalized.extensions,
        { liboliphauntVersion: normalized.liboliphauntVersion },
      );
      const androidOptions = {
        ...normalized,
        extensionVersions: installedExtensions.extensionVersions,
        liboliphauntVersion: installedExtensions.liboliphauntVersion,
      };
      writeJson(path.join(androidRoot, 'oliphaunt.json'), androidOptions);
      mergeProperties(path.join(androidRoot, 'gradle.properties'), {
        oliphauntExtensions: normalized.extensions.join(','),
        oliphauntExtensionVersions: serializeExtensionVersions(
          installedExtensions.extensionVersions,
        ),
        oliphauntIcu: normalized.icu ? 'true' : undefined,
        oliphauntLiboliphauntVersion: installedExtensions.liboliphauntVersion,
        oliphauntAssetBaseUrl: normalized.assetBaseUrl,
      });
      patchAndroidGradle(androidRoot, androidOptions);
      return modConfig;
    },
  ]);

  config = plugin.withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const iosRoot = path.join(projectRoot, 'ios');
      stageIosAppPayload(projectRoot, iosRoot, normalized);
      writeJson(path.join(iosRoot, 'oliphaunt.json'), normalized);
      writeJson(path.join(iosRoot, 'OliphauntExtensions.json'), {
        extensions: normalized.extensions,
        icu: normalized.icu,
        liboliphauntVersion: normalized.liboliphauntVersion,
        assetBaseUrl: normalized.assetBaseUrl,
      });
      ensureIosDeploymentTargetFile(path.join(iosRoot, 'Podfile.properties.json'));
      patchIosPodfile(path.join(iosRoot, 'Podfile'), normalized);
      return modConfig;
    },
  ]);

  return config;
}

module.exports = withOliphaunt;
module.exports.withOliphaunt = withOliphaunt;
module.exports.normalizeOptions = normalizeOptions;
module.exports.extensionPackageName = extensionPackageName;
module.exports.selectedExtensionClosure = selectedExtensionClosure;
module.exports.releaseOwnerForSqlName = releaseOwnerForSqlName;
module.exports.resolveInstalledExtensionOwners = resolveInstalledExtensionOwners;
module.exports.serializeExtensionVersions = serializeExtensionVersions;
module.exports.readCarrierSummary = readCarrierSummary;
module.exports.resolveIosCarrierManifests = resolveIosCarrierManifests;
module.exports.iosStageCommand = iosStageCommand;
module.exports.stageIosAppPayload = stageIosAppPayload;
module.exports.insertIosPodfileBlock = insertIosPodfileBlock;
module.exports.iosPodfileBlock = iosPodfileBlock;
module.exports.ensureIosDeploymentTarget = ensureIosDeploymentTarget;
module.exports.ensureIosConfigDeploymentTarget = ensureIosConfigDeploymentTarget;
module.exports.insertAppGradlePlugin = insertAppGradlePlugin;
