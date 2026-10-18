import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import { createDeterministicTar } from '../packaging/archive-directory.mts';
import type { ExtensionFinalInputFile } from './native-extension-final-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import { projectPreparedNativePublicationPlan } from './native-freeze-publication-candidate.mts';
import {
  acquirePreparedNativeReleaseInputs,
  assertAcquiredPreparedNativeReleaseInputs,
  importPublicNativePublicationInputs,
  type NativeReleaseFinalInputs,
  parseNativeReleaseInputRecord,
  relocateNativeReleaseInputs,
  resolveNativeReleaseInputContext,
  transportPublicNativePublicationInputs,
  writeNativeReleaseInputs,
} from './native-release-inputs.mts';
import {
  nativeArchiveConstructionFinalInputs,
  nativeConstructorProducerArtifacts,
  writeNativeConstructionInputSnapshot,
} from './native-release-preparation.mts';
import {
  collectNativeVersionUpdates,
  commitNativeVersionUpdates,
} from './native-version-source.mts';
import { loadProducts } from './release-graph.mts';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'native-release-inputs-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(
    path.join(root, 'release-please-config.json'),
    JSON.stringify({
      'changelog-sections': [{ type: 'feat', section: 'Features' }],
      packages: { 'src/database-resources': { component: 'database-resources' } },
    }),
  );
  const manifest = path.join(root, '.release-please-manifest.json');
  writeFileSync(manifest, '{"src/database-resources":"0.2.2"}\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'source',
  );
  const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  const collector = collectNativeVersionUpdates();
  const before = readFileSync(manifest);
  const after = Buffer.from('{"src/database-resources":"0.2.3"}\n');
  writeFileSync(manifest, after);
  collector.observe({ path: '.release-please-manifest.json', before, after });
  const bridge = collector.freeze(source);
  const preparedSource = commitNativeVersionUpdates(
    bridge,
    'chore(release): prepare main releases',
    root,
  );
  const record = {
    bridge,
    selectedProducts: ['database-resources'],
    preparedSource,
    buildBound: Object.keys(loadProducts())
      .sort()
      .map((id) => [id, []] as [string, string[]]),
  };
  const seedRoot = path.join(root, 'constructor');
  const pgdata = path.join(seedRoot, 'pgdata');
  const contract = JSON.parse(
    readFileSync(
      new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
      'utf8',
    ),
  );
  for (const directory of contract.pgdataDirectories)
    mkdirSync(path.join(pgdata, directory), { recursive: true });
  writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
  writeFileSync(path.join(pgdata, 'global/pg_control'), 'original control bytes\n');
  writeFileSync(path.join(pgdata, 'pg_wal/000000010000000000000001'), 'original WAL bytes\n');
  const tool = path.join(seedRoot, 'constructor.mts');
  writeFileSync(tool, 'declared constructor input\n');
  const slot = { family: 'native' as const, target: 'linux-x64-gnu', profile: 'standard' as const };
  const intent = captureSeedConstructionIntent(slot, { command: 'fixture' }, { tool });
  const frozen = path.join(seedRoot, 'seed.tar');
  const receipt = path.join(seedRoot, 'seed.seed-construction.json');
  writeFileSync(frozen, await createDeterministicTar(pgdata));
  writeSeedConstructionReceipt(receipt, intent, frozen, pgdata);
  const file = (file: string) => {
    const actual = fileIdentity(file);
    return { path: file, size: actual.size, sha256: actual.sha256 };
  };
  const controls = [
    {
      ...slot,
      promotion: {
        source,
        evidenceDigest: `sha256:${'a'.repeat(64)}`,
        invocationId: 'fixture-invocation',
        frozen: file(frozen),
        receipt: file(receipt),
        transition: { source: preparedSource, updatesSha256: bridge.updatesSha256 },
      },
    },
  ];
  const capsule = path.join(root, 'native-release-inputs');
  writeNativeReleaseInputs(capsule, record, controls, []);
  return {
    root,
    git,
    record,
    controls,
    capsule,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function finalInputsFixture(root: string): Required<NativeReleaseFinalInputs> {
  const directory = path.join(root, 'original-final-files');
  mkdirSync(directory);
  const file = (
    name: string,
    label: string,
    contents = `original ${name}\n`,
    member?: string,
  ): ExtensionFinalInputFile => {
    const absolute = path.join(directory, name);
    writeFileSync(absolute, contents);
    const { size, sha256 } = fileIdentity(absolute);
    return {
      path: absolute,
      size,
      sha256,
      producer: {
        evidenceDigest: `sha256:${'a'.repeat(64)}`,
        invocationId: 'original-constructor-invocation',
        root: label,
        configuration: 'b'.repeat(64),
        output: `bazel-out/original/bin/${name}`,
      },
      ...(member === undefined ? {} : { member }),
    };
  };
  return {
    extensionFinalInputs: [
      {
        product: 'pg-hashids',
        owner: 'pg-hashids',
        version: '0.1.0',
        family: 'native',
        target: 'linux-x64-gnu',
        github: [
          file(
            'pg-hashids-0.1.0-linux-x64-gnu.tar.gz',
            '//src/extensions/pg_hashids:shipping_github',
            undefined,
            'archives/pg-hashids-0.1.0-linux-x64-gnu.tar.gz',
          ),
        ],
        npm: [file('pg-hashids-0.1.0.tgz', '//src/extensions/pg_hashids:shipping_npm')],
        cargo: [file('pg-hashids-0.1.0.crate', '//src/extensions/pg_hashids:shipping_cargo')],
        manifest: file('pg-hashids-release.json', '//src/extensions/pg_hashids:shipping_manifest'),
        frozen: file('pg-hashids-frozen.json', '//src/extensions/pg_hashids:shipping_frozen'),
      },
    ],
    nativeAppleBase: {
      owner: 'liboliphaunt-native',
      version: '0.3.3',
      file: file('ios.json', '//src/native/runtime:apple_ios_manifest_shipping'),
      framework: file(
        'liboliphaunt-0.3.3-apple-spm-xcframework.zip',
        '//src/native/runtime:apple_swiftpm_shipping',
      ),
      resources: file(
        'liboliphaunt-0.3.3-runtime-resources-ios-datum64.tar.gz',
        '//src/native/runtime:apple_resources_shipping',
      ),
    },
    nativeSwiftSource: {
      owner: 'oliphaunt-swift',
      version: '0.8.2',
      archive: file(
        'Oliphaunt-source.zip',
        '//src/native/sdks/swift:shipping_Oliphaunt-source_zip',
      ),
      carrier: file(
        'oliphaunt-react-native-ios-carriers.json',
        '//src/native/sdks/swift:shipping_oliphaunt-react-native-ios-carriers_json',
        JSON.stringify({
          schema: 'oliphaunt-react-native-ios-carrier-v1',
          base: {
            product: 'liboliphaunt-native',
            version: '0.3.3',
            tag: 'liboliphaunt-native-v0.3.3',
          },
          extensions: [],
          carriers: [],
        }),
        'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
      ),
      ownerCatalog: file(
        'extension-owner-catalog.json',
        '//src/native/sdks/swift:shipping_extension-owner-catalog_json',
      ),
      bindingsArchive: file(
        'oliphaunt-swift-0.8.2-bindings.xcframework.zip',
        '//src/native/sdks/swift:shipping_bindings',
      ),
    },
  };
}

function finalFiles(inputs: NativeReleaseFinalInputs): ExtensionFinalInputFile[] {
  return [
    ...(inputs.nativeCurrentArtifacts ?? []).map((row) => row.file),
    ...(inputs.extensionFinalInputs ?? []).flatMap((row) => [
      ...row.github,
      ...row.npm,
      ...row.cargo,
      row.manifest,
      row.frozen,
    ]),
    ...(inputs.nativeAppleBase
      ? [
          inputs.nativeAppleBase.file,
          inputs.nativeAppleBase.framework,
          inputs.nativeAppleBase.resources,
        ]
      : []),
    ...(inputs.nativeSwiftSource
      ? [
          inputs.nativeSwiftSource.archive,
          inputs.nativeSwiftSource.carrier,
          inputs.nativeSwiftSource.ownerCatalog,
          inputs.nativeSwiftSource.bindingsArchive,
        ]
      : []),
  ];
}

test('native publication scope and versions project the exact Prepare transition without a second ownership graph', async () => {
  const f = await fixture();
  try {
    expect(projectPreparedNativePublicationPlan(f.record, f.record.preparedSource, f.root)).toEqual(
      {
        mode: 'release-bump',
        publicationSha: f.record.preparedSource.commit,
        releaseSha: f.record.preparedSource.commit,
        products: ['database-resources'],
        versions: { 'database-resources': '0.2.3' },
      },
    );
    expect(() =>
      projectPreparedNativePublicationPlan(
        f.record,
        { ...f.record.preparedSource, tree: 'f'.repeat(40) },
        f.root,
      ),
    ).toThrow(/prepared tree/u);
    expect(() =>
      projectPreparedNativePublicationPlan(
        { ...f.record, selectedProducts: ['oliphaunt-query'] },
        f.record.preparedSource,
        f.root,
      ),
    ).toThrow(/actual RP scope/u);
    expect(() => assertAcquiredPreparedNativeReleaseInputs(f.record)).toThrow(
      /authenticated Prepare/u,
    );
  } finally {
    f.cleanup();
  }
});

test('native release source guard checks ownership and the normalized parent without recalculating suppliers', async () => {
  const f = await fixture();
  try {
    const run = (branch: string, head = f.record.preparedSource.commit) =>
      spawnSync(
        'bash',
        [
          path.resolve(import.meta.dir, '../../.github/scripts/check-release-intent.sh'),
          'chore(release): prepare main releases',
          f.record.bridge.source.commit,
          head,
          branch,
          'pull_request',
          'refs/pull/17/merge',
          '--source-policy-only',
        ],
        {
          cwd: f.root,
          env: {
            ...process.env,
            PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
            MOON_BIN: '/definitely-unavailable-moon',
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
    const generated = run('release-please--branches--main');
    expect(generated.status, generated.stderr).toBe(0);
    const authored = run('feature');
    expect(authored.status).not.toBe(0);
    expect(authored.stderr).toContain('manifest version bumps are release owned');
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'extra',
    );
    const extra = run('release-please--branches--main', f.git('rev-parse', 'HEAD'));
    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain('one normalized release-bump commit');
  } finally {
    f.cleanup();
  }
});

test('public seed facts transport once and relocate for the exact source without prepared authority', async () => {
  const f = await fixture();
  try {
    const publication = {
      product: 'database-resources',
      version: '0.2.2',
      tagName: 'database-resources-v0.2.2',
      publicationSha: 'a'.repeat(40),
      publicationTree: 'b'.repeat(40),
      releaseSha: 'c'.repeat(40),
    };
    const raw = path.join(f.root, 'public.json');
    const snapshot = {
      source: f.record.bridge.source,
      seedControls: f.controls.map(({ promotion, ...slot }) => ({
        ...slot,
        reuse: {
          operation: 'adopt',
          publication,
          archive: promotion.frozen,
          manifest: promotion.receipt,
        },
      })),
      supplierPublications: [publication],
    };
    writeFileSync(raw, JSON.stringify(snapshot));
    const exported = path.join(f.root, 'public-export');
    transportPublicNativePublicationInputs(raw, exported, f.record.bridge.source);
    const destination = path.join(f.root, 'public-downloaded');
    cpSync(exported, destination, { recursive: true });
    rmSync(path.join(f.root, 'constructor'), { recursive: true });
    const importedFile = importPublicNativePublicationInputs(destination, f.record.bridge.source);
    const imported = JSON.parse(readFileSync(importedFile, 'utf8'));
    expect(imported.source).toEqual(f.record.bridge.source);
    expect(imported.seedControls[0].reuse.archive.path).toStartWith(destination);
    expect(imported.seedControls[0].reuse.archive.sha256).toBe(
      snapshot.seedControls[0].reuse.archive.sha256,
    );
    expect(imported.supplierPublications).toEqual([publication]);
    expect(() => assertAcquiredPreparedNativeReleaseInputs(imported)).toThrow(
      'authenticated Prepare',
    );
    expect(() => importPublicNativePublicationInputs(destination, f.record.preparedSource)).toThrow(
      'source differs',
    );
    writeFileSync(imported.seedControls[0].reuse.archive.path, 'changed public seed');
    expect(() => importPublicNativePublicationInputs(destination, f.record.bridge.source)).toThrow(
      'File bytes differ',
    );
    writeFileSync(
      raw,
      JSON.stringify({ ...snapshot, supplierPublications: [publication, publication] }),
    );
    expect(() =>
      transportPublicNativePublicationInputs(
        raw,
        path.join(f.root, 'bad-public'),
        f.record.bridge.source,
      ),
    ).toThrow('duplicated');
    writeFileSync(raw, JSON.stringify({ ...snapshot, seedControls: f.controls }));
    expect(() =>
      transportPublicNativePublicationInputs(
        raw,
        path.join(f.root, 'bad-promotion'),
        f.record.bridge.source,
      ),
    ).toThrow('cannot promote');
  } finally {
    f.cleanup();
  }
});

test('retained suppliers share the existing public and prepared File pool, relocate by digest, and never authenticate serialized origins', async () => {
  const f = await fixture();
  try {
    const publication = {
      product: 'liboliphaunt-wasix',
      version: '0.3.2',
      tagName: 'liboliphaunt-wasix-v0.3.2',
      publicationSha: 'a'.repeat(40),
      publicationTree: 'b'.repeat(40),
      releaseSha: 'c'.repeat(40),
    };
    const original = path.join(f.root, 'retained-supplier.crate');
    writeFileSync(original, 'opaque retained stream fixture');
    const actual = fileIdentity(original);
    const supplierArtifacts = [
      {
        publication,
        artifact: 'cargo:liboliphaunt-wasix-portable',
        file: { path: original, size: actual.size, sha256: actual.sha256 },
      },
    ];
    const raw = path.join(f.root, 'supplier-public.json');
    writeFileSync(
      raw,
      JSON.stringify({
        source: f.record.bridge.source,
        seedControls: [],
        supplierPublications: [publication],
        supplierArtifacts,
      }),
    );
    const exported = path.join(f.root, 'supplier-public-export');
    transportPublicNativePublicationInputs(raw, exported, f.record.bridge.source);
    const prepared = path.join(f.root, 'supplier-prepared');
    writeNativeReleaseInputs(prepared, f.record, f.controls, [publication], supplierArtifacts);
    const downloaded = path.join(f.root, 'supplier-downloaded');
    cpSync(exported, downloaded, { recursive: true });
    rmSync(original);
    const imported = JSON.parse(
      readFileSync(importPublicNativePublicationInputs(downloaded, f.record.bridge.source), 'utf8'),
    );
    expect(imported.supplierArtifacts[0].publication).toEqual(publication);
    expect(imported.supplierArtifacts[0].file.path).toStartWith(
      path.join(downloaded, 'files', actual.sha256),
    );
    expect(readFileSync(imported.supplierArtifacts[0].file.path, 'utf8')).toBe(
      'opaque retained stream fixture',
    );
    expect(() => assertAcquiredPreparedNativeReleaseInputs(imported)).toThrow(
      'authenticated Prepare',
    );
    const relocated = relocateNativeReleaseInputs(prepared, f.record);
    expect(relocated.supplierArtifacts[0].file.path).toStartWith(
      path.join(prepared, 'files', actual.sha256),
    );
    expect(relocated.supplierArtifacts[0].publication).toEqual(publication);
    writeFileSync(imported.supplierArtifacts[0].file.path, 'substituted supplier');
    expect(() => importPublicNativePublicationInputs(downloaded, f.record.bridge.source)).toThrow(
      'supplier File bytes differ',
    );
    const snapshot = JSON.parse(
      readFileSync(path.join(prepared, 'native-publication-inputs.json'), 'utf8'),
    );
    snapshot.supplierPublications[0].publicationTree = 'd'.repeat(40);
    writeFileSync(path.join(prepared, 'native-publication-inputs.json'), JSON.stringify(snapshot));
    expect(() => relocateNativeReleaseInputs(prepared, f.record)).toThrow(
      'supplier origin differs',
    );
  } finally {
    f.cleanup();
  }
});

test('public and prepared final constructor facts relocate every File through the existing pool without producer authority', async () => {
  const f = await fixture();
  try {
    const finalInputs = finalInputsFixture(f.root);
    const originals = finalFiles(finalInputs);
    const publication = {
      product: 'oliphaunt-swift',
      version: '0.8.2',
      tagName: 'oliphaunt-swift-v0.8.2',
      publicationSha: 'c'.repeat(40),
      publicationTree: 'd'.repeat(40),
      releaseSha: 'e'.repeat(40),
    };
    const supplier = {
      publication,
      artifact: 'swift-source-tag:0.8.2',
      source: {
        commit: 'f'.repeat(40),
        tree: '1'.repeat(40),
        member: 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
        blob: '2'.repeat(40),
      },
      file: {
        path: finalInputs.nativeSwiftSource.archive.path,
        size: finalInputs.nativeSwiftSource.archive.size,
        sha256: finalInputs.nativeSwiftSource.archive.sha256,
      },
    };
    const raw = path.join(f.root, 'final-public.json');
    writeFileSync(
      raw,
      JSON.stringify({
        source: f.record.bridge.source,
        selectedProducts: f.record.selectedProducts,
        seedControls: [],
        supplierPublications: [publication],
        supplierArtifacts: [supplier],
        ...finalInputs,
      }),
    );
    const exported = path.join(f.root, 'final-public-export');
    transportPublicNativePublicationInputs(raw, exported, f.record.bridge.source);
    const prepared = path.join(f.root, 'final-prepared');
    writeNativeReleaseInputs(
      prepared,
      f.record,
      f.controls,
      [publication],
      [supplier],
      finalInputs,
    );
    const downloaded = path.join(f.root, 'final-downloaded');
    cpSync(exported, downloaded, { recursive: true });
    const serializedFile = path.join(downloaded, 'native-publication-inputs.json');
    const serialized = JSON.parse(readFileSync(serializedFile, 'utf8'));
    for (const file of finalFiles(serialized))
      file.path = path.join('/missing/original-producer', path.basename(file.path));
    writeFileSync(serializedFile, JSON.stringify(serialized));
    rmSync(path.join(f.root, 'original-final-files'), { recursive: true });
    const imported = JSON.parse(
      readFileSync(importPublicNativePublicationInputs(downloaded, f.record.bridge.source), 'utf8'),
    );
    const relocated = relocateNativeReleaseInputs(prepared, f.record, {
      ...f.record.preparedSource,
      commit: '3'.repeat(40),
    });
    expect(finalFiles(imported)).toHaveLength(12);
    for (const [index, file] of finalFiles(imported).entries()) {
      expect(file.path).toBe(
        path.join(downloaded, 'files', file.sha256, path.basename(originals[index].path)),
      );
      expect(file.producer).toEqual(originals[index].producer);
      expect(file.member).toEqual(originals[index].member);
      expect(fileIdentity(file.path).sha256).toBe(originals[index].sha256);
      expect(finalFiles(relocated)[index].producer).toEqual(originals[index].producer);
      expect(finalFiles(relocated)[index].member).toEqual(originals[index].member);
      expect(finalFiles(relocated)[index].path).toStartWith(prepared);
    }
    expect(imported.supplierArtifacts[0].file.path).toBe(imported.nativeSwiftSource.archive.path);
    expect(imported.supplierArtifacts[0].source).toEqual(supplier.source);
    expect(imported.selectedProducts).toEqual(f.record.selectedProducts);
    expect(relocated.selectedProducts).toEqual(f.record.selectedProducts);
    expect(() => assertAcquiredPreparedNativeReleaseInputs(imported)).toThrow(
      'authenticated Prepare',
    );
    expect(() => assertAcquiredPreparedNativeReleaseInputs(structuredClone(relocated))).toThrow(
      'authenticated Prepare',
    );
    writeFileSync(imported.nativeAppleBase.resources.path, 'substituted original resource File');
    expect(() => importPublicNativePublicationInputs(downloaded, f.record.bridge.source)).toThrow(
      'File bytes differ',
    );
  } finally {
    f.cleanup();
  }
});

test('final constructor transport rejects source, selected scope, tuple identity, and byte substitutions without restamping', async () => {
  const f = await fixture();
  try {
    const finalInputs = finalInputsFixture(f.root);
    const prepared = path.join(f.root, 'final-rejections');
    writeNativeReleaseInputs(prepared, f.record, [], [], [], finalInputs);
    const file = path.join(prepared, 'native-publication-inputs.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    for (const mutate of [
      (value) => {
        value.source.commit = 'f'.repeat(40);
      },
      (value) => {
        value.selectedProducts = ['oliphaunt-query'];
      },
      (value) => {
        value.nativeAppleBase.owner = 'oliphaunt-swift';
      },
      (value) => {
        value.nativeAppleBase.version = '0.3.4';
      },
      (value) => {
        value.nativeSwiftSource.version = '0.8.3';
      },
      (value) => {
        value.nativeSwiftSource.bindingsArchive.producer.invocationId = 'another-invocation';
      },
    ]) {
      const changed = structuredClone(snapshot);
      mutate(changed);
      writeFileSync(file, JSON.stringify(changed));
      expect(() => relocateNativeReleaseInputs(prepared, f.record)).toThrow();
    }
    writeFileSync(file, JSON.stringify(snapshot));
    const publicFile = path.join(f.root, 'wrong-source-final-public.json');
    writeFileSync(
      publicFile,
      JSON.stringify({
        source: f.record.bridge.source,
        seedControls: [],
        supplierPublications: [],
        ...finalInputs,
      }),
    );
    expect(() =>
      transportPublicNativePublicationInputs(
        publicFile,
        path.join(f.root, 'wrong-source-final-export'),
        f.record.preparedSource,
      ),
    ).toThrow('source differs');
    writeFileSync(finalInputs.extensionFinalInputs[0].frozen.path, 'substituted frozen File');
    const destination = path.join(f.root, 'bad-final-writer');
    expect(() => writeNativeReleaseInputs(destination, f.record, [], [], [], finalInputs)).toThrow(
      'File bytes differ',
    );
    expect(existsSync(destination)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('prepared transport retains original seed and receipt, relocates from exact hashes, and carries one complete supplier map', async () => {
  const f = await fixture();
  try {
    const destination = path.join(f.root, 'downloaded');
    cpSync(f.capsule, destination, { recursive: true });
    rmSync(path.join(f.root, 'constructor'), { recursive: true });
    const snapshot = relocateNativeReleaseInputs(destination, f.record);
    expect(snapshot.seedControls[0].promotion.source).toEqual(f.record.bridge.source);
    expect(snapshot.seedControls[0].promotion.frozen.path).toStartWith(destination);
    expect(snapshot.seedControls[0].promotion.frozen.sha256).toBe(
      f.controls[0].promotion.frozen.sha256,
    );
    expect(parseNativeReleaseInputRecord(f.record).buildBound.size).toBe(27);
    expect(snapshot).not.toHaveProperty('ready');
    writeFileSync(snapshot.seedControls[0].promotion.frozen.path, 'fresh entropy');
    expect(() => relocateNativeReleaseInputs(destination, f.record)).toThrow(/bytes differ/u);
  } finally {
    f.cleanup();
  }
});

test('producer context is the actual canonical PR parent and skips ordinary PRs or unchanged main without release reads', async () => {
  const f = await fixture();
  try {
    const pull = {
      number: 17,
      head: {
        ref: 'release-please--branches--main',
        sha: f.record.preparedSource.commit,
        repo: { full_name: 'f0rr0/oliphaunt' },
      },
      base: { ref: 'main', repo: { full_name: 'f0rr0/oliphaunt' } },
    };
    const read = async (endpoint: string) =>
      endpoint.endsWith('/pulls/17')
        ? pull
        : {
            sha: f.record.preparedSource.commit,
            tree: { sha: f.record.preparedSource.tree },
            parents: [{ sha: f.record.bridge.source.commit }],
          };
    const context = await resolveNativeReleaseInputContext(
      { source: f.record.preparedSource, pullNumber: 17 },
      { read, gitDirectory: f.root },
    );
    expect(context).toEqual({ pullNumber: 17, prepareSourceCommit: f.record.bridge.source.commit });
    expect(
      await resolveNativeReleaseInputContext(
        { source: f.record.preparedSource, pullNumber: 17 },
        {
          read: async () => ({ ...pull, head: { ...pull.head, ref: 'feature' } }),
          gitDirectory: f.root,
        },
      ),
    ).toBeUndefined();
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'docs only',
    );
    const current = { commit: f.git('rev-parse', 'HEAD'), tree: f.git('rev-parse', 'HEAD^{tree}') };
    let reads = 0;
    expect(
      await resolveNativeReleaseInputContext(
        { source: current },
        {
          read: async () => {
            reads++;
            throw new Error('unexpected read');
          },
          pages: async () => {
            reads++;
            throw new Error('unexpected page');
          },
          gitDirectory: f.root,
        },
      ),
    ).toBeUndefined();
    expect(reads).toBe(0);
    await expect(
      resolveNativeReleaseInputContext(
        { source: { ...current, tree: 'f'.repeat(40) }, pullNumber: 17 },
        { read, gitDirectory: f.root },
      ),
    ).rejects.toThrow(/PR tree/u);
  } finally {
    f.cleanup();
  }
});

test('versioned main resolves the canonical PR associated with that exact commit', async () => {
  const f = await fixture();
  try {
    const commit = execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        f.record.preparedSource.tree,
        '-p',
        f.record.bridge.source.commit,
        '-m',
        'chore(release): merged candidate',
      ],
      { cwd: f.root, encoding: 'utf8' },
    ).trim();
    f.git('reset', '--hard', commit);
    const current = { commit, tree: f.record.preparedSource.tree };
    const pull = {
      number: 17,
      merged_at: '2026-10-12T00:00:00Z',
      merge_commit_sha: commit,
      head: {
        ref: 'release-please--branches--main',
        sha: f.record.preparedSource.commit,
        repo: { full_name: 'f0rr0/oliphaunt' },
      },
      base: { ref: 'main', repo: { full_name: 'f0rr0/oliphaunt' } },
    };
    const options = {
      read: async () => ({
        sha: f.record.preparedSource.commit,
        tree: { sha: f.record.preparedSource.tree },
        parents: [{ sha: f.record.bridge.source.commit }],
      }),
      pages: async (endpoint: string) => {
        expect(endpoint).toContain(`/commits/${commit}/pulls`);
        return [pull];
      },
      gitDirectory: f.root,
    };
    expect(await resolveNativeReleaseInputContext({ source: current }, options)).toEqual({
      pullNumber: 17,
      prepareSourceCommit: f.record.bridge.source.commit,
    });
    f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'later unchanged controller',
    );
    expect(await resolveNativeReleaseInputContext({ source: current }, options)).toEqual({
      pullNumber: 17,
      prepareSourceCommit: f.record.bridge.source.commit,
    });
    await expect(
      resolveNativeReleaseInputContext({ source: { ...current, tree: 'f'.repeat(40) } }, options),
    ).rejects.toThrow('source tree differs');
    await expect(
      resolveNativeReleaseInputContext(
        { source: current },
        { ...options, pages: async () => [pull, pull] },
      ),
    ).rejects.toThrow(/one canonical/u);
  } finally {
    f.cleanup();
  }
});

test('merge queue reuses only the exact canonical open release tree and rejects mixed or ambiguous queue contents', async () => {
  const f = await fixture();
  try {
    const queued = execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        f.record.preparedSource.tree,
        '-p',
        f.record.bridge.source.commit,
        '-m',
        'Merge queue synthetic title',
      ],
      { cwd: f.root, encoding: 'utf8' },
    ).trim();
    const pull = {
      number: 17,
      state: 'open',
      merged_at: null,
      head: {
        ref: 'release-please--branches--main',
        sha: f.record.preparedSource.commit,
        repo: { full_name: 'f0rr0/oliphaunt' },
      },
      base: { ref: 'main', repo: { full_name: 'f0rr0/oliphaunt' } },
    };
    const options = {
      gitDirectory: f.root,
      pages: async (endpoint: string) => {
        expect(endpoint).toContain(`/commits/${queued}/pulls`);
        return [pull];
      },
      read: async () => ({
        sha: f.record.preparedSource.commit,
        tree: { sha: f.record.preparedSource.tree },
        parents: [{ sha: f.record.bridge.source.commit }],
        message: 'chore(release): publish prepared products\n\nRelease body',
      }),
    };
    const request = {
      source: { commit: queued, tree: f.record.preparedSource.tree },
      event: 'merge_group',
    };
    expect(await resolveNativeReleaseInputContext(request, options)).toEqual({
      pullNumber: 17,
      prepareSourceCommit: f.record.bridge.source.commit,
      sourcePolicy: {
        subject: 'chore(release): publish prepared products',
        base: f.record.bridge.source.commit,
        head: f.record.preparedSource.commit,
        branch: 'release-please--branches--main',
      },
    });
    await expect(
      resolveNativeReleaseInputContext(request, { ...options, pages: async () => [pull, pull] }),
    ).rejects.toThrow('one canonical');
    await expect(
      resolveNativeReleaseInputContext(
        {
          ...request,
          source: { commit: f.record.bridge.source.commit, tree: f.record.bridge.source.tree },
        },
        { ...options, pages: async () => [pull] },
      ),
    ).rejects.toThrow('mixed merge queue');
    await expect(
      resolveNativeReleaseInputContext(request, {
        ...options,
        pages: async () => [{ ...pull, merged_at: '2026-10-12' }],
      }),
    ).rejects.toThrow('canonical open');
    await expect(
      resolveNativeReleaseInputContext(request, {
        ...options,
        read: async () => ({
          sha: f.record.preparedSource.commit,
          tree: { sha: f.record.preparedSource.tree },
          parents: [{ sha: f.record.bridge.source.commit }, { sha: 'f'.repeat(40) }],
        }),
      }),
    ).rejects.toThrow('one exact source parent');
    await expect(
      resolveNativeReleaseInputContext(request, {
        ...options,
        read: async () => ({
          ...(await options.read()),
          message: 'chore(release): unsafe\toutput',
        }),
      }),
    ).rejects.toThrow('safe source policy subject');
  } finally {
    f.cleanup();
  }
});

