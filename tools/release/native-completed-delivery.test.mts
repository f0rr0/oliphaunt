import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mavenPom } from '../../build_defs/languages/jvm/maven-pom.mts';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { packagePayload } from '../packaging/native-cargo-payload.mts';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';
import { captureNativeBuildEvidence } from './capture-native-build-evidence.mts';
import { fixture as observationFixture } from './completed-native-publication.fixture.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import { nativeBuildMetadata } from './native-build-qualification.mts';
import {
  captureCompletedNativePublicArtifacts,
  captureCompletedNativeRegistryCarriers,
  compareNativeCompletedPhysicalDelivery,
  nativeArchiveDeliveryMembers,
  nativeCarrierDeliveryMembers,
  readCompletedNativeDeliveryInventory,
} from './native-completed-delivery.mts';
import {
  compareNativePreVersionDelivery,
  differentNativeDeliveredMembers,
} from './native-publication-delivery.mts';
import { nativePublicationMetadataArtifactRow } from './native-publication-metadata-contract.mts';
import { observeNativePublicationConstruction } from './native-publication-observation.mts';
import {
  loadPublicationCatalog,
  PUBLICATION_CATALOG_SCHEMA,
  publicationCatalogDigest,
  resolveActualCarrier,
} from './publication-catalog.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import {
  buildPublicationCandidate,
  expectedProductArtifactRows,
  lockedPublicationFiles,
  PUBLICATION_CANDIDATE_SCHEMA,
  sourceIdentity,
  validatePublicationCandidate,
} from './publication-lock.mts';

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const artifact = (file: string) => ({
  path: file,
  size: readFileSync(file).length,
  sha256: hash(file),
});
function scratch(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'completed-native-delivery-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
async function asyncScratch(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'completed-native-delivery-'));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function carrier(ecosystem: string, name: string, version: string, files: string[]) {
  return { id: `${ecosystem}:${name}`, ecosystem, name, version, artifacts: files.map(artifact) };
}
const metadata = {
  name: 'Oliphaunt test',
  description: 'Declared Maven source',
  inceptionYear: '2026',
  url: 'https://oliphaunt.dev',
  license: { name: 'MIT', url: 'https://opensource.org/license/mit', distribution: 'repo' },
  developer: { id: 'oliphaunt', name: 'Oliphaunt', url: 'https://github.com/f0rr0' },
  scm: {
    url: 'https://github.com/f0rr0/oliphaunt',
    connection: 'scm:git:https://github.com/f0rr0/oliphaunt.git',
    developerConnection: 'scm:git:ssh://git@github.com/f0rr0/oliphaunt.git',
  },
};
function maven(
  directory: string,
  version: string,
  dependency = '0.3.2',
  changed: Record<string, string> = {},
) {
  mkdirSync(directory, { recursive: true });
  const prefix = path.join(directory, `library-${version}`);
  writeFileSync(
    `${prefix}.pom`,
    mavenPom({
      coordinate: { groupId: 'dev.oliphaunt', artifactId: 'library', version, packaging: 'aar' },
      metadata,
      dependencies: [{ module: 'dev.oliphaunt.runtime:liboliphaunt', version: dependency }],
    }),
  );
  for (const [suffix, members] of Object.entries({
    '.aar': {
      'AndroidManifest.xml': '<manifest/>',
      'classes.jar': 'exact compiler JAR bytes',
      'jni/arm64-v8a/liboliphaunt.so': 'exact compiled version public API 0.3.3',
    },
    '-sources.jar': { 'Public.kt': '// exact shipped docs and source' },
    '-javadoc.jar': { 'index.html': '<p>Shipped API</p>' },
  }))
    writeFileSync(
      prefix + suffix,
      zipArchive(
        Object.entries(members).map(([name, data]) => ({ name, data: changed[name] ?? data })),
      ),
    );
  return carrier(
    'maven',
    'dev.oliphaunt:library',
    version,
    ['.pom', '.aar', '-sources.jar', '-javadoc.jar'].map((suffix) => prefix + suffix),
  );
}

test('actual Maven writer neutralizes only root coordinate and keeps held pins and all companions', () =>
  scratch((directory) => {
    const before = maven(path.join(directory, 'old'), '0.1.0');
    const current = maven(path.join(directory, 'new'), '0.2.0');
    expect(
      differentNativeDeliveredMembers(
        nativeCarrierDeliveryMembers(before)!,
        nativeCarrierDeliveryMembers(current)!,
      ),
    ).toEqual([]);
    const adopted = maven(path.join(directory, 'adopted'), '0.2.0', '0.3.3');
    expect(
      differentNativeDeliveredMembers(
        nativeCarrierDeliveryMembers(before)!,
        nativeCarrierDeliveryMembers(adopted)!,
      ),
    ).toEqual(['.pom']);
    for (const member of ['Public.kt', 'index.html', 'jni/arm64-v8a/liboliphaunt.so']) {
      const changed = maven(path.join(directory, member.replaceAll('/', '_')), '0.2.0', '0.3.2', {
        [member]: 'actual changed delivered bytes',
      });
      expect(
        differentNativeDeliveredMembers(
          nativeCarrierDeliveryMembers(before)!,
          nativeCarrierDeliveryMembers(changed)!,
        ),
      ).toHaveLength(1);
    }
  }));

test('Maven rejects incomplete/duplicate identities and leaves unsupported module contracts unknown', () =>
  scratch((directory) => {
    const current = maven(directory, '0.1.0');
    expect(() => nativeCarrierDeliveryMembers({ ...current, version: '0.2.0' })).toThrow(
      'own coordinate',
    );
    expect(() =>
      nativeCarrierDeliveryMembers({ ...current, artifacts: current.artifacts.slice(0, 2) }),
    ).toThrow('missing required file');
    expect(() =>
      nativeCarrierDeliveryMembers({
        ...current,
        artifacts: [...current.artifacts, current.artifacts[1]],
      }),
    ).toThrow('duplicate');
    const module = path.join(directory, 'library-0.1.0.module');
    writeFileSync(module, JSON.stringify({ component: { version: '0.1.0' }, variants: [] }));
    expect(
      nativeCarrierDeliveryMembers({
        ...current,
        artifacts: [...current.artifacts, artifact(module)],
      }),
    ).toBeUndefined();
    writeFileSync(
      current.artifacts[0].path,
      readFileSync(current.artifacts[0].path, 'utf8').replace(
        '<version>0.1.0</version>',
        '<version>0.1.0</version><version>0.1.0</version>',
      ),
    );
    expect(() => nativeCarrierDeliveryMembers(current)).toThrow('exactly one <version>');
  }));

test('Maven keeps source/byte modes and rejects unsafe packed entries', () =>
  scratch((directory) => {
    const current = maven(directory, '0.1.0');
    const source = current.artifacts.find(({ path }) => path.endsWith('-sources.jar'))!.path;
    const before = nativeCarrierDeliveryMembers(current)!;
    writeFileSync(
      source,
      zipArchive([
        {
          name: 'Public.kt',
          data: '// exact shipped docs and source',
          externalAttributes: 0o100755 << 16,
        },
      ]),
    );
    expect(differentNativeDeliveredMembers(before, nativeCarrierDeliveryMembers(current)!)).toEqual(
      ['-sources.jar/Public.kt'],
    );
    writeFileSync(source, zipArchive([{ name: '../outside', data: 'outside' }]));
    expect(() => nativeCarrierDeliveryMembers(current)).toThrow(/unsafe|traversal|relative/);
  }));

test('outer archive representation and producer inputs cannot erase exact inner delivery differences', () =>
  scratch((directory) => {
    const old = path.join(directory, 'old.tar.gz');
    const next = path.join(directory, 'next.zip');
    const file = {
      name: 'runtime/bin/psql',
      data: 'actual public interface version 0.3.3',
      mode: 0o755,
    };
    writeFileSync(old, tarArchive([file]));
    writeFileSync(next, zipArchive([{ ...file, externalAttributes: 0o100755 << 16, method: 8 }]));
    expect(
      differentNativeDeliveredMembers(
        nativeArchiveDeliveryMembers(old),
        nativeArchiveDeliveryMembers(next),
      ),
    ).toEqual([]);
    for (const change of [
      { data: 'public interface version 0.3.4' },
      { name: 'runtime/bin/renamed' },
      { externalAttributes: 0o100644 << 16 },
    ]) {
      writeFileSync(next, zipArchive([{ ...file, externalAttributes: 0o100755 << 16, ...change }]));
      expect(
        differentNativeDeliveredMembers(
          nativeArchiveDeliveryMembers(old),
          nativeArchiveDeliveryMembers(next),
        ).length,
      ).toBeGreaterThan(0);
    }
  }));

