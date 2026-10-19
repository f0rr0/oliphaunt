import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  hasCanonicalReleaseStagingMode,
  releaseNoticeRows,
} from '../../../tools/packaging/release-notices.mts';
import {
  assertExtensionUpstreamLicensesInArchive,
  assertExtensionUpstreamLicensesInDirectory,
  assertExtensionUpstreamLicensesInEntries,
  assertSupportedExtensionUpstreamSpdxId,
  extensionCarrierLegalContract,
  extensionCarrierLegalFileInventory,
  extensionMavenLicenses,
  extensionRegistryLicense,
  extensionUpstreamLicenseFileInventory,
  extensionUpstreamLicenseRows,
  externalReleaseExtensionSqlNames,
  nativeExtensionCarrierLegal,
  nativeExtensionConstructionLicenseInventory,
  nativeExtensionConstructionMavenLicenses,
  PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS,
  stageExtensionUpstreamLicenses,
  validateExtensionUpstreamLicenseContract,
  validateNativeExtensionConstructionLicenseInventory,
} from './extension-upstream-licenses.mts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

for (const [sqlName, product] of [
  ['vector', 'oliphaunt-extension-vector'],
  ['pg_textsearch', 'oliphaunt-extension-pg-textsearch'],
]) {
  test(`${sqlName} native carrier SPDX follows actual compiler-runtime receipts and rejects altered receipts`, () => {
    const target = 'android-arm64-v8a';
    const files = nativeExtensionConstructionLicenseInventory(sqlName, target);
    const legal = nativeExtensionCarrierLegal(product, [sqlName], {
      target,
      carriesPayload: true,
      memberContracts: [{ sqlName, nativeConstructionLicenseFiles: files }],
    });
    assert.equal(
      legal.packageSpdx,
      `${extensionCarrierLegalContract(product, [sqlName], { family: 'native', target }).packageSpdx} AND Apache-2.0 WITH LLVM-exception`,
    );
    assert.equal(Object.isFrozen(legal), true);
    assert.equal(
      nativeExtensionCarrierLegal(product, [sqlName], { carriesPayload: false }).profile,
      'code-facade',
    );
    for (const changedIndex of [0, 1]) {
      assert.throws(
        () =>
          nativeExtensionCarrierLegal(product, [sqlName], {
            target,
            carriesPayload: true,
            memberContracts: [
              {
                sqlName,
                nativeConstructionLicenseFiles: files.map((file, index) =>
                  index === changedIndex ? { ...file, sha256: '0'.repeat(64) } : file,
                ),
              },
            ],
          }),
        /differs from the immutable construction source/u,
      );
    }
  });

  test(`${sqlName} Maven compiler-runtime entries follow validated canonical receipts`, () => {
    const receipts = nativeExtensionConstructionLicenseInventory(sqlName, 'android-arm64-v8a');
    const source = JSON.parse(
      readFileSync(path.join(ROOT, 'build_defs/extensions/compiler_rt/source.json'), 'utf8'),
    );
    assert.deepEqual(
      nativeExtensionConstructionMavenLicenses(sqlName, 'android-arm64-v8a', receipts),
      [
        {
          name: `${source.license} (${source.project})`,
          url: `https://github.com/llvm/llvm-project/blob/${source.commit}/${source.files.find((file) => file.destination === 'LICENSE.TXT').path}`,
          distribution: 'repo',
        },
      ],
    );
    assert.deepEqual(
      nativeExtensionConstructionMavenLicenses(sqlName, 'android-arm64-v8a', []),
      [],
    );
    for (const changedIndex of [0, 1]) {
      assert.throws(() =>
        nativeExtensionConstructionMavenLicenses(
          sqlName,
          'android-arm64-v8a',
          receipts.map((file, index) =>
            index === changedIndex ? { ...file, sha256: '0'.repeat(64) } : file,
          ),
        ),
      );
    }
  });
}

