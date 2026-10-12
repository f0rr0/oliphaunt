import { afterEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import {
  buildSwiftExtensionCarrierManifest,
  iosBaseLegalMetadata,
  swiftExtensionCarrierAssetName,
} from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { extensionDependencyRequirement } from '../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { createDeterministicTar } from '../packaging/cargo-source-package.mts';
import { releaseJavaScript } from '../packaging/emit-javascript.mts';
import { canonicalGzipSync } from '../packaging/portable-archive.mts';
import { stageReleaseNotices } from '../packaging/release-notices.mts';
import {
  extensionGithubArtifactInputs,
  loadReleaseMetadata,
  nativePublicationInputProjection,
  nativeSupplierGithubArtifactDeclarations,
} from './bazel-release-metadata.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  assertLockedArtifactSet,
  assertLockedProductArtifacts,
  assertPublicationLockSource,
  assertWasixPublicationPackages,
  buildPublicationCandidate,
  discoverProductArtifacts,
  discoverPublicationArtifacts,
  expectedExtensionGithubReleaseAssetRows,
  expectedProductArtifactRows,
  freezePublicationCandidate,
  lockedCarrierFile,
  lockedPublicationFiles,
  projectInternalDependencyIds,
  validateCargoPayloadPartSets,
  validatePublicationCandidate,
  validatePublicationLock,
} from './publication-lock.mts';
import {
  allArtifactTargets,
  currentProductVersionSync,
  extensionArtifactProductRoot,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
  validateExtensionCatalogRows,
} from './release-artifact-targets.mts';
import { productCompatibilityVersion, ROOT } from './release-graph.mts';

const temporaryDirectories = [];

function assertExpectedArtifactInventory(artifacts, products) {
  const versions = new Map(products.map(({ id, version }) => [id, version]));
  expect(
    artifacts.map(({ product, id, role, kind, target, identity, name }) => ({
      product,
      version: versions.get(product),
      id,
      role,
      kind,
      target,
      identity,
      name,
    })),
  ).toEqual(expectedProductArtifactRows(products));
}

