const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXTENSION_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const packageMetadata = require('./package.json');
const extensionMetadata = require('./src/generated/extensions.json');
const IOS_PODFILE_START = '# @oliphaunt/react-native begin';
const IOS_PODFILE_END = '# @oliphaunt/react-native end';
const IOS_CARRIER_SCHEMA = 'oliphaunt-react-native-ios-carrier-v1';
const IOS_CARRIER_FILENAME = 'oliphaunt-react-native-ios-carriers.json';
const IOS_BASE_CARRIER_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER';
const IOS_EXTENSION_CARRIERS_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS';
const IOS_CARRIER_CACHE_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_CACHE_DIR';
const IOS_ALLOW_FILE_URLS_ENV = 'OLIPHAUNT_REACT_NATIVE_IOS_ALLOW_FILE_URLS';
const ANDROID_APP_PLUGIN_RE = /id\s*(?:\(\s*)?['"]dev\.oliphaunt\.android['"]/;
const KNOWN_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions.map((extension) => extension['sql-name']),
);
const MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES = new Set(
  extensionMetadata.extensions
    .filter((extension) => extension['mobile-release-ready'] === true)
    .map((extension) => extension['sql-name']),
);

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
  return `@oliphaunt/extension-${sqlName.replaceAll('_', '-')}`;
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
  if (!Array.isArray(manifest.extensions)) {
    throw new Error(`${label} at ${file} must contain an extensions array`);
  }
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
    return { dependencies, sqlName: row.sqlName };
  });
  if (new Set(extensions.map(({ sqlName }) => sqlName)).size !== extensions.length) {
    throw new Error(`${label} at ${file} repeats an extension row`);
  }
  return { extensions, file: path.resolve(file) };
}

function carrierPointerFromPackage(packageJsonFile, expectedPackageName) {
  const packageJson = readJsonObject(packageJsonFile, `${expectedPackageName} package metadata`);
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
  return { carrier, packageRoot };
}

function resolvePackageJson(packageName, searchPaths) {
  try {
    return require.resolve(`${packageName}/package.json`, { paths: searchPaths });
  } catch (error) {
    throw new Error(
      `selected iOS extension requires installed package ${packageName}: ${error.message}`,
    );
  }
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

  function visit(sqlName, searchPaths, requiredBy) {
    if (visited.has(sqlName)) {
      return;
    }
    if (visiting.has(sqlName)) {
      throw new Error(`iOS carrier dependency cycle includes ${sqlName}`);
    }
    visiting.add(sqlName);
    const packageName = extensionPackageName(sqlName);
    let carrier;
    let dependencySearchPaths = searchPaths;
    if (overrides.has(sqlName)) {
      carrier = overrides.get(sqlName);
    } else {
      let packageJsonFile;
      try {
        packageJsonFile = packageJsonResolver(packageName, searchPaths);
      } catch (error) {
        const suffix = requiredBy ? ` required by ${requiredBy}` : '';
        throw new Error(`missing ${packageName}${suffix}: ${error.message}`);
      }
      const resolved = carrierPointerFromPackage(packageJsonFile, packageName);
      carrier = resolved.carrier;
      dependencySearchPaths = [resolved.packageRoot, ...searchPaths];
    }
    const summary = readCarrierSummary(carrier, `${packageName} iOS carrier manifest`);
    if (summary.extensions.length !== 1 || summary.extensions[0].sqlName !== sqlName) {
      throw new Error(
        `${packageName} iOS carrier manifest must contain exactly the ${sqlName} extension row`,
      );
    }
    for (const dependency of summary.extensions[0].dependencies) {
      visit(dependency, dependencySearchPaths, sqlName);
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
    extensionCarriers.push(summary.file);
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

function stageIosAppPayload(
  projectRoot,
  iosRoot,
  normalized,
  {
    basePackageRoot = __dirname,
    env = process.env,
    packageJsonResolver = resolvePackageJson,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  const command = iosStageCommand(projectRoot, iosRoot, normalized, {
    basePackageRoot,
    env,
    packageJsonResolver,
  });
  const result = spawnSyncImpl(command.command, command.args, {
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
    "oliphaunt_payload_podspec = File.expand_path('oliphaunt/OliphauntReactNativePayload.podspec', __dir__)",
    "raise 'Oliphaunt iOS payload is missing; rerun Expo prebuild' unless File.file?(oliphaunt_payload_podspec)",
    "pod 'OliphauntReactNativePayload', :podspec => oliphaunt_payload_podspec",
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

  config = plugin.withDangerousMod(config, [
    'android',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      writeJson(path.join(androidRoot, 'oliphaunt.json'), normalized);
      mergeProperties(path.join(androidRoot, 'gradle.properties'), {
        oliphauntExtensions: normalized.extensions.join(','),
        oliphauntIcu: normalized.icu ? 'true' : undefined,
        oliphauntLiboliphauntVersion: normalized.liboliphauntVersion,
        oliphauntAssetBaseUrl: normalized.assetBaseUrl,
      });
      patchAndroidGradle(androidRoot, normalized);
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
module.exports.readCarrierSummary = readCarrierSummary;
module.exports.resolveIosCarrierManifests = resolveIosCarrierManifests;
module.exports.iosStageCommand = iosStageCommand;
module.exports.stageIosAppPayload = stageIosAppPayload;
module.exports.insertIosPodfileBlock = insertIosPodfileBlock;
module.exports.iosPodfileBlock = iosPodfileBlock;
module.exports.insertAppGradlePlugin = insertAppGradlePlugin;
