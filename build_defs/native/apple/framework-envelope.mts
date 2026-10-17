import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { finalizeNativeRuntimeCarrier } from '../../../src/native/runtime/tools/finalize-native-runtime-carrier.mts';
import {
  compareNativeMobileAbiReceipts,
  nativeMobileAbiReceipt,
} from '../../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { requiredRuntimeMemberPaths } from '../../../src/native/runtime/tools/native-runtime-payload.mts';
import { writeIosCarrierManifest } from '../../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { currentNativeLegalSourceBasis } from '../../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import { validateAppleXcframeworkAsset } from '../../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import {
  createDeterministicTar,
  createDeterministicZip,
} from '../../../tools/packaging/archive-directory.mts';
import {
  inspectPlatformBinaryBuffer,
  inspectPlatformBinaryTree,
} from '../../../tools/packaging/platform-binary-contract.mts';
import {
  canonicalGzipSync,
  extractPortableArchiveTree,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { APPLE_PLATFORM_COMPATIBILITY } from '../../../tools/release/platform-compatibility-policy.mts';
import { materializeInputs, privateWork, readSpecification, run } from '../../resources/shared.mts';
import { copyDeclaredTree } from '../carriers/payload.mts';

const FRAMEWORK = 'liboliphaunt.xcframework';
const INSTALL_NAME = '@rpath/liboliphaunt.framework/liboliphaunt';
const SLICES = [
  {
    target: 'macos-arm64',
    identifier: 'macos-arm64',
    platform: APPLE_PLATFORM_COMPATIBILITY.macos,
  },
  { target: 'ios-arm64', identifier: 'ios-arm64', platform: APPLE_PLATFORM_COMPATIBILITY.ios },
  {
    target: 'ios-arm64-simulator',
    identifier: 'ios-arm64-simulator',
    platform: APPLE_PLATFORM_COMPATIBILITY.iosSimulator,
  },
];

/** Admission uses the shared Mach-O parser, then requires a real dynamic library. */
export function inspectDynamicFrameworkBinary(bytes: Buffer, target: string) {
  const expected = SLICES.find((slice) => slice.target === target);
  assert(expected, `unsupported Apple framework slice ${target}`);
  const inspected = inspectPlatformBinaryBuffer(bytes, {
    target: 'ios-xcframework',
    label: target,
  });
  assert.equal(inspected.format, 'macho', 'framework binary must be Mach-O');
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'framework must be a thin arm64 Mach-O');
  assert.equal(bytes.readUInt32LE(12), 6, 'public base framework must be MH_DYLIB');
  assert.equal(inspected.slices.length, 1, 'framework must contain exactly one arm64 slice');
  assert.equal(
    inspected.slices[0].platform,
    expected.platform.id,
    'framework binary platform disagrees with its slice',
  );
  return inspected;
}

/** Public relative paths and content, never the workspace or sandbox location. */
export function runtimeContentIdentity(
  entries: Record<string, Uint8Array>,
  context: unknown,
): string {
  const hash = createHash('sha256');
  const field = (bytes: Uint8Array) => {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(size).update(bytes);
  };
  field(Buffer.from('oliphaunt-native-apple-runtime-v1'));
  field(Buffer.from(JSON.stringify(context)));
  for (const name of Object.keys(entries).sort()) {
    assert(
      name &&
        !path.isAbsolute(name) &&
        !name.includes('\\') &&
        !name.split('/').some((part) => ['', '.', '..'].includes(part)),
      'identity requires stable public relative paths',
    );
    field(Buffer.from(name));
    field(entries[name]);
  }
  return `apple-runtime-${hash.digest('hex')}`;
}

function tool(specification, name: string, args: string[], work: string): string {
  // Tool Files and their runtime closure are declared by the Mac SDK repository.
  return run(
    realpathSync(specification.tools[name]),
    args,
    { HOME: work, TMPDIR: work, LC_ALL: 'C', LANG: 'C' },
    work,
  );
}

function checkPublicAbi(specification, binary: string, target: string, work: string): void {
  inspectDynamicFrameworkBinary(readFileSync(binary), target);
  const symbols = new Set(
    tool(specification, 'nm', ['-gU', binary], work)
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).at(-1)),
  );
  const header = readFileSync(specification.publicHeader, 'utf8');
  const publicFunctions = [
    ...header.matchAll(/^OLIPHAUNT_API\s+[^;]+?\b(oliphaunt_\w+)\s*\(/gmu),
  ].map((match) => match[1]);
  assert(publicFunctions.length > 0, 'canonical public header has no API functions');
  for (const name of publicFunctions)
    assert(symbols.has(`_${name}`), `${target}: missing canonical public API ${name}`);
  if (target.startsWith('ios-')) {
    const imports = tool(specification, 'nm', ['-u', binary], work)
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).at(-1));
    assert(
      !imports.some((name) =>
        /^_(?:shmget|shmat|shmdt|shmctl|shm_open|shm_unlink|semget|semop|semctl|sem_open|sem_close|sem_unlink|sem_wait|sem_post|sem_trywait|sem_init|sem_destroy)$/u.test(
          name ?? '',
        ),
      ),
      `${target}: mobile framework imports process-global IPC`,
    );
    for (const name of [
      'dsnowball_init',
      'dsnowball_lexize',
      'pg_finfo_dsnowball_init',
      'pg_finfo_dsnowball_lexize',
      'oliphaunt_builtin_dict_snowball_Pg_magic_func',
    ])
      assert(symbols.has(`_${name}`), `${target}: missing builtin Snowball ${name}`);
  }
  const installNames = tool(specification, 'otool', ['-D', binary], work)
    .split(/\r?\n/u)
    .slice(1)
    .filter(Boolean)
    .map((line) => line.trim());
  assert.deepEqual(installNames, [INSTALL_NAME], `${target}: unexpected framework install name`);
}

