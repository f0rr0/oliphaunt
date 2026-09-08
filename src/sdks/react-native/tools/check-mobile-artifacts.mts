#!/usr/bin/env bun
import path from 'node:path';
import {
  ROOT,
  compareText,
  exactExtensionProducts,
  extensionArtifactProductRoot,
} from '../../../shared/product-metadata/release-artifact-targets.mts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  ARCHIVE_ENTRY_CACHE,
  ARCHIVE_ENTRY_CACHE_LIMIT,
  PREFIX,
  directoryNames,
  fail,
  isDirectory,
  isFile,
  readJson,
  readPropertiesText,
  rel,
  sha256File,
  walkFiles,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import { readAndroidApkEntries } from '../../../shared/artifact-packaging/portable-archive.mts';
import { validateMobileRuntimeFiles } from './validate-mobile-runtime-files.mts';
import { EXTENSION_ROOT } from '../../../extensions/artifacts/packages/tools/check-carriers.mts';

const MOBILE_ROOT = path.join(ROOT, 'target/mobile-build/react-native');

const REACT_NATIVE_EXTENSION_METADATA = path.join(
  ROOT,
  'src/extensions/generated/sdk/extensions.json',
);

const MOBILE_STATIC_REGISTRY = path.join(
  ROOT,
  'src/extensions/generated/mobile/static-registry.json',
);

const IOS_EXTENSION_LINK_PREFIX = 'liboliphaunt_extension_';

const IOS_EXTENSION_LINK_STEM = /^[a-z_][a-z0-9_-]{0,127}$/u;

function csvValues(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function strictAndroidApkEntries(file) {
  const fileStat = statSync(file, { bigint: true });
  const cacheKey = [
    'android-apk',
    path.resolve(file),
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeNs,
    fileStat.ctimeNs,
  ].join('\0');
  const cached = ARCHIVE_ENTRY_CACHE.get(cacheKey);
  if (cached !== undefined) {
    ARCHIVE_ENTRY_CACHE.delete(cacheKey);
    ARCHIVE_ENTRY_CACHE.set(cacheKey, cached);
    return cached;
  }
  let entries;
  try {
    entries = readAndroidApkEntries(file);
  } catch (error) {
    fail(`${rel(file)} is not a strict Android APK archive: ${error.message}`);
  }
  ARCHIVE_ENTRY_CACHE.set(cacheKey, entries);
  while (ARCHIVE_ENTRY_CACHE.size > ARCHIVE_ENTRY_CACHE_LIMIT) {
    ARCHIVE_ENTRY_CACHE.delete(ARCHIVE_ENTRY_CACHE.keys().next().value);
  }
  return entries;
}

function archiveAndroidApkNames(file) {
  return [...strictAndroidApkEntries(file)]
    .filter(([, entry]) => entry.isFile)
    .map(([name]) => name)
    .sort(compareText);
}

function androidApkReadText(file, name) {
  const entry = strictAndroidApkEntries(file).get(name);
  if (!entry || !entry.isFile) {
    fail(`${rel(file)} is missing ${name}`);
  }
  try {
    return Buffer.from(entry.data()).toString('utf8');
  } catch (error) {
    fail(`${rel(file)} member ${name} is not readable UTF-8: ${error.message}`);
  }
}

function pathBytes(file) {
  if (isFile(file)) {
    return statSync(file).size;
  }
  if (isDirectory(file)) {
    let total = 0;
    for (const name of directoryNames(file)) {
      total += statSync(path.join(file, ...name.split('/'))).size;
    }
    return total;
  }
  fail(`missing path while measuring bytes: ${rel(file)}`);
}

function dirReadText(root, name) {
  const file = path.join(root, ...name.split('/'));
  if (!isFile(file)) {
    fail(`${rel(root)} is missing ${name}`);
  }
  return readFileSync(file, 'utf8');
}

function generatedExtensionRows() {
  const data = readJson(REACT_NATIVE_EXTENSION_METADATA);
  const rows = data.extensions;
  if (!Array.isArray(rows)) {
    fail(`${rel(REACT_NATIVE_EXTENSION_METADATA)} must contain an extensions array`);
  }
  const result = new Map();
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const sqlName = row['sql-name'];
      if (typeof sqlName === 'string' && sqlName) {
        result.set(sqlName, row);
      }
    }
  }
  return result;
}

function canonicalMobileDomain(values, label) {
  const canonical = [...new Set(values)].sort(compareText);
  if (canonical.length !== values.length || JSON.stringify(canonical) !== JSON.stringify(values)) {
    throw new Error(
      `${label} must be a sorted, duplicate-free CSV domain; got ${JSON.stringify(values)}`,
    );
  }
  return canonical;
}

