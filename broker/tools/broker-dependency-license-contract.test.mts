import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { currentProductVersionSync } from '../../tools/release/release-artifact-targets.mts';
import {
  assertBrokerDependencyLicensesInArchive,
  assertBrokerDependencyLicensesInDirectory,
  assertBrokerDependencyLicensesInEntries,
  BROKER_DEPENDENCY_LICENSE_ROOT,
  BROKER_PAYLOAD_LICENSE,
  brokerDependencyLicenseMembers,
  hasCanonicalBrokerFilesystemMode,
  hasSafeBrokerSourceFilesystemMode,
  isAllowedBrokerPathPackageMetadataRow,
  loadBrokerDependencyLicenseContract,
  normalizeBrokerDependencyLicenseModes,
  stageBrokerDependencyLicenses,
} from './broker-dependency-license-contract.mts';
import { brokerNpmTarballs } from './package-carriers.mts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTRACT = path.join(ROOT, 'broker/dependency-licenses.json');
const BROKER_VERSION = currentProductVersionSync(
  'oliphaunt-broker',
  'broker-dependency-license-contract.test.mts',
);
const TARGETS = ['linux-x64-gnu', 'linux-arm64-gnu', 'macos-arm64', 'windows-x64-msvc'];
const TIMEOUT = 120_000;

function scratch(t, label) {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), `oliphaunt-broker-license-${label}-`)),
  );
  chmodSync(directory, 0o755);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stageCarrier(t, target) {
  const directory = scratch(t, target);
  stageReleaseNotices(directory, { profile: 'broker' });
  stageBrokerDependencyLicenses(directory, target);
  return directory;
}

function writeMutatedContract(t, mutate) {
  const directory = scratch(t, 'contract');
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'));
  mutate(contract);
  const file = path.join(directory, 'dependency-licenses.json');
  writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o644 });
  chmodSync(file, 0o644);
  return file;
}

async function archive(directory, extension) {
  const output = `${directory}.${extension}`;
  await archiveDirectory(directory, output);
  return output;
}

const packageFixture = process.env.OLIPHAUNT_BROKER_LICENSE_TEST_ROOT;
if (!packageFixture)
  throw new Error('Run bash broker/tools/broker-dependency-license-contract.test.sh');

test('broker local dependency licenses follow Cargo workspace membership', () => {
  const row = {
    id: 'workspace-bindings',
    name: 'liboliphaunt-native-bindings',
    version: '17.23.401',
    source: null,
    license: 'MIT',
    manifest_path: path.join(ROOT, 'sdks/rust/liboliphaunt-native/Cargo.toml'),
  };
  const members = new Set([row.id]);
  assert.equal(isAllowedBrokerPathPackageMetadataRow(row, members), true);
  for (const changed of [
    { ...row, source: 'registry+https://github.com/rust-lang/crates.io-index' },
    { ...row, id: 'external-path-dependency' },
    { ...row, license: 'Apache-2.0' },
    { ...row, manifest_path: path.join(ROOT, '../external/Cargo.toml') },
  ])
    assert.equal(isAllowedBrokerPathPackageMetadataRow(changed, members), false);
});

test('treats direct filesystem modes as POSIX-only metadata', () => {
  assert.equal(hasCanonicalBrokerFilesystemMode(0o666, 0o644, 'win32'), true);
  assert.equal(hasCanonicalBrokerFilesystemMode(0o666, 0o755, 'win32'), true);
  assert.equal(hasCanonicalBrokerFilesystemMode(0o644, 0o644, 'linux'), true);
  assert.equal(hasCanonicalBrokerFilesystemMode(0o755, 0o755, 'darwin'), true);
  assert.equal(hasCanonicalBrokerFilesystemMode(0o666, 0o644, 'linux'), false);
  assert.equal(hasCanonicalBrokerFilesystemMode(0o666, 0o755, 'darwin'), false);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o600, 'linux'), true);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o640, 'darwin'), true);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o644, 'linux'), true);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o664, 'linux'), true);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o666, 'linux'), true);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o755, 'darwin'), false);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o000, 'linux'), false);
  assert.equal(hasSafeBrokerSourceFilesystemMode(0o666, 'win32'), true);
});

test("target indexes exclude other operating systems' conditional dependencies", {
  timeout: TIMEOUT,
}, (t) => {
  const indexes = new Map();
  for (const target of TARGETS) {
    const directory = stageCarrier(t, target);
    assertBrokerDependencyLicensesInDirectory(directory, { target });
    const index = JSON.parse(
      readFileSync(
        path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split('/'), 'DEPENDENCIES.json'),
        'utf8',
      ),
    );
    assert.equal(index.target, target);
    assert.equal(index.payloadLicense, BROKER_PAYLOAD_LICENSE);
    indexes.set(target, new Set(index.packages.map(({ name }) => name)));
  }
  assert.ok(indexes.get('linux-x64-gnu').has('libc'));
  assert.ok(!indexes.get('linux-x64-gnu').has('windows-link'));
  assert.ok(indexes.get('macos-arm64').has('libc'));
  assert.ok(!indexes.get('macos-arm64').has('windows-link'));
  assert.ok(indexes.get('windows-x64-msvc').has('windows-link'));
  assert.ok(indexes.get('windows-x64-msvc').has('winapi'));
  assert.ok(!indexes.get('windows-x64-msvc').has('libc'));
});

