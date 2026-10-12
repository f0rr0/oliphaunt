import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

type AcquiredPackage = { package: string; version: string; integrity: string; root: string };
type Profile = {
  package: string;
  module: string;
  directory: string;
  deps?: string[];
  exclude?: string[];
  swift?: string;
  podspec?: string;
};
const profiles: Profile[] = [
  { package: '@expo/dom-webview', module: 'ExpoDomWebView', directory: 'ios', swift: '5' },
  { package: '@expo/log-box', module: 'ExpoLogBox', directory: 'ios', deps: ['React'] },
  {
    package: 'expo',
    module: 'Expo',
    directory: 'ios',
    swift: '6',
    deps: ['ExpoModulesCore', 'ExpoModulesJSI', 'React', '@app//:ReactAppDependencyProvider'],
    exclude: ['ios/Tests'],
  },
  { package: 'expo-asset', module: 'ExpoAsset', directory: 'ios', swift: '5' },
  { package: 'expo-constants', module: 'EXConstants', directory: 'ios', swift: '5' },
  {
    package: 'expo-dev-menu-interface',
    module: 'expo_dev_menu_interface',
    directory: 'ios',
    deps: [],
    swift: '5',
  },
  { package: 'expo-json-utils', module: 'EXJSONUtils', directory: 'ios/EXJSONUtils', deps: [] },
  { package: 'expo-keep-awake', module: 'ExpoKeepAwake', directory: 'ios', swift: '5' },
  { package: 'expo-manifests', module: 'EXManifests', directory: 'ios/EXManifests', swift: '5' },
  { package: 'expo-splash-screen', module: 'ExpoSplashScreen', directory: 'ios' },
  {
    package: 'expo-sqlite',
    module: 'ExpoSQLite',
    directory: 'ios',
    exclude: ['ios/SQLiteModuleLibSQL.swift', 'ios/libsql', 'ios/libsql.xcframework'],
  },
  { package: 'expo-system-ui', module: 'ExpoSystemUI', directory: 'ios/ExpoSystemUI', swift: '5' },
  {
    package: 'expo-updates-interface',
    module: 'EXUpdatesInterface',
    directory: 'ios/EXUpdatesInterface',
    swift: '5',
  },
];
const imported = {
  'expo-modules-core': ['ExpoModulesCore', 'ExpoModulesWorklets'],
  'expo-file-system': ['ExpoFileSystem'],
  'expo-font': ['ExpoFont'],
};
const releaseEmpty = ['expo-dev-client'];
const debugOnly = ['expo-dev-launcher', 'expo-dev-menu'];

