/** Canonical public layouts and real checksums; synthetic payloads grant no release authority. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from '../../../src/extensions/tools/extension-upstream-licenses.mts';
import {
  buildSwiftExtensionCarrierManifest,
  swiftExtensionCarrierAssetName,
} from '../../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { createDeterministicTar } from '../../packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../packaging/release-notices.mts';
import {
  allArtifactTargets,
  extensionArtifactProductRoot,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
} from '../release-artifact-targets.mts';
import { ROOT } from '../release-graph.mts';

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

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function githubReleaseFixture(root, product) {
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

export function extensionGithubReleaseFixture(
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
    readFileSync(path.join(ROOT, 'src/extensions/generated/sdk/extensions.json'), 'utf8'),
  );
  const staticLines = readFileSync(
    path.join(ROOT, 'src/extensions/generated/mobile/static-extensions.tsv'),
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
  if (family !== 'wasix')
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
    ...(family === 'wasix' ? [] : [swiftCarrierName]),
  ].sort();
  writeFileSync(
    path.join(directory, checksumName),
    payloadNames.map((name) => `${sha256File(path.join(directory, name))}  ./${name}\n`).join(''),
  );
  return { assets: directAssets, directory, manifestPath: extensionManifestPath, swiftCarrierName };
}