function requireSameMobileDomain(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}=${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

export function validateMobileExtensionManifestDomains({
  runtime,
  staticRegistry,
  rows,
  label = 'mobile runtime manifest',
}) {
  for (const key of [
    'selectedExtensions',
    'extensions',
    'mobileStaticRegistryState',
    'mobileStaticRegistryRegistered',
    'mobileStaticRegistryPending',
    'nativeModuleStems',
  ]) {
    if (!Object.hasOwn(runtime, key)) {
      throw new Error(
        key === 'selectedExtensions'
          ? `${label} must define the full selectedExtensions domain`
          : `${label} must define ${key}`,
      );
    }
  }
  for (const key of [
    'state',
    'registeredExtensions',
    'pendingExtensions',
    'nativeModuleStems',
    'modules',
  ]) {
    if (!Object.hasOwn(staticRegistry, key)) {
      throw new Error(`${label} static-registry manifest must define ${key}`);
    }
  }
  const selectedExtensions = canonicalMobileDomain(
    csvValues(runtime.selectedExtensions),
    `${label} selectedExtensions`,
  );
  const createableExtensions = [];
  const nativeExtensions = [];
  const nativeModuleStems = [];
  for (const extension of selectedExtensions) {
    const row = rows.get(extension);
    if (!row) {
      throw new Error(
        `${label} selected extension ${JSON.stringify(extension)} is missing from generated extension metadata`,
      );
    }
    if (row['creates-extension'] === true) {
      createableExtensions.push(extension);
    }
    const stem = row['native-module-stem'];
    if (typeof stem === 'string' && stem && stem !== '-') {
      nativeExtensions.push(extension);
      nativeModuleStems.push(stem);
    }
  }
  nativeModuleStems.sort(compareText);

  requireSameMobileDomain(
    canonicalMobileDomain(csvValues(runtime.extensions), `${label} extensions`),
    createableExtensions,
    `${label} createable extensions`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(
      csvValues(runtime.mobileStaticRegistryRegistered),
      `${label} mobileStaticRegistryRegistered`,
    ),
    nativeExtensions,
    `${label} registered native extensions`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(csvValues(runtime.nativeModuleStems), `${label} nativeModuleStems`),
    nativeModuleStems,
    `${label} native module stems`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(
      csvValues(staticRegistry.registeredExtensions),
      `${label} static-registry registeredExtensions`,
    ),
    nativeExtensions,
    `${label} static-registry registered native extensions`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(
      csvValues(staticRegistry.nativeModuleStems),
      `${label} static-registry nativeModuleStems`,
    ),
    nativeModuleStems,
    `${label} static-registry native module stems`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(
      csvValues(runtime.mobileStaticRegistryPending),
      `${label} mobileStaticRegistryPending`,
    ),
    [],
    `${label} pending native extensions`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(
      csvValues(staticRegistry.pendingExtensions),
      `${label} static-registry pendingExtensions`,
    ),
    [],
    `${label} static-registry pending native extensions`,
  );
  requireSameMobileDomain(
    canonicalMobileDomain(csvValues(staticRegistry.modules), `${label} static-registry modules`),
    nativeModuleStems,
    `${label} static-registry modules`,
  );
  const expectedRegistryState = nativeExtensions.length > 0 ? 'complete' : 'not-required';
  if (runtime.mobileStaticRegistryState !== expectedRegistryState) {
    throw new Error(
      `${label} mobileStaticRegistryState=${JSON.stringify(runtime.mobileStaticRegistryState)}, ` +
        `expected ${JSON.stringify(expectedRegistryState)}`,
    );
  }
  if (staticRegistry.state !== expectedRegistryState) {
    throw new Error(
      `${label} static-registry state=${JSON.stringify(staticRegistry.state)}, ` +
        `expected ${JSON.stringify(expectedRegistryState)}`,
    );
  }

  return {
    createableExtensions,
    nativeExtensions,
    nativeModuleStems,
    selectedExtensions,
  };
}

function discoverMobileArtifacts(platform) {
  if (platform === 'android') {
    const root = path.join(MOBILE_ROOT, 'android');
    return existsSync(root)
      ? readdirSync(root)
          .filter((name) => name.endsWith('.apk'))
          .map((name) => {
            const file = path.join(root, name);
            return {
              platform: 'android',
              path: file,
              names: archiveAndroidApkNames(file),
              readText: (member) => androidApkReadText(file, member),
            };
          })
          .sort((left, right) => compareText(left.path, right.path))
      : [];
  }
  if (platform === 'ios') {
    const root = path.join(MOBILE_ROOT, 'ios');
    return existsSync(root)
      ? readdirSync(root)
          .filter((name) => name.endsWith('.app') && isDirectory(path.join(root, name)))
          .map((name) => {
            const app = path.join(root, name);
            return {
              platform: 'ios',
              path: app,
              names: directoryNames(app),
              readText: (member) => dirReadText(app, member),
            };
          })
          .sort((left, right) => compareText(left.path, right.path))
      : [];
  }
  fail(`unsupported mobile platform ${platform}`);
}

function mobilePrefix(platform) {
  if (platform === 'android') {
    return 'assets/oliphaunt/';
  }
  if (platform === 'ios') {
    return 'OliphauntReactNativeResources.bundle/oliphaunt/';
  }
  fail(`unsupported mobile platform ${platform}`);
}

function mobileTargetForArtifact(artifact) {
  if (artifact.platform === 'ios') {
    return 'ios-xcframework';
  }
  const abis = artifact.names
    .map((name) => name.split('/'))
    .filter((parts) => parts.length === 3 && parts[0] === 'lib' && parts[2] === 'liboliphaunt.so')
    .map((parts) => parts[1])
    .sort(compareText);
  if (abis.length !== 1) {
    fail(
      `${rel(artifact.path)} must contain exactly one Android liboliphaunt ABI, got ${JSON.stringify(abis)}`,
    );
  }
  if (abis[0] === 'arm64-v8a') {
    return 'android-arm64-v8a';
  }
  if (abis[0] === 'x86_64') {
    return 'android-x86_64';
  }
  fail(`${rel(artifact.path)} contains unsupported Android ABI ${abis[0]}`);
}

export function validatePackagedMobileRuntimeFiles({
  artifactNames,
  metadata,
  platform,
  prefix,
  registry,
  selected,
}) {
  const runtimePrefix = `${prefix}runtime/files/`;
  const runtimePaths = new Set(
    artifactNames
      .filter((name) => name.startsWith(runtimePrefix) && !name.endsWith('/'))
      .map((name) => name.slice(runtimePrefix.length)),
  );
  validateMobileRuntimeFiles({
    metadata,
    metadataLabel: rel(REACT_NATIVE_EXTENSION_METADATA),
    platform,
    registry,
    registryLabel: rel(MOBILE_STATIC_REGISTRY),
    runtimePaths,
    selected: selected.join(','),
  });
}

function mobileBuildReport(platform) {
  const report = path.join(MOBILE_ROOT, platform, 'build-report.json');
  if (!isFile(report)) {
    return null;
  }
  const data = readJson(report);
  if (data.schema !== 'oliphaunt-react-native-mobile-build-v1') {
    fail(`${rel(report)} has invalid mobile build report schema`);
  }
  if (data.platform !== platform) {
    fail(
      `${rel(report)} has platform=${JSON.stringify(data.platform)}, expected ${JSON.stringify(platform)}`,
    );
  }
  return data;
}

function resolveReportPath(value, reportPath, field) {
  if (typeof value !== 'string' || !value) {
    fail(`${rel(reportPath)} must declare ${field}`);
  }
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function checkExtensionPackageHasMobileTarget(sqlName, target) {
  for (const product of exactExtensionProducts(PREFIX)) {
    const manifest = path.join(
      extensionArtifactProductRoot(product, 'native', EXTENSION_ROOT, PREFIX),
      'extension-artifacts.json',
    );
    if (!isFile(manifest)) {
      continue;
    }
    const data = readJson(manifest);
    const member =
      data.schema === 'oliphaunt-extension-ci-artifacts-v2'
        ? data.extensions?.find((row) => row?.sqlName === sqlName)
        : data.sqlName === sqlName
          ? data
          : null;
    if (member === null || member === undefined) {
      continue;
    }
    const assets = member.assets;
    if (!Array.isArray(assets)) {
      fail(`${rel(manifest)} must declare assets`);
    }
    const runtimeMatches = assets.filter(
      (asset) =>
        asset && asset.family === 'native' && asset.target === target && asset.kind === 'runtime',
    );
    if (runtimeMatches.length !== 1) {
      fail(
        `${sqlName} exact-extension package must contain one native runtime asset for ${target}`,
      );
    }
    if (target === 'ios-xcframework') {
      const frameworkMatches = assets.filter(
        (asset) =>
          asset &&
          asset.family === 'native' &&
          asset.target === target &&
          asset.kind === 'ios-xcframework',
      );
      const dependencyMatches = assets.filter(
        (asset) =>
          asset &&
          asset.family === 'native' &&
          asset.target === target &&
          asset.kind === 'ios-dependency-xcframework',
      );
      const hasNativeModule =
        typeof member.nativeModuleStem === 'string' && member.nativeModuleStem.length > 0;
      if (frameworkMatches.length !== (hasNativeModule ? 1 : 0)) {
        fail(
          `${sqlName} exact-extension package has the wrong iOS XCFramework role count for ${hasNativeModule ? 'native' : 'SQL-only'} metadata`,
        );
      }
      const expectedDependencies =
        hasNativeModule && Array.isArray(member.iosNativeDependencies)
          ? member.iosNativeDependencies
          : [];
      if (
        JSON.stringify(dependencyMatches.map((asset) => asset.identity).sort(compareText)) !==
        JSON.stringify(expectedDependencies)
      ) {
        fail(
          `${sqlName} exact-extension package iOS dependency XCFrameworks do not match its frozen dependency closure`,
        );
      }
    }
    return;
  }
  fail(`no exact-extension package found for selected mobile extension ${sqlName}`);
}

export function iosPayloadCocoaPodsFileListPaths(scratchPath) {
  const podName = 'OliphauntReactNativePayload';
  const supportRoot = path.join(
    scratchPath,
    'examples/react-native-expo/ios/Pods/Target Support Files',
    podName,
  );
  return {
    inputFile: path.join(supportRoot, `${podName}-xcframeworks-input-files.xcfilelist`),
    outputFile: path.join(supportRoot, `${podName}-xcframeworks-output-files.xcfilelist`),
    podName,
    supportRoot,
  };
}

function canonicalIosExtensionLinkStems(stems) {
  if (!Array.isArray(stems)) {
    throw new Error('expected iOS extension native-module stems must be an array');
  }
  const raw = new Set();
  const symbols = new Map();
  for (const stem of stems) {
    if (typeof stem !== 'string' || !IOS_EXTENSION_LINK_STEM.test(stem)) {
      throw new Error(`invalid iOS extension native-module stem ${JSON.stringify(stem)}`);
    }
    if (raw.has(stem)) {
      throw new Error(`duplicate iOS extension native-module stem ${JSON.stringify(stem)}`);
    }
    raw.add(stem);
    const symbolStem = stem.replaceAll('-', '_');
    const prior = symbols.get(symbolStem);
    if (prior !== undefined) {
      throw new Error(
        `iOS extension native-module stems ${JSON.stringify(prior)} and ${JSON.stringify(stem)} ` +
          `collide after registration-symbol normalization to ${JSON.stringify(symbolStem)}`,
      );
    }
    symbols.set(symbolStem, stem);
  }
  return [...raw].sort(compareText);
}

function iosCocoaPodsExtensionArtifacts(text, kind) {
  if (typeof text !== 'string') {
    throw new Error(`CocoaPods ${kind} file list must be text`);
  }
  const suffixes =
    kind === 'input' ? ['.xcframework'] : kind === 'output' ? ['.framework', '.a'] : null;
  if (suffixes === null) {
    throw new Error(`unsupported CocoaPods file-list kind ${JSON.stringify(kind)}`);
  }
  const artifacts = new Set();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (raw.includes('\0')) {
      throw new Error(`CocoaPods ${kind} file list line ${index + 1} contains NUL`);
    }
    const record = raw.trim();
    if (!record) {
      continue;
    }
    const components = record.split('/');
    const candidates = kind === 'input' ? components : [components.at(-1)];
    for (const component of candidates) {
      if (!component.startsWith(IOS_EXTENSION_LINK_PREFIX)) {
        continue;
      }
      const suffix = suffixes.find((value) => component.endsWith(value));
      if (suffix === undefined) {
        throw new Error(
          `CocoaPods ${kind} file list line ${index + 1} has unsupported ` +
            `Oliphaunt extension artifact component ${JSON.stringify(component)}`,
        );
      }
      const stem = component.slice(IOS_EXTENSION_LINK_PREFIX.length, -suffix.length);
      if (!IOS_EXTENSION_LINK_STEM.test(stem)) {
        throw new Error(
          `CocoaPods ${kind} file list line ${index + 1} has invalid ` +
            `Oliphaunt extension native-module stem ${JSON.stringify(stem)}`,
        );
      }
      const artifact = `${IOS_EXTENSION_LINK_PREFIX}${stem}`;
      if (artifacts.has(artifact)) {
        throw new Error(
          `CocoaPods ${kind} file list repeats Oliphaunt extension artifact ${JSON.stringify(artifact)}`,
        );
      }
      artifacts.add(artifact);
    }
  }
  return [...artifacts].sort(compareText);
}

export function iosCocoaPodsExtensionLinkEvidence({ expectedStems, inputText, outputText }) {
  const expectedArtifacts = canonicalIosExtensionLinkStems(expectedStems).map(
    (stem) => `${IOS_EXTENSION_LINK_PREFIX}${stem}`,
  );
  const inputArtifacts = iosCocoaPodsExtensionArtifacts(inputText, 'input');
  const outputArtifacts = iosCocoaPodsExtensionArtifacts(outputText, 'output');
  const expected = new Set(expectedArtifacts);
  const input = new Set(inputArtifacts);
  const output = new Set(outputArtifacts);
  return {
    expectedArtifacts,
    inputArtifacts,
    missingInput: expectedArtifacts.filter((artifact) => !input.has(artifact)),
    missingOutput: expectedArtifacts.filter((artifact) => !output.has(artifact)),
    outputArtifacts,
    unexpectedInput: inputArtifacts.filter((artifact) => !expected.has(artifact)),
    unexpectedOutput: outputArtifacts.filter((artifact) => !expected.has(artifact)),
  };
}

function checkIosPrebuiltExtensionLinkage(artifact, stems) {
  if (stems.length === 0) {
    return;
  }
  const sourceLeaks = artifact.names
    .filter(
      (name) =>
        name.includes('/static-registry/oliphaunt_static_registry.c') ||
        name.includes('/extension-frameworks/') ||
        name.endsWith('.xcframework'),
    )
    .sort(compareText);
  if (sourceLeaks.length > 0) {
    fail(
      `${rel(artifact.path)} includes build-only iOS static-extension inputs as app resources: ${sourceLeaks.slice(0, 10).join(', ')}`,
    );
  }
  const report = mobileBuildReport('ios');
  if (report === null) {
    fail(
      `${rel(artifact.path)} requires ${rel(path.join(MOBILE_ROOT, 'ios/build-report.json'))} for iOS extension link evidence`,
    );
  }
  const scratchRoot = report.scratchRoot;
  if (typeof scratchRoot !== 'string' || !scratchRoot) {
    fail(
      `${rel(path.join(MOBILE_ROOT, 'ios/build-report.json'))} must declare scratchRoot for iOS extension link evidence`,
    );
  }
  const scratchPath = scratchRoot;
  const xcodeLog = path.join(scratchPath, 'xcodebuild.log');
  if (!isFile(xcodeLog)) {
    fail(`iOS extension link evidence is missing xcodebuild log: ${rel(xcodeLog)}`);
  }
  const logText = readFileSync(xcodeLog, 'utf8');
  if (!logText.includes('** BUILD SUCCEEDED **')) {
    fail(`iOS extension link evidence requires a successful xcodebuild log: ${rel(xcodeLog)}`);
  }
  const { inputFile, outputFile } = iosPayloadCocoaPodsFileListPaths(scratchPath);
  if (!isFile(inputFile)) {
    fail(
      `iOS extension link evidence is missing CocoaPods XCFramework input file list: ${rel(inputFile)}`,
    );
  }
  if (!isFile(outputFile)) {
    fail(
      `iOS extension link evidence is missing CocoaPods XCFramework output file list: ${rel(outputFile)}`,
    );
  }
  let podEvidence;
  try {
    podEvidence = iosCocoaPodsExtensionLinkEvidence({
      expectedStems: stems,
      inputText: readFileSync(inputFile, 'utf8'),
      outputText: readFileSync(outputFile, 'utf8'),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const expectedFrameworks = new Set(podEvidence.expectedArtifacts);
  const productsRoot = path.join(scratchPath, 'DerivedData/Build/Products');
  if (!isDirectory(productsRoot)) {
    fail(`iOS extension link evidence is missing Xcode build products: ${rel(productsRoot)}`);
  }
  const builtFrameworks = new Set(
    walkFiles(productsRoot)
      .map((file) => path.basename(file))
      .filter((name) => /^liboliphaunt_extension_.*(\.a|\.framework)$/u.test(name))
      .map((name) => name.replace(/\.a$/u, '').replace(/\.framework$/u, '')),
  );
  if (podEvidence.missingInput.length > 0) {
    fail(
      `CocoaPods input file list does not include selected iOS extension XCFramework(s): ${podEvidence.missingInput.join(', ')}`,
    );
  }
  if (podEvidence.missingOutput.length > 0) {
    fail(
      `CocoaPods output file list does not include selected iOS extension linked artifact(s): ${podEvidence.missingOutput.join(', ')}`,
    );
  }
  const missingBuilt = [...expectedFrameworks]
    .filter((item) => !builtFrameworks.has(item))
    .sort(compareText);
  if (missingBuilt.length > 0) {
    fail(
      `Xcode build products do not include selected iOS extension linked artifact(s): ${missingBuilt.join(', ')}`,
    );
  }
  if (podEvidence.unexpectedInput.length > 0) {
    fail(
      `CocoaPods input file list includes unselected iOS extension XCFramework(s): ${podEvidence.unexpectedInput.join(', ')}`,
    );
  }
  if (podEvidence.unexpectedOutput.length > 0) {
    fail(
      `CocoaPods output file list includes unselected iOS extension linked artifact(s): ${podEvidence.unexpectedOutput.join(', ')}`,
    );
  }
  const unexpectedBuilt = [...builtFrameworks]
    .filter((item) => !expectedFrameworks.has(item))
    .sort(compareText);
  if (unexpectedBuilt.length > 0) {
    fail(
      `Xcode build products include unselected iOS extension linked artifact(s): ${unexpectedBuilt.join(', ')}`,
    );
  }
}

function checkAndroidPrebuiltExtensionLinkage(
  artifact,
  stems,
  report,
  reportPath,
  expectedAbi,
  staticRegistry,
  target,
) {
  if (stems.length === 0) {
    return;
  }
  const evidencePath = resolveReportPath(
    report.androidLinkEvidence,
    reportPath,
    'androidLinkEvidence',
  );
  if (!isFile(evidencePath)) {
    fail(`Android extension link evidence is missing: ${rel(evidencePath)}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(report.androidLinkEvidenceSha256 ?? '')) {
    fail(`${rel(reportPath)} androidLinkEvidenceSha256 must be a lowercase SHA-256 digest`);
  }
  const evidenceSha256 = sha256File(evidencePath);
  if (evidenceSha256 !== report.androidLinkEvidenceSha256) {
    fail(`${rel(reportPath)} androidLinkEvidenceSha256 does not match ${rel(evidencePath)}`);
  }
  const linkedStems = new Set();
  const linkedDependencies = new Set();
  let evidenceAbi = '';
  let runtimePath = '';
  let schemaRows = 0;
  let abiRows = 0;
  const requireExistingPath = (rawPath, lineNumber, rowKind) => {
    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.join(path.dirname(evidencePath), rawPath);
    if (!isFile(resolved)) {
      fail(`${rel(evidencePath)}:${lineNumber} ${rowKind} path does not exist: ${resolved}`);
    }
    return resolved;
  };
  const lines = readFileSync(evidencePath, 'utf8').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split('\t');
    if (!parts.length || !parts[0]) {
      continue;
    }
    const lineNumber = index + 1;
    const kind = parts[0];
    if (kind === 'schema') {
      if (
        JSON.stringify(parts) !==
        JSON.stringify(['schema', 'oliphaunt-android-static-extension-link-v1'])
      ) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid schema row`);
      }
      schemaRows += 1;
    } else if (kind === 'abi') {
      if (parts.length !== 2) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid abi row`);
      }
      evidenceAbi = parts[1];
      abiRows += 1;
    } else if (kind === 'runtime') {
      if (parts.length !== 3 || parts[1] !== 'liboliphaunt') {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid runtime row`);
      }
      const runtime = requireExistingPath(parts[2], lineNumber, 'runtime');
      if (path.basename(runtime) !== 'liboliphaunt.so') {
        fail(`${rel(evidencePath)}:${lineNumber} runtime path must end in liboliphaunt.so`);
      }
      if (runtimePath) {
        fail(`${rel(evidencePath)} contains duplicate runtime rows`);
      }
      runtimePath = runtime;
    } else if (kind === 'extension') {
      if (parts.length !== 3) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid extension row`);
      }
      const [stem, archive] = [parts[1], parts[2]];
      const expectedName = `liboliphaunt_extension_${stem}.a`;
      const archivePath = requireExistingPath(archive, lineNumber, 'extension');
      const expectedRelative = staticRegistry[`module.${stem}.archive.${target}`];
      if (!expectedRelative) {
        fail(
          `${rel(artifact.path)} static registry manifest has no module.${stem}.archive.${target} entry`,
        );
      }
      if (path.basename(archivePath) !== expectedName) {
        fail(
          `${rel(evidencePath)}:${lineNumber} archive ${JSON.stringify(archive)} does not match stem ${JSON.stringify(stem)}`,
        );
      }
      if (!archivePath.split(path.sep).join('/').endsWith(expectedRelative)) {
        fail(
          `${rel(evidencePath)}:${lineNumber} archive ${JSON.stringify(archive)} does not match static-registry path ${JSON.stringify(expectedRelative)}`,
        );
      }
      linkedStems.add(stem);
    } else if (kind === 'dependency') {
      if (parts.length !== 3 || !parts[1]) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid dependency row`);
      }
      const dependencyName = parts[1];
      const dependencyPath = requireExistingPath(parts[2], lineNumber, 'dependency');
      const expectedRelative = staticRegistry[`dependency.${dependencyName}.archive.${target}`];
      if (!expectedRelative) {
        fail(
          `${rel(evidencePath)}:${lineNumber} dependency ${JSON.stringify(dependencyName)} is not declared by the static-registry manifest for ${target}`,
        );
      }
      if (!dependencyPath.split(path.sep).join('/').endsWith(expectedRelative)) {
        fail(
          `${rel(evidencePath)}:${lineNumber} dependency path ${JSON.stringify(parts[2])} does not match static-registry path ${JSON.stringify(expectedRelative)}`,
        );
      }
      linkedDependencies.add(dependencyName);
    } else {
      fail(`${rel(evidencePath)}:${lineNumber} has unknown row kind ${JSON.stringify(kind)}`);
    }
  }
  if (schemaRows !== 1) {
    fail(`${rel(evidencePath)} must contain exactly one schema row`);
  }
  if (abiRows !== 1) {
    fail(`${rel(evidencePath)} must contain exactly one abi row`);
  }
  if (evidenceAbi !== expectedAbi) {
    fail(
      `${rel(evidencePath)} declares abi=${JSON.stringify(evidenceAbi)}, expected ${JSON.stringify(expectedAbi)}`,
    );
  }
  if (!runtimePath) {
    fail(`${rel(evidencePath)} does not show liboliphaunt runtime link input`);
  }
  const expectedStems = new Set(stems);
  const missing = [...expectedStems].filter((stem) => !linkedStems.has(stem)).sort(compareText);
  if (missing.length > 0) {
    fail(
      `${rel(evidencePath)} does not show selected Android extension archive link input(s): ${missing.join(', ')}`,
    );
  }
  const unexpected = [...linkedStems].filter((stem) => !expectedStems.has(stem)).sort(compareText);
  if (unexpected.length > 0) {
    fail(
      `${rel(evidencePath)} shows unselected Android extension archive link input(s): ${unexpected.join(', ')}`,
    );
  }
  const expectedDependencies = new Set(csvValues(staticRegistry.dependencyArchives));
  const missingDependencies = [...expectedDependencies]
    .filter((dependency) => !linkedDependencies.has(dependency))
    .sort(compareText);
  if (missingDependencies.length > 0) {
    fail(
      `${rel(evidencePath)} does not show required Android extension dependency archive link input(s): ${missingDependencies.join(', ')}`,
    );
  }
  const unexpectedDependencies = [...linkedDependencies]
    .filter((dependency) => !expectedDependencies.has(dependency))
    .sort(compareText);
  if (unexpectedDependencies.length > 0) {
    fail(
      `${rel(evidencePath)} shows unselected Android extension dependency archive link input(s): ${unexpectedDependencies.join(', ')}`,
    );
  }
}

