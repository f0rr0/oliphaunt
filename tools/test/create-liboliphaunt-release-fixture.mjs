#!/usr/bin/env bun
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { releaseNoticeRows } from '../release/release-notices.mjs';
import {
  logicalTreeSha256,
  nativeClusterSeedCompatibilityKey,
} from '../release/native-cluster-seed-contract.mjs';
import { NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN } from '../release/native-mobile-abi-contract.mjs';

import {
  elfFixture,
  machoFixture,
  parseCommonArgs,
  windowsImportLibraryFixture,
  windowsPeFixture,
  writeChecksumManifest,
  writeEntriesArchive,
} from './release-fixture-utils.mjs';
import { nativeRuntimeResourceManifestFixture } from './native-runtime-fixture.mjs';

const NATIVE_RUNTIME_TOOL_STEMS = ['initdb', 'pg_ctl', 'postgres'];
const NATIVE_TOOLS_TOOL_STEMS = ['pg_basebackup', 'pg_dump', 'psql'];
const SNOWBALL_STOPWORDS = [
  'danish.stop',
  'dutch.stop',
  'english.stop',
  'finnish.stop',
  'french.stop',
  'german.stop',
  'hungarian.stop',
  'italian.stop',
  'nepali.stop',
  'norwegian.stop',
  'portuguese.stop',
  'russian.stop',
  'spanish.stop',
  'swedish.stop',
  'turkish.stop',
];
const WINDOWS_VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const WINDOWS_ICU_RUNTIME_DLLS = ['icudt76.dll', 'icuin76.dll', 'icuuc76.dll'];

function windowsVcRuntimeEntries() {
  const entries = {};
  for (const directory of ['bin', 'runtime/bin']) {
    for (const name of WINDOWS_VC_RUNTIME_DLLS) {
      entries[`${directory}/${name}`] = windowsPeFixture({ imports: ['KERNEL32.dll'] });
    }
    entries[`${directory}/windows-vc-runtime.sha256`] =
      WINDOWS_VC_RUNTIME_DLLS.map((name) => {
        const digest = createHash('sha256').update(entries[`${directory}/${name}`]).digest('hex');
        return `${digest}  ${name}`;
      }).join('\n') + '\n';
  }
  return entries;
}

function windowsIcuRuntimeEntries() {
  const entries = {};
  for (const directory of ['bin', 'runtime/bin']) {
    for (const name of WINDOWS_ICU_RUNTIME_DLLS) {
      entries[`${directory}/${name}`] = nativeBinary('windows-x64-msvc', { provider: true });
    }
  }
  return entries;
}

function nativeBinary(target, { provider = false } = {}) {
  if (target === 'macos-arm64') {
    return machoFixture({ platform: 1, minos: [11, 0, 0] });
  }
  if (target === 'linux-x64-gnu') {
    return elfFixture({ machine: 62, requiredVersions: ['GLIBC_2.17'] });
  }
  if (target === 'linux-arm64-gnu') {
    return elfFixture({ machine: 183, requiredVersions: ['GLIBC_2.17'] });
  }
  if (target === 'android-arm64-v8a') {
    return elfFixture({ machine: 183, androidApi: 24 });
  }
  if (target === 'android-x86_64') {
    return elfFixture({ machine: 62, androidApi: 24 });
  }
  if (target === 'windows-x64-msvc') {
    return windowsPeFixture({ imports: [provider ? 'VCRUNTIME140.dll' : 'KERNEL32.dll'] });
  }
  throw new Error(`unsupported liboliphaunt release fixture target ${target}`);
}

