import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import {
  captureSeedConstructionIntent,
  captureSeedContentIntent,
  captureSeedProducerIdentity,
  expandSeedConstructionTrees,
  SEED_CONSTRUCTION_ANCHOR_SCHEMA,
  seedConstructionFileBinding,
  seedConstructionInvocation,
  seedProducerIdentity,
  selectCompletedSeed,
  selectQualifiedSeed,
  validateSeedConstructionAnchor,
  validateSeedConstructionReceipt,
  writePromotedSeedReceipt,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';
import { bootstrapFiles, fixture, identity, publication } from './seed-construction-fixture.mts';

test('semantic File roles must bind exact declared inputs and invalidate reassigned headers', () => {
  const inputs = { manual: '/cache/manual.h', control: '/cache/control.h' };
  expect(seedConstructionFileBinding(inputs, '/cache/manual.h')).toBe('manual');
  expect(() => seedConstructionFileBinding(inputs, '/ambient/header.h')).toThrow(
    'declared logical File',
  );
  expect(() =>
    seedConstructionFileBinding({ ...inputs, alias: '/cache/manual.h' }, '/cache/manual.h'),
  ).toThrow('exactly one');
  const bindings = (headers: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(headers).map(([role, file]) => [
        role,
        seedConstructionFileBinding(inputs, file),
      ]),
    );
  expect(bindings({ manual: inputs.manual, control: inputs.control })).not.toEqual(
    bindings({ manual: inputs.control, control: inputs.manual }),
  );
});

test('semantic File names do not inherit undeclared tool trees from Object.prototype', async () => {
  const f = await fixture('native');
  try {
    const inputs = { constructor: f.inputs.tool, toString: f.inputs.postgres };
    const implicit = captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      f.invocation,
      inputs,
    );
    const explicit = captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      f.invocation,
      inputs,
      Object.create(null),
    );
    expect(implicit).toEqual(explicit);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const family of ['native', 'wasix'] as const) {
  for (const profile of ['standard', 'icu'] as const) {
    test(`${family}/${profile} reuses every immutable PGDATA and empty directory only with matching concrete intent`, async () => {
      const f = await fixture(family, profile);
      try {
        const selected = selectCompletedSeed(f.intent, f.control());
        expect(selected?.origin.operation).toBe('reused');
        expect(selected?.origin.metadata).toBeDefined();
        const destination = path.join(f.root, 'copy');
        extractPortableArchiveTree(f.assets.archive, destination);
        expect(readFileSync(path.join(destination, 'global/pg_control'))).toEqual(
          readFileSync(path.join(f.pgdata, 'global/pg_control')),
        );
        expect(readFileSync(path.join(destination, 'pg_wal/000000010000000000000001'))).toEqual(
          readFileSync(path.join(f.pgdata, 'pg_wal/000000010000000000000001')),
        );
        expect(
          selectCompletedSeed(f.intent, { ...f.control(), metadata: undefined }),
        ).toBeUndefined();
        expect(selectCompletedSeed(f.intent)).toBeUndefined();
        const adoption = selectCompletedSeed(f.intent, {
          ...f.control(),
          operation: 'adopt',
          metadata: undefined,
        });
        expect(adoption?.origin.operation).toBe('adopted');
        expect(adoption?.origin.metadata).toBeUndefined();
        const adoptedReceipt = writeSeedConstructionReceipt(
          f.receiptPath,
          f.intent,
          f.frozen,
          f.pgdata,
          adoption?.origin,
        );
        expect(adoptedReceipt.origin.kind).toBe('completed-publication');
        expect(adoptedReceipt).not.toHaveProperty('qualified');
        f.updateMetadata(adoptedReceipt);
        expect(selectCompletedSeed(f.intent, f.control())?.origin.operation).toBe('reused');
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
}

test('completed seed reuse reads the declared archive alias and rejects a directory target', async () => {
  const f = await fixture('wasix');
  try {
    const captured = f.control();
    const sandbox = path.join(f.root, 'sandbox');
    mkdirSync(sandbox);
    const alias = path.join(sandbox, path.basename(captured.archive.path));
    symlinkSync(captured.archive.path, alias, 'file');
    const control = { ...captured, archive: { ...captured.archive, path: alias } };
    const selected = selectCompletedSeed(f.intent, control);
    expect(selected?.origin.operation).toBe('reused');
    expect(selected?.archive).toBe(alias);
    expect(selected?.origin.archive).toEqual({
      size: captured.archive.size,
      sha256: captured.archive.sha256,
    });
    rmSync(alias);
    symlinkSync(f.pgdata, alias, 'dir');
    expect(() => selectCompletedSeed(f.intent, control)).toThrow('regular file');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('legacy and changed recipe proof constructs afresh; corrupt declared completion bytes fail closed', async () => {
  const f = await fixture('native');
  try {
    writeFileSync(
      f.metadata,
      JSON.stringify({
        source: { commit: publication.publicationSha, tree: publication.publicationTree },
        product: { id: publication.product, version: publication.version },
        construction: [{}],
      }),
    );
    expect(selectCompletedSeed(f.intent, f.control())).toBeUndefined();
    f.updateMetadata();
    const changed = structuredClone(f.intent);
    changed.invocation = { ...f.invocation, arguments: ['--encoding=LATIN1'] };
    expect(selectCompletedSeed(changed, f.control())).toBeUndefined();
    const captured = f.control();
    writeFileSync(f.assets.archive, 'corrupt bytes');
    expect(() => selectCompletedSeed(f.intent, captured)).toThrow('input bytes differ');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('fresh control/WAL entropy never proves the old seed came from an unchanged constructor', async () => {
  const f = await fixture('wasix');
  try {
    writeFileSync(path.join(f.pgdata, 'global/pg_control'), 'fresh control clock/PID/random');
    writeFileSync(path.join(f.pgdata, 'pg_wal/000000010000000000000001'), 'fresh WAL entropy');
    writeFileSync(f.frozen, await createDeterministicTar(f.pgdata));
    const fresh = writeSeedConstructionReceipt(f.receiptPath, f.intent, f.frozen, f.pgdata);
    expect(fresh.intentSha256).toBe(f.receipt.intentSha256);
    expect(fresh.pgdata.treeSha256).not.toBe(f.receipt.pgdata.treeSha256);
    f.updateMetadata(fresh);
    expect(() => selectCompletedSeed(f.intent, f.control())).toThrow('PGDATA differs');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('deterministic random actual-input mutations always invalidate reuse and restore coherently', async () => {
  const f = await fixture('native');
  try {
    let random = 0x5eed;
    const before = Object.fromEntries(
      Object.entries(f.inputs).map(([name, file]) => [name, readFileSync(file)]),
    );
    for (let scenario = 0; scenario < 64; scenario++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const selected = Object.keys(f.inputs).filter((_, index) => (random & (1 << index)) !== 0);
      for (const name of selected)
        writeFileSync(f.inputs[name], Buffer.concat([before[name], Buffer.from(` ${scenario}`)]));
      const current = captureSeedConstructionIntent(f.intent, f.invocation, f.inputs);
      expect(selectCompletedSeed(current, f.control()) !== undefined).toBe(selected.length === 0);
      for (const name of selected) writeFileSync(f.inputs[name], before[name]);
      expect(
        selectCompletedSeed(
          captureSeedConstructionIntent(f.intent, f.invocation, f.inputs),
          f.control(),
        )?.origin.operation,
      ).toBe('reused');
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('source transport modes preserve intent; actual empty directories, command and environment belong to intent', async () => {
  const f = await fixture('native');
  try {
    const changedEnvironment = captureSeedConstructionIntent(
      f.intent,
      { ...f.invocation, environment: { TZ: 'Pacific/Honolulu' } },
      f.inputs,
    );
    expect(selectCompletedSeed(changedEnvironment, f.control())).toBeUndefined();
    if (process.platform !== 'win32') {
      chmodSync(f.inputs.tool, 0o444);
      expect(
        selectCompletedSeed(
          captureSeedConstructionIntent(f.intent, f.invocation, f.inputs),
          f.control(),
        )?.origin.operation,
      ).toBe('reused');
      chmodSync(f.inputs.tool, 0o755);
      expect(
        selectCompletedSeed(
          captureSeedConstructionIntent(f.intent, f.invocation, f.inputs),
          f.control(),
        )?.origin.operation,
      ).toBe('reused');
    }
    const inputTree = path.join(f.root, 'input-tree');
    mkdirSync(path.join(inputTree, 'empty'), { recursive: true });
    writeFileSync(path.join(inputTree, 'tool.mts'), 'declared tool');
    const initial = captureSeedConstructionIntent(f.intent, f.invocation, { inputTree });
    rmSync(path.join(inputTree, 'empty'), { recursive: true });
    expect(captureSeedConstructionIntent(f.intent, f.invocation, { inputTree })).not.toEqual(
      initial,
    );
    expect(() =>
      captureSeedConstructionIntent(f.intent, f.invocation, { '../escape': inputTree }),
    ).toThrow('safe logical name');
    const bad = structuredClone(f.receipt);
    bad.intent.invocation = 'forged';
    expect(() => validateSeedConstructionReceipt(bad)).toThrow('intent digest differs');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('transport locations do not hide any actual command, environment or input data', () => {
  const invocation = (root: string) =>
    seedConstructionInvocation(
      `${root}/runtime/bin/initdb`,
      ['-D', `${root}/work/pgdata`, '--encoding=UTF8'],
      { HOME: `${root}/work`, TZ: 'UTC' },
      { runtime: `${root}/runtime`, work: `${root}/work` },
    );
  expect(invocation('/first')).toEqual(invocation('/second'));
  expect(invocation('/first').arguments).toContain('--encoding=UTF8');
  expect(invocation('/first').environment.TZ).toBe('UTC');
});

test('version promotion keeps one frozen seed and original constructor while observing final runtime intent', async () => {
  const f = await fixture('wasix');
  try {
    writeFileSync(f.inputs.postgres, 'actual final versioned runtime bytes');
    const current = captureSeedConstructionIntent(f.intent, f.invocation, f.inputs);
    expect(selectCompletedSeed(current, f.control())).toBeUndefined();
    const control = {
      source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
      evidenceDigest: `sha256:${'f'.repeat(64)}`,
      invocationId: 'original-qualified-invocation',
      frozen: identity(f.frozen),
      receipt: identity(f.receiptPath),
      transition: {
        source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
        updatesSha256: '3'.repeat(64),
      },
    };
    const promotion = selectQualifiedSeed(current, control);
    assert.ok(promotion);
    const frozen = path.join(f.root, 'promoted.tar');
    copyFileSync(promotion.frozen, frozen);
    const promotedReceipt = writePromotedSeedReceipt(
      path.join(f.root, 'promoted.json'),
      promotion,
      frozen,
      f.pgdata,
    );
    expect(promotedReceipt.frozen).toEqual(f.receipt.frozen);
    expect(promotedReceipt.pgdata).toEqual(f.receipt.pgdata);
    expect(promotedReceipt.intentSha256).toBe(f.receipt.intentSha256);
    expect(promotedReceipt.intent).toEqual(f.receipt.intent);
    expect(promotedReceipt.qualificationIntent).toEqual(current);
    expect(promotedReceipt.origin.kind).toBe('qualified-construction');
    expect(promotedReceipt).not.toHaveProperty('qualified');
    f.updateMetadata(promotedReceipt);
    expect(selectCompletedSeed(current, f.control())?.origin.operation).toBe('reused');
    expect(selectCompletedSeed(f.intent, f.control())).toBeUndefined();
    expect(() => selectQualifiedSeed({ ...current, profile: 'icu' }, control)).toThrow(
      'cannot change seed slot',
    );
    expect(() =>
      selectQualifiedSeed(current, { ...control, evidenceDigest: 'unverified' }),
    ).toThrow('authenticated evidence digest');
    writeFileSync(f.frozen, 'changed frozen constructor bytes');
    expect(() => selectQualifiedSeed(current, control)).toThrow(
      'qualified seed input bytes differ',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('desired content binds actual bootstrap/ABI/invocation/ICU, independent of tool comments and version envelopes', async () => {
  const f = await fixture('native');
  try {
    const share = bootstrapFiles(f.root);
    const invocation = {
      arguments: ['--encoding=UTF8'],
      abi: 'real catalog/control ABI',
      contract: 'PG18',
    };
    const content = () => captureSeedContentIntent(f.intent, invocation, share);
    const original = content();
    writeFileSync(f.inputs.tool, '// constructor comment changed\n');
    writeFileSync(f.inputs.postgres, 'same valid runtime with different version envelope\n');
    expect(content()).toEqual(original);
    expect(captureSeedConstructionIntent(f.intent, f.invocation, f.inputs)).not.toEqual(f.intent);
    writeFileSync(path.join(share, 'postgres.bki'), 'actual changed desired catalog\n');
    expect(content()).not.toEqual(original);
    expect(
      captureSeedContentIntent(f.intent, { ...invocation, abi: 'changed ABI' }, share),
    ).not.toEqual(content());
    expect(
      captureSeedContentIntent(
        f.intent,
        { ...invocation, arguments: ['--encoding=LATIN1'] },
        share,
      ),
    ).not.toEqual(content());
    const icu = path.join(f.root, 'actual-icu');
    mkdirSync(icu);
    writeFileSync(path.join(icu, 'data.dat'), 'ICU one');
    const icuContent = captureSeedContentIntent(
      { ...f.intent, profile: 'icu' },
      invocation,
      share,
      icu,
    );
    writeFileSync(path.join(icu, 'data.dat'), 'ICU two');
    expect(
      captureSeedContentIntent({ ...f.intent, profile: 'icu' }, invocation, share, icu),
    ).not.toEqual(icuContent);
    writeFileSync(
      path.join(share, 'extension/plpgsql.control'),
      "default_version = '1.0'\ndefault_version = '2.0'\n",
    );
    expect(() => content()).toThrow('one declared');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const family of ['native', 'wasix'] as const) {
  test(`${family} fixed legacy adoption retains exact public data through comments/versions and changes only on desired input`, async () => {
    const f = await fixture(family);
    try {
      const share = bootstrapFiles(f.root);
      const content = captureSeedContentIntent(
        f.intent,
        { contract: 'actual desired contract' },
        share,
      );
      const adoption = selectCompletedSeed(
        f.intent,
        { ...f.control(), operation: 'adopt', metadata: undefined },
        content,
      );
      const receipt = writeSeedConstructionReceipt(
        f.receiptPath,
        f.intent,
        f.frozen,
        f.pgdata,
        adoption?.origin,
        content,
      );
      const contents = readFileSync(f.receiptPath, 'utf8');
      const anchor = {
        schema: SEED_CONSTRUCTION_ANCHOR_SCHEMA,
        source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
        publication,
        seeds: [
          {
            family,
            target: f.intent.target,
            profile: f.intent.profile,
            archive: identity(f.assets.archive),
            manifest: identity(f.assets.manifest),
            receipt: { ...identity(f.receiptPath), contents },
            producer: {
              evidenceDigest: `sha256:${'f'.repeat(64)}`,
              invocationId: 'original-PR-construction',
              root: '//source:resource',
              configuration: 'actual-root-config',
              output: 'actual-resource.tar',
            },
          },
        ],
      };
      // Transport paths are not part of the immutable source contract.
      for (const seed of anchor.seeds)
        for (const field of ['archive', 'manifest', 'receipt']) delete seed[field].path;
      const anchorPath = path.join(f.root, 'construction-anchor.json');
      writeFileSync(anchorPath, JSON.stringify(validateSeedConstructionAnchor(anchor)));
      const control = { ...f.control(), metadata: undefined, anchor: identity(anchorPath) };
      writeFileSync(f.inputs.postgres, 'current valid version wrapper');
      writeFileSync(f.inputs.tool, '// current worker comments');
      const current = captureSeedConstructionIntent(f.intent, f.invocation, f.inputs);
      const selected = selectCompletedSeed(current, control, content);
      expect(selected?.origin.operation).toBe('reused');
      expect(selected?.origin.anchor.source).toEqual(anchor.source);
      expect(selected?.origin).not.toHaveProperty('metadata');
      expect(selected?.archive).toBe(f.assets.archive);
      const reusedReceipt = writeSeedConstructionReceipt(
        f.receiptPath,
        current,
        f.frozen,
        f.pgdata,
        selected?.origin,
        content,
      );
      expect(reusedReceipt.pgdata).toEqual(receipt.pgdata);
      f.updateMetadata(reusedReceipt);
      expect(selectCompletedSeed(current, f.control(), content)?.origin.operation).toBe('reused');
      writeFileSync(path.join(share, 'postgres.bki'), 'genuinely changed catalog content');
      const changed = captureSeedContentIntent(
        f.intent,
        { contract: 'actual desired contract' },
        share,
      );
      expect(selectCompletedSeed(current, control, changed)).toBeUndefined();
      expect(() => selectCompletedSeed(current, control)).toThrow('observed desired');
      expect(() =>
        selectCompletedSeed(
          current,
          { ...control, publication: { ...publication, publicationTree: '1'.repeat(40) } },
          content,
        ),
      ).toThrow('completed origin differs');
      const edited = structuredClone(anchor);
      edited.seeds[0].receipt.contents += ' ';
      expect(() => validateSeedConstructionAnchor(edited)).toThrow('receipt size differs');
      const fabricated = structuredClone(anchor);
      const raw = JSON.parse(fabricated.seeds[0].receipt.contents);
      raw.origin = { kind: 'constructed' };
      fabricated.seeds[0].receipt.contents = JSON.stringify(raw);
      fabricated.seeds[0].receipt.size = Buffer.byteLength(fabricated.seeds[0].receipt.contents);
      fabricated.seeds[0].receipt.sha256 = createHash('sha256')
        .update(fabricated.seeds[0].receipt.contents)
        .digest('hex');
      expect(() => validateSeedConstructionAnchor(fabricated)).toThrow('explicit adoption');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('copied seed creator facts survive version promotion while WASIX consumer binds actual final bytes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-producer-identity-'));
  const contract = JSON.parse(
    readFileSync(
      new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
      'utf8',
    ),
  );
  const publication = {
    product: 'database-resources',
    version: '0.2.2',
    tagName: 'database-resources-v0.2.2',
    publicationSha: 'a'.repeat(40),
    publicationTree: 'b'.repeat(40),
    releaseSha: 'c'.repeat(40),
  };
  const id = (file: string) => {
    return identity(file);
  };
  try {
    for (const family of ['native', 'wasix'] as const) {
      const base = path.join(root, family);
      const pgdata = path.join(base, 'pgdata');
      for (const dir of contract.pgdataDirectories)
        mkdirSync(path.join(pgdata, dir), { recursive: true });
      writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
      writeFileSync(path.join(pgdata, 'global/pg_control'), 'opaque original control');
      writeFileSync(path.join(pgdata, 'pg_wal/000000010000000000000001'), 'opaque original WAL');
      const runtime = path.join(base, 'runtime');
      mkdirSync(path.join(runtime, 'bin'), { recursive: true });
      writeFileSync(path.join(runtime, 'bin/postgres'), 'original actual postgres bytes');
      writeFileSync(path.join(runtime, 'bin/initdb'), 'original actual initdb bytes');
      const target = family === 'native' ? 'linux-x64-gnu' : 'portable';
      const slot = { family, target, profile: 'standard' as const };
      const originalProducer = captureSeedProducerIdentity(runtime, target);
      const bootstrap = path.join(base, 'bootstrap.sql');
      writeFileSync(bootstrap, 'declared same bootstrap content');
      const content = captureSeedConstructionIntent(slot, { contract }, { bootstrap });
      const frozen = path.join(base, 'frozen.tar');
      writeFileSync(frozen, await createDeterministicTar(pgdata));
      const assets = await packageClusterSeed({
        family,
        target,
        profile: 'standard',
        pgdata,
        runtime,
        contract,
        version: '0.2.2',
        runtimeVersion: '0.3.2',
        outputDir: path.join(base, 'public'),
      });
      writeFileSync(path.join(runtime, 'bin/postgres'), 'preversion current actual postgres');
      writeFileSync(path.join(runtime, 'bin/initdb'), 'preversion current actual initdb');
      const beforeIntent = captureSeedConstructionIntent(
        slot,
        { contract, producer: captureSeedProducerIdentity(runtime, target) },
        { runtime },
      );
      const fresh = writeSeedConstructionReceipt(
        path.join(base, 'fresh.seed-construction.json'),
        beforeIntent,
        frozen,
        pgdata,
      );
      expect(seedProducerIdentity(fresh)).toEqual(captureSeedProducerIdentity(runtime, target));
      expect(
        seedProducerIdentity({
          ...fresh,
          intent: {
            ...fresh.intent,
            invocation: { producer: { ...originalProducer, extra: 'never copied into source' } },
          },
        }),
      ).toEqual(originalProducer);
      const completed = selectCompletedSeed(
        beforeIntent,
        {
          operation: 'adopt',
          publication,
          archive: id(assets.archive),
          manifest: id(assets.manifest),
        },
        content,
      )!;
      const receiptFile = path.join(base, 'adopted.seed-construction.json');
      const adopted = writeSeedConstructionReceipt(
        receiptFile,
        beforeIntent,
        frozen,
        pgdata,
        completed.origin,
        content,
        completed.sourceManifest,
      );
      expect(seedProducerIdentity(adopted)).toEqual(originalProducer);
      expect(() => seedProducerIdentity({ ...adopted, sourceManifest: undefined })).toThrow(
        'original completed descriptor',
      );
      expect(() =>
        validateSeedConstructionReceipt({
          ...adopted,
          sourceManifest: {
            ...adopted.sourceManifest,
            contents: adopted.sourceManifest!.contents + ' ',
          },
        }),
      ).toThrow('descriptor bytes differ');
      writeFileSync(path.join(runtime, 'bin/postgres'), 'final compiled bumped runtime bytes');
      writeFileSync(path.join(runtime, 'bin/initdb'), 'final compiled bumped initdb bytes');
      const finalIntent = captureSeedConstructionIntent(
        slot,
        { contract, producer: captureSeedProducerIdentity(runtime, target) },
        { runtime },
      );
      const promotion = {
        source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
        evidenceDigest: `sha256:${'f'.repeat(64)}`,
        invocationId: 'original-qualified-construction',
        frozen: id(frozen),
        receipt: id(receiptFile),
        transition: {
          source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
          updatesSha256: '3'.repeat(64),
        },
      };
      const selected = selectQualifiedSeed(finalIntent, promotion, content)!;
      const promoted = writePromotedSeedReceipt(
        path.join(base, 'promoted.seed-construction.json'),
        selected,
        frozen,
        pgdata,
      );
      expect(promoted.intent).toEqual(adopted.intent);
      expect(promoted.sourceManifest).toEqual(adopted.sourceManifest);
      expect(promoted.pgdata).toEqual(adopted.pgdata);
      expect(seedProducerIdentity(promoted)).toEqual(originalProducer);
      const final = await packageClusterSeed({
        family,
        target,
        profile: 'standard',
        pgdata,
        runtime,
        contract,
        version: '0.2.3',
        runtimeVersion: '0.3.3',
        outputDir: path.join(base, 'final'),
        producer: seedProducerIdentity(promoted),
        nativeSourceManifest: family === 'native' ? promoted.sourceManifest?.contents : undefined,
      });
      const descriptor = JSON.parse(readFileSync(final.manifest, 'utf8'));
      expect(descriptor.runtime.version).toBe(
        family === 'native'
          ? JSON.parse(promoted.sourceManifest?.contents ?? '{}').runtime?.version
          : '0.3.3',
      );
      if (family === 'native')
        expect({
          postgresSha256: descriptor.source.postgresSha256,
          initdbSha256: descriptor.source.initdbSha256,
        }).toEqual(originalProducer);
      else {
        expect(descriptor.runtime.consumerSha256).toBe(
          captureSeedProducerIdentity(runtime, target).postgresSha256,
        );
        expect(descriptor.runtime.producerSha256).toBe(originalProducer.postgresSha256);
        expect(descriptor.runtime.initdbSha256).toBe(originalProducer.initdbSha256);
        expect(descriptor.runtime.consumerSha256).not.toBe(descriptor.runtime.producerSha256);
      }
      writeFileSync(bootstrap, 'changed desired bootstrap content');
      const changed = captureSeedConstructionIntent(slot, { contract }, { bootstrap });
      expect(() => selectQualifiedSeed(finalIntent, promotion, changed)).toThrow(
        'declared seed contents',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'declared Bun module trees bind sandbox leaf links to exact logical members and source bytes',
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'seed-module-transport-'));
    try {
      const originals = path.join(root, 'declared');
      const output = path.join(root, 'producer-tree');
      const sandbox = path.join(root, 'sandbox-tree');
      for (const directory of [originals, output, sandbox])
        mkdirSync(path.join(directory, 'tools'), { recursive: true });
      const source = path.join(originals, 'tools/seed.mts');
      const copied = path.join(output, 'tools/seed.mts');
      const linked = path.join(sandbox, 'tools/seed.mts');
      writeFileSync(source, 'exact source-owned constructor bytes\n');
      copyFileSync(source, copied);
      symlinkSync(copied, linked); // Ordinary sandbox absolute links leave the sandbox root.
      const slot = {
        family: 'native' as const,
        profile: 'standard' as const,
        target: 'linux-arm64-gnu',
      };
      const inputs = (tree: string) => ({ 'tools/source': source, 'tools/copied': tree });
      const declared = { 'tools/copied': { 'tools/seed.mts': source } };
      const intent = () =>
        captureSeedConstructionIntent(slot, { command: 'initdb' }, inputs(sandbox), declared);
      expect(intent()).toEqual(
        captureSeedConstructionIntent(slot, { command: 'initdb' }, inputs(output), declared),
      );
      expect(() => captureSeedConstructionIntent(slot, {}, inputs(sandbox))).toThrow(
        'actual Files: tools/copied/tools/seed.mts',
      );
      writeFileSync(path.join(sandbox, 'extra.mts'), 'undeclared source');
      expect(intent).toThrow('undeclared member');
      rmSync(path.join(sandbox, 'extra.mts'));
      rmSync(linked);
      expect(intent).toThrow('missing a declared File');
      symlinkSync(copied, linked);
      writeFileSync(copied, 'substituted producer output');
      expect(intent).toThrow('differs from its declared File');
      writeFileSync(copied, readFileSync(source));
      mkdirSync(path.join(sandbox, 'extra-directory'));
      expect(intent).toThrow('undeclared directory');
      rmSync(path.join(sandbox, 'extra-directory'), { recursive: true });
      rmSync(path.join(sandbox, 'tools'), { recursive: true });
      symlinkSync(path.join(output, 'tools'), path.join(sandbox, 'tools'), 'dir');
      expect(intent).toThrow('undeclared member');
      expect(() =>
        captureSeedConstructionIntent(slot, {}, inputs(output), {
          unknown: declared['tools/copied'],
        }),
      ).toThrow('declared input');
      expect(() =>
        captureSeedConstructionIntent(slot, {}, inputs(output), {
          'tools/copied': { '../escape': source },
        }),
      ).toThrow('safe logical name');
      expect(() =>
        captureSeedConstructionIntent(slot, {}, inputs(output), {
          'tools/copied': { 'tools/seed.mts': copied },
        }),
      ).toThrow('declared File');
      expect(() =>
        captureSeedConstructionIntent(slot, {}, inputs(output), { 'tools/copied': {} }),
      ).toThrow('declared members');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'Bazel expanded runtime leaves preserve constructor intent and reject missing, unknown and substituted Files',
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'seed-runtime-tree-'));
    try {
      const producer = path.join(root, 'producer');
      const sandbox = path.join(root, 'sandbox');
      const members = ['bin/postgres', 'share/postgresql/postgres.bki'];
      for (const member of members) {
        for (const base of [producer, sandbox])
          mkdirSync(path.dirname(path.join(base, member)), { recursive: true });
        writeFileSync(path.join(producer, member), `declared runtime ${member}`);
        symlinkSync(path.join(producer, member), path.join(sandbox, member));
      }
      const logical = 'src/wasix/runtime/portable_payload_files';
      const inputs = (directory: string) => ({ [logical]: directory });
      const leaves = (directory: string) => members.map((member) => path.join(directory, member));
      const expanded = (directory: string, files = leaves(directory)) =>
        expandSeedConstructionTrees(inputs(directory), [directory], files);
      const capture = (profile: 'standard' | 'icu', declared: ReturnType<typeof expanded>) =>
        captureSeedConstructionIntent(
          { family: 'wasix', target: 'portable', profile },
          {},
          declared.inputs,
          declared.treeMembers,
        );
      const declared = expanded(sandbox);
      expect(declared.inputs[`${logical}/bin/postgres`]).toBe(path.join(producer, 'bin/postgres'));
      for (const profile of ['standard', 'icu'] as const) {
        expect(capture(profile, declared)).toEqual(capture(profile, expanded(producer)));
        expect(capture(profile, expanded(sandbox, leaves(sandbox).reverse()))).toEqual(
          capture(profile, declared),
        );
      }
      expect(() =>
        captureSeedConstructionIntent(
          { family: 'wasix', target: 'portable', profile: 'standard' },
          {},
          inputs(sandbox),
        ),
      ).toThrow('actual Files');
      expect(() => capture('standard', expanded(sandbox, leaves(sandbox).slice(0, 1)))).toThrow(
        'undeclared directory',
      );
      expect(() =>
        expandSeedConstructionTrees(
          inputs(sandbox),
          [sandbox],
          [...leaves(sandbox), leaves(sandbox)[0]],
        ),
      ).toThrow('more than once');
      expect(() => expanded(sandbox, leaves(producer))).toThrow('exact declared input root');
      expect(() => expanded(sandbox, [path.join(sandbox, 'share/postgresql')])).toThrow(
        'actual regular primary File',
      );
      expect(() =>
        expandSeedConstructionTrees(inputs(sandbox), [producer], leaves(producer)),
      ).toThrow('declared logical File');
      expect(() => expandSeedConstructionTrees(inputs(sandbox), [sandbox], [])).toThrow(
        'no declared leaf Files',
      );
      expect(() =>
        expandSeedConstructionTrees(inputs(sandbox), [sandbox], leaves(sandbox), {
          [logical]: { [members[0]]: path.join(producer, members[0]) },
        }),
      ).toThrow('already has a declared member inventory');
      expect(() =>
        expandSeedConstructionTrees(
          { ...inputs(sandbox), nested: path.join(sandbox, 'bin') },
          [sandbox, path.join(sandbox, 'bin')],
          leaves(sandbox),
        ),
      ).toThrow('must not overlap');
      writeFileSync(path.join(sandbox, 'extra'), 'unlisted runtime');
      expect(() => capture('standard', declared)).toThrow('undeclared member');
      rmSync(path.join(sandbox, 'extra'));
      const alias = path.join(sandbox, members[0]);
      rmSync(alias);
      expect(() => capture('standard', declared)).toThrow('missing a declared File');
      const wrong = path.join(root, 'wrong');
      writeFileSync(wrong, 'substituted runtime');
      symlinkSync(wrong, alias);
      expect(() => capture('standard', declared)).toThrow('differs from its declared File');
      rmSync(path.join(sandbox, 'bin'), { recursive: true });
      symlinkSync(path.join(producer, 'bin'), path.join(sandbox, 'bin'), 'dir');
      expect(() => expanded(sandbox)).toThrow('aliased parent directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
