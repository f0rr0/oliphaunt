import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SWIFT_SOURCE_FIXTURE_PREFIX,
  validateSwiftSourceFixtureEntries,
} from '../../../src/native/sdks/swift/tools/swift-source-fixture-contract.mts';
import { readNativeAppleHeader } from '../../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { zipArchive } from '../../../tools/packaging/testdata/zip-fixture.mts';
import { copyDeclaredTree } from '../../native/carriers/payload.mts';
import {
  assertSwiftSourceDeliveryParity,
  readSwiftSourceTagMembers,
} from './source-delivery-contract.mts';
import { fixture } from './source-package.fixture.mts';
import { packageSwiftSource, verifyFrozenNativeArchives } from './source-package.mts';

test('a held native header cannot be replaced by another slice or an incomplete framework', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'selected-native-header-'));
  try {
    const file = path.join(root, 'native.zip');
    const rows = ['macos-arm64', 'ios-arm64', 'ios-arm64-simulator'].map((slice) => ({
      name: `liboliphaunt.xcframework/${slice}/liboliphaunt.framework/Headers/oliphaunt.h`,
      data: Buffer.from('original selected ABI header'),
    }));
    writeFileSync(file, zipArchive(rows));
    expect(readNativeAppleHeader(file)).toEqual(rows[0].data);
    writeFileSync(file, zipArchive(rows.slice(1)));
    expect(() => readNativeAppleHeader(file)).toThrow(/all public C headers/);
    writeFileSync(
      file,
      zipArchive([...rows.slice(0, 2), { ...rows[2], data: Buffer.from('another ABI header') }]),
    );
    expect(() => readNativeAppleHeader(file)).toThrow(/different public C headers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('final source envelope preserves held native version, exact source-tag paths and portable package paths', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-swift-source-'));
  try {
    const spec = await fixture(scratch);
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    await packageSwiftSource(path.relative(process.cwd(), first), spec);
    await packageSwiftSource(second, spec);
    expect(
      readFileSync(path.join(first, 'Oliphaunt-source.zip')).equals(
        readFileSync(path.join(second, 'Oliphaunt-source.zip')),
      ),
    ).toBeTrue();
    const manifest = readFileSync(path.join(first, 'Package.swift.release'), 'utf8');
    expect(manifest).toContain('liboliphaunt-native-v0.3.3');
    expect(manifest).toContain('oliphaunt-swift-v9.8.7');
    expect(readFileSync(path.join(first, 'release-tree/Package.swift'), 'utf8')).toBe(manifest);
    expect(
      readFileSync(path.join(first, 'release-tree/src/sdks/swift/VERSION'), 'utf8').trim(),
    ).toBe(spec.version);
    expect(
      readFileSync(
        path.join(first, 'release-tree/src/sdks/swift/LIBOLIPHAUNT_VERSION'),
        'utf8',
      ).trim(),
    ).toBe(spec.nativeVersion);
    expect(
      readFileSync(
        path.join(
          first,
          'release-tree/src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
        ),
      ).equals(readFileSync(spec.carrier)),
    ).toBeTrue();
    const entries = readPortableArchiveEntries(path.join(first, 'Oliphaunt-source.zip'));
    const fixtures = new Map(
      Object.entries(spec.sources)
        .filter(([member]) => `package/${member}`.startsWith(SWIFT_SOURCE_FIXTURE_PREFIX))
        .map(([member, file]) => [`package/${member}`, readFileSync(file)]),
    );
    const [fixtureName] = fixtures.keys();
    assert(fixtureName);
    const fixtureEntry = entries.get(fixtureName);
    assert(fixtureEntry?.isFile);
    for (const [fault, message] of [
      ['missing', 'file set must exactly match'],
      ['extra', 'file set must exactly match'],
      ['tampered', 'must byte-for-byte match'],
    ]) {
      const changed = new Map(entries);
      if (fault === 'missing') changed.delete(fixtureName);
      else
        changed.set(
          fault === 'extra' ? `${SWIFT_SOURCE_FIXTURE_PREFIX}extra.control` : fixtureName,
          {
            ...fixtureEntry,
            data: () => Buffer.from('changed fixture'),
          },
        );
      expect(() => validateSwiftSourceFixtureEntries('changed.zip', changed, fixtures)).toThrow(
        message,
      );
    }
    const tree = path.join(first, 'release-tree');
    const treeManifest = readFileSync(path.join(tree, 'Package.swift'));
    // This is the publisher's Git100644 fixture, not a claim about NTFS
    // permission bits. Exact physical-tree modes are checked separately below.
    const declaredTagMembers = readSwiftSourceTagMembers(tree).map((row) =>
      row.type === 'file' ? { ...row, mode: 0o644 } : row,
    );
    const archiveParity = (archive: string) =>
      assertSwiftSourceDeliveryParity(archive, declaredTagMembers, treeManifest);
    archiveParity(path.join(first, 'Oliphaunt-source.zip'));
    const zipRows = [...entries].map(([name, entry]) => {
      expect(entry.mode & 0o777).toBe(entry.isDirectory ? 0o755 : 0o644);
      return {
        name: entry.isDirectory ? `${name}/` : name,
        data: entry.isFile ? Buffer.from(entry.data()) : Buffer.alloc(0),
        externalAttributes:
          ((entry.isDirectory ? 0o40755 : 0o100644) << 16) | (entry.isDirectory ? 0x10 : 0),
      };
    });
    const corruptArchive = path.join(scratch, 'source-fault.zip');
    writeFileSync(corruptArchive, zipArchive(zipRows));
    archiveParity(corruptArchive);
    const sharedMember = 'package/Sources/Oliphaunt/Oliphaunt.swift';
    for (const [rows, message] of [
      [zipRows.filter(({ name }) => name !== sharedMember), 'shared delivered members differ'],
      [
        zipRows.map((row) =>
          row.name === sharedMember
            ? { ...row, data: Buffer.from('// ZIP-only source edit\n') }
            : row,
        ),
        'shared delivered members differ',
      ],
      [
        [
          ...zipRows,
          {
            name: 'package/Sources/Oliphaunt/extra.swift',
            data: Buffer.from('// ZIP-only extra source\n'),
            externalAttributes: 0o100644 << 16,
          },
        ],
        'shared delivered members differ',
      ],
      [
        zipRows.map((row) =>
          row.name === 'package/Package.swift'
            ? {
                ...row,
                data: Buffer.concat([row.data, Buffer.from('// ZIP-only manifest edit\n')]),
              }
            : row,
        ),
        'manifest differs beyond the canonical source path rewrite',
      ],
    ] as const) {
      writeFileSync(corruptArchive, zipArchive(rows));
      expect(() => archiveParity(corruptArchive)).toThrow(message);
    }
    for (const member of [sharedMember, 'package/Package.swift']) {
      writeFileSync(
        corruptArchive,
        zipArchive(
          zipRows.map((row) =>
            row.name === member ? { ...row, externalAttributes: 0o100755 << 16 } : row,
          ),
        ),
      );
      expect(() => archiveParity(corruptArchive)).toThrow(
        member.endsWith('/Package.swift')
          ? 'manifest mode differs'
          : 'shared delivered members differ',
      );
    }
    for (const [name, message] of [
      ['package/../escape', 'unsafe archive member'],
      ['/escape', 'unsafe archive member'],
      ['C:/escape', 'unsafe archive member'],
      ['package\\escape', 'unsafe archive member'],
      ['package/Sources/CON.swift', 'non-portable archive member'],
      ['package/Sources/file.swift:stream', 'non-portable archive member'],
    ]) {
      writeFileSync(corruptArchive, zipArchive([...zipRows, { name, data: 'unsafe member' }]));
      expect(() => archiveParity(corruptArchive)).toThrow(message);
    }
    for (const mode of [0o120777, 0o10644]) {
      writeFileSync(
        corruptArchive,
        zipArchive(
          zipRows.map((row) =>
            row.name === sharedMember
              ? { ...row, data: Buffer.from('../outside'), externalAttributes: mode << 16 }
              : row,
          ),
        ),
      );
      expect(() => archiveParity(corruptArchive)).toThrow('link or special ZIP entry');
    }
    // Windows chmod/stat cannot establish a POSIX source-tree mode contract,
    // and file symlink creation may require privileges. Encoded ZIP faults
    // above cover both contracts portably without weakening the public reader.
    if (process.platform !== 'win32') {
      const declaredTree = 'first/release-tree';
      const runfilesTree = path.join(scratch, 'runfiles/_main', declaredTree);
      for (const row of readSwiftSourceTagMembers(tree)) {
        const destination = path.join(runfilesTree, row.path);
        if (row.type === 'directory') mkdirSync(destination, { recursive: true });
        else {
          mkdirSync(path.dirname(destination), { recursive: true });
          chmodSync(path.join(tree, row.path), 0o555);
          symlinkSync(path.join(tree, row.path), destination);
        }
      }
      expect(() => readSwiftSourceTagMembers(runfilesTree)).toThrow('regular members');
      const stagedTree = path.join(scratch, 'staged-source-tag');
      copyDeclaredTree(runfilesTree, stagedTree, [], declaredTree);
      assertSwiftSourceDeliveryParity(
        path.join(first, 'Oliphaunt-source.zip'),
        readSwiftSourceTagMembers(stagedTree),
        readFileSync(path.join(stagedTree, 'Package.swift')),
      );
      for (const row of readSwiftSourceTagMembers(stagedTree))
        if (row.type === 'file') chmodSync(path.join(tree, row.path), 0o644);
      const parity = () =>
        assertSwiftSourceDeliveryParity(
          path.join(first, 'Oliphaunt-source.zip'),
          readSwiftSourceTagMembers(tree),
          readFileSync(path.join(tree, 'Package.swift')),
        );
      parity();
      const member = path.join(tree, 'src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift');
      const original = readFileSync(member);
      for (const fault of ['removed', 'changed', 'extra', 'mode', 'symlink']) {
        const extra = path.join(tree, 'src/sdks/swift/Sources/Oliphaunt/extra.swift');
        if (fault === 'removed') rmSync(member);
        if (fault === 'changed') writeFileSync(member, '// only source tag changed\n');
        if (fault === 'extra') writeFileSync(extra, '// extra source tag member\n');
        if (fault === 'mode') chmodSync(member, 0o755);
        if (fault === 'symlink') {
          rmSync(member);
          symlinkSync(spec.generatedSwift, member);
        }
        expect(parity).toThrow();
        rmSync(extra, { force: true });
        rmSync(member, { force: true });
        writeFileSync(member, original, { mode: 0o644 });
      }
      parity();
      const tagManifest = path.join(tree, 'Package.swift');
      const manifestBytes = readFileSync(tagManifest);
      writeFileSync(
        tagManifest,
        Buffer.concat([manifestBytes, Buffer.from('// tree-only edit\n')]),
      );
      expect(parity).toThrow('manifest differs beyond the canonical source path rewrite');
      writeFileSync(tagManifest, manifestBytes);
      chmodSync(tagManifest, 0o755);
      expect(parity).toThrow('manifest mode differs');
      chmodSync(tagManifest, 0o644);
      parity();
    }
    const content = (member: string) => {
      const entry = entries.get(member);
      assert.ok(entry?.isFile, `Missing ${member}`);
      return Buffer.from(entry.data());
    };
    expect(content('package/Package.swift').toString()).toContain('path: "Sources/Oliphaunt"');
    expect(
      content('package/Sources/OliphauntNativeBindings/OliphauntNativeBindings.swift').toString(),
    ).toBe('// generated fixture\n');
    expect(entries.has('package/Tests/test.swift')).toBeTrue();
    expect(
      entries.has(
        'package/Tests/Fixtures/swiftpm-extension-resources/runtime/files/share/postgresql/extension/fixture.control',
      ),
    ).toBeTrue();
    expect(entries.has('package/Templates/OliphauntBroker/Info.plist')).toBeTrue();
    expect(content('package/Sources/COliphaunt/include/oliphaunt.h').toString()).toBe(
      '// genuine held native fixture header\n',
    );
    expect(
      content('package/Sources/COliphaunt/include/oliphaunt.h').equals(
        readFileSync('src/native/runtime/include/oliphaunt.h'),
      ),
    ).toBeFalse();
    for (const name of [
      'extension-resource-inventory.mjs',
      'render-extension-products.mjs',
      'swift-carrier-resolver.mjs',
      'extension-owner-catalog.json',
    ])
      expect(readFileSync(path.join(first, 'extension-generator', name)).length).toBeGreaterThan(0);
    expect(() => verifyFrozenNativeArchives({ ...spec, nativeVersion: '0.3.4' })).toThrow(
      'must match',
    );
    await expect(
      packageSwiftSource(path.join(scratch, 'mismatch'), { ...spec, version: '9.8.8' }),
    ).rejects.toThrow('owner version');
    await expect(
      packageSwiftSource(path.join(scratch, 'escape'), {
        ...spec,
        sources: { ...spec.sources, '../escape': spec.generatedSwift },
      }),
    ).rejects.toThrow('Unsafe Swift source');
    await expect(
      packageSwiftSource(path.join(scratch, 'runtime-payload'), {
        ...spec,
        sources: {
          ...spec.sources,
          'Sources/Oliphaunt/Resources/runtime/files/share/postgresql/extension/pgtap.control':
            spec.generatedSwift,
        },
      }),
    ).rejects.toThrow('must not include runtime/extension payload');
    for (const member of [
      'Package.swift',
      'VERSION',
      'LIBOLIPHAUNT_VERSION',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'README.md',
    ]) {
      const sources = { ...spec.sources };
      delete sources[member];
      await expect(
        packageSwiftSource(path.join(scratch, `missing-${member}`), { ...spec, sources }),
      ).rejects.toThrow(`omitted ${member}`);
    }
    const corrupted = path.join(scratch, 'corrupt.zip');
    writeFileSync(corrupted, 'corrupt\n');
    expect(() => verifyFrozenNativeArchives({ ...spec, xcframework: corrupted })).toThrow(
      'size differs',
    );
    const executableLegal = await fixture(path.join(scratch, 'executable-legal'), 0o755);
    expect(() => verifyFrozenNativeArchives(executableLegal)).toThrow('must have mode 0644');
    // Even an updated envelope hash cannot hide a changed frozen legal locator.
    const changed = JSON.parse(readFileSync(spec.carrier, 'utf8'));
    changed.legal.base[0].files[0].sha256 = '0'.repeat(64);
    writeFileSync(spec.carrier, JSON.stringify(changed));
    expect(() => verifyFrozenNativeArchives(spec)).toThrow('SHA-256 differs');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'installed Swift consumer isolates its home and supplies the native suite its installed runtime',
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'swift-consumer-signing-'));
    try {
      const spec = await fixture(path.join(scratch, 'inputs'));
      const nativeTests = path.join(scratch, 'NativeRuntimeTests.swift');
      writeFileSync(nativeTests, 'import Testing\n');
      spec.sources['Tests/OliphauntTests/NativeRuntimeTests.swift'] = nativeTests;
      const packaged = path.join(scratch, 'packaged');
      await packageSwiftSource(packaged, spec);
      const sdk = path.join(scratch, 'declared-sdk');
      const bin = path.join(sdk, 'toolchain/bin');
      const tools = path.join(sdk, 'tools');
      mkdirSync(bin, { recursive: true });
      mkdirSync(tools);
      for (const name of ['codesign', 'codesign_allocate'])
        symlinkSync(process.execPath, path.join(tools, name));
      const sdkFile = path.join(sdk, 'sdk_macosx/usr/include/fixture.h');
      mkdirSync(path.dirname(sdkFile), { recursive: true });
      writeFileSync(sdkFile, '// declared SDK fixture\n');
      const receipt = path.join(sdk, 'receipt.json');
      writeFileSync(
        receipt,
        JSON.stringify({
          developerDirectory: '/declared/developer',
          deploymentTargets: { package_macos: '13.0' },
        }),
      );
      const trace = path.join(scratch, 'swiftpm-phases');
      const runRoot = path.join(scratch, 'test-root');
      mkdirSync(runRoot);
      const installedRuntime = path.join(
        runRoot,
        'build/debug/liboliphaunt.framework/Resources/oliphaunt/runtime/files',
      );
      const checkHome = `assert.equal(process.env.HOME, ${JSON.stringify(path.join(runRoot, 'home'))});
assert.equal(process.env.CFFIXED_USER_HOME, process.env.HOME, 'Foundation must use the private test home');`;
      const checkDefaultRuntime = `assert.equal(process.env.OLIPHAUNT_INSTALL_DIR, undefined, 'default resource discovery must remain under test');
assert.equal(process.env.OLIPHAUNT_RUNTIME_DIR, undefined);
assert.equal(process.env.OLIPHAUNT_INITDB, undefined);`;
      const installedConsumer = `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
${checkHome}
${checkDefaultRuntime}
appendFileSync(${JSON.stringify(trace)}, process.argv[2] + '\\n');
console.log('installed-swift-' + process.argv[2] + '-42');
`;
      const executable = path.join(bin, 'swift');
      // These tool fixtures exercise the real consumer runner and child PATH;
      // they are not Swift compilation or macOS signing evidence.
      writeFileSync(
        executable,
        '#!' +
          process.execPath +
          '\n' +
          `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
${checkHome}
const args = process.argv.slice(2);
const signing = spawnSync('codesign', ['--version'], { env: process.env, encoding: 'utf8' });
assert.equal(signing.error, undefined, 'captured codesign must resolve from the consumer PATH');
assert.equal(signing.status, 0);
assert.equal(process.env.CODESIGN_ALLOCATE, ${JSON.stringify(path.join(tools, 'codesign_allocate'))});
assert.equal(spawnSync(process.env.CODESIGN_ALLOCATE, ['--version'], { env: process.env }).status, 0);
assert.equal(process.env.SWIFTPM_CUSTOM_BIN_DIR, ${JSON.stringify(bin)});
appendFileSync(${JSON.stringify(trace)}, args[0] + '\\n');
if (args[0] === 'build') {
  ${checkDefaultRuntime}
  const build = args[args.indexOf('--scratch-path') + 1];
  mkdirSync(path.join(build, 'debug'), { recursive: true });
  writeFileSync(path.join(build, 'debug/InstalledConsumer'), ${JSON.stringify(installedConsumer)}, { mode: 0o755 });
  mkdirSync(${JSON.stringify(installedRuntime)}, { recursive: true });
  writeFileSync(path.join(${JSON.stringify(installedRuntime)}, '../manifest.properties'), 'installed framework runtime fixture');
} else {
  assert.equal(args[0], 'test');
  assert(args.includes('--disable-xctest'));
  assert.equal(args[args.indexOf('--filter') + 1], 'NativeRuntimeTests');
  assert.equal(process.env.OLIPHAUNT_SWIFT_REQUIRE_NATIVE, '1');
  assert.equal(process.env.OLIPHAUNT_INSTALL_DIR, ${JSON.stringify(installedRuntime)}, 'the native suite must use its installed framework runtime');
  assert.equal(readFileSync(path.join(process.env.OLIPHAUNT_INSTALL_DIR, '../manifest.properties'), 'utf8'), 'installed framework runtime fixture');
  console.log('Test run with 1 test passed');
}
`,
        { mode: 0o755 },
      );
      const preload = path.join(scratch, 'darwin-fixture.mts');
      writeFileSync(
        preload,
        "Object.defineProperty(process, 'platform', { value: 'darwin' });\nObject.defineProperty(process, 'arch', { value: 'arm64' });\n",
      );
      const sourceTree = path.join(packaged, 'release-tree');
      const result = spawnSync(
        process.execPath,
        [
          '--no-install',
          '--no-env-file',
          '--preload',
          preload,
          path.join(import.meta.dir, 'consumer-test.mts'),
          path.join(packaged, 'Oliphaunt-source.zip'),
          spec.xcframework,
          spec.bindingsArchive,
          nativeTests,
          executable,
          path.join(bin, 'swiftc'),
          path.join(bin, 'clang'),
          path.join(bin, 'clang++'),
          sdkFile,
          receipt,
          'arm64-apple-macosx13.0',
          sourceTree,
          sourceTree,
        ],
        { env: { TEST_TMPDIR: runRoot }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(trace, 'utf8')).toBe('build\ncreate\nreopen\ntest\n');
      const proof = JSON.parse(
        readFileSync(path.join(runRoot, 'swift-consumer-receipt.json'), 'utf8'),
      );
      expect(proof.cases).toEqual(['create-query-42', 'reopen-query-42', 'native-runtime-suite']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