test('actual split Cargo writer preserves every payload, legal and aggregator member', () =>
  scratch((directory) => {
    const payload = path.join(directory, 'payload');
    mkdirSync(path.join(payload, 'runtime/bin'), { recursive: true });
    writeFileSync(path.join(payload, 'runtime/bin/psql'), Buffer.alloc(96, 7));
    chmodSync(path.join(payload, 'runtime/bin/psql'), 0o755);
    const output = path.join(directory, 'output');
    mkdirSync(output);
    const packages = packagePayload(
      payload,
      path.join(directory, 'source'),
      output,
      path.join(directory, 'cargo'),
      {
        target: { target: 'linux-x64-gnu', triple: 'x86_64-unknown-linux-gnu' },
        version: '9.8.7',
        partBytes: 64,
        packageBase: 'oliphaunt-tools',
        artifactProduct: 'postgres-tools-native',
        artifactKind: 'native-tools',
        artifactLabel: 'tools',
        noticeProfile: 'native-tools',
        executableFiles: ['runtime/bin/psql'],
      },
    );
    const parts = packages.filter(({ role }) => role === 'part');
    expect(parts.length).toBeGreaterThan(1);
    for (const item of packages) {
      const record = carrier('cargo', item.name, item.version, [item.cratePath]);
      const members = nativeCarrierDeliveryMembers(record)!;
      expect(members.some(({ path }) => path === 'Cargo.toml')).toBe(true);
      expect(members.some(({ path }) => path === 'THIRD_PARTY_NOTICES.md')).toBe(true);
      expect(members.some(({ path }) => path === 'build.rs')).toBe(true);
      if (item.role === 'part')
        expect(members.some(({ path }) => path.startsWith('payload/chunks/'))).toBe(true);
      const rows = [...readPortableArchiveEntries(item.cratePath).values()].map((entry) => ({
        name: entry.name + (entry.isDirectory ? '/' : ''),
        type: entry.isFile ? '0' : '5',
        mode: entry.mode,
        data: entry.isFile ? entry.data() : Buffer.alloc(0),
      }));
      const target = rows.find((row) => row.name.endsWith('/build.rs'))!;
      target.data = Buffer.concat([
        target.data,
        Buffer.from('\n// changed reconstruction recipe\n'),
      ]);
      const changed = path.join(directory, item.name + '.crate');
      writeFileSync(changed, tarArchive(rows));
      expect(
        differentNativeDeliveredMembers(
          members,
          nativeCarrierDeliveryMembers(carrier('cargo', item.name, item.version, [changed]))!,
        ),
      ).toEqual(['build.rs']);
    }
  }));

async function publicFixture(directory: string, id: string, version = '9.8.7') {
  const product = {
    ...loadPublicationCatalog('completed public fixture', { products: [id] }).products[0],
    version,
  };
  const rows = expectedProductArtifactRows([product]).filter(({ role }) =>
    role.startsWith('github-release-'),
  );
  const files: Record<string, string> = {};
  for (const row of rows) {
    const file = path.join(directory, 'release-assets', row.name);
    files[row.id] = file;
    if (row.kind === 'checksums') continue;
    if (row.role === 'github-release-metadata' || row.name.endsWith('.json')) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        row.kind === 'manifest-properties' ? 'fixture=exact\n' : '{"fixture":"exact"}\n',
      );
      continue;
    }
    const payload = path.join(directory, 'members', row.name);
    if (['native-seeds', 'wasix-seeds'].includes(row.kind)) {
      mkdirSync(path.join(payload, 'global'), { recursive: true });
      mkdirSync(path.join(payload, 'pg_wal'), { recursive: true });
      writeFileSync(path.join(payload, 'PG_VERSION'), '18\n');
      writeFileSync(path.join(payload, 'global/pg_control'), 'frozen control identity');
      writeFileSync(path.join(payload, 'pg_wal/000000010000000000000001'), 'frozen WAL identity');
      await archiveDirectory(payload, file);
      continue;
    }
    mkdirSync(path.join(payload, 'runtime/bin'), { recursive: true });
    writeFileSync(
      path.join(payload, 'runtime/bin/psql'),
      'exact installed tools and held runtime API',
    );
    chmodSync(path.join(payload, 'runtime/bin/psql'), 0o755);
    writeFileSync(path.join(payload, 'THIRD_PARTY_NOTICES.md'), 'exact declared license bytes');
    await archiveDirectory(payload, file);
  }
  for (const row of rows.filter(({ kind }) => kind === 'checksums'))
    writeFileSync(
      files[row.id],
      rows
        .filter(({ kind }) => kind !== 'checksums')
        .map(({ id, name }) => `${hash(files[id])}  ./${name}\n`)
        .join(''),
    );
  const publication = {
    product: id,
    version,
    tagName: `${id}-v${version}`,
    publicationSha: '1'.repeat(40),
    publicationTree: '2'.repeat(40),
    releaseSha: '3'.repeat(40),
  };
  // These responses exercise the production API/physical contract. They do
  // not claim that the local writer fixture is an actual published release.
  const release = {
    id: 123,
    tag_name: publication.tagName,
    target_commitish: publication.publicationSha,
    draft: false,
    prerelease: false,
  };
  const assets = rows.map(({ id, name }, index) => ({
    id: index + 1,
    name,
    size: readFileSync(files[id]).length,
    digest: `sha256:${hash(files[id])}`,
    state: 'uploaded',
    url: `https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/${index + 1}`,
  }));
  const options = {
    assertCompletedPublication: async (requested) => {
      expect(requested).toEqual(publication);
      return publication;
    },
    readJson: async (endpoint) => {
      if (endpoint === `repos/f0rr0/oliphaunt/releases/tags/${publication.tagName}`) return release;
      const match = endpoint.match(
        /^repos\/f0rr0\/oliphaunt\/contents\/(.+)\?ref=([a-f0-9]{40})$/u,
      );
      if (!match || match[2] !== publication.publicationSha)
        throw new Error(`unexpected fixture historical endpoint ${endpoint}`);
      const file = match[1];
      const bytes =
        file === '.release-please-manifest.json'
          ? Buffer.from(
              JSON.stringify({
                ...JSON.parse(
                  readFileSync(
                    new URL('../../.release-please-manifest.json', import.meta.url),
                    'utf8',
                  ),
                ),
                [product.path]: version,
              }),
            )
          : readFileSync(new URL(`../../${file}`, import.meta.url));
      return {
        type: 'file',
        path: file,
        encoding: 'base64',
        content: bytes.toString('base64'),
        sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      };
    },
    readPages: async (endpoint) => {
      expect(endpoint).toBe('repos/f0rr0/oliphaunt/releases/123/assets');
      return assets;
    },
    proveAsset: async () => {
      throw new Error('published API digest already binds every archive');
    },
  };
  return { input: { publication, files }, options, rows, release, assets };
}

test('canonical native and WASIX public inventory binds actual archive writer bytes and exact member changes', async () =>
  asyncScratch(async (directory) => {
    for (const product of ['postgres-tools-native', 'postgres-tools-wasix']) {
      const fixture = await publicFixture(path.join(directory, product), product);
      const baseline = await captureCompletedNativePublicArtifacts(fixture.input, fixture.options);
      expect(baseline.unknowns).toEqual([]);
      expect(baseline.archives).toHaveLength(
        fixture.rows.filter(({ kind }) => kind !== 'checksums').length,
      );
      expect(baseline.scope).toBe('construction');
      const row = baseline.archives.find(({ target }) => target === 'linux-x64-gnu')!;
      const original = fixture.input.files[row.id];
      expect(
        differentNativeDeliveredMembers(row.members, nativeArchiveDeliveryMembers(original)),
      ).toEqual([]);
      const changed = path.join(directory, `${product}-changed.tar.gz`);
      writeFileSync(
        changed,
        tarArchive([
          { name: 'runtime/bin/psql', data: 'new real compiled public interface', mode: 0o755 },
          { name: 'THIRD_PARTY_NOTICES.md', data: 'exact declared license bytes' },
          { name: 'runtime', type: '5', mode: 0o755 },
          { name: 'runtime/bin', type: '5', mode: 0o755 },
        ]),
      );
      expect(
        differentNativeDeliveredMembers(row.members, nativeArchiveDeliveryMembers(changed)),
      ).toEqual(['runtime/bin/psql']);
      fixture.input.files[row.id] = changed;
      await expect(
        captureCompletedNativePublicArtifacts(fixture.input, fixture.options),
      ).rejects.toThrow('archive bytes differ');
    }
  }));

