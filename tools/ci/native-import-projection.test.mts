import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import {
  projectNativeAppleBaseInput,
  projectNativeCurrentArtifacts,
  projectNativeSwiftSourceInput,
} from '../release/native-extension-final-inputs.mts';
import { fileIdentity } from '../release/native-file-identity.mts';
import {
  createNativeImportProjection,
  nativeImportProjection,
} from './native-import-projection.mts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Controlled physical transport fixtures never acquire authenticated-origin capabilities. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'native-import-projection-'));
  directories.push(root);
  const executionRoot = path.join(root, 'execroot');
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const write = (file: string, bytes: string | Buffer) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  };
  const original = (name: string, bytes: Buffer, shipping: string) => {
    const file = write(path.join(root, 'original', name), bytes);
    const identity = fileIdentity(file);
    return {
      path: file,
      size: identity.size,
      sha256: identity.sha256,
      producer: {
        evidenceDigest: `sha256:${'c'.repeat(64)}`,
        invocationId: 'controlled-wasix-producer',
        root: shipping,
        configuration: 'd'.repeat(64),
        output: `bazel-out/producer/bin/${name}`,
      },
    };
  };
  const cargo = (name: string) => {
    const prefix = `${name}-1.0.0`;
    return original(
      `${prefix}.crate`,
      tarArchive([
        { name: `${prefix}/Cargo.toml`, data: `[package]\nname = "${name}"\nversion = "1.0.0"\n` },
        { name: `${prefix}/src/lib.rs`, data: `pub fn ${name.replaceAll('-', '_')}() {}\n` },
      ]),
      `//producer:${name.replaceAll('-', '_')}_shipping`,
    );
  };
  const core = cargo('fixture-core');
  const contrib = cargo('fixture-contrib');
  const archive = original(
    'fixture-runtime-1.0.0.tar.gz',
    tarArchive([{ name: 'payload/runtime', data: 'controlled public runtime payload' }]),
    '//producer:public_archive_shipping',
  );
  const artifact = (file: typeof core, identity: string) => ({
    product: 'fixture-runtime',
    version: '1.0.0',
    artifact: identity,
    configuration: 'portable',
    source,
    file,
  });
  const snapshot = {
    source,
    supplierArtifacts: [] as any[],
    nativeCurrentArtifacts: [
      artifact(core, 'cargo:fixture-core'),
      artifact(contrib, 'cargo:fixture-contrib'),
      artifact(archive, 'github-release:fixture-runtime-1.0.0.tar.gz'),
    ],
  };
  const metadataRepository = '_main+metadata+oliphaunt_metadata';
  const metadata = projectNativeCurrentArtifacts(snapshot.nativeCurrentArtifacts, source);
  for (const alias of metadata.files)
    write(
      path.join(executionRoot, 'external', metadataRepository, alias.path),
      readFileSync(alias.source),
    );
  const metadataCore = metadata.files.find((alias) => alias.source === core.path)!;
  const metadataLabel = `@@${metadataRepository}//:${metadataCore.path}`;
  const guestRepository = '_main+postmaster+postmaster_guest';
  const guestMember = `release-archives/fixture-runtime/${path.basename(archive.path)}`;
  const guestPath = write(
    path.join(executionRoot, 'external', guestRepository, guestMember),
    readFileSync(archive.path),
  );
  const guestLabel = `@@${guestRepository}//:${guestMember}`;
  const runtimeRepository = '_main+runtime+wasix_runtime_carriers';
  const runtimeRoot = path.join(executionRoot, 'external', runtimeRepository);
  write(path.join(runtimeRoot, 'Cargo.toml'), '[workspace]\nmembers = ["crates/core"]\n');
  write(
    path.join(runtimeRoot, 'crates/core/Cargo.toml'),
    '[package]\nname = "fixture-core"\nversion = "1.0.0"\n',
  );
  write(path.join(runtimeRoot, 'crates/core/src/lib.rs'), 'pub fn fixture_core() {}\n');
  const extractedLabel = `@@${runtimeRepository}//crates/core:src/lib.rs`;
  const hostSmokeMember = `host-smoke/${path.basename(contrib.path)}`;
  const hostSmokePath = write(path.join(runtimeRoot, hostSmokeMember), readFileSync(contrib.path));
  const hostSmokeLabel = `@@${runtimeRepository}//:${hostSmokeMember}`;
  const wasixCargoInputs = path.join(root, 'cargo-receipt');
  const receiptRow = (name: string, file: typeof core) => ({
    name,
    version: '1.0.0',
    path: path.basename(file.path),
    size: file.size,
    sha256: file.sha256,
  });
  const receipt = {
    schema: 'oliphaunt-wasix-cargo-construction-v1',
    source,
    crates: [receiptRow('fixture-core', core)],
    hostSmokeCrates: [receiptRow('fixture-contrib', contrib)],
  };
  for (const file of [core, contrib])
    write(path.join(wasixCargoInputs, path.basename(file.path)), readFileSync(file.path));
  const saveReceipt = () =>
    write(path.join(wasixCargoInputs, 'receipt.json'), JSON.stringify(receipt));
  saveReceipt();
  const inspect = (labels: string[]) =>
    nativeImportProjection({ snapshot, source, labels, executionRoot, wasixCargoInputs });
  return {
    snapshot,
    source,
    executionRoot,
    wasixCargoInputs,
    inspect,
    receipt,
    saveReceipt,
    core,
    contrib,
    archive,
    metadataLabel,
    guestLabel,
    guestPath,
    extractedLabel,
    hostSmokeLabel,
    hostSmokePath,
    runtimeRoot,
    metadataRepository,
    metadataCore,
    original,
    write,
  };
}

