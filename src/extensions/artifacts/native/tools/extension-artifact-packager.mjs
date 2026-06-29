#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '../../../../..');

const CATALOG_PATH = path.join(root, 'src/extensions/generated/extensions.catalog.json');
const CONTRIB_RECIPE_PATH = path.join(root, 'src/extensions/contrib/postgres18.toml');
const RELEASE_CONFIG_PATH = path.join(root, 'release-please-config.json');

function fail(message) {
  throw new Error(message);
}

async function readText(relativeOrAbsolute) {
  return fs.readFile(path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(root, relativeOrAbsolute), 'utf8');
}

async function readJson(relativeOrAbsolute) {
  return JSON.parse(await readText(relativeOrAbsolute));
}

async function readToml(relativeOrAbsolute) {
  return Bun.TOML.parse(await readText(relativeOrAbsolute));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(file) {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}

function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0).sort();
}

function splitCsv(value) {
  if (value === undefined || value === null || value === '' || value === '-') {
    return [];
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sortedDeduped(values) {
  return [...new Set(values.filter((item) => item !== undefined && item !== null && String(item).length > 0).map(String))].sort();
}

function dashIfEmpty(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '-' : value.join(',');
  }
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function validatePortableId(value, label) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    fail(`${label} '${value}' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'`);
  }
}

function validateCIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail(`${label} '${value}' must be a portable C identifier`);
  }
}