function nativeRuntimeEntries(target, icuDataTreeSha256) {
  const windows = target === 'windows-x64-msvc';
  const suffix = windows ? '.exe' : '';
  const moduleSuffix = windows ? '.dll' : target === 'macos-arm64' ? '.dylib' : '.so';
  const entries = Object.fromEntries(
    NATIVE_RUNTIME_TOOL_STEMS.map((tool) => [
      `runtime/bin/${tool}${suffix}`,
      nativeBinary(target, { provider: windows }),
    ]),
  );
  entries['runtime/share/postgresql/README.release-fixture'] =
    'release-shaped native runtime fixture\n';
  entries['runtime/manifest.properties'] = nativeRuntimeResourceManifestFixture({
    cacheKey: 'release-fixture-runtime',
    target,
  });
  entries[`runtime/lib/postgresql/dict_snowball${moduleSuffix}`] = nativeBinary(target);
  entries[`runtime/lib/postgresql/plpgsql${moduleSuffix}`] = nativeBinary(target);
  entries['runtime/share/postgresql/extension/plpgsql.control'] = "default_version = '1.0'\n";
  entries['runtime/share/postgresql/extension/plpgsql--1.0.sql'] =
    '-- release-shaped PL/pgSQL fixture\n';
  entries['runtime/share/postgresql/snowball_create.sql'] =
    '-- release-shaped Snowball dictionary fixture\n';
  for (const stopword of SNOWBALL_STOPWORDS) {
    entries[`runtime/share/postgresql/tsearch_data/${stopword}`] = `${stopword}\n`;
  }
  Object.assign(
    entries,
    nativeRuntimeCarrierReceipt(target),
    nativeClusterSeedEntries('standard', 'cluster-seed', target),
    nativeClusterSeedEntries('icu', 'cluster-seed-icu', target, icuDataTreeSha256),
  );
  return entries;
}

function nativeRuntimeModes(target) {
  const windows = target === 'windows-x64-msvc';
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_RUNTIME_TOOL_STEMS.map((tool) => [`runtime/bin/${tool}${suffix}`, 0o755]),
  );
}

function nativeToolsEntries(target) {
  const windows = target === 'windows-x64-msvc';
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_TOOLS_TOOL_STEMS.map((tool) => [`runtime/bin/${tool}${suffix}`, nativeBinary(target)]),
  );
}

function nativeToolsModes(target) {
  const windows = target === 'windows-x64-msvc';
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_TOOLS_TOOL_STEMS.map((tool) => [`runtime/bin/${tool}${suffix}`, 0o755]),
  );
}

function emptyStaticRegistryManifest() {
  return [
    'packageLayout=oliphaunt-static-registry-v1',
    'abiVersion=1',
    'state=not-required',
    'source=',
    'registeredExtensions=',
    'pendingExtensions=',
    'nativeModuleStems=',
    'modules=',
    'archiveTargets=',
    'dependencyArchiveTargets=',
    'dependencyArchives=',
    '',
  ].join('\n');
}

function byteSize(entries, prefix) {
  return Object.entries(entries)
    .filter(([name]) => name.startsWith(prefix))
    .reduce((total, [, data]) => total + Buffer.byteLength(data), 0);
}

function runtimeResourcePackageSizeReport(entries, prefix = 'oliphaunt/') {
  const runtimeBytes = byteSize(entries, `${prefix}runtime/files/`);
  const clusterSeedBytes = byteSize(entries, `${prefix}cluster-seed/files/`);
  const icuClusterSeedBytes = byteSize(entries, `${prefix}cluster-seed-icu/files/`);
  const staticRegistryBytes = byteSize(entries, `${prefix}static-registry/`);
  return [
    'kind\tid\textensions\tfiles\tbytes',
    `package\ttotal\t-\t-\t${runtimeBytes + clusterSeedBytes + icuClusterSeedBytes + staticRegistryBytes}`,
    `package\truntime\t-\t-\t${runtimeBytes}`,
    `package\tcluster-seed\t-\t-\t${clusterSeedBytes}`,
    `package\tcluster-seed-icu\t-\t-\t${icuClusterSeedBytes}`,
    `package\tstatic-registry\t-\t-\t${staticRegistryBytes}`,
    'extensions\tselected\t-\t-\t0',
    '',
  ].join('\n');
}

function nativeRuntimeCarrierReceipt(target, prefix = '') {
  return {
    [`${prefix}manifest.properties`]: [
      'schema=oliphaunt-native-runtime-carrier-v1',
      `clusterSeedTarget=${target}`,
      'clusterSeedRelativePath=cluster-seed',
      'icuClusterSeedRelativePath=cluster-seed-icu',
      '',
    ].join('\n'),
  };
}