function completed(
  file: { path: string; size: number; sha256: string },
  product = 'fixture-runtime',
  artifact = `github-release:${path.basename(file.path)}`,
) {
  return {
    publication: {
      product,
      version: '1.0.0',
      tagName: `${product}-v1.0.0`,
      publicationSha: '1'.repeat(40),
      publicationTree: '2'.repeat(40),
      releaseSha: '3'.repeat(40),
    },
    artifact,
    file: { path: file.path, size: file.size, sha256: file.sha256 },
  };
}

function heldDescriptor(row: ReturnType<typeof completed>) {
  return {
    ...row,
    file: {
      ...row.file,
      path: `@oliphaunt_metadata//:supplier-artifacts/${row.publication.product}/${row.publication.version}/${row.file.sha256}/${path.basename(row.file.path)}`,
    },
  };
}

test('metadata File aliases retain only the original producer actually reached by the consumer', () => {
  const f = fixture();
  assert.deepEqual(f.inspect([f.metadataLabel]), [f.core.producer]);
  assert.deepEqual(f.inspect([f.metadataLabel, f.metadataLabel]), [f.core.producer]);
});

test('one capture projector keeps independent root slices while sharing original File verification', () => {
  const f = fixture();
  const project = createNativeImportProjection(f);
  assert.deepEqual(project([f.metadataLabel]), [f.core.producer]);
  assert.deepEqual(project([f.guestLabel]), [f.archive.producer]);
  assert.deepEqual(project([]), []);
  assert.deepEqual(project([f.metadataLabel]), [f.core.producer]);
});

test('public checksum archive aliases inherit their original producer without suppressing aggregate lineage', () => {
  const f = fixture();
  assert.deepEqual(f.inspect([f.guestLabel]), [f.archive.producer]);
});

test('the single postmaster guest archive also retains its actual original producer', () => {
  const f = fixture();
  const repository = '_main+postmaster+postmaster_guest';
  f.write(
    path.join(f.executionRoot, 'external', repository, path.basename(f.archive.path)),
    readFileSync(f.archive.path),
  );
  assert.deepEqual(f.inspect([`@@${repository}//:${path.basename(f.archive.path)}`]), [
    f.archive.producer,
  ]);
});

test('held checksum archives skip current lineage and unknown archives fail closed', () => {
  const f = fixture();
  f.snapshot.nativeCurrentArtifacts.pop();
  f.snapshot.supplierArtifacts.push(completed(f.archive));
  assert.deepEqual(f.inspect([f.guestLabel]), []);
  f.snapshot.supplierArtifacts.length = 0;
  assert.throws(() => f.inspect([f.guestLabel]), /original current producer/u);
});

test('a copied archive with ambiguous held and current origins cannot invent current lineage', () => {
  const f = fixture();
  f.snapshot.supplierArtifacts.push(completed(f.archive));
  assert.throws(() => f.inspect([f.guestLabel]), /unambiguous/u);
});

