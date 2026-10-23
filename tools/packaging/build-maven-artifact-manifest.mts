#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { extensionManifestMembers } from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import {
  assertExtensionUpstreamLicensesInEntries,
  extensionMavenLicenses,
  extensionRegistryLicense,
  nativeExtensionCarrierLegal,
  nativeExtensionConstructionMavenLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { requireCompatibilityVersionBounds } from '../release/compatibility-version-policy.mts';
import { frozenExtensionOwnerRequirements } from '../release/extension-release-metadata.mts';
import { currentVersion } from '../release/product-version.mts';
import {
  allArtifactTargets,
  extensionArtifactProductRoot,
  extensionMetadata,
  extensionOwnerForSqlName,
  extensionReleaseProduct,
  extensionReleaseVersion,
  extensionSqlNames,
  exactExtensionProducts as logicalExactExtensionProducts,
  registryPackageRows,
  extensionArtifactTargets as releaseExtensionArtifactTargets,
} from '../release/release-artifact-targets.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';
import {
  assertReleaseNoticesInEntries,
  releaseProfileMavenLicenses,
  releaseProfilePackageLicense,
} from './release-notices.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const PREFIX = 'build_maven_artifact_manifest.mts';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function canonicalMavenPayloadPrefix(file, entries) {
  if (entries.has('LICENSE')) return '';

  const roots = new Set([...entries.keys()].map((member) => member.split('/', 1)[0]));
  const expected = path.basename(file).slice(0, -'.tar.gz'.length);
  if (roots.size !== 1 || !roots.has(expected)) {
    throw new Error(
      `${path.basename(file)} must stage release notices at the archive root or beneath its ` +
        `canonical single archive root ${expected}`,
    );
  }
  return expected;
}

