import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeterministicZip } from '../../tools/packaging/archive-directory.mts';
import {
  readAndroidApkEntries,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';

export type Source = { source: string; destination: string };
export type NpmPackage = {
  package: string;
  version: string;
  integrity: string;
  source: string;
  dependencies: Record<string, string>;
  local?: boolean;
};
export type NodeInputs = {
  packages: Record<string, NpmPackage>;
  roots: Record<string, string>;
  sources: Source[];
  node: string;
  tar: string;
  tarEnvironment?: Record<string, string>;
};

function member(name: string) {
  assert(
    name &&
      !path.isAbsolute(name) &&
      !/[\\\0]/u.test(name) &&
      name.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe declared Android app path ${name}`,
  );
  return name;
}
function put(root: string, name: string, bytes: Buffer | string) {
  const destination = path.join(root, member(name));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { mode: 0o644 });
}
function packageName(name: string) {
  assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name), `Invalid npm name ${name}`);
  return name;
}

/** Resolve only declared archives; package managers never run in app actions. */
export function stageNodeInputs(root: string, inputs: NodeInputs) {
  const stores: Record<string, string> = {};
  for (const [id, row] of Object.entries(inputs.packages)) {
    assert(/^[a-z0-9_]+$/iu.test(id), `Invalid npm package ID ${id}`);
    assert(
      row.local || /^sha512-[A-Za-z0-9+/]+=*$/u.test(row.integrity),
      `Missing npm integrity ${id}`,
    );
    const destination = path.join(root, '.packages', id, 'node_modules', packageName(row.package));
    if (lstatSync(realpathSync(row.source)).isDirectory())
      cpSync(row.source, destination, { recursive: true });
    else {
      const archive = realpathSync(row.source);
      if (!row.local)
        assert.equal(
          `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`,
          row.integrity,
          `npm archive integrity ${id}`,
        );
      mkdirSync(destination, { recursive: true });
      execFileSync(
        realpathSync(inputs.tar),
        [
          '--extract',
          '--no-same-owner',
          '--no-same-permissions',
          '--strip-components',
          '1',
          '--file',
          archive,
          '--directory',
          destination,
        ],
        { env: { ...process.env, ...inputs.tarEnvironment } },
      );
    }
    const manifest = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'));
    assert.equal(manifest.name, row.package, `npm package identity ${id}`);
    assert.equal(manifest.version, row.version, `npm package version ${id}`);
    stores[id] = destination;
  }
  function link(directory: string, name: string, id: string) {
    assert(stores[id], `Undeclared npm dependency ${name}/${id}`);
    const destination = path.join(directory, 'node_modules', packageName(name));
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.relative(path.dirname(destination), stores[id]), destination, 'dir');
  }
  for (const [id, row] of Object.entries(inputs.packages))
    for (const [name, dependency] of Object.entries(row.dependencies))
      link(stores[id], name, dependency);
  for (const [name, id] of Object.entries(inputs.roots)) link(root, name, id);
  const seen = new Set<string>();
  for (const source of inputs.sources) {
    assert(!seen.has(member(source.destination)), `Duplicate app input ${source.destination}`);
    seen.add(source.destination);
    const physical = realpathSync(source.source);
    assert(lstatSync(physical).isFile(), `App input is not a file ${source.destination}`);
    put(root, source.destination, readFileSync(physical));
  }
  const manifestFile = path.join(root, 'package.json');
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const [name, id] of Object.entries(inputs.roots)) {
      if (!inputs.packages[id].local || !manifest.dependencies?.[name]?.startsWith('workspace:'))
        continue;
      manifest.dependencies[name] = inputs.packages[id].version;
    }
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  }
  return stores;
}
function invoke(
  node: string,
  script: string,
  args: string[],
  cwd: string,
  environment: Record<string, string> = {},
) {
  execFileSync(realpathSync(node), [script, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      PATH: path.dirname(realpathSync(node)),
      CI: '1',
      NODE_ENV: 'production',
      EXPO_OFFLINE: '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_NO_GIT_STATUS: '1',
      ...environment,
    },
  });
}
function invokeJson(node: string, script: string, args: string[], cwd: string) {
  return JSON.parse(
    execFileSync(realpathSync(node), [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: path.dirname(realpathSync(node)),
        CI: '1',
        NODE_ENV: 'production',
        EXPO_OFFLINE: '1',
        EXPO_NO_TELEMETRY: '1',
      },
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}
function kotlinTemplate(file: string, name: string) {
  const source = readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`val ${name}\\s*=\\s*"""([\\s\\S]*?)"""`, 'u'));
  assert(match, `Declared RN Gradle source no longer exposes ${name}`);
  const lines = match[1].replace(/^\n|\n\s*$/gu, '').split('\n');
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/u)![0].length),
  );
  return lines.map((line) => line.slice(indent)).join('\n') + '\n';
}
function javaName(name: string) {
  assert(
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(name),
    `Invalid Android classifier ${name}`,
  );
  return name;
}
function expoRegistry(configuration: any, templateFile: string) {
  const projects = configuration.modules.flatMap((module: any) =>
    module.projects.map((project: any) => ({ ...project, packageName: module.packageName })),
  );
  const packages = projects
    .filter((project: any) => project.packageName !== 'expo')
    .flatMap((project: any) => project.packages ?? []);
  const modules = projects.flatMap((project: any) => project.modules ?? []);
  const services = projects.flatMap((project: any) => project.services ?? []);
  const map = modules.map((module: any) => {
    const classifier =
      typeof module === 'string' ? module : (module.classifier ?? module.className);
    assert(typeof classifier === 'string');
    return `${javaName(classifier)}::class.java to ${module.name ? JSON.stringify(module.name) : 'null'}`;
  });
  const template = readFileSync(templateFile, 'utf8').match(
    /return\s+"""([\s\S]*?)"""\.trimIndent\(\)/u,
  )?.[1];
  assert(template, 'Declared Expo Gradle generator no longer exposes its package-list template');
  const values = [
    packages.map((name: string) => `      ${javaName(name)}()`).join(',\n'),
    map.map((value) => `      ${value}`).join(',\n'),
    services.map((name: string) => `      ${javaName(name)}::class.java`).join(',\n'),
  ];
  const result = template
    .replace('${namespace.get()}', 'expo.modules')
    .replace(/\$\{\n[\s\S]*?\n    \}/gu, () => {
      assert(values.length, 'Expo registry template gained an unsupported projection');
      return values.shift()!;
    });
  assert.equal(values.length, 0, 'Expo registry template lost a required projection');
  assert(!result.includes('${'), 'Expo registry retains an unresolved Kotlin interpolation');
  return result.trimEnd() + '\n';
}

async function generateAndroidAutolinking(
  root: string,
  stores: Record<string, string>,
  spec: NodeInputs & {
    expoRegistry: string;
    nativeSources: string;
    nativeHeaders: string;
    expoAssets: string;
    autolinking: string;
  },
) {
  const reactNative = stores[spec.roots['react-native']];
  const plugin =
    stores[spec.packages[spec.roots['react-native']].dependencies['@react-native/gradle-plugin']];
  const expo = stores[spec.roots.expo];
  const expoCli = path.join(expo, 'bin/autolinking');
  const resolved = invokeJson(
    spec.node,
    expoCli,
    ['resolve', '--platform', 'android', '--json'],
    root,
  );
  assert.deepEqual(
    resolved.coreFeatures,
    [],
    'App source/compiler graph must explicitly handle new Expo core features',
  );
  assert.deepEqual(
    resolved.extraDependencies,
    [],
    'App source/compiler graph must explicitly handle new Expo native Maven inputs',
  );
  const config = invokeJson(
    spec.node,
    expoCli,
    ['react-native-config', '--platform', 'android', '--json'],
    root,
  );
  const packageName = javaName(config.project.android.packageName);
  const dependencies = Object.values(config.dependencies)
    .map((dependency: any) => dependency.platforms?.android)
    .filter(Boolean) as any[];
  const tasks = path.join(
    plugin,
    'react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks',
  );
  const instances = dependencies
    .filter((dependency) => !dependency.isPureCxxDependency)
    .map((dependency) => {
      assert(
        typeof dependency.packageImportPath === 'string' &&
          typeof dependency.packageInstance === 'string',
      );
      const name = dependency.packageImportPath.match(/import\s+([\w.]+)\s*;/u)?.[1];
      assert(name, 'RN autolinking package import must name one Java classifier');
      const fqcn = javaName(name);
      const short = name.split('.').at(-1)!;
      return dependency.packageInstance
        .replace(new RegExp(`\\b${short}\\b`, 'gu'), fqcn)
        .replace(
          /([^\w.])(BuildConfig|R)(\W)/gu,
          (_match: string, prefix: string, name: string, suffix: string) =>
            `${prefix}${packageName}.${name}${suffix}`,
        );
    });
  put(
    root,
    'android/app/src/main/java/com/facebook/react/PackageList.java',
    kotlinTemplate(
      path.join(tasks, 'GeneratePackageListTask.kt'),
      'generatedFileContentsTemplate',
    ).replace(
      '{{ packageClassInstances }}',
      instances.length ? ',\n      ' + instances.join(',\n      ') : '',
    ),
  );
  put(
    root,
    'android/app/src/main/java/com/facebook/react/ReactNativeApplicationEntryPoint.java',
    kotlinTemplate(
      path.join(tasks, 'GenerateEntryPointTask.kt'),
      'generatedFileContentsTemplate',
    ).replaceAll('{{packageName}}', packageName),
  );
  const properties = readFileSync(path.join(root, 'android/gradle.properties'), 'utf8');
  const appManifest = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
  const fields = {
    DEBUG: 'false',
    IS_NEW_ARCHITECTURE_ENABLED: 'true',
    IS_HERMES_ENABLED: 'true',
    IS_EDGE_TO_EDGE_ENABLED: /^edgeToEdgeEnabled=true$/mu.test(properties) ? 'true' : 'false',
    REACT_NATIVE_RELEASE_LEVEL: JSON.stringify('stable'),
    VERSION_NAME: JSON.stringify(appManifest.version),
    APPLICATION_ID: JSON.stringify(packageName),
    BUILD_TYPE: JSON.stringify('release'),
    VERSION_CODE: '1',
  };
  put(
    root,
    `android/app/src/main/java/${packageName.replaceAll('.', '/')}/BuildConfig.java`,
    `package ${packageName};\npublic final class BuildConfig {\n` +
      Object.entries(fields)
        .map(
          ([name, value]) =>
            `  public static final ${value.startsWith('"') ? 'String' : name === 'VERSION_CODE' ? 'int' : 'boolean'} ${name} = ${value};`,
        )
        .join('\n') +
      '\n}\n',
  );
  const registry = path.join(root, 'expo-registry');
  const expoAutolinker =
    stores[spec.packages[spec.roots.expo].dependencies['expo-modules-autolinking']];
  assert(expoAutolinker);
  put(
    registry,
    'expo/modules/ExpoModulesPackageList.kt',
    expoRegistry(
      resolved,
      path.join(
        expoAutolinker,
        'android/expo-gradle-plugin/expo-autolinking-plugin/src/main/kotlin/expo/modules/plugin/GeneratePackagesListTask.kt',
      ),
    ),
  );
  writeFileSync(spec.expoRegistry, await createDeterministicZip(registry));
  const libraries = dependencies.filter((dependency) => dependency.libraryName);
  const includes: string[] = [],
    javaProviders: string[] = [],
    cxxProviders: string[] = [],
    descriptors: string[] = [];
  for (const dependency of libraries) {
    const library = dependency.libraryName;
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(library));
    includes.push(`#include <${library}.h>`);
    if (dependency.componentDescriptors?.length) {
      includes.push(`#include <react/renderer/components/${library}/ComponentDescriptors.h>`);
      for (const descriptor of dependency.componentDescriptors) {
        assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(descriptor));
        descriptors.push(
          `providerRegistry->add(concreteComponentDescriptorProvider<${descriptor}>());`,
        );
      }
    }
    javaProviders.push(
      `if (auto module = ${library}_ModuleProvider(moduleName, params)) return module;`,
    );
    if (dependency.cxxModuleHeaderName) {
      const header = dependency.cxxModuleHeaderName;
      assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(header));
      includes.push(`#include <${header}.h>`);
      cxxProviders.push(
        `if (moduleName == ${header}::kModuleName) return std::make_shared<${header}>(jsInvoker);`,
      );
    }
  }
  const cppTask = path.join(tasks, 'GenerateAutolinkingNewArchitecturesFileTask.kt');
  put(
    spec.nativeSources,
    'autolinking.cpp',
    kotlinTemplate(cppTask, 'CPP_TEMPLATE')
      .replace('{{ autolinkingCppIncludes }}', includes.join('\n'))
      .replace('{{ autolinkingCppTurboModuleJavaProviders }}', javaProviders.join('\n'))
      .replace('{{ autolinkingCppTurboModuleCxxProviders }}', cxxProviders.join('\n'))
      .replace('{{ autolinkingCppComponentDescriptors }}', descriptors.join('\n')),
  );
  put(spec.nativeHeaders, 'autolinking.h', kotlinTemplate(cppTask, 'hTemplate'));
  const constantsId = Object.keys(spec.packages).find(
    (id) => spec.packages[id].package === 'expo-constants',
  );
  assert(constantsId);
  mkdirSync(spec.expoAssets, { recursive: true });
  invoke(
    spec.node,
    path.join(stores[constantsId], 'scripts/getAppConfig.js'),
    [root, spec.expoAssets],
    root,
  );
  function normalized(value: any): any {
    if (typeof value === 'string') return value.replaceAll(root + '/', '');
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, normalized(child)]),
      );
    return value;
  }
  writeFileSync(
    spec.autolinking,
    JSON.stringify(normalized({ expo: resolved, reactNative: config }), null, 2) + '\n',
  );
}
async function scratch<T>(operation: (root: string) => T | Promise<T>) {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-expo-'));
  try {
    return await operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function files(root: string, predicate = (_name: string) => true): Source[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .flatMap((name) => {
      const file = path.join(root, name);
      return lstatSync(file).isFile() && predicate(name)
        ? [{ source: file, destination: name.replaceAll(path.sep, '/') }]
        : [];
    });
}
async function sourceJar(root: string, sources: Source[], output: string) {
  assert(sources.length, 'Android compiler input must contain source files');
  for (const source of sources) put(root, source.destination, readFileSync(source.source));
  writeFileSync(output, await createDeterministicZip(root));
}

export async function generateReactNativeCodegen(
  spec: NodeInputs & {
    libraryName: string;
    javaPackageName: string;
    specs: string[];
    schema: string;
    javaSources: string;
    nativeSources: string;
    nativeHeaders: string;
  },
) {
  return scratch(async (root) => {
    const stores = stageNodeInputs(root, spec);
    const codegenId =
      spec.roots['@react-native/codegen'] ??
      spec.packages[spec.roots['react-native']]?.dependencies['@react-native/codegen'];
    const codegen = stores[codegenId];
    const reactNative = stores[spec.roots['react-native']];
    assert(codegen && reactNative, 'RN codegen requires the declared RN/codegen packages');
    const schema = path.join(root, 'schema.json');
    const output = path.join(root, 'generated');
    invoke(
      spec.node,
      path.join(codegen, 'lib/cli/combine/combine-js-to-schema-cli.js'),
      [schema, ...spec.specs.map((name) => path.join(root, member(name)))],
      root,
    );
    invoke(
      spec.node,
      path.join(reactNative, 'scripts/generate-specs-cli.js'),
      [
        '--platform',
        'android',
        '--schemaPath',
        schema,
        '--outputDir',
        output,
        '--libraryName',
        spec.libraryName,
        '--javaPackageName',
        spec.javaPackageName,
      ],
      root,
    );
    assert(
      Object.keys(JSON.parse(readFileSync(schema, 'utf8')).modules).length,
      'RN codegen produced an empty schema',
    );
    copyFileSync(schema, spec.schema);
    await sourceJar(path.join(root, 'srcjar'), files(path.join(output, 'java')), spec.javaSources);
    for (const [destination, predicate] of [
      [spec.nativeSources, (name: string) => /\.(?:c|cc|cpp)$/u.test(name)],
      [spec.nativeHeaders, (name: string) => /\.(?:h|hpp)$/u.test(name)],
    ] as const) {
      mkdirSync(destination, { recursive: true });
      const selected = files(path.join(output, 'jni'), predicate);
      assert(selected.length, `RN codegen omitted native files ${destination}`);
      for (const source of selected)
        put(destination, source.destination, readFileSync(source.source));
    }
  });
}

/** Expo prebuild generates sources/resources, while Bazel owns compilation. */
export async function generateExpoAndroidProject(
  spec: NodeInputs & {
    manifest: string;
    javaSources: string;
    resources: string;
    project: string;
    expoRegistry?: string;
    nativeSources?: string;
    nativeHeaders?: string;
    expoAssets?: string;
    autolinking?: string;
    keystore?: string;
  },
) {
  return scratch(async (root) => {
    const stores = stageNodeInputs(root, spec);
    const expo = stores[spec.roots.expo];
    assert(
      expo && existsSync(path.join(expo, 'template.tgz')),
      'Declared Expo must carry its template',
    );
    invoke(
      spec.node,
      path.join(expo, 'bin/cli'),
      [
        'prebuild',
        '--platform',
        'android',
        '--no-install',
        '--template',
        path.join(expo, 'template.tgz'),
      ],
      root,
    );
    if (spec.expoRegistry) {
      assert(spec.nativeSources && spec.nativeHeaders && spec.expoAssets && spec.autolinking);
      await generateAndroidAutolinking(
        root,
        stores,
        spec as Parameters<typeof generateAndroidAutolinking>[2],
      );
    }
    const app = path.join(root, 'android/app/src/main');
    copyFileSync(path.join(app, 'AndroidManifest.xml'), spec.manifest);
    await sourceJar(
      path.join(root, 'srcjar'),
      files(path.join(app, 'java'), (name) => /\.(?:java|kt)$/u.test(name)),
      spec.javaSources,
    );
    cpSync(path.join(app, 'res'), spec.resources, { recursive: true });
    if (spec.keystore) copyFileSync(path.join(root, 'android/app/debug.keystore'), spec.keystore);
    const declaredProject = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));
    assert.equal(typeof declaredProject.expo?.android?.package, 'string');
    writeFileSync(
      spec.project,
      JSON.stringify(
        {
          package: declaredProject.expo.android.package,
          generatedGradle: readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'),
          gradleProperties: readFileSync(path.join(root, 'android/gradle.properties'), 'utf8'),
          reactNativeVersion: JSON.parse(
            readFileSync(path.join(stores[spec.roots['react-native']], 'package.json'), 'utf8'),
          ).version,
        },
        null,
        2,
      ) + '\n',
    );
  });
}