if (['prepare-handoff', 'prepare-npm-preflight'].includes(process.argv[2])) {
  const root = process.argv[3];
  const catalog = loadPublicationCatalog('publication-lock.test', { products: ['oliphaunt-js'] });
  const npm = npmFixture(root, '@oliphaunt/ts', catalog.products[0].version);
  const lock = freezePublicationCandidate(
    buildPublicationCandidate({
      products: ['oliphaunt-js'],
      artifactRoots: [root],
      headRef: process.argv[4] ?? 'HEAD',
    }),
  );
  writeFileSync(path.join(root, 'publication-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  if (process.argv[2] === 'prepare-handoff') rmSync(npm);
  process.exit(0);
}
if (process.argv[2] === 'assert-source') {
  const snapshot = JSON.parse(process.env.OLIPHAUNT_GIT_SOURCE_JSON);
  const lock = { source: { commit: snapshot.commit, tree: snapshot.tree } };
  assert.deepEqual(assertPublicationLockSource(lock, snapshot.ref), lock.source);
  assert.deepEqual(assertPublicationLockSource(lock, snapshot.commit), lock.source);
  assert.throws(
    () =>
      assertPublicationLockSource(
        { source: { ...lock.source, tree: 'f'.repeat(40) } },
        snapshot.ref,
      ),
    /does not match/,
  );
  if (snapshot.checkout === snapshot.commit) {
    assert.deepEqual(assertPublicationLockSource(lock, 'HEAD'), lock.source);
  } else {
    assert.throws(() => assertPublicationLockSource(lock, 'HEAD'), /matching Git snapshot/);
  }
  process.exit(0);
}

test('native publication inventory requires no Moon metadata and preserves runtime carrier ownership', () => {
  const script = `
    Bun.YAML.parse = () => { throw new Error('Moon metadata must not be read'); };
    const { loadPublicationCatalog } = await import('./tools/release/publication-catalog.mts');
    const { expectedProductArtifactRows } = await import('./tools/release/publication-lock.mts');
    const catalog = loadPublicationCatalog('native-inventory-test');
    const rows = expectedProductArtifactRows(catalog.products);
    const versions = new Map(catalog.products.map(({ id, version }) => [id, version]));
    if (rows.some(row => row.version !== versions.get(row.product))) throw new Error('Wrong release owner version');
    if (new Set(rows.map(row => row.product + ':' + row.id)).size !== rows.length) throw new Error('Duplicate artifact identity');
    const contrib = rows.filter(row => row.name.startsWith('oliphaunt-extension-contrib-pg18-'));
    if (!contrib.some(row => row.product === 'liboliphaunt-native' && row.identity === 'native')) throw new Error('Missing native contrib envelope');
    if (!contrib.some(row => row.product === 'liboliphaunt-wasix' && row.identity === 'wasix')) throw new Error('Missing WASIX contrib envelope');
    if (contrib.some(row => row.product === 'oliphaunt-extension-contrib-pg18')) throw new Error('Contrib has no independent release version');
    const swiftOnly = loadPublicationCatalog('native-inventory-swift', { products: ['oliphaunt-swift'] });
    if (expectedProductArtifactRows(swiftOnly.products).some(row => row.kind === 'swiftpm-extension-consumer-fixture')) throw new Error('Unselected extension fixture');
    if (rows.some(row => row.kind === 'swiftpm-extension-consumer-fixture')) throw new Error('Undeclared consumer fixture');
    if (!expectedProductArtifactRows(catalog.products, { swiftExtensionFixture: true }).some(row => row.kind === 'swiftpm-extension-consumer-fixture')) throw new Error('Missing requested extension fixture');
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: ROOT,
    env: { ...process.env, OLIPHAUNT_MOON_PROJECTS_FILE: '/missing-moon-projects.json' },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test('canonical extension GitHub projection matches every legacy native asset row', () => {
  const metadata = loadReleaseMetadata(ROOT);
  const nativePayloads = metadata.extensionGithubArtifacts.filter(
    (row) => row.family === 'native' && !row.control,
  );
  const distributions = [
    ...new Set(metadata.extensionGithubArtifacts.map((row) => row.artifactProduct)),
  ];
  expect(distributions).toHaveLength(8);
  for (const artifactProduct of distributions) {
    const actual = nativePayloads.filter((row) => row.artifactProduct === artifactProduct);
    const identity = { id: artifactProduct, version: actual[0].version, family: 'native' };
    const legacy = expectedExtensionGithubReleaseAssetRows(identity).filter(
      (row) => row.family === 'native',
    );
    expect(actual).toEqual(
      legacy.map((row) => ({
        artifactProduct,
        owner: actual[0].owner,
        product: actual[0].owner,
        version: actual[0].version,
        id: `github-release:${row.name}`,
        role: 'github-release-asset',
        family: row.family,
        kind: row.kind,
        target: row.target,
        identity: row.identity,
        name: row.name,
      })),
    );
    expect(
      expectedExtensionGithubReleaseAssetRows(identity, {
        sqlNames: extensionSqlNames(artifactProduct),
        requiredRows: legacy.map(({ name: _name, ...row }) => row),
      }),
    ).toEqual(legacy);
  }
  expect(nativePayloads).toHaveLength(68);
  expect(
    metadata.extensionGithubArtifacts.filter((row) => row.family === 'wasix' && !row.control),
  ).toHaveLength(8);
  expect(metadata.extensionGithubArtifacts.filter((row) => row.control)).toHaveLength(35);
  for (const [target, count] of [
    ['android-arm64-v8a', 8],
    ['android-x86_64', 8],
    ['ios-xcframework', 20],
  ])
    expect(metadata.extensionGithubArtifacts.filter((row) => row.target === target)).toHaveLength(
      count,
    );
  const catalog = loadPublicationCatalog('canonical-extension-github-projection');
  const old = expectedProductArtifactRows(catalog.products).filter(
    (row) =>
      row.role === 'github-release-asset' &&
      metadata.extensionGithubArtifacts.some(
        (asset) => asset.product === row.product && asset.id === row.id,
      ),
  );
  expect(
    metadata.extensionGithubArtifacts
      .filter((row) => !row.control)
      .map(({ artifactProduct: _artifactProduct, owner: _owner, family: _family, ...row }) => row)
      .sort((left, right) => left.id.localeCompare(right.id)),
  ).toEqual(old.sort((left, right) => left.id.localeCompare(right.id)));
});

test('canonical extension GitHub projection preserves all 39 legacy mobile member contracts', () => {
  const metadata = loadReleaseMetadata(ROOT);
  const catalog = validateExtensionCatalogRows(
    JSON.parse(
      readFileSync(path.join(ROOT, 'src/extensions/generated/extensions.catalog.json'), 'utf8'),
    ),
  );
  const sdk = JSON.parse(
    readFileSync(path.join(ROOT, 'src/extensions/generated/sdk/extensions.json'), 'utf8'),
  );
  const lines = readFileSync(
    path.join(ROOT, 'src/extensions/generated/mobile/static-extensions.tsv'),
    'utf8',
  )
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith('#'));
  const columns = lines[0].split('\t');
  const statics = new Map(
    lines.slice(1).map((line) => {
      const values = line.split('\t');
      const row = Object.fromEntries(columns.map((key, index) => [key, values[index] ?? '']));
      return [row['sql-name'], row];
    }),
  );
  expect(metadata.extensionReleaseMetadata).toHaveLength(39);
  let compared = 0;
  for (const member of metadata.extensionReleaseMetadata) {
    const sqlName = member.sqlName;
    const legacy = sdk.extensions.find((row) => row['sql-name'] === sqlName);
    expect(legacy).toBeDefined();
    const stem = legacy['native-module-stem'] ?? null;
    const profiles = Object.keys(metadata.nativeMobileComponentClosures[sqlName]).map((target) => ({
      target,
      family: 'native',
      kind: 'native-static-registry',
    }));
    expect(profiles).toHaveLength(3);
    const identity = {
      artifactProduct: member.artifactProduct,
      owner: 'fixture',
      version: '1.2.3',
      sqlNames: [sqlName],
    };
    const actual = extensionGithubArtifactInputs(
      identity,
      profiles,
      catalog,
      metadata.nativeMobileComponentClosures,
    );
    for (const { target } of profiles) {
      const dependencies =
        stem === null
          ? []
          : (
              statics.get(sqlName)?.[
                target === 'ios-xcframework'
                  ? 'ios-static-dependencies'
                  : 'android-static-dependencies'
              ] ?? ''
            )
              .split(',')
              .filter(Boolean)
              .sort();
      expect([...metadata.nativeMobileComponentClosures[sqlName][target].linkUnits].sort()).toEqual(
        dependencies,
      );
      const rows = [{ sqlName, family: 'native', target, kind: 'runtime', identity: null }];
      if (target === 'ios-xcframework' && stem !== null)
        rows.push(
          { sqlName, family: 'native', target, kind: 'ios-xcframework', identity: stem },
          ...dependencies.map((dependency) => ({
            sqlName,
            family: 'native',
            target,
            kind: 'ios-dependency-xcframework',
            identity: dependency,
          })),
        );
      rows.sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          (left.identity ?? '').localeCompare(right.identity ?? ''),
      );
      expect(
        actual
          .filter((row) => row.target === target)
          .map(({ kind, identity }) => ({ kind, identity })),
      ).toEqual(rows.map(({ kind, identity }) => ({ kind, identity })));
      compared += 1;
    }
  }
  expect(compared).toBe(117);
});

test('frozen Cargo bytes reject a changed archive header with unchanged package identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-frozen-cargo-'));
  temporaryDirectories.push(root);
  const file = cargoFixture(root, 'fixture', '1.2.3');
  const records = discoverPublicationArtifacts([file]);
  const lock = {
    carriers: records.map((record) => ({
      ...record,
      id: 'cargo:' + record.name,
      product: 'fixture',
    })),
  };
  expect(() => assertLockedArtifactSet(lock, records, { product: 'fixture' })).not.toThrow();
  const bytes = readFileSync(file);
  bytes[4] ^= 1;
  writeFileSync(file, bytes);
  expect(() =>
    assertLockedArtifactSet(lock, discoverPublicationArtifacts([file]), { product: 'fixture' }),
  ).toThrow(/frozen artifact bytes mismatch/u);
});

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function wasixInstall(sqlName, dependencies, createsExtension) {
  return {
    schema: 'oliphaunt-wasix-extension-install-v1',
    name: sqlName,
    nativeModule: null,
    nativeModules: [],
    coreExportsRequired: [],
    dependencies,
    loadOrder: [],
    lifecycle: {
      createExtension: createsExtension,
      createSchema: 'pg_catalog',
      loadSql: [],
      postCreateSql: [],
      startupConfig: [],
      preloadRequired: false,
      restartRequired: false,
      sharedMemoryRequired: false,
    },
    installedFiles: [`share/postgresql/extension/${sqlName}.control`],
    unresolvedImports: [],
  };
}

function refreshTarHeaderChecksum(tar, offset = 0) {
  tar.fill(0x20, offset + 148, offset + 156);
  const checksum = tar.subarray(offset, offset + 512).reduce((total, byte) => total + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(tar, offset + 148);
}

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-publication-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

function selectionNeutralSwiftSourceCarrier(version = '1.2.3') {
  const product = 'liboliphaunt-native';
  const tag = `${product}-v${version}`;
  const assets = [
    [
      'base-xcframework',
      `liboliphaunt-${version}-apple-spm-xcframework.zip`,
      'zip',
      'liboliphaunt.xcframework',
      '1',
    ],
    [
      'runtime-resources',
      `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`,
      'tar.gz',
      'oliphaunt',
      '2',
    ],
  ].map(([role, name, format, member, digestDigit], index) => ({
    bytes: index + 1,
    format,
    member,
    name,
    role,
    sha256: digestDigit.repeat(64),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  return {
    base: { assets, product, tag, version },
    carriers: [],
    extensions: [],
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
    schema: 'oliphaunt-react-native-ios-carrier-v1',
  };
}

function tarGzip(output, cwd, member) {
  writeFileSync(
    output,
    canonicalGzipSync(createDeterministicTar(path.join(cwd, member), member, {})),
  );
}

function npmFixture(root, name, version, overrides = {}, bundledManifest = null) {
  const stage = path.join(root, 'npm-stage', 'package');
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version,
        repository: {
          type: 'git',
          url: 'git+https://github.com/f0rr0/oliphaunt.git',
        },
        publishConfig: {
          access: 'public',
          provenance: true,
        },
        optionalDependencies: { '@oliphaunt/optional-test': version },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  if (bundledManifest !== null) {
    const bundled = path.join(stage, 'node_modules', '@oliphaunt', 'js-core');
    mkdirSync(bundled, { recursive: true });
    writeFileSync(path.join(bundled, 'package.json'), `${JSON.stringify(bundledManifest)}\n`);
  }
  const output = path.join(root, 'package.tgz');
  tarGzip(output, path.dirname(stage), 'package');
  return output;
}

test('freezing pristine WASIX npm bytes checks all four carriers and historical pins', () => {
  const root = temporaryDirectory();
  const sdk = JSON.parse(
    readFileSync(new URL('../../src/wasix/sdks/ts/package.json', import.meta.url), 'utf8'),
  );
  delete sdk.scripts;
  delete sdk.devDependencies;
  sdk.dependencies['@oliphaunt/liboliphaunt-wasix'] = sdk.oliphaunt.runtimeVersion;
  sdk.dependencies['@oliphaunt/ts-query'] = productCompatibilityVersion(
    'oliphaunt-wasix-ts',
    'oliphaunt-query-ts',
  );
  for (const name of Object.keys(sdk.optionalDependencies))
    sdk.optionalDependencies[name] = sdk.oliphaunt.wasixNapiVersion;
  const options = {
    readCompatibility: (_product, source) =>
      source === 'liboliphaunt-wasix'
        ? sdk.oliphaunt.runtimeVersion
        : sdk.oliphaunt.wasixNapiVersion,
    readDependencyCompatibility: () => sdk.oliphaunt.runtimeVersion,
  };
  npmFixture(path.join(root, 'sdk'), sdk.name, sdk.version, sdk);
  for (const name of Object.keys(sdk.optionalDependencies)) {
    npmFixture(path.join(root, name.split('/')[1]), name, sdk.oliphaunt.wasixNapiVersion, {
      oliphaunt: {
        runtimeProduct: sdk.oliphaunt.runtimeProduct,
        runtimeVersion: sdk.oliphaunt.runtimeVersion,
        addonAbiVersion: sdk.oliphaunt.wasixAddonAbiVersion,
        nodeApiVersion: sdk.oliphaunt.nodeApiVersion,
        profiles: ['standard', 'icu'],
      },
    });
  }
  const artifacts = () => discoverPublicationArtifacts([root]);
  expect(() => assertWasixPublicationPackages(artifacts(), options)).not.toThrow();
  expect(() =>
    assertWasixPublicationPackages(artifacts(), {
      ...options,
      readDependencyCompatibility: () => '99.0.0',
    }),
  ).toThrow('select a new addon release');
  const name = '@oliphaunt/wasix-napi-darwin-arm64';
  npmFixture(path.join(root, name.split('/')[1]), name, sdk.oliphaunt.wasixNapiVersion, {
    oliphaunt: {
      runtimeProduct: sdk.oliphaunt.runtimeProduct,
      runtimeVersion: '99.0.0',
      addonAbiVersion: 3,
      nodeApiVersion: 8,
      profiles: ['standard', 'icu'],
    },
  });
  expect(() => assertWasixPublicationPackages(artifacts(), options)).toThrow(
    'carrier embeds runtime 99.0.0',
  );
  // A checksum-consistent historical capsule still needs consumer validation.
  // The staged root differs from ROOT during atomic candidate extraction.
  const reused = {
    products: [{ id: 'oliphaunt-wasix-ts' }, { id: 'oliphaunt-wasix-napi' }],
    carriers: artifacts().map((carrier) => ({
      ...carrier,
      product: carrier.name === sdk.name ? 'oliphaunt-wasix-ts' : 'oliphaunt-wasix-napi',
      artifacts: carrier.artifacts.map((artifact) => ({
        ...artifact,
        path: path.relative(root, path.resolve(ROOT, artifact.path)),
      })),
    })),
    productArtifacts: [],
  };
  expect(() => lockedPublicationFiles(reused, { workspaceRoot: root })).toThrow(
    /runtime .*differs|carrier embeds runtime 99.0.0/u,
  );
  sdk.oliphaunt.runtimeVersion = '98.0.0';
  sdk.dependencies['@oliphaunt/liboliphaunt-wasix'] = '98.0.0';
  npmFixture(path.join(root, 'sdk'), sdk.name, sdk.version, sdk);
  expect(() =>
    assertWasixPublicationPackages(artifacts(), {
      ...options,
      readCompatibility: (_product, source) =>
        source === 'liboliphaunt-wasix' ? '97.0.0' : sdk.oliphaunt.wasixNapiVersion,
    }),
  ).toThrow('differs from its declared release dependency pins');
});

function cargoFixture(root, name, version, { manifestSuffix = '' } = {}) {
  const directoryName = `${name}-${version}`;
  const stage = path.join(root, 'cargo-stage', directoryName);
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(
    path.join(stage, 'Cargo.toml'),
    `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\n\n[dependencies]\nserde = "1"\n${manifestSuffix}`,
  );
  writeFileSync(path.join(stage, 'src/lib.rs'), 'pub const FIXTURE: bool = true;\n');
  const output = path.join(root, `${directoryName}.crate`);
  tarGzip(output, path.dirname(stage), directoryName);
  return output;
}

function mavenFixture(root, group, artifact, version) {
  const directory = path.join(root, 'maven', ...group.split('.'), artifact, version);
  mkdirSync(directory, { recursive: true });
  const pom = path.join(directory, `${artifact}-${version}.pom`);
  writeFileSync(
    pom,
    `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><name>Fixture</name><description>Fixture publication</description><url>https://github.com/f0rr0/oliphaunt</url><licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses><developers><developer><name>Fixture Maintainer</name><url>https://github.com/f0rr0</url></developer></developers><scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm><dependencies><dependency><groupId>example</groupId><artifactId>dependency</artifactId><version>1</version></dependency></dependencies></project>\n`,
  );
  writeFileSync(path.join(directory, `${artifact}-${version}.jar`), 'fixture');
  writeFileSync(path.join(directory, `${artifact}-${version}-sources.jar`), 'fixture sources');
  writeFileSync(path.join(directory, `${artifact}-${version}-javadoc.jar`), 'fixture javadocs');
  return pom;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function githubReleaseFixture(root, product) {
  const directory = path.join(root, product.id, 'release-assets');
  mkdirSync(directory, { recursive: true });
  const rows = allArtifactTargets(
    {
      product: product.id,
      surface: 'github-release',
    },
    'publication-lock.test',
  ).map((target) => ({
    target,
    name: target.asset.replaceAll('{version}', product.version),
  }));
  const checksum = rows.find((row) => row.target.kind === 'checksums');
  for (const row of rows.filter((item) => item !== checksum)) {
    writeFileSync(path.join(directory, row.name), `fixture:${row.name}\n`);
  }
  const checksumLines = rows
    .filter((item) => item !== checksum)
    .map((row) => `${sha256File(path.join(directory, row.name))}  ./${row.name}\n`)
    .sort();
  writeFileSync(path.join(directory, checksum.name), checksumLines.join(''));
  return { checksum, directory, rows };
}

function extensionGithubReleaseFixture(
  root,
  product,
  {
    artifactProduct = product.id,
    family = null,
    mutateBundleArchive = undefined,
    mutateBundleStage = undefined,
    bundleFixedFileMode = 0o644,
  } = {},
) {
  const productRoot = extensionArtifactProductRoot(
    artifactProduct,
    family ?? 'native',
    path.join(root, 'target', 'extension-artifacts'),
    'publication-lock.test',
  );
  const directory = path.join(productRoot, 'release-assets');
  rmSync(productRoot, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const sqlNames = extensionSqlNames(artifactProduct, 'publication-lock.test');
  const bundled = sqlNames.length > 1;
  const releaseMetadata = extensionMetadata(artifactProduct, 'publication-lock.test');
  const ownership =
    artifactProduct === product.id
      ? {}
      : { releaseProduct: product.id, family: family ?? 'combined' };
  const compatibility = releaseMetadata.compatibility;
  const generated = JSON.parse(
    readFileSync(
      path.join(import.meta.dir, '../../src/extensions/generated/sdk/extensions.json'),
      'utf8',
    ),
  );
  const staticLines = readFileSync(
    path.join(import.meta.dir, '../../src/extensions/generated/mobile/static-extensions.tsv'),
    'utf8',
  )
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const staticHeader = staticLines[0].split('\t');
  const staticRows = staticLines
    .slice(1)
    .map((line) =>
      Object.fromEntries(
        staticHeader.map((column, index) => [column, line.split('\t')[index] ?? '']),
      ),
    );
  const assets = [];
  const extensions = [];
  for (const sqlName of sqlNames) {
    const extension = generated.extensions.find((row) => row['sql-name'] === sqlName);
    const nativeModuleStem = extension['native-module-stem'];
    const staticRow = staticRows.find((row) => row['sql-name'] === sqlName);
    const iosNativeDependencies =
      nativeModuleStem === null
        ? []
        : (staticRow?.['ios-static-dependencies'] ?? '').split(',').filter(Boolean).sort();
    const memberAssets = [];
    for (const target of extensionArtifactTargets(
      { product: artifactProduct },
      'publication-lock.test',
    ).filter((row) => row.sqlName === sqlName && (family === null || row.family === family))) {
      const roles =
        target.family === 'wasix'
          ? ['wasix-runtime']
          : target.target === 'ios-xcframework'
            ? [
                'runtime',
                ...(nativeModuleStem === null
                  ? []
                  : [
                      'ios-xcframework',
                      ...iosNativeDependencies.map(
                        (dependency) => `ios-dependency-xcframework:${dependency}`,
                      ),
                    ]),
              ]
            : ['runtime'];
      for (const role of roles) {
        const [kind, dependencyIdentity] = role.split(':');
        const identity =
          kind === 'ios-xcframework'
            ? nativeModuleStem
            : kind === 'ios-dependency-xcframework'
              ? dependencyIdentity
              : null;
        const prefix = `${artifactProduct}-${product.version}`;
        const name =
          target.family === 'wasix'
            ? `${prefix}-wasix-portable.tar.zst`
            : kind === 'ios-xcframework'
              ? `${prefix}-native-ios-xcframework.zip`
              : kind === 'ios-dependency-xcframework'
                ? `${prefix}-native-ios-dependency-${identity}-xcframework.zip`
                : target.target === 'ios-xcframework'
                  ? `${prefix}-native-ios-runtime.tar.gz`
                  : `${prefix}-native-${target.target}-runtime.tar.gz`;
        const file = path.join(
          bundled ? path.join(productRoot, 'member-assets', sqlName) : directory,
          name,
        );
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `fixture:${name}\n`);
        const asset = {
          name,
          family: target.family,
          target: target.target,
          kind,
          identity,
          path: file,
          sha256: sha256File(file),
          bytes: readFileSync(file).length,
        };
        assets.push(asset);
        memberAssets.push(asset);
      }
    }
    const dependencies = [...extension['selected-extension-dependencies']].sort();
    const createsExtension = extension['creates-extension'] !== false;
    const stagesIos = memberAssets.some((asset) => asset.target === 'ios-xcframework');
    extensions.push({
      sqlName,
      createsExtension,
      dependencies,
      dataFiles: [...extension['runtime-share-data-files']].sort(),
      extensionSqlFileNames: [...extension['extension-sql-file-names']].sort(),
      extensionSqlFilePrefixes: [...extension['extension-sql-file-prefixes']].sort(),
      nativeModuleStem,
      iosNativeDependencies: stagesIos ? iosNativeDependencies : [],
      iosRegistration:
        nativeModuleStem === null || !stagesIos
          ? null
          : {
              schema: 'oliphaunt-ios-extension-registration-v1',
              sqlName,
              nativeModuleStem,
              magicSymbol: `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, '_')}_Pg_magic_func`,
              initSymbol: null,
              symbols: [],
            },
      wasixInstall: memberAssets.some((asset) => asset.family === 'wasix')
        ? wasixInstall(sqlName, dependencies, createsExtension)
        : null,
      sharedPreloadLibraries: [...extension['shared-preload-libraries']].sort(),
      assets: memberAssets,
    });
  }
  const carrierAssets = [];
  if (bundled) {
    const groups = new Map();
    for (const extension of extensions) {
      for (const asset of extension.assets) {
        const key = `${asset.family}\0${asset.target}`;
        const group = groups.get(key) ?? { family: asset.family, target: asset.target, rows: [] };
        group.rows.push({ sqlName: extension.sqlName, asset });
        groups.set(key, group);
      }
    }
    for (const group of [...groups.values()].sort((left, right) =>
      `${left.family}\0${left.target}`.localeCompare(`${right.family}\0${right.target}`),
    )) {
      const archiveRoot = `${artifactProduct}-${product.version}-${group.family}-${group.target}-bundle`;
      const stage = path.join(productRoot, 'bundle-stage', archiveRoot);
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true });
      const manifestMembers = [];
      for (const { sqlName, asset } of group.rows.sort((left, right) =>
        `${left.sqlName}\0${left.asset.kind}\0${left.asset.identity ?? ''}`.localeCompare(
          `${right.sqlName}\0${right.asset.kind}\0${right.asset.identity ?? ''}`,
        ),
      )) {
        const memberPath = `extensions/${sqlName}/${asset.name}`;
        const destination = path.join(stage, ...memberPath.split('/'));
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(asset.path));
        asset.carrierAsset = `${archiveRoot}.tar.gz`;
        asset.carrierRoot = archiveRoot;
        asset.memberPath = memberPath;
        manifestMembers.push({
          sqlName,
          kind: asset.kind,
          identity: asset.identity,
          path: memberPath,
          sha256: asset.sha256,
          bytes: asset.bytes,
        });
      }
      const memberNames = [...new Set(manifestMembers.map(({ sqlName }) => sqlName))].sort();
      const legal = extensionCarrierLegalContract(artifactProduct, memberNames, {
        family: group.family,
        target: group.target,
      });
      for (const sqlName of memberNames) stageExtensionUpstreamLicenses(sqlName, stage);
      const bundleManifest = path.join(stage, 'bundle-manifest.json');
      writeFileSync(
        bundleManifest,
        canonicalJson({
          schema: 'oliphaunt-extension-bundle-v1',
          product: artifactProduct,
          version: product.version,
          compatibility,
          family: group.family,
          target: group.target,
          licenseProfile: legal.profile,
          licenseFiles: legal.licenseFiles,
          members: manifestMembers,
        }),
      );
      stageReleaseNotices(stage, { profile: legal.profile });
      mutateBundleStage?.({
        archiveRoot,
        bundleManifest,
        family: group.family,
        legal,
        stage,
        target: group.target,
      });
      const output = path.join(directory, `${archiveRoot}.tar.gz`);
      const tarOptions = {
        includeDirectories: false,
        fail(message) {
          throw new Error(`publication lock fixture: ${message}`);
        },
      };
      if (bundleFixedFileMode !== null) tarOptions.fixedFileMode = bundleFixedFileMode;
      writeFileSync(
        output,
        canonicalGzipSync(createDeterministicTar(stage, archiveRoot, tarOptions)),
      );
      mutateBundleArchive?.({
        archiveRoot,
        family: group.family,
        output,
        target: group.target,
      });
      carrierAssets.push({
        name: path.basename(output),
        path: output,
        sha256: sha256File(output),
        bytes: readFileSync(output).length,
        family: group.family,
        target: group.target,
        kind: 'extension-bundle',
        memberCount: sqlNames.length,
      });
    }
  }
  const extensionManifestPath = path.join(productRoot, 'extension-artifacts.json');
  const extensionManifest = bundled
    ? {
        schema: 'oliphaunt-extension-ci-artifacts-v2',
        product: artifactProduct,
        ...ownership,
        version: product.version,
        compatibility,
        extensions,
        carrierAssets,
      }
    : {
        schema: 'oliphaunt-extension-ci-artifacts-v1',
        product: artifactProduct,
        ...ownership,
        version: product.version,
        compatibility,
        ...extensions[0],
      };
  writeFileSync(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`);
  const manifestName = `${artifactProduct}-${product.version}-manifest.json`;
  const propertiesName = `${artifactProduct}-${product.version}-manifest.properties`;
  const swiftCarrierName = swiftExtensionCarrierAssetName(artifactProduct, product.version);
  const checksumName = `${artifactProduct}-${product.version}-release-assets.sha256`;
  const directAssets = bundled ? carrierAssets : assets;
  writeFileSync(
    path.join(directory, manifestName),
    `${JSON.stringify(
      {
        schema: bundled
          ? 'oliphaunt-extension-release-manifest-v2'
          : 'oliphaunt-extension-release-manifest-v1',
        product: artifactProduct,
        ...ownership,
        version: product.version,
        extensionClass: releaseMetadata.class,
        versioning: releaseMetadata.versioning,
        sourceIdentity: extensionSourceIdentity(artifactProduct, 'publication-lock.test'),
        compatibility,
        ...(bundled
          ? {
              extensions: extensions.map((row) => ({
                ...row,
                assets: row.assets.map(
                  ({
                    name,
                    family,
                    target,
                    kind,
                    identity,
                    sha256,
                    bytes,
                    carrierAsset,
                    carrierRoot,
                    memberPath,
                  }) => ({
                    name,
                    family,
                    target,
                    kind,
                    identity,
                    sha256,
                    bytes,
                    carrierAsset,
                    carrierRoot,
                    memberPath,
                  }),
                ),
              })),
              assets: carrierAssets.map(
                ({ name, family, target, kind, sha256, bytes, memberCount }) => ({
                  name,
                  family,
                  target,
                  kind,
                  sha256,
                  bytes,
                  memberCount,
                }),
              ),
            }
          : {
              sqlName: extensions[0].sqlName,
              createsExtension: extensions[0].createsExtension,
              dependencies: extensions[0].dependencies,
              dataFiles: extensions[0].dataFiles,
              extensionSqlFileNames: extensions[0].extensionSqlFileNames,
              extensionSqlFilePrefixes: extensions[0].extensionSqlFilePrefixes,
              nativeModuleStem: extensions[0].nativeModuleStem,
              iosNativeDependencies: extensions[0].iosNativeDependencies,
              iosRegistration: extensions[0].iosRegistration,
              wasixInstall: extensions[0].wasixInstall,
              sharedPreloadLibraries: extensions[0].sharedPreloadLibraries,
              assets: assets.map(({ name, family, target, kind, identity, sha256, bytes }) => ({
                name,
                family,
                target,
                kind,
                identity,
                sha256,
                bytes,
              })),
            }),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, propertiesName),
    `schema=oliphaunt-extension-release-manifest-v${bundled ? '2' : '1'}\nproduct=${artifactProduct}\n${artifactProduct === product.id ? '' : `releaseProduct=${product.id}\ncarrierFamily=${family ?? 'combined'}\n`}version=${product.version}\n`,
  );
  writeFileSync(
    path.join(directory, swiftCarrierName),
    `${JSON.stringify(
      buildSwiftExtensionCarrierManifest({
        extensionManifest: extensionManifestPath,
        verifyMembers: false,
      }),
      null,
      2,
    )}\n`,
  );
  const payloadNames = [
    ...directAssets.map((asset) => asset.name),
    manifestName,
    propertiesName,
    swiftCarrierName,
  ].sort();
  writeFileSync(
    path.join(directory, checksumName),
    payloadNames.map((name) => `${sha256File(path.join(directory, name))}  ./${name}\n`).join(''),
  );
  return { assets: directAssets, directory, manifestPath: extensionManifestPath, swiftCarrierName };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('canonical publication catalog', () => {
  test('projects repeated package dependencies to one sorted internal carrier edge', () => {
    const carriers = [
      { id: 'npm:@oliphaunt/zeta', version: '0.1.0' },
      { id: 'cargo:oliphaunt-tools', version: '0.1.0' },
      { id: 'cargo:oliphaunt', version: '0.1.0' },
    ];
    const packageDependencies = [
      { ecosystem: 'cargo', name: 'oliphaunt-tools', requirement: '=0.1.0', scope: 'runtime' },
      { ecosystem: 'npm', name: '@oliphaunt/zeta', requirement: '0.1.0', scope: 'optional' },
      { ecosystem: 'cargo', name: 'serde', requirement: '1', scope: 'runtime' },
      { ecosystem: 'cargo', name: 'oliphaunt-tools', requirement: '=0.1.0', scope: 'build' },
      { ecosystem: 'cargo', name: 'oliphaunt-tools', requirement: '=0.1.0', scope: 'runtime' },
    ];
    expect(projectInternalDependencyIds(carriers, packageDependencies)).toEqual([
      'cargo:oliphaunt-tools',
      'npm:@oliphaunt/zeta',
    ]);
  });

  test('projects only matching selected versions and package-manager publication scopes', () => {
    const carriers = [
      { id: 'cargo:tools', version: '0.3.1' },
      { id: 'npm:tools', version: '0.3.1' },
      { id: 'maven:example:tools', version: '0.3.1' },
    ];
    const edge = (ecosystem, name, requirement, scope = 'runtime') => ({
      ecosystem,
      name,
      requirement,
      scope,
    });
    expect(
      projectInternalDependencyIds(carriers, [
        edge('cargo', 'tools', '=0.2.4'),
        edge('npm', 'tools', '0.2.4'),
        edge('maven', 'example:tools', '0.2.4'),
        edge('cargo', 'tools', '=0.3.1', 'development'),
        edge('maven', 'example:tools', '0.3.1', 'test'),
      ]),
    ).toEqual([]);
    expect(
      projectInternalDependencyIds(carriers, [
        edge('cargo', 'tools', '0.3.0', 'build'),
        edge('cargo', 'tools', '>=0.3.0,<0.4.0'),
        edge('npm', 'tools', '^0.3.0', 'optional'),
        edge('maven', 'example:tools', '0.3.1', 'compile'),
      ]),
    ).toEqual(['cargo:tools', 'maven:example:tools', 'npm:tools']);
    expect(projectInternalDependencyIds(carriers, [edge('npm', 'tools', '0.3.0')])).toEqual([]);
    expect(projectInternalDependencyIds(carriers, [edge('cargo', 'tools', '0.2.4')])).toEqual([]);
  });

  test('Cargo bare prerelease and build versions retain implicit caret semantics', () => {
    const carriers = [
      { id: 'cargo:tools', version: '1.0.1' },
      { id: 'npm:tools', version: '1.0.1' },
    ];
    for (const requirement of ['1.0.0-rc.1', '1.0.0+build', ' 1.0.0-rc.1+build ']) {
      expect(
        projectInternalDependencyIds(carriers, [
          { ecosystem: 'cargo', name: 'tools', requirement, scope: 'runtime' },
          { ecosystem: 'npm', name: 'tools', requirement, scope: 'runtime' },
        ]),
      ).toEqual(['cargo:tools']);
    }
    expect(
      projectInternalDependencyIds(carriers, [
        { ecosystem: 'cargo', name: 'tools', requirement: '=1.0.0-rc.1', scope: 'runtime' },
      ]),
    ).toEqual([]);
  });

  test('permits only Cargo part identities as dynamic carriers', () => {
    const catalog = loadPublicationCatalog('publication-lock.test', {
      products: ['liboliphaunt-native'],
    });
    const part = resolveActualCarrier(
      catalog,
      'cargo',
      'liboliphaunt-native-linux-x64-gnu-part-001',
    );
    expect(part.declared).toBe(false);
    expect(part.parentCarrier).toBe('cargo:liboliphaunt-native-linux-x64-gnu');
    expect(part.part).toBe(1);
    expect(() =>
      resolveActualCarrier(catalog, 'cargo', 'liboliphaunt-native-linux-x64-gnu-part-000'),
    ).toThrow('1-based');
    expect(() =>
      resolveActualCarrier(catalog, 'cargo', 'liboliphaunt-native-linux-x64-gnu-part-1000'),
    ).toThrow('is not a Cargo payload part crate');
    expect(() =>
      resolveActualCarrier(catalog, 'npm', '@oliphaunt/liboliphaunt-linux-x64-gnu-payload-0'),
    ).toThrow('dynamic identities are permitted only for Cargo');
  });

  test('requires every split carrier to use one complete contiguous 1-based part set', () => {
    const parent = {
      id: 'cargo:fixture-linux-x64-gnu',
      ecosystem: 'cargo',
      name: 'fixture-linux-x64-gnu',
      role: 'platform-leaf',
      declared: true,
      packageDependencies: [
        { ecosystem: 'cargo', name: 'fixture-linux-x64-gnu-part-001' },
        { ecosystem: 'cargo', name: 'fixture-linux-x64-gnu-part-002' },
      ],
    };
    const part = (number) => ({
      id: `cargo:fixture-linux-x64-gnu-part-${String(number).padStart(3, '0')}`,
      ecosystem: 'cargo',
      name: `fixture-linux-x64-gnu-part-${String(number).padStart(3, '0')}`,
      role: 'payload-part',
      declared: false,
      parentCarrier: parent.id,
      part: number,
      packageDependencies: [],
    });
    expect(() => validateCargoPayloadPartSets([part(1), part(2), parent])).not.toThrow();
    expect(() =>
      validateCargoPayloadPartSets([
        part(1),
        part(3),
        {
          ...parent,
          packageDependencies: [
            { ecosystem: 'cargo', name: 'fixture-linux-x64-gnu-part-001' },
            { ecosystem: 'cargo', name: 'fixture-linux-x64-gnu-part-003' },
          ],
        },
      ]),
    ).toThrow('contiguous from part-001');
    expect(() => validateCargoPayloadPartSets([part(1), parent])).toThrow(
      'exactly its complete Cargo payload part set',
    );
  });

  test('keeps contrib WASIX dependencies exact and external dependencies patch-compatible', () => {
    expect(extensionDependencyRequirement('0.1.2', 'runtime-bound')).toBe('=0.1.2');
    expect(extensionDependencyRequirement('0.3.4', 'upstream-bound')).toBe('>=0.3.4,<0.4.0');
    expect(extensionDependencyRequirement('2.3.4', 'upstream-bound')).toBe('>=2.3.4,<3.0.0');
  });
});

describe('publication artifact discovery and freezing', () => {
  test('freezes a held-version package cycle and rejects a selected new package cycle', () => {
    const version = currentProductVersionSync('oliphaunt-rust');
    const fixture = (requirement, scope = 'dependencies') => {
      const root = temporaryDirectory();
      cargoFixture(root, 'oliphaunt-build', version, {
        manifestSuffix: `\n${scope === 'dependencies' ? '' : `[${scope}]\n`}oliphaunt = "${requirement}"\n`,
      });
      cargoFixture(root, 'oliphaunt', version, {
        manifestSuffix: `\noliphaunt-build = "=${version}"\n`,
      });
      return () =>
        buildPublicationCandidate({ products: ['oliphaunt-rust'], artifactRoots: [root] });
    };
    const held = fixture('=0.0.0')();
    expect(held.carriers.find(({ id }) => id === 'cargo:oliphaunt-build').dependencies).toEqual([]);
    expect(held.carriers.find(({ id }) => id === 'cargo:oliphaunt').dependencies).toEqual([
      'cargo:oliphaunt-build',
    ]);
    expect(() => validatePublicationLock(freezePublicationCandidate(held))).not.toThrow();
    expect(() =>
      freezePublicationCandidate(fixture(`=${version}`, 'dev-dependencies')()),
    ).not.toThrow();
    expect(fixture(`=${version}`)).toThrow('carrier dependency cycle');
  });

  test('publish resolution rejects regenerated paths and mutations', () => {
    const root = mkdtempSync(path.join(import.meta.dir, '../../target/publication-lock-publish-'));
    temporaryDirectories.push(root);
    const frozen = npmFixture(root, '@oliphaunt/test', '1.2.3');
    const artifact = {
      path: path
        .relative(path.join(import.meta.dir, '../..'), frozen)
        .split(path.sep)
        .join('/'),
      sha256: sha256File(frozen),
      size: readFileSync(frozen).length,
    };
    const lock = {
      carriers: [
        {
          id: 'npm:@oliphaunt/test',
          ecosystem: 'npm',
          name: '@oliphaunt/test',
          version: '1.2.3',
          artifacts: [artifact],
        },
      ],
    };

    expect(lockedCarrierFile(lock, 'npm', '@oliphaunt/test', frozen).file).toBe(frozen);
    const regenerated = path.join(root, 'regenerated.tgz');
    writeFileSync(regenerated, readFileSync(frozen));
    expect(() => lockedCarrierFile(lock, 'npm', '@oliphaunt/test', regenerated)).toThrow(
      'attempted to substitute',
    );
    writeFileSync(frozen, 'regenerated bytes');
    expect(() => lockedCarrierFile(lock, 'npm', '@oliphaunt/test', frozen)).toThrow(
      'bytes do not match',
    );
  });

  test('reads npm, Cargo, and Maven identities, bytes, and dependencies', () => {
    const root = temporaryDirectory();
    npmFixture(root, '@oliphaunt/test', '1.2.3');
    cargoFixture(root, 'oliphaunt-test', '1.2.3');
    mavenFixture(root, 'dev.oliphaunt', 'test', '1.2.3');
    const records = discoverPublicationArtifacts([root]);
    expect(records.map((record) => `${record.ecosystem}:${record.name}`).sort()).toEqual([
      'cargo:oliphaunt-test',
      'maven:dev.oliphaunt:test',
      'npm:@oliphaunt/test',
    ]);
    expect(
      records.every((record) =>
        record.artifacts.every((artifact) => artifact.size > 0 && artifact.sha256.length === 64),
      ),
    ).toBe(true);
    expect(records.find((record) => record.ecosystem === 'cargo').dependencies[0].name).toBe(
      'serde',
    );
  });

  test('freezes repeated target-specific Cargo package rows as one internal carrier edge', () => {
    const root = temporaryDirectory();
    const catalog = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-rust'],
    });
    const version = catalog.products[0].version;
    cargoFixture(root, 'oliphaunt-build', version);
    cargoFixture(root, 'oliphaunt', version, {
      manifestSuffix: [
        '',
        '[target.\'cfg(target_os = "linux")\'.dependencies]',
        `oliphaunt-build = "=${version}"`,
        '',
        '[target.\'cfg(target_os = "macos")\'.dependencies]',
        `oliphaunt-build = "=${version}"`,
        '',
        '[target.\'cfg(target_os = "windows")\'.dependencies]',
        `oliphaunt-build = "=${version}"`,
        '',
      ].join('\n'),
    });

    const candidate = buildPublicationCandidate({
      products: ['oliphaunt-rust'],
      artifactRoots: [root],
    });
    const facade = candidate.carriers.find(({ id }) => id === 'cargo:oliphaunt');
    expect(
      facade.packageDependencies.filter(({ name }) => name === 'oliphaunt-build'),
    ).toHaveLength(3);
    expect(facade.dependencies).toEqual(['cargo:oliphaunt-build']);
    expect(() => freezePublicationCandidate(candidate)).not.toThrow();

    const duplicatedEdge = structuredClone(candidate);
    duplicatedEdge.carriers
      .find(({ id }) => id === 'cargo:oliphaunt')
      .dependencies.push('cargo:oliphaunt-build');
    expect(() => validatePublicationCandidate(duplicatedEdge)).toThrow(
      'cargo:oliphaunt.dependencies must be sorted and contain no duplicates',
    );
  });

  test('rejects frozen npm tarballs that cannot use trusted publishing', () => {
    for (const [label, overrides, pattern] of [
      ['missing-repository', { repository: undefined }, /repository must be an object/u],
      [
        'wrong-repository',
        { repository: { type: 'git', url: 'https://github.com/example/other' } },
        /repository\.url must exactly match/u,
      ],
      [
        'provenance-disabled',
        { publishConfig: { access: 'public', provenance: false } },
        /must not disable npm provenance/u,
      ],
    ]) {
      const root = temporaryDirectory();
      npmFixture(root, `@oliphaunt/${label}`, '1.2.3', overrides);
      expect(() => discoverPublicationArtifacts([root])).toThrow(pattern);
    }
  });

  test('reads the root npm manifest when a dependency is bundled', () => {
    const root = temporaryDirectory();
    npmFixture(
      root,
      '@oliphaunt/ts',
      '1.2.3',
      {},
      {
        name: '@oliphaunt/ts-query',
        version: '0.0.0',
      },
    );
    expect(discoverPublicationArtifacts([root])).toMatchObject([
      {
        ecosystem: 'npm',
        name: '@oliphaunt/ts',
        version: '1.2.3',
      },
    ]);
  });

  test('freezes an exhaustive product carrier set and detects tampering', () => {
    const root = temporaryDirectory();
    const catalog = loadPublicationCatalog('publication-lock.test', { products: ['oliphaunt-js'] });
    const version = catalog.products[0].version;
    npmFixture(root, '@oliphaunt/ts', version);
    const candidate = buildPublicationCandidate({
      products: ['oliphaunt-js'],
      artifactRoots: [root],
    });
    expect(candidate.missing).toEqual([]);
    expect(candidate.carriers).toHaveLength(1);
    expect(candidate.packageEnvelopeDigest).toHaveLength(64);
    const unknownDependency = structuredClone(candidate);
    unknownDependency.carriers[0].dependencies = ['npm:@oliphaunt/not-frozen'];
    expect(() => validatePublicationCandidate(unknownDependency)).toThrow(
      /internal package dependency identities/u,
    );
    const nonCanonicalIdentity = structuredClone(candidate);
    nonCanonicalIdentity.carriers[0].id = 'npm:wrong-name';
    expect(() => validatePublicationCandidate(nonCanonicalIdentity)).toThrow(/canonical/u);
    const lock = freezePublicationCandidate(candidate);
    expect(validatePublicationLock(lock)).toBe(lock);
    const tampered = structuredClone(lock);
    tampered.carriers[0].artifacts[0].size += 1;
    expect(() => validatePublicationLock(tampered)).toThrow(
      /Digest mismatch|digest mismatch|packageEnvelopeDigest/u,
    );
  });

  test('projects broad artifact roots through the full catalog onto selected products', () => {
    const root = temporaryDirectory();
    const selectedCatalog = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-js'],
    });
    const selectedVersion = selectedCatalog.products[0].version;
    npmFixture(root, '@oliphaunt/ts', selectedVersion);

    const fullCatalog = loadPublicationCatalog('publication-lock.test');
    const unselected = fullCatalog.carriers.find(
      (carrier) =>
        carrier.ecosystem === 'cargo' &&
        carrier.product === 'oliphaunt-rust' &&
        carrier.name === 'oliphaunt',
    );
    expect(unselected).toBeDefined();
    cargoFixture(root, unselected.name, unselected.version);
    cargoFixture(root, unselected.name, '999.0.0');
    const unselectedNpm = fullCatalog.carriers.find(
      (carrier) => carrier.ecosystem === 'npm' && carrier.product === 'oliphaunt-broker',
    );
    expect(unselectedNpm).toBeDefined();
    npmFixture(path.join(root, 'unselected-a'), unselectedNpm.name, unselectedNpm.version, {
      description: 'first unselected carrier bytes',
      oliphaunt: { qualificationOnly: true },
    });
    npmFixture(path.join(root, 'unselected-b'), unselectedNpm.name, unselectedNpm.version, {
      description: 'second unselected carrier bytes',
    });

    const candidate = buildPublicationCandidate({
      products: ['oliphaunt-js'],
      artifactRoots: [root],
    });
    expect(candidate.carriers.map((carrier) => `${carrier.ecosystem}:${carrier.name}`)).toEqual([
      'npm:@oliphaunt/ts',
    ]);
    expect(candidate.carriers.every((carrier) => carrier.product === 'oliphaunt-js')).toBe(true);

    const conflictingSelected = npmFixture(
      path.join(root, 'selected-conflict'),
      '@oliphaunt/ts',
      selectedVersion,
      { description: 'ambiguous selected carrier bytes' },
    );
    expect(() =>
      buildPublicationCandidate({
        products: ['oliphaunt-js'],
        artifactRoots: [root],
      }),
    ).toThrow(/duplicate artifact identity npm:@oliphaunt\/ts@.+ conflicting candidate bytes/u);
    unlinkSync(conflictingSelected);

    cargoFixture(root, 'undeclared-publication-carrier', '1.2.3');
    expect(() =>
      buildPublicationCandidate({
        products: ['oliphaunt-js'],
        artifactRoots: [root],
      }),
    ).toThrow(/artifact identity cargo:undeclared-publication-carrier is not declared/u);
  });

  test('refuses to freeze a selected workspace qualification carrier', () => {
    const root = temporaryDirectory();
    const catalog = loadPublicationCatalog('publication-lock.test', { products: ['oliphaunt-js'] });
    npmFixture(root, '@oliphaunt/ts', catalog.products[0].version, {
      oliphaunt: { qualificationOnly: true },
    });
    expect(() =>
      buildPublicationCandidate({ products: ['oliphaunt-js'], artifactRoots: [root] }),
    ).toThrow('workspace qualification carrier');
  });

  test('rejects qualification extension fixtures only when their product is selected', () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-extension-vector'],
    }).products[0];
    const { manifestPath } = extensionGithubReleaseFixture(root, product);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Presence rejects even a forged false marker.
    manifest.qualificationOnly = false;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      'workspace qualification carrier',
    );
    const unrelated = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-js'],
    }).products[0];
    expect(discoverProductArtifacts([root], [unrelated])).toEqual([]);
  });

  test.each([
    'oliphaunt-broker',
    'postgres-tools-native',
    'postgres-tools-wasix',
  ])('freezes exact %s GitHub assets and rejects tampering, missing assets, and extras', (id) => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog('publication-lock.test', {
      products: [id],
    }).products[0];
    const { checksum, directory, rows } = githubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(rows.length);
    assertExpectedArtifactInventory(artifacts, [product]);
    expect(
      artifacts.every(
        (artifact) => artifact.role === 'github-release-asset' && artifact.sha256.length === 64,
      ),
    ).toBe(true);

    const payload = rows.find((row) => row !== checksum);
    const payloadPath = path.join(directory, payload.name);
    writeFileSync(payloadPath, 'tampered\n');
    expect(() => discoverProductArtifacts([root], [product])).toThrow('checksum');
    writeFileSync(payloadPath, `fixture:${payload.name}\n`);

    unlinkSync(payloadPath);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      /requires exactly one|asset set mismatch/u,
    );
    writeFileSync(payloadPath, `fixture:${payload.name}\n`);

    writeFileSync(path.join(directory, 'undeclared.zip'), 'extra\n');
    expect(() => discoverProductArtifacts([root], [product])).toThrow('extra');
  });

  test('freezes every declared extension OS target plus public metadata', () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-extension-vector'],
    }).products[0];
    const { assets, directory, manifestPath, swiftCarrierName } = extensionGithubReleaseFixture(
      root,
      product,
    );
    const artifacts = discoverProductArtifacts([root], [product]);
    assertExpectedArtifactInventory(artifacts, [product]);
    expect(artifacts).toHaveLength(assets.length + 4);
    expect(
      new Set(
        artifacts
          .filter((artifact) => artifact.role === 'github-release-asset')
          .map((artifact) => artifact.target),
      ),
    ).toEqual(
      new Set(
        extensionArtifactTargets({ product: product.id }, 'publication-lock.test').map(
          (target) => target.target,
        ),
      ),
    );

    const swiftCarrierPath = path.join(directory, swiftCarrierName);
    const incompatibleCarrier = JSON.parse(readFileSync(swiftCarrierPath, 'utf8'));
    incompatibleCarrier.base.version = '9.9.9';
    incompatibleCarrier.base.tag = 'liboliphaunt-native-v9.9.9';
    writeFileSync(swiftCarrierPath, `${JSON.stringify(incompatibleCarrier, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow('compatible native base');

    extensionGithubReleaseFixture(root, product);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const missingRole = manifest.assets.find((asset) => asset.kind === 'ios-xcframework');
    manifest.assets = manifest.assets.filter((asset) => asset !== missingRole);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    unlinkSync(path.join(directory, missingRole.name));
    expect(() => discoverProductArtifacts([root], [product])).toThrow('roles');

    extensionGithubReleaseFixture(root, product);
    writeFileSync(path.join(directory, 'undeclared-extension-asset.tar.gz'), 'extra\n');
    expect(() => discoverProductArtifacts([root], [product])).toThrow('extra');

    extensionGithubReleaseFixture(root, product);
    const publicManifestPath = path.join(
      directory,
      `${product.id}-${product.version}-manifest.json`,
    );
    const forgedPublicManifest = JSON.parse(readFileSync(publicManifestPath, 'utf8'));
    forgedPublicManifest.versioning = 'independent';
    forgedPublicManifest.sourceIdentity = {
      kind: 'external',
      name: 'forged',
      url: 'https://invalid.example',
      branch: 'main',
      commit: '0'.repeat(40),
    };
    writeFileSync(publicManifestPath, `${JSON.stringify(forgedPublicManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      /canonical extension identity/u,
    );

    extensionGithubReleaseFixture(root, product);
    const forgedCiManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    forgedCiManifest.compatibility.nativeRuntimeVersion = '9.9.9';
    writeFileSync(manifestPath, `${JSON.stringify(forgedCiManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/does not describe/u);

    extensionGithubReleaseFixture(root, product);
    const forgedInventoryManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    forgedInventoryManifest.dataFiles = [
      ...forgedInventoryManifest.dataFiles,
      'undeclared/foreign.sql',
    ].sort();
    writeFileSync(manifestPath, `${JSON.stringify(forgedInventoryManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      /semantic extension metadata is not canonical generated metadata/u,
    );
  });

  test('freezes the exact contrib bundle member set under one release owner', {
    timeout: 20_000,
  }, () => {
    const root = temporaryDirectory();
    const artifactProduct = 'oliphaunt-extension-contrib-pg18';
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['liboliphaunt-native'],
    }).products[0];
    const fixtureOptions = { artifactProduct, family: 'native' };
    const { rows: runtimeAssets } = githubReleaseFixture(root, product);
    const { assets, manifestPath } = extensionGithubReleaseFixture(root, product, fixtureOptions);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(runtimeAssets.length + assets.length + 4);
    assertExpectedArtifactInventory(artifacts, [product]);
    expect(assets.every(({ name }) => /^oliphaunt-extension-contrib-pg18-[^-]+/u.test(name))).toBe(
      true,
    );
    const candidate = buildPublicationCandidate({
      products: [product.id],
      artifactRoots: [root],
      allowMissing: true,
    });
    expect(candidate.missing.length).toBeGreaterThan(0);
    expect(() => validatePublicationCandidate(candidate)).not.toThrow();

    const wrongCarrierIdentity = structuredClone(candidate);
    wrongCarrierIdentity.productArtifacts.find(
      ({ role }) => role === 'github-release-asset',
    ).identity = 'wrong-family';
    expect(() => validatePublicationCandidate(wrongCarrierIdentity)).toThrow(
      /packageEnvelopeDigest mismatch|incorrect target, kind, or identity metadata/u,
    );

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.extensions.pop();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      'exact sorted bundle member set',
    );

    extensionGithubReleaseFixture(root, product, fixtureOptions);
    const forgedMemberInventory = JSON.parse(readFileSync(manifestPath, 'utf8'));
    forgedMemberInventory.extensions[0].extensionSqlFilePrefixes = [
      ...forgedMemberInventory.extensions[0].extensionSqlFilePrefixes,
      'undeclared-prefix',
    ].sort();
    writeFileSync(manifestPath, `${JSON.stringify(forgedMemberInventory, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      /semantic extension metadata is not canonical generated metadata/u,
    );

    extensionGithubReleaseFixture(root, product, fixtureOptions);
    const publicManifestPath = path.join(
      path.dirname(manifestPath),
      'release-assets',
      `${artifactProduct}-${product.version}-manifest.json`,
    );
    const forgedPublicManifest = JSON.parse(readFileSync(publicManifestPath, 'utf8'));
    forgedPublicManifest.compatibility.wasixRuntimeVersion = '9.9.9';
    writeFileSync(publicManifestPath, `${JSON.stringify(forgedPublicManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(
      /frozen aggregate member\/carrier inventory/u,
    );
  });

  test('rejects stale, missing, extra, substituted, or wrongly-moded aggregate bundle legal material', {
    timeout: 60_000,
  }, () => {
    const artifactProduct = 'oliphaunt-extension-contrib-pg18';
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['liboliphaunt-native'],
    }).products[0];
    const reject = (options, expected) => {
      const root = temporaryDirectory();
      githubReleaseFixture(root, product);
      extensionGithubReleaseFixture(root, product, {
        ...options,
        artifactProduct,
        family: 'native',
      });
      expect(() => discoverProductArtifacts([root], [product])).toThrow(expected);
    };

    reject(
      {
        mutateBundleStage({ bundleManifest }) {
          const manifest = JSON.parse(readFileSync(bundleManifest, 'utf8'));
          delete manifest.licenseProfile;
          writeFileSync(bundleManifest, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      },
      /bundle-manifest\.json does not exactly freeze its nested member and legal locators/u,
    );

    reject(
      {
        mutateBundleStage({ stage }) {
          unlinkSync(path.join(stage, 'LICENSE'));
        },
      },
      /contains undeclared or missing regular bundle members/u,
    );

    reject(
      {
        mutateBundleStage({ stage }) {
          writeFileSync(path.join(stage, 'UNDECLARED.txt'), 'undeclared\n');
        },
      },
      /contains undeclared or missing regular bundle members/u,
    );

    reject(
      {
        mutateBundleStage({ stage }) {
          writeFileSync(path.join(stage, 'LICENSE'), 'substituted legal bytes\n');
        },
      },
      /legal member .*\/LICENSE does not match its canonical bytes and mode/u,
    );

    reject(
      {
        bundleFixedFileMode: null,
        mutateBundleStage({ stage }) {
          chmodSync(path.join(stage, 'LICENSE'), 0o600);
        },
      },
      /member .*\/LICENSE must be a regular mode=644 file/u,
    );
  });

  test('rejects bundle encodings that supported mobile consumers reject', {
    timeout: 60_000,
  }, () => {
    const artifactProduct = 'oliphaunt-extension-contrib-pg18';
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['liboliphaunt-native'],
    }).products[0];
    const reject = (options, expected) => {
      const root = temporaryDirectory();
      githubReleaseFixture(root, product);
      extensionGithubReleaseFixture(root, product, {
        ...options,
        artifactProduct,
        family: 'native',
      });
      expect(() => discoverProductArtifacts([root], [product])).toThrow(expected);
    };

    reject(
      {
        mutateBundleStage({ bundleManifest }) {
          const manifest = JSON.parse(readFileSync(bundleManifest, 'utf8'));
          writeFileSync(bundleManifest, `${JSON.stringify(manifest)}\n`);
        },
      },
      /bundle-manifest\.json must use the exact canonical bytes/u,
    );

    reject(
      {
        mutateBundleArchive({ output }) {
          const bytes = readFileSync(output);
          bytes[3] = 8;
          writeFileSync(output, bytes);
        },
      },
      /without optional header sections/u,
    );

    reject(
      {
        mutateBundleArchive({ output }) {
          const tar = gunzipSync(readFileSync(output));
          Buffer.from('ustar  \0', 'ascii').copy(tar, 257);
          refreshTarHeaderChecksum(tar);
          writeFileSync(output, canonicalGzipSync(tar));
        },
      },
      /non-POSIX-ustar/u,
    );
  });

  test('keeps SQL-only mobile extensions resource-only', () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-extension-pgtap'],
    }).products[0];
    extensionGithubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    const mobile = artifacts.filter(
      (artifact) =>
        artifact.role === 'github-release-asset' &&
        (artifact.target === 'ios-xcframework' || artifact.target.startsWith('android-')),
    );
    expect(
      mobile.every((artifact) => artifact.kind === 'runtime' && artifact.identity === null),
    ).toBe(true);
  });

  test('pre-version inventory is digest-bound construction and cannot be frozen', () => {
    const root = mkdtempSync(path.join(ROOT, 'target/publication-lock-phase-'));
    temporaryDirectories.push(root);
    const product = loadPublicationCatalog('publication-lock-phase', { products: ['oliphaunt-js'] })
      .products[0];
    npmFixture(root, '@oliphaunt/ts', product.version);
    const final = buildPublicationCandidate({ products: [product.id], artifactRoots: [root] });
    const pre = buildPublicationCandidate({
      products: [product.id],
      artifactRoots: [root],
      artifactPhase: 'pre-version',
    });
    expect(pre.carriers).toEqual(final.carriers);
    expect(pre.productArtifacts).toEqual(final.productArtifacts);
    expect(pre.packageEnvelopeDigest).not.toBe(final.packageEnvelopeDigest);
    expect(() => validatePublicationCandidate(pre)).not.toThrow();
    expect(() => freezePublicationCandidate(pre)).toThrow(/construction.*cannot freeze/u);
    const forged = { ...pre, artifactPhase: 'final' };
    expect(() => validatePublicationCandidate(forged)).toThrow(/packageEnvelopeDigest/u);
    expect(() => validatePublicationCandidate({ ...pre, scope: undefined })).toThrow(
      /construction scope/u,
    );
    expect(() => freezePublicationCandidate(final)).not.toThrow();
  });

  test('freezes a selection-neutral Swift source carrier and separately composed dependency-closed output', () => {
    const workspaceRoot = mkdtempSync(
      path.join(import.meta.dir, '../../target/publication-lock-swift-'),
    );
    temporaryDirectories.push(workspaceRoot);
    const sdk = path.join(workspaceRoot, 'sdk-artifacts/oliphaunt-swift');
    const fixture = path.join(workspaceRoot, 'release/swiftpm-extension-consumer-fixture');
    mkdirSync(path.join(sdk, 'extension-generator'), { recursive: true });
    mkdirSync(path.join(sdk, 'release-tree/src/sdks/swift/Carriers'), { recursive: true });
    mkdirSync(path.join(fixture, 'Sources/OliphauntExtensionPgtap/Resources/extension-artifact'), {
      recursive: true,
    });
    writeFileSync(path.join(sdk, 'Oliphaunt-source.zip'), 'source archive\n');
    writeFileSync(path.join(sdk, 'Package.swift.release'), '// release manifest fixture\n');
    for (const name of [
      'extension-owner-catalog.json',
      'extension-resource-inventory.mjs',
      'render-extension-products.mjs',
      'swift-carrier-resolver.mjs',
      'swiftpm-extension-input.schema.json',
    ]) {
      writeFileSync(
        path.join(sdk, 'extension-generator', name),
        name === 'extension-owner-catalog.json'
          ? readFileSync(
              path.join(import.meta.dir, '../../src/extensions/generated/sdk/extensions.json'),
            )
          : name === 'extension-resource-inventory.mjs'
            ? releaseJavaScript(
                path.join(
                  import.meta.dir,
                  '../../src/native/sdks/swift/tools/extension-resource-inventory.mts',
                ),
              )
            : `${name}\n`,
      );
    }
    const sourceCarrier = path.join(
      sdk,
      'release-tree/src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
    );
    const canonicalSourceCarrier = selectionNeutralSwiftSourceCarrier(
      productCompatibilityVersion(
        'oliphaunt-swift',
        'liboliphaunt-native',
        'publication-lock.test',
      ),
    );
    writeFileSync(sourceCarrier, `${JSON.stringify(canonicalSourceCarrier)}\n`);
    const baseXcframework = canonicalSourceCarrier.base.assets.find(
      ({ role }) => role === 'base-xcframework',
    );
    writeFileSync(
      path.join(sdk, 'Package.swift.release'),
      `.binaryTarget(\n    name: "liboliphaunt",\n    url: "${baseXcframework.url}",\n    checksum: "${baseXcframework.sha256}"\n)\n`,
    );
    writeFileSync(path.join(fixture, 'Package.swift'), '// generated consumer\n');
    writeFileSync(
      path.join(fixture, 'extension-products.json'),
      '{"schema":"oliphaunt-swiftpm-extension-products-v1"}\n',
    );
    writeFileSync(
      path.join(
        fixture,
        'Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control',
      ),
      "default_version='1.0'\n",
    );

    const catalog = loadPublicationCatalog('publication-lock.test', {
      products: ['oliphaunt-swift', 'oliphaunt-extension-pgtap'],
    });
    const product = catalog.products.find(({ id }) => id === 'oliphaunt-swift');
    const extensionProduct = catalog.products.find(({ id }) => id === 'oliphaunt-extension-pgtap');
    expect(product).toBeDefined();
    expect(extensionProduct).toBeDefined();
    const bindingsName = `oliphaunt-swift-${product.version}-bindings.xcframework.zip`;
    const checksumName = `oliphaunt-swift-${product.version}-release-assets.sha256`;
    const releaseAssets = path.join(sdk, 'release-assets');
    mkdirSync(releaseAssets);
    const bindingsBytes = Buffer.from('Swift bindings artifact fixture\n');
    writeFileSync(path.join(releaseAssets, bindingsName), bindingsBytes);
    writeFileSync(
      path.join(releaseAssets, checksumName),
      `${createHash('sha256').update(bindingsBytes).digest('hex')}  ./${bindingsName}\n`,
    );
    const { manifestPath } = extensionGithubReleaseFixture(workspaceRoot, extensionProduct);
    const extensionRoot = path.dirname(manifestPath);
    const selectedRoots = [sdk, fixture, extensionRoot];

    expect(() => discoverProductArtifacts([sdk, fixture], [product])).toThrow(
      /selects no extension products and requires no frozen Swift consumer fixture/u,
    );
    expect(() =>
      discoverProductArtifacts([sdk, extensionRoot], catalog.products, {
        swiftExtensionFixture: true,
      }),
    ).toThrow(/selects extension products and requires exactly one frozen Swift consumer fixture/u);
    const preVersionArtifacts = discoverProductArtifacts([sdk, extensionRoot], catalog.products, {
      artifactPhase: 'pre-version',
    });
    expect(
      preVersionArtifacts.some(({ kind }) => kind === 'swiftpm-extension-consumer-fixture'),
    ).toBe(false);
    expect(preVersionArtifacts.map(({ product, id }) => `${product}:${id}`).sort()).toEqual(
      expectedProductArtifactRows(catalog.products, { artifactPhase: 'pre-version' })
        .map(({ product, id }) => `${product}:${id}`)
        .sort(),
    );

    const artifacts = discoverProductArtifacts(selectedRoots, catalog.products, {
      swiftExtensionFixture: true,
    });
    expect(artifacts.filter(({ kind }) => kind !== 'swiftpm-extension-consumer-fixture')).toEqual(
      preVersionArtifacts,
    );
    const swiftArtifacts = artifacts.filter((artifact) => artifact.product === product.id);
    expect(swiftArtifacts.map(({ id }) => id).sort()).toEqual([
      `github-release:${bindingsName}`,
      `github-release:${checksumName}`,
      'release-input:Oliphaunt-source.zip',
      'release-input:Package.swift.release',
      'release-input:extension-owner-catalog.json',
      'release-input:extension-resource-inventory.mjs',
      'release-input:oliphaunt-react-native-ios-carriers.json',
      'release-input:render-extension-products.mjs',
      'release-input:swift-carrier-resolver.mjs',
      'release-input:swiftpm-extension-consumer-fixture',
      'release-input:swiftpm-release-tree',
    ]);
    expect(() =>
      assertLockedProductArtifacts(
        { productArtifacts: artifacts, products: catalog.products },
        product.id,
        [sdk, fixture],
      ),
    ).not.toThrow();
    const qualificationMarker = path.join(sdk, 'qualification.json');
    writeFileSync(qualificationMarker, JSON.stringify({ qualificationOnly: true }));
    expect(() =>
      discoverProductArtifacts(selectedRoots, catalog.products, { swiftExtensionFixture: true }),
    ).toThrow('workspace qualification carrier');
    unlinkSync(qualificationMarker);
    const frozenFixture = swiftArtifacts.find(
      ({ id }) => id === 'release-input:swiftpm-extension-consumer-fixture',
    );
    writeFileSync(
      path.join(
        fixture,
        'Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control',
      ),
      'tampered\n',
    );
    const tamperedFixture = discoverProductArtifacts(selectedRoots, catalog.products, {
      swiftExtensionFixture: true,
    }).find(
      ({ id, product: artifactProduct }) =>
        artifactProduct === product.id && id === 'release-input:swiftpm-extension-consumer-fixture',
    );
    expect(tamperedFixture.sha256).not.toBe(frozenFixture.sha256);

    const selectedSourceCarrier = structuredClone(canonicalSourceCarrier);
    selectedSourceCarrier.extensions.push({ sqlName: 'pgtap' });
    writeFileSync(sourceCarrier, `${JSON.stringify(selectedSourceCarrier)}\n`);
    expect(() =>
      discoverProductArtifacts(selectedRoots, catalog.products, { swiftExtensionFixture: true }),
    ).toThrow(/ios-carriers\.json\.extensions.*selection-neutral/u);

    const malformedSourceCarrier = structuredClone(canonicalSourceCarrier);
    delete malformedSourceCarrier.carriers;
    writeFileSync(sourceCarrier, `${JSON.stringify(malformedSourceCarrier)}\n`);
    expect(() => discoverProductArtifacts(selectedRoots, catalog.products)).toThrow(
      /ios-carriers\.json.*fields must be exactly/u,
    );
    writeFileSync(sourceCarrier, `${JSON.stringify(canonicalSourceCarrier)}\n`);

    writeFileSync(
      path.join(sdk, 'extension-generator/extension-resource-inventory.mjs'),
      '// forged inventory validator\n',
    );
    expect(() => discoverProductArtifacts(selectedRoots, catalog.products)).toThrow(
      /frozen extension-resource-inventory\.mjs must exactly match/u,
    );
  });
});

