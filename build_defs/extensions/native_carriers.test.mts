import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { assemble } from './member_payload.mts';
import {
  frozenNativeMember,
  type NativeCarrierSpec,
  packageNativeCarriers,
  validateNativeCarrierIdentities,
  validateNativeShippingModule,
} from './native_carriers.mts';

const [input] = process.argv.slice(2);
assert(input, 'expected canonical pgtap carrier metadata');
const metadata = JSON.parse(readFileSync(input, 'utf8'));
assert.throws(
  () => validateNativeShippingModule(Buffer.from('foreign module'), metadata.target),
  /does not contain a recognized/,
);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'extension-carrier-test-'));
try {
  const actual = {
    schema: 'oliphaunt-extension-member-payload-v1',
    sql_name: 'pgtap',
    owner: metadata.product,
    version: metadata.version,
    family: 'native',
    configuration: metadata.target,
    source_kind: metadata.descriptor['source-kind'],
    postgres_major: 18,
    default_version: metadata.source['extension-control']['default-version'],
    creates_extension: true,
    dependencies: metadata.descriptor.dependencies,
    module_profiles: [],
    module_file: '',
    dependency_modules: [],
    data_files: [],
    sql_prefixes: metadata.recipe.artifacts.extension_sql_file_prefixes ?? [],
    sql_files: metadata.recipe.artifacts.extension_sql_file_names ?? [],
    source: metadata.source,
  };
  const control = path.join(root, 'pgtap.control');
  const sql = path.join(root, 'pgtap.sql');
  writeFileSync(control, `default_version = '${actual.default_version}'\nrelocatable = true\n`);
  writeFileSync(sql, 'SELECT 1;\n');
  const archive = path.join(root, 'member.tar.gz');
  await assemble(
    {
      descriptor: actual,
      inputs: [
        { source: control, destination: 'share/postgresql/extension/pgtap.control' },
        {
          source: sql,
          destination: `share/postgresql/extension/pgtap--${actual.default_version}.sql`,
        },
        ...actual.sql_files.map((name: string) => ({
          source: sql,
          destination: 'share/postgresql/extension/' + name,
        })),
      ],
    },
    archive,
    path.join(root, 'inventory.json'),
  );
  const makeSpec = (directory: string): NativeCarrierSpec => ({
    ...metadata,
    archive,
    outputs: {
      github: path.join(
        directory,
        `${metadata.product}-${metadata.version}-native-${metadata.target}-runtime.tar.gz`,
      ),
      npm: path.join(directory, 'npm.tgz'),
      cargo: path.join(directory, 'cargo'),
      manifest: path.join(directory, `${metadata.product}-${metadata.version}-manifest.json`),
      frozen: path.join(directory, 'extension-artifacts.json'),
    },
  });
  const spec = makeSpec(path.join(root, 'first'));
  packageNativeCarriers(spec);
  const github = readPortableArchiveEntries(spec.outputs.github);
  assert(github.has('manifest.properties'));
  assert(github.has('files/share/postgresql/extension/pgtap.control'));
  assert(
    !github.has('extension.json'),
    'internal descriptor must not leak into public runtime layout',
  );
  const npm = readPortableArchiveEntries(spec.outputs.npm);
  const manifest = JSON.parse(npm.get('package/package.json')!.data().toString('utf8'));
  assert.equal(
    manifest.name,
    metadata.carriers.find((row: any) => row.ecosystem === 'npm' && row.target === metadata.target)
      .name,
  );
  assert.equal(manifest.version, metadata.version);
  assert.equal(
    manifest.oliphaunt.liboliphauntVersion,
    metadata.compatibility.native_runtime_version,
  );
  assert.deepEqual(manifest.os, ['linux']);
  assert.deepEqual(manifest.cpu, ['x64']);
  assert.deepEqual(manifest.libc, ['glibc']);
  assert(npm.has('package/extension-contract.json'));
  assert(npm.has('package/runtime/share/postgresql/extension/pgtap.control'));
  assert([...npm.keys()].some((name) => name.startsWith('package/runtime/share/licenses/')));
  const crates = readdirSync(spec.outputs.cargo).filter((name) => name.endsWith('.crate'));
  assert.equal(crates.length, 1);
  const crate = readPortableArchiveEntries(path.join(spec.outputs.cargo, crates[0]));
  const crateRoot = crates[0].slice(0, -'.crate'.length);
  const cargo = Bun.TOML.parse(crate.get(`${crateRoot}/Cargo.toml`)!.data().toString('utf8'));
  assert.equal(
    cargo.package.name,
    metadata.carriers.find(
      (row: any) => row.ecosystem === 'cargo' && row.target === metadata.target,
    ).name,
  );
  assert.equal(cargo.package.version, metadata.version);
  assert(crate.has(`${crateRoot}/payload/share/postgresql/extension/pgtap.control`));
  assert(crate.has(`${crateRoot}/build.rs`));
  assert([...crate.keys()].some((name) => name.startsWith(`${crateRoot}/share/licenses/`)));
  const second = makeSpec(path.join(root, 'second'));
  packageNativeCarriers(second);
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(digest(spec.outputs.github), digest(second.outputs.github));
  assert.equal(digest(spec.outputs.npm), digest(second.outputs.npm));
  assert.equal(digest(spec.outputs.manifest), digest(second.outputs.manifest));
  assert.equal(digest(spec.outputs.frozen), digest(second.outputs.frozen));
  assert.equal(
    digest(path.join(spec.outputs.cargo, crates[0])),
    digest(path.join(second.outputs.cargo, crates[0])),
  );
  for (const invalid of [
    { ...actual, version: '99.0.0' },
    { ...actual, configuration: 'macos-arm64' },
    { ...actual, source: { ...actual.source, commit: '0'.repeat(40) } },
    { ...actual, dependency_modules: ['foreign.so'] },
    { ...actual, construction_licenses: ['share/licenses/foreign.txt'] },
  ])
    assert.throws(() => frozenNativeMember(spec, invalid));
  assert.throws(() =>
    validateNativeCarrierIdentities({
      ...spec,
      carriers: spec.carriers.filter((row) => row.ecosystem !== 'cargo'),
    }),
  );
  assert.throws(() =>
    validateNativeCarrierIdentities({
      ...spec,
      outputs: { ...spec.outputs, github: path.join(root, 'wrong.tar.gz') },
    }),
  );
  console.log(
    'Native extension final envelopes preserve canonical identities, compatibility, legal files, payload layout and deterministic bytes.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
