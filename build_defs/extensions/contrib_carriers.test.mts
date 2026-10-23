/** Canonical contrib ownership, source facts and deterministic bundle byte contracts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleCarrierAssets } from '../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { nativeExtensionConstructionLicenseInventory } from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { type NativeContribCarrierSpec, validateNativeContribInputs } from './contrib_carriers.mts';
import { frozenNativeMember, nativeCarrierCompatibility } from './native_carriers.mts';

const [input] = process.argv.slice(2);
assert(input, 'expected canonical contrib carrier metadata');
const metadata = JSON.parse(readFileSync(input, 'utf8'));
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'contrib-carrier-unit-'));
const spec: NativeContribCarrierSpec = {
  ...metadata,
  outputs: {
    github: path.join(
      root,
      `${metadata.product}-${metadata.version}-native-${metadata.target}-bundle.tar.gz`,
    ),
    npm: path.join(root, 'npm.tgz'),
    cargo: path.join(root, 'cargo'),
    manifest: path.join(root, 'manifest.json'),
    frozen: path.join(root, 'extension-artifacts.json'),
  },
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  validateNativeContribInputs(spec);
  assert.equal(spec.expectedMembers.length, 32);
  const members = spec.members.map((member) => {
    const construction =
      member.sqlName === 'pgcrypto'
        ? nativeExtensionConstructionLicenseInventory(member.sqlName, member.target)
        : [];
    const actual = {
      owner: member.owner,
      version: member.version,
      sql_name: member.sqlName,
      configuration: member.target,
      source_kind: 'postgres-contrib',
      postgres_source: member.source,
      default_version: member.contrib!['default-version'] ?? null,
      creates_extension: member.descriptor.lifecycle['create-extension'],
      dependencies: member.descriptor.dependencies,
      data_files: member.contrib!['data-files'] ?? [],
      sql_files: [],
      sql_prefixes: [],
      module_file: member.descriptor['native-module-file'],
      dependency_modules: [],
      construction_licenses: construction.map((row) => row.path),
    };
    const frozen = frozenNativeMember(member, actual);
    assert.equal(frozen.sqlName, member.sqlName);
    assert.equal(frozen.nativeModuleStem + '.so', member.contrib!['module-file']);
    assert.equal(frozen.createsExtension, member.sqlName !== 'auto_explain');
    for (const invalid of [
      { ...actual, owner: 'unrelated-owner' },
      { ...actual, version: '99.0.0' },
      { ...actual, postgres_source: {} },
      { ...actual, default_version: 'foreign' },
      { ...actual, data_files: ['share/postgresql/foreign'] },
      { ...actual, construction_licenses: ['share/licenses/foreign.txt'] },
    ])
      assert.throws(() => frozenNativeMember(member, invalid));
    const name = `${spec.product}-${spec.version}-native-${spec.target}-runtime.tar.gz`;
    const file = path.join(root, 'members', member.sqlName, name);
    mkdirSync(path.dirname(file), { recursive: true });
    // Opaque bytes exercise bundle assembly; installed qualification owns real ELF/SQL proof.
    const bytes = Buffer.from('canonical bundle member ' + member.sqlName);
    writeFileSync(file, bytes);
    return {
      ...frozen,
      assets: [
        {
          name,
          path: path.relative(root, file),
          family: 'native',
          target: spec.target,
          kind: 'runtime',
          identity: null,
          sha256: digest(bytes),
          bytes: bytes.length,
        },
      ],
    };
  });
  const run = (directory: string, values = structuredClone(members)) => {
    const productRoot = path.join(root, directory);
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    const assets = bundleCarrierAssets(
      spec.product,
      spec.version,
      productRoot,
      values,
      nativeCarrierCompatibility(spec),
      { root },
    );
    assert.equal(assets.length, 1);
    return { values, assets, file: path.join(root, assets[0].path) };
  };
  const first = run('first'),
    second = run('second', [...structuredClone(members)].reverse());
  assert.deepEqual(readFileSync(first.file), readFileSync(second.file));
  const archive = readPortableArchiveEntries(first.file);
  const prefix = path.basename(first.file, '.tar.gz');
  const bundle = JSON.parse(archive.get(`${prefix}/bundle-manifest.json`)!.data().toString('utf8'));
  assert.equal(bundle.licenseProfile, 'contrib-native-openssl');
  assert.deepEqual(
    bundle.members.map((row: any) => row.sqlName),
    spec.expectedMembers,
  );
  for (const member of first.values) {
    const asset = member.assets[0];
    assert.equal(asset.carrierAsset, first.assets[0].name);
    assert.equal(asset.carrierRoot, prefix);
    assert.equal(asset.memberPath, `extensions/${member.sqlName}/${asset.name}`);
    const entry = archive.get(`${prefix}/${asset.memberPath}`)!;
    assert.equal(entry.mode, 0o644);
    assert.equal(digest(entry.data()), asset.sha256);
    assert.equal(entry.data().length, asset.bytes);
  }
  assert.throws(() => validateNativeContribInputs({ ...spec, members: spec.members.slice(1) }));
  assert.throws(() =>
    validateNativeContribInputs({
      ...spec,
      members: [spec.members[0], ...spec.members.slice(0, -1)],
    }),
  );
  assert.throws(() => validateNativeContribInputs({ ...spec, version: '99.0.0' }));
  const missing = structuredClone(members);
  missing[0].assets = [];
  assert.throws(() => run('missing', missing), /missing exact members/);
  const changed = structuredClone(members);
  changed[0].assets[0].sha256 = '0'.repeat(64);
  assert.throws(() => run('changed', changed), /changed.*member bytes/);
  const escaping = structuredClone(members);
  escaping[0].assets[0].path = '../foreign';
  assert.throws(() => run('escaping', escaping), /root-relative/);
  assert.throws(() => run('duplicate', [members[0], ...members]), /must be unique/);
  console.log(
    'All 32 canonical contrib facts, runtime ownership, pinned construction legal receipt, exact nested locators and deterministic bundle bytes verified.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
