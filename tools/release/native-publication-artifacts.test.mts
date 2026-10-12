import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { iosBaseLegalMetadata } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { createDeterministicTar } from '../packaging/cargo-source-package.mts';
import { releaseJavaScript } from '../packaging/emit-javascript.mts';
import { readNativePublicationArtifacts } from './native-publication-artifacts.mts';
import { buildNativePublicationCandidate } from './native-publication-candidate.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  expectedProductArtifactRows,
  freezePublicationCandidate,
  PUBLICATION_CANDIDATE_SCHEMA,
  PUBLICATION_LOCK_SCHEMA,
  sourceIdentity,
  validatePublicationCandidate,
  validatePublicationLock,
} from './publication-lock.mts';
import { productCompatibilityVersion } from './release-graph.mts';

function fixture(run) {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-physical-'));
  const catalog = loadPublicationCatalog('native-physical-test');
  const carrier = catalog.carriers.find(({ product }) => product === 'oliphaunt-query-ts');
  const authority = {
    catalog,
    artifactRows: expectedProductArtifactRows(catalog.products),
    resolveCarrier: (ecosystem, name) => resolveActualCarrier(catalog, ecosystem, name),
  };
  const output = 'bazel-out/fixture/bin/query.tgz';
  const archive = path.join(executionRoot, output);
  const source = path.join(executionRoot, 'stage');
  mkdirSync(path.dirname(archive), { recursive: true });
  mkdirSync(source);
  const pack = (metadata = {}) => {
    writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: carrier.name,
        version: carrier.version,
        repository: {
          type: 'git',
          url: 'git+https://github.com/f0rr0/oliphaunt.git',
          directory: 'src/query/ts',
        },
        publishConfig: { access: 'public', provenance: true },
        ...metadata,
      }),
    );
    writeFileSync(
      archive,
      gzipSync(createDeterministicTar(source, 'package', { fixedFileMode: 0o644 })),
    );
  };
  pack();
  const cohort = {
    executionRoot,
    roots: [
      {
        label: '//fixture:shipping',
        package: {
          ...carrier,
          configuration: 'portable',
          outputs: [{ path: output, owner: '//fixture:archive' }],
        },
      },
    ],
    aquery: {
      pathFragments: [
        { id: 1, label: 'source.ts' },
        { id: 2, label: 'bazel-out' },
        { id: 3, parentId: 2, label: 'fixture' },
        { id: 4, parentId: 3, label: 'bin' },
        { id: 5, parentId: 4, label: 'query.tgz' },
      ],
      targets: [{ id: 1, label: '//fixture:archive' }],
      artifacts: [
        { id: 1, pathFragmentId: 1 },
        { id: 2, pathFragmentId: 5 },
      ],
      depSetOfFiles: [{ id: 1, directArtifactIds: [1] }],
      actions: [
        {
          targetId: 1,
          configurationId: 1,
          actionKey: 'fixture',
          mnemonic: 'Package',
          inputDepSetIds: [1],
          outputIds: [2],
          primaryOutputId: 2,
          arguments: ['package', 'source.ts', output],
        },
      ],
      configuration: [{ id: 1 }],
    },
  };
  const read = () =>
    readNativePublicationArtifacts(authority, [cohort], { products: [carrier.product] });
  try {
    run({ executionRoot, archive, carrier, authority, cohort, pack, read });
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
}

test('reads native package bytes without granting release authority or full coverage', () => {
  fixture(({ carrier, read }) => {
    const result = read();
    expect(result.scope).toBe('construction');
    expect(result.completeProductInventory).toBe(false);
    expect(result.registryArtifacts[0]).toMatchObject({
      ecosystem: 'npm',
      name: carrier.name,
      version: carrier.version,
    });
    expect(result.registryArtifacts[0].artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.unverified).toContain('producer execution or trusted cached-result provenance');
    expect(result.unverified).toContain(
      'frozen source and completed-publication construction equivalence',
    );
  });
});