test('ordinary merge queues retain source version checks and do not request release producers', async () => {
  const f = await fixture();
  try {
    const queued = execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        f.record.bridge.source.tree,
        '-p',
        f.record.bridge.source.commit,
        '-m',
        'Merge queue feature changes',
      ],
      { cwd: f.root, encoding: 'utf8' },
    ).trim();
    const options = {
      gitDirectory: f.root,
      pages: async () => [{ state: 'open', merged_at: null, head: { ref: 'feature' } }],
      read: async () => {
        throw new Error('ordinary queue must not read a Prepare source');
      },
    };
    expect(
      await resolveNativeReleaseInputContext(
        {
          source: { commit: queued, tree: f.record.bridge.source.tree },
          event: 'merge_group',
        },
        options,
      ),
    ).toBeUndefined();
    await expect(
      resolveNativeReleaseInputContext(
        {
          source: f.record.preparedSource,
          event: 'merge_group',
        },
        options,
      ),
    ).rejects.toThrow('one canonical open');
  } finally {
    f.cleanup();
  }
});

for (const fault of [
  'missing-owner',
  'duplicate-owner',
  'unknown-selected',
  'bridge-digest',
  'changed-receipt-slot',
] as const)
  test(`prepared input structure rejects ${fault} without granting origin authority`, async () => {
    const f = await fixture();
    try {
      const record = structuredClone(f.record);
      if (fault === 'missing-owner') record.buildBound.pop();
      if (fault === 'duplicate-owner') record.buildBound.push(record.buildBound[0]);
      if (fault === 'unknown-selected') record.selectedProducts = ['unknown'];
      if (fault === 'bridge-digest') record.bridge.updatesSha256 = 'f'.repeat(64);
      if (fault === 'changed-receipt-slot') {
        const controls = structuredClone(f.controls);
        controls[0].target = 'linux-arm64-gnu';
        expect(() =>
          writeNativeReleaseInputs(path.join(f.root, 'bad'), record, controls, []),
        ).toThrow();
      } else expect(() => parseNativeReleaseInputRecord(record)).toThrow();
    } finally {
      f.cleanup();
    }
  });