test('captured native Apple members use the existing role descriptor and skip completed inputs', () => {
  const f = fixture();
  const native = {
    owner: 'liboliphaunt-native',
    version: '1.0.0',
    file: f.original(
      'ios.json',
      Buffer.from('{}'),
      '//src/native/runtime:apple_ios_manifest_shipping',
    ),
    framework: f.original(
      'liboliphaunt-1.0.0-apple-spm-xcframework.zip',
      Buffer.from('controlled framework'),
      '//src/native/runtime:apple_swiftpm_shipping',
    ),
    resources: f.original(
      'liboliphaunt-1.0.0-runtime-resources-ios-datum64.tar.gz',
      Buffer.from('controlled resources'),
      '//src/native/runtime:apple_resources_shipping',
    ),
  };
  Reflect.set(f.snapshot, 'nativeAppleBase', native);
  const projected = projectNativeAppleBaseInput(native).input;
  const repository = '_main+apple+react_native_native_base';
  const directory = path.join(f.executionRoot, 'external', repository);
  f.write(
    path.join(directory, 'framework.json'),
    JSON.stringify({ owner: native.owner, version: native.version, file: projected.framework }),
  );
  f.write(path.join(directory, 'framework/fixture.h'), 'controlled validated extracted header');
  const label = `@@${repository}//framework:fixture.h`;
  assert.deepEqual(f.inspect([label]), [native.framework.producer]);
  const held = completed(native.framework, native.owner);
  f.snapshot.supplierArtifacts.push(held);
  f.write(path.join(directory, 'framework.json'), JSON.stringify(heldDescriptor(held)));
  assert.deepEqual(f.inspect([label]), []);
  held.file.sha256 = 'f'.repeat(64);
  assert.throws(() => f.inspect([label]), /completed original File/u);
});

test('captured Swift source and bindings retain only their reached original descriptor Files', () => {
  const f = fixture();
  const swift = {
    owner: 'oliphaunt-swift',
    version: '1.0.0',
    archive: f.original(
      'Oliphaunt-source.zip',
      Buffer.from('controlled source'),
      '//producer:swift_source_shipping',
    ),
    carrier: f.original(
      'oliphaunt-react-native-ios-carriers.json',
      Buffer.from(
        JSON.stringify({
          schema: 'oliphaunt-react-native-ios-carrier-v1',
          base: {
            product: 'liboliphaunt-native',
            version: '1.0.0',
            tag: 'liboliphaunt-native-v1.0.0',
          },
          extensions: [],
          carriers: [],
        }),
      ),
      '//producer:swift_carrier_shipping',
    ),
    ownerCatalog: f.original(
      'extension-owner-catalog.json',
      Buffer.from('{}'),
      '//producer:swift_owner_catalog_shipping',
    ),
    bindingsArchive: f.original(
      'oliphaunt-swift-1.0.0-bindings.xcframework.zip',
      Buffer.from('controlled bindings'),
      '//src/native/sdks/swift:shipping_bindings',
    ),
  };
  Reflect.set(f.snapshot, 'nativeSwiftSource', swift);
  const projected = projectNativeSwiftSourceInput(swift).input;
  const repository = '_main+apple+react_native_swift_package';
  const directory = path.join(f.executionRoot, 'external', repository);
  f.write(
    path.join(directory, 'source.json'),
    JSON.stringify({ ...projected, carrier: { ...projected.carrier, path: swift.carrier.path } }),
  );
  f.write(
    path.join(directory, 'bindings.json'),
    JSON.stringify({ file: projected.bindingsArchive }),
  );
  f.write(path.join(directory, 'Sources/Fixture.swift'), 'controlled validated extracted Swift');
  f.write(
    path.join(directory, 'OliphauntNativeBindingsFFI.xcframework/fixture.h'),
    'controlled validated extracted binding',
  );
  const sourceLabel = `@@${repository}//Sources:Fixture.swift`;
  const bindingLabel = `@@${repository}//OliphauntNativeBindingsFFI.xcframework:fixture.h`;
  const project = createNativeImportProjection(f);
  assert.deepEqual(project([sourceLabel]), [swift.carrier.producer, swift.archive.producer]);
  assert.deepEqual(project([bindingLabel]), [swift.bindingsArchive.producer]);
  assert.deepEqual(project([sourceLabel]), [swift.carrier.producer, swift.archive.producer]);
  const held = completed(swift.bindingsArchive, swift.owner);
  f.snapshot.supplierArtifacts.push(held);
  f.write(path.join(directory, 'bindings.json'), JSON.stringify(heldDescriptor(held)));
  assert.deepEqual(f.inspect([bindingLabel]), []);
  const heldSource = {
    ...completed(swift.archive, swift.owner, 'swift-source-tag:1.0.0'),
    source: {
      commit: '4'.repeat(40),
      tree: '5'.repeat(40),
      member: 'carrier.json',
      blob: '6'.repeat(40),
    },
  };
  f.snapshot.supplierArtifacts.push(heldSource);
  f.write(
    path.join(directory, 'source.json'),
    JSON.stringify({ ...heldDescriptor(heldSource), source: heldSource.source }),
  );
  assert.deepEqual(f.inspect([sourceLabel]), []);
  const tampered = {
    ...projected,
    archive: {
      ...projected.archive,
      producer: { ...projected.archive.producer, invocationId: 'invented' },
    },
  };
  f.write(path.join(directory, 'source.json'), JSON.stringify(tampered));
  assert.throws(() => f.inspect([sourceLabel]), /original producer File/u);
});

