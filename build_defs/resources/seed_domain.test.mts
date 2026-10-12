import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bindNativeClusterSeedManifest,
  filesystemTreeRows,
  logicalTreeSha256,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  captureSeedConstructionIntent,
  captureSeedProducerIdentity,
  seedProducerIdentity,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';
import { constructSeedDomain } from './seed_domain.mts';

const identity = (file: string) => ({
  path: file,
  size: readFileSync(file).length,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
});

test('domain keeps its own public PGDATA, binds real ABI inputs, and promotes one exact frozen seed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-domain-construction-'));
  try {
    const contract = JSON.parse(
      readFileSync(
        new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
        'utf8',
      ),
    );
    const host = path.join(root, 'host');
    const pgdata = path.join(host, 'files');
    for (const directory of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, directory), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    writeFileSync(path.join(pgdata, 'global/pg_control'), 'opaque host nonce');
    writeFileSync(path.join(pgdata, 'pg_wal/000000010000000000000001'), 'opaque host WAL');
    const fields = {
      schema: 'oliphaunt-native-mobile-abi-v1',
      byteOrder: 'little',
      datumBytes: '8',
      maximumAlignof: '8',
      float8ByVal: '1',
      blockSize: '8192',
      walBlockSize: '8192',
      relationSegmentSize: '131072',
      nameDataLength: '64',
      indexMaxKeys: '32',
      catalogVersion: '202506291',
      pgControlVersion: '1800',
    };
    const receipts = ['android-arm64-v8a', 'android-x86_64', 'linux-x64-gnu'].map((target) => {
      const file = path.join(root, `${target}.properties`);
      writeFileSync(
        file,
        `${Object.entries({ ...fields, target })
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')}\n`,
      );
      return file;
    });
    writeFileSync(path.join(host, 'abi.properties'), readFileSync(receipts[2]));
    const values = {
      schema: contract.manifests.native.schema,
      layout: contract.manifests.native.layout,
      artifactRole: contract.profiles.standard.artifactRole,
      catalogProfile: 'standard',
      postgresMajor: '18',
      physicalFormat: contract.physicalFormats.native,
      initialSuperuser: 'postgres',
      icuDataVersion: '',
      icuDataForm: '',
      icuDataTreeSha256: '',
      runtimeFeatures: contract.profiles.standard.requiredRuntimeFeatures.join(','),
      cacheKey: logicalTreeSha256(filesystemTreeRows(pgdata)),
    };
    writeFileSync(
      path.join(host, 'manifest.properties'),
      bindNativeClusterSeedManifest(
        Buffer.from(
          `${Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n')}\n`,
        ),
        'linux-x64-gnu',
        'standard',
      ),
    );
    const frozen = path.join(root, 'host.tar');
    writeFileSync(frozen, await createDeterministicTar(host));
    const recipe = path.join(root, 'recipe.mts');
    writeFileSync(recipe, 'declared actual domain recipe fixture');
    const runtime = path.join(root, 'runtime');
    mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    writeFileSync(path.join(runtime, 'bin/postgres'), 'formatter-only runtime');
    writeFileSync(path.join(runtime, 'bin/initdb'), 'formatter-only runtime');
    const producerConstruction = path.join(root, 'host.seed-construction.json');
    const producerIntent = captureSeedConstructionIntent(
      { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
      { contract, producer: captureSeedProducerIdentity(runtime, 'linux-x64-gnu') },
      {
        recipe,
        postgres: path.join(runtime, 'bin/postgres'),
        initdb: path.join(runtime, 'bin/initdb'),
      },
    );
    writeSeedConstructionReceipt(
      producerConstruction,
      producerIntent,
      frozen,
      pgdata,
      undefined,
      producerIntent,
    );
    const inputs = {
      seed: frozen,
      recipe,
      ...Object.fromEntries(receipts.map((file, index) => [`abi-${index}`, file])),
    };
    const spec = {
      seed: frozen,
      producerConstruction,
      producerTarget: 'linux-x64-gnu',
      domain: 'android-datum64',
      profile: 'standard',
      receipts,
      icu: null,
      contract,
      constructionInputs: inputs,
      output: path.join(root, 'constructed.tar'),
      constructionOutput: path.join(root, 'constructed.seed-construction.json'),
    };
    await constructSeedDomain(spec);
    const constructed = JSON.parse(readFileSync(spec.constructionOutput, 'utf8'));
    expect(constructed.intent.target).toBe('android-datum64');
    expect(constructed.origin.kind).toBe('constructed');
    expect(seedProducerIdentity(constructed)).toEqual(
      captureSeedProducerIdentity(runtime, 'linux-x64-gnu'),
    );
    const publicPgdata = path.join(root, 'public-pgdata');
    mkdirSync(publicPgdata);
    // Formatter fixtures isolate immutable-data selection; actual installed tests qualify execution.
    for (const directory of contract.pgdataDirectories)
      mkdirSync(path.join(publicPgdata, directory), { recursive: true });
    writeFileSync(path.join(publicPgdata, 'PG_VERSION'), '18\n');
    writeFileSync(
      path.join(publicPgdata, 'global/pg_control'),
      'different authentic-domain nonce fixture',
    );
    writeFileSync(
      path.join(publicPgdata, 'pg_wal/000000010000000000000001'),
      'different domain WAL fixture',
    );

    const assets = await packageClusterSeed({
      family: 'native',
      target: 'android-datum64',
      profile: 'standard',
      pgdata: publicPgdata,
      runtime,
      contract,
      version: '0.2.2',
      runtimeVersion: '0.3.2',
      outputDir: path.join(root, 'assets'),
    });
    const reuse = {
      operation: 'adopt',
      publication: {
        product: 'database-resources',
        version: '0.2.2',
        tagName: 'database-resources-v0.2.2',
        publicationSha: 'a'.repeat(40),
        publicationTree: 'b'.repeat(40),
        releaseSha: 'c'.repeat(40),
      },
      archive: identity(assets.archive),
      manifest: identity(assets.manifest),
    };
    const adoptedSpec = {
      ...spec,
      reuse,
      output: path.join(root, 'adopted.tar'),
      constructionOutput: path.join(root, 'adopted.seed-construction.json'),
    };
    await constructSeedDomain(adoptedSpec);
    const adopted = JSON.parse(readFileSync(adoptedSpec.constructionOutput, 'utf8'));
    expect(adopted.origin.operation).toBe('adopted');
    expect(adopted.pgdata.treeSha256).toBe(logicalTreeSha256(filesystemTreeRows(publicPgdata)));
    expect(adopted.pgdata.treeSha256).not.toBe(constructed.pgdata.treeSha256);
    const promotion = {
      source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
      evidenceDigest: `sha256:${'f'.repeat(64)}`,
      invocationId: 'original-diagnostic-construction',
      frozen: identity(adoptedSpec.output),
      receipt: identity(adoptedSpec.constructionOutput),
      transition: {
        source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
        updatesSha256: '3'.repeat(64),
      },
    };
    writeFileSync(recipe, 'changed qualification recipe fixture');
    const promotedSpec = {
      ...spec,
      promotion,
      output: path.join(root, 'promoted.tar'),
      constructionOutput: path.join(root, 'promoted.seed-construction.json'),
    };
    await constructSeedDomain(promotedSpec);
    const promoted = JSON.parse(readFileSync(promotedSpec.constructionOutput, 'utf8'));
    expect(identity(promotedSpec.output).sha256).toBe(identity(adoptedSpec.output).sha256);
    expect(promoted.intent).toEqual(adopted.intent);
    expect(promoted.qualificationIntent).not.toEqual(adopted.intent);
    writeFileSync(
      receipts[0],
      readFileSync(receipts[0], 'utf8').replace('maximumAlignof=8', 'maximumAlignof=16'),
    );
    const rejected = { ...spec, reuse, output: path.join(root, 'rejected.tar') };
    await expect(constructSeedDomain(rejected)).rejects.toThrow('ABI mismatch');
    expect(existsSync(rejected.output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