export function mobileBundleEnvironment(
  environment: Record<string, string>,
  selectedExtensions: readonly string[],
  catalogProfile: string,
  profileProbe: string,
): Record<string, string> {
  assert(['standard', 'icu'].includes(catalogProfile), 'Unsupported packaged catalog profile');
  assert.equal(
    new Set(selectedExtensions).size,
    selectedExtensions.length,
    'Duplicate packaged extensions',
  );
  assert(
    selectedExtensions.every((name) => /^[a-z][a-z0-9_-]*$/u.test(name)),
    'Invalid packaged extension',
  );
  const probe = JSON.parse(readFileSync(profileProbe, 'utf8'));
  assert.equal(probe.schema, 'oliphaunt-cluster-seed-profile-probe-v1');
  const row = probe.profiles?.[catalogProfile];
  assert(typeof row?.sql === 'string' && row.sql.length > 0, 'Missing catalog profile SQL');
  assert(
    typeof row?.expected === 'string' && row.expected.length > 0,
    'Missing catalog profile expectation',
  );
  const canonical = {
    EXPO_PUBLIC_OLIPHAUNT_EXTENSIONS: selectedExtensions.join(','),
    EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE: catalogProfile,
    EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL: row.sql,
    EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED: row.expected,
  };
  for (const [name, value] of Object.entries(canonical))
    assert(
      environment[name] === undefined || environment[name] === value,
      'Conflicting packaged mobile environment ' + name,
    );
  return { ...environment, ...canonical };
}

