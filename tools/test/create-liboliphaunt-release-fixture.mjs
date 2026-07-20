#!/usr/bin/env bun
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  elfFixture,
  machoFixture,
  parseCommonArgs,
  windowsImportLibraryFixture,
  windowsPeFixture,
  writeChecksumManifest,
  writeEntriesArchive,
} from './release-fixture-utils.mjs';

const NATIVE_RUNTIME_TOOL_STEMS = ['initdb', 'pg_ctl', 'postgres'];
const NATIVE_TOOLS_TOOL_STEMS = ['pg_dump', 'psql'];
const WINDOWS_VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

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

function nativeRuntimeEntries(target) {
  const windows = target === 'windows-x64-msvc';
  const suffix = windows ? '.exe' : '';
  const entries = Object.fromEntries(
    NATIVE_RUNTIME_TOOL_STEMS.map((tool) => [
      `runtime/bin/${tool}${suffix}`,
      nativeBinary(target, { provider: windows }),
    ]),
  );
  entries['runtime/share/postgresql/README.release-fixture'] =
    'release-shaped native runtime fixture\n';
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

function runtimeResourcePackageSizeReport(entries) {
  const runtimeBytes = byteSize(entries, 'oliphaunt/runtime/files/');
  const templateBytes = byteSize(entries, 'oliphaunt/template-pgdata/files/');
  const staticRegistryBytes = byteSize(entries, 'oliphaunt/static-registry/');
  return [
    'kind\tid\textensions\tfiles\tbytes',
    `package\ttotal\t-\t-\t${runtimeBytes + templateBytes + staticRegistryBytes}`,
    `package\truntime\t-\t-\t${runtimeBytes}`,
    `package\ttemplate-pgdata\t-\t-\t${templateBytes}`,
    `package\tstatic-registry\t-\t-\t${staticRegistryBytes}`,
    'extensions\tselected\t-\t-\t0',
    '',
  ].join('\n');
}

function runtimeResourceEntries() {
  const entries = {
    'oliphaunt/runtime/files/share/postgresql/README.release-fixture':
      'release-shaped runtime fixture\n',
    'oliphaunt/static-registry/manifest.properties': emptyStaticRegistryManifest(),
    'oliphaunt/runtime/manifest.properties': runtimeResourceManifest(
      'release-fixture-runtime',
      'postgres-runtime-files-v1',
    ),
    'oliphaunt/template-pgdata/files/PG_VERSION': '18\n',
    'oliphaunt/template-pgdata/manifest.properties': runtimeResourceManifest(
      'release-fixture-template',
      'postgres-template-pgdata-v1',
    ),
  };
  entries['oliphaunt/package-size.tsv'] = runtimeResourcePackageSizeReport(entries);
  return entries;
}

function runtimeResourceManifest(cacheKey, layout) {
  return [
    'schema=oliphaunt-runtime-resources-v1',
    `cacheKey=${cacheKey}`,
    `layout=${layout}`,
    'selectedExtensions=',
    'extensions=',
    'runtimeFeatures=',
    'sharedPreloadLibraries=',
    'mobileStaticRegistryState=not-required',
    'mobileStaticRegistryRegistered=',
    'mobileStaticRegistryPending=',
    'nativeModuleStems=',
    'mobileStaticRegistrySource=',
    '',
  ].join('\n');
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

function xcframeworkEntries() {
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

async function writeFixtureAssets(assetDir, version) {
  await fs.mkdir(assetDir, { recursive: true });
  const runtimeResources = runtimeResourceEntries();

  await fs.writeFile(
    path.join(assetDir, `liboliphaunt-${version}-package-size.tsv`),
    runtimeResources['oliphaunt/package-size.tsv'],
    'utf8',
  );

  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-runtime-resources.tar.gz`),
    runtimeResources,
  );
  await writeEntriesArchive(path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`), {
    'share/icu/icudt76l.dat': 'not-real-icu-data\n',
  });
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-macos-arm64.tar.gz`),
    {
      'lib/liboliphaunt.dylib': nativeBinary('macos-arm64'),
      'lib/modules/plpgsql.dylib': nativeBinary('macos-arm64'),
      ...nativeRuntimeEntries('macos-arm64'),
    },
    nativeRuntimeModes('macos-arm64'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-macos-arm64.tar.gz`),
    nativeToolsEntries('macos-arm64'),
    nativeToolsModes('macos-arm64'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-x64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': nativeBinary('linux-x64-gnu'),
      'lib/modules/plpgsql.so': nativeBinary('linux-x64-gnu'),
      ...nativeRuntimeEntries('linux-x64-gnu'),
    },
    nativeRuntimeModes('linux-x64-gnu'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-x64-gnu.tar.gz`),
    nativeToolsEntries('linux-x64-gnu'),
    nativeToolsModes('linux-x64-gnu'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-arm64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': nativeBinary('linux-arm64-gnu'),
      'lib/modules/plpgsql.so': nativeBinary('linux-arm64-gnu'),
      ...nativeRuntimeEntries('linux-arm64-gnu'),
    },
    nativeRuntimeModes('linux-arm64-gnu'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-arm64-gnu.tar.gz`),
    nativeToolsEntries('linux-arm64-gnu'),
    nativeToolsModes('linux-arm64-gnu'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-ios-xcframework.tar.gz`),
    xcframeworkEntries(),
    xcframeworkModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-android-arm64-v8a.tar.gz`),
    { 'jni/arm64-v8a/liboliphaunt.so': nativeBinary('android-arm64-v8a') },
  );
  await writeEntriesArchive(path.join(assetDir, `liboliphaunt-${version}-android-x86_64.tar.gz`), {
    'jni/x86_64/liboliphaunt.so': nativeBinary('android-x86_64'),
  });
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-windows-x64-msvc.zip`),
    {
      'bin/oliphaunt.dll': nativeBinary('windows-x64-msvc', { provider: true }),
      'lib/oliphaunt.lib': windowsImportLibraryFixture(),
      'lib/modules/plpgsql.dll': nativeBinary('windows-x64-msvc', { provider: true }),
      ...nativeRuntimeEntries('windows-x64-msvc'),
      ...windowsVcRuntimeEntries(),
    },
    nativeRuntimeModes('windows-x64-msvc'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-windows-x64-msvc.zip`),
    nativeToolsEntries('windows-x64-msvc'),
    nativeToolsModes('windows-x64-msvc'),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-apple-spm-xcframework.zip`),
    xcframeworkEntries(),
    xcframeworkModes(),
  );

  await writeChecksumManifest(assetDir, `liboliphaunt-${version}-release-assets.sha256`);
}

const { assetDir, version } = parseCommonArgs(
  Bun.argv.slice(2),
  'Create small liboliphaunt release-shaped assets for SDK package checks.',
);
await writeFixtureAssets(assetDir, version);
