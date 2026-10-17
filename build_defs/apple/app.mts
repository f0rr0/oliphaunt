import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mobileBundleEnvironment, type NodeInputs, stageNodeInputs } from '../android/app.mts';

type IosSpec = NodeInputs & {
  targetName: string;
  expectedModules: Record<string, string>;
  outputs: Record<string, string>;
  autolinking: string;
  constantsConfig: string;
  swiftSdkVersion: string;
};
function put(file: string, contents: Buffer | string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
function invoke(
  inputs: NodeInputs,
  script: string,
  args: string[],
  root: string,
  environment: Record<string, string> = {},
) {
  return execFileSync(realpathSync(inputs.node), [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      PATH: path.dirname(realpathSync(inputs.node)),
      CI: '1',
      NODE_ENV: 'production',
      EXPO_OFFLINE: '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_NO_GIT_STATUS: '1',
      ...environment,
    },
  });
}
function scratch<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-ios-app-'));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function files(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) result.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  walk(root);
  return result.sort();
}
export function assertIosAutolinking(resolved: any, expectedModules: Record<string, string>) {
  assert.deepEqual(
    resolved.extraDependencies,
    [],
    'Declare new Expo Apple dependencies in the app construction graph',
  );
  assert.deepEqual(
    resolved.coreFeatures,
    [],
    'Declare new Expo Apple features in the app construction graph',
  );
  assert.equal(
    new Set(resolved.modules.map((row: any) => row.packageName)).size,
    resolved.modules.length,
    'Actual Expo Apple modules must occur exactly once',
  );
  assert.deepEqual(
    Object.fromEntries(resolved.modules.map((row: any) => [row.packageName, row.packageVersion])),
    expectedModules,
    'Actual Expo Apple autolinking differs from the declared native source closure',
  );
  for (const row of resolved.modules) {
    assert(row.pods.length && row.swiftModuleNames.length);
    assert.equal(
      row.debugOnly,
      ['expo-dev-launcher', 'expo-dev-menu'].includes(row.packageName),
      'The release graph must explicitly model changed Expo debug module conditions',
    );
  }
}
export function projectExpoIos(spec: IosSpec) {
  return scratch((root) => {
    const stores = stageNodeInputs(root, spec);
    const expo = stores[spec.roots.expo];
    const rn = stores[spec.roots['react-native']];
    const sdk = stores[spec.roots['@oliphaunt/react-native']];
    assert(expo && rn, 'The Apple app needs its declared Expo and React Native sources');
    assert(sdk, 'Compile the genuine delivered React Native SDK sources');
    const sdkManifest = JSON.parse(readFileSync(path.join(sdk, 'package.json'), 'utf8'));
    assert.equal(
      sdkManifest.oliphaunt.swiftSdkVersion,
      spec.swiftSdkVersion,
      'Retain the actual SDK conventional Swift requirement',
    );
    console.log(
      invoke(
        spec,
        path.join(expo, 'bin/cli'),
        [
          'prebuild',
          '--platform',
          'ios',
          '--no-install',
          '--template',
          path.join(expo, 'template.tgz'),
        ],
        root,
      ),
    );
    const resolved = JSON.parse(
      invoke(
        spec,
        path.join(expo, 'bin/autolinking'),
        ['resolve', '--platform', 'apple', '--json'],
        root,
      ),
    );
    assertIosAutolinking(resolved, spec.expectedModules);
    const propertiesFile = path.join(root, 'ios/Podfile.properties.json');
    const properties = JSON.parse(readFileSync(propertiesFile, 'utf8'));
    assert.equal(properties['expo.jsEngine'], 'hermes');
    assert(
      !Object.keys(properties).some((key) => key.startsWith('expo.sqlite.')),
      'Declare the changed SQLite source/compiler profile in the Apple graph',
    );
    const app = path.join(root, 'ios', spec.targetName);
    const entitlements = readFileSync(path.join(app, spec.targetName + '.entitlements'), 'utf8');
    assert(
      entitlements.includes('<dict/>') && !entitlements.includes('<key>'),
      'Nonempty application entitlements require declared plist-tool consumption by the original Expo generator',
    );
    const generated = path.join(root, 'generated');
    mkdirSync(generated);
    console.log(
      invoke(
        spec,
        path.join(expo, 'bin/autolinking'),
        [
          'generate-modules-provider',
          '--platform',
          'apple',
          '--target',
          path.join(generated, 'ExpoModulesProvider.swift'),
          '--target-name',
          spec.targetName,
          '--app-root',
          root,
          '--podfile-properties-file-path',
          propertiesFile,
          '--packages',
          ...resolved.modules.map((row: any) => row.packageName),
        ],
        root,
      ),
    );
    console.log(
      invoke(
        spec,
        path.join(rn, 'scripts/generate-codegen-artifacts.js'),
        ['-p', root, '-t', 'ios', '-o', path.join(generated, 'codegen')],
        root,
      ),
    );
    const constantsId = Object.keys(spec.packages).find(
      (id) => spec.packages[id].package === 'expo-constants',
    );
    assert(constantsId);
    const configDirectory = path.join(generated, 'constants');
    mkdirSync(configDirectory);
    console.log(
      invoke(
        spec,
        path.join(stores[constantsId], 'scripts/getAppConfig.js'),
        [root, configDirectory],
        root,
      ),
    );
    put(spec.constantsConfig, readFileSync(path.join(configDirectory, 'app.config')));
    const codegen = path.join(generated, 'codegen/build/generated/ios');
    const actualCode = files(codegen).filter((name) => /\.(?:h|mm|cpp)$/u.test(name));
    const expectedCode = Object.keys(spec.outputs)
      .filter((name) => name.startsWith('codegen/'))
      .map((name) => name.slice(8))
      .sort();
    assert.deepEqual(
      actualCode,
      expectedCode,
      'Declare the original React Native generator output changes before compilation',
    );
    for (const [relative, output] of Object.entries(spec.outputs)) {
      assert(
        !path.isAbsolute(relative) &&
          relative.split('/').every((part) => part && part !== '.' && part !== '..'),
      );
      const source =
        relative === 'ExpoModulesProvider.swift'
          ? path.join(generated, relative)
          : relative.startsWith('app/')
            ? path.join(app, relative.slice(4))
            : relative.startsWith('sdk/')
              ? path.join(sdk, relative.slice(4))
              : relative.startsWith('codegen/')
                ? path.join(codegen, relative.slice(8))
                : null;
      assert(
        source && existsSync(source),
        'Original Expo/RN generation did not produce ' + relative,
      );
      mkdirSync(path.dirname(output), { recursive: true });
      if (relative.endsWith('.xcassets') || relative.endsWith('.icon'))
        cpSync(source, output, { recursive: true });
      else copyFileSync(source, output);
    }
    // The release app preserves the generator's plist, with the original default Metro port.
    const plistOutput = spec.outputs['app/Info.plist'];
    if (plistOutput)
      put(plistOutput, readFileSync(plistOutput, 'utf8').replaceAll('$(RCT_METRO_PORT)', '8081'));
    const normalized = JSON.stringify(resolved, null, 2).replaceAll(root + '/', '');
    put(spec.autolinking, normalized + '\n');
  });
}
export function bundleExpoIos(
  spec: NodeInputs & {
    entry: string;
    bundle: string;
    resources: string;
    sourceMap: string;
    environment?: Record<string, string>;
    selectedExtensions: string[];
    catalogProfile: string;
    profileProbe: string;
  },
) {
  return scratch((root) => {
    const stores = stageNodeInputs(root, spec);
    const expo = stores[spec.roots.expo];
    const rnRow = spec.packages[spec.roots['react-native']];
    const hermesId = rnRow.dependencies['hermes-compiler'];
    assert(expo && hermesId, 'The release app needs the locked original Hermes compiler');
    assert.equal(spec.packages[hermesId].package, 'hermes-compiler');
    const rn = stores[spec.roots['react-native']];
    const rnManifest = JSON.parse(readFileSync(path.join(rn, 'package.json'), 'utf8'));
    assert.equal(
      spec.packages[hermesId].version,
      rnManifest.dependencies['hermes-compiler'],
      'Use the exact RN-declared compiler',
    );
    const host =
      process.platform === 'darwin'
        ? 'osx-bin'
        : process.platform === 'linux'
          ? 'linux64-bin'
          : null;
    assert(host, 'The declared Apple bundling executor must support the original Hermes compiler');
    const compiler = path.join(stores[hermesId], 'hermesc', host, 'hermesc');
    assert(existsSync(compiler));
    chmodSync(compiler, 0o755);
    const js = path.join(root, 'main.jsbundle'),
      assets = path.join(root, 'bundle-assets');
    const map = path.join(root, 'main.jsbundle.map');
    console.log(
      invoke(
        spec,
        path.join(expo, 'bin/cli'),
        [
          'export:embed',
          '--platform',
          'ios',
          '--dev',
          'false',
          '--entry-file',
          spec.entry,
          '--bundle-output',
          js,
          '--assets-dest',
          assets,
          '--sourcemap-output',
          map,
        ],
        root,
        {
          ...mobileBundleEnvironment(
            spec.environment ?? {},
            spec.selectedExtensions,
            spec.catalogProfile,
            spec.profileProbe,
          ),
          TMPDIR: root,
        },
      ),
    );
    const hbc = path.join(root, 'main.hbc');
    execFileSync(
      compiler,
      ['-w', '-O', '-emit-binary', '-out', path.basename(hbc), path.basename(js)],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    const bytes = readFileSync(hbc);
    assert.equal(
      bytes.subarray(0, 8).toString('hex'),
      'c61fbc03c103191f',
      'The app must contain actual Hermes bytecode',
    );
    put(spec.bundle, bytes);
    put(spec.sourceMap, readFileSync(map));
    mkdirSync(spec.resources, { recursive: true });
    if (existsSync(assets)) cpSync(assets, spec.resources, { recursive: true });
  });
}
if (import.meta.main) {
  const [operation, file] = process.argv.slice(2);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  if (operation === 'project') projectExpoIos(spec);
  else if (operation === 'bundle') bundleExpoIos(spec);
  else throw new Error('Unsupported Apple app operation ' + operation);
}
