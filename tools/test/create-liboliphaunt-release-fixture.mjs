#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  parseCommonArgs,
  writeChecksumManifest,
  writeEntriesArchive,
} from './release-fixture-utils.mjs';

const NATIVE_RUNTIME_TOOL_STEMS = ['initdb', 'pg_ctl', 'postgres'];
const NATIVE_TOOLS_TOOL_STEMS = ['pg_dump', 'psql'];

function nativeRuntimeEntries({ windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  const entries = Object.fromEntries(
    NATIVE_RUNTIME_TOOL_STEMS.map((tool) => [
      `runtime/bin/${tool}${suffix}`,
      `not-a-real-${tool}${suffix}\n`,
    ]),
  );
  entries['runtime/share/postgresql/README.release-fixture'] =
    'release-shaped native runtime fixture\n';
  return entries;
}

function nativeRuntimeModes({ windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_RUNTIME_TOOL_STEMS.map((tool) => [`runtime/bin/${tool}${suffix}`, 0o755]),
  );
}

function nativeToolsEntries({ windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_TOOLS_TOOL_STEMS.map((tool) => [
      `runtime/bin/${tool}${suffix}`,
      `not-a-real-${tool}${suffix}\n`,
    ]),
  );
}

function nativeToolsModes({ windows = false } = {}) {
  const suffix = windows ? '.exe' : '';
  return Object.fromEntries(
    NATIVE_TOOLS_TOOL_STEMS.map((tool) => [`runtime/bin/${tool}${suffix}`, 0o755]),
  );
}

function runtimeResourceEntries() {
  return {
    'oliphaunt/package-size.tsv': [
      'kind\tid\textensions\tfiles\tbytes',
      'package\ttotal\t-\t-\t96',
      'package\truntime\t-\t-\t31',
      'package\ttemplate-pgdata\t-\t-\t20',
      'package\tstatic-registry\t-\t-\t45',
      'extensions\tselected\t-\t-\t0',
      '',
    ].join('\n'),
    'oliphaunt/runtime/files/share/postgresql/README.release-fixture':
      'release-shaped runtime fixture\n',
    'oliphaunt/static-registry/manifest.properties': [
      'schema=oliphaunt-static-registry-v1',
      'registered=',
      'pending=',
      '',
    ].join('\n'),
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
}

function runtimeResourceManifest(cacheKey, layout) {
  return [
    'schema=oliphaunt-runtime-resources-v1',
    `cacheKey=${cacheKey}`,
    `layout=${layout}`,
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
      LibraryIdentifier: 'ios-arm64_x86_64-simulator',
      LibraryPath: 'liboliphaunt.framework',
      SupportedArchitectures: ['arm64', 'x86_64'],
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
    entries[`${frameworkRoot}/liboliphaunt`] = 'not-a-real-framework-binary\n';
    entries[`${frameworkRoot}/Info.plist`] = plist({
      CFBundleExecutable: 'liboliphaunt',
      CFBundleIdentifier: 'dev.oliphaunt.liboliphaunt.fixture',
      CFBundleName: 'liboliphaunt',
      CFBundlePackageType: 'FMWK',
    });
  }
  return entries;
}

async function writeFixtureAssets(assetDir, version) {
  await fs.mkdir(assetDir, { recursive: true });

  await fs.writeFile(
    path.join(assetDir, `liboliphaunt-${version}-package-size.tsv`),
    [
      'kind\tid\textensions\tfiles\tbytes',
      'package\ttotal\t-\t-\t96',
      'package\truntime\t-\t-\t31',
      'package\ttemplate-pgdata\t-\t-\t20',
      'package\tstatic-registry\t-\t-\t45',
      'extensions\tselected\t-\t-\t0',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-runtime-resources.tar.gz`),
    runtimeResourceEntries(),
  );
  await writeEntriesArchive(path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`), {
    'share/icu/icudt76l.dat': 'not-real-icu-data\n',
  });
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-macos-arm64.tar.gz`),
    {
      'lib/liboliphaunt.dylib': 'not-a-real-dylib\n',
      'lib/modules/plpgsql.dylib': 'not-a-real-module\n',
      ...nativeRuntimeEntries(),
    },
    nativeRuntimeModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-macos-arm64.tar.gz`),
    nativeToolsEntries(),
    nativeToolsModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-x64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': 'not-a-real-elf\n',
      'lib/modules/plpgsql.so': 'not-a-real-module\n',
      ...nativeRuntimeEntries(),
    },
    nativeRuntimeModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-x64-gnu.tar.gz`),
    nativeToolsEntries(),
    nativeToolsModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-linux-arm64-gnu.tar.gz`),
    {
      'lib/liboliphaunt.so': 'not-a-real-elf\n',
      'lib/modules/plpgsql.so': 'not-a-real-module\n',
      ...nativeRuntimeEntries(),
    },
    nativeRuntimeModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-linux-arm64-gnu.tar.gz`),
    nativeToolsEntries(),
    nativeToolsModes(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-ios-xcframework.tar.gz`),
    xcframeworkEntries(),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-android-arm64-v8a.tar.gz`),
    { 'jni/arm64-v8a/liboliphaunt.so': 'not-a-real-android-elf\n' },
  );
  await writeEntriesArchive(path.join(assetDir, `liboliphaunt-${version}-android-x86_64.tar.gz`), {
    'jni/x86_64/liboliphaunt.so': 'not-a-real-android-elf\n',
  });
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-windows-x64-msvc.zip`),
    {
      'bin/oliphaunt.dll': 'not-a-real-dll\n',
      'lib/modules/plpgsql.dll': 'not-a-real-module\n',
      ...nativeRuntimeEntries({ windows: true }),
    },
    nativeRuntimeModes({ windows: true }),
  );
  await writeEntriesArchive(
    path.join(assetDir, `oliphaunt-tools-${version}-windows-x64-msvc.zip`),
    nativeToolsEntries({ windows: true }),
    nativeToolsModes({ windows: true }),
  );
  await writeEntriesArchive(
    path.join(assetDir, `liboliphaunt-${version}-apple-spm-xcframework.zip`),
    xcframeworkEntries(),
  );

  await writeChecksumManifest(assetDir, `liboliphaunt-${version}-release-assets.sha256`);
}

const { assetDir, version } = parseCommonArgs(
  Bun.argv.slice(2),
  'Create small liboliphaunt release-shaped assets for SDK package checks.',
);
await writeFixtureAssets(assetDir, version);
