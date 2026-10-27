import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadSwiftExtensionInventoryCatalog,
  validateSwiftExtensionResourceArtifact,
} from '../../../src/native/sdks/swift/tools/extension-resource-inventory.mts';
import { buildSwiftExtensionCarrierManifest } from '../../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import { expect, test } from 'bun:test';
import { inspectDynamicFrameworkBinary, runtimeContentIdentity } from './framework-envelope.mts';

// Independent minimal physical Mach-O fixture; no filename/header inference.
function image(platform: number, minimum: number, type = 6): Buffer {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(type, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(platform, 40);
  bytes.writeUInt32LE(minimum << 16, 44);
  bytes.writeUInt32LE(minimum << 16, 48);
  return bytes;
}

test('the public framework admits actual dynamic binaries for all three Apple slices', () => {
  for (const [target, platform, minimum] of [
    ['macos-arm64', 1, 14],
    ['ios-arm64', 2, 17],
    ['ios-arm64-simulator', 7, 17],
  ] as const)
    expect(inspectDynamicFrameworkBinary(image(platform, minimum), target).slices).toHaveLength(1);
});

test('a static object, swapped device/simulator image or incompatible OS floor cannot replace the public framework', () => {
  expect(() => inspectDynamicFrameworkBinary(image(2, 17, 1), 'ios-arm64')).toThrow(/MH_DYLIB/u);
  expect(() => inspectDynamicFrameworkBinary(image(7, 17), 'ios-arm64')).toThrow(
    /platform disagrees/u,
  );
  expect(() => inspectDynamicFrameworkBinary(image(2, 18), 'ios-arm64')).toThrow(/minimum/u);
  expect(() => inspectDynamicFrameworkBinary(Buffer.from('!<arch>\n'), 'ios-arm64')).toThrow();
});

test('runtime identity commits content and public names, independent of source location and entry order', () => {
  const header = Buffer.from('public ABI');
  const runtime = Buffer.from('dynamic runtime');
  const first = runtimeContentIdentity(
    { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': runtime },
    { domain: 'ios-datum64' },
  );
  expect(first).toBe(
    runtimeContentIdentity(
      { 'runtime/liboliphaunt': runtime, 'Headers/oliphaunt.h': header },
      { domain: 'ios-datum64' },
    ),
  );
  expect(first).toMatch(/^apple-runtime-[0-9a-f]{64}$/u);
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': Buffer.from('changed runtime') },
      { domain: 'ios-datum64' },
    ),
  );
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/oliphaunt.h': header, 'runtime/liboliphaunt': runtime },
      { domain: 'macos-arm64' },
    ),
  );
  expect(first).not.toBe(
    runtimeContentIdentity(
      { 'Headers/other.h': header, 'runtime/liboliphaunt': runtime },
      { domain: 'ios-datum64' },
    ),
  );
  for (const name of ['/sandbox/runtime', '../runtime', 'runtime\\file', 'runtime/./file'])
    expect(() => runtimeContentIdentity({ [name]: runtime }, {})).toThrow(/public relative paths/u);
});