function validateRelativeArtifactPath(value, label) {
  if (!value || path.isAbsolute(value)) {
    fail(`${label} '${value}' must be a relative path`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label} '${value}' must not contain '.', '..', or empty path components`);
  }
  return parts.join('/');
}

function nativeModuleStem(extension) {
  const moduleFile = extension['native-module-file'] ?? extension['module-file'];
  if (typeof moduleFile !== 'string' || moduleFile.length === 0) {
    return '';
  }
  for (const suffix of ['.so', '.dylib', '.dll']) {
    if (moduleFile.endsWith(suffix)) {
      return moduleFile.slice(0, -suffix.length);
    }
  }
  return moduleFile;
}

function sharedPreloadLibraries(extension) {
  const startupConfig = extension.lifecycle?.['startup-config'] ?? [];
  const libraries = [];
  for (const assignment of startupConfig) {
    if (typeof assignment !== 'string') {
      continue;
    }
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    if (assignment.slice(0, separator) === 'shared_preload_libraries') {
      libraries.push(...splitCsv(assignment.slice(separator + 1)));
    }
  }
  return sortedDeduped(libraries);
}

async function externalRecipe(sqlName) {
  const recipePath = path.join(root, 'src/extensions/external', sqlName, 'recipe.toml');
  if (!(await isFile(recipePath))) {
    return null;
  }
  return readToml(recipePath);
}

async function extensionDataFiles(extension, contribRows) {
  const sqlName = extension['sql-name'] ?? extension.id;
  const recipe = await externalRecipe(sqlName);
  if (recipe !== null) {
    return stringList(recipe.artifacts?.data_files);
  }
  const row = contribRows.find((item) => item?.['sql-name'] === sqlName);
  return stringList(row?.['data-files']);
}

function runtimeShareDataFiles(dataFiles) {
  const prefix = 'share/postgresql/';
  return dataFiles.map((item) => (item.startsWith(prefix) ? item.slice(prefix.length) : item)).sort();
}

async function extensionArtifactList(sqlName, field) {
  const recipe = await externalRecipe(sqlName);
  if (recipe === null) {
    return [];
  }
  return stringList(recipe.artifacts?.[field]);
}

async function externalTargetStatus(sqlName, target) {
  const targetPath = path.join(root, 'src/extensions/external', sqlName, 'targets', `${target}.toml`);
  if (!(await isFile(targetPath))) {
    return null;
  }
  const data = await readToml(targetPath);
  return typeof data.status === 'string' ? data.status : null;
}

async function extensionSupportStatuses(sqlName, family) {
  const recipe = await externalRecipe(sqlName);
  const support = recipe?.support?.[family];
  if (support === undefined || support === null || typeof support !== 'object') {
    return [];
  }
  return Object.values(support).filter((value) => typeof value === 'string');
}

async function mobileReleaseReady(sqlName) {
  const targetStatus = await externalTargetStatus(sqlName, 'mobile');
  if (targetStatus !== null) {
    return targetStatus === 'supported';
  }
  const statuses = await extensionSupportStatuses(sqlName, 'mobile');
  return statuses.length === 0 || statuses.every((status) => status === 'supported');
}

async function desktopReleaseReady(sqlName, promotion) {
  if (!(promotion?.promoted === true && promotion?.stable === true)) {
    return false;
  }
  const targetStatus = await externalTargetStatus(sqlName, 'native');
  if (targetStatus !== null) {
    return targetStatus === 'supported';
  }
  const statuses = await extensionSupportStatuses(sqlName, 'native');
  return statuses.length === 0 || statuses.every((status) => status === 'supported');
}

async function catalogRows() {
  const catalog = await readJson(CATALOG_PATH);
  const contrib = await readToml(CONTRIB_RECIPE_PATH);
  const contribRows = Array.isArray(contrib.extensions) ? contrib.extensions : [];
  const extensions = Array.isArray(catalog.extensions) ? catalog.extensions : [];
  const publicSqlNames = new Set(
    extensions
      .filter((extension) => extension.promotion?.promoted === true)
      .map((extension) => extension['sql-name'] ?? extension.id),
  );
  const rows = [];
  for (const extension of extensions) {
    const promotion = extension.promotion ?? {};
    if (!(promotion.promoted === true && promotion.stable === true)) {
      continue;
    }
    const sqlName = extension['sql-name'] ?? extension.id;
    const dependencies = stringList(extension.dependencies).filter((dependency) => publicSqlNames.has(dependency));
    const dataFiles = runtimeShareDataFiles(await extensionDataFiles(extension, contribRows));
    const stem = nativeModuleStem(extension);
    rows.push({
      sqlName,
      pgMajor: '18',
      createsExtension: Boolean(extension.lifecycle?.['create-extension']),
      stem,
      dependencies,
      sharedPreload: sharedPreloadLibraries(extension),
      desktopPrebuilt: await desktopReleaseReady(sqlName, promotion),
      mobilePrebuilt: await mobileReleaseReady(sqlName),
      mobileStaticRequired: stem.length > 0,
      mobileStaticTargets: [],
      dataFiles,
      artifact: 'first-party',
    });
  }
  rows.sort((left, right) => left.sqlName.localeCompare(right.sqlName));
  return rows;
}

async function listCatalog() {
  const header = [
    'sql_name',
    'pg_major',
    'creates_extension',
    'native_module_stem',
    'dependencies',
    'shared_preload',
    'desktop_prebuilt',
    'mobile_prebuilt',
    'mobile_static_registry_required',
    'mobile_static_archive_targets',
    'data_files',
    'artifact',
  ];
  console.log(header.join('\t'));
  for (const row of await catalogRows()) {
    console.log(
      [
        row.sqlName,
        row.pgMajor,
        yesNo(row.createsExtension),
        dashIfEmpty(row.stem),
        dashIfEmpty(row.dependencies),
        dashIfEmpty(row.sharedPreload),
        yesNo(row.desktopPrebuilt),
        yesNo(row.mobilePrebuilt),
        yesNo(row.mobileStaticRequired),
        dashIfEmpty(row.mobileStaticTargets),
        dashIfEmpty(row.dataFiles),
        row.artifact,
      ].join('\t'),
    );
  }
}

async function releasePackageByProduct(product) {
  const releaseConfig = await readJson(RELEASE_CONFIG_PATH);
  const packages = releaseConfig.packages ?? {};
  for (const [packagePath, config] of Object.entries(packages)) {
    if (config?.component === product) {
      return { packagePath, config };
    }
  }
  fail(`unknown release product '${product}'`);
}

async function productReleaseMetadata(product) {
  const { packagePath } = await releasePackageByProduct(product);
  const releaseTomlPath = path.join(root, packagePath, 'release.toml');
  const metadata = await readToml(releaseTomlPath);
  if (metadata.id !== product) {
    fail(`${path.relative(root, releaseTomlPath)} must declare id = '${product}'`);
  }
  return metadata;
}

async function selectedSqlNames(productsCsv) {
  const products = sortedDeduped(splitCsv(productsCsv));
  if (products.length === 0) {
    fail('no exact-extension products were selected');
  }
  const sqlNames = [];
  for (const product of products) {
    const metadata = await productReleaseMetadata(product);
    if (metadata.kind !== 'exact-extension-artifact') {
      fail(`${product} is not an exact-extension artifact product`);
    }
    if (typeof metadata.extension_sql_name !== 'string' || metadata.extension_sql_name.length === 0) {
      fail(`${product} release metadata must declare extension_sql_name`);
    }
    sqlNames.push(metadata.extension_sql_name);
  }
  console.log(sortedDeduped(sqlNames).join(','));
}

function parseCargoVersion(text) {
  let inPackage = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith('[')) {
      break;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (match) {
        return match[1];
      }
    }
  }
  return '';
}

function parseJsonPath(text, dotted) {
  let value = JSON.parse(text);
  for (const key of dotted.split('.')) {
    if (value === null || typeof value !== 'object' || !(key in value)) {
      return '';
    }
    value = value[key];
  }
  return String(value);
}

async function productVersion(product) {
  const { packagePath, config } = await releasePackageByProduct(product);
  const releaseType = config['release-type'];
  const relativeVersionFile =
    typeof config['version-file'] === 'string' && config['version-file'].length > 0
      ? config['version-file']
      : releaseType === 'rust'
        ? 'Cargo.toml'
        : releaseType === 'node' || releaseType === 'expo'
          ? 'package.json'
          : null;
  if (relativeVersionFile === null) {
    fail(`${product} release-please config must declare version-file for release type '${releaseType}'`);
  }
  const versionFile = path.join(root, packagePath, relativeVersionFile);
  const text = await readText(versionFile);
  const parser =
    path.basename(versionFile) === 'Cargo.toml'
      ? 'cargo'
      : path.basename(versionFile) === 'package.json'
        ? 'json:version'
        : 'raw';
  const version = parser === 'cargo' ? parseCargoVersion(text) : parser.startsWith('json:') ? parseJsonPath(text, parser.slice(5)) : text.trim();
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    fail(`${product} version is not semver-like: '${version}'`);
  }
  console.log(version);
}

function parseArgs(argv) {
  const args = {
    dependencies: [],
    dataFiles: [],
    sharedPreloadLibraries: [],
    mobileStaticArchives: [],
    mobileStaticDependencyArchives: [],
    staticSymbolAliases: [],
    createsExtension: true,
    mobilePrebuilt: false,
    format: 'directory',
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let value = null;
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 0) {
      value = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    }
    const nextValue = () => {
      if (value !== null) {
        return value;
      }
      index += 1;
      if (index >= argv.length) {
        fail(`${arg} requires a value`);
      }
      return argv[index];
    };
    switch (arg) {
      case '--force':
        args.force = true;
        break;
      case '--no-create-extension':
        args.createsExtension = false;
        break;
      case '--mobile-prebuilt':
        args.mobilePrebuilt = value === null ? true : parseBoolean(nextValue(), arg);
        break;
      case '--no-mobile-prebuilt':
        args.mobilePrebuilt = false;
        break;
      case '--runtime':
        args.runtime = nextValue();
        break;
      case '--sql-name':
        args.sqlName = nextValue();
        break;
      case '--creates-extension':
        args.createsExtension = parseBoolean(nextValue(), arg);
        break;
      case '--target':
      case '--native-target':
        args.nativeTarget = nextValue();
        break;
      case '--output':
      case '-o':
        args.output = nextValue();
        break;
      case '--stage-root':
        args.stageRoot = nextValue();
        break;
      case '--format':
        args.format = nextValue();
        break;
      case '--native-module-stem':
        args.nativeModuleStem = nextValue();
        break;
      case '--native-module-file':
        args.nativeModuleFile = nextValue();
        break;
      case '--dependency':
      case '--dependencies':
        args.dependencies.push(...splitCsv(nextValue()));
        break;
      case '--data-file':
      case '--data-files':
        args.dataFiles.push(...splitCsv(nextValue()).map((item) => validateRelativeArtifactPath(item, 'data file')));
        break;
      case '--shared-preload-library':
      case '--shared-preload-libraries':
        args.sharedPreloadLibraries.push(...splitCsv(nextValue()));
        break;
      case '--mobile-static-archive':
      case '--mobile-static-archives':
        args.mobileStaticArchives.push(...splitCsv(nextValue()).map(parseMobileStaticArchive));
        break;
      case '--mobile-static-dependency-archive':
      case '--mobile-static-dependency-archives':
        args.mobileStaticDependencyArchives.push(...splitCsv(nextValue()).map(parseMobileStaticDependencyArchive));
        break;
      case '--static-symbol-prefix':
        args.staticSymbolPrefix = nextValue();
        break;
      case '--static-symbol-alias':
      case '--static-symbol-aliases':
        args.staticSymbolAliases.push(...splitCsv(nextValue()).map(parseStaticSymbolAlias));
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }
  return args;
}

function parseBoolean(value, label) {
  if (['true', 'yes', '1'].includes(value)) {
    return true;
  }
  if (['false', 'no', '0'].includes(value)) {
    return false;
  }
  fail(`${label} expected true/false, got '${value}'`);
}

function parseMobileStaticArchive(value) {
  const separator = value.includes('=') ? value.indexOf('=') : value.indexOf(':');
  if (separator <= 0) {
    fail('--mobile-static-archive values must use <target>:<archive> or <target>=<archive>');
  }
  const target = value.slice(0, separator).trim();
  const archive = value.slice(separator + 1).trim();
  if (target.length === 0 || archive.length === 0) {
    fail('--mobile-static-archive values must include both target and archive path');
  }
  return { target, archive };
}

function parseMobileStaticDependencyArchive(value) {
  if (value.includes('=')) {
    const [left, archive] = value.split(/=(.*)/s);
    const [target, name] = left.split(':');
    if (!target || !name || !archive) {
      fail('--mobile-static-dependency-archive values must use <target>:<name>:<archive> or <target>:<name>=<archive>');
    }
    return { target: target.trim(), name: name.trim(), archive: archive.trim() };
  }
  const parts = value.split(':');
  if (parts.length < 3) {
    fail('--mobile-static-dependency-archive values must use <target>:<name>:<archive> or <target>:<name>=<archive>');
  }
  const target = parts.shift().trim();
  const name = parts.shift().trim();
  const archive = parts.join(':').trim();
  if (!target || !name || !archive) {
    fail('--mobile-static-dependency-archive values must include target, name, and archive path');
  }
  return { target, name, archive };
}

function parseStaticSymbolAlias(value) {
  const separator = value.includes('=') ? value.indexOf('=') : value.indexOf(':');
  if (separator <= 0) {
    fail('--static-symbol-alias values must use <sql-symbol>:<linked-symbol> or <sql-symbol>=<linked-symbol>');
  }
  const sqlSymbol = value.slice(0, separator).trim();
  const linkedSymbol = value.slice(separator + 1).trim();
  if (sqlSymbol.length === 0 || linkedSymbol.length === 0) {
    fail('--static-symbol-alias values must include both SQL and linked C symbols');
  }
  return { sqlSymbol, linkedSymbol };
}

async function validateArtifactArgs(args) {
  for (const [value, label] of [
    [args.sqlName, 'prebuilt extension sqlName'],
    [args.nativeModuleStem, 'prebuilt extension native module stem'],
    [args.nativeModuleFile, 'prebuilt extension native module file'],
    [args.nativeTarget, 'prebuilt extension native target'],
  ]) {
    if (value !== undefined) {
      validatePortableId(value, label);
    }
  }
  if (args.output === undefined) {
    fail('missing required --output <path>');
  }
  if (args.runtime === undefined) {
    fail('missing required --runtime <directory>');
  }
  if (args.sqlName === undefined) {
    fail('missing required --sql-name <extension>');
  }
  if (!(await isDirectory(args.runtime))) {
    fail(`prebuilt extension artifact runtime root ${args.runtime} must be an existing directory`);
  }
  if (args.nativeModuleFile !== undefined && args.nativeModuleStem === undefined) {
    fail('prebuilt extension nativeModuleFile requires nativeModuleStem');
  }
  if (args.nativeModuleStem !== undefined && args.nativeTarget === undefined) {
    fail('prebuilt extension artifacts with nativeModuleStem must declare nativeTarget');
  }
  if (args.staticSymbolPrefix !== undefined) {
    validateCIdentifier(args.staticSymbolPrefix, 'prebuilt extension static symbol prefix');
  }
  const aliasSqlSymbols = new Set();
  for (const alias of args.staticSymbolAliases) {
    validateCIdentifier(alias.sqlSymbol, 'prebuilt extension static symbol alias');
    validateCIdentifier(alias.linkedSymbol, 'prebuilt extension static symbol alias target');
    if (aliasSqlSymbols.has(alias.sqlSymbol)) {
      fail(`prebuilt extension repeats static symbol alias for '${alias.sqlSymbol}'`);
    }
    aliasSqlSymbols.add(alias.sqlSymbol);
  }
  if (args.mobileStaticArchives.length > 0 && args.nativeModuleStem === undefined) {
    fail('prebuilt extension mobile static archives require nativeModuleStem');
  }
  const mobilePrebuilt = artifactMobilePrebuilt(args);
  if (mobilePrebuilt && args.nativeModuleStem !== undefined && args.mobileStaticArchives.length === 0) {
    fail('mobilePrebuilt native-module artifacts must carry at least one mobile static archive');
  }
  const mobileTargets = new Set();
  for (const archive of args.mobileStaticArchives) {
    validatePortableId(archive.target, 'prebuilt extension mobile static archive target');
    if (mobileTargets.has(archive.target)) {
      fail(`prebuilt extension mobile static archives repeat target '${archive.target}'`);
    }
    mobileTargets.add(archive.target);
    if (!(await isFile(archive.archive))) {
      fail(`prebuilt extension mobile static archive for target '${archive.target}' must be a file: ${archive.archive}`);
    }
  }
  const mobileDependencyKeys = new Set();
  for (const archive of args.mobileStaticDependencyArchives) {
    validatePortableId(archive.target, 'prebuilt extension mobile static dependency archive target');
    validatePortableId(archive.name, 'prebuilt extension mobile static dependency archive name');
    if (!mobileTargets.has(archive.target)) {
      fail(`prebuilt extension mobile static dependency archive '${archive.name}' for target '${archive.target}' requires a matching mobile static archive target`);
    }
    const key = `${archive.target}:${archive.name}`;
    if (mobileDependencyKeys.has(key)) {
      fail(`prebuilt extension mobile static dependency archives repeat '${archive.name}' for target '${archive.target}'`);
    }
    mobileDependencyKeys.add(key);
    validatePortableId(path.basename(archive.archive), 'prebuilt extension mobile static dependency archive file');
    if (!(await isFile(archive.archive))) {
      fail(`prebuilt extension mobile static dependency archive '${archive.name}' for target '${archive.target}' must be a file: ${archive.archive}`);
    }
  }
  for (const dataFile of args.dataFiles) {
    validateRelativeArtifactPath(dataFile, 'data file');
    if (dataFile.split('/')[0] === 'extension') {
      fail(`prebuilt extension data file '${dataFile}' must not be under share/postgresql/extension; control and SQL files are selected from sqlName`);
    }
  }
}

function artifactMobilePrebuilt(args) {
  return args.mobilePrebuilt || args.mobileStaticArchives.length > 0;
}

function extensionSqlFileBelongs(sqlName, fileName, extraSql) {
  return (
    fileName === `${sqlName}.control` ||
    fileName === `${sqlName}.sql` ||
    (fileName.startsWith(`${sqlName}--`) && fileName.endsWith('.sql')) ||
    extraSql.names.includes(fileName) ||
    extraSql.prefixes.some((prefix) => fileName.startsWith(prefix))
  );
}

async function ensureParent(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function copyFileChecked(sourceRoot, source, destination) {
  const sourceReal = await fs.realpath(source);
  const rootReal = await fs.realpath(sourceRoot);
  if (!sourceReal.startsWith(`${rootReal}${path.sep}`) && sourceReal !== rootReal) {
    fail(`selected extension runtime symlink ${source} resolves outside runtime root ${sourceRoot}`);
  }
  const stat = await fs.stat(source);
  if (!stat.isFile()) {
    fail(`prebuilt extension artifact source runtime file ${source} must be a regular file`);
  }
  await ensureParent(destination);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
}

async function copyRuntimeRelativeFile(runtime, artifactFiles, relative) {
  const normalized = validateRelativeArtifactPath(relative, 'runtime file');
  const source = path.join(runtime, normalized);
  if (!(await isFile(source))) {
    fail(`prebuilt extension artifact source runtime is missing declared file ${source}`);
  }
  await copyFileChecked(runtime, source, path.join(artifactFiles, normalized));
}

async function copySqlFiles(args, artifactRoot, artifactFiles) {
  const sourceDir = path.join(args.runtime, 'share/postgresql/extension');
  const targetDir = path.join(artifactFiles, 'share/postgresql/extension');
  if (!(await isDirectory(sourceDir))) {
    if (args.createsExtension) {
      fail(`prebuilt extension artifact source runtime ${args.runtime} is missing share/postgresql/extension for '${args.sqlName}'`);
    }
    return;
  }
  const extraSql = {
    prefixes: await extensionArtifactList(args.sqlName, 'extension_sql_file_prefixes'),
    names: await extensionArtifactList(args.sqlName, 'extension_sql_file_names'),
  };
  let copied = 0;
  let copiedControl = false;
  let copiedSql = false;
  const entries = (await fs.readdir(sourceDir)).sort();
  for (const entry of entries) {
    if (!extensionSqlFileBelongs(args.sqlName, entry, extraSql)) {
      continue;
    }
    copied += 1;
    if (entry === `${args.sqlName}.control`) {
      copiedControl = true;
    } else if (entry.endsWith('.sql')) {
      copiedSql = true;
    }
    await copyFileChecked(args.runtime, path.join(sourceDir, entry), path.join(targetDir, entry));
  }
  if (args.createsExtension && (!copiedControl || !copiedSql)) {
    fail(`prebuilt extension artifact ${artifactRoot} for '${args.sqlName}' must include a control file and at least one SQL install file`);
  }
  if (!args.createsExtension && copied === 0) {
    return;
  }
}

function mobileStaticArchiveRelativePath(target, stem) {
  return `mobile-static/${target}/extensions/${stem}/liboliphaunt_extension_${stem}.a`;
}

function mobileStaticDependencyArchiveRelativePath(target, name, archivePath) {
  return `mobile-static/${target}/dependencies/${name}/${path.basename(archivePath)}`;
}

async function copyStandaloneFile(source, destination) {
  const stat = await fs.stat(source);
  if (!stat.isFile()) {
    fail(`prebuilt extension artifact source file ${source} must be a regular file`);
  }
  await ensureParent(destination);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
}

function extensionMetadata(args) {
  const dependencies = sortedDeduped(args.dependencies);
  const dataFiles = sortedDeduped(args.dataFiles);
  const sharedPreloadLibraries = sortedDeduped(args.sharedPreloadLibraries);
  const mobileStaticArchives = args.nativeModuleStem === undefined
    ? []
    : args.mobileStaticArchives
        .map((archive) => ({
          target: archive.target,
          source: archive.archive,
          relativePath: mobileStaticArchiveRelativePath(archive.target, args.nativeModuleStem),
        }))
        .sort((left, right) => left.target.localeCompare(right.target));
  const mobileStaticDependencyArchives = args.mobileStaticDependencyArchives
    .map((archive) => ({
      target: archive.target,
      name: archive.name,
      source: archive.archive,
      relativePath: mobileStaticDependencyArchiveRelativePath(archive.target, archive.name, archive.archive),
    }))
    .sort((left, right) => left.target.localeCompare(right.target) || left.name.localeCompare(right.name));
  const staticSymbolAliases = [...args.staticSymbolAliases].sort(
    (left, right) => left.sqlSymbol.localeCompare(right.sqlSymbol) || left.linkedSymbol.localeCompare(right.linkedSymbol),
  );
  return {
    dependencies,
    dataFiles,
    sharedPreloadLibraries,
    mobileStaticArchives,
    mobileStaticDependencyArchives,
    staticSymbolAliases,
    mobilePrebuilt: artifactMobilePrebuilt(args),
    nativeModuleFile: args.nativeModuleStem === undefined ? '' : args.nativeModuleFile ?? args.nativeModuleStem,
  };
}

async function writeArtifactDirectory(artifactRoot, args) {
  const filesRoot = path.join(artifactRoot, 'files');
  const metadata = extensionMetadata(args);
  await copySqlFiles(args, artifactRoot, filesRoot);
  for (const dataFile of metadata.dataFiles) {
    await copyRuntimeRelativeFile(args.runtime, filesRoot, `share/postgresql/${dataFile}`);
  }
  if (metadata.nativeModuleFile.length > 0) {
    await copyRuntimeRelativeFile(args.runtime, filesRoot, `lib/postgresql/${metadata.nativeModuleFile}`);
  }
  for (const archive of metadata.mobileStaticArchives) {
    await copyStandaloneFile(archive.source, path.join(artifactRoot, archive.relativePath));
  }
  for (const archive of metadata.mobileStaticDependencyArchives) {
    await copyStandaloneFile(archive.source, path.join(artifactRoot, archive.relativePath));
  }
  const manifest = [
    'packageLayout=oliphaunt-extension-artifact-v1',
    'pgMajor=18',
    `sqlName=${args.sqlName}`,
    `createsExtension=${yesNo(args.createsExtension)}`,
    `nativeModuleStem=${args.nativeModuleStem ?? ''}`,
    `nativeModuleFile=${metadata.nativeModuleFile}`,
    `nativeTarget=${args.nativeTarget ?? ''}`,
    `dependencies=${metadata.dependencies.join(',')}`,
    `dataFiles=${metadata.dataFiles.join(',')}`,
    `sharedPreloadLibraries=${metadata.sharedPreloadLibraries.join(',')}`,
    `mobilePrebuilt=${yesNo(metadata.mobilePrebuilt)}`,
    `mobileStaticArchives=${metadata.mobileStaticArchives.map((archive) => `${archive.target}:${archive.relativePath}`).join(',')}`,
    `mobileStaticDependencyArchives=${metadata.mobileStaticDependencyArchives.map((archive) => `${archive.target}:${archive.name}:${archive.relativePath}`).join(',')}`,
    `staticSymbolPrefix=${args.staticSymbolPrefix ?? ''}`,
    `staticSymbolAliases=${metadata.staticSymbolAliases.map((alias) => `${alias.sqlSymbol}:${alias.linkedSymbol}`).join(',')}`,
    'files=files',
    '',
  ].join('\n');
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(path.join(artifactRoot, 'manifest.properties'), manifest);
}

function stripNativeReleaseBinaries(artifactRoot, nativeTarget) {
  const stripArgs = ['tools/release/strip_native_release_binaries.mjs'];
  if (nativeTarget) {
    stripArgs.push('--target', nativeTarget);
  }
  stripArgs.push(artifactRoot);
  const result = spawnSync(
    path.join(root, 'tools/dev/bun.sh'),
    stripArgs,
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error !== undefined) {
    fail(`failed to run native release binary stripper: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`native release binary stripper failed for ${artifactRoot}`);
  }
}