test('public baseline rejects source/asset substitutions and preserves missing or extra deliveries as unknown', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'postgres-tools-wasix');
    const row = fixture.rows.find(
      ({ kind, target }) => kind !== 'checksums' && target === 'linux-x64-gnu',
    )!;
    const call = (input = fixture.input, options = fixture.options) =>
      captureCompletedNativePublicArtifacts(input, options);
    const missing = structuredClone(fixture.input);
    delete missing.files[row.id];
    expect((await call(missing)).unknowns).toContain(`completed-public-artifact-missing:${row.id}`);
    const extra = structuredClone(fixture.input);
    extra.files['github-release:foreign.tar.gz'] = fixture.input.files[row.id];
    expect((await call(extra)).unknowns).toContain('completed-public-artifact-inventory-differs');
    const asset = fixture.assets.find(({ name }) => name === row.name)!;
    const saved = { ...asset };
    asset.digest = `sha256:${'f'.repeat(64)}`;
    await expect(call()).rejects.toThrow('archive bytes differ');
    Object.assign(asset, saved);
    asset.url = 'https://api.github.com/repos/foreign/release/assets/1';
    await expect(call()).rejects.toThrow('invalid identity');
    Object.assign(asset, saved);
    fixture.release.target_commitish = 'f'.repeat(40);
    await expect(call()).rejects.toThrow('completed source');
    fixture.release.target_commitish = fixture.input.publication.publicationSha;
    fixture.assets.push({ ...asset });
    await expect(call()).rejects.toThrow('absent or ambiguous');
    fixture.assets.pop();
    const link = path.join(directory, 'linked.tar.gz');
    symlinkSync(fixture.input.files[row.id], link);
    await expect(
      call({ ...fixture.input, files: { ...fixture.input.files, [row.id]: link } }),
    ).rejects.toThrow();
    delete asset.digest;
    const fallback = await call(fixture.input, {
      ...fixture.options,
      proveAsset: async (url, name, size) => {
        expect([url, name, size]).toEqual([saved.url, saved.name, saved.size]);
        return { bytes: size, sha256: hash(fixture.input.files[row.id]) };
      },
    });
    expect(fallback.unknowns).toEqual([]);
    const seedFixture = await publicFixture(
      path.join(directory, 'missing-seeds'),
      'database-resources',
    );
    const seeds = await captureCompletedNativePublicArtifacts(
      { ...seedFixture.input, files: {} },
      seedFixture.options,
    );
    for (const row of seedFixture.rows.filter(({ kind }) =>
      ['native-seeds', 'wasix-seeds'].includes(kind),
    ))
      expect(seeds.unknowns).toContain(`completed-public-artifact-missing:${row.id}`);
  }));

test('completed seed deliveries preserve every control and WAL byte rather than normalizing initdb entropy', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'database-resources');
    const baseline = await captureCompletedNativePublicArtifacts(fixture.input, fixture.options);
    expect(baseline.unknowns).toEqual([]);
    for (const kind of ['native-seeds', 'wasix-seeds']) {
      const row = baseline.archives.find(
        (artifact) => artifact.kind === kind && artifact.name.endsWith('.tar.zst'),
      )!;
      expect(row).toBeDefined();
      const original = fixture.input.files[row.id];
      expect(
        differentNativeDeliveredMembers(row.members, nativeArchiveDeliveryMembers(original)),
      ).toEqual([]);
      const changed = path.join(directory, `${kind}-fresh.tar.gz`);
      writeFileSync(
        changed,
        tarArchive([
          { name: 'PG_VERSION', data: '18\n' },
          { name: 'global', type: '5', mode: 0o755 },
          { name: 'global/pg_control', data: 'fresh initdb control identity' },
          { name: 'pg_wal', type: '5', mode: 0o755 },
          { name: 'pg_wal/000000010000000000000001', data: 'fresh initdb WAL identity' },
        ]),
      );
      expect(
        differentNativeDeliveredMembers(row.members, nativeArchiveDeliveryMembers(changed)),
      ).toEqual(['global/pg_control', 'pg_wal/000000010000000000000001']);
      await expect(
        captureCompletedNativePublicArtifacts(
          { ...fixture.input, files: { ...fixture.input.files, [row.id]: changed } },
          fixture.options,
        ),
      ).rejects.toThrow('archive bytes differ');
    }
    expect(baseline.scope).toBe('construction');
  }));

test('separately authenticated controller metadata stays outside seed delivery while extra or duplicate assets remain unknown', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'database-resources');
    const before = await captureCompletedNativePublicArtifacts(fixture.input, fixture.options);
    const metadata = nativePublicationMetadataArtifactRow({
      id: fixture.input.publication.product,
      version: fixture.input.publication.version,
    });
    fixture.assets.push({ name: metadata.name });
    const withMetadata = await captureCompletedNativePublicArtifacts(
      fixture.input,
      fixture.options,
    );
    expect(withMetadata.unknowns).toEqual([]);
    expect(withMetadata.archives).toEqual(before.archives);
    fixture.assets.push({ name: metadata.name });
    expect(
      (await captureCompletedNativePublicArtifacts(fixture.input, fixture.options)).unknowns,
    ).toContain('completed-public-asset-inventory-differs');
    fixture.assets.pop();
    fixture.assets.push({ name: 'database-resources-99.0.0-native-baseline.json' });
    expect(
      (await captureCompletedNativePublicArtifacts(fixture.input, fixture.options)).unknowns,
    ).toContain('completed-public-asset-inventory-differs');
  }));

const sourceFixture = path.join(import.meta.dir, 'testdata/native-source-carriers');
const captured = JSON.parse(
  readFileSync(path.join(sourceFixture, 'captured-publication.json'), 'utf8'),
);
const publicationSha = 'c51052fe8b8ffc7e992266c5ab3d7a63b47441e7';
function originEnvironment() {
  const readJson = async (endpoint) => {
    expect(Object.hasOwn(captured.responses, endpoint)).toBe(true);
    return structuredClone(captured.responses[endpoint]);
  };
  return {
    readJson,
    assertCompletedPublication: createCompletedPublicationChecker({
      repository: 'f0rr0/oliphaunt',
      readJson,
      listPullRequests: async () => captured.pullRequests,
      readPages: async () => {
        throw new Error('unexpected paged history');
      },
    }),
    registryOptions: {
      cratesIoReadGate: null,
      fetchImpl: async (url) => {
        if (url === 'https://crates.io/api/v1/crates/oliphaunt-query/0.1.1')
          return Response.json(captured.registryMetadata.cargo);
        expect(url).toBe('https://registry.npmjs.org/%40oliphaunt%2Fts-query/0.1.1');
        return Response.json(captured.registryMetadata.npm);
      },
    },
  };
}
const sourceProducts = ['oliphaunt-query', 'oliphaunt-query-ts'];
async function origins(options) {
  return await Promise.all(
    sourceProducts.map(async (product) => ({
      publication: await options.assertCompletedPublication({
        product,
        version: '0.1.1',
        tagName: `${product}-v0.1.1`,
        publicationSha,
      }),
      carriers:
        product === 'oliphaunt-query'
          ? { 'cargo:oliphaunt-query': [path.join(sourceFixture, 'oliphaunt-query-0.1.1.crate')] }
          : {
              'npm:@oliphaunt/ts-query': [path.join(sourceFixture, 'oliphaunt-ts-query-0.1.1.tgz')],
            },
    })),
  );
}

test('completed registry supplier capture retains genuine raw source and provenance bytes', async () => {
  const options = originEnvironment();
  const input = (await origins(options))[0];
  const result = await captureCompletedNativeRegistryCarriers(input, options);
  expect(result.unknowns).toEqual([]);
  expect(result.archives).toHaveLength(1);
  expect(result.archives[0].name).toBe('cargo:oliphaunt-query');
  const entries = readPortableArchiveEntries(input.carriers['cargo:oliphaunt-query'][0]);
  for (const name of ['Cargo.toml', 'Cargo.toml.orig', '.cargo_vcs_info.json', 'src/lib.rs']) {
    const entry = entries.get(`oliphaunt-query-0.1.1/${name}`)!;
    const member = result.archives[0].members.find((member) => member.path === name)!;
    expect(member.sha256).toBe(createHash('sha256').update(entry.data()).digest('hex'));
    expect(member.size).toBe(entry.size);
  }
});

test('completed registry suppliers reject substituted ownership, checksum and companions', async () => {
  const options = originEnvironment();
  const input = (await origins(options))[0];
  await expect(
    captureCompletedNativeRegistryCarriers(
      { ...input, carriers: { 'cargo:foreign': input.carriers['cargo:oliphaunt-query'] } },
      options,
    ),
  ).rejects.toThrow('not declared');
  await expect(
    captureCompletedNativeRegistryCarriers(input, {
      ...options,
      registryOptions: {
        cratesIoReadGate: null,
        fetchImpl: async () => Response.json({ version: { checksum: '0'.repeat(64) } }),
      },
    }),
  ).rejects.toThrow('registry checksum mismatch');
  const endpoint = `repos/f0rr0/oliphaunt/contents/src/query/rust/release.toml?ref=${publicationSha}`;
  const descriptor = Buffer.from(
    'id="oliphaunt-query"\nkind="sdk"\npublish_targets=["crates-io"]\nregistry_packages=[]\n',
  );
  await expect(
    captureCompletedNativeRegistryCarriers(input, {
      ...options,
      readJson: async (request) =>
        request !== endpoint
          ? options.readJson(request)
          : {
              type: 'file',
              path: 'src/query/rust/release.toml',
              encoding: 'base64',
              content: descriptor.toString('base64'),
              sha: createHash('sha1')
                .update(`blob ${descriptor.length}\0`)
                .update(descriptor)
                .digest('hex'),
            },
    }),
  ).rejects.toThrow('not declared');
});

