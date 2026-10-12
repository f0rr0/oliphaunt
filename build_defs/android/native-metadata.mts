import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Package = { package: string; version: string; root: string };
type Module = {
  name: string;
  namespace: string;
  root: string;
  sources: string[];
  resources: string[];
  manifest: string;
  aar?: string;
  dependencies: string[];
  buildConfig: Record<string, string>;
  pika: boolean;
};
const text = (file: string) => readFileSync(file, 'utf8');
export function nativeAndroidPackages(packages: Package[]) {
  const identities = new Map<string, Package>();
  for (const row of packages) {
    const candidate =
      row.package === 'react-native' ||
      row.package === 'react-native-safe-area-context' ||
      row.package === 'expo' ||
      row.package.startsWith('expo-') ||
      row.package.startsWith('@expo/');
    const native =
      candidate &&
      (existsSync(path.join(row.root, 'android/build.gradle')) ||
        existsSync(path.join(row.root, 'android/build.gradle.kts')) ||
        (row.package === 'react-native' &&
          existsSync(path.join(row.root, 'ReactAndroid/gradle.properties'))));
    if (!native) continue;
    const previous = identities.get(row.package);
    if (
      previous &&
      (previous.version !== row.version || path.resolve(previous.root) !== path.resolve(row.root))
    )
      throw new Error(
        `Native Android autolinking needs one exact locked package identity: ${row.package}`,
      );
    identities.set(row.package, row);
  }
  return [...identities.values()];
}
function required(source: string, expression: RegExp, description: string) {
  const value = source.match(expression)?.[1];
  if (!value) throw new Error(`Conventional Android metadata is missing ${description}`);
  return value;
}
function properties(source: string) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}
const coordinateLabel = (coordinate: string) =>
  coordinate
    .split(':')
    .slice(0, 2)
    .join('_')
    .replaceAll(/[^A-Za-z0-9_]/g, '_');
