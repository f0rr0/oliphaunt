/** Packaged current native core and actual Apple static carriers; no Swift SDK construction. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { buildIosCarrierManifest } from '../../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { renderExtensionProducts } from '../../../src/native/sdks/swift/tools/render-extension-products.mts';
import {
  archiveLogicalTreeRows,
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const relativeFile = (value: string) => {
  assert.equal(typeof value, 'string');
  assert.ok(value && !value.includes('\\') && !path.posix.isAbsolute(value));
  assert.ok(value.split('/').every((part) => part && part !== '.' && part !== '..'));
  return value;
};

function filesAt(input: string): string[] {
  const source = realpathSync(input);
  if (statSync(source).isFile()) return [source];
  assert.ok(statSync(source).isDirectory(), 'carrier input must be a declared file or tree');
  return readdirSync(source, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(source, entry.name);
    assert.ok(
      entry.isFile() || entry.isDirectory() || (entry.isSymbolicLink() && statSync(file).isFile()),
    );
    return filesAt(file);
  });
}

/** Relocate exact original archives; all frozen identity fields remain unchanged. */
export function stageAppleStaticLeaf(leaf: any, root: string, runtimeVersion: string) {
  assert.equal(leaf.runtimeVersion, runtimeVersion, 'static carrier holds a different native core');
  const frozen = json(leaf.frozen);
  assert.equal(frozen.product, leaf.product);
  assert.equal(frozen.version, leaf.version);
  assert.equal(frozen.releaseProduct ?? frozen.product, leaf.owner);
  assert.equal(frozen.compatibility.nativeRuntimeVersion, runtimeVersion);
  const members = frozen.extensions ?? [frozen];
  assert.deepEqual(members.map((member: any) => member.sqlName).sort(), [...leaf.sqlNames].sort());
  const actualFiles = leaf.github.flatMap(filesAt);
  const physical = new Map<string, string>(
    actualFiles.map((file: string) => [path.basename(file), file]),
  );
  assert.equal(physical.size, actualFiles.length, 'carrier archive basenames must be unique');
  mkdirSync(root, { recursive: true });
  const stageBytes = (row: any, bytes: Uint8Array, destination: string) => {
    assert.equal(path.basename(relativeFile(row.name)), row.name);
    assert.equal(bytes.length, row.bytes, `${row.name} frozen size differs`);
    assert.equal(sha256(bytes), row.sha256, `${row.name} frozen SHA-256 differs`);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    return { ...row, path: destination };
  };
  const direct = new Map<string, any>();
  for (const row of frozen.carrierAssets ?? members[0].assets) {
    assert.equal(row.family, 'native');
    assert.equal(row.target, 'ios-xcframework');
    const file = physical.get(row.name);
    assert.ok(file, `missing actual packaged carrier ${row.name}`);
    assert.ok(!direct.has(row.name), 'frozen carrier archive basenames must be unique');
    direct.set(
      row.name,
      stageBytes(row, readFileSync(file), path.join(root, 'archives', row.name)),
    );
  }
  assert.equal(direct.size, physical.size, 'actual carrier files must match frozen direct assets');
  const bundles = new Map<string, ReturnType<typeof readPortableArchiveEntries>>();
  const staged = members.map((member: any) => ({
    ...member,
    assets: member.assets.map((row: any) => {
      if (row.carrierAsset === undefined) {
        const archive = direct.get(row.name);
        assert.ok(archive, `missing direct member archive ${row.name}`);
        return { ...row, path: archive.path };
      }
      const outer = direct.get(row.carrierAsset);
      assert.ok(outer, 'member archive lacks its original aggregate carrier');
      if (!bundles.has(outer.path)) bundles.set(outer.path, readPortableArchiveEntries(outer.path));
      const name = `${relativeFile(row.carrierRoot)}/${relativeFile(row.memberPath)}`;
      const entry = bundles.get(outer.path)?.get(name);
      assert.ok(entry?.isFile, `missing original nested member ${name}`);
      return stageBytes(
        row,
        entry.data(),
        path.join(root, 'members', relativeFile(member.sqlName), row.name),
      );
    }),
  }));
  const document = frozen.extensions
    ? { ...frozen, carrierAssets: [...direct.values()], extensions: staged }
    : staged[0];
  const output = path.join(root, 'extension-artifacts.json');
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  return { output, archives: [...direct.values()] };
}

/** Maintained Apple static XCFrameworks store ar bytes inside a .framework binary. */
export function macosStaticArchive(framework: string): string {
  const files = filesAt(path.join(framework, 'macos-arm64'));
  const archives = files.filter((file) =>
    readFileSync(file).subarray(0, 8).equals(Buffer.from('!<arch>\n')),
  );
  assert.equal(
    archives.length,
    1,
    'packaged macOS static framework must contain exactly one ar library',
  );
  const archive = archives[0];
  assert.ok(archive);
  return archive;
}