test('completed registry suppliers reject an archive mutated during authentication', async () =>
  asyncScratch(async (directory) => {
    const options = originEnvironment();
    const input = (await origins(options))[0];
    const original = input.carriers['cargo:oliphaunt-query'][0];
    const file = path.join(directory, 'oliphaunt-query.crate');
    copyFileSync(original, file);
    input.carriers['cargo:oliphaunt-query'] = [file];
    await expect(
      captureCompletedNativeRegistryCarriers(input, {
        ...options,
        registryOptions: {
          cratesIoReadGate: null,
          fetchImpl: async (url) => {
            const response = await options.registryOptions.fetchImpl(url);
            writeFileSync(file, 'substituted after registry checksum lookup');
            return response;
          },
        },
      }),
    ).rejects.toThrow('changed during registry authentication');
  }));

test('authentic completed query archives enter the one pre-version comparison, never admission', async () => {
  const candidate = {
    ...buildPublicationCandidate({ products: sourceProducts, artifactRoots: [sourceFixture] }),
    scope: 'construction',
  };
  const options = originEnvironment();
  const completed = await compareNativeCompletedPhysicalDelivery(
    candidate,
    await origins(options),
    options,
  );
  expect(completed.products.map(({ deliveryStatus }) => deliveryStatus)).toEqual([
    'identical',
    'identical',
  ]);
  expect(
    completed.products
      .flatMap(({ comparisons }) => comparisons!)
      .every(({ differentMembers }) => !differentMembers.length),
  ).toBe(true);
  const preVersion = compareNativePreVersionDelivery({
    source: candidate.source,
    products: sourceProducts,
    completed,
    affectedProducts: ['oliphaunt-query'],
  });
  expect(preVersion.products.map(({ affectedBuild }) => affectedBuild)).toEqual([
    'required',
    'not-required',
  ]);
  expect(
    preVersion.products.every(
      ({ deliveryStatus, necessaryDelivery }) =>
        deliveryStatus === 'identical' && necessaryDelivery === 'unknown',
    ),
  ).toBe(true);
  expect(preVersion.releaseDecision).toBe('unverified');
  const observation: any = {
    coverage: { completeProductInventory: true },
    authenticated: [
      {
        evidence: { source: candidate.source },
        qualification: {
          source: candidate.source,
          testQualification: 'passed',
          requiredTests: [{ label: '//fixture:test', configuration: 'a'.repeat(64) }],
          unverified: ['fixture origin is unverified'],
        },
      },
    ],
    products: candidate.products.map((product) => ({
      product,
      carriers: candidate.carriers
        .filter((carrier) => carrier.product === product.id)
        .map((carrier) => ({
          ...carrier,
          qualifiedFiles: carrier.artifacts.map((artifact) => ({
            frozenPath: artifact.path,
            label: '//fixture:shipping',
            path: 'bazel-out/fixture/bin/package',
            sha256: artifact.sha256,
            size: artifact.size,
          })),
        })),
      productArtifacts: [],
    })),
  };
  expect(
    compareNativePreVersionDelivery({
      source: candidate.source,
      products: sourceProducts,
      completed,
      observation,
    }).products[0].deliveryStatus,
  ).toBe('identical');
  const substituted = structuredClone(observation);
  substituted.products[0].carriers[0].artifacts[0].sha256 = 'f'.repeat(64);
  expect(() =>
    compareNativePreVersionDelivery({
      source: candidate.source,
      products: sourceProducts,
      completed,
      observation: substituted,
    }),
  ).toThrow('qualified physical inventory');
  expect(() =>
    compareNativePreVersionDelivery({
      source: { ...candidate.source, commit: 'f'.repeat(40) },
      products: sourceProducts,
      completed,
    }),
  ).toThrow('captured source');
});

test('real observation output bindings do not become spurious envelope differences', async () => {
  await observationFixture(async ({ input, origin }) => {
    const old = input.publicationLock.carriers[0];
    writeFileSync(
      old.artifacts[0].path,
      readFileSync(path.join(sourceFixture, 'oliphaunt-ts-query-0.1.1.tgz')),
    );
    const candidate = {
      ...buildPublicationCandidate({
        products: ['oliphaunt-query-ts'],
        artifactRoots: [old.artifacts[0].path],
      }),
      scope: 'construction',
    };
    const carrier = candidate.carriers[0];
    const cohort = origin.evidence.cohorts[0];
    const root = cohort.roots.find(({ package: pkg }) => pkg.product === 'alpha');
    root.package = {
      ...root.package,
      product: carrier.product,
      name: carrier.name,
      version: carrier.version,
      role: carrier.role,
    };
    const output = root.package.outputs[0].path;
    for (const event of cohort.buildEvents) {
      if (event.buildMetadata)
        event.buildMetadata.metadata = nativeBuildMetadata(candidate.source, origin.github);
      for (const file of event.namedSetOfFiles?.files ?? [])
        if (file.name === output)
          Object.assign(file, {
            digest: carrier.artifacts[0].sha256,
            length: String(carrier.artifacts[0].size),
          });
    }
    // Reuse the existing fixture's configured actions and real physical input
    // files. The actual collector binds the substituted authentic source archive.
    origin.evidence = captureNativeBuildEvidence({
      source: candidate.source,
      github: origin.github,
      bazelVersion: input.bazelVersion,
      cohorts: [
        {
          executionRoot: cohort.executionRoot,
          roots: [root],
          aquery: cohort.aquery,
          buildEvents: cohort.buildEvents,
          cquery: {
            results: [{ target: { rule: { name: root.label } }, configurationId: 1 }],
            configurations: [{ id: 1, checksum: cohort.rootConfigurations[0].configuration }],
          },
        },
      ],
    }).evidence;
    const build = {
      ...input.builds[0],
      expected: { ...input.builds[0].expected, source: candidate.source },
    };
    const observation = await observeNativePublicationConstruction(
      {
        envelope: candidate,
        files: lockedPublicationFiles(candidate),
        repository: input.repository,
        bazelVersion: input.bazelVersion,
        builds: [build],
      },
      { authenticate: async () => origin },
    );
    expect(observation.products[0].carriers[0].qualifiedFiles).toHaveLength(1);
    const options = originEnvironment();
    const baseline = (await origins(options)).filter(
      ({ publication }) => publication.product === 'oliphaunt-query-ts',
    );
    const completed = await compareNativeCompletedPhysicalDelivery(candidate, baseline, options);
    const compared = compareNativePreVersionDelivery({
      source: candidate.source,
      products: ['oliphaunt-query-ts'],
      completed,
      observation,
    });
    expect(compared.products[0]).toMatchObject({
      deliveryStatus: 'identical',
      configuredTests: 'observed-passed',
      necessaryDelivery: 'unknown',
    });
    const substituted = structuredClone(observation);
    substituted.products[0].carriers[0].packageDependencies.push({
      ecosystem: 'npm',
      name: 'substituted-held-pin',
      requirement: '0.3.3',
      scope: 'runtime',
    });
    expect(() =>
      compareNativePreVersionDelivery({
        source: candidate.source,
        products: ['oliphaunt-query-ts'],
        completed,
        observation: substituted,
      }),
    ).toThrow('qualified physical inventory');
  });
});