function runtimeResourceEntries(target, icuDataTreeSha256) {
  const entries = {
    'oliphaunt/runtime/files/share/postgresql/README.release-fixture':
      'release-shaped runtime fixture\n',
    'oliphaunt/static-registry/manifest.properties': emptyStaticRegistryManifest(),
    'oliphaunt/runtime/manifest.properties': nativeRuntimeResourceManifestFixture({
      cacheKey: 'release-fixture-runtime',
      target,
    }),
    ...nativeRuntimeCarrierReceipt(target, 'oliphaunt/'),
    ...nativeClusterSeedEntries('standard', 'oliphaunt/cluster-seed', target),
    ...nativeClusterSeedEntries('icu', 'oliphaunt/cluster-seed-icu', target, icuDataTreeSha256),
  };
  entries['oliphaunt/runtime/files/share/postgresql/extension/plpgsql.control'] =
    "default_version = '1.0'\n";
  entries['oliphaunt/runtime/files/share/postgresql/extension/plpgsql--1.0.sql'] =
    '-- release-shaped PL/pgSQL fixture\n';
  entries['oliphaunt/runtime/files/share/postgresql/snowball_create.sql'] =
    '-- release-shaped Snowball dictionary fixture\n';
  for (const stopword of SNOWBALL_STOPWORDS) {
    entries[`oliphaunt/runtime/files/share/postgresql/tsearch_data/${stopword}`] = `${stopword}\n`;
  }
  if (NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[target] !== undefined) {
    Object.assign(entries, mobileAbiProofEntries(target));
  }
  entries['oliphaunt/package-size.tsv'] = runtimeResourcePackageSizeReport(entries);
  return entries;
}

function mobileAbiProofEntries(domain) {
  return Object.fromEntries(
    NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain].map((target) => [
      `oliphaunt/provenance/native-mobile-abi/${target}.properties`,
      [
        'schema=oliphaunt-native-mobile-abi-v1',
        `target=${target}`,
        'byteOrder=little',
        'datumBytes=8',
        'maximumAlignof=8',
        'float8ByVal=1',
        'blockSize=8192',
        'walBlockSize=8192',
        'relationSegmentSize=131072',
        'nameDataLength=64',
        'indexMaxKeys=32',
        'catalogVersion=202506291',
        'pgControlVersion=1800',
        '',
      ].join('\n'),
    ]),
  );
}

function nativeClusterSeedEntries(profile, prefix, target, icuDataTreeSha256 = '') {
  const runtimeFeatures = profile === 'icu' ? 'icu' : '';
  const manifest = [
    'schema=oliphaunt-runtime-resources-v1',
    'layout=oliphaunt-cluster-seed-v1',
    `artifactRole=cluster-seed-${profile}`,
    `catalogProfile=${profile}`,
    `target=${target}`,
    'postgresMajor=18',
    'physicalFormat=native-pg18-v1',
    `compatibilityKey=${nativeClusterSeedCompatibilityKey(target)}`,
    'initialSuperuser=postgres',
    `icuDataVersion=${profile === 'icu' ? '76.1' : ''}`,
    `icuDataForm=${profile === 'icu' ? 'files-le' : ''}`,
    `icuDataTreeSha256=${icuDataTreeSha256}`,
    `runtimeFeatures=${runtimeFeatures}`,
    `cacheKey=${createHash('sha256').update(`${target}:${profile}`).digest('hex').slice(0, 16)}`,
    '',
  ].join('\n');
  return {
    [`${prefix}/manifest.properties`]: manifest,
    [`${prefix}/files/PG_VERSION`]: '18\n',
    [`${prefix}/files/global/pg_control`]: `${profile}-fixture-control\n`,
    [`${prefix}/files/pg_wal/`]: '',
  };
}