export function reactNativeRuntimeDependencies(source: string, catalogSource: string): string[] {
  const catalog = Bun.TOML.parse(catalogSource) as {
    versions: Record<string, string>;
    libraries: Record<
      string,
      { module?: string; group?: string; name?: string; version: string | { ref: string } }
    >;
  };
  const result = new Set<string>();
  for (const match of source.matchAll(
    /^\s*(?:api|implementation|runtimeOnly)\(libs\.([\w.]+)\)/gm,
  )) {
    const alias = match[1].replaceAll('.', '-');
    const library = catalog.libraries[alias];
    if (!library) throw new Error(`Missing conventional React Native catalog alias ${alias}`);
    const module = library.module ?? `${library.group}:${library.name}`;
    const version =
      typeof library.version === 'string' ? library.version : catalog.versions[library.version.ref];
    if (!/^[\w.-]+:[\w.-]+$/.test(module) || !version)
      throw new Error(`Incomplete conventional React Native runtime dependency ${alias}`);
    result.add(`${module}:${version}`);
  }
  if (!result.size)
    throw new Error('React Native release runtime dependency declarations are missing');
  return [...result].sort();
}
function disabledComposeBranches(source: string) {
  const branches: [number, number][] = [];
  for (const match of source.matchAll(/\bif\s*\(shouldIncludeCompose\)\s*\{/g)) {
    const start = match.index!;
    let depth = 1,
      at = start + match[0].length;
    for (; at < source.length && depth; at++) {
      const char = source[at];
      if (char === '"' || char === "'") {
        const quote = char;
        for (at++; at < source.length; at++) {
          if (source[at] === '\\') at++;
          else if (source[at] === quote) break;
        }
      } else if (char === '/' && source[at + 1] === '/') {
        while (at < source.length && source[at] !== '\n') at++;
      } else if (char === '/' && source[at + 1] === '*') {
        const end = source.indexOf('*/', at + 2);
        if (end < 0) throw new Error('Unterminated conventional Android comment');
        at = end + 1;
      } else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth) throw new Error('Unterminated conventional Android Compose branch');
    branches.push([start, at]);
  }
  return branches;
}
export function androidReleaseDependencies(
  source: string,
  kotlin: string,
  rn: string,
  withoutCompose = false,
): string[] {
  const variables = Object.fromEntries(
    [...source.matchAll(/(?:def|val)\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  variables.kotlinVersion = kotlin;
  variables.kotlin_version = kotlin;
  const result: string[] = [];
  const disabled = withoutCompose ? disabledComposeBranches(source) : [];
  for (const match of source.matchAll(
    /^\s*(?:implementation|api|compileOnly|releaseCompileOnly)\s*\(?\s*['"]([^'"]+)['"]/gm,
  )) {
    if (disabled.some(([start, end]) => match.index! >= start && match.index! < end)) continue;
    let coordinate = match[1].replaceAll(/\$\{?(\w+)\}?/g, (_, name: string) => {
      if (!variables[name])
        throw new Error(`Unresolved conventional Android dependency variable ${name}`);
      return variables[name];
    });
    if (
      coordinate === 'com.facebook.react:react-android' ||
      coordinate === 'com.facebook.react:react-native:+'
    )
      coordinate = `com.facebook.react:react-android:aar:release:${rn}`;
    // The upstream Gradle module redirects the androidJvm release variant to
    // this AAR; its common metadata JAR contains no Android implementation.
    if (coordinate.startsWith('com.squareup.zstd:zstd-kmp-okio:'))
      coordinate = `com.squareup.zstd:zstd-kmp-okio-android:aar:${coordinate.split(':').at(-1)}`;
    if (
      coordinate === 'com.facebook.react:hermes-android' ||
      coordinate.includes('org.webkit:android-jsc:')
    )
      continue; // Only the upstream androidTest branch.
    if (!/^[\w.-]+:[\w.-]+:[\w.+-]+(?::[\w.+-]+)*$/.test(coordinate))
      throw new Error(`Unsupported conventional Android dependency ${coordinate}`);
    result.push(coordinate);
  }
  return [...new Set(result)];
}
function pomDependencies(source: string, rn: string) {
  return [...source.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)]
    .map((match) => {
      const body = match[1];
      const module = ['groupId', 'artifactId']
        .map((tag) => required(body, new RegExp(`<${tag}>([^<]+)<\\/${tag}>`), `published ${tag}`))
        .join(':');
      if (module === 'com.facebook.react:react-android') return `${module}:aar:release:${rn}`;
      const version = required(body, /<version>([^<]+)<\/version>/, `${module} published version`);
      return `${module}:${version}`;
    })
    .filter(
      (coordinate) =>
        !coordinate.startsWith('host.exp.exponent:') && !coordinate.startsWith('expo.modules.'),
    );
}
const sourceSets: Record<string, string[]> = {
  'expo-modules-core': ['src/main/java', 'src/main/kotlin', 'src/withoutCompose'],
  expo: ['src/main/java', 'src/main/kotlin', 'src/release/java', 'src/release/kotlin'],
  'expo-dev-launcher': ['src/main/java', 'src/main/kotlin', 'src/disableInRelease/java'],
  'expo-dev-menu': ['src/main/java', 'src/main/kotlin', 'src/disableInRelease/java'],
  '@expo/log-box': ['src/main'],
  'react-native-safe-area-context': ['src/main/java', 'src/main/kotlin', 'src/fabric/java'],
};

export function androidNativeMetadata(packages: Package[], kotlin: string) {
  packages = nativeAndroidPackages(packages);
  const byName = new Map(packages.map((row) => [row.package, row]));
  const rn = byName.get('react-native');
  if (!rn) throw new Error('Native Expo construction requires the locked React Native package');
  const rnProperties = properties(text(path.join(rn.root, 'ReactAndroid/gradle.properties')));
  const hermes = properties(text(path.join(rn.root, 'sdks/hermes-engine/version.properties')));
  if (rnProperties.VERSION_NAME !== rn.version)
    throw new Error('React Native package/Android release version differs');
  const rnCatalog = text(path.join(rn.root, 'gradle/libs.versions.toml'));
  const reactNativeDependencies = reactNativeRuntimeDependencies(
    text(path.join(rn.root, 'ReactAndroid/build.gradle.kts')),
    rnCatalog,
  );
  const maven = new Set<string>([
    ...reactNativeDependencies,
    `com.facebook.react:react-android:aar:release:${rn.version}`,
    `${rnProperties['react.internal.hermesPublishingGroup']}:hermes-android:aar:release:${hermes.HERMES_V1_VERSION_NAME}`,
  ]);
  const modules: Module[] = [];
  for (const row of packages) {
    const android = path.join(row.root, 'android');
    const gradleFile = path.join(android, 'build.gradle');
    if (!existsSync(gradleFile)) continue;
    const gradle = text(gradleFile);
    const namespace = required(
      gradle,
      /namespace\s*(?:=\s*)?["']([^"']+)["']/,
      `${row.package} namespace`,
    );
    const configFile = path.join(row.root, 'expo-module.config.json');
    const config = existsSync(configFile) ? (JSON.parse(text(configFile)).android ?? {}) : {};
    const publication = config.publication;
    let aar: string | undefined;
    let deps = androidReleaseDependencies(
      gradle,
      kotlin,
      rn.version,
      row.package === 'expo-modules-core',
    );
    if (publication) {
      const directory = path.join(
        row.root,
        publication.repository,
        ...publication.groupId.split('.'),
        publication.artifactId,
        publication.version,
      );
      aar = path.join(directory, `${publication.artifactId}-${publication.version}.aar`);
      if (!existsSync(aar)) throw new Error(`Missing pinned Expo published AAR ${row.package}`);
      deps = pomDependencies(
        text(path.join(directory, `${publication.artifactId}-${publication.version}.pom`)),
        rn.version,
      );
      deps = deps.map((coordinate) =>
        coordinate.startsWith('com.facebook.react:react-android:')
          ? `com.facebook.react:react-android:aar:release:${rn.version}`
          : coordinate,
      );
    }
    if (row.package === 'expo-modules-core') {
      const extension = text(
        path.join(
          row.root,
          'expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/gradle/ExpoModuleExtension.kt',
        ),
      );
      if (!/enableCompileTimeOptimization[\s\S]*default\s*=\s*true/.test(extension))
        throw new Error('Expo compile-time optimization default changed');
      const plugin = text(path.join(row.root, 'expo-module-gradle-plugin/build.gradle.kts'));
      const pika = required(
        plugin,
        /io\.github\.lukmccall\.pika:pika-gradle:([^"']+)/,
        'Expo Pika plugin version',
      );
      maven.add(`io.github.lukmccall.pika:pika-compiler:${pika}-${kotlin}`);
      maven.add(`org.jetbrains.kotlin:kotlin-compose-compiler-plugin-embeddable:${kotlin}`);
      maven.add(`org.jetbrains.kotlin:kotlin-serialization-compiler-plugin-embeddable:${kotlin}`);
    }
    // Release disables dev-launcher/menu debug source sets. Their release-only
    // stubs still compile with the originally applied compiler plugins.
    if (row.package === 'expo-dev-menu')
      deps = deps.filter((coordinate) => coordinate.startsWith('androidx.compose.foundation:'));
    // Exact classifier AAR acquisition has no transitive variant metadata.
    // Preserve RN's original api dependency edges from its source catalog.
    if (deps.some((coordinate) => coordinate.startsWith('com.facebook.react:react-android:')))
      deps = [...new Set([...deps, ...reactNativeDependencies])];
    for (const coordinate of deps) {
      maven.add(coordinate);
      if (coordinate.startsWith('com.squareup.zstd:zstd-kmp-okio-android:'))
        maven.add(`com.squareup.zstd:zstd-kmp-android:aar:${coordinate.split(':').at(-1)}`);
    }
    const buildConfig: Record<string, string> = {
      DEBUG: 'false',
      LIBRARY_PACKAGE_NAME: JSON.stringify(namespace),
      BUILD_TYPE: '"release"',
    };
    if (row.package === 'expo-modules-core')
      Object.assign(buildConfig, {
        EXPO_MODULES_CORE_VERSION: JSON.stringify(row.version),
        IS_NEW_ARCHITECTURE_ENABLED: 'true',
      });
    if (row.package === 'expo-dev-launcher' || row.package === 'expo-dev-client')
      buildConfig.VERSION = JSON.stringify(row.version);
    if (row.package === 'expo-dev-menu') buildConfig.AUTO_INITIALIZATION = 'false';
    if (row.package === '@expo/log-box') buildConfig.EXPO_UNSTABLE_LOG_BOX = 'false';
    if (row.package === 'react-native-safe-area-context')
      buildConfig.IS_NEW_ARCHITECTURE_ENABLED = 'true';
    modules.push({
      name: row.package,
      namespace,
      root: row.root,
      aar,
      dependencies: deps,
      buildConfig,
      pika: /expo-module-gradle-plugin/.test(gradle),
      sources: (sourceSets[row.package] ?? ['src/main/java', 'src/main/kotlin'])
        .map((directory) => path.join(android, directory))
        .filter(existsSync),
      resources: [
        'src/main/res',
        ...(row.package === 'expo-dev-launcher' || row.package === 'expo-dev-menu'
          ? ['src/disableInRelease/res']
          : ['src/release/res']),
      ]
        .map((directory) => path.join(android, directory))
        .filter(existsSync),
      manifest: path.join(android, 'src/main/AndroidManifest.xml'),
    });
  }
  // Follow the RN-pinned ABI dependencies; Gradle resolves the older Expo
  // compile-only fbjni request to RN's actual pinned version.
  const fbjni = required(rnCatalog, /^fbjni\s*=\s*"([^"]+)"/m, 'React Native fbjni version');
  for (const coordinate of maven)
    if (coordinate.startsWith('com.facebook.fbjni:fbjni:')) maven.delete(coordinate);
  maven.add(`com.facebook.fbjni:fbjni:${fbjni}`);
  for (const coordinate of [...maven])
    if (coordinate.startsWith('org.jetbrains.kotlin:')) {
      maven.delete(coordinate);
      maven.add(coordinate.split(':').slice(0, 2).join(':') + ':' + kotlin);
    }
  return {
    modules,
    maven: [...maven].sort(),
    reactNative: rn.version,
    reactNativeDependencies,
    hermes: hermes.HERMES_V1_VERSION_NAME,
    kotlin,
    fbjni,
  };
}

function bzl(value: unknown): string {
  if (value === undefined || value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return `[${value.map(bzl).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${bzl(key)}: ${bzl(item)}`)
      .join(', ')}}`;
  return JSON.stringify(value);
}

export function emitAndroidNativeMetadata(
  packages: Package[],
  kotlin: string,
  output: string,
  sdkGradle?: string,
) {
  const metadata = androidNativeMetadata(packages, kotlin);
  if (sdkGradle) {
    const source = text(sdkGradle);
    const jna = required(
      source,
      /net\.java\.dev\.jna:jna:([^"']+)@aar/,
      'React Native Android JNA release',
    );
    const topology = required(
      source,
      /def oliphauntTopology\s*=\s*\(oliphauntProperty\("oliphauntTopology"\)\s*\?:\s*"([^"]+)"/,
      'React Native default native topology',
    );
    const namespace = required(source, /namespace\s*=\s*"([^"]+)"/, 'React Native SDK namespace');
    metadata.maven.push(`net.java.dev.jna:jna:aar:${jna}`);
    metadata.maven.sort();
    writeFileSync(
      path.join(output, 'jna-android.versions.toml'),
      `[libraries]\njnaAndroid = ${JSON.stringify(`net.java.dev.jna:jna:aar:${jna}`)}\n`,
    );
    Object.assign(metadata, { reactNativeSdk: { jna, namespace, topology } });
    const directory = path.join(output, 'generated/oliphaunt_react_native');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'BuildConfig.java'),
      `package ${namespace};\npublic final class BuildConfig {\n  public static final String OLIPHAUNT_TOPOLOGY = ${JSON.stringify(topology)};\n}\n`,
    );
  }
  const relative = (file: string) => path.relative(output, file).replaceAll(path.sep, '/');
  const modules = metadata.modules.map((row) => ({
    ...row,
    root: relative(row.root),
    aar: row.aar && relative(row.aar),
    manifest: relative(row.manifest),
    sources: row.sources.map(relative),
    resources: row.resources.map(relative),
  }));
  writeFileSync(
    path.join(output, 'metadata.bzl'),
    `ANDROID_NATIVE = ${bzl({ ...metadata, modules })}\n`,
  );
  writeFileSync(
    path.join(output, 'maven.versions.toml'),
    `[libraries]\n${metadata.maven.map((coordinate, index) => `native${index} = ${JSON.stringify(coordinate)}`).join('\n')}\n`,
  );
  const build = [
    'load("@oliphaunt//build_defs/android:jvm.bzl", "expo_android_jvm")',
    'load("@oliphaunt//build_defs/android:native-targets.bzl", "expo_android_native")',
    'load(":metadata.bzl", "ANDROID_NATIVE")',
    'package(default_visibility = ["//visibility:public"])',
    `exports_files(${bzl(['metadata.bzl', 'maven.versions.toml', ...(sdkGradle ? ['jna-android.versions.toml'] : [])])})`,
  ];
  for (const row of modules) {
    const name = coordinateLabel(row.name);
    build.push(
      `filegroup(name = ${JSON.stringify(name + '_sources')}, srcs = glob(${bzl(row.sources.flatMap((directory) => [directory + '/**/*.kt', directory + '/**/*.java']))}, allow_empty = True))`,
    );
    build.push(
      `filegroup(name = ${JSON.stringify(name + '_resource_files')}, srcs = glob(${bzl(row.resources.map((directory) => directory + '/**/*'))}, allow_empty = True))`,
    );
    if (!row.aar) {
      const directory = path.join(output, 'generated', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'BuildConfig.java'),
        `package ${row.namespace};\npublic final class BuildConfig {\n${Object.entries(
          row.buildConfig,
        )
          .map(
            ([name, value]) =>
              `  public static final ${value.startsWith('"') ? 'String' : 'boolean'} ${name} = ${value};`,
          )
          .join('\n')}\n}\n`,
      );
    }
    if (row.aar) build.push(`exports_files([${JSON.stringify(row.aar)}])`);
    if (existsSync(path.join(output, row.manifest)))
      build.push(`exports_files([${JSON.stringify(row.manifest)}])`);
  }
  writeFileSync(
    path.join(output, 'source-manifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="expo.modules" />\n',
  );
  build.push(
    'exports_files(glob(["packages/react-native/ReactAndroid/cmake-utils/default-app-setup/*.cpp", "packages/expo-modules-core/android/src/main/cpp/ExpoHeader.pch", "generated/oliphaunt_react_native/BuildConfig.java"]))',
  );
  build.push(
    'expo_android_jvm(metadata = ANDROID_NATIVE, safe_area_codegen = "@oliphaunt//src/examples/native/react-native-expo:safe_area_codegen")',
  );
  build.push('expo_android_native(metadata = ANDROID_NATIVE)');
  writeFileSync(path.join(output, 'BUILD.bazel'), build.join('\n') + '\n');
  return metadata;
}

if (import.meta.main) {
  const [input, catalog, output, sdkGradle] = process.argv.slice(2);
  emitAndroidNativeMetadata(
    JSON.parse(text(input)),
    (Bun.TOML.parse(text(catalog)) as any).versions.kotlin,
    output,
    sdkGradle,
  );
}