function assertMavenPayloadLegal(
  file,
  profile,
  sqlNames = [],
  sourceRoot,
  constructionLicenseFiles = [],
  target = null,
) {
  try {
    const entries = readPortableArchiveEntries(file);
    const prefix = canonicalMavenPayloadPrefix(file, entries);
    assertReleaseNoticesInEntries(entries, {
      profile,
      prefix,
      label: path.basename(file),
      sourceRoot,
    });
    if (sqlNames.length > 0) {
      // Native singleton payloads install upstream notices with runtime files
      // below files/, while aggregate bundles stage their combined legal tree
      // directly below the canonical archive root.
      const upstreamPrefix = prefix === '' ? 'files' : prefix;
      assertExtensionUpstreamLicensesInEntries(sqlNames, entries, {
        prefix: upstreamPrefix,
        constructionLicenseFiles,
        target,
      });
    }
  } catch (error) {
    fail(
      `${rel(file)} failed Maven payload legal closure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return file;
}

/** Project frozen SQL dependencies to conventional, same-ABI Maven owner edges. */
export function extensionMavenDependencies({
  product,
  releaseProduct,
  runtimeVersion,
  target,
  members,
  ownerMetadata = undefined,
}) {
  return frozenExtensionOwnerRequirements({
    product,
    releaseProduct,
    runtimeProduct: 'liboliphaunt-native',
    runtimeVersion,
    members,
    ownerForSqlName(sqlName) {
      return extensionOwnerForSqlName(sqlName, 'native', { ownerMetadata, prefix: PREFIX });
    },
  }).map((requirement) => ({
    groupId: 'dev.oliphaunt.extensions',
    artifactId: `${requirement.product}-${target}`,
    version: requirement.version,
    type: 'tar.gz',
    scope: 'runtime',
  }));
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function productArtifactTargets(product, version, context) {
  return (
    context?.artifactTargets ??
    allArtifactTargets(
      {
        product,
      },
      PREFIX,
    )
  )
    .filter((target) => target.surfaces.includes('maven'))
    .map((target) => ({
      ...target,
      asset: target.asset.replaceAll('{version}', version),
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

function runtimeMavenArtifactId(target) {
  if (target.kind === 'runtime-resources') {
    if (target.target !== 'android-datum64') {
      fail(`unsupported Maven runtime-resource target ${target.target}`);
    }
    return 'liboliphaunt-runtime-resources-android-datum64';
  }
  if (target.kind === 'icu-data') {
    return 'oliphaunt-icu';
  }
  if (target.kind === 'native-runtime' && target.target.startsWith('android-')) {
    return `liboliphaunt-${target.target}`;
  }
  return undefined;
}

function runtimeMavenArtifactMetadata(target) {
  if (target.kind === 'runtime-resources') {
    return {
      name: 'Oliphaunt runtime resources',
      description:
        'Package-managed Oliphaunt PostgreSQL runtime resources for the Android datum64 physical domain.',
      licenseProfile: 'native-runtime-resources',
    };
  }
  if (target.kind === 'icu-data') {
    return {
      name: 'Oliphaunt ICU data',
      description: 'Package-managed optional ICU data files for Oliphaunt app builds.',
      licenseProfile: 'native-icu-data',
    };
  }
  if (target.kind === 'native-runtime' && target.target.startsWith('android-')) {
    const abi = target.target.slice('android-'.length);
    return {
      name: `Oliphaunt Android runtime ${abi}`,
      description: `Package-managed liboliphaunt Android runtime for ${abi} app builds.`,
      licenseProfile: 'native-runtime',
    };
  }
  fail(`unsupported liboliphaunt-native Maven artifact target ${target.id}`);
}

function productMavenArtifacts(product, version, context) {
  const artifacts = new Map();
  for (const target of productArtifactTargets(product, version, context)) {
    const artifactId = runtimeMavenArtifactId(target);
    if (artifactId === undefined) {
      continue;
    }
    if (artifacts.has(artifactId)) {
      fail(`duplicate ${product} Maven artifact mapping for ${artifactId}`);
    }
    artifacts.set(artifactId, {
      filename: target.asset,
      ...runtimeMavenArtifactMetadata(target),
    });
  }
  if (artifacts.size === 0) {
    fail(`${product} artifact targets did not produce any Maven artifacts`);
  }
  return artifacts;
}

function splitMavenCoordinate(coordinate) {
  const separator = coordinate.indexOf(':');
  if (separator <= 0 || separator === coordinate.length - 1) {
    fail(`invalid Maven coordinate ${JSON.stringify(coordinate)}; expected group:artifact`);
  }
  return [coordinate.slice(0, separator), coordinate.slice(separator + 1)];
}

async function requireFile(file, label) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) {
      return file;
    }
  } catch {
    // Fall through to the shared diagnostic below.
  }
  fail(`missing ${label}: ${rel(file)}`);
}

function tsvRow({
  groupId,
  artifactId,
  version,
  file,
  name,
  description,
  runtimeProduct = '',
  runtimeVersion = '',
  licenseSpdx,
  licenses,
  dependencies = [],
}) {
  if (typeof licenseSpdx !== 'string' || !licenseSpdx)
    fail(`Maven artifact ${groupId}:${artifactId} has no package SPDX expression`);
  if (!Array.isArray(licenses) || licenses.length === 0)
    fail(`Maven artifact ${groupId}:${artifactId} has no structured license entries`);
  const values = [
    groupId,
    artifactId,
    version,
    rel(file),
    name,
    description,
    runtimeProduct,
    runtimeVersion,
    licenseSpdx,
    JSON.stringify(licenses),
    ...(dependencies.length > 0 ? [JSON.stringify(dependencies)] : []),
  ];
  if (values.some((value) => value.includes('\t') || value.includes('\n'))) {
    fail(`Maven artifact manifest value contains a tab or newline: ${JSON.stringify(values)}`);
  }
  return values.join('\t');
}

async function productRows(assetRoot, product, artifactIds, context) {
  const version = context?.version ?? (await currentVersion(product));
  const artifacts = productMavenArtifacts(product, version, context);
  const rows = [];
  const selected = artifactIds === undefined ? undefined : new Set(artifactIds);
  for (const coordinate of (
    context?.registryPackages ??
    registryPackageRows(
      {
        product,
        packageKind: 'maven',
      },
      PREFIX,
    ).map((row) => row.packageName)
  ).filter((name) => name.startsWith('dev.oliphaunt.runtime:'))) {
    const [groupId, artifactId] = splitMavenCoordinate(coordinate);
    if (selected && !selected.delete(artifactId)) continue;
    if (groupId !== 'dev.oliphaunt.runtime') {
      fail(`${product} Maven artifact ${coordinate} must use dev.oliphaunt.runtime`);
    }
    const artifact = artifacts.get(artifactId);
    if (artifact === undefined) {
      fail(`${product} Maven artifact ${coordinate} has no release asset mapping`);
    }
    const file = await requireFile(path.join(assetRoot, artifact.filename), artifactId);
    assertMavenPayloadLegal(file, artifact.licenseProfile, [], context?.noticeSourceRoot);
    rows.push(
      tsvRow({
        groupId,
        artifactId,
        version,
        file,
        name: artifact.name,
        description: artifact.description,
        licenseSpdx: releaseProfilePackageLicense(artifact.licenseProfile, {
          sourceRoot: context?.noticeSourceRoot,
        }).spdx,
        licenses: releaseProfileMavenLicenses(artifact.licenseProfile, {
          product,
          version,
          sourceRoot: context?.noticeSourceRoot,
        }),
      }),
    );
  }
  if (selected?.size)
    fail(`unknown selected Maven artifacts for ${product}: ${[...selected].join(', ')}`);
  return rows;
}

async function extensionRows(extensionRoot, selectedProducts, context) {
  if (context?.extensions && selectedProducts.length === 0)
    fail('declared extension Maven inputs require explicit selected products');
  const products =
    selectedProducts.length > 0 ? selectedProducts : logicalExactExtensionProducts(PREFIX);
  const rows = [];
  for (const product of [...products].sort()) {
    const declared = context?.extensions?.[product];
    if (context?.extensions && !declared)
      fail(`${product} is absent from declared extension Maven inputs`);
    if (
      declared &&
      (!Array.isArray(declared.sqlNames) ||
        declared.sqlNames.length === 0 ||
        !Array.isArray(declared.targets) ||
        !Array.isArray(declared.registryPackages) ||
        typeof declared.version !== 'string' ||
        typeof declared.releaseProduct !== 'string' ||
        typeof declared.runtimeSourceVersion !== 'string' ||
        typeof declared.productRoot !== 'string' ||
        !declared.compatibility)
    )
      fail(`${product} has incomplete declared extension Maven inputs`);
    const sqlNames = declared?.sqlNames ?? extensionSqlNames(product, PREFIX);
    if (declared && new Set(sqlNames).size !== sqlNames.length)
      fail(`${product} repeats a declared SQL member`);
    const version = declared?.version ?? extensionReleaseVersion(product, 'native', PREFIX);
    const registryLicense = extensionRegistryLicense(product, sqlNames);
    const compatibility =
      declared?.compatibility ?? extensionMetadata(product, PREFIX).compatibility;
    const releaseProduct =
      declared?.releaseProduct ?? extensionReleaseProduct(product, 'native', PREFIX);
    const runtimeProduct = compatibility.nativeRuntimeProduct;
    const runtimeVersion = compatibility.nativeRuntimeVersion;
    if (
      typeof runtimeProduct !== 'string' ||
      !runtimeProduct ||
      typeof runtimeVersion !== 'string' ||
      !runtimeVersion
    ) {
      fail(`${product} must declare exact native runtime compatibility for Maven carriers`);
    }
    // Unchanged external products retain their published runtime pin when the
    // runtime releases independently, just like their Cargo, npm and Swift carriers.
    requireCompatibilityVersionBounds(
      {
        id: `${product} native runtime`,
        value: runtimeVersion,
        sourceProduct: runtimeProduct,
        sourceVersion: declared?.runtimeSourceVersion ?? (await currentVersion(runtimeProduct)),
      },
      { prefix: PREFIX },
    );
    const productRoot = path.join(
      declared?.productRoot ??
        extensionArtifactProductRoot(product, 'native', extensionRoot, PREFIX),
      'release-assets',
    );
    const frozenMembers = declared?.memberContracts
      ? null
      : extensionManifestMembers(
          JSON.parse(
            await fs.readFile(
              path.join(productRoot, `${product}-${version}-manifest.json`),
              'utf8',
            ),
          ),
        );
    if (
      frozenMembers &&
      JSON.stringify(frozenMembers.map((member) => member.sqlName).sort()) !==
        JSON.stringify([...sqlNames].sort())
    )
      fail(`${product} frozen Maven member inventory differs from its selected SQL members`);
    const targets = [
      ...new Map(
        (
          declared?.targets ??
          releaseExtensionArtifactTargets(
            {
              product,
              family: 'native',
            },
            PREFIX,
          )
        )
          .filter(
            (target) =>
              target.kind === 'native-static-registry' && target.target.startsWith('android-'),
          )
          .map((target) => [target.target, target]),
      ).values(),
    ];
    if (targets.length === 0) {
      fail(`${product} has no published Android Maven extension targets`);
    }
    if (
      declared &&
      (declared.targets.length !== 2 ||
        declared.targets.some(
          (target) => target.family !== 'native' || target.kind !== 'native-static-registry',
        ) ||
        JSON.stringify(targets.map((target) => target.target).sort()) !==
          JSON.stringify(['android-arm64-v8a', 'android-x86_64']))
    )
      fail(`${product} declared Maven inputs must cover both canonical Android targets`);
    const declaredCoordinates = new Set(
      (
        declared?.registryPackages ??
        registryPackageRows({ product: releaseProduct, packageKind: 'maven' }, PREFIX).map(
          (row) => row.packageName,
        )
      ).filter((name) => name.startsWith(`dev.oliphaunt.extensions:${product}-`)),
    );
    if (declared && new Set(declared.registryPackages).size !== declared.registryPackages.length)
      fail(`${product} repeats a declared Maven coordinate`);
    for (const target of targets) {
      const coordinate = `dev.oliphaunt.extensions:${product}-${target.target}`;
      if (!declaredCoordinates.delete(coordinate)) {
        fail(`${product} release metadata is missing Maven carrier ${coordinate}`);
      }
      const filename =
        sqlNames.length > 1
          ? `${product}-${version}-native-${target.target}-bundle.tar.gz`
          : `${product}-${version}-native-${target.target}-runtime.tar.gz`;
      const memberLabel =
        sqlNames.length === 1
          ? `the ${sqlNames[0]} PostgreSQL extension`
          : `the PostgreSQL 18 contrib bundle (${sqlNames.length} exact extension members)`;
      const file = await requireFile(
        path.join(productRoot, filename),
        `${product} ${target.target} Maven artifact`,
      );
      const legacyLicenseProfile =
        product === 'oliphaunt-extension-contrib-pg18'
          ? 'contrib-native-openssl'
          : 'external-native';
      const memberContracts = declared?.memberContracts?.[target.target] ?? [];
      const legal = declared
        ? nativeExtensionCarrierLegal(product, sqlNames, {
            target: target.target,
            carriesPayload: true,
            memberContracts,
          })
        : null;
      const licenseProfile = legal?.profile ?? legacyLicenseProfile;
      assertMavenPayloadLegal(
        file,
        licenseProfile,
        product === 'oliphaunt-extension-contrib-pg18' ? [] : sqlNames,
        context?.noticeSourceRoot,
        memberContracts.flatMap((member) => member.nativeConstructionLicenseFiles ?? []),
        target.target,
      );
      rows.push(
        tsvRow({
          groupId: 'dev.oliphaunt.extensions',
          artifactId: `${product}-${target.target}`,
          version,
          file,
          name: `Oliphaunt ${sqlNames.length === 1 ? `extension ${sqlNames[0]}` : 'PostgreSQL 18 contrib extensions'} ${target.target}`,
          description: `Package-managed Oliphaunt Android runtime and static-link artifacts for ${memberLabel} on ${target.target}.`,
          runtimeProduct,
          runtimeVersion,
          dependencies: extensionMavenDependencies({
            product,
            releaseProduct,
            runtimeVersion,
            target: target.target,
            members: declared?.memberContracts?.[target.target] ?? frozenMembers,
            ownerMetadata: declared?.ownerMetadata,
          }),
          licenseSpdx:
            legal?.packageSpdx ??
            (product === 'oliphaunt-extension-contrib-pg18'
              ? releaseProfilePackageLicense(licenseProfile).spdx
              : registryLicense.packageSpdx),
          licenses: [
            ...(product === 'oliphaunt-extension-contrib-pg18'
              ? releaseProfileMavenLicenses(licenseProfile, {
                  product,
                  version,
                  sourceRoot: context?.noticeSourceRoot,
                })
              : extensionMavenLicenses(product, sqlNames, { version })),
            ...memberContracts.flatMap((member) =>
              nativeExtensionConstructionMavenLicenses(
                member.sqlName,
                target.target,
                member.nativeConstructionLicenseFiles ?? [],
              ),
            ),
          ],
        }),
      );
    }
    if (declaredCoordinates.size > 0) {
      fail(
        `${product} declares unexpected Maven carrier(s): ${[...declaredCoordinates].sort().join(', ')}`,
      );
    }
  }
  return rows;
}

function valueArg(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    output: undefined,
    artifactProduct: 'liboliphaunt-native',
    runtimeAssetRoot: 'target/liboliphaunt/release-assets',
    extensionArtifactRoot: 'target/extension-artifacts',
    runtime: false,
    extensions: false,
    extensionProducts: [],
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    if (arg === '--output') {
      args.output = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === '--artifact-product') {
      args.artifactProduct = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === '--runtime-asset-root') {
      args.runtimeAssetRoot = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === '--extension-artifact-root') {
      args.extensionArtifactRoot = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === '--runtime') {
      args.runtime = true;
      index += 1;
    } else if (arg === '--extensions') {
      args.extensions = true;
      index += 1;
    } else if (arg === '--extension-product') {
      args.extensionProducts.push(valueArg(argv, index, arg));
      index += 2;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!args.output) {
    fail('--output is required');
  }
  return args;
}

export async function buildMavenArtifactManifest(
  outputValue,
  {
    artifactProduct = 'liboliphaunt-native',
    artifactIds,
    runtimeAssetRoot = 'target/liboliphaunt/release-assets',
    extensionArtifactRoot = 'target/extension-artifacts',
    runtime = false,
    extensions = false,
    extensionProducts = [],
    context,
  } = {},
) {
  const includeRuntime = runtime || !extensions;
  const includeExtensions = extensions || extensionProducts.length > 0;
  const rows = [];
  if (includeRuntime) {
    rows.push(
      ...(await productRows(repoPath(runtimeAssetRoot), artifactProduct, artifactIds, context)),
    );
  }
  if (includeExtensions) {
    rows.push(
      ...(await extensionRows(repoPath(extensionArtifactRoot), extensionProducts, context)),
    );
  }
  if (rows.length === 0) {
    fail('manifest would be empty');
  }
  const output = repoPath(outputValue);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${rows.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${rows.length} Maven artifact publication row(s) to ${rel(output)}`);
  return output;
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    await buildMavenArtifactManifest(args.output, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