function fixEmbeddedModules(specification, directory: string, work: string): void {
  for (const name of ['dict_snowball', 'plpgsql']) {
    const binary = path.join(directory, `${name}.dylib`);
    assert(lstatSync(binary).isFile(), `missing actual embedded module ${name}`);
    tool(
      specification,
      'install_name_tool',
      ['-change', '@rpath/liboliphaunt.dylib', INSTALL_NAME, binary],
      work,
    );
    const commands = tool(specification, 'otool', ['-l', binary], work);
    for (const match of commands.matchAll(
      /\bcmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset \d+\)/gu,
    )) {
      if (path.isAbsolute(match[1]))
        tool(specification, 'install_name_tool', ['-delete_rpath', match[1], binary], work);
    }
    tool(specification, 'strip', ['-S', binary], work);
    const dependencies = tool(specification, 'otool', ['-L', binary], work);
    assert(
      dependencies.includes(INSTALL_NAME),
      `${name}: embedded module does not link the public framework`,
    );
    assert(
      !dependencies.includes('@rpath/liboliphaunt.dylib '),
      `${name}: stale standalone runtime install name`,
    );
    inspectPlatformBinaryBuffer(readFileSync(binary), { target: 'ios-xcframework', label: name });
  }
}

export async function packageAppleRuntime(specification): Promise<void> {
  assert.equal(
    process.platform,
    'darwin',
    'Apple framework finalization requires the declared Mac SDK executor',
  );
  const work = privateWork(path.resolve(specification.swiftpm));
  try {
    const payload = path.join(work, 'payload');
    copyDeclaredTree(
      specification.payload,
      payload,
      requiredRuntimeMemberPaths('macos-arm64', 'runtime/bin'),
    );
    const legal = materializeInputs(specification.notices, path.join(work, 'legal'));
    const framework = path.join(work, FRAMEWORK);
    extractPortableArchiveTree(realpathSync(specification.intermediate), framework, FRAMEWORK);
    tool(specification, 'plutil', ['-convert', 'xml1', path.join(framework, 'Info.plist')], work);
    const receipts = new Map<string, Buffer>();
    const identityInputs: Record<string, Uint8Array> = {
      'runtime-payload.tar': await createDeterministicTar(payload),
      'legal-sources.tar': await createDeterministicTar(legal),
    };
    for (const slice of SLICES) {
      const directory = path.join(framework, slice.identifier, 'liboliphaunt.framework');
      const binary = path.join(directory, 'liboliphaunt');
      tool(specification, 'strip', ['-S', binary], work);
      checkPublicAbi(specification, binary, slice.target, work);
      identityInputs[`${slice.identifier}/liboliphaunt.framework/liboliphaunt`] =
        readFileSync(binary);
      identityInputs[`${slice.identifier}/liboliphaunt.framework/Headers.tar`] =
        await createDeterministicTar(path.join(directory, 'Headers'));
      const headers = materializeInputs(
        specification.headers[slice.target],
        path.join(work, 'headers', slice.target),
      );
      const receipt = Buffer.from(nativeMobileAbiReceipt(headers, slice.target));
      receipts.set(slice.target, receipt);
      identityInputs[`provenance/native-mobile-abi/${slice.target}.properties`] = receipt;
      mkdirSync(path.dirname(specification.receipts[slice.target]), { recursive: true });
      writeFileSync(specification.receipts[slice.target], receipt, { mode: 0o644 });
    }
    compareNativeMobileAbiReceipts(
      'ios-datum64',
      [...receipts].map(([target, bytes]) => ({ label: target, text: bytes.toString('utf8') })),
    );

    const macosModules = path.join(work, 'framework-modules');
    copyDeclaredTree(path.join(payload, 'lib/modules'), macosModules);
    fixEmbeddedModules(specification, macosModules, work);
    identityInputs['macos-arm64/runtime/files/lib/modules.tar'] =
      await createDeterministicTar(macosModules);

    const resources = new Map<string, string>();
    for (const domain of ['macos-arm64', 'ios-datum64']) {
      const output = path.join(work, domain);
      const identity = runtimeContentIdentity(identityInputs, {
        version: specification.version,
        domain,
        artifact: 'native-direct',
        registry: 'not-required',
      });
      run(
        realpathSync(specification.formatter),
        [
          '--output',
          output,
          '--liboliphaunt-native-version',
          specification.version,
          '--extension-target',
          domain,
          '--runtime-cache-identity',
          identity,
        ],
        {
          HOME: work,
          TMPDIR: work,
          LC_ALL: 'C',
          LANG: 'C',
          OLIPHAUNT_INSTALL_DIR: path.join(payload, 'runtime'),
          OLIPHAUNT_EMBEDDED_MODULE_DIR:
            domain === 'macos-arm64' ? macosModules : path.join(payload, 'lib/modules'),
          OLIPHAUNT_RUNTIME_CACHE_DIR: path.join(work, 'cache', domain),
        },
        work,
      );
      const root = path.join(output, 'oliphaunt');
      if (domain === 'macos-arm64') {
        copyDeclaredTree(macosModules, path.join(root, 'runtime/files/lib/modules'));
        // The embedded engine and subprocess server have distinct core modules.
        // Preserve the ordinary PostgreSQL modules alongside the framework ones.
        for (const name of ['dict_snowball', 'plpgsql'])
          copyFileSync(
            path.join(payload, 'runtime/lib/postgresql', `${name}.dylib`),
            path.join(root, 'runtime/files/lib/postgresql', `${name}.dylib`),
          );
      } else {
        const provenance = path.join(root, 'provenance/native-mobile-abi');
        mkdirSync(provenance, { recursive: true });
        for (const [target, receipt] of receipts)
          writeFileSync(path.join(provenance, `${target}.properties`), receipt, { mode: 0o644 });
      }
      finalizeNativeRuntimeCarrier(root, domain);
      resources.set(domain, root);
    }
    for (const slice of SLICES) {
      const destination = path.join(
        framework,
        slice.identifier,
        'liboliphaunt.framework/Resources/oliphaunt',
      );
      assert(
        !lstatExists(destination),
        'maintained framework must not contain a competing runtime resource tree',
      );
      const source = resources.get(slice.target === 'macos-arm64' ? 'macos-arm64' : 'ios-datum64');
      assert(source, 'missing formatted runtime resource domain');
      copyDeclaredTree(source, destination);
    }
    stageReleaseNotices(framework, { profile: 'native-runtime', sourceRoot: legal });
    assertReleaseNoticesInDirectory(framework, { profile: 'native-runtime', sourceRoot: legal });
    await inspectPlatformBinaryTree(framework, { target: 'ios-xcframework' });
    writeFileSync(
      specification.swiftpm,
      await createDeterministicZip(framework, { keepParent: true }),
      { mode: 0o644 },
    );
    await validateAppleXcframeworkAsset(specification.swiftpm);
    const archiveRoot = path.join(work, `liboliphaunt-${specification.version}-ios-xcframework`);
    mkdirSync(archiveRoot);
    copyDeclaredTree(framework, path.join(archiveRoot, FRAMEWORK));
    stageReleaseNotices(archiveRoot, { profile: 'native-runtime', sourceRoot: legal });
    writeFileSync(
      specification.archive,
      canonicalGzipSync(await createDeterministicTar(archiveRoot)),
      { mode: 0o644 },
    );
    for (const [name, domain] of [
      ['resources', 'ios-datum64'],
      ['macos_resources', 'macos-arm64'],
    ]) {
      // The macOS projection is an internal candidate-consumer input, drawn
      // from the same formatter result already embedded in its framework.
      const resourceRoot = path.join(work, `resource-archive-${domain}`);
      mkdirSync(resourceRoot);
      const source = resources.get(domain);
      assert(source, `missing formatted ${domain} runtime resources`);
      copyDeclaredTree(source, path.join(resourceRoot, 'oliphaunt'));
      stageReleaseNotices(resourceRoot, { profile: 'native-runtime-resources', sourceRoot: legal });
      writeFileSync(
        specification[name],
        canonicalGzipSync(await createDeterministicTar(resourceRoot)),
        { mode: 0o644 },
      );
    }
    for (const name of ['swiftpm', 'archive', 'resources', 'macos_resources'])
      chmodSync(specification[name], 0o644);
    writeIosCarrierManifest(specification.ios_manifest, {
      baseAssetDir: path.dirname(specification.swiftpm),
      baseRuntimeVersion: specification.version,
      baseTag: `liboliphaunt-native-v${specification.version}`,
      baseSourceBasis: currentNativeLegalSourceBasis,
      baseLegalSourceRoot: legal,
    });
    writeFileSync(
      specification.checksums,
      `${['swiftpm', 'archive', 'resources']
        .map(
          (name) =>
            `${createHash('sha256').update(readFileSync(specification[name])).digest('hex')}  ./${path.basename(specification[name])}`,
        )
        .sort()
        .join('\n')}\n`,
      { mode: 0o644 },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

if (import.meta.main) await packageAppleRuntime(readSpecification());
