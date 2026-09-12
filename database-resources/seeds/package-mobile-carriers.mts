#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  createDeterministicTar,
  createDeterministicZip,
} from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import {
  releaseProfileMavenLicenses,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
import { stageMavenArtifactManifest } from '../../tools/packaging/maven-artifact-staging.mts';
import { currentProductVersionSync, ROOT } from '../../tools/release/release-artifact-targets.mts';
import {
  bindNativeClusterSeedManifest,
  filesystemTreeRows,
  logicalTreeSha256,
  nativeClusterSeedCompatibilityKey,
  validateNativeClusterSeedDirectory,
} from '../contracts/native-manifest.mts';
import { validateNativeIcuDataManifest } from '../contracts/icu-data.mts';

const contract = JSON.parse(
  readFileSync(new URL('../contracts/contract.json', import.meta.url), 'utf8'),
);

/** Adapt the canonical seed into the existing native mobile resource contract. */
export function stageMobileSeed({ archive, manifest, destination, target, profile, icuData }) {
  if (
    !['android-datum64', 'ios-datum64'].includes(target) ||
    !['standard', 'icu'].includes(profile)
  )
    throw new Error('a declared mobile seed target and profile are required');
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (
    metadata.schema !== contract.manifests.wasix.schema ||
    metadata.catalogProfile !== profile ||
    metadata.artifactRole !== contract.profiles[profile].artifactRole ||
    metadata.runtime?.engineFamily !== 'native' ||
    metadata.runtime.target !== target ||
    metadata.runtime.postgresMajor !== 18 ||
    metadata.runtime.physicalFormat !== contract.physicalFormats.native ||
    metadata.runtime.compatibilityKey !== nativeClusterSeedCompatibilityKey(target) ||
    metadata.archive?.sha256 !== digest
  )
    throw new Error(
      'mobile seed does not match its target, profile, native compatibility or checksum',
    );
  if ((profile === 'icu') !== (metadata.icu !== null))
    throw new Error('mobile seed ICU selection mismatch');
  rmSync(destination, { recursive: true, force: true });
  const files = path.join(destination, 'files');
  mkdirSync(files, { recursive: true });
  extractPortableArchiveTree(archive, files);
  const properties = {
    schema: contract.manifests.native.schema,
    layout: contract.manifests.native.layout,
    artifactRole: metadata.artifactRole,
    catalogProfile: profile,
    postgresMajor: '18',
    physicalFormat: contract.physicalFormats.native,
    initialSuperuser: 'postgres',
    icuDataVersion: metadata.icu?.dataVersion ?? '',
    icuDataForm: metadata.icu?.dataForm ?? '',
    runtimeFeatures: contract.profiles[profile].requiredRuntimeFeatures.join(','),
    icuDataTreeSha256: metadata.icu?.dataTreeSha256 ?? '',
    cacheKey: logicalTreeSha256(filesystemTreeRows(files)),
  };
  const unbound = Buffer.from(
    Object.entries(properties)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(destination, 'manifest.properties'),
    bindNativeClusterSeedManifest(unbound, target, profile),
  );
  validateNativeClusterSeedDirectory(destination, profile, { target, icuData });
  return metadata;
}

export async function packageMobileSeedCarriers({
  targets = ['android-datum64', 'ios-datum64'],
  profiles = ['standard', 'icu'],
  assetDir,
  workDir,
  mavenDir,
} = {}) {
  const version = currentProductVersionSync('database-resources');
  const assets = path.resolve(
    assetDir ?? path.join(ROOT, 'target/database-resources/release-assets'),
  );
  const work = path.resolve(
    workDir ?? path.join(ROOT, 'target/database-resources/mobile-carriers'),
  );
  const rows = [];
  const results = [];
  const swiftRoot = path.join(work, 'oliphaunt-database-resources');
  const extractedIcu = path.join(work, 'icu');
  if (profiles.includes('icu') || targets.includes('ios-datum64')) {
    rmSync(extractedIcu, { recursive: true, force: true });
    extractPortableArchiveTree(
      path.join(assets, `database-resources-${version}-icu-data.tar.gz`),
      extractedIcu,
    );
    validateNativeIcuDataManifest(
      readFileSync(path.join(extractedIcu, 'manifest.properties')),
      path.join(extractedIcu, 'share/icu'),
      'canonical mobile ICU data',
    );
  }
  const swiftProducts = [];
  const swiftTargets = [];
  if (targets.includes('ios-datum64')) rmSync(swiftRoot, { recursive: true, force: true });
  for (const target of targets)
    for (const profile of profiles) {
      const suffix = `native-${target}-${profile}`;
      const stage = path.join(work, suffix);
      rmSync(stage, { recursive: true, force: true });
      const swift = target === 'ios-datum64';
      const name = `OliphauntSeedNativeIOS${profile === 'icu' ? 'ICU' : 'Standard'}`;
      const resource = profile === 'icu' ? 'cluster-seed-icu' : 'cluster-seed';
      const resourceRoot = swift ? path.join(swiftRoot, 'Sources', name) : stage;
      const stem = `database-resources-${version}-seed-${suffix}`;
      stageMobileSeed({
        archive: path.join(assets, `${stem}.tar.zst`),
        manifest: path.join(assets, `${stem}.json`),
        destination: path.join(resourceRoot, resource),
        target,
        profile,
        icuData: profile === 'icu' ? path.join(extractedIcu, 'share/icu') : undefined,
      });
      stageReleaseNotices(swift ? swiftRoot : stage, { profile: 'native-runtime-resources' });
      if (swift) {
        writeFileSync(
          path.join(resourceRoot, 'Resources.swift'),
          `import Foundation\npublic enum ${name} {\n    public static var resourceRoot: URL { Bundle.module.resourceURL! }\n}\n`,
        );
        swiftProducts.push(`.library(name: "${name}", targets: ["${name}"])`);
        swiftTargets.push(
          `.target(name: "${name}", dependencies: [${profile === 'icu' ? '"OliphauntICU"' : ''}], resources: [.copy("${resource}")])`,
        );
      } else {
        const output = path.join(assets, `${stem}-maven.tar.gz`);
        writeFileSync(output, gzipSync(await createDeterministicTar(stage), { level: 9 }));
        rows.push(
          [
            'dev.oliphaunt.runtime',
            `oliphaunt-seed-${suffix}`,
            version,
            output,
            `Oliphaunt ${profile} Android cluster seed`,
            `Selectable PostgreSQL native ${profile} cluster seed for Android.`,
            '',
            '',
            releaseProfilePackageLicense('native-runtime-resources').spdx,
            JSON.stringify(
              releaseProfileMavenLicenses('native-runtime-resources', {
                product: 'database-resources',
                version,
              }),
            ),
          ].join('\t'),
        );
        results.push(output);
      }
    }
  if (swiftProducts.length) {
    const icu = path.join(swiftRoot, 'Sources/OliphauntICU');
    mkdirSync(icu, { recursive: true });
    cpSync(path.join(extractedIcu, 'share'), path.join(icu, 'share'), { recursive: true });
    copyFileSync(
      path.join(extractedIcu, 'manifest.properties'),
      path.join(icu, 'manifest.properties'),
    );
    rmSync(extractedIcu, { recursive: true, force: true });
    validateNativeIcuDataManifest(
      readFileSync(path.join(icu, 'manifest.properties')),
      path.join(icu, 'share/icu'),
      'Swift ICU resource',
    );
    writeFileSync(
      path.join(icu, 'Resources.swift'),
      'import Foundation\npublic enum OliphauntICUResources { public static var resourceRoot: URL { Bundle.module.resourceURL! } }\n',
    );
    swiftProducts.push('.library(name: "OliphauntICU", targets: ["OliphauntICU"])');
    swiftTargets.push(
      '.target(name: "OliphauntICU", resources: [.copy("share"), .copy("manifest.properties")])',
    );
    writeFileSync(
      path.join(swiftRoot, 'Package.swift'),
      `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "OliphauntDatabaseResources", products: [${swiftProducts.join(', ')}], targets: [${swiftTargets.join(', ')}])\n`,
    );
    const output = path.join(assets, `database-resources-${version}-swift.zip`);
    writeFileSync(output, await createDeterministicZip(swiftRoot));
    results.push(output);
  }
  if (rows.length) {
    const manifest = path.join(work, 'maven.tsv');
    writeFileSync(manifest, rows.join('\n') + '\n');
    await stageMavenArtifactManifest(
      manifest,
      mavenDir ?? path.join(ROOT, 'target/release/maven-staging/database-resources-seeds'),
    );
  }
  return results;
}

if (import.meta.main) {
  if (process.argv[2] === 'stage') {
    const options = {};
    const allowed = new Set([
      'archive',
      'manifest',
      'destination',
      'target',
      'profile',
      'icu-data',
    ]);
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || options[key])
        throw new Error(
          'usage: stage --archive FILE --manifest FILE --destination DIR --target TARGET --profile PROFILE [--icu-data DIR]',
        );
      options[key] = args[i + 1];
    }
    for (const key of ['archive', 'manifest', 'destination', 'target', 'profile'])
      if (!options[key]) throw new Error(`stage requires --${key}`);
    stageMobileSeed({ ...options, icuData: options['icu-data'] });
  } else {
    await packageMobileSeedCarriers(process.argv[2] ? { targets: [process.argv[2]] } : {});
  }
}