test('missing/foreign completed source, carrier coverage and physical origin substitution fail closed', async () =>
  asyncScratch(async (directory) => {
    const candidate = {
      ...buildPublicationCandidate({ products: sourceProducts, artifactRoots: [sourceFixture] }),
      scope: 'construction',
    };
    const options = originEnvironment();
    const baselines = await origins(options);
    expect(
      (await compareNativeCompletedPhysicalDelivery(candidate, [], options)).products.every(
        ({ deliveryStatus }) => deliveryStatus === 'unknown',
      ),
    ).toBe(true);
    const missing = structuredClone(baselines);
    missing[0].carriers = {};
    expect(
      (await compareNativeCompletedPhysicalDelivery(candidate, missing, options)).products[0]
        .deliveryStatus,
    ).toBe('unknown');
    const extra = structuredClone(baselines);
    extra[0].carriers['cargo:foreign'] = baselines[0].carriers['cargo:oliphaunt-query'];
    expect(
      (await compareNativeCompletedPhysicalDelivery(candidate, extra, options)).products[0]
        .deliveryStatus,
    ).toBe('unknown');
    await expect(
      compareNativeCompletedPhysicalDelivery(candidate, [...baselines, baselines[0]], options),
    ).rejects.toThrow('duplicate');
    const foreign = structuredClone(baselines);
    foreign[0].publication.publicationSha = 'f'.repeat(40);
    await expect(
      compareNativeCompletedPhysicalDelivery(candidate, foreign, options),
    ).rejects.toThrow();
    const original = baselines[0].carriers['cargo:oliphaunt-query'][0];
    const changed = path.join(directory, 'changed.crate');
    const rows = [...readPortableArchiveEntries(original).values()].map((entry) => ({
      name: entry.name + (entry.isDirectory ? '/' : ''),
      type: entry.isFile ? '0' : '5',
      mode: entry.mode,
      data: entry.isFile ? entry.data() : Buffer.alloc(0),
    }));
    rows.find(({ name }) => name.endsWith('/README.md'))!.data = Buffer.from(
      'substituted published docs',
    );
    writeFileSync(changed, tarArchive(rows));
    const forged = structuredClone(baselines);
    forged[0].carriers['cargo:oliphaunt-query'] = [changed];
    await expect(
      compareNativeCompletedPhysicalDelivery(candidate, forged, options),
    ).rejects.toThrow(/checksum|payload mismatch/);
    const link = path.join(directory, 'linked.crate');
    symlinkSync(original, link);
    forged[0].carriers['cargo:oliphaunt-query'] = [link];
    await expect(
      compareNativeCompletedPhysicalDelivery(candidate, forged, options),
    ).rejects.toThrow();
  }));