export async function bundleExpoAndroid(
  spec: NodeInputs & {
    entry: string;
    bundle: string;
    resources: string;
    assets: string;
    sourceMap: string;
    environment: Record<string, string>;
    selectedExtensions: string[];
    catalogProfile: string;
    profileProbe: string;
  },
) {
  return scratch(async (root) => {
    const stores = stageNodeInputs(root, spec);
    const expo = stores[spec.roots.expo];
    const reactNativeId = spec.roots['react-native'];
    const hermesId = spec.packages[reactNativeId]?.dependencies['hermes-compiler'];
    assert(
      expo && hermesId && spec.packages[hermesId]?.package === 'hermes-compiler',
      'Release bundling requires declared Expo and the RN-selected Hermes compiler',
    );
    assert.equal(
      spec.packages[hermesId].version,
      JSON.parse(readFileSync(path.join(stores[reactNativeId], 'package.json'), 'utf8'))
        .dependencies['hermes-compiler'],
      'Hermes compiler differs from the original RN dependency',
    );
    const compiler = path.join(stores[hermesId], 'hermesc/linux64-bin/hermesc');
    assert(existsSync(compiler), 'Locked Hermes compiler has no Linux execution artifact');
    chmodSync(compiler, 0o755);
    const bundle = path.join(root, 'index.android.bundle');
    const resources = path.join(root, 'res');
    const sourceMap = path.join(root, 'index.android.bundle.map');
    invoke(
      spec.node,
      path.join(expo, 'bin/cli'),
      [
        'export:embed',
        '--platform',
        'android',
        '--dev',
        'false',
        '--entry-file',
        member(spec.entry),
        '--bundle-output',
        bundle,
        '--assets-dest',
        resources,
        '--sourcemap-output',
        sourceMap,
      ],
      root,
      {
        ...mobileBundleEnvironment(
          spec.environment,
          spec.selectedExtensions,
          spec.catalogProfile,
          spec.profileProbe,
        ),
        TMPDIR: root,
      },
    );
    const bytecode = path.join(root, 'index.android.hbc');
    execFileSync(
      compiler,
      ['-w', '-O', '-emit-binary', '-out', path.basename(bytecode), path.basename(bundle)],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    const bytes = readFileSync(bytecode);
    assertHermesBytecode(bytes);
    copyFileSync(bytecode, spec.bundle);
    copyFileSync(sourceMap, spec.sourceMap);
    mkdirSync(spec.resources, { recursive: true });
    if (existsSync(resources)) cpSync(resources, spec.resources, { recursive: true });
    mkdirSync(spec.assets, { recursive: true });
    put(spec.assets, 'index.android.bundle', bytes);
  });
}

export function extractPrefab(spec: {
  aar: string;
  abi: string;
  module: string;
  headers: string;
  library: string;
}) {
  assert(['arm64-v8a', 'x86_64'].includes(spec.abi));
  const entries = readPortableArchiveEntries(realpathSync(spec.aar), { format: 'zip' });
  const prefix = `prefab/modules/${member(spec.module)}`;
  const abi = entries.get(`${prefix}/libs/android.${spec.abi}/abi.json`);
  assert(abi?.isFile, `Missing prefab ABI metadata ${spec.module}/${spec.abi}`);
  assert.equal(JSON.parse(Buffer.from(abi.data()).toString('utf8')).abi, spec.abi);
  const shared = entries.get(`${prefix}/libs/android.${spec.abi}/lib${spec.module}.so`);
  assert(shared?.isFile, `Missing prefab library ${spec.module}/${spec.abi}`);
  writeFileSync(spec.library, shared.data());
  mkdirSync(spec.headers, { recursive: true });
  const selected = [...entries].filter(
    ([name, entry]) => name.startsWith(`${prefix}/include/`) && entry.isFile,
  );
  assert(selected.length, `Missing prefab headers ${spec.module}`);
  for (const [name, entry] of selected)
    put(spec.headers, name.slice(`${prefix}/include/`.length), Buffer.from(entry.data()));
}

export async function extractAarNative(spec: {
  aar: string;
  abi: string;
  library: string;
  output: string;
  jar: string;
}) {
  assert(['arm64-v8a', 'x86_64'].includes(spec.abi));
  assert(/^lib[^/]+\.so$/u.test(spec.library));
  // The maintained JDK reader handles upstream AAR ZIP64 metadata. Extraction
  // names one declared member, while final release archives retain strict ZIP.
  await scratch((root) => {
    const name = `jni/${spec.abi}/${spec.library}`;
    execFileSync(realpathSync(spec.jar), ['xf', realpathSync(spec.aar), name], {
      cwd: root,
      stdio: 'inherit',
    });
    assert(existsSync(path.join(root, name)), `Pinned Android AAR omitted ${name}`);
    const bytes = readFileSync(path.join(root, name));
    assertAndroidElf(bytes, spec.abi);
    writeFileSync(spec.output, bytes);
  });
}

export async function extractFinalAar(spec: {
  source: string;
  output: string;
  kind?: 'aar' | 'runtime' | 'seed';
  package?: string;
  abi?: string;
}) {
  const extension = !spec.kind || spec.kind === 'aar' ? '.aar' : '.tar.gz';
  const source = realpathSync(spec.source);
  const candidates = lstatSync(source).isDirectory()
    ? files(source, (name) => name.endsWith(extension))
    : [{ source }];
  assert.equal(
    candidates.length,
    1,
    `A canonical Maven tree must contain exactly one final ${extension} carrier`,
  );
  if (extension === '.aar') {
    copyFileSync(candidates[0].source, spec.output);
    return;
  }
  assert(spec.package && /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(spec.package));
  const entries = readPortableArchiveEntries(candidates[0].source);
  if (spec.kind === 'runtime') {
    assert(spec.abi === 'arm64-v8a' || spec.abi === 'x86_64');
    const library = entries.get(`jni/${spec.abi}/liboliphaunt.so`);
    assert(library?.isFile, 'Canonical Android runtime TAR omitted its selected JNI library');
    for (const [name, entry] of entries)
      if (entry.isFile && name.startsWith('jni/')) {
        assert(
          name.startsWith(`jni/${spec.abi}/`),
          `Canonical Android runtime TAR includes foreign ABI ${name}`,
        );
        if (name.endsWith('.so')) assertAndroidElf(Buffer.from(entry.data()), spec.abi);
      }
  } else
    assert(
      entries.get('cluster-seed/manifest.properties')?.isFile,
      'Canonical Android seed TAR omitted its resource manifest',
    );
  await scratch(async (root) => {
    for (const [name, entry] of entries)
      if (entry.isFile)
        put(
          root,
          spec.kind === 'seed' && name.startsWith('cluster-seed/')
            ? `assets/oliphaunt/${name}`
            : name,
          Buffer.from(entry.data()),
        );
    assert(
      !existsSync(path.join(root, 'AndroidManifest.xml')) &&
        !existsSync(path.join(root, 'classes.jar')),
      'Maven TAR collides with the app-private Android envelope',
    );
    put(
      root,
      'AndroidManifest.xml',
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${spec.package}" />\n`,
    );
    const classes = path.join(root, 'classes');
    mkdirSync(classes);
    put(root, 'classes.jar', await createDeterministicZip(classes));
    rmSync(classes, { recursive: true });
    writeFileSync(spec.output, await createDeterministicZip(root));
  });
}

export function extensionLinkReceipt(spec: {
  library: string;
  registry: string;
  members: { archive: string; registration: string }[];
  selectedExtensions: string[];
  abi: string;
  nm: string;
  output: string;
}) {
  const bytes = readFileSync(spec.library);
  assertAndroidElf(bytes, spec.abi);
  const symbols = execFileSync(
    realpathSync(spec.nm),
    ['-D', '--defined-only', realpathSync(spec.library)],
    { encoding: 'utf8', env: { LC_ALL: 'C', LANG: 'C' } },
  );
  const defined = new Set(
    symbols
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/u).at(-1)!),
  );
  assert(
    defined.has('liboliphaunt_selected_static_extensions'),
    'Linked static extension registry is absent',
  );
  const members = spec.members
    .map((member) => {
      const row = JSON.parse(readFileSync(member.registration, 'utf8'));
      for (const symbol of [
        row.magicSymbol,
        row.initSymbol,
        ...row.symbols.map((symbol: any) => symbol.address),
      ].filter(Boolean))
        assert(
          defined.has(symbol),
          `Linked APK extension omitted actual archive definition ${row.sqlName}/${symbol}`,
        );
      return {
        sqlName: row.sqlName,
        nativeModuleStem: row.nativeModuleStem,
        archiveSha256: createHash('sha256').update(readFileSync(member.archive)).digest('hex'),
        registrationSha256: createHash('sha256')
          .update(readFileSync(member.registration))
          .digest('hex'),
        definedSymbols: [
          row.magicSymbol,
          row.initSymbol,
          ...row.symbols.map((symbol: any) => symbol.address),
        ]
          .filter(Boolean)
          .sort(),
      };
    })
    .sort((a, b) => a.sqlName.localeCompare(b.sqlName));
  assert.deepEqual(
    members.map((row) => row.sqlName),
    [...spec.selectedExtensions].sort(),
  );
  writeFileSync(
    spec.output,
    JSON.stringify(
      {
        schema: 'oliphaunt-android-static-extension-link-v1',
        abi: spec.abi,
        linkedSha256: createHash('sha256').update(bytes).digest('hex'),
        registrySha256: createHash('sha256').update(readFileSync(spec.registry)).digest('hex'),
        selectedExtensions: [...spec.selectedExtensions].sort(),
        members,
      },
      null,
      2,
    ) + '\n',
  );
}