function icuClosure() {
  const data = Buffer.from('not-real-icu-data\n');
  const entries = {
    'share/icu/icudt76l.dat': data,
  };
  const icuDataTreeSha256 = logicalTreeSha256([{ path: 'icudt76l.dat', bytes: data }]);
  const icuDataBytes = byteSize(entries, 'share/icu/');
  entries['manifest.properties'] = [
    'schema=oliphaunt-icu-data-v1',
    'artifactRole=icu-data',
    'icuDataVersion=76.1',
    'icuDataForm=files-le',
    `icuDataTreeSha256=${icuDataTreeSha256}`,
    '',
  ].join('\n');
  entries['package-size.tsv'] = [
    'kind\tid\textensions\tfiles\tbytes',
    `package\ttotal\t-\t-\t${icuDataBytes}`,
    `package\ticu-data\t-\t-\t${icuDataBytes}`,
    '',
  ].join('\n');
  return { entries, icuDataTreeSha256 };
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function plistValue(value, indent = '  ') {
  if (Array.isArray(value)) {
    const lines = [`${indent}<array>`];
    for (const item of value) {
      lines.push(plistValue(item, `${indent}  `));
    }
    lines.push(`${indent}</array>`);
    return lines.join('\n');
  }
  if (value && typeof value === 'object') {
    const lines = [`${indent}<dict>`];
    for (const key of Object.keys(value).sort()) {
      lines.push(`${indent}  <key>${xmlEscape(key)}</key>`);
      lines.push(plistValue(value[key], `${indent}  `));
    }
    lines.push(`${indent}</dict>`);
    return lines.join('\n');
  }
  return `${indent}<string>${xmlEscape(String(value))}</string>`;
}

function plist(dictionary) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(dictionary, '  '),
    '</plist>',
    '',
  ].join('\n');
}

function xcframeworkEntries({ macosRuntimeResources, iosRuntimeResources }) {
  const libraries = [
    {
      LibraryIdentifier: 'macos-arm64',
      LibraryPath: 'liboliphaunt.framework',
      SupportedArchitectures: ['arm64'],
      SupportedPlatform: 'macos',
    },
    {
      LibraryIdentifier: 'ios-arm64',
      LibraryPath: 'liboliphaunt.framework',
      SupportedArchitectures: ['arm64'],
      SupportedPlatform: 'ios',
    },
    {
      LibraryIdentifier: 'ios-arm64-simulator',
      LibraryPath: 'liboliphaunt.framework',
      SupportedArchitectures: ['arm64'],
      SupportedPlatform: 'ios',
      SupportedPlatformVariant: 'simulator',
    },
  ];
  const entries = {
    'liboliphaunt.xcframework/Info.plist': plist({
      AvailableLibraries: libraries,
      CFBundlePackageType: 'XFWK',
      XCFrameworkFormatVersion: '1.0',
    }),
  };
  for (const library of libraries) {
    const frameworkRoot = `liboliphaunt.xcframework/${library.LibraryIdentifier}/liboliphaunt.framework`;
    const appleTarget =
      library.SupportedPlatform === 'macos'
        ? { platform: 1, minos: [14, 0, 0] }
        : library.SupportedPlatformVariant === 'simulator'
          ? { platform: 7, minos: [17, 0, 0] }
          : { platform: 2, minos: [17, 0, 0] };
    entries[`${frameworkRoot}/liboliphaunt`] = machoFixture(appleTarget);
    entries[`${frameworkRoot}/Info.plist`] = plist({
      CFBundleExecutable: 'liboliphaunt',
      CFBundleIdentifier: 'dev.oliphaunt.liboliphaunt.fixture',
      CFBundleName: 'liboliphaunt',
      CFBundlePackageType: 'FMWK',
    });
    const runtimeResources =
      library.SupportedPlatform === 'macos' ? macosRuntimeResources : iosRuntimeResources;
    for (const [name, data] of Object.entries(runtimeResources)) {
      entries[`${frameworkRoot}/Resources/${name}`] = data;
    }
  }
  return entries;
}

function xcframeworkModes() {
  return {
    'liboliphaunt.xcframework/macos-arm64/liboliphaunt.framework/liboliphaunt': 0o755,
    'liboliphaunt.xcframework/ios-arm64/liboliphaunt.framework/liboliphaunt': 0o755,
    'liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/liboliphaunt': 0o755,
  };
}

async function writeProfiledArchive(output, entries, profile, modes = {}, noticePrefix = '') {
  const notices = {};
  for (const row of releaseNoticeRows({ profile })) {
    const member = noticePrefix ? `${noticePrefix}/${row.member}` : row.member;
    notices[member] = await fs.readFile(row.source);
  }
  await writeEntriesArchive(output, { ...entries, ...notices }, modes);
}