function walk(root: string): string[] {
  const result: string[] = [];
  function descend(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) descend(file);
      else if (entry.isFile()) result.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  descend(root);
  return result.sort();
}
/** Extend the existing native npm source projection; it does not acquire or resolve packages. */
export function projectAppleNativeInputs(
  packages: AcquiredPackage[],
  repository: string,
  sdkManifestFile: string,
) {
  const sdk = JSON.parse(readFileSync(sdkManifestFile, 'utf8'));
  assert.equal(sdk.name, '@oliphaunt/react-native');
  assert.match(sdk.oliphaunt.swiftSdkVersion, /^\d+\.\d+\.\d+$/u);
  const expected = [
    ...profiles.map((row) => row.package),
    ...Object.keys(imported),
    ...releaseEmpty,
    ...debugOnly,
    'expo-modules-jsi',
  ];
  const nativeNames = new Set([...expected, 'react-native', 'react-native-safe-area-context']);
  const byName = new Map<string, AcquiredPackage>();
  for (const row of packages) {
    if (!nativeNames.has(row.package)) continue;
    const previous = byName.get(row.package);
    if (previous)
      assert.deepEqual(
        [previous.version, previous.integrity],
        [row.version, row.integrity],
        'Apple native modules require one exact locked source identity: ' + row.package,
      );
    byName.set(row.package, row);
  }
  function requireInput(name: string) {
    const row = byName.get(name);
    assert(row, 'Missing acquired Apple module ' + name);
    return row;
  }
  const expectedModules: Record<string, string> = {};
  const rows: Record<string, unknown>[] = [];
  for (const name of expected) {
    const row = requireInput(name);
    const manifest = JSON.parse(readFileSync(path.join(row.root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, row.version);
    expectedModules[name] = row.version;
  }
  for (const profile of profiles) {
    const row = requireInput(profile.package);
    const files = walk(row.root);
    const podspecs = files.filter((name) => name.endsWith('.podspec') && !name.includes('Tests'));
    assert.equal(
      podspecs.length,
      1,
      'Review changed Apple Podspec/subspec composition for ' + profile.package,
    );
    const spec = readFileSync(path.join(row.root, podspecs[0]), 'utf8');
    assert(
      spec.includes(profile.module.replaceAll('_', '-')) || spec.includes(profile.module),
      'Apple module identity differs from its original Podspec: ' + profile.module,
    );
    assert(
      spec.includes('s.source_files'),
      'Original Apple module no longer declares source_files',
    );
    const sources = files.filter(
      (name) =>
        name.startsWith(profile.directory + '/') &&
        /\.(?:swift|h|m|mm|cpp|c)$/u.test(name) &&
        !/(?:^|\/)(?:Tests|[^/]*Tests)(?:\/|\.)/u.test(name) &&
        !(profile.exclude ?? []).some(
          (excluded) => name === excluded || name.startsWith(excluded + '/'),
        ),
    );
    const prefix = path.relative(repository, row.root).split(path.sep).join('/');
    assert(
      !prefix.startsWith('../') && !path.isAbsolute(prefix),
      'Native sources must belong to their captured repository',
    );
    const headers: string[] = [],
      privateHeaders: string[] = [];
    const names = new Set<string>();
    for (const source of sources.filter((name) => name.endsWith('.h'))) {
      privateHeaders.push(prefix + '/' + source);
      const basename = path.basename(source);
      assert(
        !names.has(basename),
        'Ambiguous CocoaPods public header name ' + profile.module + '/' + basename,
      );
      names.add(basename);
      if (profile.module === 'Expo' && basename === 'Swift.h') continue;
      const alias = 'apple-headers/' + profile.module + '/' + basename;
      const destination = path.join(repository, alias);
      mkdirSync(path.dirname(destination), { recursive: true });
      if (!existsSync(destination))
        symlinkSync(
          path.relative(path.dirname(destination), path.join(row.root, source)),
          destination,
        );
      headers.push(alias);
    }
    rows.push({
      ...profile,
      root: prefix,
      sources: sources.filter((name) => !name.endsWith('.h')).map((name) => prefix + '/' + name),
      headers,
      privateHeaders,
      deps: profile.deps ?? ['ExpoModulesCore'],
      privacy: files
        .filter((name) => name.endsWith('PrivacyInfo.xcprivacy'))
        .map((name) => prefix + '/' + name),
      podspec: prefix + '/' + podspecs[0],
    });
  }
  const frameworks = Object.entries(imported).flatMap(([name, modules]) => {
    const row = requireInput(name);
    return modules.map((module) => {
      const archive = path.join(
        row.root,
        'prebuilds/output/release/xcframeworks',
        module + '.tar.gz',
      );
      assert(existsSync(archive), 'Use original Expo release XCFramework ' + module);
      return {
        module,
        archive: path.relative(repository, archive).split(path.sep).join('/'),
        privacy: walk(row.root)
          .filter((name) => name.endsWith('PrivacyInfo.xcprivacy'))
          .map((name) =>
            path.relative(repository, path.join(row.root, name)).split(path.sep).join('/'),
          ),
      };
    });
  });
  const rn = requireInput('react-native');
  const rnManifest = JSON.parse(readFileSync(path.join(rn.root, 'package.json'), 'utf8'));
  const rnHelpers = readFileSync(path.join(rn.root, 'scripts/cocoapods/helpers.rb'), 'utf8');
  const follyFlags = rnHelpers.match(
    /@@folly_config\s*=\s*\{[^}]*:compiler_flags\s*=>\s*'([^']+)'/u,
  )?.[1];
  assert(follyFlags, 'Original RN Apple recipe must declare Folly compiler flags');
  const follyCompilerFlags = follyFlags.trim().split(/\s+/u);
  assert(
    follyCompilerFlags.every((flag) => /^-[A-Za-z0-9=_+.-]+$/u.test(flag)),
    'Review changed original RN Folly compiler flags',
  );
  const hermesProperties = readFileSync(
    path.join(rn.root, 'sdks/hermes-engine/version.properties'),
    'utf8',
  );
  const hermes = hermesProperties.match(/^HERMES_V1_VERSION_NAME=(.+)$/mu)?.[1];
  assert(hermes);
  const result = {
    expectedModules,
    modules: rows,
    frameworks,
    swiftSdkVersion: sdk.oliphaunt.swiftSdkVersion,
    reactNativeVersion: rnManifest.version,
    hermesVersion: hermes,
    follyCompilerFlags,
    jsiRoot: path
      .relative(repository, requireInput('expo-modules-jsi').root)
      .split(path.sep)
      .join('/'),
    safeAreaRoot: path
      .relative(repository, requireInput('react-native-safe-area-context').root)
      .split(path.sep)
      .join('/'),
    sqliteRoot: path
      .relative(repository, requireInput('expo-sqlite').root)
      .split(path.sep)
      .join('/'),
  };
  writeFileSync(
    path.join(repository, 'apple-metadata.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  writeFileSync(
    path.join(repository, 'apple-metadata.bzl'),
    'APPLE_NATIVE = ' +
      JSON.stringify(result, null, 4)
        .replaceAll(': false', ': False')
        .replaceAll(': true', ': True') +
      '\n',
  );
  return result;
}

if (import.meta.main) {
  const [inputs, repository, sdkManifest] = process.argv.slice(2);
  assert(inputs && repository && sdkManifest, 'Expected acquired inputs, repository, SDK manifest');
  projectAppleNativeInputs(JSON.parse(readFileSync(inputs, 'utf8')), repository, sdkManifest);
}