export async function prepareAppRuntimeAssets(spec: {
  payload: string;
  formatter: string;
  version: string;
  selectedExtensions: string[];
  mobileStaticModules: string[];
  receipt: string;
  output: string;
}) {
  return scratch(async (root) => {
    assert(spec.selectedExtensions.length === spec.mobileStaticModules.length);
    const receipt = JSON.parse(readFileSync(spec.receipt, 'utf8'));
    assert.deepEqual(receipt.selectedExtensions, [...spec.selectedExtensions].sort());
    const stage = path.join(root, 'resources');
    const identity = createHash('sha256').update(readFileSync(spec.receipt)).digest('hex');
    execFileSync(
      realpathSync(spec.formatter),
      [
        '--output',
        stage,
        '--liboliphaunt-native-version',
        spec.version,
        '--extension-target',
        'android-datum64',
        '--runtime-cache-identity',
        `android-app-${identity}`,
        '--require-mobile-static-registry',
        ...spec.selectedExtensions.flatMap((name) => ['--extension', name]),
        ...spec.mobileStaticModules.flatMap((name) => ['--mobile-static-module', name]),
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          HOME: root,
          TMPDIR: root,
          LC_ALL: 'C',
          LANG: 'C',
          OLIPHAUNT_INSTALL_DIR: path.join(realpathSync(spec.payload), 'runtime'),
          OLIPHAUNT_EMBEDDED_MODULE_DIR: path.join(realpathSync(spec.payload), 'lib/modules'),
          OLIPHAUNT_RUNTIME_CACHE_DIR: path.join(root, 'cache'),
        },
      },
    );
    cpSync(path.join(stage, 'oliphaunt'), path.join(spec.output, 'oliphaunt'), { recursive: true });
    put(spec.output, 'oliphaunt/static-registry/link-receipt.json', readFileSync(spec.receipt));
  });
}