async function writeFixtureAssets(assetDir, version) {
  await fs.mkdir(assetDir, { recursive: true });
  const icu = icuClosure();
  const macosRuntimeResources = runtimeResourceEntries('macos-arm64', icu.icuDataTreeSha256);
  const iosRuntimeResources = runtimeResourceEntries('ios-datum64', icu.icuDataTreeSha256);
  const androidRuntimeResources = runtimeResourceEntries('android-datum64', icu.icuDataTreeSha256);
  const appleXcframeworkEntries = xcframeworkEntries({
    macosRuntimeResources,
    iosRuntimeResources,
  });

  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`),
    iosRuntimeResources,
    'native-runtime-resources',
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-runtime-resources-android-datum64.tar.gz`),
    androidRuntimeResources,
    'native-runtime-resources',
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`),
    icu.entries,
    'native-icu-data',
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-macos-arm64.tar.gz`),
    {
      'lib/liboliphaunt.dylib': nativeBinary('macos-arm64'),
      'lib/modules/dict_snowball.dylib': nativeBinary('macos-arm64'),
      'lib/modules/plpgsql.dylib': nativeBinary('macos-arm64'),
      ...nativeRuntimeEntries('macos-arm64', icu.icuDataTreeSha256),
    },
    'native-runtime',
    nativeRuntimeModes('macos-arm64'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-macos-arm64.tar.gz`),
    nativeToolsEntries('macos-arm64'),
    'native-tools',
    nativeToolsModes('macos-arm64'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-x64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': nativeBinary('linux-x64-gnu'),
      'lib/modules/dict_snowball.so': nativeBinary('linux-x64-gnu'),
      'lib/modules/plpgsql.so': nativeBinary('linux-x64-gnu'),
      ...nativeRuntimeEntries('linux-x64-gnu', icu.icuDataTreeSha256),
    },
    'native-runtime',
    nativeRuntimeModes('linux-x64-gnu'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-x64-gnu.tar.gz`),
    nativeToolsEntries('linux-x64-gnu'),
    'native-tools',
    nativeToolsModes('linux-x64-gnu'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-arm64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': nativeBinary('linux-arm64-gnu'),
      'lib/modules/dict_snowball.so': nativeBinary('linux-arm64-gnu'),
      'lib/modules/plpgsql.so': nativeBinary('linux-arm64-gnu'),
      ...nativeRuntimeEntries('linux-arm64-gnu', icu.icuDataTreeSha256),
    },
    'native-runtime',
    nativeRuntimeModes('linux-arm64-gnu'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-arm64-gnu.tar.gz`),
    nativeToolsEntries('linux-arm64-gnu'),
    'native-tools',
    nativeToolsModes('linux-arm64-gnu'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-ios-xcframework.tar.gz`),
    appleXcframeworkEntries,
    'native-runtime',
    xcframeworkModes(),
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-android-arm64-v8a.tar.gz`),
    { 'jni/arm64-v8a/liboliphaunt.so': nativeBinary('android-arm64-v8a') },
    'native-runtime',
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-android-x86_64.tar.gz`),
    { 'jni/x86_64/liboliphaunt.so': nativeBinary('android-x86_64') },
    'native-runtime',
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-windows-x64-msvc.zip`),
    {
      'bin/oliphaunt.dll': nativeBinary('windows-x64-msvc', { provider: true }),
      'lib/oliphaunt.lib': windowsImportLibraryFixture(),
      'lib/modules/dict_snowball.dll': nativeBinary('windows-x64-msvc', { provider: true }),
      'lib/modules/plpgsql.dll': nativeBinary('windows-x64-msvc', { provider: true }),
      ...nativeRuntimeEntries('windows-x64-msvc', icu.icuDataTreeSha256),
      ...windowsIcuRuntimeEntries(),
      ...windowsVcRuntimeEntries(),
    },
    'native-runtime',
    nativeRuntimeModes('windows-x64-msvc'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-windows-x64-msvc.zip`),
    nativeToolsEntries('windows-x64-msvc'),
    'native-tools',
    nativeToolsModes('windows-x64-msvc'),
  );
  await writeProfiledArchive(
    path.join(assetDir, `liboliphaunt-${version}-apple-spm-xcframework.zip`),
    appleXcframeworkEntries,
    'native-runtime',
    xcframeworkModes(),
    'liboliphaunt.xcframework',
  );

  await writeChecksumManifest(assetDir, `liboliphaunt-${version}-release-assets.sha256`);
}

const { assetDir, version } = parseCommonArgs(
  Bun.argv.slice(2),
  'Create small liboliphaunt release-shaped assets for SDK package checks.',
);
await writeFixtureAssets(assetDir, version);