for (const fault of [
  'none',
  'pr-head',
  'code-source',
  'product-scope',
  'failed-job',
  'artifact-digest',
  'outside-update',
  'feature-dispatch',
  'preserved-old-head',
  'retained-producer-attempt',
  'wrong-parent',
] as const)
  test(`actual Prepare acquisition joins PR/API/source/Files (${fault})`, async () => {
    const f = await fixture();
    const destination = path.join(f.root, 'acquired');
    try {
      // A merge commit can preserve the prepared tree while changing its commit identity.
      f.git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'merged release PR',
      );
      const currentSource = {
        commit: f.git('rev-parse', 'HEAD'),
        tree: f.git('rev-parse', 'HEAD^{tree}'),
      };
      if (fault === 'outside-update') {
        writeFileSync(path.join(f.root, 'extra.mts'), 'unrecorded source change');
        f.git('add', 'extra.mts');
        f.git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'extra',
        );
        currentSource.commit = f.git('rev-parse', 'HEAD');
        currentSource.tree = f.git('rev-parse', 'HEAD^{tree}');
      }
      const read = async (endpoint: string) => {
        if (endpoint.endsWith('/actions/runs/41'))
          return {
            id: 41,
            event: 'workflow_dispatch',
            head_branch: fault === 'feature-dispatch' ? 'feature' : 'main',
            head_sha: f.record.bridge.source.commit,
            run_attempt: 2,
          };
        if (endpoint.endsWith('/pulls/17'))
          return {
            number: 17,
            base: { ref: 'main', repo: { full_name: 'f0rr0/oliphaunt' } },
            head: {
              ref: 'release-please--branches--main',
              repo: { full_name: 'f0rr0/oliphaunt' },
              sha:
                fault === 'pr-head'
                  ? f.record.bridge.source.commit
                  : f.record.preparedSource.commit,
            },
          };
        const sha = endpoint.split('/').at(-1);
        return {
          sha,
          tree: { sha: f.git('rev-parse', `${sha}^{tree}`) },
          parents: [
            {
              sha: fault === 'wrong-parent' ? currentSource.commit : f.record.bridge.source.commit,
            },
          ],
        };
      };
      let downloads = 0;
      const download = async (
        _command: string,
        args: string[],
        options: { env: Record<string, string> },
      ) => {
        downloads++;
        expect(args).toContain('--job-success-only');
        expect(args).toContain('Prepare release PR');
        expect(args).toContain('native-release-inputs');
        cpSync(f.capsule, args[3], { recursive: true });
        const recordFile = path.join(args[3], 'native-version-source.json');
        const record = JSON.parse(readFileSync(recordFile, 'utf8'));
        if (fault === 'preserved-old-head') {
          record.preparedSource.commit = 'c'.repeat(40);
          const snapshotFile = path.join(args[3], 'native-publication-inputs.json');
          const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
          snapshot.source.commit = record.preparedSource.commit;
          for (const row of snapshot.seedControls)
            row.promotion.transition.source.commit = record.preparedSource.commit;
          writeFileSync(snapshotFile, JSON.stringify(snapshot));
        }
        if (fault === 'code-source') record.bridge.source = f.record.preparedSource;
        if (fault === 'product-scope') record.selectedProducts = ['oliphaunt-query'];
        writeFileSync(recordFile, JSON.stringify(record));
        const snapshots = options.env.OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR;
        mkdirSync(snapshots, { recursive: true });
        writeFileSync(
          path.join(snapshots, 'run-41.json'),
          JSON.stringify({
            repo: 'f0rr0/oliphaunt',
            runId: '41',
            headSha: f.record.bridge.source.commit,
            headTree: f.record.bridge.source.tree,
            workflowName: 'Release',
            workflowPath: '.github/workflows/release.yml',
            runAttempt: 2,
            event: 'workflow_dispatch',
            headBranch: 'main',
            jobs: [
              {
                name: 'Prepare release PR',
                run_attempt: fault === 'retained-producer-attempt' ? 1 : 2,
                started_at: '2026-10-11T01:00:00Z',
                completed_at: '2026-10-11T01:02:00Z',
                status: 'completed',
                conclusion: fault === 'failed-job' ? 'failure' : 'success',
              },
            ],
            artifacts: [
              {
                name: 'native-release-inputs',
                expired: false,
                head_sha: f.record.bridge.source.commit,
                created_at: '2026-10-11T01:01:00Z',
                id: 51,
                size_in_bytes: 512,
                digest: fault === 'artifact-digest' ? 'unknown' : `sha256:${'b'.repeat(64)}`,
              },
            ],
          }),
        );
      };
      const acquisition = acquirePreparedNativeReleaseInputs(
        { runId: 41, pullNumber: 17, source: currentSource, directory: destination },
        { read, download: download as never, gitDirectory: f.root },
      );
      if (
        fault === 'none' ||
        fault === 'preserved-old-head' ||
        fault === 'retained-producer-attempt'
      ) {
        const result = await acquisition;
        expect(() => assertAcquiredPreparedNativeReleaseInputs(result)).toThrow(
          /authenticated Prepare producer/u,
        );
        const snapshot = JSON.parse(readFileSync(result.snapshotFile, 'utf8'));
        expect(snapshot.source).toEqual(currentSource);
        expect(snapshot.seedControls[0].promotion.transition.source).toEqual(currentSource);
        expect(snapshot.seedControls[0].promotion.source).toEqual(f.record.bridge.source);
        expect(snapshot.seedControls[0].promotion.frozen.sha256).toBe(
          f.controls[0].promotion.frozen.sha256,
        );
        expect(result.origin.runAttempt).toBe(fault === 'retained-producer-attempt' ? 1 : 2);
        expect(result.buildBound.size).toBe(27);
        expect(downloads).toBe(1);
      } else {
        await expect(acquisition).rejects.toThrow();
        expect(existsSync(destination)).toBe(false);
      }
    } finally {
      f.cleanup();
    }
  });