export function validatePackagedMobileRuntimeManifest(runtime, source = 'mobile runtime manifest') {
  if (runtime.schema !== 'oliphaunt-runtime-resources-v1') {
    throw new Error(`${source} has invalid runtime resource manifest schema`);
  }
  if (runtime.mode !== 'native-direct') {
    throw new Error(`${source} must declare mode=native-direct`);
  }
}

function checkMobileArtifact(artifact, { requirePrebuiltExtensions }) {
  const prefix = mobilePrefix(artifact.platform);
  const runtimeManifestName = `${prefix}runtime/manifest.properties`;
  const staticRegistryManifestName = `${prefix}static-registry/manifest.properties`;
  const packageSizeName = `${prefix}package-size.tsv`;
  const runtime = readPropertiesText(artifact.readText(runtimeManifestName));
  try {
    validatePackagedMobileRuntimeManifest(
      runtime,
      `${rel(artifact.path)} runtime resource manifest`,
    );
  } catch (error) {
    fail(error.message);
  }
  const rows = generatedExtensionRows();
  const staticRegistry = readPropertiesText(artifact.readText(staticRegistryManifestName));
  let domains;
  try {
    domains = validateMobileExtensionManifestDomains({
      label: `${rel(artifact.path)} runtime manifest`,
      rows,
      runtime,
      staticRegistry,
    });
  } catch (error) {
    fail(error.message);
  }
  const selected = domains.selectedExtensions;
  const target = mobileTargetForArtifact(artifact);
  const reportPath = path.join(MOBILE_ROOT, artifact.platform, 'build-report.json');
  const report = mobileBuildReport(artifact.platform);
  if (report === null) {
    fail(`${rel(artifact.path)} requires mobile build report ${rel(reportPath)}`);
  }
  const reportArtifact = resolveReportPath(report.appArtifact, reportPath, 'appArtifact');
  if (path.resolve(reportArtifact) !== path.resolve(artifact.path)) {
    fail(
      `${rel(reportPath)} appArtifact=${reportArtifact} does not match inspected artifact ${artifact.path}`,
    );
  }
  if (report.appArtifactBytes !== pathBytes(artifact.path)) {
    fail(`${rel(reportPath)} appArtifactBytes does not match inspected artifact size`);
  }
  if (!Array.isArray(report.selectedExtensions)) {
    fail(`${rel(reportPath)} selectedExtensions must be an array`);
  }
  const reportSelected = report.selectedExtensions
    .map((value) => String(value))
    .filter(Boolean)
    .sort(compareText);
  if (JSON.stringify(reportSelected) !== JSON.stringify([...selected].sort(compareText))) {
    fail(
      `${rel(reportPath)} selectedExtensions=${JSON.stringify(reportSelected)} must match runtime manifest ${JSON.stringify([...selected].sort(compareText))}`,
    );
  }
  let expectedAbi = '';
  if (artifact.platform === 'android') {
    expectedAbi = target === 'android-arm64-v8a' ? 'arm64-v8a' : 'x86_64';
    if (report.abi !== expectedAbi) {
      fail(
        `${rel(reportPath)} abi=${JSON.stringify(report.abi)}, expected ${JSON.stringify(expectedAbi)}`,
      );
    }
  }
  try {
    validatePackagedMobileRuntimeFiles({
      artifactNames: artifact.names,
      metadata: readJson(REACT_NATIVE_EXTENSION_METADATA),
      platform: artifact.platform === 'android' ? 'Android' : 'iOS',
      prefix,
      registry: readJson(MOBILE_STATIC_REGISTRY),
      selected,
    });
  } catch (error) {
    fail(`${rel(artifact.path)} failed mobile runtime inventory validation: ${error.message}`);
  }
  for (const extension of selected) {
    if (requirePrebuiltExtensions) {
      checkExtensionPackageHasMobileTarget(extension, target);
    }
  }
  const stems = domains.nativeModuleStems;
  if (stems.length > 0) {
    if (runtime.mobileStaticRegistryState !== 'complete') {
      fail(
        `${rel(artifact.path)} must mark mobile static registry complete for native-module extensions`,
      );
    }
    if (
      artifact.platform === 'android' &&
      !artifact.names.some((name) => name.endsWith('/liboliphaunt_extensions.so'))
    ) {
      fail(`${rel(artifact.path)} Android app is missing liboliphaunt_extensions.so`);
    }
    if (artifact.platform === 'android' && requirePrebuiltExtensions) {
      checkAndroidPrebuiltExtensionLinkage(
        artifact,
        stems,
        report,
        reportPath,
        expectedAbi,
        staticRegistry,
        target,
      );
    }
    if (artifact.platform === 'ios' && requirePrebuiltExtensions) {
      checkIosPrebuiltExtensionLinkage(artifact, stems);
    }
    if (artifact.names.some((name) => name.includes('static-registry/archives/'))) {
      fail(`${rel(artifact.path)} must not ship build-only static-registry archives`);
    }
  } else if (![undefined, '', 'not-required'].includes(runtime.mobileStaticRegistryState)) {
    fail(`${rel(artifact.path)} must not claim a static registry for SQL-only extensions`);
  }
  const packageSize = artifact.readText(packageSizeName);
  const packageSizeExtensions = packageSize
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('extension\t'))
    .map((line) => line.split('\t')[1])
    .filter(Boolean)
    .sort(compareText);
  if (JSON.stringify(packageSizeExtensions) !== JSON.stringify([...selected].sort(compareText))) {
    fail(
      `${rel(artifact.path)} package-size extension rows ${JSON.stringify(packageSizeExtensions)} must exactly match selected extensions ${JSON.stringify([...selected].sort(compareText))}`,
    );
  }
  console.log(
    `validated mobile app extension contents: ${artifact.platform} ${rel(artifact.path)}`,
  );
}

export function checkMobilePlatform(platform, { require, requirePrebuiltExtensions }) {
  const artifacts = discoverMobileArtifacts(platform);
  if (artifacts.length === 0) {
    if (require) {
      fail(
        `missing staged React Native ${platform} mobile app artifacts under ${rel(path.join(MOBILE_ROOT, platform))}`,
      );
    }
    return false;
  }
  for (const artifact of artifacts) {
    checkMobileArtifact(artifact, { requirePrebuiltExtensions });
  }
  return true;
}

if (import.meta.main) {
  const [platform] = process.argv.slice(2);
  if (!['android', 'ios'].includes(platform)) fail('usage: check-mobile-artifacts.mts android|ios');
  checkMobilePlatform(platform, { require: true, requirePrebuiltExtensions: true });
}