test('members without construction sources have frozen empty inventories and reject supplied receipts', () => {
  const target = 'linux-x64-gnu';
  const receipts = nativeExtensionConstructionLicenseInventory('vector', target);
  for (const sqlName of ['pg_hashids', 'hstore', 'unknown_extension']) {
    const files = nativeExtensionConstructionLicenseInventory(sqlName, target);
    assert.deepEqual(files, []);
    assert.equal(Object.isFrozen(files), true);
    const validated = validateNativeExtensionConstructionLicenseInventory(sqlName, target);
    assert.deepEqual(validated, []);
    assert.equal(Object.isFrozen(validated), true);
    assert.throws(
      () => validateNativeExtensionConstructionLicenseInventory(sqlName, target, receipts),
      /no declared source for this member\/target/u,
    );
    assert.throws(
      () => nativeExtensionConstructionMavenLicenses(sqlName, target, receipts),
      /no declared source for this member\/target/u,
    );
  }
});

test('every active external release has an exact upstream license contract', () => {
  const rows = validateExtensionUpstreamLicenseContract();
  assert.deepEqual(
    rows.map((row) => row.sqlName),
    externalReleaseExtensionSqlNames(),
  );
  for (const row of rows) {
    assert.ok(row.files.length > 0, `${row.sqlName} must ship at least one license file`);
    assert.equal(new Set(row.files.map((file) => file.destination)).size, row.files.length);
  }
});

test('npm extension legal inventory binds canonical paths, bytes, and modes', () => {
  const row = extensionUpstreamLicenseRows().find(({ sqlName }) => sqlName === 'pg_uuidv7');
  assert.ok(row, 'pg_uuidv7 must have canonical upstream legal metadata');
  assert.deepEqual(
    extensionUpstreamLicenseFileInventory(['pg_uuidv7']),
    row.files.map((file) => ({
      path: file.destination,
      sha256: file.sha256,
      mode: '0644',
    })),
  );
  const postgis = extensionUpstreamLicenseFileInventory(['postgis']);
  assert.deepEqual(
    postgis.map(({ path: member }) => member),
    [...postgis].map(({ path: member }) => member).sort(),
  );
  assert.equal(Object.isFrozen(postgis), true);
  assert.equal(postgis.every(Object.isFrozen), true);
  assert.throws(
    () => extensionUpstreamLicenseFileInventory([]),
    /requires a non-empty unique extension member list/u,
  );
});

test('pgcrypto native construction receipts bind desktop and mobile-host OpenSSL source bytes', () => {
  assert.deepEqual(PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS, [
    'linux-x64-gnu',
    'linux-arm64-gnu',
    'macos-arm64',
    'windows-x64-msvc',
  ]);
  assert.equal(Object.isFrozen(PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS), true);
  const openssl = releaseNoticeRows({ profile: 'contrib-native-openssl' }).find(
    ({ id }) => id === 'openssl',
  );
  assert.ok(openssl, 'the canonical native OpenSSL profile must declare its source');
  const expected = [
    ['share/licenses/openssl-native/LICENSE.txt', openssl.source],
    ['share/licenses/openssl-native/SOURCE.toml', openssl.sourceManifest],
  ].map(([file, source]) => ({
    path: file,
    sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    mode: '0644',
  }));
  for (const target of [
    ...PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS,
    'android-arm64-v8a',
    'android-x86_64',
    'ios-xcframework',
  ]) {
    const files = nativeExtensionConstructionLicenseInventory('pgcrypto', target);
    assert.deepEqual(files, expected, target);
    assert.equal(Object.isFrozen(files), true);
    assert.equal(files.every(Object.isFrozen), true);
    assert.deepEqual(
      validateNativeExtensionConstructionLicenseInventory('pgcrypto', target, files),
      expected,
    );
    assert.equal(
      extensionCarrierLegalContract('oliphaunt-extension-contrib-pg18', ['pgcrypto'], {
        family: 'native',
        target,
        memberContracts: [{ sqlName: 'pgcrypto', nativeConstructionLicenseFiles: files }],
      }).profile,
      'contrib-native-openssl',
    );
  }
});