test('completed supplier projection covers the entire canonical GitHub delivery graph and keeps owner identities exact', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'complete-supplier-catalog-'));
  try {
    const root = path.resolve(import.meta.dir, '../..');
    const metadata = loadReleaseMetadata(root);
    const catalog = loadPublicationCatalog('complete supplier catalog fixture');
    const expected = expectedProductArtifactRows(catalog.products).filter(
      (row) => row.role === 'github-release-asset' || row.role === 'github-release-metadata',
    );
    const declarations = nativeSupplierGithubArtifactDeclarations(metadata)
      .map(
        (row) =>
          row.product +
          '/' +
          row.asset.replaceAll('{version}', metadata.products[row.product].version),
      )
      .sort();
    expect(declarations).toEqual(expected.map((row) => row.product + '/' + row.name).sort());
    const bytes = Buffer.from('catalog File fixture; no public or runtime qualification');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const supplierArtifacts = expected.map((row) => {
      const file = path.join(directory, row.name);
      writeFileSync(file, bytes);
      const version = metadata.products[row.product].version;
      return {
        publication: {
          product: row.product,
          version,
          tagName: row.product + '-v' + version,
          publicationSha: 'a'.repeat(40),
          publicationTree: 'b'.repeat(40),
          releaseSha: 'c'.repeat(40),
        },
        artifact: row.id,
        file: { path: file, size: bytes.length, sha256 },
      };
    });
    const snapshot = {
      source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
      supplierArtifacts,
    };
    const result = nativePublicationInputProjection(snapshot, metadata);
    expect(Object.keys(result.supplierArtifacts)).toHaveLength(expected.length);
    expect(
      Object.values(result.supplierArtifacts).some(
        (row) => row.publication.product === 'oliphaunt-swift',
      ),
    ).toBe(true);
    expect(
      Object.values(result.supplierArtifacts).some((row) => row.artifact.includes('extension-')),
    ).toBe(true);
    expect(() =>
      nativePublicationInputProjection(
        {
          ...snapshot,
          supplierArtifacts: [
            { ...supplierArtifacts[0], artifact: 'github-release:invented-private.bin' },
          ],
        },
        metadata,
      ),
    ).toThrow('unknown canonical');
    expect(() =>
      nativePublicationInputProjection(
        {
          ...snapshot,
          supplierArtifacts: [
            {
              ...supplierArtifacts[0],
              publication: {
                ...supplierArtifacts[0].publication,
                product: 'oliphaunt-rust',
                tagName: 'oliphaunt-rust-v' + supplierArtifacts[0].publication.version,
              },
            },
          ],
        },
        metadata,
      ),
    ).toThrow('unknown canonical');
    const subset = structuredClone(metadata);
    subset.products['oliphaunt-swift'].publish_targets = ['swift-package-source-tag'];
    const binding = supplierArtifacts.find(
      (row) => row.publication.product === 'oliphaunt-swift' && row.artifact.endsWith('.zip'),
    );
    expect(() =>
      nativePublicationInputProjection({ ...snapshot, supplierArtifacts: [binding] }, subset),
    ).toThrow('unknown canonical');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