test('retired historical registry and source-tag obligations cannot disappear into identical delivery', async () => {
  const candidate = {
    ...buildPublicationCandidate({ products: sourceProducts, artifactRoots: [sourceFixture] }),
    scope: 'construction',
  };
  const options = originEnvironment();
  const baselines = await origins(options);
  const target = candidate.products.find(({ id }) => id === 'oliphaunt-query')!;
  const endpoint = `repos/f0rr0/oliphaunt/contents/${target.path}/release.toml?ref=${publicationSha}`;
  const descriptor = await options.readJson(endpoint);
  const original = Buffer.from(descriptor.content, 'base64').toString('utf8');
  for (const [text, expected] of [
    [
      original.replace(
        /registry_packages\s*=\s*\[/u,
        'registry_packages = ["crates:retired-published-carrier",',
      ),
      'completed-carrier-missing:cargo:retired-published-carrier',
    ],
    [
      original.replace(
        /publish_targets\s*=\s*\[/u,
        'publish_targets = ["swift-package-source-tag",',
      ),
      'authenticated-swift-source-tag-delivery-missing',
    ],
  ]) {
    const bytes = Buffer.from(text);
    const altered = {
      ...descriptor,
      content: bytes.toString('base64'),
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    };
    const readJson = async (request) =>
      request === endpoint ? altered : options.readJson(request);
    const result = await compareNativeCompletedPhysicalDelivery(candidate, baselines, {
      ...options,
      readJson,
    });
    expect(result.products.find(({ product }) => product === target.id)!.deliveryStatus).toBe(
      'unknown',
    );
    expect(result.products.find(({ product }) => product === target.id)!.unknowns).toContain(
      expected,
    );
  }
});

test('complete canonical runtime inventory uses its genuine completed contrib declarations', async () =>
  asyncScratch(async (directory) => {
    const publication = JSON.parse(
      readFileSync(
        new URL(
          '../../build_defs/release/native-0.3.3-completed-publication.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const catalog = loadPublicationCatalog('completed contrib comparison fixture', {
      products: [publication.product],
    });
    const product = catalog.products[0];
    expect(product.version).toBe(publication.version);
    const publicFiles = await publicFixture(
      path.join(directory, 'public'),
      product.id,
      product.version,
    );
    Object.assign(publicFiles.input.publication, publication);
    publicFiles.release.target_commitish = publication.publicationSha;
    const registryResponses = new Map<string, () => Response>();
    const oldCarriers: Record<string, string[]> = {};
    const carriers = [];
    // The inventory is the actual canonical runtime inventory. Local packed
    // bytes and controlled transports exercise its full comparison; they are
    // not presented as genuinely published runtime binaries or qualification.
    for (const [index, declared] of catalog.carriers.entries()) {
      const root = path.join(directory, 'registry', String(index));
      mkdirSync(root, { recursive: true });
      let packed: string[];
      if (declared.ecosystem === 'maven') {
        const [groupId, artifactId] = declared.name.split(':');
        const prefix = path.join(root, `${artifactId}-${product.version}`);
        writeFileSync(
          `${prefix}.pom`,
          mavenPom({
            coordinate: { groupId, artifactId, version: product.version, packaging: 'jar' },
            metadata,
            dependencies: [],
          }),
        );
        for (const suffix of ['.jar', '-sources.jar', '-javadoc.jar'])
          writeFileSync(
            prefix + suffix,
            zipArchive([{ name: 'declared-member', data: declared.id }]),
          );
        packed = ['.pom', '.jar', '-sources.jar', '-javadoc.jar'].map((suffix) => prefix + suffix);
        for (const file of packed)
          registryResponses.set(
            `https://repo1.maven.org/maven2/${groupId.replaceAll('.', '/')}/${artifactId}/${product.version}/${path.basename(file)}`,
            () => new Response(readFileSync(file)),
          );
      } else {
        const stage = path.join(root, 'stage');
        const member =
          declared.ecosystem === 'cargo' ? `${declared.name}-${product.version}` : 'package';
        mkdirSync(path.join(stage, member), { recursive: true });
        writeFileSync(
          path.join(stage, member, declared.ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json'),
          declared.ecosystem === 'cargo'
            ? `[package]\nname=${JSON.stringify(declared.name)}\nversion=${JSON.stringify(product.version)}\nedition="2024"\n`
            : JSON.stringify({
                name: declared.name,
                version: product.version,
                repository: { type: 'git', url: 'git+https://github.com/f0rr0/oliphaunt.git' },
                publishConfig: { access: 'public', provenance: true },
              }),
        );
        writeFileSync(
          path.join(stage, member, 'README.md'),
          `Exact delivered member for ${declared.id}\n`,
        );
        const file = path.join(
          root,
          declared.ecosystem === 'cargo' ? 'package.crate' : 'package.tgz',
        );
        await archiveDirectory(stage, file + '.tar.gz');
        renameSync(file + '.tar.gz', file);
        packed = [file];
        registryResponses.set(
          declared.ecosystem === 'cargo'
            ? `https://crates.io/api/v1/crates/${encodeURIComponent(declared.name)}/${product.version}`
            : `https://registry.npmjs.org/${encodeURIComponent(declared.name)}/${product.version}`,
          () =>
            Response.json(
              declared.ecosystem === 'cargo'
                ? { version: { checksum: hash(file) } }
                : {
                    dist: {
                      integrity: `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`,
                    },
                  },
            ),
        );
      }
      oldCarriers[declared.id] = packed;
      const currentFiles = packed.map((file) => {
        const current = path.join(root, 'current', path.basename(file));
        mkdirSync(path.dirname(current), { recursive: true });
        copyFileSync(file, current);
        return current;
      });
      carriers.push({
        ...declared,
        parentCarrier: null,
        part: null,
        dependencies: [],
        packageDependencies: [],
        artifacts: currentFiles.map(artifact),
        publishOrder: index,
      });
    }
    const productArtifacts = publicFiles.rows.map(({ version: _version, ...row }) => ({
      ...row,
      ...artifact(publicFiles.input.files[row.id]),
    }));
    const candidate = {
      schema: PUBLICATION_CANDIDATE_SCHEMA,
      catalogSchema: PUBLICATION_CATALOG_SCHEMA,
      catalogDigest: publicationCatalogDigest(catalog),
      source: sourceIdentity('HEAD'),
      scope: 'construction',
      products: catalog.products,
      carriers,
      productArtifacts,
      missing: [],
      packageEnvelopeDigest: consumerDigest({ carriers, productArtifacts }),
    };
    validatePublicationCandidate(candidate);
    const sourceFiles = new Map<string, Buffer>();
    const options = {
      assertCompletedPublication: publicFiles.options.assertCompletedPublication,
      readPages: publicFiles.options.readPages,
      readJson: async (endpoint: string) => {
        if (endpoint.includes('/releases/tags/')) return publicFiles.options.readJson(endpoint);
        const match = endpoint.match(
          /^repos\/f0rr0\/oliphaunt\/contents\/(.+)\?ref=([a-f0-9]{40})$/u,
        );
        if (!match || match[2] !== publication.publicationSha)
          throw new Error(`unexpected historical source endpoint ${endpoint}`);
        const file = match[1];
        if (!sourceFiles.has(file))
          sourceFiles.set(
            file,
            execFileSync('git', ['show', `${publication.publicationSha}:${file}`]),
          );
        const bytes = sourceFiles.get(file);
        if (!bytes) throw new Error(`missing historical fixture ${file}`);
        return {
          type: 'file',
          path: file,
          encoding: 'base64',
          content: bytes.toString('base64'),
          sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
        };
      },
      registryOptions: {
        cratesIoReadGate: null,
        fetchImpl: async (url) => {
          const response = registryResponses.get(String(url));
          if (!response) throw new Error(`unexpected registry fixture ${url}`);
          return response();
        },
      },
    };
    const baseline = [
      { publication, carriers: oldCarriers, productArtifacts: publicFiles.input.files },
    ];
    const result = await compareNativeCompletedPhysicalDelivery(candidate, baseline, options);
    expect(result.products[0].unknowns).toEqual([]);
    expect(result.products[0].deliveryStatus).toBe('identical');
    expect(result.products[0].comparisons).toHaveLength(
      carriers.length + publicFiles.rows.filter(({ kind }) => kind !== 'checksums').length,
    );
    expect(sourceFiles.size).toBe(12);
    let random = 0x5eed;
    for (let scenario = 0; scenario < 4; scenario++) {
      const entries = Object.entries(oldCarriers);
      for (let index = entries.length - 1; index > 0; index--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const swap = random % (index + 1);
        [entries[index], entries[swap]] = [entries[swap], entries[index]];
      }
      expect(
        await compareNativeCompletedPhysicalDelivery(
          candidate,
          [
            {
              ...baseline[0],
              carriers: Object.fromEntries(entries),
            },
          ],
          options,
        ),
      ).toEqual(result);
    }
    // Controlled sealed-inventory fixture; actual parent-archive dependency checks run at acquisition.
    const historical = await readCompletedNativeDeliveryInventory(publication, options);
    const frozenMetadata: any = {
      publication,
      metadata: {
        repository: 'f0rr0/oliphaunt',
        source: { commit: publication.publicationSha, tree: publication.publicationTree },
        product,
        carriers: structuredClone(carriers),
        productArtifacts: productArtifacts.filter(({ kind }) => kind !== 'checksums'),
      },
    };
    const oldRole = frozenMetadata.metadata.carriers.find(({ ecosystem }) => ecosystem === 'cargo');
    oldRole.role = 'retired-source-contract';
    oldRole.target = 'retired-target-v1';
    const visited = new Set<string>();
    const frozenOptions = {
      ...options,
      assertMetadataBaseline: (value) => value,
      readJson: async (endpoint: string) => {
        if (endpoint.includes('/contents/')) {
          const file = endpoint.match(/\/contents\/(.+)\?ref=/u)?.[1];
          expect([
            'release-please-config.json',
            '.release-please-manifest.json',
            `${product.path}/release.toml`,
          ]).toContain(file);
          visited.add(file!);
        }
        return options.readJson(endpoint);
      },
    };
    const frozenResult = await compareNativeCompletedPhysicalDelivery(
      candidate,
      [{ ...baseline[0], metadataBaseline: frozenMetadata }],
      frozenOptions,
    );
    expect(frozenResult.products[0].deliveryStatus).toBe('identical');
    expect(frozenResult.products[0].unknowns).toEqual([]);
    expect(frozenResult.products[0].contractChanges).toEqual({ added: [], removed: [] });
    expect(visited.size).toBe(3);
    const parent = frozenMetadata.metadata.carriers.find(
      ({ ecosystem, role }) => ecosystem === 'cargo' && role === 'platform-leaf',
    );
    if (!parent) throw new Error('runtime inventory fixture has no split-capable Cargo parent');
    const parts = [1, 2].map((number) => {
      const name = `${parent.name}-part-${String(number).padStart(3, '0')}`;
      return {
        ...resolveActualCarrier(historical.catalog, 'cargo', name),
        artifacts: [{ ...parent.artifacts[0], path: `original/${name}-${product.version}.crate` }],
        packageDependencies: [],
      };
    });
    parent.packageDependencies = parts.map(({ name }) => ({ ecosystem: 'cargo', name }));
    frozenMetadata.metadata.carriers.push(...parts);
    const frozen = await readCompletedNativeDeliveryInventory(publication, {
      ...options,
      metadataBaseline: frozenMetadata,
      assertMetadataBaseline: (value) => value,
    });
    expect(frozen.catalog.carriers).toEqual(frozen.carriers);
    expect(frozen.carriers).toHaveLength(carriers.length + 2);
    expect(
      frozen.carriers.filter(({ role }) => role === 'payload-part').map(({ id }) => id),
    ).toEqual(parts.map(({ id }) => id));
    const incomplete = structuredClone(frozenMetadata);
    incomplete.metadata.carriers.pop();
    await expect(
      readCompletedNativeDeliveryInventory(publication, {
        ...options,
        metadataBaseline: incomplete,
        assertMetadataBaseline: (value) => value,
      }),
    ).rejects.toThrow('complete Cargo payload part set');
    const expanded = carriers.find(({ name }) => name === 'oliphaunt-extension-contrib-pg18');
    expect(expanded).toBeDefined();
    const file = expanded.artifacts[0].path;
    const entries = [...readPortableArchiveEntries(file).values()].map((entry) => ({
      name: entry.name + (entry.isDirectory ? '/' : ''),
      type: entry.isFile ? '0' : '5',
      mode: entry.mode,
      data: entry.isFile ? entry.data() : Buffer.alloc(0),
    }));
    const docs = entries.find(({ name }) => name.endsWith('/README.md'));
    if (!docs) throw new Error('fixture lacks delivered contrib documentation');
    docs.data = Buffer.from('actual changed contrib delivered documentation');
    writeFileSync(file, tarArchive(entries));
    expanded.artifacts = [artifact(file)];
    candidate.packageEnvelopeDigest = consumerDigest({ carriers, productArtifacts });
    const changed = await compareNativeCompletedPhysicalDelivery(candidate, baseline, options);
    expect(changed.products[0].deliveryStatus).toBe('different');
    expect(
      changed.products[0].comparisons.find(({ id }) => id === expanded.id).differentMembers,
    ).toEqual(['README.md']);
    expect(changed.releaseDecision).toBe('unverified');
  }));

function historicalFileResponse(file: string, contents: string) {
  const bytes = Buffer.from(contents);
  return {
    type: 'file',
    path: file,
    encoding: 'base64',
    content: bytes.toString('base64'),
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  };
}

test('the historical Cargo-only WASIX SDK stays asset-free while declared relink kits use archive delivery', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'oliphaunt-wasix-rust');
    const { publication } = fixture.input;
    const ownerPath = 'historical/wasix-sdk';
    const descriptor =
      'id="oliphaunt-wasix-rust"\nkind="sdk"\npublish_targets=["crates-io"]\n' +
      'registry_packages=["crates:oliphaunt-wasix"]\nrelease_artifacts=["cargo-crate"]\n';
    const visited = new Set<string>();
    const readJson = async (endpoint: string) => {
      const file = endpoint.match(/\/contents\/(.+)\?ref=/u)?.[1];
      if (!file) return fixture.options.readJson(endpoint);
      visited.add(file);
      const text = {
        'release-please-config.json': JSON.stringify({
          packages: { [ownerPath]: { component: publication.product } },
        }),
        '.release-please-manifest.json': JSON.stringify({ [ownerPath]: publication.version }),
        [`${ownerPath}/release.toml`]: descriptor,
      }[file];
      if (!text) throw new Error(`unexpected historical SDK inventory input ${file}`);
      return historicalFileResponse(file, text);
    };
    const options = { ...fixture.options, readJson };
    const frozen = {
      publication,
      metadata: {
        repository: 'f0rr0/oliphaunt',
        source: { commit: publication.publicationSha, tree: publication.publicationTree },
        product: { id: publication.product, version: publication.version },
        carriers: [
          {
            id: 'cargo:oliphaunt-wasix',
            ecosystem: 'cargo',
            product: publication.product,
            name: 'oliphaunt-wasix',
            version: publication.version,
            role: 'facade',
            target: null,
            declared: true,
            artifacts: [{ path: 'oliphaunt-wasix.crate', size: 1, sha256: 'a'.repeat(64) }],
          },
        ],
        productArtifacts: [],
      },
    };
    for (const metadataBaseline of [undefined, frozen]) {
      const inventory = await readCompletedNativeDeliveryInventory(publication, {
        ...options,
        ...(metadataBaseline ? { metadataBaseline, assertMetadataBaseline: (value) => value } : {}),
      });
      expect(inventory.carriers.map(({ id }) => id)).toEqual(['cargo:oliphaunt-wasix']);
      expect(inventory.publicRows).toEqual([]);
      expect(inventory.catalog.products[0].publishTargets).toEqual(['crates-io']);
    }
    expect([...visited].sort()).toEqual([
      '.release-please-manifest.json',
      `${ownerPath}/release.toml`,
      'release-please-config.json',
    ]);
    const current = await captureCompletedNativePublicArtifacts(fixture.input, fixture.options);
    expect(current.unknowns).toEqual([]);
    expect(current.archives.map(({ kind }) => kind)).toEqual(['windows-v8-relink']);
    expect(current.archives[0].members).toEqual(
      nativeArchiveDeliveryMembers(fixture.input.files[current.archives[0].id]),
    );
  }));

test('missing published baselines cannot become first deliveries through explicit IDs', async () => {
  const candidate = {
    ...buildPublicationCandidate({ products: sourceProducts, artifactRoots: [sourceFixture] }),
    scope: 'construction',
  };
  const options = originEnvironment();
  const baseline = await origins(options);
  const remaining = baseline.filter(({ publication }) => publication.product !== 'oliphaunt-query');
  expect(
    (await compareNativeCompletedPhysicalDelivery(candidate, remaining, options)).products.find(
      ({ product }) => product === 'oliphaunt-query',
    )!.deliveryStatus,
  ).toBe('unknown');
  for (const unreleasedProducts of [
    ['oliphaunt-query'],
    ['foreign'],
    ['oliphaunt-query', 'oliphaunt-query'],
    ['oliphaunt-query-ts'],
  ])
    await expect(
      compareNativeCompletedPhysicalDelivery(candidate, remaining, {
        ...options,
        unreleasedProducts,
      }),
    ).rejects.toThrow('unique explicit version-zero products');
});

test('verified historical registry additions and removals compare as necessary contract changes', async () => {
  const candidate = {
    ...buildPublicationCandidate({ products: sourceProducts, artifactRoots: [sourceFixture] }),
    scope: 'construction',
  };
  const options = originEnvironment();
  const baselines = await origins(options);
  const owner = candidate.products.find(({ id }) => id === 'oliphaunt-query')!;
  const file = `${owner.path}/release.toml`;
  const endpoint = `repos/f0rr0/oliphaunt/contents/${file}?ref=${publicationSha}`;
  const original = Buffer.from((await options.readJson(endpoint)).content, 'base64').toString(
    'utf8',
  );
  const history = async (text: string) => ({
    ...options,
    readJson: async (request: string) =>
      request === endpoint ? historicalFileResponse(file, text) : options.readJson(request),
  });
  const added = structuredClone(baselines);
  added[0].carriers = {};
  const addition = await compareNativeCompletedPhysicalDelivery(
    candidate,
    added,
    await history(original.replace('"crates:oliphaunt-query"', '')),
  );
  expect(addition.products[0].deliveryStatus).toBe('different');
  expect(addition.products[0].contractChanges.added).toEqual(['cargo:oliphaunt-query']);
  expect(addition.products[0].unknowns).toEqual([]);
  const removed = structuredClone(baselines);
  removed[0].carriers['npm:@oliphaunt/ts-query'] = baselines[1].carriers['npm:@oliphaunt/ts-query'];
  const removal = await compareNativeCompletedPhysicalDelivery(
    candidate,
    removed,
    await history(
      original.replace(
        '"crates:oliphaunt-query"',
        '"crates:oliphaunt-query", "npm:@oliphaunt/ts-query"',
      ),
    ),
  );
  expect(removal.products[0].deliveryStatus).toBe('different');
  expect(removal.products[0].contractChanges.removed).toEqual(['npm:@oliphaunt/ts-query']);
  expect(removal.products[0].unknowns).toEqual([]);
  const missing = structuredClone(removed);
  delete missing[0].carriers['npm:@oliphaunt/ts-query'];
  expect(
    (
      await compareNativeCompletedPhysicalDelivery(
        candidate,
        missing,
        await history(
          original.replace(
            '"crates:oliphaunt-query"',
            '"crates:oliphaunt-query", "npm:@oliphaunt/ts-query"',
          ),
        ),
      )
    ).products[0].deliveryStatus,
  ).toBe('unknown');
  await asyncScratch(async (directory) => {
    const file = path.join(directory, 'retired.tgz');
    const originalArchive = removed[0].carriers['npm:@oliphaunt/ts-query'][0];
    const rows = [...readPortableArchiveEntries(originalArchive).values()].map((entry) => ({
      name: entry.name + (entry.isDirectory ? '/' : ''),
      type: entry.isFile ? '0' : '5',
      mode: entry.mode,
      data: entry.isFile ? entry.data() : Buffer.alloc(0),
    }));
    const docs = rows.find(({ name }) => name.endsWith('/README.md'));
    if (!docs) throw new Error('retired supplier fixture has no README');
    docs.data = Buffer.from('substituted retired contract');
    writeFileSync(file, tarArchive(rows));
    const changed = structuredClone(removed);
    changed[0].carriers['npm:@oliphaunt/ts-query'] = [file];
    await expect(
      compareNativeCompletedPhysicalDelivery(
        candidate,
        changed,
        await history(
          original.replace(
            '"crates:oliphaunt-query"',
            '"crates:oliphaunt-query", "npm:@oliphaunt/ts-query"',
          ),
        ),
      ),
    ).rejects.toThrow(/checksum|integrity|payload mismatch/);
  });
});

test('historical inventory uses exact owner path and targets rather than current directories or defaults', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'oliphaunt-broker');
    const original = fixture.options.readJson;
    const oldPath = 'historical/broker';
    const readJson = async (endpoint: string) => {
      const match = endpoint.match(/^repos\/f0rr0\/oliphaunt\/contents\/(.+)\?ref=/u);
      if (!match) return original(endpoint);
      const file = match[1];
      if (file === 'release-please-config.json')
        return historicalFileResponse(
          file,
          JSON.stringify({ packages: { [oldPath]: { component: 'oliphaunt-broker' } } }),
        );
      if (file === '.release-please-manifest.json')
        return historicalFileResponse(
          file,
          JSON.stringify({ [oldPath]: fixture.input.publication.version }),
        );
      if (file === `${oldPath}/release.toml`)
        return historicalFileResponse(
          file,
          'id="oliphaunt-broker"\nkind="tool"\npublish_targets=["github-release-assets"]\nregistry_packages=[]\n' +
            '[artifact_targets]\npreset="broker-helper"\ntargets=["macos-arm64"]\n',
        );
      throw new Error(`unexpected current-source request ${file}`);
    };
    const inventory = await readCompletedNativeDeliveryInventory(fixture.input.publication, {
      ...fixture.options,
      readJson,
    });
    expect(inventory.catalog.products[0].path).toBe(oldPath);
    expect(
      inventory.publicRows.map(({ target }) => target).filter((target) => target !== 'portable'),
    ).toEqual(['macos-arm64']);
    const legacy = await readCompletedNativeDeliveryInventory(fixture.input.publication, {
      ...fixture.options,
      readJson: async (endpoint: string) => {
        if (endpoint.includes(`/contents/${oldPath}/moon.yml?`))
          return historicalFileResponse(
            `${oldPath}/moon.yml`,
            `id: oliphaunt-broker\nproject:\n  release:\n    component: oliphaunt-broker\n    packagePath: ${oldPath}\n    artifactTargets:\n      preset: broker-helper\n      targets: [macos-arm64]\n`,
          );
        if (endpoint.includes(`/contents/${oldPath}/release.toml?`))
          return historicalFileResponse(
            `${oldPath}/release.toml`,
            'id="oliphaunt-broker"\nkind="tool"\npublish_targets=["github-release-assets"]\nregistry_packages=[]\n',
          );
        return readJson(endpoint);
      },
    });
    expect(legacy.publicRows).toEqual(inventory.publicRows);
    expect(legacy.sourceFiles.some(({ path: file }) => file === `${oldPath}/moon.yml`)).toBe(true);
    const invalid = async (endpoint: string) => {
      const response = await readJson(endpoint);
      return endpoint.includes(`/contents/${oldPath}/release.toml?`)
        ? { ...response, sha: '0'.repeat(40) }
        : response;
    };
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...fixture.options,
        readJson: invalid,
      }),
    ).rejects.toThrow('Git blob differs');
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...fixture.options,
        readJson: async () => {
          throw new Error('history inaccessible');
        },
      }),
    ).rejects.toThrow('history inaccessible');
  }));

