import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  machoFixture,
  windowsPeFixture,
} from '../../tools/packaging/testdata/release-fixture-utils.mts';
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
  () =>
    validateNativeShippingModule(
      Buffer.from('foreign module'),
      metadata.target,
      'lib/modules/foreign.so',
    ),
  /does not contain a recognized/,
);

for (const profile of ['postgresql', 'modules']) {
  const modulePath = `lib/${profile}/fixture.dylib`;
  const result = validateNativeShippingModule(machoFixture(), 'macos-arm64', modulePath);
  assert.equal(result.format, 'macho');
  assert.equal(result.slices[0].machine, 'arm64');
  assert.deepEqual(result.platforms, [1]);
  const bundle = machoFixture();
  bundle.writeUInt32LE(8, 12);
  assert.equal(validateNativeShippingModule(bundle, 'macos-arm64', modulePath).format, 'macho');
  for (const [bytes, expected] of [
    [machoFixture({ cpu: 0x01000007 }), /not arm64/u],
    [machoFixture({ cpuSubtype: 2 }), /not generic ARM64_ALL/u],
    [machoFixture({ platform: 2 }), /unsupported iOS/u],
    [machoFixture({ minos: [14, 0, 0] }), /minimum OS.*exceeds/u],
    [windowsPeFixture(), /PE content does not match/u],
  ] as const) {
    assert.throws(() => validateNativeShippingModule(bytes, 'macos-arm64', modulePath), expected);
  }
  const object = machoFixture();
  object.writeUInt32LE(1, 12);
  assert.throws(
    () => validateNativeShippingModule(object, 'macos-arm64', modulePath),
    /dylib or bundle/u,
  );
  assert.throws(
    () => validateNativeShippingModule(machoFixture(), 'macos-arm64', `lib/${profile}/fixture.so`),
    /unsupported configuration or layout/u,
  );
}

for (const [profile, provider, wrongProvider, expected] of [
  ['postgresql', 'postgres.exe', 'oliphaunt.dll', /standalone PostgreSQL extension DLLs/u],
  ['modules', 'oliphaunt.dll', 'postgres.exe', /embedded extension DLLs/u],
] as const) {
  const modulePath = `lib/${profile}/fixture.dll`;
  for (const imports of [[provider], ['KERNEL32.dll']]) {
    const result = validateNativeShippingModule(
      windowsPeFixture({ imports }),
      'windows-x64-msvc',
      modulePath,
    );
    assert.equal(result.format, 'pe');
    assert.equal(result.slices[0].machine, 'x64');
  }
  for (const importField of ['imports', 'delayImports']) {
    assert.throws(
      () =>
        validateNativeShippingModule(
          windowsPeFixture({ [importField]: [wrongProvider] }),
          'windows-x64-msvc',
          modulePath,
        ),
      expected,
    );
  }
  assert.throws(
    () =>
      validateNativeShippingModule(
        windowsPeFixture({ machine: 0xaa64 }),
        'windows-x64-msvc',
        modulePath,
      ),
    /PE machine.*not x64/u,
  );
  const executable = windowsPeFixture();
  executable.writeUInt16LE(0x22, executable.readUInt32LE(0x3c) + 4 + 18);
  assert.throws(
    () => validateNativeShippingModule(executable, 'windows-x64-msvc', modulePath),
    /must be a PE x64 DLL/u,
  );
  assert.throws(
    () => validateNativeShippingModule(machoFixture(), 'windows-x64-msvc', modulePath),
    /MACHO content does not match/u,
  );
  assert.throws(
    () =>
      validateNativeShippingModule(
        windowsPeFixture(),
        'windows-x64-msvc',
        `lib/${profile}/fixture.so`,
      ),
    /unsupported configuration or layout/u,
  );
}