export async function runAppleStaticCarrierConsumer(spec: any, root: string) {
  assert.equal(process.platform, 'darwin', 'packaged Apple execution requires genuine macOS');
  assert.equal(process.arch, 'arm64', 'packaged Apple execution requires Apple arm64');
  assert.ok(root && path.isAbsolute(root), 'Bazel must supply a private TEST_TMPDIR');
  const facts = json(spec.receipt);
  assert.equal(spec.triple, `arm64-apple-macosx${facts.deploymentTargets.package_macos}`);
  const sdkMarker = `${path.sep}sdk_macosx${path.sep}`;
  assert.ok(spec.sdkFile.includes(sdkMarker));
  const sdk = spec.sdkFile.slice(0, spec.sdkFile.indexOf(sdkMarker)) + sdkMarker.slice(0, -1);
  const products = Object.fromEntries(
    spec.leaves.map((leaf: any) => [
      leaf.product,
      {
        product: leaf.product,
        releaseProduct: leaf.owner,
        version: leaf.version,
        sqlNames: [...leaf.sqlNames].sort(),
        tag: `${leaf.owner}-v${leaf.version}`,
      },
    ]),
  );
  assert.equal(Object.keys(products).length, spec.leaves.length, 'repeated static carrier owner');
  const staged = spec.leaves.map((leaf: any, index: number) =>
    stageAppleStaticLeaf(leaf, path.join(root, `leaf-${index}`), spec.version),
  );
  const archiveInput = (file: string) => ({
    path: realpathSync(file),
    size: statSync(file).size,
    sha256: sha256(readFileSync(file)),
  });
  const carrier = buildIosCarrierManifest({
    baseRuntimeVersion: spec.version,
    baseTag: `liboliphaunt-native-v${spec.version}`,
    baseCarrierManifest: realpathSync(spec.baseManifest),
    baseArchiveInputs: {
      'base-xcframework': archiveInput(spec.base),
      'runtime-resources': archiveInput(spec.iosResources),
    },
    declaredProducts: products,
    extensionManifests: staged.map((leaf: any) => leaf.output),
  });
  const cache = path.join(root, 'cache');
  mkdirSync(path.join(cache, 'objects'), { recursive: true });
  for (const row of staged.flatMap((leaf: any) => leaf.archives))
    copyFileSync(row.path, path.join(cache, 'objects', `${row.sha256}-${row.name}`));
  const carrierFile = path.join(root, 'ios.json');
  writeFileSync(carrierFile, JSON.stringify(carrier));
  const generated = path.join(root, 'generated');
  await renderExtensionProducts([
    '--carrier',
    carrierFile,
    '--extensions',
    spec.extensions.join(','),
    '--output-dir',
    generated,
    '--cache-dir',
    cache,
    '--offline',
    '--local-binary-targets',
    '--owner-catalog',
    spec.ownerCatalog,
    '--base-package-version',
    spec.basePackageVersion,
  ]);
  const rows = (archive: string, prefix: string) =>
    archiveLogicalTreeRows(readPortableArchiveEntries(realpathSync(archive)), archive, prefix).sort(
      (left, right) => left.path.localeCompare(right.path),
    );
  assert.deepEqual(
    rows(
      spec.base,
      'liboliphaunt.xcframework/macos-arm64/liboliphaunt.framework/Resources/oliphaunt/',
    ),
    rows(spec.macosResources, 'oliphaunt/'),
    'packaged macOS resource archive differs from bundled framework resources',
  );
  const framework = path.join(root, 'liboliphaunt.xcframework');
  extractPortableArchiveTree(realpathSync(spec.base), framework, 'liboliphaunt.xcframework');
  const macos = path.join(framework, 'macos-arm64');
  const include = path.join(root, 'include');
  mkdirSync(include);
  writeFileSync(path.join(include, 'COliphaunt.h'), '#include <liboliphaunt/oliphaunt.h>\n');
  const selection = json(path.join(generated, 'extension-products.json'));
  assert.deepEqual(
    selection.selected.map((row: any) => row.sqlName).sort(),
    [...spec.extensions].sort(),
    'selected registration cohort differs',
  );
  const registrations = selection.targets.filter(
    (target: any) => target.kind === 'target' && target.name.startsWith('COliphauntExtension'),
  );
  assert.equal(
    registrations.length,
    spec.extensions.length,
    'consumer requires actual compiled static extensions',
  );
  const environment = {
    HOME: path.join(root, 'home'),
    TMPDIR: root,
    PATH: path.dirname(spec.clang),
    DEVELOPER_DIR: facts.developerDirectory,
    SDKROOT: sdk,
    DYLD_LIBRARY_PATH: '',
    DYLD_FRAMEWORK_PATH: '',
    DYLD_FALLBACK_LIBRARY_PATH: '',
    DYLD_FALLBACK_FRAMEWORK_PATH: '',
  };
  mkdirSync(environment.HOME);
  const run = (binary: string, args: string[]) => {
    const result = spawnSync(binary, args, {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${binary}: ${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const flags = ['-target', spec.triple, '-isysroot', sdk, '-F', macos, '-I', include];
  const objects: string[] = [];
  const functions: string[] = [];
  const headers: string[] = [];
  for (const target of registrations) {
    const directory = path.join(generated, target.path);
    const header = path.join(directory, 'include', `${target.name}.h`);
    const declarations = [
      ...readFileSync(header, 'utf8').matchAll(
        /const OliphauntStaticExtension \*([A-Za-z_][A-Za-z0-9_]*)\(void\);/gu,
      ),
    ];
    assert.equal(
      declarations.length,
      1,
      'registration header must expose exactly one renderer-owned descriptor',
    );
    const descriptor = declarations[0]?.[1];
    assert.ok(descriptor);
    functions.push(descriptor);
    headers.push(header);
    const object = path.join(root, `${target.name}.o`);
    run(spec.clang, [
      ...flags,
      '-std=gnu11',
      '-I',
      path.dirname(header),
      '-c',
      path.join(directory, 'registration.c'),
      '-o',
      object,
    ]);
    objects.push(object);
  }
  const main = path.join(root, 'consumer.c');
  writeFileSync(
    main,
    `${headers.map((header) => `#include ${JSON.stringify(header)}`).join('\n')}\n#include <stdio.h>\n#include <string.h>\nint main(void) {\nif (strcmp(oliphaunt_version(), ${JSON.stringify(spec.version)}) != 0) return 1;\nOliphauntStaticExtension extensions[] = { ${functions.map((name) => `*${name}()`).join(', ')} };\nif (oliphaunt_register_static_extensions(extensions, sizeof(extensions)/sizeof(extensions[0])) != 0) return 2;\nprintf("%s\\n", oliphaunt_version());\nreturn 0;\n}\n`,
  );
  const mainObject = path.join(root, 'consumer.o');
  run(spec.clang, [...flags, '-std=gnu11', '-c', main, '-o', mainObject]);
  const archives = selection.targets
    .filter((target: any) => target.kind === 'binaryTarget')
    .map((target: any) => macosStaticArchive(path.join(generated, target.path)));
  assert.ok(
    archives.length >= registrations.length,
    'generated registration lacks packaged static archives',
  );
  const executable = path.join(root, 'consumer');
  run(spec.clangxx, [
    ...flags,
    mainObject,
    ...objects,
    ...archives,
    '-framework',
    'liboliphaunt',
    `-Wl,-rpath,${macos}`,
    '-o',
    executable,
  ]);
  assert.equal(
    run(executable, []).trim(),
    spec.version,
    'actual packaged native API returned another version',
  );
  const binary = path.join(macos, 'liboliphaunt.framework', 'liboliphaunt');
  renameSync(binary, `${binary}.disabled`);
  try {
    const missing = spawnSync(executable, [], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(missing.error, undefined);
    assert.notEqual(missing.status, 0, 'consumer resolved an alternate native core');
    assert.match(missing.stderr, /liboliphaunt/iu);
    assert.match(missing.stderr, /Library not loaded|image not found|library not found/iu);
  } finally {
    renameSync(`${binary}.disabled`, binary);
  }
  console.log(
    JSON.stringify({
      runtimeVersion: spec.version,
      coreSha256: sha256(readFileSync(spec.base)),
      registeredExtensions: spec.extensions,
      construction: 'actual-packaged-core-static-final-link-and-process-registration',
      sqlExecuted: false,
    }),
  );
}

if (import.meta.main) {
  const [specFile, runfiles] = process.argv.slice(2);
  assert.equal(
    process.argv.length,
    4,
    'expected declared consumer specification and runfiles root',
  );
  assert.ok(runfiles && path.isAbsolute(runfiles));
  assert.ok(specFile);
  const spec = json(specFile);
  for (const key of [
    'base',
    'iosResources',
    'macosResources',
    'baseManifest',
    'ownerCatalog',
    'clang',
    'clangxx',
    'sdkFile',
    'receipt',
  ])
    spec[key] = path.join(runfiles, relativeFile(spec[key]));
  for (const leaf of spec.leaves) {
    leaf.frozen = path.join(runfiles, relativeFile(leaf.frozen));
    leaf.github = leaf.github.map((file: string) => path.join(runfiles, relativeFile(file)));
  }
  const root = process.env.TEST_TMPDIR;
  assert.ok(root);
  await runAppleStaticCarrierConsumer(spec, root);
}