test('pgcrypto construction receipts reject unsupported targets and changed source digests', () => {
  const files = nativeExtensionConstructionLicenseInventory('pgcrypto', 'linux-x64-gnu');
  for (const target of ['macos-x64', 'linux-x64-musl', 'wasix']) {
    const inventory = nativeExtensionConstructionLicenseInventory('pgcrypto', target);
    assert.deepEqual(inventory, []);
    assert.equal(Object.isFrozen(inventory), true);
    assert.throws(
      () => validateNativeExtensionConstructionLicenseInventory('pgcrypto', target, files),
      /no declared source for this member\/target/u,
      target,
    );
    assert.deepEqual(validateNativeExtensionConstructionLicenseInventory('pgcrypto', target), []);
  }
  for (const target of [
    ...PGCRYPTO_NATIVE_CONSTRUCTION_TARGETS,
    'android-arm64-v8a',
    'android-x86_64',
    'ios-xcframework',
  ]) {
    for (const changedIndex of [0, 1]) {
      const changed = files.map((file, index) =>
        index === changedIndex
          ? { ...file, sha256: `${file.sha256[0] === '0' ? '1' : '0'}${file.sha256.slice(1)}` }
          : file,
      );
      assert.throws(
        () => validateNativeExtensionConstructionLicenseInventory('pgcrypto', target, changed),
        /differs from the immutable construction source/u,
        `${target}: ${files[changedIndex].path}`,
      );
    }
    assert.deepEqual(validateNativeExtensionConstructionLicenseInventory('pgcrypto', target), []);
  }
  for (const target of ['android-arm64-v8a', 'android-x86_64', 'ios-xcframework', 'macos-x64']) {
    assert.equal(
      extensionCarrierLegalContract('oliphaunt-extension-contrib-pg18', ['pgcrypto'], {
        family: 'native',
        target,
      }).profile,
      'contrib-native-openssl',
    );
  }
});

for (const sqlName of ['vector', 'pg_textsearch']) {
  test(`Android ${sqlName} host receipts retain the actual Linux compiler runtime without admitting Apple receipts`, () => {
    const files = nativeExtensionConstructionLicenseInventory(sqlName, 'linux-x64-gnu');
    for (const target of ['android-arm64-v8a', 'android-x86_64']) {
      assert.deepEqual(nativeExtensionConstructionLicenseInventory(sqlName, target), files);
      assert.deepEqual(
        validateNativeExtensionConstructionLicenseInventory(sqlName, target, files),
        files,
      );
    }
    for (const target of ['ios-xcframework', 'macos-arm64', 'linux-arm64-gnu']) {
      const inventory = nativeExtensionConstructionLicenseInventory(sqlName, target);
      assert.deepEqual(inventory, []);
      assert.equal(Object.isFrozen(inventory), true);
      assert.deepEqual(validateNativeExtensionConstructionLicenseInventory(sqlName, target), []);
      assert.throws(
        () => validateNativeExtensionConstructionLicenseInventory(sqlName, target, files),
        /no declared source/u,
      );
    }
  });
}

test('carrier legal inventory binds release notices and PostGIS upstream bytes', () => {
  const legal = extensionCarrierLegalContract('oliphaunt-extension-postgis', ['postgis'], {
    family: 'native',
    target: 'android-arm64-v8a',
  });
  const files = extensionCarrierLegalFileInventory('oliphaunt-extension-postgis', ['postgis'], {
    family: 'native',
    target: 'android-arm64-v8a',
  });
  assert.deepEqual(
    files
      .filter(({ path: file }) => file.startsWith('share/licenses/'))
      .map(({ path: file }) => file),
    [...legal.licenseFiles],
  );
  assert.deepEqual(
    files.slice(0, 2).map(({ path: file }) => file),
    ['LICENSE', 'THIRD_PARTY_NOTICES.md'],
  );
  assert.equal(
    files.every(({ bytes }) => Number.isSafeInteger(bytes) && bytes > 0),
    true,
  );
  assert.equal(
    files.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)),
    true,
  );
  assert.equal(
    files.every(({ mode }) => mode === '0644'),
    true,
  );
  assert.equal(Object.isFrozen(files), true);
  assert.equal(files.every(Object.isFrozen), true);
});

test('committed legal bytes stage every active external release without source checkouts', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'external-license-clean-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingCheckouts = process.env.OLIPHAUNT_EXTENSION_SOURCE_CHECKOUT_ROOT;
  assert.ok(missingCheckouts, 'run bash src/extensions/tools/extension-upstream-licenses.test.sh');
  assert.equal(existsSync(missingCheckouts), false);
  for (const sqlName of externalReleaseExtensionSqlNames()) {
    const stage = path.join(root, sqlName);
    mkdirSync(stage, { recursive: true });
    const staged = stageExtensionUpstreamLicenses(sqlName, stage);
    assert.deepEqual(assertExtensionUpstreamLicensesInDirectory([sqlName], stage), staged);
    const archive = path.join(root, `${sqlName}.tar.gz`);
    writeFileSync(archive, canonicalGzipSync(createDeterministicTar(stage, sqlName, {})));
    assert.deepEqual(
      assertExtensionUpstreamLicensesInArchive([sqlName], archive, { prefix: sqlName }),
      staged.map((member) => `${sqlName}/${member}`),
    );
  }
  assert.equal(existsSync(missingCheckouts), false);
});