export async function nativeLibrariesAar(spec: {
  libraries: Source[];
  output: string;
  package: string;
}) {
  return scratch(async (root) => {
    assert(/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(spec.package));
    assert(spec.libraries.length, 'JNI carrier cannot be empty');
    const seen = new Set<string>();
    for (const file of spec.libraries) {
      assert(/^jni\/(?:arm64-v8a|x86_64)\/lib[^/]+\.so$/u.test(file.destination));
      assert(!seen.has(file.destination), `Duplicate JNI library ${file.destination}`);
      seen.add(file.destination);
      const bytes = readFileSync(file.source);
      assertAndroidElf(bytes, file.destination.includes('/arm64-v8a/') ? 'arm64-v8a' : 'x86_64');
      put(root, file.destination, bytes);
    }
    put(
      root,
      'AndroidManifest.xml',
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${spec.package}" />\n`,
    );
    const classes = path.join(root, 'classes');
    mkdirSync(classes);
    put(root, 'classes.jar', await createDeterministicZip(classes));
    rmSync(classes, { recursive: true });
    writeFileSync(spec.output, await createDeterministicZip(root));
  });
}

export function assertHermesBytecode(bytes: Buffer) {
  assert(
    bytes.length > 128 && bytes.readBigUInt64LE() === 0x1f1903c103bc1fc6n,
    'Release APK must contain actual Hermes bytecode',
  );
  assert.equal(bytes.readUInt32LE(32), bytes.length, 'Hermes bytecode is truncated');
  assert.equal(
    createHash('sha1').update(bytes.subarray(0, -20)).digest('hex'),
    bytes.subarray(-20).toString('hex'),
    'Hermes bytecode checksum differs',
  );
}
export function assertAndroidElf(bytes: Buffer, abi: string) {
  assert(bytes.length > 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  assert.equal(bytes[4], 2, 'Android APK JNI libraries must use ELF64');
  assert.equal(bytes[5], 1, 'Android ELF must be little endian');
  assert.equal(
    bytes.readUInt16LE(18),
    abi === 'arm64-v8a' ? 183 : 62,
    'Android ELF machine differs',
  );
  const headerSize = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  const offset = Number(bytes.readBigUInt64LE(32));
  assert(
    headerSize >= 56 && offset + headerSize * count <= bytes.length,
    'Truncated ELF program headers',
  );
  const alignments: bigint[] = [];
  for (let index = 0; index < count; index++) {
    const header = offset + index * headerSize;
    if (bytes.readUInt32LE(header) !== 1) continue;
    const alignment = bytes.readBigUInt64LE(header + 48);
    assert(alignment >= 16384n, 'JNI library lost 16 KiB ELF page alignment');
    assert.equal(
      bytes.readBigUInt64LE(header + 8) % alignment,
      bytes.readBigUInt64LE(header + 16) % alignment,
      'ELF LOAD offset/address are incongruent',
    );
    alignments.push(alignment);
  }
  assert(alignments.length, 'JNI library has no ELF LOAD segments');
}

/** class_defs identifies definitions, so an unused DEX string cannot satisfy proof. */
export function dexDefinedClasses(bytes: Buffer): Set<string> {
  assert(bytes.subarray(0, 4).equals(Buffer.from('dex\n')), 'APK bytecode must be standard DEX');
  assert(
    bytes.length >= 112 &&
      bytes.readUInt32LE(32) === bytes.length &&
      bytes.readUInt32LE(36) === 112,
  );
  assert.equal(bytes.readUInt32LE(40), 0x12345678, 'Unsupported DEX endianness');
  function table(countOffset: number, offsetOffset: number, stride: number) {
    const count = bytes.readUInt32LE(countOffset);
    const offset = bytes.readUInt32LE(offsetOffset);
    assert(offset + count * stride <= bytes.length, 'Truncated DEX table');
    return { count, offset };
  }
  const strings = table(56, 60, 4);
  const types = table(64, 68, 4);
  const definitions = table(96, 100, 32);
  function descriptor(type: number) {
    assert(type < types.count, 'DEX definition has invalid type index');
    const string = bytes.readUInt32LE(types.offset + type * 4);
    assert(string < strings.count, 'DEX definition has invalid descriptor index');
    let offset = bytes.readUInt32LE(strings.offset + string * 4);
    assert(offset < bytes.length, 'DEX descriptor is outside the file');
    let encodedLength = 0;
    do {
      assert(offset < bytes.length && encodedLength++ < 5, 'Invalid DEX UTF length');
    } while (bytes[offset++] & 0x80);
    const end = bytes.indexOf(0, offset);
    assert(end > offset, 'Invalid DEX class descriptor');
    const result = bytes.subarray(offset, end).toString('utf8');
    assert(/^L[A-Za-z0-9_$/]+;$/u.test(result), `Invalid defined DEX class ${result}`);
    return result.slice(1, -1).replaceAll('/', '.');
  }
  const result = new Set<string>();
  for (let index = 0; index < definitions.count; index++)
    result.add(descriptor(bytes.readUInt32LE(definitions.offset + index * 32)));
  return result;
}

/** Android imports need conventional runtime names, never Bazel output paths. */
export function androidDynamicLinkMetadata(output: string, library: string) {
  const sonames = [...output.matchAll(/^\s*SONAME\s+(\S+)\s*$/gmu)].map((row) => row[1]);
  const needed = [...output.matchAll(/^\s*NEEDED\s+(\S+)\s*$/gmu)].map((row) => row[1]);
  assert(sonames.length <= 1, `JNI library has multiple SONAME entries ${library}`);
  if (sonames.length)
    assert.equal(sonames[0], library, `JNI SONAME differs from packaged name ${library}`);
  for (const dependency of needed)
    assert(
      /^[A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)*$/u.test(dependency),
      `JNI dependency has a build path ${library}/${dependency}`,
    );
  if (
    [
      'libexpo-modules-core.so',
      'libreact_codegen_safeareacontext.so',
      'libappmodules.so',
      'liboliphauntreactnative.so',
      'liboliphaunt_extensions.so',
    ].includes(library)
  )
    assert.deepEqual(
      sonames,
      [library],
      `Source-built JNI library omitted its conventional SONAME ${library}`,
    );
  if (library === 'liboliphaunt_extensions.so')
    assert(
      needed.includes('liboliphaunt.so'),
      'Selected extension link omitted its native runtime dependency',
    );
  return { soname: sonames[0] ?? null, needed };
}

export function verifyAndroidApk(spec: {
  apk: string;
  abi: string;
  zipalign: string;
  apksigner: string;
  aapt: string;
  objdump: string;
  output: string;
  selectedExtensions: string[];
  expectedClasses: string[];
  catalogProfile: string;
  profileProbe: string;
  environment?: Record<string, string>;
  unsignedApk?: string;
  keystore?: string;
}) {
  if (spec.unsignedApk) {
    assert(spec.keystore, 'Release APK must retain the original generated signing key');
    const aligned = spec.apk + '.aligned';
    execFileSync(
      realpathSync(spec.zipalign),
      ['-P', '16', '-f', '4', realpathSync(spec.unsignedApk), aligned],
      { stdio: 'inherit' },
    );
    execFileSync(
      realpathSync(spec.apksigner),
      [
        'sign',
        '--ks',
        realpathSync(spec.keystore),
        '--ks-key-alias',
        'androiddebugkey',
        '--ks-pass',
        'pass:android',
        '--key-pass',
        'pass:android',
        '--out',
        spec.apk,
        aligned,
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, ...spec.environment },
      },
    );
    rmSync(aligned);
  }
  const apk = realpathSync(spec.apk);
  const badging = execFileSync(realpathSync(spec.aapt), ['dump', 'badging', apk], {
    encoding: 'utf8',
  });
  assert(
    /^package: name='dev\.oliphaunt\.reactnative\.example'/mu.test(badging),
    'Compiled APK application identity differs',
  );
  assert(/^sdkVersion:'24'$/mu.test(badging), 'Compiled APK minimum Android API differs');
  assert(/^targetSdkVersion:'36'$/mu.test(badging), 'Compiled APK target Android API differs');
  assert(
    /^launchable-activity: name='dev\.oliphaunt\.reactnative\.example\.MainActivity'/mu.test(
      badging,
    ),
    'Compiled APK omitted its actual launcher',
  );
  execFileSync(realpathSync(spec.zipalign), ['-c', '-P', '16', '4', apk], { stdio: 'inherit' });
  execFileSync(realpathSync(spec.apksigner), ['verify', '--verbose', apk], {
    stdio: 'inherit',
    env: { ...process.env, ...spec.environment },
  });
  const entries = readAndroidApkEntries(apk);
  for (const name of [
    `lib/${spec.abi}/liboliphaunt.so`,
    `lib/${spec.abi}/liboliphaunt_mobile_bindings.so`,
    `lib/${spec.abi}/liboliphauntreactnative.so`,
    `lib/${spec.abi}/libreactnative.so`,
    `lib/${spec.abi}/libhermesvm.so`,
    `lib/${spec.abi}/libfbjni.so`,
    `lib/${spec.abi}/libappmodules.so`,
    `lib/${spec.abi}/libexpo-modules-core.so`,
    `lib/${spec.abi}/libjsi.so`,
    `lib/${spec.abi}/libc++_shared.so`,
    `lib/${spec.abi}/libreact_codegen_safeareacontext.so`,
    `lib/${spec.abi}/liboliphaunt_extensions.so`,
    `lib/${spec.abi}/libjnidispatch.so`,
    'assets/oliphaunt/runtime/manifest.properties',
    'assets/oliphaunt/cluster-seed/manifest.properties',
    'assets/oliphaunt/static-registry/link-receipt.json',
    'assets/index.android.bundle',
  ])
    assert(entries.get(name)?.isFile, `Full Expo APK omitted ${name}`);
  const bytecode = Buffer.from(entries.get('assets/index.android.bundle')!.data());
  assertHermesBytecode(bytecode);
  const bundleEnvironment = mobileBundleEnvironment(
    {},
    spec.selectedExtensions,
    spec.catalogProfile,
    spec.profileProbe,
  );
  for (const name of [
    'EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL',
    'EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED',
  ])
    assert(
      bytecode.includes(Buffer.from(bundleEnvironment[name])),
      'APK bundle omitted its original catalog expectation ' + name,
    );
  const seedManifest = Buffer.from(
    entries.get('assets/oliphaunt/cluster-seed/manifest.properties')!.data(),
  ).toString('utf8');
  assert.equal(
    seedManifest.match(/^catalogProfile=(.*)$/mu)?.[1],
    spec.catalogProfile,
    'APK seed profile differs from its bundle expectation',
  );
  const classes = new Set<string>();
  const nativeLibraries: {
    name: string;
    sha256: string;
    soname: string | null;
    needed: string[];
  }[] = [];
  const nativeProof = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-apk-link-'),
  );
  try {
    for (const [name, entry] of entries) {
      if (/^classes(?:\d+)?\.dex$/u.test(name))
        for (const className of dexDefinedClasses(Buffer.from(entry.data())))
          classes.add(className);
      if (/^lib\/[^/]+\/[^/]+\.so$/u.test(name)) {
        assert(name.startsWith(`lib/${spec.abi}/`), `APK includes unselected ABI ${name}`);
        const bytes = Buffer.from(entry.data());
        assertAndroidElf(bytes, spec.abi);
        const library = path.basename(name);
        const file = path.join(nativeProof, library);
        writeFileSync(file, bytes);
        const dynamic = androidDynamicLinkMetadata(
          execFileSync(realpathSync(spec.objdump), ['-p', file], { encoding: 'utf8' }),
          library,
        );
        nativeLibraries.push({
          name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ...dynamic,
        });
      }
    }
  } finally {
    rmSync(nativeProof, { recursive: true, force: true });
  }
  for (const name of [
    'dev.oliphaunt.DatabaseStorage$TemporaryDirectory',
    'com.sun.jna.Native',
    'dev.oliphaunt.reactnative.OliphauntModule',
    'dev.oliphaunt.reactnative.NativeOliphauntSpec',
    'expo.modules.ExpoModulesPackageList',
    'expo.modules.kotlin.AppContext',
    ...spec.expectedClasses,
  ])
    assert(classes.has(name), `Full Expo APK omitted defined bytecode ${name}`);
  const manifest = Buffer.from(
    entries.get('assets/oliphaunt/runtime/manifest.properties')!.data(),
  ).toString('utf8');
  const selected = manifest
    .match(/^selectedExtensions=(.*)$/mu)?.[1]
    ?.split(',')
    .filter(Boolean)
    .sort();
  assert.deepEqual(selected, [...spec.selectedExtensions].sort(), 'APK selected extensions differ');
  const receipt = JSON.parse(
    Buffer.from(entries.get('assets/oliphaunt/static-registry/link-receipt.json')!.data()).toString(
      'utf8',
    ),
  );
  assert.equal(receipt.schema, 'oliphaunt-android-static-extension-link-v1');
  assert.equal(receipt.abi, spec.abi);
  assert.deepEqual(receipt.selectedExtensions, [...spec.selectedExtensions].sort());
  assert.equal(
    receipt.linkedSha256,
    createHash('sha256')
      .update(entries.get(`lib/${spec.abi}/liboliphaunt_extensions.so`)!.data())
      .digest('hex'),
    'APK static extension library differs from the actual verified link',
  );
  writeFileSync(
    spec.output,
    JSON.stringify(
      {
        schema: 'oliphaunt-expo-android-apk-proof-v1',
        abi: spec.abi,
        apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
        applicationId: 'dev.oliphaunt.reactnative.example',
        minSdk: 24,
        targetSdk: 36,
        selectedExtensions: selected,
        catalogProfile: spec.catalogProfile,
        catalogProbeSha256: createHash('sha256')
          .update(readFileSync(spec.profileProbe))
          .digest('hex'),
        bundleSha256: createHash('sha256').update(bytecode).digest('hex'),
        definedClasses: [...classes].sort(),
        nativeLibraries,
        deviceExecution: false,
      },
      null,
      2,
    ) + '\n',
  );
}

if (import.meta.main) {
  const [mode, file] = Bun.argv.slice(2);
  assert(mode && file, 'Android app action needs a mode and declared specification');
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  if (mode === 'codegen') await generateReactNativeCodegen(spec);
  else if (mode === 'project') await generateExpoAndroidProject(spec);
  else if (mode === 'bundle') await bundleExpoAndroid(spec);
  else if (mode === 'prefab') extractPrefab(spec);
  else if (mode === 'aar-native') await extractAarNative(spec);
  else if (mode === 'final-aar') await extractFinalAar(spec);
  else if (mode === 'extension-receipt') extensionLinkReceipt(spec);
  else if (mode === 'runtime-assets') await prepareAppRuntimeAssets(spec);
  else if (mode === 'jni-aar') await nativeLibrariesAar(spec);
  else if (mode === 'verify') verifyAndroidApk(spec);
  else throw new Error(`Unknown Android app action ${mode}`);
}