test('same final source constructor facts replace stale tuples and survive the existing source snapshot transport', async () => {
  const f = await fixture();
  try {
    const finalInputs = finalInputsFixture(f.root);
    const name = 'liboliphaunt-native-linux-x64-gnu-0.3.3.crate';
    const currentFile = path.join(f.root, name);
    writeFileSync(currentFile, 'original current carrier protocol fixture');
    const identity = fileIdentity(currentFile);
    finalInputs.nativeCurrentArtifacts = [
      {
        product: 'liboliphaunt-native',
        version: '0.3.3',
        artifact: 'cargo:liboliphaunt-native-linux-x64-gnu',
        configuration: 'linux-x64-gnu',
        source: f.record.preparedSource,
        file: {
          path: currentFile,
          size: identity.size,
          sha256: identity.sha256,
          producer: {
            evidenceDigest: 'sha256:' + 'c'.repeat(64),
            invocationId: 'same-candidate-native',
            root: '//src/native/runtime:native_cargo_shipping',
            configuration: 'd'.repeat(64),
            output: 'bazel-out/cfg/bin/cargo-packages',
          },
          member: name,
        },
      },
    ];
    const inherited = path.join(f.root, 'source-inputs.json');
    const snapshot = {
      source: f.record.preparedSource,
      selectedProducts: f.record.selectedProducts,
      seedControls: [],
      supplierPublications: [],
      extensionFinalInputs: [],
      nativeSwiftSource: finalInputs.nativeSwiftSource,
    };
    writeFileSync(inherited, JSON.stringify(snapshot));
    const current = structuredClone(finalInputs);
    current.nativeSwiftSource.archive.producer.evidenceDigest = `sha256:${'c'.repeat(64)}`;
    for (const key of ['carrier', 'ownerCatalog', 'bindingsArchive'])
      current.nativeSwiftSource[key].producer.evidenceDigest =
        current.nativeSwiftSource.archive.producer.evidenceDigest;
    const output = writeNativeConstructionInputSnapshot({
      source: f.record.preparedSource,
      file: inherited,
      directory: path.join(f.root, 'source-fresh'),
      finalInputs: current,
    });
    const written = JSON.parse(readFileSync(output, 'utf8'));
    expect(written.source).toEqual(snapshot.source);
    expect(written.selectedProducts).toEqual(snapshot.selectedProducts);
    expect(written.nativeSwiftSource).toEqual(current.nativeSwiftSource);
    expect(written.extensionFinalInputs).toEqual(current.extensionFinalInputs);
    expect(written.nativeAppleBase).toEqual(current.nativeAppleBase);
    expect(written.nativeCurrentArtifacts).toEqual(current.nativeCurrentArtifacts);
    expect(written.nativeSwiftSource.archive.producer.evidenceDigest).not.toBe(
      snapshot.nativeSwiftSource.archive.producer.evidenceDigest,
    );
    const exported = transportPublicNativePublicationInputs(
      output,
      path.join(f.root, 'source-export'),
      f.record.preparedSource,
    );
    const relocated = importPublicNativePublicationInputs(
      path.dirname(exported),
      f.record.preparedSource,
    );
    const imported = JSON.parse(readFileSync(relocated, 'utf8'));
    const originalFiles = finalFiles(current),
      importedFiles = finalFiles(imported);
    expect(importedFiles).toHaveLength(originalFiles.length);
    for (const [index, file] of importedFiles.entries()) {
      expect(file.path).not.toBe(originalFiles[index].path);
      expect(fileIdentity(file.path).sha256).toBe(originalFiles[index].sha256);
      expect(file.producer).toEqual(originalFiles[index].producer);
      expect(file.member).toEqual(originalFiles[index].member);
    }
    const wrongCurrent = structuredClone(written);
    wrongCurrent.nativeCurrentArtifacts[0].source.commit = 'f'.repeat(40);
    const forged = path.join(f.root, 'wrong-current-source.json');
    writeFileSync(forged, JSON.stringify(wrongCurrent));
    expect(() =>
      transportPublicNativePublicationInputs(
        forged,
        path.join(f.root, 'wrong-current-export'),
        f.record.preparedSource,
      ),
    ).toThrow('current native artifact source differs');
    const missing = structuredClone(current);
    delete missing.nativeSwiftSource.bindingsArchive;
    expect(() =>
      writeNativeConstructionInputSnapshot({
        source: f.record.preparedSource,
        file: inherited,
        directory: path.join(f.root, 'missing-source-tuple'),
        finalInputs: missing,
      }),
    ).toThrow('fields differ');
    expect(existsSync(path.join(f.root, 'missing-source-tuple'))).toBe(false);
    const restamped = structuredClone(current);
    restamped.nativeSwiftSource.version = '0.8.3';
    expect(() =>
      writeNativeConstructionInputSnapshot({
        source: f.record.preparedSource,
        file: inherited,
        directory: path.join(f.root, 'restamp'),
        finalInputs: restamped,
      }),
    ).toThrow('name differs');
    expect(() =>
      writeNativeConstructionInputSnapshot({
        source: f.record.bridge.source,
        file: inherited,
        directory: path.join(f.root, 'wrong-source'),
        finalInputs: current,
      }),
    ).toThrow('source differs');
  } finally {
    f.cleanup();
  }
});

test('the actual constructor coordinator rejects a raw origin and uses only the known Apple role for RN bootstrap', () => {
  expect(nativeConstructorProducerArtifacts(['oliphaunt-react-native'])).toEqual([
    'native-build-evidence-mobile-ios',
  ]);
  expect(() =>
    nativeConstructorProducerArtifacts(['oliphaunt-react-native', 'oliphaunt-swift']),
  ).toThrow('canonical RN');
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  expect(() =>
    nativeArchiveConstructionFinalInputs(
      { builds: [], origins: new Map([['raw', {}]]) } as any,
      source,
    ),
  ).toThrow('producer plan differs');
  expect(() =>
    nativeArchiveConstructionFinalInputs(
      {
        builds: [{ evidenceRoot: 'raw', expected: { source } }],
        origins: new Map([['raw', {}]]),
      } as any,
      source,
    ),
  ).toThrow('authenticated producer transport');
});