test('staged and packed closures preserve exact bytes, modes, and members', {
  timeout: TIMEOUT,
}, async (t) => {
  for (const [target, extension] of [
    ['linux-x64-gnu', 'tar.gz'],
    ['windows-x64-msvc', 'zip'],
  ]) {
    const directory = stageCarrier(t, target);
    const packed = await archive(directory, extension);
    t.after(() => rmSync(packed, { force: true }));
    assertBrokerDependencyLicensesInArchive(packed, { target });
    const expected = brokerDependencyLicenseMembers(target);
    assert.ok(expected.includes(`${BROKER_DEPENDENCY_LICENSE_ROOT}/DEPENDENCIES.json`));
    assert.ok(
      expected.some((member) => member.startsWith(`${BROKER_DEPENDENCY_LICENSE_ROOT}/licenses/`)),
    );
  }

  const extraDirectory = stageCarrier(t, 'linux-x64-gnu');
  writeFileSync(
    path.join(extraDirectory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split('/'), 'licenses/extra.txt'),
    'undeclared\n',
    { mode: 0o644 },
  );
  const extraArchive = await archive(extraDirectory, 'tar.gz');
  t.after(() => rmSync(extraArchive, { force: true }));
  assert.throws(
    () => assertBrokerDependencyLicensesInArchive(extraArchive, { target: 'linux-x64-gnu' }),
    /unexpected dependency license member/u,
  );
});

test('portable archive dependency-license modes remain exact on every host', {
  timeout: TIMEOUT,
}, async (t) => {
  const target = 'windows-x64-msvc';
  const directory = stageCarrier(t, target);
  const packed = await archive(directory, 'zip');
  t.after(() => rmSync(packed, { force: true }));
  const entries = readPortableArchiveEntries(packed);

  const fileMember = `${BROKER_DEPENDENCY_LICENSE_ROOT}/DEPENDENCIES.json`;
  const fileModeDrift = new Map(entries);
  fileModeDrift.set(fileMember, { ...entries.get(fileMember), mode: 0o666 });
  assert.throws(
    () => assertBrokerDependencyLicensesInEntries(fileModeDrift, { target }),
    /dependency license member .* must have mode 0644/u,
  );

  const directoryMember = `${BROKER_DEPENDENCY_LICENSE_ROOT}/licenses`;
  const directoryModeDrift = new Map(entries);
  directoryModeDrift.set(directoryMember, { ...entries.get(directoryMember), mode: 0o700 });
  assert.throws(
    () => assertBrokerDependencyLicensesInEntries(directoryModeDrift, { target }),
    /dependency license directory .* must have mode 0755/u,
  );
});

test('real npm target tarballs reopen the exact target-specific dependency closure', {
  timeout: TIMEOUT,
}, () => {
  const assetDir = path.join(packageFixture, 'assets');
  const packageTargets = new Map([
    ['@oliphaunt/broker-darwin-arm64', 'macos-arm64'],
    ['@oliphaunt/broker-linux-arm64-gnu', 'linux-arm64-gnu'],
    ['@oliphaunt/broker-linux-x64-gnu', 'linux-x64-gnu'],
    ['@oliphaunt/broker-win32-x64-msvc', 'windows-x64-msvc'],
  ]);
  const tarballs = brokerNpmTarballs(BROKER_VERSION, { assetDir });
  assert.equal(tarballs.length, packageTargets.size);
  for (const [packageName, tarball] of tarballs) {
    for (const [name, entry] of readPortableArchiveEntries(tarball)) {
      assert.ok(entry.mode === 0o644 || entry.mode === 0o755, `${packageName} ${name} mode`);
    }
    assertBrokerDependencyLicensesInArchive(tarball, {
      target: packageTargets.get(packageName),
      prefix: 'package',
    });
  }
});

test('concurrent real Cargo payload packagers are isolated and reopen exact target closures', {
  timeout: TIMEOUT,
}, () => {
  const outputDirs = ['a', 'b'].map((id) => path.join(packageFixture, `cargo-${id}`));
  const targets = new Map(
    TARGETS.map((target) => [`oliphaunt-broker-${target}-${BROKER_VERSION}.crate`, target]),
  );
  for (const outputDir of outputDirs) {
    const crates = readdirSync(outputDir)
      .filter((name) => name.endsWith('.crate'))
      .sort();
    assert.deepEqual(crates, [...targets.keys()].sort());
    for (const crate of crates) {
      assertBrokerDependencyLicensesInArchive(path.join(outputDir, crate), {
        target: targets.get(crate),
        prefix: crate.replace(/\.crate$/u, ''),
      });
    }
  }
  for (const crate of targets.keys()) {
    assert.deepEqual(
      readFileSync(path.join(outputDirs[0], crate)),
      readFileSync(path.join(outputDirs[1], crate)),
      `${crate} must not depend on its staging directory`,
    );
  }
});