test('external public inventory captures its exact historical runtime owner tables and iOS closure', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'oliphaunt-extension-postgis');
    const inventory = await readCompletedNativeDeliveryInventory(
      fixture.input.publication,
      fixture.options,
    );
    expect(inventory.publicRows).toEqual(fixture.rows);
    const files = inventory.sourceFiles.map(({ path: file }) => file);
    for (const file of [
      'src/extensions/contrib/carriers.toml',
      'src/native/runtime/release.toml',
      'src/wasix/runtime/release.toml',
      'src/extensions/contracts/extension-target-profiles.toml',
      'src/extensions/generated/sdk/extensions.json',
      'src/extensions/generated/mobile/static-extensions.tsv',
    ])
      expect(files).toContain(file);
    expect(inventory.publicRows.some(({ kind }) => kind === 'ios-dependency-xcframework')).toBe(
      true,
    );
    expect(
      (await captureCompletedNativePublicArtifacts(fixture.input, fixture.options)).unknowns,
    ).toEqual([]);
  }));

test('frozen public names and File identities survive changed current filename templates', async () =>
  asyncScratch(async (directory) => {
    const fixture = await publicFixture(directory, 'oliphaunt-broker');
    const row = fixture.rows.find(({ target }) => target === 'macos-arm64');
    if (!row) throw new Error('broker fixture has no macOS archive');
    const oldName = `old-broker-${fixture.input.publication.version}-macos.tar.gz`;
    const oldId = `github-release:${oldName}`;
    const files = { ...fixture.input.files, [oldId]: fixture.input.files[row.id] };
    delete files[row.id];
    const asset = fixture.assets.find(({ name }) => name === row.name);
    if (!asset) throw new Error('broker fixture has no macOS asset');
    asset.name = oldName;
    const metadataBaseline: any = {
      publication: fixture.input.publication,
      metadata: {
        repository: 'f0rr0/oliphaunt',
        source: {
          commit: fixture.input.publication.publicationSha,
          tree: fixture.input.publication.publicationTree,
        },
        product: {
          id: fixture.input.publication.product,
          version: fixture.input.publication.version,
        },
        carriers: [],
        productArtifacts: fixture.rows
          .filter(({ kind }) => kind !== 'checksums')
          .map((item) => ({
            ...item,
            ...(item.id === row.id ? { id: oldId, name: oldName } : {}),
            ...artifact(fixture.input.files[item.id]),
          })),
      },
    };
    const visited = new Set<string>();
    const options = {
      ...fixture.options,
      assertMetadataBaseline: (value) => value,
      readJson: async (endpoint: string) => {
        if (endpoint.includes('/contents/')) {
          const file = endpoint.match(/\/contents\/(.+)\?ref=/u)?.[1];
          expect([
            'release-please-config.json',
            '.release-please-manifest.json',
            'src/native/broker/release.toml',
          ]).toContain(file);
          visited.add(file!);
        }
        if (endpoint.includes('/contents/src/native/broker/release.toml?'))
          return historicalFileResponse(
            'src/native/broker/release.toml',
            'id="oliphaunt-broker"\nkind="retired-factory-v1"\npublish_targets=["github-release-assets"]\nregistry_packages=[]\n',
          );
        return fixture.options.readJson(endpoint);
      },
    };
    const inventory = await readCompletedNativeDeliveryInventory(fixture.input.publication, {
      ...options,
      metadataBaseline,
    });
    expect(inventory.publicRows.some(({ name }) => name === oldName)).toBe(true);
    expect(inventory.publicRows.some(({ name }) => name === row.name)).toBe(false);
    expect(inventory.publicRows.every(({ kind }) => kind !== 'checksums')).toBe(true);
    expect(visited.size).toBe(3);
    expect(
      (
        await captureCompletedNativePublicArtifacts(
          { ...fixture.input, files, metadataBaseline },
          options,
        )
      ).unknowns,
    ).toEqual([]);
    const checksumAsset = fixture.assets.find(({ name }) => name.endsWith('.sha256'))!;
    checksumAsset.name = 'retired-outer-envelope.sha256';
    const payloadFiles = Object.fromEntries(
      Object.entries(files).filter(([id]) => !id.endsWith('.sha256')),
    );
    const capture = () =>
      captureCompletedNativePublicArtifacts(
        { ...fixture.input, files: payloadFiles, metadataBaseline },
        options,
      );
    expect((await capture()).unknowns).toEqual([]);
    fixture.assets.push({ ...checksumAsset });
    expect((await capture()).unknowns).toContain('completed-public-asset-inventory-differs');
    fixture.assets.pop();
    fixture.assets.push({ ...checksumAsset, name: 'unlisted-delivery.bin' });
    expect((await capture()).unknowns).toContain('completed-public-asset-inventory-differs');
    fixture.assets.pop();
    const missingFile = { ...payloadFiles };
    delete missingFile[oldId];
    expect(
      (
        await captureCompletedNativePublicArtifacts(
          { ...fixture.input, files: missingFile, metadataBaseline },
          options,
        )
      ).unknowns,
    ).toContain(`completed-public-artifact-missing:${oldId}`);
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...fixture.options,
        metadataBaseline: structuredClone(metadataBaseline),
      }),
    ).rejects.toThrow('authenticated completed metadata origin');
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...options,
        metadataBaseline,
        assertMetadataBaseline: () => undefined,
      }),
    ).rejects.toThrow('authentication returned no baseline');
    const wrongSource = structuredClone(metadataBaseline);
    wrongSource.metadata.source.commit = 'f'.repeat(40);
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...options,
        metadataBaseline: wrongSource,
      }),
    ).rejects.toThrow('source/product/version differs');
    const wrongHash = structuredClone(metadataBaseline);
    wrongHash.metadata.productArtifacts.find(({ id }) => id === oldId).sha256 = 'f'.repeat(64);
    await expect(
      captureCompletedNativePublicArtifacts(
        { ...fixture.input, files, metadataBaseline: wrongHash },
        options,
      ),
    ).rejects.toThrow('File differs from frozen metadata');
    const wrongOwner = structuredClone(metadataBaseline);
    wrongOwner.metadata.productArtifacts[0].product = 'foreign';
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...options,
        metadataBaseline: wrongOwner,
      }),
    ).rejects.toThrow('frozen public File identity differs');
    const wrongVersion = structuredClone(metadataBaseline);
    wrongVersion.metadata.productArtifacts[0].version = '99.0.0';
    await expect(
      readCompletedNativeDeliveryInventory(fixture.input.publication, {
        ...options,
        metadataBaseline: wrongVersion,
      }),
    ).rejects.toThrow('frozen public version differs');
  }));