test('physical native roots enter the existing candidate and cannot freeze as publication evidence', () => {
  fixture(({ carrier, cohort, archive }) => {
    const candidate = buildNativePublicationCandidate({
      products: [carrier.product],
      cohorts: [{ ...cohort, source: sourceIdentity('HEAD') }],
    });
    expect(candidate.schema).toBe(PUBLICATION_CANDIDATE_SCHEMA);
    expect(candidate.scope).toBe('construction');
    expect(candidate.source).toEqual(sourceIdentity('HEAD'));
    expect(candidate.nativePayloads.source).toEqual(candidate.source);
    expect(candidate.nativePayloads.products).toEqual([
      { id: carrier.product, version: carrier.version, roots: [] },
    ]);
    expect(candidate.missing).toEqual([]);
    expect(candidate.carriers).toHaveLength(1);
    expect(candidate.carriers[0].artifacts[0].sha256).toBe(
      createHash('sha256').update(readFileSync(archive)).digest('hex'),
    );
    expect(candidate.carriers[0].artifacts[0].path).toMatch(/^target\/n\//u);
    expect(
      buildNativePublicationCandidate({
        products: [carrier.product],
        cohorts: [{ ...cohort, source: sourceIdentity('HEAD') }],
      }).packageEnvelopeDigest,
    ).toBe(candidate.packageEnvelopeDigest);
    expect(validatePublicationCandidate(candidate)).toBe(candidate);
    expect(() => freezePublicationCandidate(candidate)).toThrow('cannot freeze');
    expect(() =>
      validatePublicationLock({ ...candidate, schema: PUBLICATION_LOCK_SCHEMA }),
    ).toThrow('construction evidence cannot authorize');
    const withoutScope = { ...candidate };
    delete withoutScope.scope;
    for (const value of [withoutScope, { ...withoutScope, nativePayloads: undefined }]) {
      expect(() => freezePublicationCandidate(value)).toThrow('cannot freeze');
      expect(() => validatePublicationLock({ ...value, schema: PUBLICATION_LOCK_SCHEMA })).toThrow(
        'construction evidence cannot authorize',
      );
    }
  });
});

test('native candidate rejects foreign frozen sources, missing cohort outputs and incomplete inventory', () => {
  fixture(({ carrier, cohort }) => {
    const source = sourceIdentity('HEAD');
    const run = (value, products = [carrier.product]) =>
      buildNativePublicationCandidate({ products, cohorts: [value] });
    expect(() => run({ ...cohort })).toThrow('exact frozen candidate source');
    expect(() => run({ ...cohort, source: { ...source, commit: '0'.repeat(40) } })).toThrow(
      'exact frozen candidate source',
    );
    expect(() => run({ ...cohort, source: { ...source, tree: '0'.repeat(40) } })).toThrow(
      'exact frozen candidate source',
    );
    expect(() => run({ ...cohort, source, roots: [] })).toThrow();
    expect(() => run({ ...cohort, source }, ['oliphaunt-query', carrier.product])).toThrow();
    expect(() =>
      run({ ...cohort, source, executionRoot: path.dirname(cohort.executionRoot) }),
    ).toThrow();
  });
});

test('native candidate rejects a replaced source snapshot between physical capture and candidate assembly', () => {
  fixture(({ carrier, cohort }) => {
    const snapshot = process.env.OLIPHAUNT_GIT_SOURCE_JSON!;
    const source = sourceIdentity('HEAD');
    try {
      for (const replacement of [
        { ...JSON.parse(snapshot), commit: 'b'.repeat(40), checkout: 'b'.repeat(40) },
        { ...JSON.parse(snapshot), tree: 'c'.repeat(40) },
      ]) {
        process.env.OLIPHAUNT_GIT_SOURCE_JSON = snapshot;
        const changing = Object.defineProperty({ ...cohort, source }, 'aquery', {
          get() {
            process.env.OLIPHAUNT_GIT_SOURCE_JSON = JSON.stringify(replacement);
            return cohort.aquery;
          },
        });
        expect(() =>
          buildNativePublicationCandidate({ products: [carrier.product], cohorts: [changing] }),
        ).toThrow();
      }
    } finally {
      process.env.OLIPHAUNT_GIT_SOURCE_JSON = snapshot;
    }
  });
});

test('native declarations cannot substitute for the actual packed identity or version', () => {
  fixture(({ pack, read }) => {
    pack({ name: '@oliphaunt/other' });
    expect(read).toThrow('physical output does not contain');
    pack({ version: '99.0.0' });
    expect(read).toThrow('physical carrier does not match its canonical identity');
  });
});

test('uses only the captured execroot and rejects missing, symlinked or incomplete outputs', () => {
  fixture(({ executionRoot, archive, authority, cohort, read }) => {
    cohort.executionRoot = 'relative';
    expect(read).toThrow('captured absolute executionRoot');
    cohort.executionRoot = executionRoot;
    rmSync(archive);
    expect(read).toThrow('ENOENT');
    symlinkSync(path.join(executionRoot, 'stage/package.json'), archive);
    expect(read).toThrow('not a physical file or directory');
    expect(() => readNativePublicationArtifacts(authority, [cohort])).toThrow(
      'incomplete native shipping coverage',
    );
  });
});

test('rejects an output parent symlink that escapes the captured execroot', () => {
  fixture(({ archive, read }) => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'native-physical-outside-'));
    try {
      writeFileSync(path.join(outside, path.basename(archive)), readFileSync(archive));
      rmSync(path.dirname(archive), { recursive: true });
      symlinkSync(outside, path.dirname(archive));
      expect(read).toThrow('escapes its captured executionRoot');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('Maven companion files must belong to the declared native output', () => {
  fixture(({ archive, executionRoot, authority, cohort }) => {
    const carrier = authority.catalog.carriers.find(({ ecosystem }) => ecosystem === 'maven');
    const product = authority.catalog.products.find(({ id }) => id === carrier.product);
    const [group, artifact] = carrier.name.split(':');
    const prefix = `${artifact}-${carrier.version}`;
    rmSync(archive);
    const pom = path.join(path.dirname(archive), `${prefix}.pom`);
    writeFileSync(
      pom,
      `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${carrier.version}</version><name>Fixture</name><description>Fixture</description><url>https://github.com/f0rr0/oliphaunt</url><licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses><developers><developer><name>Fixture</name><url>https://github.com/f0rr0</url></developer></developers><scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm></project>\n`,
    );
    for (const suffix of ['.jar', '-sources.jar', '-javadoc.jar'])
      writeFileSync(path.join(path.dirname(pom), `${prefix}${suffix}`), 'fixture');
    authority.catalog = { ...authority.catalog, products: [product], carriers: [carrier] };
    authority.artifactRows = [];
    cohort.aquery.pathFragments[4].label = path.basename(pom);
    cohort.roots[0].package = {
      ...carrier,
      configuration: 'portable',
      outputs: [{ path: path.relative(executionRoot, pom), owner: '//fixture:archive' }],
    };
    const read = () =>
      readNativePublicationArtifacts(authority, [cohort], { products: [product.id] });
    expect(read).toThrow('physical registry file is not a declared output');
    cohort.roots[0].package.outputs[0].path = path.relative(executionRoot, path.dirname(pom));
    cohort.aquery.artifacts[1].pathFragmentId = 4;
    expect(read().registryArtifacts[0].artifacts).toHaveLength(4);
  });
});

test('validates the frozen Swift manifest and source tree as actual native outputs', () => {
  const executionRoot = mkdtempSync(path.join(os.tmpdir(), 'native-physical-swift-'));
  const catalog = loadPublicationCatalog('native-physical-swift');
  const product = catalog.products.find(({ id }) => id === 'oliphaunt-swift');
  const rows = expectedProductArtifactRows([product]);
  const sdk = 'bazel-out/fixture/bin/swift';
  const paths = rows.map((row) => {
    const directory =
      row.role === 'github-release-asset'
        ? 'release-assets'
        : row.kind === 'swiftpm-ios-carrier-manifest'
          ? 'release-tree/src/sdks/swift/Carriers'
          : row.kind.startsWith('swiftpm-extension-') || row.kind === 'swiftpm-carrier-resolver'
            ? 'extension-generator'
            : '';
    return path.posix.join(sdk, directory, row.name);
  });
  const write = (name, bytes) => {
    const index = rows.findIndex((row) => row.name === name);
    const file = path.join(executionRoot, paths[index]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const nativeVersion = productCompatibilityVersion('oliphaunt-swift', 'liboliphaunt-native');
  const tag = `liboliphaunt-native-v${nativeVersion}`;
  const assets = [
    [
      'base-xcframework',
      `liboliphaunt-${nativeVersion}-apple-spm-xcframework.zip`,
      'zip',
      'liboliphaunt.xcframework',
    ],
    [
      'runtime-resources',
      `liboliphaunt-${nativeVersion}-runtime-resources-ios-datum64.tar.gz`,
      'tar.gz',
      'oliphaunt',
    ],
  ].map(([role, name, format, member], index) => ({
    role,
    name,
    format,
    member,
    bytes: index + 1,
    sha256: String(index + 1).repeat(64),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  const carrier = {
    schema: 'oliphaunt-react-native-ios-carrier-v1',
    base: { product: 'liboliphaunt-native', version: nativeVersion, tag, assets },
    carriers: [],
    extensions: [],
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
  };
  const manifest = `.binaryTarget(name: "liboliphaunt", url: "${assets[0].url}", checksum: "${assets[0].sha256}")\n`;
  try {
    for (const row of rows.filter(({ kind }) => kind !== 'swiftpm-release-tree'))
      write(row.name, `${row.name}\n`);
    write('Package.swift.release', manifest);
    write('oliphaunt-react-native-ios-carriers.json', JSON.stringify(carrier));
    write(
      'extension-owner-catalog.json',
      readFileSync(new URL('../../src/extensions/generated/sdk/extensions.json', import.meta.url)),
    );
    write(
      'extension-resource-inventory.mjs',
      releaseJavaScript(
        path.resolve(
          import.meta.dir,
          '../../src/native/sdks/swift/tools/extension-resource-inventory.mts',
        ),
      ),
    );
    const bindings = rows.find(({ kind }) => kind === 'swift-bindings');
    const checksum = rows.find(({ kind }) => kind === 'checksums');
    write(
      checksum.name,
      `${createHash('sha256').update(`${bindings.name}\n`).digest('hex')}  ./${bindings.name}\n`,
    );
    const pathFragments = [];
    const artifacts = paths.map((output, index) => {
      let parentId;
      for (const label of output.split('/')) {
        const id = pathFragments.length + 1;
        pathFragments.push({ id, label, ...(parentId ? { parentId } : {}) });
        parentId = id;
      }
      return { id: index + 1, pathFragmentId: parentId };
    });
    const cohort = {
      executionRoot,
      roots: rows.map((row, index) => ({
        label: `//fixture:swift_${index}`,
        package: {
          ...row,
          ecosystem: 'github',
          configuration: row.target,
          outputs: [
            {
              path: paths[index],
              owner:
                row.role === 'github-release-asset' ? '//fixture:bindings' : '//fixture:producer',
            },
          ],
        },
      })),
      aquery: {
        pathFragments,
        artifacts,
        targets: [
          { id: 1, label: '//fixture:producer' },
          { id: 2, label: '//fixture:bindings' },
        ],
        depSetOfFiles: [],
        configuration: [{ id: 1 }],
        actions: [
          {
            targetId: 1,
            configurationId: 1,
            actionKey: 'fixture',
            mnemonic: 'Package',
            inputDepSetIds: [],
            outputIds: artifacts
              .filter((_, index) => rows[index].role !== 'github-release-asset')
              .map(({ id }) => id),
            primaryOutputId: artifacts.find(
              (_, index) => rows[index].role !== 'github-release-asset',
            ).id,
            arguments: ['fixture'],
          },
          {
            targetId: 2,
            configurationId: 1,
            actionKey: 'bindings',
            mnemonic: 'Package',
            inputDepSetIds: [],
            outputIds: artifacts
              .filter((_, index) => rows[index].role === 'github-release-asset')
              .map(({ id }) => id),
            primaryOutputId: artifacts.find(
              (_, index) => rows[index].role === 'github-release-asset',
            ).id,
            arguments: ['bindings'],
          },
        ],
      },
    };
    const authority = {
      catalog,
      artifactRows: rows,
      resolveCarrier: (ecosystem, name) => resolveActualCarrier(catalog, ecosystem, name),
    };
    const read = () =>
      readNativePublicationArtifacts(authority, [cohort], { products: [product.id] });
    const result = read();
    authority.artifactRows = expectedProductArtifactRows(catalog.products, {
      swiftExtensionFixture: true,
    });
    expect(read).toThrow(/incomplete native shipping coverage/u);
    const preVersion = readNativePublicationArtifacts(authority, [cohort], {
      products: [product.id],
      artifactPhase: 'pre-version',
    });
    expect(preVersion.productArtifacts).toEqual(result.productArtifacts);
    expect(preVersion.registryArtifacts).toEqual(result.registryArtifacts);
    authority.artifactRows = rows;
    expect(result.sourcePublicationInputs).toBe(2);
    expect(result.productArtifacts).toHaveLength(rows.length);
    expect(
      result.productArtifacts.find(({ kind }) => kind === 'swiftpm-release-tree').sha256,
    ).toMatch(/^[0-9a-f]{64}$/);
    const candidate = buildNativePublicationCandidate({
      products: [product.id],
      cohorts: [{ ...cohort, source: sourceIdentity('HEAD') }],
    });
    const before = result.productArtifacts.filter(({ role }) => role === 'github-release-asset');
    const after = candidate.productArtifacts.filter(({ role }) => role === 'github-release-asset');
    expect(after.map(({ name, sha256 }) => ({ name, sha256 }))).toEqual(
      before.map(({ name, sha256 }) => ({ name, sha256 })),
    );
    for (const artifact of after)
      expect(path.basename(path.dirname(artifact.path))).toBe('release-assets');
    expect(candidate.scope).toBe('construction');
    expect(() => freezePublicationCandidate(candidate)).toThrow('cannot freeze');
    carrier.extensions.push({ sqlName: 'pgtap' });
    write('oliphaunt-react-native-ios-carriers.json', JSON.stringify(carrier));
    expect(read).toThrow('selection-neutral');
    carrier.extensions = [];
    write('oliphaunt-react-native-ios-carriers.json', JSON.stringify(carrier));
    write('Package.swift.release', manifest.replace(assets[0].sha256, 'f'.repeat(64)));
    expect(read).toThrow('checksum');
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
  }
});