test('Swift mobile carriers preserve logical closure and exact primary physical inventory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-mobile-closure-'));
  try {
    const fixtures = path.resolve(
      import.meta.dirname,
      '../../../src/native/sdks/swift/Tests/Fixtures',
    );
    const document = JSON.parse(
      await fs.readFile(path.join(fixtures, 'swiftpm-extension-selection.json'), 'utf8'),
    );
    const member = document.extensions.find((row) => row.sqlName === 'postgis');
    const canonical = (await loadSwiftExtensionInventoryCatalog()).get(member.sqlName);
    const stems = ['postgis-3', 'postgis_raster-3', 'postgis_topology-3'];
    const prefix = 'oliphaunt_static_postgis_3';
    const asset = async (file, kind, identity = null) => {
      const bytes = await fs.readFile(file);
      return {
        family: 'native',
        target: 'ios-xcframework',
        kind,
        identity,
        name: path.basename(file),
        path: path.relative(root, file),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    };
    const frameworks = [];
    // These archived fixture members test packaging and inventory, not Apple execution.
    for (const [kind, identity, bundle] of [
      [
        'ios-xcframework',
        member.nativeModuleStem,
        `liboliphaunt_extension_${member.nativeModuleStem}`,
      ],
      ...member.nativeDependencies.map(({ name }) => [
        'ios-dependency-xcframework',
        name,
        `liboliphaunt_dependency_${name}`,
      ]),
    ]) {
      const directory = path.join(root, `${bundle}.xcframework`);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'Info.plist'), '<plist><dict/></plist>\n');
      const file = path.join(root, `${bundle}.zip`);
      await archiveDirectory(directory, file, { keepParent: true });
      frameworks.push(await asset(file, kind, identity));
    }
    const archives = ['ios-device', 'ios-simulator'].map(
      (target) =>
        `${target}:mobile-static/${target}/extensions/${member.nativeModuleStem}/liboliphaunt_extension_${member.nativeModuleStem}.a`,
    );
    const dependencies = ['ios-device', 'ios-simulator'].flatMap((target) =>
      member.nativeDependencies.map(
        ({ name }) => `${target}:${name}:mobile-static/${target}/dependencies/${name}/lib${name}.a`,
      ),
    );
    for (const shape of ['full', 'primary', 'legacy']) {
      const directory = path.join(root, shape);
      const resources = path.join(directory, 'resources');
      await fs.cp(path.join(fixtures, member.resourceRoot), resources, {
        recursive: true,
        dereference: true,
      });
      for (const name of ['', ...(await fs.readdir(resources, { recursive: true }))]) {
        const file = path.join(resources, name);
        await fs.chmod(file, (await fs.stat(file)).isDirectory() ? 0o755 : 0o644);
      }
      const metadata = { ...member };
      metadata.nativeModuleStems = shape === 'full' ? stems : member.nativeModuleStems;
      let properties = await fs.readFile(path.join(resources, 'manifest.properties'), 'utf8');
      properties = properties.replace(
        'nativeModuleStems=postgis-3\n',
        `nativeModuleStems=${metadata.nativeModuleStems.join(',')}\n`,
      );
      if (shape === 'legacy') {
        delete metadata.sqlMembers;
        delete metadata.nativeModuleStems;
        properties = properties.replace(/^sqlMembers=.*\n|^nativeModuleStems=.*\n/gmu, '');
        const sql = path.join(resources, 'files/share/postgresql/extension');
        for (const name of await fs.readdir(sql)) {
          if (
            member.sqlMembers.some(
              (owned) =>
                owned !== member.sqlName &&
                (name === `${owned}.control` || name.startsWith(`${owned}--`)),
            )
          )
            await fs.rm(path.join(sql, name));
        }
      }
      properties = properties
        .replace('mobileStaticArchives=\n', `mobileStaticArchives=${archives.join(',')}\n`)
        .replace(
          'mobileStaticDependencyArchives=\n',
          `mobileStaticDependencyArchives=${dependencies.join(',')}\n`,
        );
      await fs.writeFile(path.join(resources, 'manifest.properties'), properties);
      for (const row of [...archives, ...dependencies]) {
        const file = path.join(resources, row.slice(row.lastIndexOf(':') + 1));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '!<arch>\n');
      }
      const runtime = path.join(directory, 'runtime.tar.gz');
      await archiveDirectory(resources, runtime);
      const file = path.join(directory, 'extension-artifacts.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          ...metadata,
          schema: 'oliphaunt-extension-ci-artifacts-v1',
          compatibility: {
            postgresMajor: '18',
            extensionRuntimeContract: 'src/extensions/contracts/contract.toml',
            nativeRuntimeProduct: document.nativeRuntime.product,
            nativeRuntimeVersion: document.nativeRuntime.version,
            wasixRuntimeProduct: 'liboliphaunt-wasix',
            wasixRuntimeVersion: '0.1.0',
          },
          iosNativeDependencies: member.nativeDependencies.map(({ name }) => name),
          iosRegistration: {
            schema: 'oliphaunt-ios-extension-registration-v1',
            sqlName: member.sqlName,
            nativeModuleStem: member.nativeModuleStem,
            magicSymbol: `${prefix}_Pg_magic_func`,
            initSymbol: `${prefix}__PG_init`,
            symbols: member.registration.symbols,
          },
          assets: [...frameworks, await asset(runtime, 'runtime')],
        }),
      );
      const carrier = buildSwiftExtensionCarrierManifest({
        extensionManifest: file,
        assetRoot: root,
        nativeRuntimeVersion: document.nativeRuntime.version,
        baseTag: `liboliphaunt-native-v${document.nativeRuntime.version}`,
        declaredProducts: {
          [member.product]: {
            product: member.product,
            releaseProduct: member.releaseProduct,
            version: member.version,
            sqlNames: [member.sqlName],
            tag: `${member.releaseProduct}-v${member.version}`,
          },
          'oliphaunt-extension-contrib-pg18': {
            product: 'oliphaunt-extension-contrib-pg18',
            releaseProduct: 'liboliphaunt-native',
            version: document.nativeRuntime.version,
            sqlNames: member.dependencies,
            tag: `liboliphaunt-native-v${document.nativeRuntime.version}`,
          },
        },
      });
      const generated = carrier.entries[0].extension;
      if (shape === 'legacy') {
        expect(Object.hasOwn(generated, 'sqlMembers')).toBeFalse();
        expect(Object.hasOwn(generated, 'nativeModuleStems')).toBeFalse();
      } else expect(generated.nativeModuleStems).toEqual(metadata.nativeModuleStems);
      const consumed = path.join(directory, 'consumed');
      extractPortableArchiveTree(runtime, consumed);
      const extension = {
        ...generated,
        resourceRoot: consumed,
        nativeDependencies: member.nativeDependencies,
        registration: member.registration,
      };
      const validate = (selected = extension) =>
        validateSwiftExtensionResourceArtifact({
          extension: selected,
          canonical,
          nativeRuntime: document.nativeRuntime,
          allowMobileCarrierArchives: true,
        });
      await validate();
      expect(await fs.readdir(path.join(consumed, 'files/lib/postgresql'))).toEqual([
        'postgis-3.dylib',
      ]);
      if (shape === 'full') {
        await expect(
          validate({ ...extension, nativeModuleStems: member.nativeModuleStems }),
        ).rejects.toThrow(/manifest nativeModuleStems/u);
        const extra = path.join(consumed, 'files/lib/postgresql/postgis_raster-3.dylib');
        await fs.writeFile(extra, 'undeclared companion');
        await expect(validate()).rejects.toThrow(/leaf inventory mismatch/u);
        await fs.rm(extra);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