test('frozen registry inventory binds actual archive filenames and hashes before held supplier capture', async () => {
  const options = originEnvironment();
  const input = (await origins(options))[0];
  const inventory = await readCompletedNativeDeliveryInventory(input.publication, options);
  const metadataBaseline: any = {
    publication: input.publication,
    metadata: {
      repository: 'f0rr0/oliphaunt',
      source: { commit: input.publication.publicationSha, tree: input.publication.publicationTree },
      product: { id: input.publication.product, version: input.publication.version },
      carriers: inventory.catalog.carriers.map((carrier) => ({
        ...carrier,
        artifacts: input.carriers[carrier.id].map(artifact),
        packageDependencies: [],
      })),
      productArtifacts: [],
    },
  };
  const transport = { ...options, assertMetadataBaseline: (value) => value };
  metadataBaseline.metadata.carriers[0].role = 'retired-classifier-role';
  metadataBaseline.metadata.carriers[0].target = 'retired-target-v1';
  expect(
    (await captureCompletedNativeRegistryCarriers({ ...input, metadataBaseline }, transport))
      .unknowns,
  ).toEqual([]);
  await expect(
    captureCompletedNativeRegistryCarriers(
      {
        ...input,
        metadataBaseline,
        carriers: { ...input.carriers, 'cargo:foreign': input.carriers['cargo:oliphaunt-query'] },
      },
      transport,
    ),
  ).rejects.toThrow('absent from frozen metadata');
  const wrongOwner = structuredClone(metadataBaseline);
  wrongOwner.metadata.carriers[0].product = 'foreign';
  await expect(
    readCompletedNativeDeliveryInventory(input.publication, {
      ...transport,
      metadataBaseline: wrongOwner,
    }),
  ).rejects.toThrow('frozen registry ownership differs');
  const changed = structuredClone(metadataBaseline);
  changed.metadata.carriers[0].artifacts[0].sha256 = 'f'.repeat(64);
  await expect(
    captureCompletedNativeRegistryCarriers({ ...input, metadataBaseline: changed }, transport),
  ).rejects.toThrow('Files differ from frozen metadata');
  const missing = structuredClone(metadataBaseline);
  missing.metadata.carriers = [];
  await expect(
    readCompletedNativeDeliveryInventory(input.publication, {
      ...transport,
      metadataBaseline: missing,
    }),
  ).rejects.toThrow('omits a historical declaration');
});