test("the contract retains dependency licenses and pgtap's complete upstream grant", () => {
  const rows = extensionUpstreamLicenseRows();
  const postgis = rows.find((row) => row.sqlName === 'postgis');
  assert.deepEqual(
    [...new Set(postgis.files.map((file) => file.checkout))],
    ['geos', 'json-c', 'libiconv', 'libxml2', 'postgis', 'proj', 'sqlite'],
  );
  assert.deepEqual(
    postgis.files.filter((file) => file.checkout === 'libiconv').map((file) => file.path),
    ['libcharset/COPYING.LIB', 'COPYING.LIB'],
  );
  assert.deepEqual(
    postgis.files
      .filter((file) => file.checkout === 'geos' && file.path.startsWith('src/deps/ryu/'))
      .map((file) => file.path),
    ['src/deps/ryu/LICENSE', 'src/deps/ryu/LICENSE-Apache2', 'src/deps/ryu/LICENSE-Boost'],
  );
  assert.deepEqual(
    postgis.files.filter((file) => file.checkout === 'postgis').map((file) => file.path),
    [
      'COPYING',
      'LICENSE.TXT',
      'deps/flatgeobuf/include/flatbuffers/LICENSE',
      'deps/ryu/LICENSE',
      'deps/ryu/LICENSE-Apache2',
      'deps/ryu/LICENSE-Boost',
    ],
  );
  const pgtap = rows.find((row) => row.sqlName === 'pgtap');
  assert.equal(pgtap.files.length, 1);
  assert.equal(pgtap.files[0].path, 'README.md');
  const source = path.join(ROOT, 'target/oliphaunt-sources/checkouts/pgtap/README.md');
  try {
    const text = readFileSync(source, 'utf8');
    assert.match(text, /Permission to use, copy, modify, and distribute/u);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

test('registry metadata derives external and contrib SPDX expressions from the same contract', () => {
  assert.deepEqual(extensionRegistryLicense('oliphaunt-extension-pg-uuidv7', ['pg_uuidv7']), {
    product: 'oliphaunt-extension-pg-uuidv7',
    upstreamSpdx: 'MPL-2.0',
    packageSpdx: 'MIT AND MPL-2.0',
  });
  assert.deepEqual(extensionRegistryLicense('oliphaunt-extension-postgis', ['postgis']), {
    product: 'oliphaunt-extension-postgis',
    upstreamSpdx: 'MIT AND Apache-2.0 AND GPL-2.0-or-later AND LGPL-2.1-or-later AND blessing',
    packageSpdx: 'MIT AND Apache-2.0 AND GPL-2.0-or-later AND LGPL-2.1-or-later AND blessing',
  });
  assert.deepEqual(
    extensionRegistryLicense('oliphaunt-extension-contrib-pg18', ['hstore', 'pgcrypto']),
    {
      product: 'oliphaunt-extension-contrib-pg18',
      upstreamSpdx: 'PostgreSQL',
      packageSpdx: 'MIT AND PostgreSQL',
    },
  );
  assert.deepEqual(
    extensionRegistryLicense('oliphaunt-extension-pg-hashids', ['pg_hashids']).packageSpdx,
    'MIT',
  );
  const maven = extensionMavenLicenses('oliphaunt-extension-pg-uuidv7', ['pg_uuidv7'], {
    version: '0.1.0',
  });
  assert.deepEqual(
    maven.map((entry) => entry.name),
    ['MIT License (Oliphaunt)', 'MPL-2.0 (pg_uuidv7)'],
  );
  assert.match(maven[0].url, /\/blob\/oliphaunt-extension-pg-uuidv7-v0\.1\.0\/LICENSE$/u);
  assert.match(maven[1].url, /c707aae2411181be4802f5fa565b44d9c0bcbc29\/LICENSE$/u);
});

test('carrier legal roles derive exact contrib and external payload closure', () => {
  assert.deepEqual(
    extensionCarrierLegalContract('oliphaunt-extension-contrib-pg18', ['hstore', 'pgcrypto'], {
      family: 'native',
      target: 'linux-x64-gnu',
    }),
    {
      profile: 'contrib-native',
      packageSpdx: 'MIT AND PostgreSQL',
      upstreamMembers: [],
      licenseFiles: [],
    },
  );
  assert.equal(
    extensionCarrierLegalContract('oliphaunt-extension-contrib-pg18', ['hstore', 'pgcrypto'], {
      family: 'wasix',
      target: 'wasix',
    }).profile,
    'contrib-wasix-openssl',
  );
  const postgis = extensionCarrierLegalContract('oliphaunt-extension-postgis', ['postgis'], {
    family: 'native',
    target: 'android-arm64-v8a',
  });
  assert.equal(postgis.profile, 'external-native');
  assert.deepEqual(postgis.upstreamMembers, ['postgis']);
  assert.deepEqual(postgis.licenseFiles, [
    'share/licenses/geos/COPYING',
    'share/licenses/geos/src/deps/ryu/LICENSE',
    'share/licenses/geos/src/deps/ryu/LICENSE-Apache2',
    'share/licenses/geos/src/deps/ryu/LICENSE-Boost',
    'share/licenses/json-c/COPYING',
    'share/licenses/libcharset/COPYING.LIB',
    'share/licenses/libiconv/COPYING.LIB',
    'share/licenses/libxml2/Copyright',
    'share/licenses/postgis/COPYING',
    'share/licenses/postgis/LICENSE.TXT',
    'share/licenses/postgis/deps/flatgeobuf/flatbuffers/LICENSE',
    'share/licenses/postgis/deps/ryu/LICENSE',
    'share/licenses/postgis/deps/ryu/LICENSE-Apache2',
    'share/licenses/postgis/deps/ryu/LICENSE-Boost',
    'share/licenses/proj/COPYING',
    'share/licenses/sqlite/LICENSE.md',
  ]);
  assert.deepEqual(
    extensionCarrierLegalContract('oliphaunt-extension-vector', ['vector'], {
      carriesPayload: false,
    }),
    {
      profile: 'code-facade',
      packageSpdx: 'MIT',
      upstreamMembers: [],
      licenseFiles: [],
    },
  );
});

test('SPDX metadata fails closed to the identifiers supported by the carrier contract', () => {
  assert.equal(assertSupportedExtensionUpstreamSpdxId('MPL-2.0'), 'MPL-2.0');
  assert.throws(
    () => assertSupportedExtensionUpstreamSpdxId('Unknown-License-1.0'),
    /must declare one supported SPDX identifier/u,
  );
});

test('staging verifies committed bytes, mode, and directory safety', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'extension-license-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const staged = stageExtensionUpstreamLicenses('pg_hashids', stage);
  assert.deepEqual(staged, ['share/licenses/pg_hashids/LICENSE']);
  const output = path.join(stage, staged[0]);
  assert.equal(hasCanonicalReleaseStagingMode(lstatSync(output).mode), true);
  assert.equal(
    createHash('sha256').update(readFileSync(output)).digest('hex'),
    extensionUpstreamLicenseRows().find(({ sqlName }) => sqlName === 'pg_hashids').files[0].sha256,
  );
  assert.deepEqual(assertExtensionUpstreamLicensesInDirectory(['pg_hashids'], stage), staged);

  const archive = path.join(root, 'pg-hashids.crate');
  writeFileSync(
    archive,
    canonicalGzipSync(
      createDeterministicTar(stage, 'pg-hashids-0.1.0', {
        fail(message) {
          throw new Error(message);
        },
      }),
    ),
  );
  assert.deepEqual(
    assertExtensionUpstreamLicensesInArchive(['pg_hashids'], archive, {
      prefix: 'pg-hashids-0.1.0',
    }),
    ['pg-hashids-0.1.0/share/licenses/pg_hashids/LICENSE'],
  );

  const entries = readPortableArchiveEntries(archive);
  const assertion = (mutated) =>
    assertExtensionUpstreamLicensesInEntries(['pg_hashids'], mutated, {
      prefix: 'pg-hashids-0.1.0',
    });
  const inject = (member, entry) => new Map([...entries, [member, entry]]);
  const fakeEntry = (overrides = {}) => ({
    data: () => Buffer.from('unexpected'),
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
    mode: 0o644,
    ...overrides,
  });
  assert.throws(
    () => assertion(inject('pg-hashids-0.1.0/share/licenses/unknown/LICENSE', fakeEntry())),
    /unexpected file member/u,
  );
  assert.throws(
    () =>
      assertion(
        inject(
          'pg-hashids-0.1.0/share/licenses/unknown',
          fakeEntry({ isDirectory: true, isFile: false, mode: 0o755 }),
        ),
      ),
    /unexpected directory member/u,
  );
  assert.throws(
    () =>
      assertion(
        inject(
          'pg-hashids-0.1.0/share/licenses/unknown-link',
          fakeEntry({ isFile: false, isSymbolicLink: true, mode: 0o777 }),
        ),
      ),
    /unexpected symlink member/u,
  );
  assert.throws(
    () =>
      assertion(
        inject(
          'pg-hashids-0.1.0/share/licenses/unknown-special',
          fakeEntry({ isFile: false, mode: 0o600 }),
        ),
      ),
    /unexpected special member/u,
  );
  const wrongDirectoryMode = new Map(entries);
  const directoryMember = 'pg-hashids-0.1.0/share/licenses/pg_hashids';
  wrongDirectoryMode.set(directoryMember, {
    ...wrongDirectoryMode.get(directoryMember),
    mode: 0o700,
  });
  assert.throws(() => assertion(wrongDirectoryMode), /directory must be a real mode-0755/u);

  const privilegedFileMode = new Map(entries);
  const licenseMember = 'pg-hashids-0.1.0/share/licenses/pg_hashids/LICENSE';
  privilegedFileMode.set(licenseMember, {
    ...privilegedFileMode.get(licenseMember),
    mode: 0o4644,
  });
  assert.throws(
    () => assertion(privilegedFileMode),
    /must be a regular non-symlink mode-0644 file/u,
  );

  const missingAssertionRoot = path.join(root, 'missing-parent', 'missing-stage');
  assert.throws(
    () => assertExtensionUpstreamLicensesInDirectory(['pg_hashids'], missingAssertionRoot),
    /upstream license assertion cannot be inspected/u,
  );
  assert.equal(existsSync(path.join(root, 'missing-parent')), false);

  const unsafe = path.join(root, 'unsafe');
  const outside = path.join(root, 'outside');
  mkdirSync(unsafe);
  mkdirSync(outside);
  symlinkSync(outside, path.join(unsafe, 'share'));
  assert.throws(
    () => stageExtensionUpstreamLicenses('pg_hashids', unsafe),
    /staging parent must be a real directory/u,
  );

  const realAncestor = path.join(root, 'real-ancestor');
  const existingStage = path.join(realAncestor, 'existing-stage');
  mkdirSync(existingStage, { recursive: true });
  const linkedAncestor = path.join(root, 'linked-ancestor');
  symlinkSync(realAncestor, linkedAncestor);
  assert.throws(
    () => stageExtensionUpstreamLicenses('pg_hashids', path.join(linkedAncestor, 'existing-stage')),
    /symlink or non-directory ancestor/u,
  );
});

test("the public PostGIS carrier's compiled-component legal atoms are pinned, staged, and exact in archives", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'postgis-license-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const expected = extensionCarrierLegalContract('oliphaunt-extension-postgis', ['postgis'], {
    family: 'wasix',
    target: 'wasix-portable',
  }).licenseFiles;
  assert.deepEqual(stageExtensionUpstreamLicenses('postgis', stage), expected);
  assert.deepEqual(assertExtensionUpstreamLicensesInDirectory(['postgis'], stage), expected);

  const archive = path.join(root, 'postgis.tar.gz');
  writeFileSync(
    archive,
    canonicalGzipSync(
      createDeterministicTar(stage, 'postgis', {
        fail(message) {
          throw new Error(message);
        },
      }),
    ),
  );
  assert.deepEqual(
    assertExtensionUpstreamLicensesInArchive(['postgis'], archive, { prefix: 'postgis' }),
    expected.map((member) => `postgis/${member}`),
  );
});
