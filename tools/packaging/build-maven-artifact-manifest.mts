#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';

import { currentVersion } from '../release/product-version.mts';
import {
  allArtifactTargets,
  exactExtensionProducts as logicalExactExtensionProducts,
  extensionArtifactProductRoot,
  extensionArtifactTargets as releaseExtensionArtifactTargets,
  extensionMetadata,
  extensionReleaseProduct,
  extensionReleaseVersion,
  extensionSqlNames,
  registryPackageRows,
} from '../release/release-artifact-targets.mts';
import {
  assertReleaseNoticesInEntries,
  releaseProfileMavenLicenses,
  releaseProfilePackageLicense,
} from './release-notices.mts';
import {
  assertExtensionUpstreamLicensesInEntries,
  extensionMavenLicenses,
  extensionRegistryLicense,
} from '../../extensions/tools/extension-upstream-licenses.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';

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

function assertMavenPayloadLegal(file, profile, sqlNames = []) {
  try {
    const entries = readPortableArchiveEntries(file);
    const prefix = canonicalMavenPayloadPrefix(file, entries);
    assertReleaseNoticesInEntries(entries, { profile, prefix, label: path.basename(file) });
    if (sqlNames.length > 0) {
      // Native singleton payloads install upstream notices with runtime files
      // below files/, while aggregate bundles stage their combined legal tree
      // directly below the canonical archive root.
      const upstreamPrefix = prefix === '' ? 'files' : prefix;
      assertExtensionUpstreamLicensesInEntries(sqlNames, entries, { prefix: upstreamPrefix });
    }
  } catch (error) {
    fail(
      `${rel(file)} failed Maven payload legal closure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return file;
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function productArtifactTargets(product, version) {
  return allArtifactTargets(
    {
      product,
    },
    PREFIX,
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

function productMavenArtifacts(product, version) {
  const artifacts = new Map();
  for (const target of productArtifactTargets(product, version)) {
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
  ];
  if (values.some((value) => value.includes('\t') || value.includes('\n'))) {
    fail(`Maven artifact manifest value contains a tab or newline: ${JSON.stringify(values)}`);
  }
  return values.join('\t');
}

async function productRows(assetRoot, product, artifactIds) {
  const version = await currentVersion(product);
  const artifacts = productMavenArtifacts(product, version);
  const rows = [];
  const selected = artifactIds === undefined ? undefined : new Set(artifactIds);
  for (const coordinate of registryPackageRows(
    {
      product,
      packageKind: 'maven',
    },
    PREFIX,
  )
    .map((row) => row.packageName)
    .filter((name) => name.startsWith('dev.oliphaunt.runtime:'))) {
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
    assertMavenPayloadLegal(file, artifact.licenseProfile);
    rows.push(
      tsvRow({
        groupId,
        artifactId,
        version,
        file,
        name: artifact.name,
        description: artifact.description,
        licenseSpdx: releaseProfilePackageLicense(artifact.licenseProfile).spdx,
        licenses: releaseProfileMavenLicenses(artifact.licenseProfile, {
          product,
          version,
        }),
      }),
    );
  }
  if (selected?.size)
    fail(`unknown selected Maven artifacts for ${product}: ${[...selected].join(', ')}`);
  return rows;
}

async function extensionRows(extensionRoot, selectedProducts) {
  const products =
    selectedProducts.length > 0 ? selectedProducts : logicalExactExtensionProducts(PREFIX);
  const rows = [];
  for (const product of [...products].sort()) {
    const sqlNames = extensionSqlNames(product, PREFIX);
    const version = extensionReleaseVersion(product, 'native', PREFIX);
    const registryLicense = extensionRegistryLicense(product, sqlNames);
    const compatibility = extensionMetadata(product, PREFIX).compatibility;
    const releaseProduct = extensionReleaseProduct(product, 'native', PREFIX);
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
    const currentRuntimeVersion = await currentVersion(runtimeProduct);
    if (runtimeVersion !== currentRuntimeVersion) {
      fail(
        `${product} native runtime compatibility ${runtimeVersion} does not match ${runtimeProduct}@${currentRuntimeVersion}`,
      );
    }
    const productRoot = path.join(
      extensionArtifactProductRoot(product, 'native', extensionRoot, PREFIX),
      'release-assets',
    );
    const targets = [
      ...new Map(
        releaseExtensionArtifactTargets(
          {
            product,
            family: 'native',
          },
          PREFIX,
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
    const declaredCoordinates = new Set(
      registryPackageRows({ product: releaseProduct, packageKind: 'maven' }, PREFIX)
        .map((row) => row.packageName)
        .filter((name) => name.startsWith(`dev.oliphaunt.extensions:${product}-`)),
    );
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
      const licenseProfile =
        product === 'oliphaunt-extension-contrib-pg18'
          ? 'contrib-native-openssl'
          : 'external-native';
      assertMavenPayloadLegal(
        file,
        licenseProfile,
        product === 'oliphaunt-extension-contrib-pg18' ? [] : sqlNames,
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
          licenseSpdx:
            product === 'oliphaunt-extension-contrib-pg18'
              ? releaseProfilePackageLicense(licenseProfile).spdx
              : registryLicense.packageSpdx,
          licenses:
            product === 'oliphaunt-extension-contrib-pg18'
              ? releaseProfileMavenLicenses('contrib-native-openssl', { product, version })
              : extensionMavenLicenses(product, sqlNames, { version }),
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
  } = {},
) {
  const includeRuntime = runtime || !extensions;
  const includeExtensions = extensions || extensionProducts.length > 0;
  const rows = [];
  if (includeRuntime) {
    rows.push(...(await productRows(repoPath(runtimeAssetRoot), artifactProduct, artifactIds)));
  }
  if (includeExtensions) {
    rows.push(...(await extensionRows(repoPath(extensionArtifactRoot), extensionProducts)));
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