const compiled = metadata.compiledMember;
assert.equal(compiled?.sqlName, 'pg_uuidv7', 'expected canonical compiled extension metadata');
assert.deepEqual(
  metadata.newCoreMember,
  compiled,
  'an unrelated core version must not adopt a new extension host',
);
const canonicalModule = compiled.descriptor['native-module-file'];
assert.equal(typeof canonicalModule, 'string');
assert(canonicalModule.endsWith('.so'));
const canonicalStem = canonicalModule.slice(0, -3);
const compiledArtifacts = compiled.recipe.artifacts ?? {};
for (const [target, suffix, wrongSuffix] of [
  ['macos-arm64', '.dylib', '.dll'],
  ['windows-x64-msvc', '.dll', '.dylib'],
] as const) {
  const spec = { ...compiled, target } as NativeCarrierSpec;
  const actual = {
    sql_name: compiled.sqlName,
    owner: compiled.owner ?? compiled.product,
    version: compiled.version,
    configuration: target,
    source_kind: compiled.descriptor['source-kind'],
    source: compiled.source,
    default_version: compiled.source['extension-control']['default-version'],
    creates_extension: compiled.descriptor.lifecycle['create-extension'],
    dependencies: compiled.descriptor.dependencies,
    data_files: compiledArtifacts.data_files ?? [],
    sql_files: compiledArtifacts.extension_sql_file_names ?? [],
    sql_prefixes: compiledArtifacts.extension_sql_file_prefixes ?? [],
    module_profiles: ['postgresql', 'modules'],
    module_file: canonicalStem + suffix,
    dependency_modules: [],
    construction_licenses: [],
  };
  assert.equal(frozenNativeMember(spec, actual).nativeModuleStem, canonicalStem);
  for (const module_file of [canonicalModule, canonicalStem + wrongSuffix, 'foreign' + suffix]) {
    assert.throws(() => frozenNativeMember(spec, { ...actual, module_file }));
  }
}

const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'extension-carrier-test-'));
try {
  for (const [target, os, cpu, libc] of [
    ['linux-x64-gnu', 'linux', 'x64', 'glibc'],
    ['linux-arm64-gnu', 'linux', 'arm64', 'glibc'],
    ['macos-arm64', 'darwin', 'arm64', null],
    ['windows-x64-msvc', 'win32', 'x64', null],
  ] as const) {
    const selected = { ...metadata, target };
    const directory = path.join(root, target);
    mkdirSync(directory, { recursive: true });
    const actual = {
      schema: 'oliphaunt-extension-member-payload-v1',
      sql_name: 'pgtap',
      owner: metadata.product,
      version: metadata.version,
      family: 'native',
      configuration: target,
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
    const control = path.join(directory, 'pgtap.control');
    const sql = path.join(directory, 'pgtap.sql');
    writeFileSync(control, `default_version = '${actual.default_version}'\nrelocatable = true\n`);
    writeFileSync(sql, 'SELECT 1;\n');
    const archive = path.join(directory, 'member.tar.gz');
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
      path.join(directory, 'inventory.json'),
    );
    const makeSpec = (directory: string): NativeCarrierSpec => ({
      ...selected,
      archive,
      outputs: {
        github: path.join(
          directory,
          `${metadata.product}-${metadata.version}-native-${target}-runtime.tar.gz`,
        ),
        npm: path.join(directory, 'npm.tgz'),
        cargo: path.join(directory, 'cargo'),
        manifest: path.join(directory, `${metadata.product}-${metadata.version}-manifest.json`),
        frozen: path.join(directory, 'extension-artifacts.json'),
      },
    });
    const spec = makeSpec(path.join(directory, 'first'));
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
      metadata.carriers.find((row: any) => row.ecosystem === 'npm' && row.target === target).name,
    );
    assert.equal(manifest.version, metadata.version);
    assert.equal(
      manifest.oliphaunt.liboliphauntVersion,
      metadata.compatibility.native_runtime_version,
    );
    assert.deepEqual(manifest.os, [os]);
    assert.deepEqual(manifest.cpu, [cpu]);
    assert.deepEqual(manifest.libc, libc === null ? undefined : [libc]);
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
      metadata.carriers.find((row: any) => row.ecosystem === 'cargo' && row.target === target).name,
    );
    assert.equal(cargo.package.version, metadata.version);
    assert(crate.has(`${crateRoot}/payload/share/postgresql/extension/pgtap.control`));
    assert(crate.has(`${crateRoot}/build.rs`));
    assert([...crate.keys()].some((name) => name.startsWith(`${crateRoot}/share/licenses/`)));
    const second = makeSpec(path.join(directory, 'second'));
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
      { ...actual, configuration: target === 'macos-arm64' ? 'linux-x64-gnu' : 'macos-arm64' },
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
  }
  console.log(
    'Native extension final envelopes preserve canonical identities, compatibility, legal files, payload layout and deterministic bytes.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