async function prepareOutputFile(output, force) {
  if (await exists(output)) {
    if (!force) {
      fail(`prebuilt extension artifact output ${output} already exists; pass --force`);
    }
    const stat = await fs.lstat(output);
    if (stat.isDirectory()) {
      await fs.rm(output, { recursive: true, force: true });
    } else {
      await fs.unlink(output);
    }
  }
  await ensureParent(output);
}

async function createArtifact(argv) {
  const args = parseArgs(argv);
  await validateArtifactArgs(args);
  if (!['directory', 'dir', 'tar', 'tar-gz', 'tar.gz', 'tgz', 'gz'].includes(args.format)) {
    fail(`unknown extension artifact format '${args.format}'`);
  }
  const output = path.resolve(args.output);
  if (args.format === 'directory' || args.format === 'dir') {
    if (await exists(output)) {
      if (!args.force) {
        fail(`prebuilt extension artifact output ${output} already exists; pass --force`);
      }
      await fs.rm(output, { recursive: true, force: true });
    }
    await writeArtifactDirectory(output, args);
    stripNativeReleaseBinaries(output, args.nativeTarget);
    console.log(`path=${output}`);
    console.log(`sqlName=${args.sqlName}`);
    console.log('format=directory');
    console.log(`manifest=${path.join(output, 'manifest.properties')}`);
    return;
  }
  await prepareOutputFile(output, args.force);
  const stageRoot = path.resolve(args.stageRoot ?? path.join(root, 'target/extensions/native/release-stage/local'));
  const artifactRoot = path.join(stageRoot, `.artifact-${args.sqlName}-${process.pid}-${Date.now()}`);
  const formatLabel = args.format === 'tar' ? 'tar' : 'tar-gz';
  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  try {
    await writeArtifactDirectory(artifactRoot, args);
    stripNativeReleaseBinaries(artifactRoot, args.nativeTarget);
    if (args.format === 'tar') {
      await fs.writeFile(output, await createTar(artifactRoot));
    } else {
      await fs.writeFile(output, Bun.gzipSync(await createTar(artifactRoot)));
    }
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
  console.log(`path=${output}`);
  console.log(`sqlName=${args.sqlName}`);
  console.log(`format=${formatLabel}`);
  console.log('manifest=');
}

async function listFilesRecursive(base, current = base) {
  const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`prebuilt extension artifact archives do not support symlinks: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(base, fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      fail(`prebuilt extension artifact archives only support files and directories: ${fullPath}`);
    }
    files.push(fullPath);
  }
  return files;
}

function tarPathParts(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const bytes = Buffer.byteLength(normalized);
  if (bytes <= 100) {
    return { name: normalized, prefix: '' };
  }
  const parts = normalized.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`prebuilt extension artifact archive path is too long for ustar: ${normalized}`);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    fail(`tar header field overflow for '${value}'`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  writeString(buffer, offset, length, `${text}\0`);
}

function tarHeader(relativePath, size, mode) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = tarPathParts(relativePath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${checksumText}\0 `);
  return header;
}

async function createTar(base) {
  const chunks = [];
  const files = await listFilesRecursive(base);
  for (const file of files) {
    const relative = validateRelativeArtifactPath(path.relative(base, file).split(path.sep).join('/'), 'archive file');
    const stat = await fs.stat(file);
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    const data = await fs.readFile(file);
    chunks.push(tarHeader(relative, data.length, mode));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'list-catalog':
      await listCatalog();
      break;
    case 'selected-sql-names':
      await selectedSqlNames(args[0] ?? '');
      break;
    case 'product-version':
      await productVersion(args[0] ?? '');
      break;
    case 'create-artifact':
      await createArtifact(args);
      break;
    default:
      fail('usage: extension-artifact-packager.mjs <list-catalog|selected-sql-names|product-version|create-artifact> [options]');
  }
}

main().catch((error) => {
  console.error(`extension-artifact-packager.mjs: ${error.message}`);
  process.exit(2);
});