test('extracted runtime Cargo sources and host-smoke archive copies bind the original receipt Files', () => {
  const f = fixture();
  assert.deepEqual(f.inspect([f.extractedLabel]), [f.core.producer]);
  assert.deepEqual(f.inspect([f.hostSmokeLabel]), [f.contrib.producer]);
});

test('completed-publication metadata aliases do not inherit current producer sources', () => {
  const f = fixture();
  const held = completed(f.core, 'fixture-runtime', 'cargo:fixture-core');
  f.snapshot.supplierArtifacts.push(held);
  const member = heldDescriptor(held).file.path.split('//:')[1];
  f.write(
    path.join(f.executionRoot, 'external', f.metadataRepository, member),
    readFileSync(f.core.path),
  );
  assert.deepEqual(f.inspect([`@@${f.metadataRepository}//:${member}`]), []);
});

for (const fault of [
  'source',
  'receipt-hash',
  'receipt-name',
  'missing-original',
  'duplicate-receipt',
  'extracted-package',
  'copied-crate',
] as const)
  test(`WASIX source lineage fails closed: ${fault}`, () => {
    const f = fixture();
    if (fault === 'source') f.receipt.source = { ...f.source, commit: 'f'.repeat(40) };
    if (fault === 'receipt-hash') f.receipt.crates[0].sha256 = 'f'.repeat(64);
    if (fault === 'receipt-name') f.receipt.crates[0].name = 'invented';
    if (fault === 'missing-original') f.snapshot.nativeCurrentArtifacts.shift();
    if (fault === 'duplicate-receipt')
      f.receipt.hostSmokeCrates.push(structuredClone(f.receipt.crates[0]));
    if (fault === 'extracted-package')
      writeFileSync(
        path.join(f.runtimeRoot, 'crates/core/Cargo.toml'),
        '[package]\nname = "invented"\nversion = "1.0.0"\n',
      );
    if (fault === 'copied-crate')
      writeFileSync(path.join(f.wasixCargoInputs, f.receipt.crates[0].path), 'substituted');
    f.saveReceipt();
    assert.throws(() => f.inspect([f.extractedLabel]));
  });

test('missing receipt, unknown current alias and archive substitutions cannot become lineage', () => {
  const f = fixture();
  assert.throws(() =>
    nativeImportProjection({
      snapshot: f.snapshot,
      source: f.source,
      labels: [f.extractedLabel],
      executionRoot: f.executionRoot,
    }),
  );
  assert.throws(
    () => f.inspect([`@@${f.metadataRepository}//:native-current-artifacts/missing`]),
    /original producer/u,
  );
  for (const [label, file] of [
    [
      f.metadataLabel,
      path.join(f.executionRoot, 'external', f.metadataRepository, f.metadataCore.path),
    ],
    [f.guestLabel, f.guestPath],
    [f.hostSmokeLabel, f.hostSmokePath],
  ]) {
    writeFileSync(file, 'substituted');
    assert.throws(() => f.inspect([label]), /original.*producer/u);
  }
});