test('directory closure rejects missing, changed, extra, executable, and symlinked legal members', {
  timeout: TIMEOUT,
}, (t) => {
  const mutations = [
    ['missing', (directory, member) => rmSync(path.join(directory, ...member.split('/')))],
    [
      'changed',
      (directory, member) => writeFileSync(path.join(directory, ...member.split('/')), 'changed\n'),
    ],
    [
      'executable',
      (directory, member) => chmodSync(path.join(directory, ...member.split('/')), 0o755),
    ],
    [
      'extra',
      (directory) =>
        writeFileSync(
          path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split('/'), 'licenses/extra.txt'),
          'extra\n',
          { mode: 0o644 },
        ),
    ],
  ];
  for (const [label, mutate] of mutations) {
    const directory = stageCarrier(t, 'linux-x64-gnu');
    const member = brokerDependencyLicenseMembers('linux-x64-gnu').find((value) =>
      value.endsWith('.txt'),
    );
    mutate(directory, member);
    assert.throws(
      () => assertBrokerDependencyLicensesInDirectory(directory, { target: 'linux-x64-gnu' }),
      /broker dependency license|canonical|mode 0644|unexpected|missing/u,
      label,
    );
  }

  const directory = stageCarrier(t, 'linux-x64-gnu');
  const licenses = path.join(directory, ...BROKER_DEPENDENCY_LICENSE_ROOT.split('/'), 'licenses');
  const replacement = path.join(directory, 'replacement');
  mkdirSync(replacement, { mode: 0o755 });
  rmSync(licenses, { recursive: true });
  symlinkSync(replacement, licenses, 'dir');
  assert.throws(
    () => assertBrokerDependencyLicensesInDirectory(directory, { target: 'linux-x64-gnu' }),
    /symlink|missing/u,
  );
});

test('staging rejects a symlinked legal namespace ancestor without touching its target', {
  timeout: TIMEOUT,
}, (t) => {
  const directory = scratch(t, 'symlink-parent-stage');
  const external = scratch(t, 'symlink-parent-external');
  const externalRust = path.join(external, 'rust');
  mkdirSync(externalRust, { mode: 0o755 });
  const sentinel = path.join(externalRust, 'sentinel.txt');
  writeFileSync(sentinel, 'must survive\n', { mode: 0o644 });
  symlinkSync(external, path.join(directory, 'THIRD_PARTY_LICENSES'), 'dir');

  assert.throws(
    () => stageBrokerDependencyLicenses(directory, 'linux-x64-gnu'),
    /symlink|non-directory ancestor/u,
  );
  assert.throws(
    () => normalizeBrokerDependencyLicenseModes(directory, 'linux-x64-gnu'),
    /symlink/u,
  );
  assert.throws(
    () => assertBrokerDependencyLicensesInDirectory(directory, { target: 'linux-x64-gnu' }),
    /symlink/u,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'must survive\n');
});

test('contract mutations cannot omit legal files, change lock identity, lie about a selected branch, or skew target claims', {
  timeout: TIMEOUT,
}, (t) => {
  {
    const file = writeMutatedContract(t, (contract) => {
      const legal = contract.packages[0].licenseFiles[0];
      contract.packages[0].licenseFiles[0] = Object.fromEntries(Object.entries(legal).reverse());
    });
    assert.doesNotThrow(() => loadBrokerDependencyLicenseContract({ contractPath: file }));
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      const memchr = contract.packages.find(({ name }) => name === 'memchr');
      memchr.licenseFiles = memchr.licenseFiles.filter(({ name }) => name !== 'UNLICENSE');
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /license blobs differ/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      contract.packages[0].checksum = '0'.repeat(64);
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file, auditLock: true }),
      /Cargo\.lock identity changed/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      contract.packages.find(({ name }) => name === 'libloading').selectedLicense = 'MIT';
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /selects MIT but declares ISC/u,
    );
  }

  {
    const file = writeMutatedContract(t, (contract) => {
      const { name, version } = contract.packages.find(({ name }) => name === 'libc');
      const key = `${name}@${version}`;
      contract.targets['linux-x64-gnu'].packages = contract.targets[
        'linux-x64-gnu'
      ].packages.filter((value) => value !== key);
    });
    assert.throws(
      () => loadBrokerDependencyLicenseContract({ contractPath: file }),
      /package graph and package target claims disagree/u,
    );
  }
});
